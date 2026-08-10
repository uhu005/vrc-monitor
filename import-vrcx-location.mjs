#!/usr/bin/env node
/**
 * VRCX 历史位置导入 (import-vrcx-location.mjs)
 *
 * 把 VRCX 本地库 gamelog_location（自己的历史位置记录，覆盖 2025-06 至今）
 * 导入 vrc-monitor events 表，作为 user-location 事件，补全「共玩统计」所需的历史位置数据。
 *
 * 用法: node import-vrcx-location.mjs [--dry]
 *
 * 幂等：按 (type, user_id, created_at, content_json) 判重，重复运行不产生重复事件。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

const MON_DB = process.env.VRC_MONITOR_DB || path.join(__dirname, 'vrc-monitor.sqlite3');
const VRCX_DB = process.env.VRCX_DB || path.join(process.env.APPDATA || '', 'VRCX', 'VRCX.sqlite3');

if (!existsSync(VRCX_DB)) {
  console.error(`❌ VRCX 库不存在: ${VRCX_DB}`);
  process.exit(1);
}

const db = new Database(MON_DB, { timeout: 10000 });
const vrcx = new Database(VRCX_DB, { readonly: true, timeout: 10000 });

// 当前用户
let SELF_ID = '';
try {
  const h = await fetch('http://127.0.0.1:8799/health').then(r => r.json());
  SELF_ID = h.auth?.user?.id || '';
} catch { /* ignore */ }
if (!SELF_ID) {
  const row = db.prepare("SELECT DISTINCT user_id FROM events WHERE type='user-location' LIMIT 1").get();
  SELF_ID = row?.user_id || '';
}
if (!SELF_ID) {
  // 从 gamelog 的 location 里提取（hidden(usr_xxx) 格式）
  const s = vrcx.prepare("SELECT location FROM gamelog_location WHERE location LIKE '%~hidden(usr_%' LIMIT 1").get();
  const m = s?.location?.match(/~hidden\((usr_[a-f0-9-]+)\)/);
  SELF_ID = m?.[1] || '';
}
console.error(`[self] ${SELF_ID || '(未知，将用导入数据的默认值)'}`);

// 已存在的 user-location 键（去重）
const existing = new Set(
  db.prepare("SELECT user_id || '|' || created_at || '|' || content_json FROM events WHERE type='user-location'").all()
    .map(r => Object.values(r)[0])
);

// 读取 VRCX 历史位置
const rows = vrcx.prepare(
  "SELECT created_at, location, world_id, world_name FROM gamelog_location WHERE location LIKE 'wrld_%' ORDER BY created_at ASC"
).all();
console.error(`[read] VRCX 真实位置 ${rows.length} 条`);

let imported = 0, skipped = 0, bad = 0;
const insert = db.prepare(
  `INSERT OR IGNORE INTO events (type, user_id, display_name, content_json, world_id, world_name, created_at, source)
   VALUES ('user-location', @uid, '', @content, @worldId, @worldName, @createdAt, 'vrcx_import')`
);

const tx = db.transaction(() => {
  for (const r of rows) {
    const content = JSON.stringify({ location: r.location, platform: 'vrcx_import' });
    const key = `${SELF_ID}|${r.created_at}|${content}`;
    if (existing.has(key)) { skipped++; continue; }
    // 也跳过同时间同位置的（避免 time=0 重复）
    if (!DRY) {
      const res = insert.run({
        uid: SELF_ID || 'unknown',
        content,
        worldId: r.world_id || '',
        worldName: r.world_name || '',
        createdAt: r.created_at,
      });
      if (res.changes > 0) imported++;
      else skipped++;
    } else {
      imported++;
    }
  }
});
tx();

console.error(DRY ? `[dry-run] 将导入 ${imported} 条（跳过 ${skipped}）` : `[done] 导入 ${imported} 条（跳过 ${skipped} 重复）`);

// 统计
const stats = db.prepare("SELECT COUNT(*) c, MIN(created_at) mn, MAX(created_at) mx FROM events WHERE type='user-location'").get();
console.log(JSON.stringify({
  imported, skipped,
  userLocationTotal: stats.c,
  userLocationRange: `${stats.mn?.slice(0, 10)} ~ ${stats.mx?.slice(0, 10)}`,
}));
db.close();
vrcx.close();
