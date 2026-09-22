import fs from 'fs';
import path from 'path';

/** Каталог с логами: <корень проекта>/logs */
const LOG_DIR = path.resolve(__dirname, '../../logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

/** Общий лог всех запусков */
const APP_LOG = path.join(LOG_DIR, 'app.log');

/** Лог текущего запуска (назначается через setRunLog) */
let runLog: string | null = null;

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
  process.stdout.write(decorated + '\n');
  try {
    fs.appendFileSync(APP_LOG, decorated + '\n');
    if (runLog) fs.appendFileSync(runLog, decorated + '\n');
  } catch {
    // логирование не должно ронять процесс
  }
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
