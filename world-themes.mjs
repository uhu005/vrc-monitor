#!/usr/bin/env node
/**
 * VRChat 新地图主题分类器 (world-themes.mjs)
 *
 * 功能：把 new_worlds 表里的世界按主题分类（夏天/海/雪/恐怖/太空/森林/游戏…），
 *       支持按主题筛选未逛的地图，供「开个夏天的地图」这类指令使用。
 *
 * 分类信号（三信号综合，任一命中即归入该主题）：
 *   1. author_tag_* 作者标签
 *   2. 世界名关键词（中/日/英）
 *   3. 世界描述关键词（中/日/英）
 *
 * 用法：
 *   node world-themes.mjs                    # 列出所有主题及每个主题的世界数
 *   node world-themes.mjs 夏天                # 列出「夏天」主题的未逛世界（按热度排序）
 *   node world-themes.mjs 夏天 --all          # 含已逛的
 *   node world-themes.mjs 夏天 --random       # 随机抽一个未逛的（输出 world_id）
 *   node world-themes.mjs 夏天 --random --hot # 随机+热度加权
 *
 * 输出 JSON：{ theme, count, worlds: [{name, id, favorites, occupants, visited}] }
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VRC_MONITOR_DB || path.join(__dirname, 'vrc-monitor.sqlite3');

/**
 * 主题定义：key=主题名，match=匹配规则数组
 * 每条规则：{ type: 'tag'|'name'|'desc', kw: 关键词（小写） }
 * tag 匹配 author_tag_xxx 或原始 tag；name/desc 匹配世界名/描述（不区分大小写）
 */
