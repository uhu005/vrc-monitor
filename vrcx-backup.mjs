#!/usr/bin/env node
/**
 * VRCX 本地收藏备份 (vrcx-backup.mjs) — 可选增强，不依赖主流程
 *
 * 功能：把 vrc-monitor 的 new_worlds 表（新地图追踪结果）备份一套到
 *       VRCX 本地收藏，便于在 VRCX 界面中自主检阅。
 *       「有 VRCX 就备份，没有就跳过」——不会因 VRCX 缺失而报错。
 *
 * 同步规则：
 *   - new_worlds 表中 visited=0（未逛）  -> VRCX「新地图」分组
 *   - new_worlds 表中 visited=1（已逛）  -> VRCX「新地图 已玩」分组
 *   - 幂等：已在对应分组的 world 跳过，不重复插入
 *
 * 用法：
 *   node vrcx-backup.mjs                # 默认（VRCX 库在 %APPDATA%\VRCX\）
 *   VRCX_DB=xxx node vrcx-backup.mjs   # 自定义 VRCX 库路径
 *
 * 输出 JSON：{ vrcxFound, group, synced, skipped, visitedGroup, visitedSynced }
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_DB = process.env.VRC_MONITOR_DB || path.join(__dirname, 'vrc-monitor.sqlite3');
const GROUP = '新地图';
const VISITED_GROUP = '新地图 已玩';

// VRCX 数据库路径：环境变量优先，默认 %APPDATA%\VRCX\VRCX.sqlite3
const VRCX_DB = process.env.VRCX_DB || path.join(process.env.APPDATA || os.homedir(), 'VRCX', 'VRCX.sqlite3');

// ── 1. 检测 VRCX 是否存在 ──
if (!existsSync(VRCX_DB)) {
  console.log(JSON.stringify({ vrcxFound: false, reason: 'VRCX 数据库不存在，跳过备份', path: VRCX_DB }));
  process.exit(0);
}

// ── 2. 读 vrc-monitor 的 new_worlds ──
if (!existsSync(MONITOR_DB)) {
  console.log(JSON.stringify({ vrcxFound: true, error: `监控库不存在: ${MONITOR_DB}` }));
  process.exit(1);
}
const monitor = new Database(MONITOR_DB, { readonly: true, timeout: 10000 });
let worlds;
try {
  worlds = monitor.prepare(
    'SELECT world_id, world_name, visited FROM new_worlds'
  ).all();
} catch (e) {
  console.log(JSON.stringify({ vrcxFound: true, error: `读取 new_worlds 失败: ${e.message}` }));
  monitor.close();
  process.exit(1);
}
monitor.close();

const unvisited = worlds.filter(w => !w.visited);
const visited = worlds.filter(w => w.visited);
console.error(`[monitor] new_worlds: ${worlds.length} 个（未逛 ${unvisited.length} / 已逛 ${visited.length}）`);

// ── 3. 同步到 VRCX（幂等：跳过已在对应分组的）──
const vrcx = new Database(VRCX_DB, { timeout: 15000 });
vrcx.pragma('busy_timeout = 15000');

// 查已有收藏（world_id + group 组合去重）
const existingRows = vrcx.prepare(
  'SELECT world_id, group_name FROM favorite_world WHERE group_name IN (?, ?)'
).all(GROUP, VISITED_GROUP);
const existing = new Set(existingRows.map(r => `${r.world_id}|${r.group_name}`));

const now = new Date().toISOString();
const insert = vrcx.prepare(
  'INSERT INTO favorite_world (created_at, world_id, group_name) VALUES (?, ?, ?)'
);

let synced = 0;
let visitedSynced = 0;

const tx = vrcx.transaction(items => {
  for (const w of items) {
    const key = `${w.world_id}|${w.visited ? VISITED_GROUP : GROUP}`;
    if (existing.has(key)) continue;
    insert.run(now, w.world_id, w.visited ? VISITED_GROUP : GROUP);
    if (w.visited) visitedSynced++; else synced++;
  }
});

try {
  tx(worlds);
  console.error(`[vrcx] 同步完成：未逛 +${synced}，已逛 +${visitedSynced}（已存在跳过）`);
} catch (e) {
  console.error(`[vrcx] 写入失败: ${e.message}`);
  console.log(JSON.stringify({ vrcxFound: true, error: e.message, synced, visitedSynced }));
  vrcx.close();
  process.exit(1);
}
vrcx.close();

// ── 4. 输出报告 ──
console.log(JSON.stringify({
  vrcxFound: true,
  db: VRCX_DB,
  group: GROUP,
  visitedGroup: VISITED_GROUP,
  total: worlds.length,
  synced,             // 本次新同步的未逛数
  skipped: unvisited.length - synced,
  visitedSynced,      // 本次新同步的已逛数
  visitedTotal: visited.length,
}, null, 2));
