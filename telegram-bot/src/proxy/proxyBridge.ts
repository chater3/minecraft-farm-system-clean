import fs from 'fs';
import net from 'net';
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
  'C:\\Users\\User\\Downloads\\Webshare 10 proxies.txt',
  'C:\\Users\\User\\Downloads\\Webshare 10 proxies (другой ак).txt',
];

export const PROXY_ENABLED = (process.env.PROXY_ENABLED || 'true').toLowerCase() !== 'false';
const BRIDGE_BASE_PORT = parseInt(process.env.PROXY_BRIDGE_PORT || '2081', 10);

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

/** JVM-аргументы SOCKS для очередного клиента (или [] если прокси нет). */
export function nextProxyJvmArgs(label: string): string[] {
  if (proxies.length === 0) return [];
  const p = proxies[cursor % proxies.length];
  cursor++;
  const port = BRIDGE_BASE_PORT + ((cursor - 1) % proxies.length);
  log(`[Proxy] ${label} → мост 127.0.0.1:${port} → ${p.host}:${p.port}`);
  return [`-DsocksProxyHost=127.0.0.1`, `-DsocksProxyPort=${port}`];
}

/* ---------------- SOCKS5 → HTTP CONNECT мост ---------------- */

export function startBridge(): boolean {
  if (!bridgeStarted && proxies.length > 0) {
    proxies.forEach((p, i) => {
      const port = BRIDGE_BASE_PORT + i;
      const server = net.createServer((sock) => handleSocksClient(sock, p));
      server.on('error', (err) => logError(`[Proxy] Ошибка моста 127.0.0.1:${port}:`, err));
      server.listen(port, '127.0.0.1', () => {
        log(`[Proxy] SOCKS5 мост 127.0.0.1:${port} → HTTP ${p.host}:${p.port}`);
      });
      servers.push(server);
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
