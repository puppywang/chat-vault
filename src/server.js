// 本地 HTTP 服务：JSON API + 静态 UI
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { imagesDir } from './imagestore.js';
import { listSessions, listWorkspaces, stats, findRetryCorpses, listFlagged, AGENTS, getSessionLinks, getChain, getSessionRefTree, listChains } from './query.js';
import { extractSessionLinks, addManualLink, removeLink } from './links.js';
import { runAgent } from './agent.js';
import { log, logDir } from './log.js';
import { readConfig, writeConfig, CONFIG_PATH } from './config.js';
import { llmConfig, llmPing } from './llm.js';
import {
  TOOLS as MCP_TOOLS,
  PROTOCOL_VERSIONS as MCP_PROTOCOL_VERSIONS, FALLBACK_VERSION as MCP_FALLBACK_VERSION,
  SERVER_NAME as MCP_SERVER_NAME, SERVER_TITLE as MCP_SERVER_TITLE, VERSION as MCP_VERSION,
} from './mcp-tools.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(UI_DIR, '..', 'package.json'), 'utf8')).version; } catch { return ''; }
})();
const DATA_DIR = path.join(os.homedir(), '.chat-vault');
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 作息图聚合需按消息时间全量分组（即使有覆盖索引也需数百毫秒），
// 内存缓存同一过滤条件的结果；同步或隐藏/恢复会话后失效，10 分钟兜底过期
// （兜底覆盖"另一进程跑 agent-exporter sync"的极端情况）
const TL_CACHE_TTL = 10 * 60 * 1000;
const tlCache = new Map();
export function invalidateTimelineCache() { tlCache.clear(); }

// workspace_id 参数支持逗号分隔多选：?workspace_id=3,17,42
const wsIdsOf = (raw) => (raw || '').split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0);

function sendJson(res, code, data, req = null) {
  const body = JSON.stringify(data);
  // 大响应（大会话详情可达数 MB）gzip 传输；异步压缩避免数百 ms 阻塞事件循环
  if (body.length > 100_000 && req && /gzip/.test(req.headers['accept-encoding'] || '')) {
    zlib.gzip(body, (err, gz) => {
      if (err) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(body);
      }
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    });
    return;
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 会话详情响应：按 updated_at 做 ETag，未变化直接 304（浏览场景同一会话反复打开）。
 *  ETag 含分页窗口（offset/limit），不同窗口互不干扰 */
function sendDetailJson(res, detail, req, win = '') {
  if (!detail) return sendJson(res, 404, { error: 'not found' });
  const etag = `"${detail.session.id}-${detail.messages.length}-${detail.session.updated_at || ''}${win}"`;
  if (req && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  const body = JSON.stringify(detail);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ETag: etag };
  if (body.length > 100_000 && req && /gzip/.test(req.headers['accept-encoding'] || '')) {
    zlib.gzip(body, (err, gz) => {
      if (err) {
        res.writeHead(200, headers);
        return res.end(body);
      }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
      res.end(gz);
    });
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}

function sendFile(res, filePath, req = null) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    // no-cache + ETag(304)：静态资源每次协商，改版后浏览器必定拿到新文件
    let etag = '';
    try { etag = `"${buf.length}-${Math.round(fs.statSync(filePath).mtimeMs)}"`; } catch { /* */ }
    const headers = {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'ETag': etag,
    };
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers); res.end(); return;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

// 本地文件预览。文本类走 /api/file（JSON 返回内容）；图片/PDF/媒体走 /api/raw（流式字节）。
// 均只允许已知工作区内的文件。
const MAX_TEXT_SIZE = 2 * 1024 * 1024;
const MAX_RAW_SIZE = 100 * 1024 * 1024;

const FILE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
};

/** 工作区白名单校验，通过返回 resolve 后的路径 */
function resolveInWorkspace(db, raw) {
  const filePath = path.resolve(raw || '');
  const lower = filePath.toLowerCase();
  const ok = db.prepare('SELECT path FROM workspaces').all().some(
    (r) => lower === r.path.toLowerCase() || lower.startsWith(r.path.toLowerCase() + path.sep)
  );
  return ok ? filePath : null;
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = FILE_MIME[ext];
  if (mime) {
    const kind = mime.startsWith('image/') ? 'image'
      : mime === 'application/pdf' ? 'pdf'
      : mime.startsWith('video/') ? 'video' : 'audio';
    return { kind, mime };
  }
  if (ext === '.md' || ext === '.markdown') return { kind: 'markdown', mime: 'text/markdown' };
  return { kind: 'text', mime: 'text/plain' };
}

