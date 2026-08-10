#!/usr/bin/env node
/**
 * 分析：在线好友的收藏夹分组归属（关系深浅信号）+ 所在图是否睡觉图
 */
const BASE = 'http://127.0.0.1:8799/mcp';

async function mcp(name, args, sid) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'mcp-session-id': sid },
    body,
  });
  const raw = await res.text();
  const line = raw.split('\n').find(l => l.startsWith('data: '));
  if (!line) return { __error__: raw.slice(0, 120) };
  const d = JSON.parse(line.slice(6));
  if (d.error) return { __error__: d.error.message || '' };
  return JSON.parse(d.result.content[0].text);
}

// 1. 在线好友
const online = await mcp('get_online_friends', {}, 'ana-1');
const onlineMap = new Map((online.friends || []).map(f => [f.userId, f]));

// 2. 收藏夹分组 -> 成员 userId 映射
const groupMap = new Map(); // groupName -> Set(userId)
const ov = await mcp('get_favorite_friends_locations', {}, 'ana-2');
for (const g of ov.groups || []) {
  const r = await mcp('get_favorite_friends_locations', { groupName: g.groupName }, 'ana-g');
  if (r.__error__) continue;
  const ids = new Set();
  for (const f of r.friends || []) ids.add(f.userId);
  for (const f of r.offline || []) ids.add(f.userId);
  groupMap.set(g.groupName, ids);
  console.log(`[${g.groupName}] ${g.memberCount}人 (${ids.size}个有ID)`);
}

// 3. 睡觉图名单
const Database = (await import('better-sqlite3')).default;
const db = new Database('vrc-monitor.sqlite3', { readonly: true, timeout: 10000 });
const sleepWorlds = new Set(db.prepare('SELECT world_id FROM new_worlds WHERE sleep_ok=1').all().map(r => r.world_id));

// 4. 汇总：在线好友 -> 分组 + 世界是否睡觉图
console.log('\n=== 在线好友关系 + 房间场景 ===');
for (const [uid, f] of onlineMap) {
  const groups = [];
  for (const [gn, ids] of groupMap) if (ids.has(uid)) groups.push(gn);
  const loc = f.locationParsed || {};
  const isSleep = loc.worldId && sleepWorlds.has(loc.worldId);
  console.log(`  ${f.displayName.padEnd(20)} | 分组:${groups.join('/') || '无'.padEnd(6)} | ${(loc.type||'?').padEnd(8)} | ${isSleep ? '💤睡觉图' : '普通图'} | ${f.location.slice(0, 30)}`);
}
db.close();
