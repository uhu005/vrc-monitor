/**
 * VRChat 好友监控系统 — 主入口
 * 
 * 独立 MCP 服务（不依赖 VRCX-0）
 * Phase 1: 基础设施 — 数据库 + 基础 MCP 工具
 * 
 * 启动: node start-monitor.js
 */
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Storage } from './core/storage.js';
import { RateLimiter } from './core/rate-limiter.js';
import { VrchatApiClient } from './vrchat-api.js';
import { WsManager } from './core/ws-manager.js';
import { EventPipeline } from './core/event-pipeline.js';
import { FriendStateManager } from './core/friend-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');
const CRED_FILE = path.join(__dirname, 'credentials.json');
const DB_PATH = path.join(__dirname, 'vrc-monitor.sqlite3');

// ── 全局状态 ──
let storage;
let api;
let rateLimiter;
let wsManager;
let eventPipeline;
let friendState;
let serverState = { started: null, authUser: null, friendCount: 0, needsOtp: false };

// ── Watchlist 内存缓存（避免每次 WS 事件查 DB）──
let _watchlistCache = [];       // 内存中的 watchlist 快照
let _watchlistDirty = false;    // 标记是否需要刷新

function _refreshWatchlistCache() {
  _watchlistCache = storage.getWatchlist();
  _watchlistDirty = false;
}

function _invalidateWatchlistCache() {
  _watchlistDirty = true;
}

// ── WebSocket 事件 → 好友状态更新 ──
async function _updateFriendState(event) {
  switch (event.type) {
    case 'friend-online':
      friendState.setOnline(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-offline':
      friendState.setOffline(event.userId);
      break;
    case 'friend-location':
      friendState.updateLocation(event.userId, {
        displayName: event.displayName,
        location: event.location,
        worldId: event.worldId,
      });
      break;
    case 'friend-active':
      friendState.setOnline(event.userId);
      break;
  }
}

// ── WebSocket 重连后刷新全量在线状态 ──
async function _refreshOnlineState() {
  try {
    const r = await api._request('GET', '/auth/user/friends?offline=false');
    if (r.status === 200 && Array.isArray(r.data)) {
      const online = r.data.filter(f => f.location && f.location !== 'offline');
      friendState.batchSetOnline(online.map(f => ({
        userId: f.id,
        displayName: f.displayName,
        location: f.location,
        worldId: f.worldId,
        isOnline: true,
      })));
      log(`🔄 刷新在线状态: ${friendState.getOnlineCount()} 人在线`);
    }
  } catch (err) {
    log(`⚠️ 刷新在线状态失败: ${err.message}`);
  }
}

// ── MCP 会话管理 ──
const sessions = new Map();

class McpSession {
  constructor() {
    this.id = randomUUID();
    this.initialized = false;
  }
}

function getOrCreateSession(sessionId) {
  if (!sessionId || !sessions.has(sessionId)) {
    const s = new McpSession();
    sessions.set(s.id, s);
    return s;
  }
  return sessions.get(sessionId);
}

// ── SSE 响应辅助 ──
function sendSSE(res, events, sessionId) {
  if (res.headersSent) return;
  let body = '';
  for (const event of events) {
    body += `data: ${JSON.stringify(event)}\n\n`;
  }
  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': Buffer.byteLength(body),
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  res.writeHead(200, headers);
  res.end(body);
}

function sendError(res, id, message) {
  sendSSE(res, [{
    jsonrpc: '2.0', id,
    error: { code: -32603, message },
  }]);
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── MCP 工具定义 ──

const CUSTOM_TOOLS = [
  // ── 已有的写工具 ──
  {
    name: 'send_boop',
    description: '[write·vrchat] Send a boop to a user. Requires userId.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        emojiId: { type: 'string', description: 'Optional emoji ID' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_boop_emojis',
    description: '[query] List built-in boop emojis and their emojiId format.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'upload_emoji',
    description: '[write·vrchat] Upload a custom boop emoji (requires VRChat Plus). Returns fileId to use as emojiId in send_boop.',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file (e.g. D:/path/emoji.png)' },
        animated: { type: 'boolean', description: 'Upload as animated emoji', default: false },
        animationStyle: { type: 'string', description: 'Animation style (e.g. bounce/spin), only used when animated=true' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'upload_print',
    description: '[write·vrchat] Upload a photo to your VRChat prints album (requires VRChat Plus).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file' },
        note: { type: 'string', description: 'Optional photo note' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'upload_gallery_image',
    description: '[write·vrchat] Upload an image to your VRC+ gallery (requires VRChat Plus).',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: 'Absolute path to the image file' },
      },
      required: ['imagePath'],
    },
  },
  {
    name: 'get_prints',
    description: '[query] List your VRChat prints (VRChat Plus photo album).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
        userId: { type: 'string', description: 'VRChat user id (usr_...). Defaults to current user.' },
      },
    },
  },
  {
    name: 'remove_print',
    description: '[write·vrchat] Remove a print from your VRChat prints album. Requires printId and confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        printId: { type: 'string', description: 'Print ID (prnt_...)' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the print (irreversible). Default false returns preview only.' },
      },
      required: ['printId'],
    },
  },
  {
    name: 'get_gallery_images',
    description: '[query] List your VRChat gallery images (VRChat Plus).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
      },
    },
  },
  {
    name: 'remove_gallery_image',
    description: '[write·vrchat] Remove an image from your VRChat gallery. Requires fileId and confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File ID (file_...)' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the gallery image (irreversible). Default false returns preview only.' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'download_print',
    description: '[query] Download a photo from your VRChat prints album to local disk. Returns local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        printId: { type: 'string', description: 'Print ID (prnt_...)' },
        outputDir: { type: 'string', description: 'Optional output directory. Defaults to <service>/downloads/' },
      },
      required: ['printId'],
    },
  },
  {
    name: 'download_gallery_image',
    description: '[query] Download an image from your VRC+ gallery to local disk. Returns local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File ID (file_...)' },
        outputDir: { type: 'string', description: 'Optional output directory. Defaults to <service>/downloads/' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'send_invite',
    description: '[write·vrchat] Send an invite to join your current instance.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        worldId: { type: 'string' },
        instanceId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId', 'worldId', 'instanceId'],
    },
  },
  {
    name: 'request_invite',
    description: '[write·vrchat] Request an invite from a user.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'send_friend_request',
    description: '[write·vrchat] Send a friend request to a user. Supports userId or exact displayName match.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search and send friend request' },
      },
    },
  },
  {
    name: 'remove_friend',
    description: '[write·vrchat] Remove a friend. Requires userId or exact displayName match, plus confirm: true to execute (irreversible).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search and remove friend' },
        confirm: { type: 'boolean', description: 'Set true to actually remove the friend (irreversible). Default false returns preview only.' },
      },
    },
  },
  // ── Phase 1 新增的读工具 ──
  {
    name: 'get_online_friends',
    description: '[query] List currently online friends from VRChat API.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_friend_info',
    description: '[query] Get detailed info about a specific friend from API.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Or search by display name' },
      },
    },
  },
  {
    name: 'get_mutual_friends',
    description: '[query] List mutual friends between you and a user (userId or exact displayName). Includes local nicknames.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        displayName: { type: 'string', description: 'Exact display name to search' },
        limit: { type: 'number', default: 100, description: 'Max results (1-100, default 100)' },
      },
    },
  },
  {
    name: 'search_users',
    description: '[query] Search VRChat users by display name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_database_stats',
    description: '[system] Get local database statistics (event count, friend count, etc).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_server_status',
    description: '[system] Check server health and auth status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── 新增 Phase 4 工具 ──
  {
    name: 'get_friend_events',
    description: '[query] Query a friend\'s event history from local database.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Friend ID (usr_...)' },
        limit: { type: 'number', default: 20 },
        offset: { type: 'number', default: 0 },
        types: { type: 'string', description: 'Comma-separated event types to filter' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'get_recent_events',
    description: '[query] Get the latest event stream from local database.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 30 },
        offset: { type: 'number', default: 0 },
        typeFilter: { type: 'string', description: 'Comma-separated event types to filter' },
        userIdFilter: { type: 'string', description: 'Filter by friend user ID' },
      },
    },
  },
  {
    name: 'get_world_name',
    description: '[query] Get world name by worldId. Checks local cache first, falls back to API.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        forceRefresh: { type: 'boolean', description: 'Force refresh from API' },
      },
      required: ['worldId'],
    },
  },
  {
    name: 'set_world_note',
    description: '[manage] Set or update a user note for a world (stored locally, never overwritten by API refresh). Empty string clears the note.',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        note: { type: 'string', description: 'User note text; empty string clears' },
      },
      required: ['worldId', 'note'],
    },
  },
  {
    name: 'get_world_history',
    description: '[query] Get change history of a world\'s info (name, description, capacity, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'World ID (wrld_...)' },
        limit: { type: 'number', default: 50, description: 'Max history entries' },
      },
      required: ['worldId'],
    },
  },
  {
    name: 'get_weekly_report',
    description: '[query] Generate a weekly gaming report for the authenticated user: active days, play time, worlds visited, companion friends (with nicknames), own online pattern, group activities and friend group calendar. Data from local events DB + cached group info.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', default: 7, description: 'Report window in days (default 7)' },
      },
    },
  },
  {
    name: 'get_watchlist',
    description: '[manage] List all watched friends.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'add_to_watchlist',
    description: '[manage] Add a friend to watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user ID (usr_...)' },
        displayName: { type: 'string', description: 'Optional display name' },
        priority: { type: 'number', default: 1, description: 'Priority 0-5' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'remove_from_watchlist',
    description: '[manage] Remove a friend from watchlist.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user ID (usr_...)' },
      },
      required: ['userId'],
    },
  },
  // ── 新增：同屏好友查询 ──
  {
    name: 'get_companions',
    description: '[query] Find all friends who were in the same instances as you during a time range. Uses SQLite cross-reference by instanceId. Each companion has: userId/displayName/firstSeen/lastSeen/matchCount/worlds (worlds is a STRING array of world names or worldIds, NOT objects).',
    inputSchema: {
      type: 'object',
      properties: {
        startTime: { type: 'string', description: 'Start time (ISO 8601, UTC recommended, e.g. 2026-07-25T11:00:00Z)' },
        endTime: { type: 'string', description: 'End time (ISO 8601, UTC)' },
        userId: { type: 'string', description: 'Optional: override userId. Defaults to current user.' },
      },
      required: ['startTime', 'endTime'],
    },
  },
  // ── 新增：好友上线规律分析 ──
  {
    name: 'get_online_pattern',
    description: '[query] Analyze a friend\'s online activity pattern (hourly distribution and frequency in Beijing time).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        days: { type: 'number', default: 30, description: 'Analyze last N days (Beijing time natural days, default 30)' },
        startTime: { type: 'string', description: 'Optional exact start time (ISO 8601 UTC); if provided with endTime, overrides days' },
        endTime: { type: 'string', description: 'Optional exact end time (ISO 8601 UTC); if provided with startTime, overrides days' },
      },
      required: ['userId'],
    },
  },
  // ── 新增：昵称映射 ──
  {
    name: 'get_nicknames',
    description: '[manage] Query friend nickname mappings (exact by userId, fuzzy by nickname/displayName, or all).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        query: { type: 'string', description: 'Fuzzy search on display_name or nickname' },
      },
    },
  },
  {
    name: 'set_nickname',
    description: '[manage] Set or update a friend nickname mapping (upsert).',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...)' },
        nickname: { type: 'string', description: 'Nickname to store' },
        displayName: { type: 'string', description: 'Optional current display name' },
      },
      required: ['userId', 'nickname'],
    },
  },
  // ── 新增：group 查询工具 ──
  {
    name: 'get_user_groups',
    description: '[group] List groups a user has joined (default: current account). withDetails=true also fetches descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'VRChat user id (usr_...); omit to use the authenticated account' },
        withDetails: { type: 'boolean', description: 'When true, also fetch each group\'s description (slower, ~1 req/group; failures skipped)' },
      },
    },
  },
  {
    name: 'get_group_info',
    description: '[group] Get a VRChat group\'s details (name, member count, description, verified status). includeAnnouncement=true also fetches the announcement.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        includeAnnouncement: { type: 'boolean', description: 'When true, also fetch the group announcement (null if none / not a member)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'get_group_instances',
    description: '[group] List a group\'s currently open group instances (rooms). Empty array = no rooms open.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'get_group_announcement',
    description: '[group] Get a group\'s announcement post (title/text/author/createdAt). null if none or not a member.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'search_groups',
    description: '[group] Search VRChat groups by name. Returns matching groups (query param; API requires query, NOT search).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Group name keyword (supports Chinese/Japanese/English)' },
        n: { type: 'number', description: 'Max results (default 30, max 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_worlds',
    description: '[query] Search VRChat worlds by name. English/Japanese search the live API; Chinese keywords fall back to local cache (API CJK search is unreliable).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'World name keyword (Chinese/English/Japanese)' },
        n: { type: 'number', description: 'Max API results (default 10, max 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'join_group',
    description: '[group] Join a group. Open groups join instantly; 400 already-member is returned as alreadyMember:true (no error).',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'leave_group',
    description: '[group] Leave a group (removes your membership). Requires confirm: true. 404 non-member returns notMember:true.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        confirm: { type: 'boolean', description: 'Must be true to actually leave; otherwise returns preview only' },
      },
      required: ['groupId'],
    },
  },
  {
    name: 'peek_group_announcement',
    description: '[group] Peek a group announcement: joins if joinState=open, reads announcement, then leaves. Requires confirm: true. Non-open groups return peekable:false.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'VRChat group id (grp_...)' },
        confirm: { type: 'boolean', description: 'Must be true to auto-join (members see the join feed)' },
      },
      required: ['groupId'],
    },
  },
];

