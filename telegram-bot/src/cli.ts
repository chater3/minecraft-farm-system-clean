/**
 * Автономный запуск авторега — без Telegram.
 *
 * Примеры:
 *   npm run reg                          # 1 случайный ник Auto_XXXX
 *   npm run reg -- --user TestPlayer1    # конкретный ник
 *   npm run reg -- --count 3 --prefix Bot
 *   npm run reg -- --skip-solver-check
 */
import 'dotenv/config';
import http from 'http';
import readline from 'readline/promises';
import { addAccount, getStats, resetInProgress, getKnownUsernames } from './database/db';
import { enqueueRegistration, type RegistrationResult } from './queue/taskManager';
import { log, logError, createRunLog, getRunLog } from './logger';
import { initProxies, startBridge, stopBridge } from './proxy/proxyBridge';
import { generateNicknames } from './nickname';
import { saveAccountFiles } from './export';

interface Options {
  users: string[];
  password: string;
  /** Явный префикс (--prefix) — только по просьбе; по умолчанию ники случайные */
  prefix: string | null;
  count: number;
  skipSolverCheck: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    users: [],
    password: process.env.DEFAULT_REG_PASSWORD || 'AutoPass123',
    prefix: null,
    count: 0,
    skipSolverCheck: false,
    timeoutMs: parseInt(process.env.RUN_TIMEOUT_MS || '900000', 10),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--user':
      case '-u':
        if (argv[i + 1]) opts.users.push(argv[++i]);
        break;
      case '--pass':
      case '-p':
        if (argv[i + 1]) opts.password = argv[++i];
        break;
      case '--prefix':
        if (argv[i + 1]) opts.prefix = argv[++i];
        break;
      case '--count':
      case '-c': {
        const n = parseInt(argv[++i] || '1', 10);
        opts.count = Number.isNaN(n) || n < 1 ? 1 : n;
        break;
      }
      case '--skip-solver-check':
        opts.skipSolverCheck = true;
        break;
      case '--timeout':
        if (argv[++i]) opts.timeoutMs = parseInt(argv[i], 10);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          logError(`Неизвестный аргумент: ${arg}`);
          printHelp();
          process.exit(2);
        }
        // без флага — считаем ником
        opts.users.push(arg);
    }
  }

  return opts;
}

function printHelp() {
  log(
    'Использование: npm run reg [--count <N>] [--user <ник>] [--pass <пароль>] [--prefix <префикс>] [--skip-solver-check] [--timeout <мс>]',
  );
  log('  --count N       — сразу N случайных уникальных ников (без общей приставки).');
  log('  --prefix X      — навязать префикс (по умолчанию ники полностью случайные).');
  log('  Без ников и --count в терминале — спросит, сколько аккаунтов запустить.');
}

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

