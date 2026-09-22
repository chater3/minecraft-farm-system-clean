import PQueue from 'p-queue';
import { join, basename } from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import type { ChildProcess } from 'child_process';
import {
  Argument,
  Launcher,
  LauncherFolder,
  MVersion,
  OfflineAuthenticator,
  readJson,
  type IMVersion,
} from 'minecraft-launcher-lib';
import { updateStatus } from '../database/db';
import { log, logError, LOG_DIR } from '../logger';
import { nextProxyJvmArgs } from '../proxy/proxyBridge';
import 'dotenv/config';

const concurrencyLimit = parseInt(process.env.MAX_CONCURRENT_WORKERS || '1', 10);
const queue = new PQueue({ concurrency: concurrencyLimit });

const GAME_DIR = (
  process.env.MINECRAFT_DIR ||
  'C:\\Users\\User\\AppData\\Roaming\\.tlauncher\\legacy\\Minecraft\\game'
).replace(/\\\\/g, '\\'); // в .env бывают двойные обратные слеши
const VERSION_ID = process.env.MINECRAFT_VERSION || 'Fabric 1.21.4';
const JAVA_PATH = process.env.JAVA_PATH || 'java';
const SERVER_HOST = process.env.MINECRAFT_SERVER || 'mc.funtime.su';
const MEMORY_MAX = process.env.MINECRAFT_XMX || '4G';
const MEMORY_MIN = process.env.MINECRAFT_XMS || '2G';
/** Страховка: если клиент не завершился сам — убиваем и помечаем FAILED */
const TASK_TIMEOUT_MS = parseInt(process.env.REG_TIMEOUT_MS || '420000', 10);

export type RegistrationResult = {
  username: string;
  status: 'SUCCESS' | 'FAILED';
  detail: string;
};

async function loadVersion(folder: LauncherFolder, versionId: string): Promise<MVersion> {
  const versionJsonPath = join(folder.getVersionPath(versionId), `${versionId}.json`);
  const child = await readJson<IMVersion>(versionJsonPath);

  if (child.inheritsFrom) {
    const parent = await loadVersion(folder, child.inheritsFrom);
    return MVersion.from(child, parent.toJSON());
  }

  return MVersion.from(child);
}

/**
 * TLauncher stores values like `-DFabricMcEmu= net.minecraft.client.main.Main `
 * (spaces around the class). minecraft-launcher-lib splits on whitespace, so
 * Java treats Main as the real main class and ignores KnotClient.
 */
function repairSplitJvmProperties(version: MVersion) {
  for (const arg of version.args.jvm) {
    if (arg.value.length <= 1) continue;
    if (!arg.value[0]?.startsWith('-D')) continue;

    const joined = arg.value.join(' ').trim();
    const match = joined.match(/^-D([^=]+)=\s*(.*)$/);
    if (match) {
      arg.value = [`-D${match[1]}=${match[2].trim()}`];
    }
  }
}

/**
 * TLauncher-профили могут содержать две версии одного артефакта
 * (в "Fabric 1.21.4" лежат и asm:9.6, и asm:9.10.1). Fabric loader на этом
 * падает с `duplicate ASM classes found on classpath`, поэтому оставляем
 * в classpath только новейшую версию каждого артефакта.
 */
