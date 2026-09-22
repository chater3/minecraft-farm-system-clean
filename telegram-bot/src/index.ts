/**
 * Telegram-бот: панель управления авторегом FunTime.
 *
 * Команды:
 *   /run <кол-во> [пароль] — запуск пачки со СЛУЧАЙНЫМИ уникальными никами
 *   /reg <логин> <пароль>  — один конкретный ник
 *   /stats                 — статистика БД
 *   /export                — скачать success-accounts.txt (ник:пароль)
 *   /exportall             — скачать accounts-all.txt (ник:пароль:статус)
 *
 * При старте: проверка captcha-сервера, загрузка прокси и подъём мостов
 * (SOCKS для authlib + игровые TCP-туннели), сброс зависших IN_PROGRESS.
 */
import { Bot, InputFile, type Context } from 'grammy';
import http from 'http';
import { enqueueRegistration, type RegistrationResult } from './queue/taskManager';
import { addAccount, getStats, resetInProgress, getKnownUsernames, getStatus } from './database/db';
import { generateNicknames } from './nickname';
import { saveAccountFiles } from './export';
import { log, logError, createRunLog, getRunLog } from './logger';
import { initProxies, startBridge } from './proxy/proxyBridge';
import 'dotenv/config';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ОШИБКА: Не указан BOT_TOKEN в файле .env!');
  process.exit(1);
}

const DEFAULT_PASSWORD = process.env.DEFAULT_REG_PASSWORD || 'AutoPass123';
/** Лимит пачки из Telegram (защита от случайного /run 10000) */
const MAX_BATCH = parseInt(process.env.MAX_BATCH || '100', 10);

const bot = new Bot(BOT_TOKEN);

/* ---------- диагностика на старте ---------- */

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

let solverUp = false;
let proxyCount = 0;

async function bootstrap(): Promise<void> {
  createRunLog('bot');
  log('====================================================');
  log('TELEGRAM-БОТ: старт панели управления');
  log(`Лог запуска: ${getRunLog()}`);

  const stale = resetInProgress();
  if (stale.changes > 0) log(`[DB] Сброшено зависших IN_PROGRESS: ${stale.changes}`);

  solverUp = await checkSolver();
  if (solverUp) {
    log('[OK] Captcha-сервер отвечает.');
  } else {
    logError('[WARN] Captcha-сервер (127.0.0.1:5000) не отвечает — /run и /reg будут отклонены.');
  }

  proxyCount = await initProxies();
  if (proxyCount > 0) {
    startBridge();
    log(`[OK] Прокси: ${proxyCount} шт., мост (SOCKS + игровые туннели) запущен.`);
  } else {
    log('[WARN] Прокси не используются — прямое подключение.');
  }
  log('====================================================');
}

/* ---------- общие обработчики ---------- */

bot.catch((err) => logError('[Bot] Ошибка обработчика:', err.error));

bot.command('start', (ctx) =>
  ctx.reply(
    '🤖 Панель управления Авторегом FunTime.\n\n' +
      `/run <кол-во> [пароль] — запуск пачки, ники случайные и каждый раз разные\n` +
      '/reg <логин> <пароль> — один конкретный ник\n' +
      '/stats — статистика базы\n' +
      '/export — скачать .txt успешных аккаунтов (ник:пароль)\n' +
      '/exportall — скачать .txt всех аккаунтов (ник:пароль:статус)',
  ),
);

bot.command('stats', (ctx) => {
  const s = getStats();
  return ctx.reply(
    `📊 Статистика:\n\n` +
      `Всего обработано: ${s.total}\n` +
      `В процессе: ⏳ ${s.inProgress}\n` +
      `Успешно: ✅ ${s.success}\n` +
      `Ошибки: ❌ ${s.failed}\n\n` +
      `Captcha-сервер: ${solverUp ? '✅' : '❌'} | Прокси: ${proxyCount > 0 ? `✅ ${proxyCount} шт.` : '❌'}`,
  );
});

bot.command('export', async (ctx) => {
  const { successFile, stats } = saveAccountFiles();
  if (stats.success === 0) {
    return ctx.reply('📭 Успешных аккаунтов пока нет.');
  }
  return ctx.replyWithDocument(new InputFile(successFile), {
    caption: `📋 Успешные аккаунты: ${stats.success} шт. (ник:пароль)`,
  });
});