function handleFilePreview(db, url, res) {
  const filePath = resolveInWorkspace(db, url.searchParams.get('path'));
  if (!filePath) return sendJson(res, 403, { error: '路径不在已知工作区内' });
  let st;
  try { st = fs.statSync(filePath); } catch {
    return sendJson(res, 404, { error: '文件不存在' });
  }
  if (!st.isFile()) return sendJson(res, 404, { error: '不是文件' });
  const { kind, mime } = classify(filePath);
  if (kind !== 'text' && kind !== 'markdown') {
    // 非文本只返回元信息，字节由 /api/raw 流式提供
    if (st.size > MAX_RAW_SIZE) return sendJson(res, 413, { error: '文件超过 100MB' });
    return sendJson(res, 200, { path: filePath, kind, mime, size: st.size });
  }
  if (st.size > MAX_TEXT_SIZE) return sendJson(res, 413, { error: '文本文件超过 2MB，请在编辑器中打开' });
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0)) return sendJson(res, 415, { error: '二进制文件' });
  sendJson(res, 200, { path: filePath, kind, mime, content: buf.toString('utf8') });
}

function handleRawFile(db, url, res) {
  const filePath = resolveInWorkspace(db, url.searchParams.get('path'));
  if (!filePath) return sendJson(res, 403, { error: '路径不在已知工作区内' });
  let st;
  try { st = fs.statSync(filePath); } catch {
    return sendJson(res, 404, { error: '文件不存在' });
  }
  if (!st.isFile() || st.size > MAX_RAW_SIZE) return sendJson(res, 404, { error: '不可预览' });
  const { mime } = classify(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Cache-Control': 'private, max-age=60',
  });
  fs.createReadStream(filePath).pipe(res);
}

