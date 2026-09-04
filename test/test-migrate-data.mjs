#!/usr/bin/env node
/**
 * test-migrate-data.mjs — issue #103 回归测试（无凭据、离线可跑）
 *
 * 覆盖：
 *   1. issue #103 核心回归：无 data/ 目录（父目录/多级父目录不存在）时 Storage.init 不再崩
 *      ——mkdirSync(dirname(dbPath), {recursive:true}) 在 new Database 前建目录。
 *   2. migrateLegacyData（core/migrate-legacy-data.js）行为：
 *      - 干净裸机：根无旧文件 → 不建 data/、返回 0
 *      - 全量搬移：根旧库+wal+shm+cookie+backups、data/ 空 → 全部搬入、根移走
 *      - 防覆盖：data/ 已存在同名库 → 不覆盖（保留 data/ 新数据）
 *      - 静默跳过 warn：根旧库在但 data/ 已有同名库 → 不迁移但输出 warn 提示（防「假丢失」）
 *      - 幂等：重复执行第二次不重复搬、根无残留
 *      - 仅 wal 异常态（无主库文件）：仍搬 wal
 *      - 失败兜底：目标为目录（rename 报错）→ warn 不抛、不阻断
 *
 * 用法：node test-migrate-data.mjs   （退出码 0 = 全部通过）
 */
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { migrateLegacyData } = await import(
  pathToFileURL(path.join(__dirname, '..', 'core', 'migrate-legacy-data.js')).href
);
const { Storage } = await import(
  pathToFileURL(path.join(__dirname, '..', 'core', 'storage.js')).href
);

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ FAIL: ${name}`); }
}

function sandbox() {
  const root = path.join(os.tmpdir(), `vrmon-migrate-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return { root, data: path.join(root, 'data') };
}
function w(p, s = '') { writeFileSync(p, s); }
function mkdb(root, ext) { w(path.join(root, 'vrc-monitor.sqlite3' + ext)); }

// ── 1. issue #103 核心：无 data/ 目录时 Storage.init 不崩 ──
console.log('── 1. Storage.init：父目录不存在时不崩 ──');
{
  // 多级父目录都不存在，验证 mkdirSync recursive 全建
  const dbPath = path.join(os.tmpdir(), `vrmon-no-data-${Math.random().toString(36).slice(2)}`, 'data', 'vrc-monitor.sqlite3');
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  let threw = false, db;
  try {
    const s = new Storage();
    await s.init(dbPath);
    db = s.db;
  } catch (e) { threw = true; console.log('  init 抛错:', e.message); }
  ok('无 data/ 目录 init 不抛错', !threw);
  ok('创建了父目录 data/', existsSync(path.dirname(dbPath)));
  ok('数据库文件已创建且可打开', !!db && existsSync(dbPath));
  // 打开后能查（说明库就绪）
  let qOk = false;
  try { if (db) { db.prepare('SELECT 1 AS x').get(); qOk = true; } } catch {}
  ok('init 后库可查询', qOk);
  // 清理（含 WAL/SHM）
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
  try { rmSync(path.dirname(path.dirname(dbPath)), { recursive: true, force: true }); } catch {}
}

// ── 2. migrateLegacyData ──
console.log('── 2. migrateLegacyData ──');

// 2.1 干净裸机：根无旧文件 → 不建 data/、返回 0
{
  const { root, data } = sandbox();
  const n = migrateLegacyData(root, data);
  ok('2.1 无旧文件不建 data/', !existsSync(data));
  ok('2.1 返回 0', n === 0);
  rmSync(root, { recursive: true, force: true });
}