bot.command('exportall', async (ctx) => {
  const { allFile, stats } = saveAccountFiles();
  if (stats.total === 0) {
    return ctx.reply('📭 База пуста.');
  }
  return ctx.replyWithDocument(new InputFile(allFile), {
    caption: `📋 Все аккаунты: ${stats.total} шт. (ник:пароль:статус)`,
  });
});

/** Единая точка запуска пачки: ждём все задачи, пишем файлы, шлём итог. */
async function runBatch(ctx: Context, users: string[], password: string): Promise<void> {
  if (!solverUp) {
    solverUp = await checkSolver();
    if (!solverUp) {
      await ctx.reply(
        '❌ Captcha-сервер (http://127.0.0.1:5000) не отвечает — авторег не прочитает капчу.\n' +
          'Запустите: cd captcha-solver && python app.py',
      );
      return;
    }
  }

  const taken = new Set(getKnownUsernames());
  const blocked: string[] = [];
  for (const u of users) {
    const status = taken.has(u) ? getStatus(u) : null;
    // уже зарегистрирован или прямо сейчас в работе — не трогаем;
    // FAILED/PENDING можно чинить повторным запуском
    if (status === 'SUCCESS' || status === 'IN_PROGRESS') {
      blocked.push(`${u} (${status})`);
      users = users.filter((x) => x !== u);
    }
  }
  if (blocked.length > 0) {
    await ctx.reply(`⚠️ Пропущены (уже в базе): ${blocked.join(', ')}`);
  }
  if (users.length === 0) return;

  await ctx.reply(
    `🚀 В очередь: ${users.length} акк. | пароль: ${password}\n` +
      users.map((u) => `• ${u}`).join('\n'),
  );

  for (const u of users) addAccount(u, password);

  const results: RegistrationResult[] = await Promise.all(
    users.map((u) =>
      enqueueRegistration(u, password).then((r) => {
        log(`[Bot] Результат ${r.username}: ${r.status} (${r.detail})`);
        return r;
      }),
    ),
  );

  // ник + пароль — текстовыми файлами (после каждой пачки)
  const { successFile, allFile, stats } = saveAccountFiles();

  const lines = results.map(
    (r) => `${r.status === 'SUCCESS' ? '✅' : '❌'} ${r.username} — ${r.detail}`,
  );
  const ok = results.filter((r) => r.status === 'SUCCESS').length;

  await ctx.reply(
    `📋 ИТОГ ПАЧКИ: ${ok}/${results.length} успешно\n\n` +
      lines.join('\n') +
      `\n\nБД: всего ${stats.total} | успех ${stats.success} | ошибка ${stats.failed}` +
      `\nФайлы обновлены:\n• success-accounts.txt (${stats.success})\n• accounts-all.txt (${stats.total})`,
  );

  if (stats.success > 0) {
    await ctx.replyWithDocument(new InputFile(successFile), {
      caption: `✅ Успешные аккаунты: ${stats.success} шт. (ник:пароль)`,
    });
  }
}

/* ---------- команды запуска ---------- */

bot.command('run', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  const count = parseInt(args[0] || '', 10);
  const password = args[1] || DEFAULT_PASSWORD;

  if (!Number.isFinite(count) || count < 1 || count > MAX_BATCH) {
    return ctx.reply(
      `⚠️ Формат: /run <количество> [пароль]\n` +
        `Количество: 1..${MAX_BATCH}. Пример: /run 5 или /run 10 myPass\n` +
        `Ники будут случайными и каждый раз разными (без общей приставки).`,
    );
  }

  // случайные уникальные ники: не повторяются с БД и внутри пачки
  const users = generateNicknames(count, getKnownUsernames());
  await runBatch(ctx, users, password);
});

bot.command('reg', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  if (args.length < 2) {
    return ctx.reply('⚠️ Формат: /reg <логин> <пароль>');
  }
  const [username, password] = args;
  await runBatch(ctx, [username], password);
});

/* ---------- запуск ---------- */

bootstrap()
  .then(() => {
    log('[+] Telegram Bot запущен и готов к работе!');
    log('[+] Команды: /run /reg /stats /export /exportall');
    bot.start().catch((err) => {
      if (String(err).includes('409')) {
        logError(
          '[Bot] Конфликт getUpdates (409): уже запущен другой экземпляр бота. ' +
            'Оставьте только один npm start — этот закрыт.',
        );
      } else {
        logError('[Bot] Поллинг остановлен:', err);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    logError('Фатальная ошибка бота:', err);
    process.exit(1);
  });
