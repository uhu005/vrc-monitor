#!/usr/bin/env node
/**
 * 热门图追加脚本 (fetch-hot-worlds.mjs)
 *
 * 功能：把 VRChat 热门世界（sort=popularity + system_approved 审核通过）追加进
 *       new_worlds 表，标记 source='hot'。热门图不属于「新发布」，但质量普遍不错，
 *       扩充探索库存。探索时优先 visited=0 的图。
 *
 * 用法：
 *   node fetch-hot-worlds.mjs 200        # 追加 200 张热门图
 *   node fetch-hot-worlds.mjs 200 --dry  # 预演（不写库）
 *
 * 注意：
 *   - 复用 vrchat-api.js 认证（自动 OTP）
 *   - source='hot' 的世界不会被 tracker 的 purge 清理（purge 只清 source='new'）
 *   - 用 events 表的历史记录初始化 visited（逛过的热门图标 1）
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VRC_MONITOR_DB || path.join(__dirname, 'vrc-monitor.sqlite3');
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');

// 限流器（与主服务同参数）
class RateLimiter {
  constructor({ minInterval = 2600, maxQueueSize = 30 } = {}) {
    this.minInterval = minInterval;
    this.maxQueueSize = maxQueueSize;
    this._queue = [];
    this._processing = false;
  }
  async execute(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (this._queue.length > this.maxQueueSize) {
        const dropped = this._queue.shift();
        dropped.reject(new Error('Rate limiter queue overflow'));
      }
      if (!this._processing) this._processQueue();
    });
  }
  async _processQueue() {
    this._processing = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      const start = Date.now();
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
      const elapsed = Date.now() - start;
      const wait = Math.max(0, this.minInterval - elapsed);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
    this._processing = false;
  }
}

const rateLimiter = new RateLimiter({ minInterval: 2600, maxQueueSize: 30 });

// 参数
const COUNT = parseInt(process.argv[2] || '200', 10);
const DRY = process.argv.includes('--dry');

const { VrchatApiClient } = await import('./vrchat-api.js');
const creds = JSON.parse(readFileSync(path.join(__dirname, 'credentials.json'), 'utf-8'));
const api = new VrchatApiClient(creds.email, creds.password);
if (existsSync(COOKIE_FILE)) api.loadCookieFromFile(COOKIE_FILE);

// OTP 回调
async function fetchOtp() {
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  return execSync(`python "${path.join(__dirname, 'fetch-otp.py')}" "${creds.email}" "${authCode}"`, {
    timeout: 15000, encoding: 'utf-8',
  }).trim();
}

// 认证
let selfUserId = '';
try {
  const user = await rateLimiter.execute(() => api.ensureAuthWithAutoOtp(fetchOtp));
  api.saveCookieToFile(COOKIE_FILE);
  selfUserId = user.id || '';
  console.error(`[auth] ${user.displayName} (${selfUserId})`);
} catch (e) {
  console.error('[auth] 失败:', e.message);
  process.exit(1);
}

// ── 1. 拉热门图（sort=popularity + system_approved）──
console.error(`[fetch] 拉热门图（sort=popularity, system_approved, 目标 ${COUNT} 张）...`);
const candidates = [];
for (let offset = 0; offset < COUNT + 100; offset += 100) {
  const r = await rateLimiter.execute(() =>
    api._request('GET', `/worlds?sort=popularity&order=descending&tag=system_approved&n=100&offset=${offset}`));
  if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
  candidates.push(...r.data);
  if (r.data.length < 100) break;
  if (candidates.length >= COUNT) break;
}
console.error(`[fetch] 拉到 ${candidates.length} 个候选`);

// ── 2. 过滤：只要公开 + 非垃圾 + 有热度 ──
// 复用 world-themes 的 isJunkWorld？那是 CLI 内部函数，这里内联简单版
function isJunkWorld(w) {
  const name = (w.name || '').toLowerCase().trim();
  const junkPatterns = [
    /test/i, /测试/i, /習作/i, /习作/i, /sample/i, /示例/i,
    /placeholder/i, /wip/i, /untitled/i, /tmp/i, /temp/i,
    /^new world$/i, /^新建世界$/i, /frist create/i, /first create/i,
    /^0+[0-9]{0,3}$/, /^room\d*$/i, /^a room$/i, /^\[?beta\]?$/i,
    /unity input/i, /tutorial/i, /sdk test/i, /do not use/i,
  ];
  const desc = (w.description || '').toLowerCase();
  const junkDesc = [/un.?finish/i, /not finish/i, /incomplete/i, /wip/i,
    /no colision/i, /no collision/i, /joke/i, /funny.?er/i, /don'?t (use|take)/i,
    /broken/i, /glitch/i, /test upload/i, /experiment/i, /troll/i];
  const hasAuthor = w.authorName && w.authorName !== 'Unknown' && w.authorName !== 'unknown';
  return junkPatterns.some(re => re.test(name)) || junkDesc.some(re => re.test(desc)) ||
    !hasAuthor || (typeof w.capacity === 'number' && w.capacity < 4);
}

const good = candidates
  .filter(w => w.releaseStatus === 'public')
  .filter(w => !isJunkWorld(w))
  .slice(0, COUNT);
console.error(`[filter] 过滤后 ${good.length} 张（排除垃圾/未公开）`);

// ── 3. 查库：已有记录 + visited 初始化 ──
const db = new Database(DB_PATH, { timeout: 8000 });
const existing = new Set(db.prepare('SELECT world_id FROM new_worlds').all().map(r => r.world_id));
// visited 初始化：用 events 表看逛过哪些 world
let visitedSet = new Set();
if (selfUserId) {
  const rows = db.prepare(
    `SELECT DISTINCT world_id FROM events
     WHERE world_id IS NOT NULL AND world_id != ''
       AND (type = 'user-location' OR (type = 'friend-location' AND user_id = ?))`
  ).all(selfUserId);
  visitedSet = new Set(rows.map(r => r.world_id));
}

// ── 4. 写入 ──
let written = 0, skipped = 0, visitedMarked = 0;
const now = new Date().toISOString();
if (!DRY) {
  const upsert = db.prepare(
    `INSERT INTO new_worlds (world_id, world_name, author_name, created_at, first_seen_at, favorites, occupants, popularity, visited, visited_at, tags, description, source)
     VALUES (@world_id, @world_name, @author_name, @created_at, @first_seen_at, @favorites, @occupants, @popularity, @visited, @visited_at, @tags, @description, 'hot')
     ON CONFLICT(world_id) DO UPDATE SET
       world_name = excluded.world_name,
       favorites = excluded.favorites,
       occupants = excluded.occupants,
       popularity = excluded.popularity,
       tags = excluded.tags,
       description = excluded.description`
  );
  const tx = db.transaction(() => {
    for (const w of good) {
      if (existing.has(w.id)) { skipped++; continue; }
      const wasVisited = visitedSet.has(w.id);
      upsert.run({
        world_id: w.id,
        world_name: w.name || '',
        author_name: w.authorName || '',
        created_at: w.created_at || null,
        first_seen_at: now,
        favorites: w.favorites || 0,
        occupants: w.occupants || 0,
        popularity: w.popularity || 0,
        visited: wasVisited ? 1 : 0,
        visited_at: wasVisited ? now : null,
        tags: Array.isArray(w.tags) ? JSON.stringify(w.tags) : '',
        description: w.description || '',
      });
      if (wasVisited) visitedMarked++;
      written++;
    }
  });
  tx();
}
db.close();

console.error(`[write] 新增 ${written} 张热门图（跳过已存在 ${skipped}，含已逛标记 ${visitedMarked}）`);
console.error(DRY ? '[dry-run] 未实际写入' : '[done] 完成');

// 输出统计 JSON
const db2 = new Database(DB_PATH, { readonly: true, timeout: 8000 });
const stats = {
  total: db2.prepare('SELECT COUNT(*) as c FROM new_worlds').get().c,
  hot: db2.prepare("SELECT COUNT(*) as c FROM new_worlds WHERE source='hot'").get().c,
  new: db2.prepare("SELECT COUNT(*) as c FROM new_worlds WHERE source='new'").get().c,
  unvisited: db2.prepare('SELECT COUNT(*) as c FROM new_worlds WHERE visited=0').get().c,
};
db2.close();
console.log(JSON.stringify(stats));
