#!/usr/bin/env node
/**
 * 在线好友加入推荐（v2）
 *
 * 推荐算法（综合关系深浅 + 房间场景 + 实例可加入性）：
 * 1. 数据源：全部在线好友（get_online_friends），private 实例自动排除
 * 2. 关系深浅（可配置，见下方环境变量）：
 *    - 默认：所有收藏夹分组统一 +5 弱加分（不区分亲密度，通用行为）
 *    - 可用 VRC_MONITOR_GROUP_WEIGHTS 自定义各分组权重：
 *        VRC_MONITOR_GROUP_WEIGHTS='{"join":20,"new":5,"活动店员":-40}'
 *    - 可用 VRC_MONITOR_CONTACT_GROUPS 指定「联系人分组」（不算好友，降权+标注）：
 *        VRC_MONITOR_CONTACT_GROUPS='活动店员'
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

// ── 1. 收藏夹分组 -> 成员映射（关系深浅信号，可配置）──
const groupMap = new Map(); // groupName -> { ids: Set, weight, contact }
// 环境变量配置（个人化权重/联系人分组，不硬编码到仓库）
//   VRC_MONITOR_GROUP_WEIGHTS: JSON，分组名->权重，如 {"join":20,"new":5,"活动店员":-40}
//   VRC_MONITOR_CONTACT_GROUPS: 逗号分隔的联系人分组名，如 "活动店员"
let groupWeights = {};
let contactGroups = new Set();
try {
  if (process.env.VRC_MONITOR_GROUP_WEIGHTS) {
    groupWeights = JSON.parse(process.env.VRC_MONITOR_GROUP_WEIGHTS);
  }
} catch (e) { console.error('[warn] VRC_MONITOR_GROUP_WEIGHTS 解析失败:', e.message); }
if (process.env.VRC_MONITOR_CONTACT_GROUPS) {
  contactGroups = new Set(process.env.VRC_MONITOR_CONTACT_GROUPS.split(',').map(s => s.trim()).filter(Boolean));
}

const ov = await mcp('get_favorite_friends_locations', {}, 'rec-v2-ov');
for (const g of ov.groups || []) {
  const r = await mcp('get_favorite_friends_locations', { groupName: g.groupName }, 'rec-v2-g');
  const ids = new Set();
  for (const f of (r.friends || [])) ids.add(f.userId);
  for (const f of (r.offline || [])) ids.add(f.userId);
  // 权重：配置了用配置值；否则默认 +5（弱加分，通用行为）；contact 分组默认 -40
  const isContact = contactGroups.has(g.groupName);
  const weight = groupWeights[g.groupName] !== undefined
    ? groupWeights[g.groupName]
    : (isContact ? -40 : 5);
  groupMap.set(g.groupName, { ids, weight, contact: isContact, desc: g.groupName });
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