async function main() {
  const runLogFile = createRunLog('autoreg');
  const opts = parseArgs(process.argv.slice(2));

  // --- выбор количества аккаунтов ---
  // Ники случайные и каждый раз разные (без общей приставки); уникальность
  // проверяется и по БД (getKnownUsernames), и внутри пачки.
  const addRandomNicks = (n: number) => {
    const fresh = generateNicknames(n, [...getKnownUsernames(), ...opts.users]);
    opts.users.push(...fresh);
  };

  if (opts.count > 0) {
    if (opts.prefix) {
      // явный --prefix: прежняя схема Префикс_XXXX
      const used = new Set([...getKnownUsernames(), ...opts.users]);
      for (let i = 0; i < opts.count; i++) {
        let nick = '';
        do {
          nick = `${opts.prefix}_${Math.floor(1000 + Math.random() * 9000)}`;
        } while (used.has(nick));
        used.add(nick);
        opts.users.push(nick);
      }
    } else {
      addRandomNicks(opts.count);
    }
  }

  if (opts.users.length === 0) {
    // ни --count, ни --user: в терминале спрашиваем, иначе 1 ник (как раньше)
    let count = 1;
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question('Сколько аккаунтов запустить? (Enter = 1): ')).trim();
        count = Math.max(1, parseInt(answer, 10) || 1);
      } finally {
        rl.close();
      }
    }
    addRandomNicks(count);
    log(`[CLI] Сгенерировано ников: ${count} (случайные, без общей приставки)`);
  }

  // дедупликация ников (БД помечает UNIQUE через INSERT OR IGNORE)
  opts.users = [...new Set(opts.users)];

  log('====================================================');
  log('АВТОНОМНЫЙ ЗАПУСК АВТОРЕГА (без Telegram)');
  log(`Лог запуска: ${runLogFile}`);
  log(`Ников: ${opts.users.length} | Пароль: ${opts.password}`);
  log(`Игровая папка: ${process.env.MINECRAFT_DIR}`);
  log(`Версия: ${process.env.MINECRAFT_VERSION} | Сервер: ${process.env.MINECRAFT_SERVER}`);
  log(`Память: ${process.env.MINECRAFT_XMS || '2G'}-${process.env.MINECRAFT_XMX || '4G'} | Параллельно: ${process.env.MAX_CONCURRENT_WORKERS || '1'}`);
  log(`Таймаут задачи: ${process.env.REG_TIMEOUT_MS || '420000'} мс | Общий таймаут: ${opts.timeoutMs} мс`);
  log('====================================================');

  const stale = resetInProgress();
  if (stale.changes > 0) log(`[DB] Сброшено зависших IN_PROGRESS: ${stale.changes}`);

  const solverUp = await checkSolver();
  if (!solverUp && !opts.skipSolverCheck) {
    logError('Captcha-сервер (http://127.0.0.1:5000) НЕ отвечает — авторег не сможет прочитать капчу.');
    logError('Запустите: cd captcha-solver && python app.py  (или повторите с --skip-solver-check)');
    process.exit(1);
  }
  log(solverUp ? '[OK] Captcha-сервер отвечает.' : '[WARN] Проверка captcha-сервера пропущена.');

  // прокси-пул + локальный SOCKS5-мост (с проверкой живости)
  const proxyCount = await initProxies();
  if (proxyCount > 0) {
    startBridge();
    log(`[OK] Прокси: ${proxyCount} шт., мост запущен.`);
  } else {
    log('[WARN] Прокси не используются.');
  }

  // страховка: не висеть вечно
  const watchdog = setTimeout(() => {
    logError(`[Watchdog] Превышен общий таймаут ${opts.timeoutMs} мс — аварийный выход.`);
    process.exit(2);
  }, opts.timeoutMs);
  watchdog.unref();

  const results: RegistrationResult[] = [];

  // задачи КЛАДЁМ в очередь все сразу — пул (PARALLEL) сам их распараллелит,
  // последовательный await в цикле грозил упереться в общий таймаут
  for (const user of opts.users) {
    addAccount(user, opts.password);
    log(`[CLI] Задача добавлена в очередь: ${user}`);
  }
  const settled = await Promise.all(
    opts.users.map((user) =>
      enqueueRegistration(user, opts.password).then((r) => {
        log(`[CLI] Результат ${user}: ${r.status} (${r.detail})`);
        return r;
      }),
    ),
  );
  results.push(...settled);

  clearTimeout(watchdog);
  stopBridge();

  const stats = getStats();
  const failed = results.filter((r) => r.status !== 'SUCCESS');

  log('====================================================');
  log('ИТОГ ЗАПУСКА:');
  for (const r of results) {
    log(`  ${r.status === 'SUCCESS' ? '✅' : '❌'} ${r.username} — ${r.detail}`);
  }
  log(`БД: всего ${stats.total} | успех ${stats.success} | ошибка ${stats.failed} | в процессе ${stats.inProgress}`);

  // ник + пароль — текстовыми файлами, чтобы не лезть в SQLite
  try {
    const { successFile, allFile } = saveAccountFiles();
    log(`[CLI] Ник+пароль сохранены: ${successFile} (успешных: ${stats.success})`);
    log(`[CLI] Полный список: ${allFile} (ник:пароль:статус, всего ${stats.total})`);
  } catch (err) {
    logError('[CLI] Не удалось сохранить файлы аккаунтов:', err);
  }

  log(`Лог: ${getRunLog()}`);
  log('====================================================');

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  logError('Фатальная ошибка CLI:', error);
  process.exit(1);
});
