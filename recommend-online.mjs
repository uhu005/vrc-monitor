#!/usr/bin/env node
/**
 * 在线好友加入推荐（v2）
 *
 * 推荐算法（综合关系深浅 + 房间场景 + 实例可加入性）：
 * 1. 数据源：全部在线好友（get_online_friends），private 实例自动排除
 * 2. 关系深浅：
 *    - 收藏夹分组映射（从 get_favorite_friends_locations 拿分组内成员）
 *    - join 分组 = 常一起玩（最亲，+20）
 *    - new 分组 = 新加好友（+5）
 *    - 活动店员分组 = 活动联系人，不算好友（-40，标注 contact=true）
 *    - 不在任何收藏夹 = 普通好友（0）
 * 3. 房间场景（用 sleep_ok 标记识别睡觉图）：
 *    - 睡觉图 + 人少(<5) = 电灯泡/在睡觉（-60，标注 risk=sleeping）
 *    - 睡觉图 + 人多(>=5) = 睡觉聚会（-20，可考虑但提示）
 *    - 普通图 + 人少(<3) = 可能私聊中（-15）
 *    - 普通图 + 人多 = 热闹（+加分按人数）
 * 4. 实例类型：public(+20) > friends(+10) = hidden friend+(+10) > group(+5)
 * 5. 实例人数/容量比：30%-80% 黄金区(+50)，>90% 减(-40)，<10% 减(-10)
 * 6. 状态：active(+10)
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

// ── 1. 收藏夹分组 -> 成员映射（关系深浅信号）──
const groupMap = new Map(); // groupName -> { ids: Set, weight, contact }
const groupDefs = [
  { name: 'join', weight: 20, contact: false, desc: '常一起玩' },
  { name: 'new', weight: 5, contact: false, desc: '新加好友' },
  { name: '活动店员', weight: -40, contact: true, desc: '活动联系人(非好友)' },
];
const ov = await mcp('get_favorite_friends_locations', {}, 'rec-v2-ov');
for (const g of ov.groups || []) {
  const def = groupDefs.find(d => d.name === g.groupName);
  if (!def) continue;
  const r = await mcp('get_favorite_friends_locations', { groupName: g.groupName }, 'rec-v2-g');
  const ids = new Set();
  for (const f of (r.friends || [])) ids.add(f.userId);
  for (const f of (r.offline || [])) ids.add(f.userId);
  groupMap.set(g.groupName, { ids, weight: def.weight, contact: def.contact, desc: def.desc });
}

// ── 2. 睡觉图名单 ──
const Database = (await import('better-sqlite3')).default;
const db = new Database(path.join(__dirname, 'vrc-monitor.sqlite3'), { readonly: true, timeout: 10000 });
const sleepWorlds = new Set(db.prepare('SELECT world_id FROM new_worlds WHERE sleep_ok=1').all().map(r => r.world_id));
db.close();

// ── 3. 在线好友 ──
const online = await mcp('get_online_friends', {}, 'rec-v2-online');
if (online.__error__) { console.log(JSON.stringify({ error: online.__error__ })); process.exit(1); }

const results = [];
for (const f of online.friends || []) {
  const loc = f.locationParsed || {};
  const type = loc.type || 'unknown';
  if (type === 'private' || f.location === 'private') continue;
  if (type === 'traveling' || type === 'offline') continue;

  // 关系分组
  let groupName = null, groupWeight = 0, isContact = false;
  for (const [gn, info] of groupMap) {
    if (info.ids.has(f.userId)) {
      if (info.weight > groupWeight || (info.contact && !isContact)) {
        // 取权重最高（非 contact 优先）；contact 分组即使权重负也标注
        groupName = gn; groupWeight = info.weight; isContact = info.contact;
      }
    }
  }
  // contact 覆盖：活动店员的人即使也在其他组，按联系人处理
  const contactGroup = [...groupMap.entries()].find(([gn, info]) => info.contact && info.ids.has(f.userId));
  if (contactGroup) {
    groupName = contactGroup[0]; groupWeight = contactGroup[1].weight; isContact = true;
  }

  const entry = {
    userId: f.userId,
    displayName: f.displayName,
    location: f.location,
    worldId: loc.worldId,
    instanceType: type,
    instanceTypeDisplay: type === 'hidden' ? 'friend+' : type,
    status: f.status,
    region: loc.region || '',
    relation: {
      group: groupName,
      isContact,
      note: isContact ? '活动联系人(非好友)' : (groupName ? `收藏夹[${groupName}]` : '普通好友'),
    },
  };

  // 世界名
  try {
    const cached = await mcp('get_world_name', { worldId: loc.worldId });
    entry.worldName = cached.name || loc.worldId;
  } catch { entry.worldName = loc.worldId || '?'; }

  // 是否睡觉图
  const isSleepWorld = loc.worldId && sleepWorlds.has(loc.worldId);
  entry.isSleepWorld = !!isSleepWorld;

  // 实例人数（可加入的才查）
  const joinable = ['public', 'friends', 'hidden', 'group'].includes(type);
  entry.joinable = joinable;
  if (joinable && f.location && !f.location.includes('~private')) {
    try {
      const r = await fetch(`${BASE}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'rec-v2-oi' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_favorite_friends_locations', arguments: { searchName: f.displayName } } }),
      });
      const raw = await r.text();
      const line = raw.split('\n').find(l => l.startsWith('data: '));
      if (line) {
        const d = JSON.parse(line.slice(6));
        const data = JSON.parse(d.result.content[0].text);
        const ff = (data.friends || [])[0];
        if (ff) {
          entry.instanceUsers = ff.instanceUsers;
          entry.instanceCapacity = ff.instanceCapacity;
          entry.fillRatio = ff.fillRatio;
        }
      }
    } catch { /* ignore */ }
  }

  // ── 推荐度综合评分 ──
  let score = 0;
  const reasons = [];

  // 关系深浅
  if (isContact) { score -= 40; reasons.push('活动联系人-40'); }
  else if (groupName) { score += groupWeight; reasons.push(`[${groupName}]+${groupWeight}`); }

  // 房间场景（电灯泡/睡觉风险）
  const users = entry.instanceUsers;
  if (isSleepWorld && users !== undefined) {
    if (users < 5) { score -= 60; reasons.push(`💤睡觉图仅${users}人-60`); }
    else { score -= 20; reasons.push(`💤睡觉聚会${users}人-20`); }
  } else if (!isSleepWorld && users !== undefined && users < 3 && users > 0) {
    score -= 15; reasons.push(`人少${users}人可能私聊-15`);
  }

  // 实例人数/容量比
  if (users !== undefined) {
    const fill = entry.fillRatio || 0;
    if (fill >= 0.3 && fill <= 0.8) { score += 50; reasons.push(`黄金区${Math.round(fill*100)}%+50`); }
    else if (fill > 0.9) { score -= 40; reasons.push(`爆满${Math.round(fill*100)}%-40`); }
    else if (fill < 0.1) { score -= 10; reasons.push(`冷清${Math.round(fill*100)}%-10`); }
    score += users * 3; reasons.push(`人数${users}*3`);
  }

  // 实例类型
  if (type === 'public') { score += 20; reasons.push('public+20'); }
  else if (type === 'friends') { score += 10; reasons.push('friends+10'); }
  else if (type === 'hidden') { score += 10; reasons.push('friend++10'); }
  else if (type === 'group') { score += 5; reasons.push('group+5'); }

  // 状态
  if (f.status === 'active') { score += 10; reasons.push('active+10'); }

  entry.recommendScore = Math.round(score);
  entry.reasons = reasons;
  results.push(entry);
}

results.sort((a, b) => (b.recommendScore || 0) - (a.recommendScore || 0));
console.log(JSON.stringify({ total: results.length, friends: results }, null, 1));