const THEMES = [
  {
    key: '夏天', emoji: '🏖️',
    rules: [
      { type: 'tag', kw: 'summer' }, { type: 'tag', kw: 'beach' }, { type: 'tag', kw: 'pool' },
      { type: 'name', kw: '夏' }, { type: 'name', kw: 'summer' },
      { type: 'name', kw: 'beach' }, { type: 'name', kw: '海辺' }, { type: 'name', kw: 'プール' },
      { type: 'name', kw: 'waterpark' }, { type: 'name', kw: 'water park' },
      { type: 'desc', kw: 'summer' }, { type: 'desc', kw: 'beach' }, { type: 'desc', kw: '夏' },
      { type: 'desc', kw: '海水浴' },
    ],
  },
  {
    key: '海', emoji: '🌊',
    rules: [
      { type: 'tag', kw: 'underwater' }, { type: 'tag', kw: 'ocean' }, { type: 'tag', kw: 'sea' },
      { type: 'tag', kw: 'aquarium' }, { type: 'tag', kw: 'fish' },
      { type: 'name', kw: '海' }, { type: 'name', kw: 'ocean' }, { type: 'name', kw: 'underwater' },
      { type: 'name', kw: 'aquarium' }, { type: 'name', kw: '水族館' }, { type: 'name', kw: '水中' },
      { type: 'name', kw: 'submarine' }, { type: 'name', kw: '深海' },
      { type: 'desc', kw: '海' }, { type: 'desc', kw: 'underwater' }, { type: 'desc', kw: 'ocean' },
    ],
  },
  {
    key: '雪', emoji: '❄️',
    rules: [
      { type: 'tag', kw: 'snow' }, { type: 'tag', kw: 'winter' },
      { type: 'name', kw: '雪' }, { type: 'name', kw: 'snow' }, { type: 'name', kw: 'winter' },
      { type: 'name', kw: 'スキー' }, { type: 'name', kw: '氷' },
      { type: 'desc', kw: '雪' }, { type: 'desc', kw: 'snow' }, { type: 'desc', kw: 'winter' },
    ],
  },
  {
    key: '恐怖', emoji: '👻',
    rules: [
      { type: 'tag', kw: 'horror' }, { type: 'tag', kw: 'dark' }, { type: 'tag', kw: 'scary' },
      { type: 'tag', kw: 'creepy' }, { type: 'tag', kw: 'ghost' },
      { type: 'name', kw: '恐怖' }, { type: 'name', kw: 'horror' }, { type: 'name', kw: 'scary' },
      { type: 'name', kw: 'creepy' }, { type: 'name', kw: 'ghost' }, { type: 'name', kw: '幽霊' },
      { type: 'name', kw: '心霊' }, { type: 'name', kw: '怖い' }, { type: 'name', kw: 'fnaf' },
      { type: 'desc', kw: '恐怖' }, { type: 'desc', kw: 'horror' }, { type: 'desc', kw: 'scary' },
    ],
  },
  {
    key: '太空', emoji: '🚀',
    rules: [
      { type: 'tag', kw: 'space' }, { type: 'tag', kw: 'sci-fi' }, { type: 'tag', kw: 'scifi' },
      { type: 'tag', kw: 'future' }, { type: 'tag', kw: 'cyber' },
      { type: 'name', kw: '宇宙' }, { type: 'name', kw: 'space' }, { type: 'name', kw: 'moon' },
      { type: 'name', kw: '火星' }, { type: 'name', kw: 'mars' }, { type: 'name', kw: 'star' },
      { type: 'name', kw: 'galaxy' }, { type: 'name', kw: '星' },
      { type: 'desc', kw: 'space' }, { type: 'desc', kw: '宇宙' },
    ],
  },
  {
    key: '森林自然', emoji: '🌲',
    rules: [
      { type: 'tag', kw: 'nature' }, { type: 'tag', kw: 'forest' }, { type: 'tag', kw: 'garden' },
      { type: 'tag', kw: 'mountain' }, { type: 'tag', kw: 'cottage' },
      { type: 'name', kw: '森' }, { type: 'name', kw: 'forest' }, { type: 'name', kw: '山' },
      { type: 'name', kw: 'mountain' }, { type: 'name', kw: '自然' }, { type: 'name', kw: '庭' },
      { type: 'name', kw: 'garden' }, { type: 'name', kw: '花' }, { type: 'name', kw: 'flower' },
      { type: 'desc', kw: 'forest' }, { type: 'desc', kw: 'nature' }, { type: 'desc', kw: '森' },
    ],
  },
  {
    key: '游戏', emoji: '🎮',
    rules: [
      { type: 'tag', kw: 'game' }, { type: 'tag', kw: 'games' }, { type: 'tag', kw: 'fps' },
      { type: 'tag', kw: 'escape' }, { type: 'tag', kw: 'puzzle' }, { type: 'tag', kw: 'fnf' },
      { type: 'name', kw: 'game' }, { type: 'name', kw: 'ゲーム' }, { type: 'name', kw: 'escape' },
      { type: 'name', kw: '謎解き' }, { type: 'name', kw: 'puzzle' }, { type: 'name', kw: 'racing' },
      { type: 'name', kw: 'racing' }, { type: 'name', kw: 'ボウリング' },
      { type: 'desc', kw: 'game' }, { type: 'desc', kw: 'play' },
    ],
    // 游戏图排除恐怖图：命中恐怖关键词的图不进「游戏」主题（恐怖单独立类）
    exclude: [
      { type: 'tag', kw: 'horror' }, { type: 'tag', kw: 'dark' }, { type: 'tag', kw: 'scary' },
      { type: 'tag', kw: 'creepy' }, { type: 'tag', kw: 'ghost' },
      { type: 'name', kw: '恐怖' }, { type: 'name', kw: 'horror' }, { type: 'name', kw: 'scary' },
      { type: 'name', kw: 'creepy' }, { type: 'name', kw: 'ghost' }, { type: 'name', kw: '幽霊' },
      { type: 'name', kw: '心霊' }, { type: 'name', kw: '怖い' }, { type: 'name', kw: 'fnaf' },
      { type: 'desc', kw: '恐怖' }, { type: 'desc', kw: 'horror' }, { type: 'desc', kw: 'scary' },
    ],
  },
  {
    key: '音乐', emoji: '🎵',
    rules: [
      { type: 'tag', kw: 'music' }, { type: 'tag', kw: 'concert' }, { type: 'tag', kw: 'dj' },
      { type: 'tag', kw: 'dance' }, { type: 'tag', kw: 'club' },
      { type: 'name', kw: 'music' }, { type: 'name', kw: '音楽' }, { type: 'name', kw: 'ライブ' },
      { type: 'name', kw: 'concert' }, { type: 'name', kw: 'dj' }, { type: 'name', kw: 'club' },
      { type: 'name', kw: 'karaoke' }, { type: 'name', kw: 'カラオケ' },
      { type: 'desc', kw: 'music' }, { type: 'desc', kw: 'concert' },
    ],
  },
  {
    key: '社交', emoji: '🍻',
    rules: [
      { type: 'tag', kw: 'hangout' }, { type: 'tag', kw: 'social' }, { type: 'tag', kw: 'bar' },
      { type: 'tag', kw: 'cafe' }, { type: 'tag', kw: 'lounge' }, { type: 'tag', kw: 'club' },
      { type: 'name', kw: 'bar' }, { type: 'name', kw: 'カフェ' }, { type: 'name', kw: 'cafe' },
      { type: 'name', kw: 'lounge' }, { type: 'name', kw: '飲み' }, { type: 'name', kw: '居酒屋' },
      { type: 'name', kw: 'hangout' },
      { type: 'desc', kw: 'hangout' }, { type: 'desc', kw: 'bar' }, { type: 'desc', kw: 'social' },
    ],
  },
  {
    key: '放松', emoji: '😌',
    rules: [
      { type: 'tag', kw: 'relax' }, { type: 'tag', kw: 'chill' }, { type: 'tag', kw: 'cozy' },
      { type: 'tag', kw: 'sleep' }, { type: 'tag', kw: 'home' }, { type: 'tag', kw: 'room' },
      { type: 'tag', kw: 'hotel' },
      { type: 'name', kw: 'home' }, { type: 'name', kw: '家' }, { type: 'name', kw: '部屋' },
      { type: 'name', kw: 'room' }, { type: 'name', kw: 'cozy' }, { type: 'name', kw: 'chill' },
      { type: 'name', kw: 'relax' }, { type: 'name', kw: '温泉' }, { type: 'name', kw: 'サウナ' },
      { type: 'name', kw: 'sauna' }, { type: 'name', kw: 'hotel' },
      { type: 'desc', kw: 'relax' }, { type: 'desc', kw: 'chill' }, { type: 'desc', kw: 'cozy' },
    ],
  },
  {
    key: '夜晚星空', emoji: '🌙',
    rules: [
      { type: 'tag', kw: 'night' }, { type: 'tag', kw: 'aurora' }, { type: 'tag', kw: 'moon' },
      { type: 'name', kw: '夜' }, { type: 'name', kw: 'night' }, { type: 'name', kw: '月' },
      { type: 'name', kw: 'moon' }, { type: 'name', kw: '星空' }, { type: 'name', kw: '星' },
      { type: 'name', kw: 'aurora' }, { type: 'name', kw: '極光' },
      { type: 'desc', kw: 'night' }, { type: 'desc', kw: 'aurora' },
    ],
  },
];

