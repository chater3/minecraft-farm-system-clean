import fs from 'fs';
import { join } from 'path';
import { exportToTxt, exportAllToTxt, getStats } from './database/db';
import { LOG_DIR } from './logger';

/**
 * Пишет текстовые файлы аккаунтов после прогона:
 *   logs/success-accounts.txt — ник:пароль (только SUCCESS)
 *   logs/accounts-all.txt     — ник:пароль:статус (все)
 */
export function saveAccountFiles(): {
  successFile: string;
  allFile: string;
  stats: ReturnType<typeof getStats>;
} {
  const stats = getStats();
  const successFile = join(LOG_DIR, 'success-accounts.txt');
  const allFile = join(LOG_DIR, 'accounts-all.txt');
  const successData = exportToTxt();
  fs.writeFileSync(successFile, successData ? successData + '\n' : '', 'utf8');
  fs.writeFileSync(allFile, (exportAllToTxt() || '') + '\n', 'utf8');
  return { successFile, allFile, stats };
}
