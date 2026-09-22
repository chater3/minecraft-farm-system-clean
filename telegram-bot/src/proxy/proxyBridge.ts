import fs from 'fs';
import net from 'net';
import path from 'path';
import { log, logError } from '../logger';

/**
 * Прокси-пул Webshare (ip:port:user:pass) + локальный SOCKS5-мост.
 *
 * Minecraft/java не умеет HTTP-прокси с авторизацией для игрового трафика,
 * поэтому поднимаем на 127.0.0.1 локальные SOCKS5-серверы (по одному на каждый
 * прокси), которые туннелируют соединение через HTTP CONNECT upstream-прокси.
 * Клиенту передаём -DsocksProxyHost=127.0.0.1 -DsocksProxyPort=<порт>.
 */

export type ProxyEntry = {
  host: string;
  port: number;
  user: string;
  pass: string;
  source: string;
};

const DEFAULT_FILES = [
  // главный файл проекта — сюда докидывайте новые прокси
  path.resolve(__dirname, '../../../proxy/proxies.txt'),
  'C:\\Users\\User\\Downloads\\Webshare 10 proxies.txt',
  'C:\\Users\\User\\Downloads\\Webshare 10 proxies (другой ак).txt',
];

export const PROXY_ENABLED = (process.env.PROXY_ENABLED || 'true').toLowerCase() !== 'false';
const BRIDGE_BASE_PORT = parseInt(process.env.PROXY_BRIDGE_PORT || '2081', 10);
/**
 * Игровой туннель: Netty в Minecraft игнорирует -DsocksProxyHost, поэтому
 * сам игровой TCP (слот/логин) идёт в обход прокси. Решение: поднимаем
 * локальный TCP-слушатель на КАЖДЫЙ слот прокси (127.0.0.1:22081+i),
 * клиент стучится в него, а мы делаем HTTP CONNECT до игрового сервера
 * через HTTP-прокси Webshare. Сервер видит IP прокси, а не реальный.
 */
const GAME_BASE_PORT = parseInt(process.env.PROXY_GAME_PORT || '22081', 10);
const GAME_HOST = process.env.MINECRAFT_SERVER || 'mc.funtime.su';
const GAME_PORT = parseInt(process.env.MINECRAFT_SERVER_PORT || '25565', 10);

