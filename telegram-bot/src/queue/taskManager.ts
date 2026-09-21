import PQueue from 'p-queue';
import { join } from 'path';
import {
  Argument,
  Launcher,
  LauncherFolder,
  MVersion,
  OfflineAuthenticator,
  readJson,
  type IMVersion,
} from 'minecraft-launcher-lib';
import { updateStatus } from '../database/db';
import 'dotenv/config';

const concurrencyLimit = parseInt(process.env.MAX_CONCURRENT_WORKERS || '1', 10);
const queue = new PQueue({ concurrency: concurrencyLimit });

const GAME_DIR =
  process.env.MINECRAFT_DIR ||
  'C:\\Users\\User\\AppData\\Roaming\\.tlauncher\\legacy\\Minecraft\\game';
const VERSION_ID = process.env.MINECRAFT_VERSION || 'Fabric 1.21.4';
const JAVA_PATH = process.env.JAVA_PATH || 'java';
const SERVER_HOST = process.env.MINECRAFT_SERVER || 'mc.funtime.su';
const MEMORY_MAX = process.env.MINECRAFT_XMX || '4G';
const MEMORY_MIN = process.env.MINECRAFT_XMS || '2G';

async function loadVersion(folder: LauncherFolder, versionId: string): Promise<MVersion> {
  const versionJsonPath = join(folder.getVersionPath(versionId), `${versionId}.json`);
  const child = await readJson<IMVersion>(versionJsonPath);

  if (child.inheritsFrom) {
    const parent = await loadVersion(folder, child.inheritsFrom);
    return MVersion.from(child, parent.toJSON());
  }

  return MVersion.from(child);
}

/**
 * TLauncher stores values like `-DFabricMcEmu= net.minecraft.client.main.Main `
 * (spaces around the class). minecraft-launcher-lib splits on whitespace, so
 * Java treats Main as the real main class and ignores KnotClient.
 */
function repairSplitJvmProperties(version: MVersion) {
  for (const arg of version.args.jvm) {
    if (arg.value.length <= 1) continue;
    if (!arg.value[0]?.startsWith('-D')) continue;

    const joined = arg.value.join(' ').trim();
    const match = joined.match(/^-D([^=]+)=\s*(.*)$/);
    if (match) {
      arg.value = [`-D${match[1]}=${match[2].trim()}`];
    }
  }
}

export function enqueueRegistration(username: string, password: string) {
  queue.add(async () => {
    console.log(`[Queue] Старт задачи для аккаунта: ${username}`);
    updateStatus(username, 'IN_PROGRESS');

    try {
      const folder = LauncherFolder.from(GAME_DIR);
      const minecraftVersion = await loadVersion(folder, VERSION_ID);
      repairSplitJvmProperties(minecraftVersion);

      const launcher = new Launcher({
        auth: new OfflineAuthenticator(username).getAuth(),
        folder,
        minecraftVersion,
        features: {
          is_quick_play_multiplayer: true,
        },
        // extraArgs полностью заменяет дефолты библиотеки — память задаём явно
        extraArgs: {
          jvm: [
            Argument.from([`-Xmx${MEMORY_MAX}`]),
            Argument.from([`-Xms${MEMORY_MIN}`]),
            Argument.from([`-Dfarm.password=${password}`]),
          ],
        },
        overrides: {
          quickPlayMultiplayer: SERVER_HOST,
          clientid: '',
          auth_xuid: '',
        },
      });

      const launchArgs = launcher.constructArguments();
      const mainClass = 'net.fabricmc.loader.impl.launch.knot.KnotClient';
      if (!launchArgs.includes(mainClass)) {
        throw new Error(
          `KnotClient отсутствует в аргументах запуска. Проверьте repairSplitJvmProperties / версию ${VERSION_ID}.`,
        );
      }

      console.log(`[Queue] Запуск клиента Minecraft для никнейма: ${username} → ${SERVER_HOST}`);

      const minecraft = launcher.launch(JAVA_PATH);

      await new Promise<void>((resolve) => {
        const log = (chunk: Buffer | string) => {
          console.log(`[Minecraft Output]: ${chunk.toString().trimEnd()}`);
        };

        minecraft.stdout?.on('data', log);
        minecraft.stderr?.on('data', log);

        minecraft.on('error', (error) => {
          console.error('[Queue Error] Ошибка процесса Minecraft:', error);
          updateStatus(username, 'FAILED');
          resolve();
        });

        minecraft.on('close', (code) => {
          console.log(`[Queue] Процесс для ${username} завершился с кодом ${code}`);

          if (code === 0) {
            updateStatus(username, 'SUCCESS');
            console.log(`[Queue] Аккаунт ${username} успешно зарегистрирован! ✅`);
          } else {
            updateStatus(username, 'FAILED');
            console.error(`[Queue] Ошибка при регистрации ${username} (код: ${code}). ❌`);
          }

          setTimeout(resolve, 5000);
        });
      });
    } catch (error) {
      console.error('[Queue Error] Ошибка при запуске через Launcher:', error);
      updateStatus(username, 'FAILED');
    }
  });
}
