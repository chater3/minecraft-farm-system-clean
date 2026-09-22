/**
 * Тестовый прогон пачки БЕЗ остановки работающего бота.
 *
 * Мосты (SOCKS 2081+i / игровые туннели 22081+i) уже подняты ботом — startBridge()
 * НЕ вызываем (иначе EADDRINUSE-шторм), просто берём пул живых прокси, чтобы
 * адреса слотов у клиентов совпадали с портами ботовских мостов.
 *
 * Использование: npx tsx src/testrun.ts [кол-во]   (по умолчанию 4)
 */
import 'dotenv/config';
import http from 'http';
import { addAccount, getStats, getKnownUsernames, resetInProgress } from './database/db';
import { enqueueRegistration } from './queue/taskManager';
import { log, logError, createRunLog, getRunLog } from './logger';
import { initProxies } from './proxy/proxyBridge';
import { generateNicknames } from './nickname';

function checkSolver(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:5000/', (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function main(): Promise<void> {
  createRunLog('testrun');
  const count = Math.max(1, parseInt(process.argv[2] || '4', 10) || 4);
  const password = process.env.DEFAULT_REG_PASSWORD || 'AutoPass123';

  log('====================================================');
  log(`ТЕСТОВЫЙ ПРОГОН: ${count} аккунтов (мосты бота, Telegram не трогаем)`);
  log(`Лог: ${getRunLog()}`);

  const solverUp = await checkSolver();
  if (!solverUp) {
    logError('Captcha-сервер (127.0.0.1:5000) не отвечает — тест невозможен.');
    process.exit(1);
  }
  log('[OK] Captcha-сервер отвечает.');

  const proxyCount = await initProxies();
  if (proxyCount === 0) {
    logError('Ни один прокси не жив — тест невозможен.');
    process.exit(1);
  }
  log(`[OK] Живых прокси: ${proxyCount} (мосты используем бота)`);

  const stale = resetInProgress();
  if (stale.changes > 0) log(`[DB] Сброшено зависших IN_PROGRESS: ${stale.changes}`);

  const nicks = generateNicknames(count, getKnownUsernames());
  log(`Ники: ${nicks.join(', ')}`);

  const startedAt = Date.now();
  for (const n of nicks) addAccount(n, password);

  const results = await Promise.all(
    nicks.map(async (n) => {
      const t0 = Date.now();
      const r = await enqueueRegistration(n, password);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log(`[Test] ${r.status === 'SUCCESS' ? '✅' : '❌'} ${n} — ${secs}с — ${r.detail}`);
      return { nick: n, status: r.status, secs: Number(secs) };
    }),
  );

  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ok = results.filter((r) => r.status === 'SUCCESS').length;
  const stats = getStats();

  log('====================================================');
  log(`ИТОГ: ${ok}/${results.length} за ${totalSecs}с (параллельно ${process.env.MAX_CONCURRENT_WORKERS})`);
  for (const r of results) {
    log(`  ${r.status === 'SUCCESS' ? '✅' : '❌'} ${r.nick} — ${r.secs}с`);
  }
  log(`БД: всего ${stats.total} | успех ${stats.success} | ошибка ${stats.failed} | в процессе ${stats.inProgress}`);
  log('====================================================');

  process.exit(ok === results.length ? 0 : 1);
}

main().catch((error) => {
  logError('Фатальная ошибка теста:', error);
  process.exit(1);
});
