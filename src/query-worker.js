// 常驻查询 worker：在独立线程执行 query.js 的同步查询函数。
// 宽泛搜索（热词/数字前缀在数十万消息上）可能耗时数十秒，
// 放 worker 里跑保证主线程 HTTP 始终响应（WAL 模式下读连接互不阻塞）。
//
// 协议：主线程 post {id, fn, args} → 本线程回 {id, ok, result|error}。
// 常驻复用（连接与页缓存不冷启动），单请求超时由主线程控制（terminate 整个线程）。
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import * as query from './query.js';
import { toolExec } from './mcp-tools.js';

const db = openDb(workerData.dbPath);

parentPort.on('message', ({ id, fn: fnName, args }) => {
  try {
    // MCP 工具执行（HTTP 传输的 tools/call）：与其他查询共用本线程池，避免阻塞主线程
    if (fnName === 'mcpCall') {
      const result = toolExec(db, args.name, args.args || {});
      return parentPort.postMessage({ id, ok: true, result });
    }
    const fn = query[fnName];
    if (typeof fn !== 'function') throw new Error(`未知查询函数: ${fnName}`);
    // args 为数组时展开为多参（如 getSessionDetail(id, opts)），否则作为单对象参数
    const result = Array.isArray(args) ? fn(db, ...args) : fn(db, args || {});
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err?.stack || err) });
  }
});
