#!/usr/bin/env node
/**
 * 亲密度计算原型（临时验证用）
 * 基于 events 表的同房统计：近期(30天) + 历史 两个窗口
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'vrc-monitor.sqlite3'), { readonly: true, timeout: 10000 });

const SELF = 'usr_cd3ddb35-3d1f-46b2-9863-e13307a95596';
const NOW = Date.now();
const DAY = 86400000;

// 目标好友
const targets = {
  'usr_0ba091c8-9650-43ad-9ff6-c56cd534ab83': 'TDN塩っ子',
  'usr_9b60da63-b5ef-42a7-9312-ac1b82dcec5a': 'D_mikan',
};

// 复用 findCompanions 逻辑（内联简化版）：统计同房次数
function countCompanion(userId, startMs, endMs) {
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const userEvents = db.prepare(
    `SELECT * FROM events WHERE user_id = ? AND type IN ('user-location','friend-location')
     AND created_at >= ? AND created_at <= ? ORDER BY created_at ASC`
  ).all(SELF, startIso, endIso);

  // 用户去过的实例
  const userInstances = new Set();
  const userTimeline = [];
  for (const ev of userEvents) {
    let location = '';
    try { location = JSON.parse(ev.content_json).location || ''; } catch {}
    if (location && location !== 'offline' && location !== 'traveling') {
      const parts = location.split(':');
      const worldId = parts[0], instanceId = parts.slice(1).join(':');
      if (worldId && instanceId) {
        userInstances.add(instanceId);
        userInstances.add(`${worldId}:${instanceId}`);
        userTimeline.push({ id: ev.id, created_at: ev.created_at, type: ev.type, world_id: worldId, instance_id: instanceId, content_json: ev.content_json });
      }
    }
  }

  // 好友事件里与用户同实例的
  const matchDays = new Set();
  let matchCount = 0;
  const worlds = new Set();
  const friendEvents = userTimeline.filter(ev => ev.type === 'friend-location');
  // 对每个用户实例，找同时间在相同实例的好友
  for (const inst of userInstances) {
    const [worldId, instanceId] = inst.includes(':') ? [inst.split(':')[0], inst.slice(inst.indexOf(':') + 1)] : [null, inst];
    if (!worldId) continue;
    // 查该实例内目标好友的事件（friend-location 且 location 含该 world+instance）
    const rows = db.prepare(
      `SELECT user_id, created_at, world_name FROM events
       WHERE type='friend-location' AND user_id = ?
         AND content_json LIKE ? AND content_json LIKE ?
         AND created_at >= ? AND created_at <= ?`
    ).all(userId, `%${worldId}%`, `%${instanceId}%`, startIso, endIso);
    for (const r of rows) {
      matchCount++;
      matchDays.add(r.created_at.slice(0, 10));
      if (r.world_name) worlds.add(r.world_name);
    }
  }
  return { matchCount, days: matchDays.size, worlds };
}

console.log('=== 亲密度统计 ===');
console.log(`当前时间: ${new Date(NOW).toISOString().slice(0,10)}`);
for (const [uid, name] of Object.entries(targets)) {
  const recent = countCompanion(uid, NOW - 30 * DAY, NOW);
  const hist = countCompanion(uid, NOW - 365 * DAY, NOW);
  console.log(`\n${name}:`);
  console.log(`  最近30天: 同房${recent.matchCount}次, ${recent.days}天, 世界: ${[...recent.worlds].slice(0,3).join(',')}`);
  console.log(`  历史一年: 同房${hist.matchCount}次, ${hist.days}天`);
}
db.close();
