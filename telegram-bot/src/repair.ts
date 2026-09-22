/**
 * Разовая/аварийная починка статусов по логам.
 *
 * 1) Нику, у которого в логах есть «Успешная регистрация» (REG_OK), но статус
 *    в БД FAILED (раньше EXIT 8 после /reg помечал успех провалом) → SUCCESS.
 * 2) Перегенерация файлов аккаунтов.
 * 3) Флаг `pending` — довести до конца ники, застрявшие в PENDING.
 *
 * Запуск: npx tsx src/repair.ts [pending]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { log, logError, createRunLog, getRunLog, LOG_DIR } from './logger';
import { getStats, promoteToSuccess, getUsernamesByStatus } from './database/db';
import { saveAccountFiles } from './export';
import { enqueueRegistration } from './queue/taskManager';
import { initProxies } from './proxy/proxyBridge';

/** Все ники с REG_OK из всех логов */
function collectRegOkUsers(): Set<string> {
  const ok = new Set<string>();
  for (const file of fs.readdirSync(LOG_DIR)) {
    if (!/^(bot|testrun|app).*\.log$/.test(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\[Minecraft ([^\]]+)\]:.*Успешная регистрация/g)) {
      ok.add(m[1]);
    }
  }
  return ok;
}

async function main(): Promise<void> {
  createRunLog('repair');
  log(`Лог: ${getRunLog()}`);
  const doPending = process.argv.includes('pending');
  // явные ники после флага — довести до конца конкретные аккаунты
  const explicit = process.argv.slice(2).filter((a) => a !== 'pending');

  const okUsers = collectRegOkUsers();
  log(`[Repair] Ников с REG_OK в логах: ${okUsers.size}`);

  const fixed = promoteToSuccess([...okUsers]);
  if (fixed > 0) log(`[Repair] Исправлено статусов FAILED → SUCCESS: ${fixed}`);

  const { stats } = saveAccountFiles();
  log(`[Repair] Файлы обновлены: успех ${stats.success} | ошибка ${stats.failed} | всего ${stats.total}`);

  if (!doPending && explicit.length === 0) return;

  // явные ники или все застрявшие PENDING
  const pending = explicit.length > 0 ? explicit : getUsernamesByStatus('PENDING');
  if (pending.length === 0) {
    log('[Repair] Нет застрявших PENDING — нечего доводить.');
    return;
  }
  log(`[Repair] Доводим: ${pending.join(', ')}`);

  const proxyCount = await initProxies();
  log(`[Repair] Живых прокси: ${proxyCount} (мосты используем бота)`);

  const results = await Promise.all(
    pending.map(async (n) => {
      const r = await enqueueRegistration(n, process.env.DEFAULT_REG_PASSWORD || 'AutoPass123');
      log(`[Repair] ${r.status === 'SUCCESS' ? '✅' : '❌'} ${n} — ${r.detail}`);
      return r;
    }),
  );

  const after = saveAccountFiles();
  const ok = results.filter((r) => r.status === 'SUCCESS').length;
  log(`[Repair] Доведено: ${ok}/${results.length} | БД: ${JSON.stringify(getStats())}`);
  log(`[Repair] Файлы: успех ${after.stats.success} | всего ${after.stats.total}`);
}

main().catch((err) => {
  logError('[Repair] Ошибка:', err);
  process.exit(1);
});
