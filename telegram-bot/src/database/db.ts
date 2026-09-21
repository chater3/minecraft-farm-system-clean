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

export function getStats() {
  const total = (db.prepare('SELECT COUNT(*) as count FROM accounts').get() as { count: number }).count;
  const success = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'SUCCESS'").get() as { count: number }).count;
  const failed = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'FAILED'").get() as { count: number }).count;
  const inProgress = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE status = 'IN_PROGRESS'").get() as { count: number }).count;
  return { total, success, failed, inProgress };
}

export function exportToTxt(): string {
  const rows = db.prepare("SELECT username, password FROM accounts WHERE status = 'SUCCESS'").all() as { username: string; password: string }[];
  return rows.map(r => `${r.username}:${r.password}`).join('\n');
}