// ── 工具处理器 ──

function parseLocation(loc) {
  if (!loc) return null;
  if (loc === 'offline') return { type: 'offline' };
  if (loc === 'traveling') return { type: 'traveling' };
  if (loc === 'private') return { type: 'private' };
  const sep = loc.indexOf(':');
  const worldId = sep >= 0 ? loc.slice(0, sep) : loc;
  const rest = sep >= 0 ? loc.slice(sep + 1) : '';
  const instMatch = rest.match(/^([^~]+)/);
  // 白名单匹配实例类型（~private/hidden/friends/group/public 带 owner 括号）；~region(jp) / ~groupAccessType(x) 是元字段
  const typeMatch = rest.match(/~(private|hidden|friends|group|public)\(([^)]+)\)/);
  // ~local 无括号（VRChat 本地实例格式 `~local`）
  const localMatch = rest.match(/~local\b/);
  const regionMatch = rest.match(/~region\(([^)]+)\)/);
  const gAccessMatch = rest.match(/~groupAccessType\(([^)]+)\)/);
  return {
    // 有 instanceId 但无类型标记 = VRChat 无房主公开实例 → 'public'
    type: typeMatch ? typeMatch[1] : (localMatch ? 'local' : (instMatch ? 'public' : null)),
    ownerId: typeMatch ? typeMatch[2] : null,
    worldId: worldId || null,
    instanceId: instMatch ? instMatch[1] : null,
    region: regionMatch ? regionMatch[1] : null,
    groupAccessType: gAccessMatch ? gAccessMatch[1] : null,
  };
}

async function handleGetOnlineFriends() {
  const r = await api._request('GET', '/auth/user/friends?offline=false');
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const friends = Array.isArray(r.data) ? r.data : [];
  const online = friends.filter(f => f.location && f.location !== 'offline');

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  return {
    online: online.length,
    total: friends.length,
    friends: online.map(f => ({
      userId: f.id,
      displayName: f.displayName,
      location: f.location || 'private',
      status: f.status,
      statusDescription: f.statusDescription,
      platform: f.platform,
      avatarImageUrl: f.currentAvatarThumbnailImageUrl,
      nickname: nicknameMap.get(f.id) || null,
      locationParsed: parseLocation(f.location || 'private'),
    })),
  };
}

