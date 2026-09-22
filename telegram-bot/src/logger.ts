import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

/** Каталог с логами: <корень проекта>/logs */
export const LOG_DIR = path.resolve(__dirname, '../../logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

/** Общий лог всех запусков */
const APP_LOG = path.join(LOG_DIR, 'app.log');

/** Лог текущего запуска (назначается через setRunLog) */
let runLog: string | null = null;

/**
 * Вывод в консоль выполняется в ОТДЕЛЬНОМ потоке.
 *
 * На Windows запись в консоль блокируется, пока окно в режиме выделения текста
 * (QuickEdit) или поставлено на паузу (Ctrl+S). Раньше такая блокировка
 * останавливала ВЕСЬ процесс: лог-файл, Telegram-поллинг и прокси-мосты
 * вставали целиком (инцидент 2026-09-22: молчание с 13:34:22). Теперь
 * блокируется только поток консоли — файлы и сеть продолжают работать.
 */
type ConsoleWriter = { post(line: string): void };

function createConsoleWriter(): ConsoleWriter {
  try {
    const worker = new Worker(
      `const { parentPort } = require('worker_threads');` +
        `parentPort.on('message', (line) => { try { process.stdout.write(line); } catch {} });`,
      { eval: true },
    );
    worker.unref();
    worker.on('error', () => {
      /* консаль отвалилась — просто не печатаем */
    });
    return { post: (line) => worker.postMessage(line) };
  } catch {
    // запасной путь: пишем напрямую (как раньше, с риском блокировки)
    return {
      post: (line) => {
        try {
          process.stdout.write(line);
        } catch {
          /* ignore */
        }
      },
    };
  }
}

const consoleOut = createConsoleWriter();

function format(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function write(line: string) {
  const decorated = `[${new Date().toISOString()}] ${line}`;
  // сначала файлы: даже если консоль зависнет, диагностика уже на диске
  try {
    fs.appendFileSync(APP_LOG, decorated + '\n');
    if (runLog) fs.appendFileSync(runLog, decorated + '\n');
  } catch {
    // логирование не должно ронять процесс
  }
  consoleOut.post(decorated + '\n');
}

/** Создать отдельный файл лога для текущего запуска и писать туда все строки */
export function createRunLog(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(LOG_DIR, `${prefix}-${stamp}.log`);
  fs.writeFileSync(file, `=== ${prefix} started ${new Date().toISOString()} ===\n`);
  runLog = file;
  return file;
}

export function getRunLog(): string | null {
  return runLog;
}

export function log(...args: unknown[]) {
  write(args.map(format).join(' '));
}

export function logError(...args: unknown[]) {
  write(`ERROR ${args.map(format).join(' ')}`);
}