// 对话内图片（我们自己落盘的，限制在 images 目录内）
function handleImage(url, res) {
  const raw = url.searchParams.get('file') || '';
  const base = imagesDir();
  const filePath = path.resolve(base, raw);
  if (!filePath.toLowerCase().startsWith(base.toLowerCase() + path.sep)) {
    return sendJson(res, 403, { error: 'invalid path' });
  }
  let st;
  try { st = fs.statSync(filePath); } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
  const mime = FILE_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- 设置页：配置读写（apiKey 只回显尾 4 位，不回传明文） ----------

function llmKeyInfo() {
  const cfgKey = readConfig().llm.apiKey || '';
  const resolved = llmConfig().apiKey; // env > config > API_KEY.txt
  if (process.env.AE_LLM_API_KEY) return { set: true, source: 'env', tail: '…' + resolved.slice(-4) };
  if (cfgKey) return { set: true, source: 'config', tail: '…' + cfgKey.slice(-4) };
  if (resolved) return { set: true, source: 'API_KEY.txt', tail: '…' + resolved.slice(-4) };
  return { set: false, source: '', tail: '' };
}

function configPayload(db, dbPath, boundLan, port) {
  const cfg = readConfig();
  let dbSize = null;
  try { dbSize = fs.statSync(dbPath).size; } catch { /* --db 未落盘等 */ }
  return {
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, apiKey: llmKeyInfo() },
    logLevel: log.currentLevel(),
    lan: cfg.lan,
    disabledAgents: cfg.disabledAgents,
    autoHideRetryCorpses: cfg.autoHideRetryCorpses,
    lanRestartPending: cfg.lan !== boundLan, // 配置与当前监听不一致 → 待重启
    status: {
      version: VERSION,
      dataDir: DATA_DIR,
      configPath: CONFIG_PATH,
      dbPath,
      dbSize: dbSize == null ? '-' : fmtBytes(dbSize),
      logDir,
      host: boundLan ? '0.0.0.0（局域网可访问）' : '127.0.0.1（仅本机）',
      port,
      pid: process.pid,
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function startServer(db, { port = 8377, dbPath = '' } = {}) {
  const startLan = readConfig().lan;
  let boundLan = startLan; // 当前实际监听模式（配置改动后需重启才变化）

  // 常驻查询线程池：搜索 / 会话详情 / 作息图等重查询全部放独立线程，
  // 主线程事件循环只做轻查询与 IO 调度（WAL 模式下多读连接互不阻塞）。
  // 池大小 2：一个被慢查询占住时另一个仍可服务；请求排队 FIFO。
  const WORKER_TIMEOUT_MS = 30000;
  const queryPool = (() => {
    const N = 2;
    const workers = [];
    const waiters = []; // 排队中的 {resolve}
    let reqSeq = 0;
    const makeWorker = () => {
      const w = new Worker(new URL('./query-worker.js', import.meta.url), { workerData: { dbPath } });
      const state = { w, busy: false, timer: null };
      w.on('message', (m) => {
        clearTimeout(state.timer);
        state.busy = false;
        state.pending?.(m); // 归还结果
        state.pending = null;
        drain();
      });
      w.on('error', (err) => {
        log.error('http', '查询线程异常', err);
        state.pending?.({ ok: false, error: String(err?.stack || err) });
        state.pending = null;
        state.busy = false;
        drain();
      });
      workers.push(state);
      return state;
    };
    const drain = () => {
      for (const st of workers) {
        if (st.busy) continue;
        const next = waiters.shift();
        if (!next) break;
        st.busy = true;
        st.pending = next.resolve;
        st.timer = setTimeout(() => {
          // 超时：终止整个线程重建（同步 sqlite 无法中断单条语句）
          try { st.w.terminate(); } catch { /* */ }
          st.pending?.({ ok: false, error: '查询超时：范围过宽，试试更具体的词或"引号"连续短语' });
          st.pending = null;
          st.w.removeAllListeners();
          makeWorker(); // 替换死掉的线程
          drain();
        }, WORKER_TIMEOUT_MS);
        st.w.postMessage({ id: ++reqSeq, fn: next.fn, args: next.args });
      }
    };
    for (let i = 0; i < N; i++) makeWorker();
    return (fn, args) => new Promise((resolve) => {
      waiters.push({ fn, args, resolve });
      drain();
    });
  })();
  // 兼容旧调用名
  const searchInWorker = (args) => queryPool('searchMessages', args);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(UI_DIR, 'index.html'), req);

      // MCP Streamable HTTP 传输：所有 MCP 客户端共用本进程（不再各 spawn 一个 stdio 进程）。
      // 无状态：不维护 Mcp-Session-Id；tools/call 走 queryPool worker，与 web 查询共用线程池。
      if (p === '/mcp') {
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, Authorization',
          'Access-Control-Max-Age': '86400',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders); return res.end(); }
        if (req.method === 'GET') {
          // 客户端连通性探测（部分 MCP 客户端先 GET）；宽容返回 serverInfo
          return sendJson(res, 200, {
            jsonrpc: '2.0',
            result: {
              protocolVersion: MCP_FALLBACK_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_VERSION },
            },
          });
        }
        if (req.method !== 'POST') { res.writeHead(405, corsHeaders); return res.end('Method Not Allowed'); }
        const msg = await readBody(req);
        const handleMcp = async (m) => {
          if (!m || typeof m !== 'object') return { error: { code: -32600, message: 'Invalid Request' } };
          const isRequest = m.id !== undefined && m.id !== null;
          switch (m.method) {
            case 'initialize': {
              const want = m.params?.protocolVersion;
              return isRequest ? { result: {
                protocolVersion: MCP_PROTOCOL_VERSIONS.includes(want) ? want : MCP_FALLBACK_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_VERSION },
              } } : null;
            }
            case 'ping':
              return isRequest ? { result: {} } : null;
            case 'tools/list':
              return isRequest ? { result: { tools: MCP_TOOLS } } : null;
            case 'resources/list':
            case 'resources/templates/list':
              return isRequest ? { result: { resources: [], resourceTemplates: [] } } : null;
            case 'tools/call': {
              const name = m.params?.name;
              try {
                const r = await queryPool('mcpCall', { name, args: m.params?.arguments || {} });
                if (!r.ok) throw new Error(r.error);
                if (r.result === undefined) return { error: { code: -32602, message: `未知工具: ${name}` } };
                return { result: { content: [{ type: 'text', text: JSON.stringify(r.result) }], isError: false } };
              } catch (err) {
                return { result: { content: [{ type: 'text', text: `工具执行失败: ${err?.message || err}` }], isError: true } };
              }
            }
            case 'notifications/initialized':
            case 'initialized':
            case 'notifications/cancelled':
            case 'notifications/progress':
              return null; // 通知：不回复
            default:
              return isRequest ? { error: { code: -32601, message: `方法不存在: ${m.method}` } } : null;
          }
        };
        const out = await handleMcp(msg);
        if (!out) { res.writeHead(202, corsHeaders); return res.end(); }
        const body = JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, ...out });
        res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        return res.end(body);
      }

      // AI 助手：SSE 流式返回工具过程与最终回答（连接断开即中止 agent）
      if (p === '/api/ask' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 空体 */ }
        if (!body.question || !String(body.question).trim()) {
          return sendJson(res, 400, { error: '缺少 question' });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.on('close', onClose);
        // 归档本次问答：即使中断/出错也保留问题与已完成的检索步骤，避免对话丢失
        const steps = [];
        let answer = '', status = 'done';
        const askT0 = Date.now();
        const qBrief = String(body.question).replace(/\s+/g, ' ').slice(0, 80);
        log.info('ai', `提问: ${qBrief}`);
        try {
          for await (const ev of runAgent(db, { question: body.question, history: body.history || [], signal: abort.signal })) {
            if (ev.type === 'tool') steps.push(ev.brief || '');
            else if (ev.type === 'answer') answer = ev.content || '';
            else if (ev.type === 'error') { status = 'error'; answer = `⚠️ ${ev.message}`; }
            else if (ev.type === 'aborted') status = 'aborted';
            send(ev);
          }
        } catch (err) {
          status = 'error';
          answer = `⚠️ ${err.message}`;
          log.error('ai', `问答异常`, err);
          try { send({ type: 'error', message: err.message }); } catch { /* 连接已断 */ }
        }
        log.info('ai', `完成: ${status} · ${steps.length} 次工具调用 · ${((Date.now() - askT0) / 1000).toFixed(1)}s`);
        try {
          db.prepare('INSERT INTO ai_chats(created_at, question, answer, steps, status) VALUES(?,?,?,?,?)')
            .run(new Date().toISOString(), String(body.question), answer || '', JSON.stringify(steps), status);
        } catch { /* 归档失败不影响回答 */ }
        res.off('close', onClose);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // AI 助手历史：最近的问答归档（刷新/重开后恢复抽屉内容）
      if (p === '/api/ai/history' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
        const rows = db.prepare('SELECT id, created_at, question, answer, steps, status FROM ai_chats ORDER BY id DESC LIMIT ?').all(limit);
        for (const r of rows) {
          try { r.steps = JSON.parse(r.steps || '[]'); } catch { r.steps = []; }
        }
        return sendJson(res, 200, { chats: rows.reverse() });
      }

      // 消息标记：以 session_id + seq 定位（seq 是会话内序号，重同步后仍有效）
      if (p === '/api/message/flag' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        const { session_id: sid, seq, kind, value } = body;
        if (!Number.isInteger(sid) || !Number.isInteger(seq)) {
          return sendJson(res, 400, { error: '缺少 session_id / seq' });
        }
        if (!['todo', 'star'].includes(kind) || typeof value !== 'boolean') {
          return sendJson(res, 400, { error: "kind 须为 'todo'|'star'，value 须为 boolean" });
        }
        const s = db.prepare('SELECT agent, agent_session_id FROM sessions WHERE id = ?').get(sid);
        if (!s) return sendJson(res, 404, { error: '会话不存在' });
        const exists = db.prepare('SELECT 1 FROM messages WHERE session_id = ? AND seq = ?').get(sid, seq);
        if (!exists) return sendJson(res, 404, { error: '消息不存在' });
        db.prepare(`INSERT INTO message_flags(agent, agent_session_id, seq, ${kind}, created_at)
                    VALUES (?, ?, ?, 1, ?)
                    ON CONFLICT(agent, agent_session_id, seq) DO UPDATE SET ${kind}=excluded.${kind}`)
          .run(s.agent, s.agent_session_id, seq, new Date().toISOString());
        if (!value) {
          // 取消：清零该标记；两种都为 0 时删除行
          db.prepare(`UPDATE message_flags SET ${kind}=0 WHERE agent=? AND agent_session_id=? AND seq=?`)
            .run(s.agent, s.agent_session_id, seq);
          db.prepare('DELETE FROM message_flags WHERE agent=? AND agent_session_id=? AND seq=? AND todo=0 AND star=0')
            .run(s.agent, s.agent_session_id, seq);
        }
        return sendJson(res, 200, { ok: true, kind, value });
      }

      // 标记的消息列表（flag = todo | star）
      if (p === '/api/flagged') {
        const q = url.searchParams;
        const flag = q.get('flag') || 'todo';
        if (!['todo', 'star'].includes(flag)) return sendJson(res, 400, { error: 'flag 参数无效' });
        return sendJson(res, 200, { flag, messages: listFlagged(db, { flag }) });
      }

      if (p === '/api/sessions') {
        const q = url.searchParams;
        const rows = listSessions(db, {
          agent: q.get('agent') || null,
          workspaceIds: wsIdsOf(q.get('workspace_id')),
          limit: Math.min(Number(q.get('limit')) || 100, 2000),
          offset: Number(q.get('offset')) || 0,
        });
        return sendJson(res, 200, { sessions: rows });
      }

      // 消息骨架（无正文）：scrubber / 会话内搜索 / 断点计算用，最大会话也只几 KB
      const outlineMatch = p.match(/^\/api\/sessions\/(\d+)\/outline$/);
      if (outlineMatch) {
        const r = await queryPool('getSessionOutline', Number(outlineMatch[1]));
        if (!r.ok) return sendJson(res, 500, { error: r.error });
        return sendJson(res, 200, { outline: r.result });
      }

      // 用户发言清单（含单行摘要）：会话详情的用户消息导航栏用
      const userTurnsMatch = p.match(/^\/api\/sessions\/(\d+)\/user-turns$/);
      if (userTurnsMatch) {
        const r = await queryPool('getSessionUserTurns', Number(userTurnsMatch[1]));
        if (!r.ok) return sendJson(res, 500, { error: r.error });
        return sendJson(res, 200, { turns: r.result });
      }

      const detailMatch = p.match(/^\/api\/sessions\/(\d+)$/);
      if (detailMatch) {
        // 大会话（最大 4.9 万条消息）查询+序列化数百 ms：放 worker 线程，主线程保持响应。
        // ?offset/limit 分页：UI 首屏只取前 N 条，滚动到尾部再增量拉取
        const q = url.searchParams;
        const offset = Math.max(Number(q.get('offset')) || 0, 0);
        const limit = Math.min(Math.max(Number(q.get('limit')) || 0, 0), 5000);
        const r = await queryPool('getSessionDetail', [Number(detailMatch[1]), { offset, limit }]);
        if (!r.ok) {
          log.error('http', `会话详情失败: ${r.error}`);
          return sendJson(res, 500, { error: r.error });
        }
        return sendDetailJson(res, r.result, req, limit > 0 ? `-${offset}-${limit}` : '');
      }

      // 隐藏的会话列表（设置页管理用；常规列表/搜索/作息图均不含隐藏会话）
      if (p === '/api/sessions/hidden') {
        return sendJson(res, 200, { sessions: listSessions(db, { hiddenOnly: true, limit: 500 }) });
      }
      // 隐藏 / 恢复会话（测试对话等；隐藏仅改标记位，重同步不会恢复）
      if (p === '/api/session/hide' && req.method === 'POST') {
        const body = await readBody(req);
        if (!Number.isInteger(body.session_id) || typeof body.hidden !== 'boolean') {
          return sendJson(res, 400, { error: '缺少 session_id / hidden' });
        }
        const r = db.prepare('UPDATE sessions SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, body.session_id);
        if (!r.changes) return sendJson(res, 404, { error: '会话不存在' });
        invalidateTimelineCache();
        log.info('hide', `会话 #${body.session_id} ${body.hidden ? '已隐藏' : '已恢复显示'}`);
        return sendJson(res, 200, { ok: true, hidden: body.hidden });
      }

      // ==================== 会话链 ====================
      // 某会话的直接引用关系（双向）
      const linksMatch = p.match(/^\/api\/sessions\/(\d+)\/links$/);
      if (linksMatch) {
        return sendJson(res, 200, getSessionLinks(db, Number(linksMatch[1])));
      }
      // 整条链（弱连通分量）
      const chainMatch = p.match(/^\/api\/chain\/(\d+)$/);
      if (chainMatch) {
        return sendJson(res, 200, getChain(db, Number(chainMatch[1])));
      }
      // 消息级引用树（当前会话 → 引用的会话 → 再引用，带消息 seq）
      const refTreeMatch = p.match(/^\/api\/sessions\/(\d+)\/ref-tree$/);
      if (refTreeMatch) {
        const q = url.searchParams;
        const direction = q.get('direction') === 'upstream' ? 'upstream' : 'downstream';
        return sendJson(res, 200, getSessionRefTree(db, Number(refTreeMatch[1]), {
          maxDepth: Math.min(Math.max(Number(q.get('depth')) || 3, 1), 6),
          direction,
        }));
      }
      // 所有链列表（按最近更新倒序）
      if (p === '/api/chains') {
        const q = url.searchParams;
        return sendJson(res, 200, {
          chains: listChains(db, {
            limit: Math.min(Number(q.get('limit')) || 100, 2000),
            agent: q.get('agent') || null,
          }),
        });
      }
      // 手动关联（纠错 / 补链）
      if (p === '/api/session/link' && req.method === 'POST') {
        const body = await readBody(req);
        const from = Number(body.from), to = Number(body.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          return sendJson(res, 400, { error: '缺少 from / to' });
        }
        const r = addManualLink(db, from, to, body.note || null);
        if (r.error) return sendJson(res, 400, { error: r.error });
        log.info('link', `手动关联 #${from} → #${to}`);
        return sendJson(res, 200, { ok: true });
      }
      // 手动删链
      if (p === '/api/session/unlink' && req.method === 'POST') {
        const body = await readBody(req);
        const from = Number(body.from), to = Number(body.to);
        if (!Number.isInteger(from) || !Number.isInteger(to)) {
          return sendJson(res, 400, { error: '缺少 from / to' });
        }
        const r = removeLink(db, from, to);
        if (r.error) return sendJson(res, 404, { error: r.error });
        log.info('link', `手动删链 #${from} → #${to}`);
        return sendJson(res, 200, { ok: true });
      }
      // 手动触发全量重新提取（重建后补历史链）
      if (p === '/api/links/re-extract' && req.method === 'POST') {
        const r = extractSessionLinks(db, { full: true });
        return sendJson(res, 200, r);
      }

      // 重试残骸会话：全部用户消息都是"请继续"类重试词（如 429 自动重试脚本反复新建会话的空壳）
      if (p === '/api/cleanup/retry-corpses' && req.method === 'GET') {
        const r = await queryPool('findRetryCorpses');
        if (!r.ok) {
          log.error('http', `残骸检测失败: ${r.error}`);
          return sendJson(res, 500, { error: r.error });
        }
        return sendJson(res, 200, { sessions: r.result });
      }
      if (p === '/api/cleanup/retry-corpses' && req.method === 'POST') {
        const corpses = findRetryCorpses(db);
        const upd = db.prepare('UPDATE sessions SET hidden = 1 WHERE id = ?');
        for (const c of corpses) upd.run(c.id);
        if (corpses.length) {
          invalidateTimelineCache();
          log.info('hide', `已隐藏 ${corpses.length} 个重试残骸会话`);
        }
        return sendJson(res, 200, { hidden: corpses.length });
      }

      if (p === '/api/search') {
        const q = url.searchParams;
        const r = await searchInWorker({
          q: q.get('q') || '',
          agent: q.get('agent') || null,
          workspaceIds: wsIdsOf(q.get('workspace_id')),
          limit: Math.min(Number(q.get('limit')) || 20, 100),
          sort: q.get('sort') || 'hit',
        });
        if (!r.ok) {
          log.error('http', `搜索失败: ${r.error}`);
          return sendJson(res, 504, { error: r.error });
        }
        return sendJson(res, 200, { results: r.result });
      }

      if (p === '/api/workspaces') return sendJson(res, 200, { workspaces: listWorkspaces(db) });
      if (p === '/api/timeline-stats') {
        const agent = url.searchParams.get('agent') || null;
        const workspaceIds = wsIdsOf(url.searchParams.get('workspace_id'));
        const key = `${agent || ''}|${workspaceIds.join(',')}`;
        let hit = tlCache.get(key);
        if (!hit || Date.now() - hit.at > TL_CACHE_TTL) {
          // 全量消息按天×小时分组（75 万行，~500ms）：放 worker 线程避免阻塞
          const r = await queryPool('timelineStats', { agent, workspaceIds });
          if (!r.ok) {
            log.error('http', `作息图聚合失败: ${r.error}`);
            return sendJson(res, 500, { error: r.error });
          }
          hit = { at: Date.now(), data: r.result };
          tlCache.set(key, hit);
        }
        return sendJson(res, 200, hit.data);
      }
      if (p === '/api/file') return handleFilePreview(db, url, res);
      if (p === '/api/raw') return handleRawFile(db, url, res);
      if (p === '/api/image') return handleImage(url, res);
      if (p === '/api/stats') return sendJson(res, 200, { ...stats(db), agents: AGENTS });
      if (p === '/api/agents') return sendJson(res, 200, { agents: AGENTS });

      if (p === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, configPayload(db, dbPath, boundLan, port));
      }
      if (p === '/api/config' && (req.method === 'PUT' || req.method === 'POST')) {
        const body = await readBody(req);
        const changed = Object.keys(body).filter((k) => ['llm', 'logLevel', 'lan', 'disabledAgents', 'autoHideRetryCorpses'].includes(k));
        if (!changed.length) return sendJson(res, 400, { error: '无可识别的配置字段' });
        let cfg;
        try {
          cfg = writeConfig(body);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        if (body.logLevel !== undefined) log.setLevel(cfg.logLevel); // 级别立即生效
        if (body.disabledAgents !== undefined) {
          log.info('config', `同步范围更新: ${cfg.disabledAgents.length ? '停用 ' + cfg.disabledAgents.join(', ') : '全部启用'}`);
        }
        log.info('config', `配置更新: ${changed.join(', ')}`);
        return sendJson(res, 200, { ok: true, restartRequired: body.lan !== undefined && cfg.lan !== boundLan, config: configPayload(db, dbPath, boundLan, port) });
      }
      if (p === '/api/config/test-llm' && req.method === 'POST') {
        const body = await readBody(req);
        const r = await llmPing({ baseUrl: body.baseUrl || '', model: body.model || '', apiKey: body.apiKey || '' });
        log.info('config', `测试连接: ${r.ok ? `ok ${r.model} ${r.latencyMs}ms` : '失败 ' + r.error.slice(0, 120)}`);
        return sendJson(res, 200, r);
      }

      if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown api' });

      // 静态资源
      const safe = path.normalize(p).replace(/^([/\\])+/, '');
      const fp = path.join(UI_DIR, safe);
      if (fp.startsWith(UI_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp, req);
      return sendFile(res, path.join(UI_DIR, 'index.html'), req);
    } catch (err) {
      log.error('http', `${req.method} ${p} 处理失败`, err);
      sendJson(res, 500, { error: err.message });
    }
  });

  const host = startLan ? '0.0.0.0' : '127.0.0.1';
  server.listen(port, host, () => {
    log.info('http', `Web UI 就绪: http://localhost:${port}（${startLan ? '0.0.0.0，局域网可访问' : '127.0.0.1，仅本机'}；设置页可改）`);
    console.log(`ChatVault Web UI: http://localhost:${port}  (Ctrl+C 停止)`);
  });
  return server;
}