async function handleGetFriendInfo({ userId, displayName }) {
  let targetId = userId;
  if (!targetId && displayName) {
    // 搜索用户
    const r = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=5`);
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    const users = Array.isArray(r.data) ? r.data : [];
    if (users.length === 0) return { error: 'User not found' };
    targetId = users[0].id;
  }
  if (!targetId) throw new Error('Provide userId or displayName');

  const r = await api._request('GET', `/users/${targetId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const u = r.data;
  return {
    userId: u.id,
    displayName: u.displayName,
    bio: u.bio,
    status: u.status,
    statusDescription: u.statusDescription,
    state: u.state,
    location: u.location,
    worldId: u.worldId,
    platform: u.platform,
    avatarImageUrl: u.currentAvatarImageUrl,
    avatarThumbnail: u.currentAvatarThumbnailImageUrl,
    tags: u.tags,
    developerType: u.developerType,
    isFriend: u.isFriend,
    lastLogin: u.last_login,
    pastDisplayNames: u.pastDisplayNames,
    dateJoined: u.date_joined,
    ageVerification: u.ageVerificationStatus,
  };
}

async function handleSearchUsers({ query, limit = 10 }) {
  const r = await api._request('GET', `/users?search=${encodeURIComponent(query)}&n=${limit}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  return {
    query,
    results: (Array.isArray(r.data) ? r.data : []).map(u => ({
      userId: u.id,
      displayName: u.displayName,
      bio: (u.bio || '').slice(0, 100),
      status: u.status,
      isFriend: u.isFriend,
    })),
  };
}

async function handleGetMutualFriends({ userId, displayName, limit = 100 }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let targetId = userId;
  let targetDisplayName = null;

  if (!targetId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    targetId = matches[0].id;
    targetDisplayName = matches[0].displayName;
  }

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/users/${targetId}/mutuals/friends?n=${n}&offset=0`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const nicknames = storage.getNicknames({});
  const nicknameMap = new Map();
  for (const item of nicknames) {
    if (item.userId) nicknameMap.set(item.userId, item.nickname);
  }

  const mutuals = Array.isArray(r.data) ? r.data : [];
  const mutualFriends = mutuals.map(u => ({
    userId: u.id,
    displayName: u.displayName,
    nickname: nicknameMap.get(u.id) || null,
    isFriend: u.isFriend !== undefined ? u.isFriend : true,
  }));

  return {
    userId: targetId,
    displayName: targetDisplayName,
    total: mutualFriends.length,
    mutualFriends,
  };
}

async function handleSendFriendRequest({ userId, displayName }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  if (userId) {
    const r = await api.sendFriendRequest(userId);
    if (r.status >= 400) throw new Error(`API error ${r.status}`);
    return { userId, displayName: null, method: 'userId', ok: true };
  }

  const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
  if (search.status !== 200) throw new Error(`API error: ${search.status}`);
  const users = Array.isArray(search.data) ? search.data : [];
  const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

  if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
  if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

  const target = matches[0];
  if (target.isFriend) throw new Error(`"${displayName}" 已经是你的好友，无需重复添加`);
  const r = await api.sendFriendRequest(target.id);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.id, displayName, method: 'displayName', ok: true };
}

async function handleRemoveFriend({ userId, displayName, confirm }) {
  if (!userId && !displayName) throw new Error('userId or displayName is required');

  let target = { userId, displayName };
  if (!userId) {
    const search = await api._request('GET', `/users?search=${encodeURIComponent(displayName)}&n=20`);
    if (search.status !== 200) throw new Error(`API error: ${search.status}`);
    const users = Array.isArray(search.data) ? search.data : [];
    const matches = users.filter(u => u.displayName && u.displayName.toLowerCase() === displayName.toLowerCase());

    if (matches.length === 0) throw new Error(`未找到显示名为 "${displayName}" 的用户`);
    if (matches.length > 1) throw new Error(`显示名 "${displayName}" 匹配到多个用户，请用 userId 指定`);

    const found = matches[0];
    if (found.isFriend === false) throw new Error(`"${displayName}" 不是你的好友，无需删除`);
    target = { userId: found.id, displayName };
  }

  if (!confirm) {
    return { userId: target.userId, displayName: target.displayName, confirmRequired: true, message: '删除好友不可逆，请传 confirm: true 确认执行' };
  }

  const r = await api.removeFriend(target.userId);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { userId: target.userId, displayName: target.displayName, ok: true };
}

function handleGetDatabaseStats() {
  return {
    ...storage.getStats(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

function handleGetServerStatus() {
  return {
    status: 'running',
    startedAt: serverState.started,
    authenticated: !!serverState.authUser,
    user: serverState.authUser,
    dbEvents: storage.getStats().events,
    dbFriends: storage.getStats().friends,
    ws: wsManager?.getState(),
    friendState: friendState?.getStats(),
    eventPipeline: eventPipeline?.getStats(),
  };
}

// ── Phase 4 新增处理器 ──

async function handleGetFriendEvents({ userId, limit = 20, offset = 0, types }) {
  // 单类型查询
  if (types && !types.includes(',')) {
    const events = storage.getEventsByUser(userId, { limit, offset, type: types.trim() });
    return { userId, total: events.length, events };
  }
  // 多类型/无类型过滤
  const events = storage.getEventsByUser(userId, { limit, offset });
  if (types) {
    const typeSet = new Set(types.split(',').map(t => t.trim()));
    const filtered = events.filter(e => typeSet.has(e.type));
    return { userId, total: filtered.length, events: filtered };
  }
  return { userId, total: events.length, events };
}

function handleGetRecentEvents({ limit = 30, offset = 0, typeFilter, userIdFilter }) {
  let events;
  if (userIdFilter) {
    events = storage.getEventsByUser(userIdFilter, { limit, offset });
  } else {
    events = storage.getRecentEvents({ limit: limit + offset });
    if (offset > 0) events = events.slice(offset);
  }
  if (typeFilter) {
    const typeSet = new Set(typeFilter.split(',').map(t => t.trim()));
    events = events.filter(e => typeSet.has(e.type));
  }
  return { total: events.length, events };
}

async function handleGetWorldName({ worldId, forceRefresh }) {
  // 懒刷新：缓存命中直接返回，只有 forceRefresh 或缓存不存在时才走 API
  if (!forceRefresh) {
    const cached = storage.getWorldName(worldId);
    if (cached) {
      return { worldId, name: cached.name, source: 'cache', ...cached };
    }
  }
  // 调 API
  const prev = storage.getWorldName(worldId);
  const r = await api._request('GET', `/worlds/${worldId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const w = r.data;
  const result = {
    worldId: w.id,
    name: w.name,
    authorName: w.authorName,
    capacity: w.capacity,
    occupants: w.occupants,
    releaseStatus: w.releaseStatus,
    tags: w.tags,
    description: (w.description || '').slice(0, 200),
    imageUrl: w.imageUrl,
    favorites: w.favorites,
    note: prev?.note ?? null,
    source: 'api',
  };
  // 写入缓存（不覆盖 note）
  storage.upsertWorld({
    worldId: w.id, name: w.name, authorName: w.authorName,
    capacity: w.capacity, favorites: w.favorites,
    releaseStatus: w.releaseStatus, tags: w.tags || [],
    description: w.description || '', imageUrl: w.imageUrl || '',
  });
  return result;
}

function handleSetWorldNote({ worldId, note }) {
  if (!worldId) throw new Error('worldId is required');
  if (note === undefined || note === null) throw new Error('note is required (empty string clears)');
  const result = storage.setWorldNote({ worldId, note });
  storage.save();
  return result;
}

function handleGetWorldHistory({ worldId, limit = 50 }) {
  if (!worldId) throw new Error('worldId is required');
  return { worldId, history: storage.getWorldHistory(worldId, limit) };
}

async function handleGetWeeklyReport({ days = 7 }) {
  if (!days || days < 1 || days > 90) days = 7;
  // 北京时间窗口（UTC - 8h）
  const endUtc = new Date(Date.now() - 8 * 3600 * 1000);  // 北京当前时刻转 UTC
  const startMs = endUtc.getTime() - days * 86400000;
  const startUtc = new Date(startMs);
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  const userId = serverState.authUser?.id;
  if (!userId) throw new Error('Not authenticated');

  // 1. 会话切分 → 世界停留统计
  const sessions = storage.getOwnWorldSessions(startIso, endIso);
  const worldMinutes = new Map();  // worldId -> {minutes, visits}
  const dayWorlds = new Map();     // MM-DD -> Set<worldId>
  for (const s of sessions) {
    if (!worldMinutes.has(s.worldId)) worldMinutes.set(s.worldId, { minutes: 0, visits: 0 });
    const w = worldMinutes.get(s.worldId); w.minutes += s.minutes; w.visits++;
    const dayLabel = new Date(Date.parse(s.start) + 8 * 3600 * 1000).toISOString().slice(5, 10);
    if (!dayWorlds.has(dayLabel)) dayWorlds.set(dayLabel, new Set());
    dayWorlds.get(dayLabel).add(s.worldId);
  }

  // 2. 同屏合并
  const companions = storage.getWeeklyCompanions(userId, startIso, endIso);

  // 3. 自己的上线规律（复用 getOnlinePattern，window = 30 天）
  const pattern = storage.getOnlinePattern(userId, { days: Math.max(days, 30) });

  // 4. 世界名解析（缓存优先，缺失批量 API 查询并写 world_cache——懒刷新，无 TTL 自动过期）
  const allWorldIds = new Set([...worldMinutes.keys(), ...(function(){ const s=new Set(); for (const d of dayWorlds.values()) for (const w of d) s.add(w); return s; })()]);
  const worldNameMap = {};
  const missingWorlds = [];
  for (const wid of allWorldIds) {
    const cached = storage.getWorldName(wid);
    if (cached && cached.name) worldNameMap[wid] = cached.name;
    else missingWorlds.push(wid);
  }
  // 批量 API 查缺失世界名（串行，rateLimiter 在 RPC case 外层已包）
  for (const wid of missingWorlds) {
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const w = r.data;
        worldNameMap[wid] = w.name || wid;
        storage.upsertWorld({ worldId: w.id, name: w.name, authorName: w.authorName, capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus, tags: w.tags || [], description: w.description || '', imageUrl: w.imageUrl || '' });
      } else worldNameMap[wid] = wid;
    } catch { worldNameMap[wid] = wid; }
  }

  // 5. 群组活动（自己进过的群组房）——从 sessions 对应的事件里找 ~group(grp_xxx)
  //    直接查 user-location 事件的 groupId
  const myGroupRows = storage._query(
    `SELECT content_json, created_at FROM events WHERE type='user-location' AND created_at >= $s AND created_at <= $e AND content_json LIKE '%~group(grp_%' ORDER BY created_at`,
    { $s: startIso, $e: endIso }
  );
  const groupActivities = [];
  const groupIds = new Set();
  for (const row of myGroupRows) {
    try {
      const c = JSON.parse(row.content_json);
      const loc = c.location || '';
      const m = loc.match(/~group\((grp_[a-f0-9-]+)\)/);
      if (m) {
        groupIds.add(m[1]);
        const wid = loc.split(':')[0];
        groupActivities.push({ time: row.created_at, worldId: wid, worldName: worldNameMap[wid] || wid, groupId: m[1] });
        // 群组房可能停留 <3min 未进 worldMinutes，这里补入世界名解析集合
        if (!worldNameMap[wid] && !missingWorlds.includes(wid)) missingWorlds.push(wid);
      }
    } catch {}
  }
  // 补充解析群组房的世界名（第 4 步未覆盖的）
  for (const wid of missingWorlds) {
    if (worldNameMap[wid]) continue;
    try {
      const r = await api._request('GET', `/worlds/${wid}`);
      if (r.status === 200 && r.data) {
        const w = r.data;
        worldNameMap[wid] = w.name || wid;
        storage.upsertWorld({ worldId: w.id, name: w.name, authorName: w.authorName, capacity: w.capacity, favorites: w.favorites, releaseStatus: w.releaseStatus, tags: w.tags || [], description: w.description || '', imageUrl: w.imageUrl || '' });
      } else worldNameMap[wid] = wid;
    } catch { worldNameMap[wid] = wid; }
  }
  // 回填 groupActivities 的世界名
  for (const a of groupActivities) {
    if (worldNameMap[a.worldId]) a.worldName = worldNameMap[a.worldId];
  }

  // 6. 圈内活动日历（好友群组房统计）
  const friendGroups = storage.getFriendGroupStats(startIso, endIso);
  for (const gid of friendGroups.keys()) groupIds.add(gid);

  // 7. 群组信息（group_cache 优先，缺失查 API 并缓存；TTL 7 天）
  const groupInfoMap = {};
  const missingGroups = [];
  for (const gid of groupIds) {
    const cached = storage.getGroupCached(gid);
    if (cached && cached.name && (Date.now() - Date.parse(cached.updated_at.replace(' ', 'T') + 'Z')) < 7 * 86400000) {
      groupInfoMap[gid] = { groupId: gid, name: cached.name, description: cached.description, memberCount: cached.member_count };
    } else missingGroups.push(gid);
  }
  let groupCacheUpdated = false;
  for (const gid of missingGroups) {
    try {
      const r = await api._request('GET', `/groups/${gid}`);
      if (r.status === 200 && r.data) {
        const d = r.data;
        groupInfoMap[gid] = { groupId: gid, name: d.name || gid, description: d.description || '', memberCount: d.memberCount || 0 };
        storage.upsertGroupCache({ groupId: gid, name: d.name || '', description: d.description || '', memberCount: d.memberCount || 0 });
        groupCacheUpdated = true;
      } else groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 };
    } catch { groupInfoMap[gid] = { groupId: gid, name: gid, description: '', memberCount: 0 }; }
  }
  if (groupCacheUpdated) storage.save();

  // 8. 昵称映射（带昵称展示）
  const nicknames = storage.getNicknames({});
  const nickMap = {};
  for (const n of nicknames) nickMap[n.userId] = n.nickname || n.displayName;

  // 组装结果
  const topWorlds = [...worldMinutes.entries()]
    .map(([wid, v]) => ({ worldId: wid, name: worldNameMap[wid] || wid, minutes: Math.round(v.minutes), visits: v.visits }))
    .sort((a, b) => b.minutes - a.minutes);

  const topCompanions = [...companions.entries()]
    .map(([uid, v]) => ({ userId: uid, displayName: v.displayName, nickname: nickMap[uid] || null, matchCount: v.matchCount, days: v.days.size, dayList: [...v.days].sort() }))
    .sort((a, b) => b.days - a.days || b.matchCount - a.matchCount);

  const friendGroupCalendar = [...friendGroups.entries()]
    .map(([gid, v]) => ({ groupId: gid, groupName: groupInfoMap[gid]?.name || gid, friendCount: v.users.size, eventCount: v.count, worldCount: v.worlds.size, memberCount: groupInfoMap[gid]?.memberCount || 0 }))
    .sort((a, b) => b.friendCount - a.friendCount || b.eventCount - a.eventCount);

  return {
    period: { start: startIso, end: endIso, days, tz: 'UTC' },
    overview: {
      activeDays: dayWorlds.size,
      totalMinutes: Math.round(sessions.reduce((a, s) => a + s.minutes, 0)),
      worldsVisited: worldMinutes.size,
      companionUsers: companions.size,
      topCompanion: topCompanions[0] ? { userId: topCompanions[0].userId, displayName: topCompanions[0].displayName, nickname: topCompanions[0].nickname, days: topCompanions[0].days, matchCount: topCompanions[0].matchCount } : null,
    },
    daily: [...dayWorlds.entries()].sort().map(([day, worlds]) => ({ day, worlds: [...worlds].map(w => ({ worldId: w, name: worldNameMap[w] || w })) })),
    topWorlds,
    ownPattern: {
      activeDays30: pattern.activeDates?.length || 0,
      hourly: pattern.hourly?.location || {},
      peakHour: pattern.peak?.activePeakHour ?? null,
      avgGapDays: pattern.frequency?.avgGapDays ?? null,
      longestGapDays: pattern.frequency?.longestGapDays ?? null,
    },
    topCompanions,
    groupActivities: groupActivities.map(a => ({ ...a, groupName: groupInfoMap[a.groupId]?.name || a.groupId, memberCount: groupInfoMap[a.groupId]?.memberCount || 0 })),
    friendGroupCalendar,
  };
}

function handleGetWatchlist() {
  return { watchlist: storage.getWatchlist() };
}

function handleAddToWatchlist({ userId, displayName, priority = 1 }) {
  storage.addToWatchlist(userId, displayName, priority);
  storage.save();
  _invalidateWatchlistCache();
  return { success: true, userId, priority };
}

function handleRemoveFromWatchlist({ userId }) {
  storage.removeFromWatchlist(userId);
  storage.save();
  _invalidateWatchlistCache();
  return { success: true, userId };
}

// ── 新增：同屏好友查询 ──

function handleGetCompanions({ startTime, endTime, userId }) {
  const targetUserId = userId || serverState.authUser?.id;
  if (!targetUserId) throw new Error('No userId provided and not authenticated');
  return storage.findCompanions(targetUserId, startTime, endTime);
}

// ── 新增：好友上线规律分析 ──

function handleGetOnlinePattern({ userId, days, startTime, endTime }) {
  if (!userId) throw new Error('userId is required');
  const opts = {};
  if (startTime && endTime) {
    opts.startTime = startTime;
    opts.endTime = endTime;
  } else if (days !== undefined && days !== null) {
    opts.days = days;
  }
  return storage.getOnlinePattern(userId, opts);
}

// ── 新增：昵称映射 ──

function handleGetNicknames({ userId, query }) {
  return { nicknames: storage.getNicknames({ userId, query }) };
}

function handleSetNickname({ userId, nickname, displayName }) {
  if (!userId) throw new Error('userId is required');
  if (!nickname) throw new Error('nickname is required');
  const result = storage.setNickname({ userId, nickname, displayName });
  storage.save();
  return result;
}

// ── 新增：group 查询工具 ──

async function handleGetUserGroups({ userId, withDetails }) {
  let targetId = userId;
  if (!targetId) {
    targetId = serverState.authUser?.id;
    if (!targetId) {
      const r = await api._request('GET', '/auth/user');
      if (r.status !== 200) throw new Error(`API error: ${r.status}`);
      targetId = r.data?.id;
    }
  }
  if (!targetId) throw new Error('Unable to determine target user id');
  const r = await api._request('GET', `/users/${targetId}/groups`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const groups = (r.data || []).map((g) => {
    const item = {};
    if (g.groupId !== undefined && g.groupId !== null) item.groupId = g.groupId;
    if (g.name !== undefined && g.name !== null) item.name = g.name;
    if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
    if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
    if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
    if (g.myRank !== undefined && g.myRank !== null) {
      item.myRank = typeof g.myRank === 'object' ? (g.myRank.id || null) : g.myRank;
    }
    return item;
  });
  if (withDetails && groups.length > 0) {
    const CONCURRENCY = 5;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, groups.length) }, async () => {
      while (idx < groups.length) {
        const i = idx++;
        const g = groups[i];
        try {
          const d = await api._request('GET', `/groups/${g.groupId}`);
          if (d.status === 200 && d.data) {
            if (d.data.description) g.description = d.data.description;
            if (d.data.isVerified !== undefined && d.data.isVerified !== null) g.isVerified = d.data.isVerified;
          }
        } catch (e) { /* 单群失败忽略 */ }
      }
    });
    await Promise.all(workers);
  }
  return { userId: targetId, count: groups.length, groups };
}

async function handleGetGroupInfo({ groupId, includeAnnouncement }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const d = r.data;
  const result = { groupId: d.id };
  if (d.name !== undefined && d.name !== null) result.name = d.name;
  if (d.shortCode !== undefined && d.shortCode !== null) result.shortCode = d.shortCode;
  if (d.memberCount !== undefined && d.memberCount !== null) result.memberCount = d.memberCount;
  if (d.isVerified !== undefined && d.isVerified !== null) result.isVerified = d.isVerified;
  if (d.description !== undefined && d.description !== null) result.description = d.description;
  if (d.discordId !== undefined && d.discordId !== null) result.discordId = d.discordId;
  if (d.bannerId !== undefined && d.bannerId !== null) result.bannerId = d.bannerId;
  if (d.tags !== undefined && d.tags !== null) result.tags = d.tags;
  if (d.joinState !== undefined && d.joinState !== null) result.joinState = d.joinState;
  if (d.allowGroupJoinPrompt !== undefined && d.allowGroupJoinPrompt !== null) result.allowGroupJoinPrompt = d.allowGroupJoinPrompt;
  if (includeAnnouncement) {
    try {
      const a = await api._request('GET', `/groups/${groupId}/announcement`);
      if (a.status === 200 && a.data && typeof a.data === 'object' && a.data.text) {
        result.announcement = {
          id: a.data.id, title: a.data.title, text: a.data.text,
          authorId: a.data.authorId, createdAt: a.data.createdAt,
          updatedAt: a.data.updatedAt, visibility: a.data.visibility,
        };
      } else {
        result.announcement = null;
      }
    } catch (e) {
      result.announcement = null;
    }
  }
  return result;
}

async function handleGetGroupInstances({ groupId }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}/instances`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const instances = (r.data || []).map((inst) => ({
    instanceId: inst.instanceId,
    location: inst.location,
    memberCount: inst.memberCount,
    worldId: inst.world?.id || null,
    worldName: inst.world?.name || null,
    worldAuthor: inst.world?.authorName || null,
    worldCapacity: inst.world?.capacity || null,
    worldImageUrl: inst.world?.imageUrl || null,
  }));
  return { groupId, count: instances.length, instances };
}

async function handleGetGroupAnnouncement({ groupId }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('GET', `/groups/${groupId}/announcement`);
  if (r.status !== 200) {
    if (r.status === 403 || r.status === 404) return { groupId, announcement: null };
    throw new Error(`API error: ${r.status}`);
  }
  const d = r.data;
  if (!d || typeof d !== 'object' || !d.text) {
    return { groupId, announcement: null };
  }
  return {
    groupId,
    announcement: {
      id: d.id,
      title: d.title,
      text: d.text,
      authorId: d.authorId,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      visibility: d.visibility,
      imageUrl: d.imageUrl,
    },
  };
}

async function handleSearchGroups({ query, n }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const limit = Math.min(Math.max(parseInt(n, 10) || 30, 1), 100);
  const r = await api._request('GET', `/groups?query=${encodeURIComponent(query)}&n=${limit}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);
  const groups = (r.data || []).map((g) => {
    const item = {};
    if (g.id !== undefined && g.id !== null) item.groupId = g.id;
    if (g.name !== undefined && g.name !== null) item.name = g.name;
    if (g.shortCode !== undefined && g.shortCode !== null) item.shortCode = g.shortCode;
    if (g.memberCount !== undefined && g.memberCount !== null) item.memberCount = g.memberCount;
    if (g.isVerified !== undefined && g.isVerified !== null) item.isVerified = g.isVerified;
    if (g.description !== undefined && g.description !== null) item.description = g.description;
    return item;
  });
  return { query, count: groups.length, groups };
}

async function handleSearchWorlds({ query, n }) {
  if (!query || typeof query !== 'string') throw new Error('query is required');
  const limit = Math.min(Math.max(parseInt(n, 10) || 10, 1), 30);
  const apiWorlds = [];
  try {
    const r = await api._request('GET', `/worlds?search=${encodeURIComponent(query)}&n=${limit}`);
    if (r.status === 200) {
      for (const w of (r.data || [])) {
        apiWorlds.push({
          worldId: w.id,
          name: w.name,
          authorName: w.authorName,
          capacity: w.capacity,
          imageUrl: w.imageUrl,
          description: (w.description || '').slice(0, 200),
        });
      }
    }
  } catch (e) { /* API 失败时仅用本地结果 */ }

  const local = storage.searchWorldsByName(query);

  // 合并：API 结果优先（完整信息），本地补充（可能命中 API 搜不到的）
  const seen = new Set(apiWorlds.map(w => w.worldId));
  const merged = [...apiWorlds];
  for (const lw of local) {
    if (!seen.has(lw.worldId)) {
      seen.add(lw.worldId);
      merged.push({ worldId: lw.worldId, name: lw.name });
    }
  }
  return { query, apiCount: apiWorlds.length, localCount: local.length, count: merged.length, worlds: merged };
}

async function handleJoinGroup({ groupId }) {
  if (!groupId) throw new Error('groupId is required');
  const r = await api._request('POST', `/groups/${groupId}/join`);
  if (r.status === 200 && r.data) {
    return { groupId, joined: true, membership: r.data.membershipId ? { membershipId: r.data.membershipId } : undefined };
  }
  if (r.status === 400 && typeof r.data?.error?.message === 'string' && r.data.error.message.includes('already a member')) {
    return { groupId, joined: false, alreadyMember: true };
  }
  throw new Error(`API error: ${r.status}`);
}

async function handleLeaveGroup({ groupId, confirm }) {
  if (!groupId) throw new Error('groupId is required');
  if (confirm !== true) {
    return { groupId, confirmRequired: true, message: 'Leaving a group removes you from it. Pass confirm: true to actually leave.' };
  }
  // 自己退出用 POST /groups/{id}/leave；DELETE /members/{userId} 是管理员移除成员（普通成员 403，实测 2026-08-09）
  const r = await api._request('POST', `/groups/${groupId}/leave`);
  if (r.status === 200) return { groupId, left: true };
  // 403 = 不是成员/群不存在（实测：POST leave 对无效群返回 403 而非 404）
  if (r.status === 403 || r.status === 404 || r.status === 400) return { groupId, left: false, notMember: true };
  throw new Error(`API error: ${r.status}`);
}

async function handlePeekGroupAnnouncement({ groupId, confirm }) {
  if (!groupId) throw new Error('groupId is required');
  if (confirm !== true) {
    return { groupId, confirmRequired: true, message: 'This auto-joins the group, reads its announcement, then leaves (members see the join feed). Pass confirm: true to proceed.' };
  }
  const g = await api._request('GET', `/groups/${groupId}`);
  if (g.status !== 200) throw new Error(`API error: ${g.status}`);
  const joinState = g.data?.joinState;
  if (joinState !== 'open') {
    return { groupId, joinState: joinState || 'unknown', peekable: false,
             message: joinState === 'request' ? 'Group requires request/approval - cannot auto-join.' :
                      joinState === 'invite' ? 'Group is invite-only - cannot auto-join.' : 'Group join state unknown.' };
  }
  let joinedNow = false;
  const j = await api._request('POST', `/groups/${groupId}/join`);
  if (j.status === 200) joinedNow = true;
  else if (!(j.status === 400 && typeof j.data?.error?.message === 'string' && j.data.error.message.includes('already a member'))) {
    throw new Error(`join failed: ${j.status}`);
  }
  try {
    const a = await api._request('GET', `/groups/${groupId}/announcement`);
    let announcement = null;
    if (a.status === 200 && a.data && typeof a.data === 'object' && a.data.text) {
      announcement = {
        id: a.data.id, title: a.data.title, text: a.data.text,
        authorId: a.data.authorId, createdAt: a.data.createdAt,
        updatedAt: a.data.updatedAt, visibility: a.data.visibility,
      };
    }
    return { groupId, joinState, peekable: true, joinedNow, announcement };
  } finally {
    // 4. 无论公告读取成功与否，刚加入就退出（POST leave，2026-08-09 实测正确端点）
    if (joinedNow) {
      try { await api._request('POST', `/groups/${groupId}/leave`); } catch (e) { /* 退出失败忽略 */ }
    }
  }
}

// ── 新增：boop emoji 工具 ──

function handleGetBoopEmojis() {
  const categories = [
    {
      name: '表情',
      names: ['Angry', 'Blushing', 'Crying', 'Frown', 'Hand Wave', 'Hang Ten', 'In Love', 'Jack O Lantern', 'Kiss', 'Laugh', 'Skull', 'Smile', 'Spooky Ghost', 'Stoic', 'Sunglasses', 'Thinking', 'Thumbs Down', 'Thumbs Up', 'Tongue Out', 'Wow'],
    },
    {
      name: '指令',
      names: ['Arrow Point', "Can't see", 'Hourglass', 'Keyboard', 'No Headphones', 'No Mic', 'Portal', 'Shush'],
    },
    {
      name: '季节/装饰',
      names: ['Bats', 'Cloud', 'Fire', 'Snow Fall', 'Snowball', 'Splash', 'Web', 'Beer', 'Candy', 'Candy Cane', 'Candy Corn', 'Champagne', 'Drink', 'Gingerbread', 'Ice Cream', 'Pineapple', 'Pizza', 'Tomato', 'Beachball', 'Coal', 'Confetti', 'Gift', 'Gifts', 'Life Ring', 'Mistletoe', 'Money', 'Neon Shades', 'Sun Lotion'],
    },
    {
      name: '通用',
      names: ['Boo', 'Broken Heart', 'Exclamation', 'Go', 'Heart', 'Music Note', 'Question', 'Stop', 'Zzz'],
    },
  ];

  const emojis = [];
  for (const category of categories) {
    for (const name of category.names) {
      emojis.push({
        name,
        emojiId: `default_${name.replace(/ /g, '_').toLowerCase()}`,
        category: category.name,
      });
    }
  }

  return {
    builtinCount: emojis.length,
    format: 'default_<name_lowercase_underscores> (e.g. "Hand Wave" -> default_hand_wave)',
    emojis,
    custom: {
      endpoint: 'POST /file/image (tag: emoji)',
      requiresVRCPlus: true,
      note: '自定义 emoji 用 upload_emoji 工具上传，返回 fileId 用作 emojiId',
    },
  };
}

async function handleUploadEmoji({ imagePath, animated = false, animationStyle }) {
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const tag = animated ? 'emojianimated' : 'emoji';
  const params = { tag, maskTag: 'square', animationStyle: (animationStyle || 'stop').toLowerCase() };

  const r = await api.uploadImageFile(fileBuffer, imagePath, params);
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const fileId = r.data?.id;
  if (!fileId) {
    throw new Error(`API 未返回 fileId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, fileId, emojiId: fileId, tag, requiresVRCPlus: true };
}

async function handleUploadPrint({ imagePath, note }) {
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const timestamp = new Date().toISOString().slice(0, 19);
  const r = await api.uploadPrint(fileBuffer, imagePath, { note, timestamp });
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const printId = r.data?.id;
  if (!printId) {
    throw new Error(`API 未返回 printId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, printId, note, timestamp };
}

async function handleUploadGalleryImage({ imagePath }) {
  if (!imagePath) throw new Error('imagePath is required (absolute path to the image file)');
  if (!existsSync(imagePath)) {
    throw new Error(`图片文件不存在: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = readFileSync(imagePath);
  } catch (err) {
    throw new Error(`读取图片失败: ${err.message}`);
  }

  const r = await api.uploadGalleryImage(fileBuffer, imagePath);
  if (r.status >= 400) {
    throw new Error(`API error ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  const fileId = r.data?.id;
  if (!fileId) {
    throw new Error(`API 未返回 fileId: ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  return { ok: true, fileId, tag: 'gallery' };
}

// ── 新增：prints / gallery 列表与删除工具 ──

async function handleGetPrints({ limit = 100, userId }) {
  let targetId = userId;
  if (!targetId) {
    const r = await api._request('GET', '/auth/user');
    if (r.status !== 200) throw new Error(`API error: ${r.status}`);
    targetId = r.data?.id;
  }
  if (!targetId) throw new Error('Unable to determine current user');

  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/prints/user/${targetId}?n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const prints = Array.isArray(r.data) ? r.data : [];
  return {
    userId: targetId,
    total: prints.length,
    prints: prints.map(p => ({
      printId: p.id,
      note: p.note,
      createdAt: p.createdAt,
      downloadUrl: p.files?.image,
      timestamp: p.timestamp,
      worldId: p.worldId,
      worldName: p.worldName,
      authorName: p.authorName,
    })),
  };
}

async function handleRemovePrint({ printId, confirm }) {
  if (!printId) throw new Error('printId is required');
  if (!confirm) {
    return { printId, confirmRequired: true, message: '删除相册照片不可逆，请传 confirm: true 确认执行' };
  }
  const r = await api._request('DELETE', `/prints/${printId}`);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { printId, ok: true };
}

async function handleGetGalleryImages({ limit = 100 }) {
  const n = Math.max(1, Math.min(100, Number(limit) || 100));
  const r = await api._request('GET', `/files?tag=gallery&n=${n}`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const images = Array.isArray(r.data) ? r.data : [];
  return {
    total: images.length,
    images: images.map(img => {
      const lastVersion = img.versions?.[img.versions.length - 1];
      return {
        fileId: img.id,
        name: img.name,
        extension: img.extension,
        mimeType: img.mimeType,
        downloadUrl: lastVersion?.file?.url,
      };
    }),
  };
}

async function handleRemoveGalleryImage({ fileId, confirm }) {
  if (!fileId) throw new Error('fileId is required');
  if (!confirm) {
    return { fileId, confirmRequired: true, message: '删除图库图片不可逆，请传 confirm: true 确认执行' };
  }
  const r = await api._request('DELETE', `/file/${fileId}`);
  if (r.status >= 400) throw new Error(`API error ${r.status}`);
  return { fileId, ok: true };
}

// ── 新增：下载 prints / gallery 图片 ──

function _extFromContentType(contentType, url) {
  if (contentType) {
    if (contentType.includes('image/png')) return 'png';
    if (contentType.includes('image/jpeg')) return 'jpg';
    if (contentType.includes('image/jpg')) return 'jpg';
    if (contentType.includes('image/gif')) return 'gif';
    if (contentType.includes('image/webp')) return 'webp';
    if (contentType.includes('image/bmp')) return 'bmp';
  }
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (match) return match[1].toLowerCase();
  } catch {}
  return 'png';
}

async function handleDownloadPrint({ printId, outputDir }) {
  if (!printId) throw new Error('printId is required');

  const user = await api.ensureAuth();
  const userId = user?.id;
  if (!userId) throw new Error('Unable to determine current user');

  const r = await api._request('GET', `/prints/user/${userId}?n=100`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const prints = Array.isArray(r.data) ? r.data : [];
  const print = prints.find(p => p.id === printId);
  if (!print) throw new Error(`未找到 printId: ${printId}`);

  const url = print.files?.image;
  if (!url) throw new Error(`未找到 printId: ${printId} 的图片 URL`);

  const buffer = await api.downloadFile(url);

  const ext = _extFromContentType(buffer.contentType, url);
  const dir = outputDir || path.join(__dirname, 'downloads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `print_${printId}.${ext}`);
  writeFileSync(filePath, buffer);

  return { ok: true, printId, path: filePath, sizeBytes: buffer.length, url };
}

async function handleDownloadGalleryImage({ fileId, outputDir }) {
  if (!fileId) throw new Error('fileId is required');

  const r = await api._request('GET', `/files?tag=gallery&n=100`);
  if (r.status !== 200) throw new Error(`API error: ${r.status}`);

  const images = Array.isArray(r.data) ? r.data : [];
  const image = images.find(img => img.id === fileId);
  if (!image) throw new Error(`未找到 fileId: ${fileId}`);

  const lastVersion = image.versions?.[image.versions.length - 1];
  const url = lastVersion?.file?.url;
  if (!url) throw new Error(`未找到 fileId: ${fileId} 的图片 URL`);

  const buffer = await api.downloadFile(url);

  const ext = _extFromContentType(buffer.contentType, url);
  const dir = outputDir || path.join(__dirname, 'downloads');
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `gallery_${fileId}.${ext}`);
  writeFileSync(filePath, buffer);

  return { ok: true, fileId, path: filePath, sizeBytes: buffer.length, url };
}

// ── RPC 处理 ──

async function handleRpc(rpc, session, res) {
  const { id, method, params } = rpc;

  switch (method) {
    case 'initialize': {
      session.initialized = true;
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'vrc-monitor', version: '1.0.0' },
        },
      }], session.id);
      break;
    }

    case 'notifications/initialized':
      sendSSE(res, [], session.id);
      break;

    case 'tools/list': {
      sendSSE(res, [{
        jsonrpc: '2.0', id,
        result: { tools: CUSTOM_TOOLS },
      }], session.id);
      break;
    }

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        let result;

        switch (name) {
          // 写工具（依赖 api client，经限流器）
          case 'send_boop': {
            const r = await rateLimiter.execute(() => api.sendBoop(args.userId, args.emojiId || ''));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, booped: true };
            break;
          }
          case 'get_boop_emojis': {
            result = await rateLimiter.execute(() => handleGetBoopEmojis());
            break;
          }
          case 'upload_emoji': {
            result = await rateLimiter.execute(() => handleUploadEmoji(args));
            break;
          }
          case 'upload_print': {
            result = await rateLimiter.execute(() => handleUploadPrint(args));
            break;
          }
          case 'upload_gallery_image': {
            result = await rateLimiter.execute(() => handleUploadGalleryImage(args));
            break;
          }
          case 'get_prints': {
            result = await rateLimiter.execute(() => handleGetPrints(args));
            break;
          }
          case 'remove_print': {
            result = await rateLimiter.execute(() => handleRemovePrint(args));
            break;
          }
          case 'get_gallery_images': {
            result = await rateLimiter.execute(() => handleGetGalleryImages(args));
            break;
          }
          case 'remove_gallery_image': {
            result = await rateLimiter.execute(() => handleRemoveGalleryImage(args));
            break;
          }
          case 'download_print': {
            result = await rateLimiter.execute(() => handleDownloadPrint(args));
            break;
          }
          case 'download_gallery_image': {
            result = await rateLimiter.execute(() => handleDownloadGalleryImage(args));
            break;
          }
          case 'send_invite': {
            await rateLimiter.execute(() => api.ensureAuth());
            const body = { instanceId: `${args.worldId}:${args.instanceId}` };
            if (args.message) body.message = args.message;
            const r = await rateLimiter.execute(() => api._request('POST', `/invite/${args.userId}`, body));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, invited: true };
            break;
          }
          case 'request_invite': {
            await rateLimiter.execute(() => api.ensureAuth());
            const r = await rateLimiter.execute(() => api._request('POST', `/requestInvite/${args.userId}`, {
              message: args.message || 'Can I join you?',
              platform: 'standalonewindows',
            }));
            if (r.status >= 400) throw new Error(`API error ${r.status}`);
            result = { success: true, userId: args.userId, requestSent: true };
            break;
          }
          case 'send_friend_request': {
            result = await rateLimiter.execute(() => handleSendFriendRequest(args));
            break;
          }
          case 'remove_friend': {
            result = await rateLimiter.execute(() => handleRemoveFriend(args));
            break;
          }
          // 读工具
          case 'get_online_friends':
            result = await rateLimiter.execute(handleGetOnlineFriends);
            break;
          case 'get_friend_info':
            result = await rateLimiter.execute(() => handleGetFriendInfo(args));
            break;
          case 'get_mutual_friends':
            result = await rateLimiter.execute(() => handleGetMutualFriends(args));
            break;
          case 'search_users':
            result = await rateLimiter.execute(() => handleSearchUsers(args));
            break;
          case 'get_database_stats':
            result = handleGetDatabaseStats();
            break;
          case 'get_server_status':
            result = handleGetServerStatus();
            break;
          // Phase 4 新工具
          case 'get_friend_events':
            result = await handleGetFriendEvents(args);
            break;
          case 'get_recent_events':
            result = handleGetRecentEvents(args);
            break;
          case 'get_world_name':
            result = await rateLimiter.execute(() => handleGetWorldName(args));
            break;
          case 'set_world_note':
            result = handleSetWorldNote(args);
            break;
          case 'get_world_history':
            result = handleGetWorldHistory(args);
            break;
          case 'get_weekly_report':
            result = await rateLimiter.execute(() => handleGetWeeklyReport(args));
            break;
          case 'get_watchlist':
            result = handleGetWatchlist();
            break;
          case 'add_to_watchlist':
            result = handleAddToWatchlist(args);
            break;
          case 'remove_from_watchlist':
            result = handleRemoveFromWatchlist(args);
            break;
          case 'get_companions':
            result = handleGetCompanions(args);
            break;
          case 'get_online_pattern':
            result = handleGetOnlinePattern(args);
            break;
          case 'get_nicknames':
            result = handleGetNicknames(args);
            break;
          case 'set_nickname':
            result = handleSetNickname(args);
            break;
          case 'get_user_groups':
            result = await rateLimiter.execute(() => handleGetUserGroups(args));
            break;
          case 'get_group_info':
            result = await rateLimiter.execute(() => handleGetGroupInfo(args));
            break;
          case 'get_group_instances':
            result = await rateLimiter.execute(() => handleGetGroupInstances(args));
            break;
          case 'get_group_announcement':
            result = await rateLimiter.execute(() => handleGetGroupAnnouncement(args));
            break;
          case 'search_groups':
            result = await rateLimiter.execute(() => handleSearchGroups(args));
            break;
          case 'search_worlds':
            result = await rateLimiter.execute(() => handleSearchWorlds(args));
            break;
          case 'join_group':
            result = await rateLimiter.execute(() => handleJoinGroup(args));
            break;
          case 'leave_group':
            result = await rateLimiter.execute(() => handleLeaveGroup(args));
            break;
          case 'peek_group_announcement':
            result = await rateLimiter.execute(() => handlePeekGroupAnnouncement(args));
            break;
          default:
            throw new Error(`Unknown tool: ${name}`);
        }

        sendSSE(res, [{
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        }]);
      } catch (err) {
        log(`❌ ${name} failed: ${err.message}`);
        sendError(res, id, err.message);
      }
      break;
    }

    default:
      sendSSE(res, [], session.id);
  }
}

// ── HTTP 服务 ──

function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      log(`❌ Unhandled: ${err.message}`);
      if (!res.headersSent) {
        try { res.writeHead(502); res.end(err.message); } catch {}
      }
    }
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    }
  });

  // 端口冲突不直接 crash
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`❌ 端口 ${PORT} 已被占用，请检查是否有旧进程残留`);
    } else {
      log(`❌ 服务器错误: ${err.message}`);
    }
  });

  return server;
}

