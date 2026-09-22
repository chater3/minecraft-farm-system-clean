/**
 * Генератор случайных ников Minecraft (3-16 символов, [A-Za-z0-9_]).
 *
 * Никакой общей приставки: каждый ник — случайная комбинация двух разных слов
 * и цифр (EmberAurora12, frost_ripple840, cometvale...). Уникальность
 * проверяется по переданному набору (обычно — все ников из БД + уже
 * сгенерированные в текущей партии), поэтому ники не повторяются и между
 * запусками, и внутри одного пакета.
 */

const POOL_A = [
  'Amber', 'Arcane', 'Arctic', 'Astral', 'Azure', 'Bitter', 'Black', 'Blessed',
  'Blitz', 'Brave', 'Bright', 'Bronze', 'Candid', 'Cedar', 'Celeste', 'Chrome',
  'Cinder', 'Cobalt', 'Cosmic', 'Crimson', 'Cryptic', 'Dapper', 'Deep', 'Delta',
  'Diamond', 'Divine', 'Dragon', 'Echo', 'Elder', 'Ember', 'Fable', 'Falcon',
  'Feral', 'Fever', 'Frost', 'Garnet', 'Ghost', 'Glacial', 'Golden', 'Grim',
  'Hallowed', 'Icy', 'Indigo', 'Ivory', 'Jade', 'Jolly', 'Keen', 'Lunar',
  'Mellow', 'Misty', 'Molten', 'Murky', 'Noble', 'Obsidian', 'Onyx', 'Opal',
  'Pearl', 'Prideful', 'Quartz', 'Quick', 'Radiant', 'Raven', 'Rogue', 'Runic',
  'Rustic', 'Sable', 'Sapphire', 'Scarlet', 'Silver', 'Solar', 'Sonic', 'Spicy',
  'Stellar', 'Stormy', 'Swift', 'Terra', 'Thorny', 'Timber', 'Umber', 'Velvet',
  'Verdant', 'Vivid', 'Wandering', 'Wavy', 'Wicked', 'Wild', 'Wintery', 'Witty',
  'Zealous', 'Ample', 'Ancient', 'Bold', 'Crisp', 'Dusky', 'Frosty', 'Gallant',
  'Humble', 'Jubilant', 'Kindled', 'Lush', 'Mighty', 'Pearled', 'Punctual',
];

const POOL_B = [
  'Aurora', 'Breeze', 'Canyon', 'Comet', 'Current', 'Dawn', 'Dune', 'Flare',
  'Fjord', 'Grove', 'Haven', 'Horizon', 'Jetty', 'Lagoon', 'Ledger', 'Lumen',
  'Marsh', 'Mirage', 'Nimbus', 'Nova', 'Oasis', 'Orbit', 'Pebble', 'Pinnacle',
  'Prairie', 'Quarry', 'Quill', 'Reef', 'Ridge', 'Ripple', 'Saber', 'Saga',
  'Savvy', 'Shale', 'Shimmer', 'Solace', 'Spark', 'Sphere', 'Spire', 'Summit',
  'Talon', 'Tempest', 'Thicket', 'Thunder', 'Tide', 'Trail', 'Tundra', 'Vale',
  'Vortex', 'Warden', 'Wharf', 'Whirl', 'Willow', 'Zenith', 'Zephyr', 'Atlas',
  'Beacon', 'Cascade', 'Drift', 'Emberline', 'Fathom', 'Glade', 'Hollow',
  'Ion', 'Juniper', 'Kestrel', 'Lattice', 'Mesa', 'Nectar', 'Oracle', 'Prowess',
  'Quiver', 'Raft', 'Slate', 'Thistle', 'Umbra', 'Vertex', 'Wisp', 'Yonder',
];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

const digits = (n: number): string =>
  Math.floor(Math.random() * 10 ** n)
    .toString()
    .padStart(n, '0');

/** Слово, которое ещё не встречалось в текущей партии (пул исчерпывается не сразу) */
function pickWord(pool: string[], usedWords: Set<string>): string {
  const fresh = pool.filter((w) => !usedWords.has(w));
  const word = pick(fresh.length > 0 ? fresh : pool);
  if (fresh.length > 0) usedWords.add(word);
  return word;
}

function buildNick(usedWords: Set<string>): string {
  const a = pickWord(POOL_A, usedWords);
  const b = pickWord(POOL_B, usedWords);
  const sep = pick(['', '', '_', '']);

  let nick: string;
  switch (Math.floor(Math.random() * 6)) {
    case 0:
      nick = a + b + digits(2 + Math.floor(Math.random() * 3));
      break; // EmberAurora123
    case 1:
      nick = a + sep + b;
      break; // Frost_Ripple / FrostRipple
    case 2:
      nick = a + digits(3 + Math.floor(Math.random() * 4));
      break; // Cobalt8401
    case 3:
      nick = (a + b).toLowerCase() + digits(2);
      break; // cometvale42
    case 4:
      nick = b + a;
      break; // ValeMolten
    default:
      nick = b + a + digits(2);
      break; // SableQuarry77
  }

  nick = nick.replace(/[^A-Za-z0-9_]/g, '');
  if (nick.length > 16) nick = nick.slice(0, 16);
  if (nick.length < 3) nick = (a + digits(4)).slice(0, 16);
  return nick;
}

/**
 * Сгенерировать `count` уникальных случайных ников.
 * @param taken — уже занятые ники (из БД + текущая партия); новые им не совпадут
 */
export function generateNicknames(count: number, taken: Iterable<string> = []): string[] {
  const used = new Set<string>(taken);
  const usedWords = new Set<string>();
  const out: string[] = [];

  for (let i = 0; i < count; i++) {
    let nick = '';
    for (let attempt = 0; attempt < 300; attempt++) {
      nick = buildNick(usedWords);
      if (!used.has(nick)) break;
    }
    let guard = 0;
    while (used.has(nick) && guard++ < 1000) {
      nick = buildNick(new Set()); // пул слов исчерпан — просто добиваем случайством
    }
    if (used.has(nick)) nick = `Zx${Date.now().toString(36)}${digits(3)}`.slice(0, 16);
    used.add(nick);
    out.push(nick);
  }

  return out;
}
