import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Убедимся, что папка для базы существует
const dbPath = path.resolve(__dirname, '../../accounts.db');
const db = new Database(dbPath);

// Создание таблицы, если ее нет
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export function addAccount(username: string, password: string) {
  const stmt = db.prepare('INSERT OR IGNORE INTO accounts (username, password, status) VALUES (?, ?, ?)');
  return stmt.run(username, password, 'PENDING');
}

export function updateStatus(username: string, status: 'SUCCESS' | 'FAILED' | 'IN_PROGRESS') {
  const stmt = db.prepare('UPDATE accounts SET status = ? WHERE username = ?');
  return stmt.run(status, username);
}

/** Зависшие IN_PROGRESS (после падения процесса) помечаем FAILED */
export function resetInProgress() {
  return db.prepare("UPDATE accounts SET status = 'FAILED' WHERE status = 'IN_PROGRESS'").run();
}

/** Все известные ники — для генератора случайных ников (никогда не повторять) */
export function getKnownUsernames(): string[] {
  return (db.prepare('SELECT username FROM accounts').all() as { username: string }[]).map(
    (r) => r.username,
  );
}

/** Текущий статус ника или null, если ника в базе нет */
export function getStatus(username: string): string | null {
  const row = db.prepare('SELECT status FROM accounts WHERE username = ?').get(username) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

/**
 * Починка статусов: ник с подтверждённой регистрацией в логах (REG_OK), но со
 * статусом FAILED (раньше кик после /reg считался провалом) → SUCCESS.
 * Возвращает число исправленных строк.
 */
export function promoteToSuccess(usernames: string[]): number {
  if (usernames.length === 0) return 0;
  const stmt = db.prepare(
    "UPDATE accounts SET status = 'SUCCESS' WHERE status = 'FAILED' AND username = ?",
  );
  let changed = 0;
  const run = db.transaction((list: string[]) => {
    for (const u of list) changed += stmt.run(u).changes;
  });
  run(usernames);
  return changed;
}

/** Никуи с указанным статусом (например, застрявшие PENDING) */
export function getUsernamesByStatus(status: string): string[] {
  return (
    db.prepare('SELECT username FROM accounts WHERE status = ?').all(status) as {
      username: string;
    }[]
  ).map((r) => r.username);
}

export function getStats() {
  const total = (db.prepare('SELECT COUNT(*) as count FROM accounts').get() as { count: number }).count;
  const success = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'SUCCESS'").get() as { count: number }).count;
  const failed = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'FAILED'").get() as { count: number }).count;
  const inProgress = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'IN_PROGRESS'").get() as { count: number }).count;
  return { total, success, failed, inProgress };
}

export function exportToTxt(): string {
  const rows = db.prepare("SELECT username, password FROM accounts WHERE status = 'SUCCESS'").all() as { username: string; password: string | null }[];
  return rows.map(r => `${r.username}:${r.password ?? ''}`).join('\n');
}

/** Все аккаунты: ник:пароль:статус — полный инвентарь для отчёта/повтора */
export function exportAllToTxt(): string {
  const rows = db.prepare('SELECT username, password, status FROM accounts').all() as { username: string; password: string | null; status: string }[];
  return rows.map(r => `${r.username}:${r.password ?? ''}:${r.status}`).join('\n');
}