async function handleRequest(req, res) {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    const uptime = serverState.started ? Math.floor((Date.now() - serverState.started) / 1000) : 0;
    const status = {
      ok: true,
      auth: serverState.authUser
        ? { authenticated: true, user: serverState.authUser }
        : { authenticated: false, needsOtp: serverState.needsOtp },
      db: storage.getStats(),
      rateLimiter: rateLimiter.getStats(),
      ws: wsManager?.getState(),
      friendState: friendState?.getStats(),
      eventPipeline: eventPipeline?.getStats(),
      uptime,
    };
    const body = JSON.stringify(status, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  // MCP endpoint probe
  if (req.method === 'GET' && req.url === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Content-Length': 0 });
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/mcp') {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', async () => {
    try {
      const rpc = JSON.parse(body);
      const sessionId = req.headers['mcp-session-id'];
      const session = getOrCreateSession(sessionId);
      log(`MCP ${rpc.method || '?'} ${body.slice(0, 60)}...`);
      await handleRpc(rpc, session, res);
    } catch (err) {
      log(`Parse error: ${err.message}`);
      sendError(res, null, 'Parse error: ' + err.message);
    }
  });
}

// ── OTP 邮箱获取 ──

async function fetchOtpFromEmail() {
  const otpScript = path.join(__dirname, 'fetch-otp.py');
  if (!existsSync(otpScript)) {
    throw new Error('fetch-otp.py 不存在');
  }
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  let cmd = `python "${otpScript}" "${creds.email}" "${authCode}"`;
  if (creds.imap_host) cmd += ` "${creds.imap_host}"`;
  const otp = execSync(cmd, { timeout: 15000, encoding: 'utf-8' }).trim();
  return otp;
}

// ── 启动 ──

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRChat 好友监控系统 v1.0');
  console.log('  Phase 1 — 基础设施');
  console.log('══════════════════════════════════════════════\n');

  serverState.started = new Date().toISOString();

  // 1. 初始化数据库
  log('📦 初始化数据库...');
  storage = new Storage();
  await storage.init(DB_PATH);
  const stats = storage.getStats();
  log(`   ✅ 数据库就绪: ${DB_PATH}`);
  log(`   📊 事件: ${stats.events} 条 | 好友: ${stats.friends} 位 | 世界缓存: ${stats.world_cache} 个`);
  _refreshWatchlistCache();  // 初始化 watchlist 内存缓存

  // 2. 初始化 API 客户端
  log('\n🔑 初始化 API 客户端...');
  if (!existsSync(CRED_FILE)) {
    console.error('\n❌ 未找到 credentials.json — 无法登录 VRChat');
    console.error('');
    console.error('   请先完成配置：');
    console.error(`   1. 复制 credentials.example.json 为 credentials.json`);
    console.error('   2. 填入 VRChat 邮箱、密码、邮箱 IMAP 授权码（imap_auth_code）');
    console.error('   3. 配置说明详见仓库根目录 AGENTS.md');
    console.error('');
    process.exit(1);
  }
  let creds;
  try {
    creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  } catch (parseErr) {
    console.error(`\n❌ credentials.json 解析失败: ${parseErr.message}`);
    console.error('   请检查文件是否为合法 JSON（参考 credentials.example.json 模板）');
    process.exit(1);
  }
  if (!creds.email || !creds.password) {
    console.error('\n❌ credentials.json 缺少 email 或 password 字段');
    console.error('   请参考 credentials.example.json 补全配置');
    process.exit(1);
  }
  api = new VrchatApiClient(creds.email, creds.password);
  api.loadCookieFromFile(COOKIE_FILE);
  try {
    const user = await api.ensureAuthWithAutoOtp(fetchOtpFromEmail);
    serverState.authUser = { id: user.id, displayName: user.displayName };
    serverState.needsOtp = false;
    log(`   ✅ 已登录: ${user.displayName} (${user.id})`);
    api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    serverState.needsOtp = false;
    log(`   ❌ 登录失败: ${err.message}`);
    // 不退出进程，让 MCP/WS 服务启动以便后续重试
  }

  // 3. 初始化限流器
  rateLimiter = new RateLimiter({ minInterval: 2600 });
  log(`\n⏱  限流器: 间隔 ${rateLimiter.minInterval}ms`);

  // 4. 初始化好友状态管理器
  friendState = new FriendStateManager();
  log(`\n👥 好友状态管理器就绪`);

  // 5. 初始化事件处理管道
  eventPipeline = new EventPipeline(storage, null);
  log(`📨 事件处理管道就绪`);

  // 6. 启动 WebSocket
  log('\n🔌 启动 WebSocket 连接...');
  wsManager = new WsManager({
    apiClient: api,
    otpFetcher: fetchOtpFromEmail,
    onEvent: async (event) => {
      try {
        await eventPipeline.process(event);
        await _updateFriendState(event);
        
        // 核心关注好友活动日志（从内存缓存读取，不查 DB）
        if (_watchlistDirty) _refreshWatchlistCache();
        const isWatched = _watchlistCache.some(w => w.user_id === event.userId);
        if (isWatched) {
          log(`⭐ [关注] ${event.displayName || event.userId}: ${event.type}`);
        }
      } catch (err) {
        log(`⚠️ 事件处理失败: ${err.message}`);
      }
    },
    onStatusChange: (status) => {
      log(`🔌 WebSocket: ${status}`);
      if (status === 'connected') {
        _refreshOnlineState(); // 连接后刷新全量状态
        // WS 重连成功但启动登录可能失败(如 OTP 错位)，此处复查认证并同步 authUser
        api.checkAuth().then((res) => {
          if (res.valid) {
            serverState.authUser = { id: res.user.id, displayName: res.displayName };
          }
        }).catch((err) => {
          log(`⚠️ 认证复查失败: ${err.message}`);
        });
      }
    },
  });
  wsManager.start();

  // 7. 启动 MCP 服务
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    log(`\n🚀 MCP 服务运行在 http://127.0.0.1:${PORT}/mcp\n`);
    log('可用工具:');
    for (const t of CUSTOM_TOOLS) {
      log(`  ${t.name} — ${t.description}`);
    }
    log(`\n健康检查: http://127.0.0.1:${PORT}/health`);
    log('\n按 Ctrl+C 停止\n');
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// ── 优雅关闭 ──
async function shutdown(signal) {
  log(`\n⚠️ 收到 ${signal}，正在关闭...`);
  try {
    if (wsManager) wsManager.stop();
    if (eventPipeline) eventPipeline.flush();
    if (storage) storage.save();
    log('✅ 已保存数据');
  } catch (e) {
    console.error('关闭时出错:', e);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('beforeExit', () => {
  if (eventPipeline) eventPipeline.flush();
  if (storage) storage.save();
});

// ── 全局异常兜底（防止僵尸进程 + 端口残留）──
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  shutdown('unhandledRejection');
});