function parseVersionParts(version: string): number[] {
  return version.split(/[.\-+_]/).map((part) => parseInt(part, 10) || 0);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersionParts(candidate);
  const b = parseVersionParts(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Возвращает список выкинутых дублей (пустой список = дублей не было) */
function dedupeLibraries(version: MVersion): string[] {
  type Lib = MVersion['libraries'][number];
  const kept = new Map<string, Lib>();
  const dropped: string[] = [];

  for (const lib of version.libraries) {
    const parts = lib.name.split(':');
    if (parts.length < 3) continue;

    const key = `${parts[0]}:${parts[1]}${parts[3] ? `:${parts[3]}` : ''}`;
    const existing = kept.get(key);

    if (!existing) {
      kept.set(key, lib);
      continue;
    }

    const existingVersion = existing.name.split(':')[2];
    const candidateVersion = parts[2];

    if (isNewerVersion(candidateVersion, existingVersion)) {
      dropped.push(existing.name);
      kept.set(key, lib);
    } else {
      dropped.push(lib.name);
    }
  }

  if (dropped.length > 0) {
    version.libraries = [...kept.values()];
  }
  return dropped;
}

/* ---------- Разбор вывода клиента: успех/провал ---------- */

const FAILURE_MARKERS = [
  'не прошли проверку',
  'вы были кикнуты',
  'kicked by',
  'disconnect.kicked',
  'STATE EXIT 3',
  'STATE EXIT 4',
  'STATE EXIT 5',
  'STATE EXIT 6',
  'STATE EXIT 7',
];

const SUCCESS_MARKERS = ['STATE EXIT 0', 'Успешная регистрация'];

function classifyOutput(lines: string[]): { ok: boolean; why: string } {
  const all = lines.join('\n');
  const lower = all.toLowerCase();

  for (const marker of FAILURE_MARKERS) {
    if (lower.includes(marker.toLowerCase())) {
      return { ok: false, why: `найден маркер провала: "${marker}"` };
    }
  }
  for (const marker of SUCCESS_MARKERS) {
    if (all.includes(marker)) {
      return { ok: true, why: `найден маркер успеха: "${marker}"` };
    }
  }
  return { ok: false, why: 'маркеров успеха не найдено' };
}

/** Скриншоты клиента (F2-режим мода) за время задачи копируем в logs/screenshots */
function collectScreenshots(username: string, startedAt: number): string[] {
  const src = join(GAME_DIR, 'screenshots');
  const dst = join(LOG_DIR, 'screenshots');
  const copied: string[] = [];
  try {
    if (!fs.existsSync(src)) {
      logError(`[Screenshots] Папка не найдена: ${src}`);
      return copied;
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      // мод пишет файлы БЕЗ расширения (autoreg_wall_<ts>), поэтому пропускаем
      // только явно не-изображения (точка есть, но это не картинка)
      const lower = name.toLowerCase();
      if (lower.includes('.') && !/\.(png|jpe?g|webp)$/.test(lower)) continue;
      const file = join(src, name);
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs < startedAt - 5000) continue;
        const target = join(dst, `${username}-${name}`);
        fs.copyFileSync(file, target);
        copied.push(target);
      } catch (err) {
        logError(`[Screenshots] Не удалось скопировать ${file}:`, err);
      }
    }
  } catch (err) {
    logError('[Screenshots] Ошибка чтения папки screenshots:', err);
  }
  return copied;
}

/** На Windows child.kill() не убивает дерево процессов — гасим через taskkill */
function forceKill(child: ChildProcess) {
  if (!child.pid || child.killed || child.exitCode !== null) return;
  exec(`taskkill /PID ${child.pid} /T /F`, () => {
    /* результат не важен */
  });
}