export function loadProxies(): ProxyEntry[] {
  const files = (process.env.PROXY_FILES || DEFAULT_FILES.join(';'))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  const out: ProxyEntry[] = [];
  for (const file of files) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      let found = 0;
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d+):([^:\s]+):(\S+)$/);
        if (m) {
          out.push({ host: m[1], port: parseInt(m[2], 10), user: m[3], pass: m[4], source: file });
          found++;
        }
      }
      log(`[Proxy] ${file}: загружено ${found} прокси`);
    } catch (error) {
      logError(`[Proxy] Не удалось прочитать файл ${file}:`, error);
    }
  }

  // дедупликация (файлы могут совпадать)
  const seen = new Set<string>();
  return out.filter((p) => {
    const key = `${p.host}:${p.port}:${p.user}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** TCP-проверка: жив ли прокси вообще (мёртвые не выдаём клиентам) */
function tcpAlive(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}

/* ---------------- round-robin выдача ---------------- */

let proxies: ProxyEntry[] = [];
let cursor = 0;
let bridgeStarted = false;
const servers: net.Server[] = [];

export function initProxies(): Promise<number> {
  if (!PROXY_ENABLED) {
    log('[Proxy] Отключены (PROXY_ENABLED=false).');
    return Promise.resolve(0);
  }
  const all = loadProxies();
  if (all.length === 0) {
    logError('[Proxy] Прокси не найдены — запуск без прокси.');
    return Promise.resolve(0);
  }
  return Promise.all(all.map(async (p) => ({ p, alive: await tcpAlive(p.host, p.port) }))).then(
    (results) => {
      proxies = results.filter((r) => r.alive).map((r) => r.p);
      const dead = results.length - proxies.length;
      if (dead > 0) {
        logError(`[Proxy] Мёртвых (TCP refused/timeout): ${dead} из ${results.length}.`);
      }
      if (proxies.length === 0) {
        logError('[Proxy] НИ ОДИН прокси не отвечает — запуск БЕЗ прокси (проверьте файл/аккаунт Webshare).');
      } else {
        log(`[Proxy] Живых прокси: ${proxies.length}`);
      }
      return proxies.length;
    },
  );
}

/** Выдача слота прокси для очередного клиента: SOCKS-мост (authlib) + игровой туннель (Netty). */
export type ProxyAssignment = {
  socksArgs: string[];
  /** Адрес для --quickPlayMultiplayer (127.0.0.1:<порт>) или null, если прокси нет */
  gameAddress: string | null;
};

export function nextProxyAssignment(label: string): ProxyAssignment {
  if (proxies.length === 0) return { socksArgs: [], gameAddress: null };
  const idx = cursor % proxies.length;
  cursor++;
  const socksPort = BRIDGE_BASE_PORT + idx;
  const gamePort = GAME_BASE_PORT + idx;
  const p = proxies[idx];
  log(
    `[Proxy] ${label} → мост 127.0.0.1:${socksPort} + игровой туннель 127.0.0.1:${gamePort} → HTTP ${p.host}:${p.port}`,
  );
  return {
    socksArgs: ['-DsocksProxyHost=127.0.0.1', `-DsocksProxyPort=${socksPort}`],
    gameAddress: `127.0.0.1:${gamePort}`,
  };
}

/* ---------------- SOCKS5 → HTTP CONNECT мост ---------------- */

const BIND_RETRIES = 15;
const BIND_RETRY_MS = 2000;

/**
 * listen с повтором при EADDRINUSE: если бот перезапускают, пока старый
 * экземпляр ещё держит порты мостов, новый подождёт и захватит их сам,
 * вместо вечной смерти моста (случалось при двух npm start).
 */
function bindWithRetry(
  factory: () => net.Server,
  port: number,
  successLog: string,
  what: string,
  attempt = 0,
): void {
  const server = factory();
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && !server.listening && attempt < BIND_RETRIES) {
      log(
        `[Proxy] ${what} 127.0.0.1:${port} занят другим процессом — повтор ${attempt + 1}/${BIND_RETRIES} через ${BIND_RETRY_MS / 1000}с...`,
      );
      setTimeout(
        () => bindWithRetry(factory, port, successLog, what, attempt + 1),
        BIND_RETRY_MS,
      );
      return;
    }
    logError(`[Proxy] Ошибка ${what} 127.0.0.1:${port}:`, err);
  });
  server.listen(port, '127.0.0.1', () => {
    log(`[Proxy] ${successLog}`);
  });
  servers.push(server);
}

export function startBridge(): boolean {
  if (!bridgeStarted && proxies.length > 0) {
    proxies.forEach((p, i) => {
      const port = BRIDGE_BASE_PORT + i;
      bindWithRetry(
        () => net.createServer((sock) => handleSocksClient(sock, p)),
        port,
        `SOCKS5 мост 127.0.0.1:${port} → HTTP ${p.host}:${p.port}`,
        'моста',
      );
    });
    // игровой TCP-туннель: 127.0.0.1:22081+i → CONNECT mc.funtime.su:25565 через прокси
    proxies.forEach((p, i) => {
      const port = GAME_BASE_PORT + i;
      bindWithRetry(
        () => net.createServer((sock) => handleGameClient(sock, p)),
        port,
        `Игровой туннель 127.0.0.1:${port} → CONNECT ${GAME_HOST}:${GAME_PORT} через ${p.host}:${p.port}`,
        'игрового туннеля',
      );
    });
    bridgeStarted = true;
  }
  return bridgeStarted;
}

export function stopBridge(): void {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  servers.length = 0;
  bridgeStarted = false;
}

/**
 * Первый пакет клиента — Handshake (id=0x00): VarInt длина, id, protoVer,
 * String адрес, u16 port, VarInt next_state. NeoProtect (FunTime) выбирает
 * бэкенд по строке адреса: клиент шлёт туда адрес локального туннеля
 * (127.0.0.1:22081) и получает кик "domain is not registered" — переписываем
 * на реальный хост игрового сервера. Тail после первого пакета не трогаем.
 */
function rewriteHandshake(buf: Buffer): Buffer | null {
  let o = 0;
  const readVarInt = (): number | null => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (o >= buf.length) return null;
      const b = buf[o++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v >>> 0;
      shift += 7;
      if (shift > 35) return null;
    }
  };

  const totalLen = readVarInt();
  if (totalLen === null || totalLen <= 0 || totalLen > 4096) return null;
  const bodyStart = o;
  const bodyEnd = bodyStart + totalLen;
  if (bodyEnd > buf.length) return null; // пакет пришёл не целиком

  const id = readVarInt();
  if (id !== 0) return null; // вне handshake состояния такого пакета быть не должно
  const proto = readVarInt();
  if (proto === null) return null;
  const afterProto = o; // id + proto в исходных байтах

  const addrLen = readVarInt();
  if (addrLen === null || addrLen < 0 || addrLen > 255) return null;
  if (o + addrLen + 2 > bodyEnd) return null;
  const portAt = o + addrLen;
  const tailAt = portAt + 2; // далее идёт VarInt next_state (последнее поле)
  if (tailAt > bodyEnd) return null;

  const newAddr = Buffer.from(GAME_HOST, 'utf8');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(GAME_PORT);

  const newBody = Buffer.concat([
    buf.slice(bodyStart, afterProto), // id + protocol version как есть
    encodeVarInt(newAddr.length),
    newAddr,
    portBuf,
    buf.slice(tailAt, bodyEnd), // next_state
  ]);
  return Buffer.concat([encodeVarInt(newBody.length), newBody, buf.slice(bodyEnd)]);
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Начало выглядит как Handshake (id=0x00), но пакет ещё не дочитан — стоит подождать. */
function isIncompleteHandshake(buf: Buffer): boolean {
  let o = 0;
  const readVarInt = (): number | null => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (o >= buf.length) return null;
      const b = buf[o++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v >>> 0;
      shift += 7;
      if (shift > 35) return null;
    }
  };
  const totalLen = readVarInt();
  if (totalLen === null) return true;
  const bodyStart = o;
  const id = readVarInt();
  if (id === null) return true;
  if (id !== 0) return false;
  return buf.length < bodyStart + totalLen;
}

/**
 * Приём подключения от Minecraft и немедленный HTTP CONNECT до игрового сервера
 * через Webshare-прокси (без SOCKS-рукопожатия — клиент думает, что это сам сервер).
 * Первый пакет (Handshake) переписываем на реальный адрес сервера — см. rewriteHandshake.
 */
function handleGameClient(client: net.Socket, up: ProxyEntry): void {
  const auth = Buffer.from(`${up.user}:${up.pass}`).toString('base64');
  const request =
    `CONNECT ${GAME_HOST}:${GAME_PORT} HTTP/1.1\r\n` +
    `Host: ${GAME_HOST}:${GAME_PORT}\r\n` +
    `Proxy-Authorization: Basic ${auth}\r\n` +
    `Proxy-Connection: keep-alive\r\n\r\n`;

  let connected = false;
  let flushed = false;
  let headerDone = false;
  let headerBuf = Buffer.alloc(0);
  const pending: Buffer[] = [];
  let upstream: net.Socket | null = null;

  const fail = (why: string) => {
    logError(`[Proxy] Игровой туннель: ${why}`);
    client.destroy();
    upstream?.destroy();
  };

  // отправляем накопленные байты клиента после 200 OK, переписав Handshake
  const flushPending = () => {
    if (!connected || flushed || pending.length === 0 || !upstream) return;
    const pre = Buffer.concat(pending);
    const rewritten = rewriteHandshake(pre);
    if (rewritten) {
      pending.length = 0;
      flushed = true;
      log(`[Proxy] ИГРА Handshake переписан: → ${GAME_HOST}:${GAME_PORT}`);
      upstream.write(rewritten);
      return;
    }
    if (isIncompleteHandshake(pre)) return; // пакет пришёл частями — ждём хвост
    pending.length = 0;
    flushed = true;
    logError('[Proxy] ИГРА Handshake не распознан — отправляем без перезаписи');
    upstream.write(pre);
  };

  upstream = net.connect({ host: up.host, port: up.port }, () => {
    upstream!.write(request);
  });

  upstream.on('data', (d: Buffer) => {
    if (!headerDone) {
      headerBuf = Buffer.concat([headerBuf, d]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (headerBuf.length > 16384) fail('слишком большой ответ прокси');
        return;
      }
      headerDone = true;
      const statusLine = headerBuf.slice(0, idx).toString('utf8').split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        fail(`CONNECT ${GAME_HOST}:${GAME_PORT} через ${up.host}:${up.port} → ${statusLine}`);
        return;
      }
      connected = true;
      log(`[Proxy] ИГРА ${client.remoteAddress ?? '?'}:${client.remotePort ?? 0} → ${GAME_HOST}:${GAME_PORT} через ${up.host}:${up.port} → 200 OK`);
      const rest = headerBuf.slice(idx + 4);
      if (rest.length) client.write(rest);
      flushPending();
      return;
    }
    client.write(d);
  });

  client.on('data', (d: Buffer) => {
    if (!flushed) {
      pending.push(d);
      flushPending(); // сработает, когда придёт 200 OK от прокси
      return;
    }
    if (connected) upstream!.write(d);
  });

  client.on('error', () => upstream?.destroy());
  client.on('close', () => upstream?.destroy());
  upstream.on('error', (err) => fail(`upstream ${up.host}:${up.port}: ${err.message}`));
  upstream.on('close', () => client.destroy());
}

const SOCKS_FAIL = Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const SOCKS_OK = Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const SOCKS_CMD_UNSUPPORTED = Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
const SOCKS_ATYP_UNSUPPORTED = Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

function handleSocksClient(client: net.Socket, up: ProxyEntry): void {
  let state: 0 | 1 | 2 | 3 = 0; // 0 greeting, 1 request, 2 connecting, 3 established
  let pending: Buffer[] = [];
  let upstream: net.Socket | null = null;

  const fail = () => {
    try {
      client.write(SOCKS_FAIL);
    } catch {
      /* ignore */
    }
    client.destroy();
    if (upstream) upstream.destroy();
  };

  const connectTo = (host: string, port: number) => {
    state = 2;
    const auth = Buffer.from(`${up.user}:${up.pass}`).toString('base64');
    const request =
      `CONNECT ${host}:${port} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      `Proxy-Connection: keep-alive\r\n\r\n`;

    upstream = net.connect({ host: up.host, port: up.port }, () => {
      upstream!.write(request);
    });

    let headerBuf = Buffer.alloc(0);
    let headerDone = false;

    upstream.on('data', (d: Buffer) => {
      if (!headerDone) {
        headerBuf = Buffer.concat([headerBuf, d]);
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx === -1) {
          if (headerBuf.length > 16384) fail();
          return;
        }
        const head = headerBuf.slice(0, idx).toString('utf8');
        const statusLine = head.split('\r\n')[0] || '';
        headerDone = true;
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          logError(`[Proxy] CONNECT ${host}:${port} через ${up.host}:${up.port} → ${statusLine}`);
          fail();
          return;
        }
        log(`[Proxy] CONNECT ${host}:${port} через ${up.host}:${up.port} → 200 OK`);
        state = 3;
        client.write(SOCKS_OK);
        const rest = headerBuf.slice(idx + 4);
        if (rest.length) client.write(rest);
        for (const b of pending) upstream!.write(b);
        pending = [];
        return;
      }
      client.write(d);
    });

    client.on('data', (d: Buffer) => {
      if (state === 3 && upstream) upstream.write(d);
      else if (state === 2) pending.push(d);
    });

    upstream.on('error', (err) => {
      logError(`[Proxy] Ошибка upstream ${up.host}:${up.port} (цель ${host}:${port}):`, err.message);
      fail();
    });
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream?.destroy());
    client.on('close', () => upstream?.destroy());
  };

  const handleRequest = (buf: Buffer) => {
    if (buf.length < 7 || buf[0] !== 5) {
      fail();
      return;
    }
    if (buf[1] !== 1) {
      client.end(SOCKS_CMD_UNSUPPORTED);
      return;
    }
    const atyp = buf[3];
    let host: string;
    let port: number;
    if (atyp === 1) {
      if (buf.length < 10) {
        fail();
        return;
      }
      host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      port = buf.readUInt16BE(8);
    } else if (atyp === 3) {
      const len = buf[4];
      if (buf.length < 5 + len + 2) {
        fail();
        return;
      }
      host = buf.slice(5, 5 + len).toString('utf8');
      port = buf.readUInt16BE(5 + len);
    } else {
      client.end(SOCKS_ATYP_UNSUPPORTED);
      return;
    }
    connectTo(host, port);
  };

  client.on('error', () => client.destroy());
  client.on('data', (chunk: Buffer) => {
    if (state === 0) {
      if (chunk.length < 2 || chunk[0] !== 5) {
        client.destroy();
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));
      const methods = chunk[1];
      const rest = chunk.slice(2 + methods);
      state = 1;
      if (rest.length) handleRequest(rest);
      return;
    }
    if (state === 1) handleRequest(chunk);
    // state 2/3 обрабатываются в connectTo
  });
}