// ── 主题匹配 ──
function matchRule(world, rule) {
  const name = (world.world_name || '').toLowerCase();
  const desc = (world.description || '').toLowerCase();
  let tags = [];
  try { tags = JSON.parse(world.tags || '[]'); } catch (e) { tags = []; }
  const tagStr = tags.map(t => t.toLowerCase()).join(' ');
  const kw = rule.kw.toLowerCase();
  if (rule.type === 'tag' && tagStr.includes(kw)) return true;
  if (rule.type === 'name' && name.includes(kw)) return true;
  if (rule.type === 'desc' && desc.includes(kw)) return true;
  return false;
}

function matchTheme(world, theme) {
  const hit = theme.rules.some(rule => matchRule(world, rule));
  if (!hit) return false;
  // 主题排除规则：命中 exclude 的图不算该主题（如游戏图排除恐怖图）
  if (Array.isArray(theme.exclude) && theme.exclude.some(rule => matchRule(world, rule))) {
    return false;
  }
  return true;
}

// ── 主逻辑 ──
const args = process.argv.slice(2);
const queryTheme = args.find(a => !a.startsWith('--'));
const showAll = args.includes('--all');
const randomPick = args.includes('--random');
const hotWeight = args.includes('--hot');

if (!existsSync(DB_PATH)) {
  console.log(JSON.stringify({ error: `数据库不存在: ${DB_PATH}` }));
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true, timeout: 10000 });
const worlds = db.prepare('SELECT * FROM new_worlds').all();
db.close();

