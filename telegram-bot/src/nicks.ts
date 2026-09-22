/**
 * Простой авто-генератор ников — только генерация, без регистрации.
 *
 * Использование:
 *   npm run nicks               # 10 случайных ников
 *   npm run nicks -- --count 25 # 25 ников
 *   npm run nicks -- -n 5
 *
 * Ники уникальны (не повторяются с базой и внутри выдачи), без общей
 * приставки, валидны для Minecraft (3-16 символов [A-Za-z0-9_]).
 * Результат также пишется в logs/nicknames.txt (каждый запуск перезаписывает).
 */
import fs from 'fs';
import { join } from 'path';
import { generateNicknames } from './nickname';
import { getKnownUsernames } from './database/db';
import { LOG_DIR } from './logger';

function parseCount(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--count' || argv[i] === '-n' || argv[i] === '--nicks') {
      const n = parseInt(argv[++i] || '', 10);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 10;
    }
    if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Использование: npm run nicks [-- --count N]');
      process.exit(0);
    }
  }
  return 10;
}

const count = parseCount(process.argv.slice(2));
const nicks = generateNicknames(count, getKnownUsernames());

const file = join(LOG_DIR, 'nicknames.txt');
fs.writeFileSync(file, nicks.join('\n') + '\n', 'utf8');

console.log(`Сгенерировано ников: ${count}`);
console.log(nicks.join('\n'));
console.log(`\nСохранено: ${file}`);
