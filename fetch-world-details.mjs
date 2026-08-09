#!/usr/bin/env node
/**
 * 简介补查脚本（fetch-world-details.mjs）
 * 给指定世界批量补查详情接口（拿 description），供睡觉图判定
 * 用法: node fetch-world-details.mjs  < ids.txt（每行 world_id）
 * 或内嵌名单（见 SUSPECTS）
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.VRC_MONITOR_DB || path.join(__dirname, 'vrc-monitor.sqlite3');
const COOKIE_FILE = path.join(__dirname, 'auth_cookie.txt');

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

const { VrchatApiClient } = await import('./vrchat-api.js');
const creds = JSON.parse(readFileSync(path.join(__dirname, 'credentials.json'), 'utf-8'));
const api = new VrchatApiClient(creds.email, creds.password);
if (existsSync(COOKIE_FILE)) api.loadCookieFromFile(COOKIE_FILE);

async function fetchOtp() {
  const { execSync } = await import('node:child_process');
  const authCode = creds.imap_auth_code || creds.qqmail_auth_code || '';
  return execSync(`python "${path.join(__dirname, 'fetch-otp.py')}" "${creds.email}" "${authCode}"`, {
    timeout: 15000, encoding: 'utf-8',
  }).trim();
}

try {
  const user = await rateLimiter.execute(() => api.ensureAuthWithAutoOtp(fetchOtp));
  api.saveCookieToFile(COOKIE_FILE);
  console.error(`[auth] ${user.displayName}`);
} catch (e) {
  console.error('[auth] 失败:', e.message);
  process.exit(1);
}

// ── 疑似适合睡觉的世界（人工圈定：名字有安静/治愈倾向）──
const SUSPECTS = [
  "蒼褪め", "時の心臓", "永遠の光輪 - Halo of Eternity", "終わらない夏 -Endless Summer-",
  "孤", "星と、あなたと。", "After Glow", "Afterglow", "After-Hours Den",
  "Tranquil Waters Retreat", "Retreat of Haze カスミノカクレガ", "Soft Solace",
  "Fog road", "Silent Stella", "曇り-kumori", "Beyond the Stratus",
  "あさのあまおとにとける", "たゆたうしろかげ", "栖隙居所 - 叠",
  "群青コントレイル ~Blue Contrail ''Gunjo''~", "琥珀色ウェーブレット ~Amber Wavelet ''Kohaku_iro''~",
  "A Minute to Breathe", "Spacing out", "Cuddle Corner", "Early in the Morning",
  "Sunrise", "MoonLight", "Sunny Side", "湯けむりのコテージ",
  "ゆるっとキャンプ場-Virtual Camping Experience-", "路地裏の隠れ家 - Alley Hiding Spot",
  "Urban Refuge", "Coze Isle", "Palm Point", "Lunar Plants", "Hearthwood",
  "Glimmer Glade", "Foliage Nook", "The Fox Den", "The Pwuppy Den", "ごろにゃんハウス",
  "4sheep", "Stellix", "Stellarya", "Celestia", "Cosmos - コスモスに入る",
  "Interstellar", "Evermist Manor", "Heaven Sent", "Anna",
  "だらけスタートルーム ⁄ The Lazy Log-in", "Fort Duvet", "Just Moved In",
  "Stand by me", "夜", "Isolate", "ISOLATE", "Comfy Winter", "Cliffside Retreat",
  "ホームチェックv6.0", "ぷらね邸 - PLANETEI", "Toki's Villa", "Nest ネスト",
  "Floating Attic", "余忆小窝", "Pinkie Promise", "Dullish", "Aquarius",
  "The Pond", "Moody", "Blend", "Desired Hues", "Monument", "The Majesty",
  "Capsule031", "The Awaits （Render）", "Lost in your mind", "Worlds Apart",
  "N o n e .", "WORLD OF THE SOUL", "MinaSoco ~水底~", "Veggie's Coffee",
  "LUMINARIUM", "AM 3:00", "Summit Court", "Outcast", "The Abyss",
  "Outlands （Legacy）", "Cherish", "reset", "Reflex", "Polyworld （v0.163）",
  "DEFLECT", "The Black Shore - 黒の岸辺", "Mute Chat", "Hidden Heights",
  "Orange Days", "Bruhville", "Coze Isle", "Early in the Morning",
  "Squirrel Sounds （Polyworld Slice）", "Monument", "Afterglow",
  "Levée au Soleil", "Pixelwave", "Stellar sail", "Displace",
];

const db = new Database(DB_PATH, { timeout: 8000 });
const rows = db.prepare('SELECT world_id, world_name FROM new_worlds').all();
const name2id = {};
for (const r of rows) name2id[r.world_name] = r.world_id;

// 过滤：只查还没 sleep_ok 的 + 名字在嫌疑名单里的
const todo = [];
for (const name of SUSPECTS) {
  const wid = name2id[name];
  if (!wid) continue;
  const s = db.prepare('SELECT sleep_ok FROM new_worlds WHERE world_id=?').get(wid);
  if (s && s.sleep_ok === 0) todo.push({ wid, name });
}

console.error(`[todo] 需补查简介 ${todo.length} 个（约 ${Math.ceil(todo.length * 2.6 / 60)} 分钟）`);

const results = [];
for (const { wid, name } of todo) {
  try {
    const r = await rateLimiter.execute(() => api._request('GET', `/worlds/${wid}`));
    if (r.status === 200 && r.data) {
      const desc = r.data.description || '';
      // 写入库
      db.prepare('UPDATE new_worlds SET description = ? WHERE world_id = ?').run(desc, wid);
      results.push({ wid, name, desc: desc.slice(0, 200) });
    } else {
      results.push({ wid, name, desc: `[HTTP ${r.status}]` });
    }
  } catch (e) {
    results.push({ wid, name, desc: `[ERR ${e.message.slice(0, 40)}]` });
  }
  if (results.length % 10 === 0) console.error(`[progress] ${results.length}/${todo.length}`);
}

db.close();
// 输出 JSON 供后续判断
console.log(JSON.stringify(results, null, 1));