// 无参数：列出所有主题统计
if (!queryTheme) {
  const stats = THEMES.map(t => {
    const matched = worlds.filter(w => matchTheme(w, t));
    return { theme: t.key, emoji: t.emoji, total: matched.length, unvisited: matched.filter(w => !w.visited).length };
  }).sort((a, b) => b.unvisited - a.unvisited);
  console.log(JSON.stringify({ themes: stats }, null, 2));
  process.exit(0);
}

// 有主题参数：找匹配主题（支持「开个夏天的地图」「来个海的」这类自然语言）
// 先尝试精确匹配，再尝试从句子中提取主题词
let theme = THEMES.find(t => t.key === queryTheme || t.emoji === queryTheme ||
  t.rules.some(r => r.kw === queryTheme.toLowerCase()));

if (!theme) {
  // 自然语言提取：在句子中查找已知主题词
  const sentence = queryTheme;
  const themeKeys = THEMES.map(t => t.key);
  // 按长度降序匹配（「森林自然」优先于「森林」）
  const foundKey = themeKeys.sort((a, b) => b.length - a.length)
    .find(k => sentence.includes(k));
  if (foundKey) {
    theme = THEMES.find(t => t.key === foundKey);
  } else {
    // 主题关键词（rules 里的 kw）匹配
    const kwMatch = THEMES.find(t => t.rules.some(r =>
      r.type === 'name' && sentence.includes(r.kw) && r.kw.length >= 2));
    if (kwMatch) theme = kwMatch;
  }
}

if (!theme) {
  console.log(JSON.stringify({ error: `未知主题「${queryTheme}」，可用主题: ${THEMES.map(t => t.key).join(' / ')}` }));
  process.exit(1);
}

let matched = worlds.filter(w => matchTheme(w, theme));
if (!showAll) matched = matched.filter(w => !w.visited);

const score = w => (w.favorites || 0) * 2 + (w.occupants || 0) * 10 + (w.popularity || 0);
matched.sort((a, b) => score(b) - score(a));

if (randomPick && matched.length > 0) {
  const pick = hotWeight
    ? matched[Math.floor(Math.random() * Math.min(5, matched.length))]  // 热度 Top5 里随机
    : matched[Math.floor(Math.random() * matched.length)];               // 全量随机
  console.log(JSON.stringify({ theme: theme.key, emoji: theme.emoji, count: matched.length,
    world: { name: pick.world_name, id: pick.world_id, favorites: pick.favorites, occupants: pick.occupants } }, null, 2));
  process.exit(0);
}

console.log(JSON.stringify({
  theme: theme.key, emoji: theme.emoji,
  count: matched.length,
  showAll,
  worlds: matched.map(w => ({
    name: w.world_name, id: w.world_id,
    favorites: w.favorites || 0, occupants: w.occupants || 0,
    visited: !!w.visited,
  })),
}, null, 2));
