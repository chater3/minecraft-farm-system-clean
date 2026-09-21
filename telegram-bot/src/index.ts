import { Bot, InputFile } from 'grammy';
import { enqueueRegistration } from './queue/taskManager';
import { addAccount, getStats, exportToTxt } from './database/db';
import fs from 'fs';
import 'dotenv/config';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("ОШИБКА: Не указан BOT_TOKEN в файле .env!");
  process.exit(1);
}

/** Префикс для /autoreg (по умолчанию Auto) */
const AUTO_NICK_PREFIX = process.env.AUTO_NICK_PREFIX || 'Auto';
const DEFAULT_PASSWORD = process.env.DEFAULT_REG_PASSWORD || 'AutoPass123';

const bot = new Bot(BOT_TOKEN);

bot.command('start', (ctx) => {
  ctx.reply(
    '🤖 Панель управления Авторегером FunTime.\n\n' +
      '/reg <логин> <пароль> — добавить аккаунт в очередь\n' +
      `/autoreg <кол-во> [пароль] — массовая рега с префиксом \`${AUTO_NICK_PREFIX}_\`\n` +
      '/massreg <префикс> <пароль> <кол-во> — массовая генерация со своим префиксом\n' +
      '/stats — посмотреть статистику\n' +
      '/export — скачать .txt базу успешных аккаунтов',
  );
});

bot.command('reg', async (ctx) => {
  const args = ctx.match.split(' ');
  if (args.length < 2 || !args[0] || !args[1]) {
    return ctx.reply('⚠️ Ошибка. Формат: `/reg <логин> <пароль>`');
  }

  const [username, password] = args;
  addAccount(username, password);
  enqueueRegistration(username, password);

  await ctx.reply(`📥 Задача для \`${username}\` добавлена в очередь!`);
});

/** Отдельная команда: ники только с префиксом Auto (или AUTO_NICK_PREFIX из .env) */
bot.command('autoreg', async (ctx) => {
  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  if (args.length < 1 || isNaN(Number(args[0]))) {
    return ctx.reply(
      `⚠️ Формат: \`/autoreg <количество> [пароль]\`\n` +
        `Пример: \`/autoreg 5\` или \`/autoreg 10 myPass\`\n` +
        `Ники: \`${AUTO_NICK_PREFIX}_XXXX\``,
    );
  }

  const count = parseInt(args[0], 10);
  const password = args[1] || DEFAULT_PASSWORD;

  if (count < 1 || count > 100) {
    return ctx.reply('⚠️ Количество должно быть от 1 до 100.');
  }

  await ctx.reply(
    `🚀 /autoreg: ${count} аккаунтов с префиксом \`${AUTO_NICK_PREFIX}_\`, пароль: \`${password}\``,
  );

  for (let i = 0; i < count; i++) {
    const randomStr = Math.floor(1000 + Math.random() * 9000).toString();
    const username = `${AUTO_NICK_PREFIX}_${randomStr}`;

    addAccount(username, password);
    enqueueRegistration(username, password);
  }
});

bot.command('massreg', async (ctx) => {
  const args = ctx.match.split(' ');
  if (args.length < 3 || !args[0] || !args[1] || isNaN(Number(args[2]))) {
    return ctx.reply(
      '⚠️ Ошибка. Формат: `/massreg <префикс_логина> <пароль> <количество>`\nПример: `/massreg FarmBot1 myPass 10`',
    );
  }

  const prefix = args[0];
  const password = args[1];
  const count = parseInt(args[2], 10);

  await ctx.reply(`🚀 Запуск массовой регистрации ${count} аккаунтов...`);

  for (let i = 0; i < count; i++) {
    const randomStr = Math.floor(1000 + Math.random() * 9000).toString();
    const username = `${prefix}_${randomStr}`;

    addAccount(username, password);
    enqueueRegistration(username, password);
  }
});

bot.command('stats', async (ctx) => {
  const stats = getStats();
  await ctx.reply(
    `📊 **Статистика:**\n\n` +
      `Всего обработано: ${stats.total}\n` +
      `В процессе: ⏳ ${stats.inProgress}\n` +
      `Успешно: ✅ ${stats.success}\n` +
      `Ошибки: ❌ ${stats.failed}`,
  );
});

bot.command('export', async (ctx) => {
  const data = exportToTxt();
  if (!data) {
    return ctx.reply('📭 Успешных аккаунтов пока нет.');
  }

  const filePath = 'successful_accounts.txt';
  fs.writeFileSync(filePath, data);

  await ctx.replyWithDocument(new InputFile(filePath), {
    caption: '📋 Экспорт успешных аккаунтов',
  });
});

bot.start();
console.log('[+] Telegram Bot запущен и готов к работе!');
console.log(`[+] /autoreg префикс: ${AUTO_NICK_PREFIX}_`);