export function enqueueRegistration(username: string, password: string): Promise<RegistrationResult> {
  return queue.add(async (): Promise<RegistrationResult> => {
    log(`[Queue] Старт задачи для аккаунта: ${username}`);
    updateStatus(username, 'IN_PROGRESS');

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const folder = LauncherFolder.from(GAME_DIR);
      const minecraftVersion = await loadVersion(folder, VERSION_ID);
      repairSplitJvmProperties(minecraftVersion);

      const droppedLibs = dedupeLibraries(minecraftVersion);
      if (droppedLibs.length > 0) {
        log(`[Preflight] Убраны дубли библиотек из classpath: ${droppedLibs.join(', ')}`);
      }

      const proxyArgs = nextProxyJvmArgs(username);
      if (proxyArgs.length > 0) {
        log(`[Preflight] JVM proxy args: ${proxyArgs.join(' ')}`);
      }

      const launcher = new Launcher({
        auth: new OfflineAuthenticator(username).getAuth(),
        folder,
        minecraftVersion,
        features: {
          is_quick_play_multiplayer: true,
        },
        // extraArgs полностью заменяет дефолты библиотеки — память задаём явно
        extraArgs: {
          jvm: [
            Argument.from([`-Xmx${MEMORY_MAX}`]),
            Argument.from([`-Xms${MEMORY_MIN}`]),
            Argument.from([`-Dfarm.password=${password}`]),
            ...proxyArgs.map((a) => Argument.from([a])),
          ],
        },
        overrides: {
          quickPlayMultiplayer: SERVER_HOST,
          clientid: '',
          auth_xuid: '',
        },
      });

      const launchArgs = launcher.constructArguments();
      const mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
      if (!launchArgs.includes(mainClass)) {
        throw new Error(
          `KnotClient отсутствует в аргументах запуска. Проверьте repairSplitJvmProperties / версию ${VERSION_ID}.`,
        );
      }

      log(`[Queue] Запуск клиента Minecraft для никнейма: ${username} → ${SERVER_HOST}`);

      const startedAt = Date.now();
      const outputLines: string[] = [];
      const minecraft = launcher.launch(JAVA_PATH);

      const result = await new Promise<RegistrationResult>((resolve) => {
        let settled = false;

        const finish = (status: 'SUCCESS' | 'FAILED', detail: string) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          const shots = collectScreenshots(username, startedAt);
          if (shots.length > 0) {
            log(`[Screenshots] Скопировано ${shots.length} шт. для ${username}:`);
            for (const s of shots) log(`[Screenshots]   ${s}`);
          }
          resolve({ username, status, detail });
        };

        const logOutput = (chunk: Buffer | string) => {
          const text = chunk.toString().trimEnd();
          if (!text) return;
          outputLines.push(text);
          log(`[Minecraft ${username}]: ${text}`);
        };

        minecraft.stdout?.on('data', logOutput);
        minecraft.stderr?.on('data', logOutput);

        timeoutHandle = setTimeout(() => {
          logError(`[Queue] Таймаут ${TASK_TIMEOUT_MS} мс для ${username} — убиваем клиент.`);
          forceKill(minecraft);
          finish('FAILED', `timeout after ${TASK_TIMEOUT_MS} ms`);
        }, TASK_TIMEOUT_MS);

        minecraft.on('error', (error: Error) => {
          logError('[Queue Error] Ошибка процесса Minecraft:', error);
          finish('FAILED', `process error: ${error.message}`);
        });

        minecraft.on('close', (code: number | null) => {
          log(`[Queue] Процесс для ${username} завершился с кодом ${code}`);

          const verdict = classifyOutput(outputLines);
          if (verdict.ok) {
            updateStatus(username, 'SUCCESS');
            log(`[Queue] Аккаунт ${username}: ${verdict.why} ✅`);
            setTimeout(() => finish('SUCCESS', verdict.why), 3000);
          } else {
            updateStatus(username, 'FAILED');
            logError(
              `[Queue] Аккаунт ${username}: ${verdict.why} (exit code ${String(code)}). ❌`,
            );
            setTimeout(() => finish('FAILED', `${verdict.why}; exit code ${String(code)}`), 3000);
          }
        });
      });

      return result;
    } catch (error) {
      const detail = error instanceof Error ? (error.stack || error.message) : String(error);
      logError('[Queue Error] Ошибка при запуске через Launcher:', detail);
      updateStatus(username, 'FAILED');
      return { username, status: 'FAILED', detail };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }) as Promise<RegistrationResult>;
}

/** Дождаться завершения всех задач в очереди */
export function waitIdle(): Promise<void> {
  return queue.onIdle();
}