// 2.2 全量搬移：根旧库+wal+shm+cookie+backups、data/ 空 → 全搬入、根移走
{
  const { root, data } = sandbox();
  mkdb(root, ''); mkdb(root, '-wal'); mkdb(root, '-shm');
  w(path.join(root, 'auth_cookie.txt'), 'cookie');
  mkdirSync(path.join(root, 'backups')); w(path.join(root, 'backups', 'b.sqlite3'), 'x');
  const n = migrateLegacyData(root, data);
  ok('2.2 主库搬入', existsSync(path.join(data, 'vrc-monitor.sqlite3')));
  ok('2.2 wal 搬入', existsSync(path.join(data, 'vrc-monitor.sqlite3-wal')));
  ok('2.2 shm 搬入', existsSync(path.join(data, 'vrc-monitor.sqlite3-shm')));
  ok('2.2 cookie 搬入', existsSync(path.join(data, 'auth_cookie.txt')));
  ok('2.2 backups 搬入', existsSync(path.join(data, 'backups')));
  ok('2.2 根主库移走', !existsSync(path.join(root, 'vrc-monitor.sqlite3')));
  ok('2.2 根 cookie 移走', !existsSync(path.join(root, 'auth_cookie.txt')));
  ok('2.2 根 backups 移走', !existsSync(path.join(root, 'backups')));
  ok('2.2 返回 5（5 项：库+wal+shm+cookie+backups）', n === 5);
  rmSync(root, { recursive: true, force: true });
}

// 2.3 防覆盖：data/ 已存在同名库 → 保留 data/ 新数据
{
  const { root, data } = sandbox();
  mkdirSync(data, { recursive: true });
  w(path.join(data, 'vrc-monitor.sqlite3'), 'NEWDB');
  mkdb(root, ''); // 根也有旧库
  migrateLegacyData(root, data);
  ok('2.3 不覆盖 data/ 库', readFileSync(path.join(data, 'vrc-monitor.sqlite3'), 'utf8') === 'NEWDB');
  ok('2.3 根旧库未搬（防止覆盖）', existsSync(path.join(root, 'vrc-monitor.sqlite3')));
  rmSync(root, { recursive: true, force: true });
}

// 2.4 静默跳过 warn：根旧库在但 data/ 已有同名库（用户手动 workaround 过）→ warn 提示
{
  const { root, data } = sandbox();
  mkdirSync(data, { recursive: true });
  w(path.join(data, 'vrc-monitor.sqlite3'), 'EMPTY_NEW');
  mkdb(root, '');
  const logs = [];
  const origWarn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try { migrateLegacyData(root, data); } finally { console.warn = origWarn; }
  const warnHit = logs.some(l => l.includes('[migrate]') && l.includes('跳过迁移'));
  ok('2.4 根旧库未被迁移', existsSync(path.join(root, 'vrc-monitor.sqlite3')));
  ok('2.4 data/ 新库未被覆盖', readFileSync(path.join(data, 'vrc-monitor.sqlite3'), 'utf8') === 'EMPTY_NEW');
  ok('2.4 输出 warn（防「假丢失」不可察觉）', warnHit);
  if (!warnHit) console.log('   logs=', JSON.stringify(logs));
  rmSync(root, { recursive: true, force: true });
}

// 2.5 幂等：重复执行第二次不重复搬、根无残留
{
  const { root, data } = sandbox();
  mkdb(root, '');
  migrateLegacyData(root, data);
  migrateLegacyData(root, data); // 第二次
  ok('2.5 二次迁移根无残留', !existsSync(path.join(root, 'vrc-monitor.sqlite3')));
  ok('2.5 data 库仍在', existsSync(path.join(data, 'vrc-monitor.sqlite3')));
  rmSync(root, { recursive: true, force: true });
}

// 2.6 仅 wal 异常态（无主库文件）→ 仍搬 wal
{
  const { root, data } = sandbox();
  mkdb(root, '-wal');
  migrateLegacyData(root, data);
  ok('2.6 仅 wal 搬入', existsSync(path.join(data, 'vrc-monitor.sqlite3-wal')));
  ok('2.6 根 wal 移走', !existsSync(path.join(root, 'vrc-monitor.sqlite3-wal')));
  rmSync(root, { recursive: true, force: true });
}

// 2.7 失败兜底：目标为目录（rename 报错）→ warn、不抛、不阻断
{
  const { root, data } = sandbox();
  mkdirSync(data, { recursive: true });
  mkdirSync(path.join(data, 'vrc-monitor.sqlite3')); // 目标同名目录
  mkdb(root, '');
  let threw = false;
  try { migrateLegacyData(root, data); } catch (e) { threw = true; }
  ok('2.7 搬移失败不抛异常', !threw);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nRESULT: ${passed} PASS / ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
