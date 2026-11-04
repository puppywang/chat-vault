// serve 专用的一次性同步 worker：独立线程打开 DB 跑 runSync 后退出。
// 巨型源文件（如 codex 数百 MB 的 rollout jsonl）解析时只阻塞本线程，
// 主线程继续响应 HTTP（WAL 模式下读写连接互不阻塞）。
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import { runSync } from './sync.js';

let db;
try {
  db = openDb(workerData.dbPath);
  const summary = await runSync(db, {});
  parentPort.postMessage({ ok: true, summary });
} catch (err) {
  try { parentPort.postMessage({ ok: false, error: String(err?.stack || err) }); } catch { /* */ }
} finally {
  try { db?.close(); } catch { /* */ }
}
