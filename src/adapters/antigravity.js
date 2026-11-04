// Antigravity adapter
// 数据源（按优先级）：
// 1) ~/.gemini/antigravity*/conversations/*.pb —— 加密会话文件。通过本地 language-server
//    daemon 的 HTTP JSON RPC（Connect-RPC）取回解密后的完整 trajectory，并按
//    https://github.com/mjacobs/agy-reader 的 sidecar 契约缓存为同名 .trajectory.json
//    （daemon 离线时消费缓存；两个工具互通）。RPC 端点/CSRF 发现逻辑亦参考该项目。
// 2) 同目录 *.trajectory.json —— agy-reader 或本工具写入的解密缓存，直接解析。
// 3) %APPDATA%\Antigravity IDE\User\globalStorage\state.vscdb 的
//    `antigravityUnifiedStateSync.trajectorySummaries` 键 —— base64(protobuf) 会话摘要索引
//    （标题/工作区兜底；官方 bug 可能只剩部分会话），wire format 参考
//    https://github.com/ag-donald/Antigravity-Database-Manager (docs/schema.proto)。
// 4) workspaceStorage\<hash>\chatSessions\*.jsonl —— VS Code 同族格式（复用 copilot 解析）。
// 5) ~/.gemini/antigravity/conversations/*.db —— 扩展版（agy.exe，CLI 1.1.23+）的新格式：
//    明文 protobuf-in-SQLite（schema user_version=1：trajectory_meta/steps/...，
//    agy-reader COMPATIBILITY.md 已验证与 IDE 版同构）。数字 step_type 经实证映射：
//    14=用户输入(f19.f2)、15=agent 步骤(f20.f3=thinking，f20.f1/f8=回复，f20.f7=工具调用)、
//    17=错误(f24)、132=执行镜像（参数与 15 重复、结果字段加密，跳过）、101=子代理通知、
//    23=会话总结快照（跳过）。工作区在 trajectory_metadata_blob 的 f1.f1（workspace URI）
//    / f7（当前目录 URI）；标题在 annotations/<id>.pbtxt / conversation_summaries.db。
//    无需 daemon 解密，离线可导。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { listFiles, fingerprint, RETRY_LATER } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { parseSessionFile, workspaceOf } from './copilot.js';
import { parsePb, f1, iso } from './antigravity-pb.js';
import { log } from '../log.js';

function globalDb() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb') : null;
}
function wsDir() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Antigravity IDE', 'User', 'workspaceStorage') : null;
}
/** 所有可能存放 conversations/*.pb 的 gemini 根目录（旧→新排序：同 id 会话后写覆盖，新目录版本胜出） */
function conversationDirs() {
  const home = os.homedir();
  return ['.gemini/antigravity-backup', '.gemini/antigravity', '.gemini/antigravity-ide']
    .map((p) => path.join(home, p, 'conversations'))
    .filter((p) => fs.existsSync(p));
}


/** 步骤 blob（F12/F14）提取 assistant 文本与任务摘要 */
function extractStep(stepBlobBuf) {
  const texts = [];
  try {
    const wrapper = parsePb(stepBlobBuf);
    const step = f1(wrapper, 1);
    if (!step?.buf) return texts;
    const content = f1(parsePb(step.buf), 5);
    if (!content?.buf) return texts;
    for (const item of parsePb(content.buf)) {
      if (item.field === 94 && item.buf) { // AssistantResponse
        const t = f1(parsePb(item.buf), 2);
        if (t?.buf) texts.push(t.buf.toString('utf8'));
      } else if (item.field === 93 && item.buf) { // TaskBoundaryResponse
        const parts = parsePb(item.buf).filter((x) => x.buf && [2, 3, 4].includes(x.field)).map((x) => x.buf.toString('utf8'));
        if (parts.length) texts.push('[task] ' + parts.join(' | ').slice(0, 500));
      }
    }
  } catch { /* 结构异常跳过 */ }
  return texts;
}

/** 解析 trajectorySummaries 键，返回会话数组（Antigravity/Windsurf 同款 pb 格式，windsurf adapter 复用） */
export function parseSummaries(b64Value) {
  const sessions = [];
  let root;
  try { root = parsePb(Buffer.from(b64Value, 'base64')); } catch { return sessions; }
  for (const s of root.filter((f) => f.field === 1)) {
    try {
      const fields = parsePb(s.buf);
      const uuid = f1(fields, 1)?.buf?.toString();
      if (!uuid) continue;
      const wrapper = f1(fields, 2);
      const payloadB64 = wrapper?.buf ? f1(parsePb(wrapper.buf), 1)?.buf?.toString() : null;
      if (!payloadB64) continue;
      const payload = parsePb(Buffer.from(payloadB64, 'base64'));
      const title = f1(payload, 1)?.buf?.toString() || '(无标题会话)';
      const created = f1(parsePb(f1(payload, 3)?.buf || Buffer.alloc(0)), 1)?.v;
      const updated = f1(parsePb(f1(payload, 7)?.buf || Buffer.alloc(0)), 1)?.v;
      const wsUri = f1(parsePb(f1(payload, 9)?.buf || Buffer.alloc(0)), 1)?.buf?.toString();
      const texts = [];
      for (const n of [14, 12]) {
        const step = f1(payload, n);
        if (step?.buf) texts.push(...extractStep(step.buf));
      }
      sessions.push({
        agentSessionId: uuid,
        workspacePath: normalizeWorkspacePath(wsUri),
        title: title.slice(0, 120),
        createdAt: iso(created),
        updatedAt: iso(updated ?? created),
        messages: texts.filter(Boolean).map((text) => ({
          role: 'assistant', createdAt: iso(updated ?? created) ?? null, text, raw: null,
        })),
      });
    } catch { /* 单条异常跳过 */ }
  }
  return sessions;
}

/** 摘要索引 → { uuid: {title, workspacePath} }（作 trajectory 标题/工作区兜底），进程内缓存 */
let hintCache = null;
function summaryHints() {
  if (hintCache) return hintCache;
  hintCache = new Map();
  const g = globalDb();
  if (!g || !fs.existsSync(g)) return hintCache;
  const tmp = path.join(os.tmpdir(), `ae-ag-hint-${Date.now()}.vscdb`);
  try {
    fs.copyFileSync(g, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    const row = db.prepare(
      "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'"
    ).get();
    db.close();
    const value = row ? (typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('base64')) : null;
    if (!value) return hintCache;
    for (const s of parseSummaries(value)) {
      hintCache.set(s.agentSessionId.toLowerCase(), {
        title: s.title, workspacePath: s.workspacePath, createdAt: s.createdAt,
      });
    }
  } catch { /* 兜底失败即无 hint */ } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
  }
  return hintCache;
}

// CLI/extension titles are independent of the trajectory DB. Prefer the user's
// annotation, then the summary index; a title-only edit must invalidate a session
// even when its messages and workspace have not changed.
const cliTitleCache = new Map();
function fileStamp(file) {
  try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
}

function cliSummaryTitles(root) {
  const file = path.join(root, 'conversation_summaries.db');
  const stamp = `${fileStamp(file)}:${fileStamp(file + '-wal')}`;
  const cached = cliTitleCache.get(file);
  if (cached?.stamp === stamp) return cached.titles;
  const titles = new Map();
  let db;
  try {
    if (fs.existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      for (const row of db.prepare('SELECT conversation_id, title FROM conversation_summaries').all()) {
        if (typeof row.title === 'string') titles.set(String(row.conversation_id).toLowerCase(), row.title.trim());
      }
    }
  } catch { return cached?.titles || titles; } finally { db?.close(); }
  if (cliTitleCache.size >= 16) cliTitleCache.delete(cliTitleCache.keys().next().value);
  cliTitleCache.set(file, { stamp, titles });
  return titles;
}

function annotationTitle(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const match = raw.match(/(?:^|\s)title\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (!match) return null;
    // Protobuf text strings may contain UTF-8 octal/hex bytes, as well as
    // escaped quotes/backslashes. JSON.parse alone cannot decode this format.
    const chunks = [];
    const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", '?': '?' };
    for (const part of match[1].match(/\\(?:[0-7]{1,3}|x[\da-f]{2}|u[\da-f]{4}|U[\da-f]{8}|.)|[^\\]+/gis) || []) {
      if (part[0] !== '\\') chunks.push(Buffer.from(part));
      else if (/^\\[0-7]/.test(part)) chunks.push(Buffer.from([parseInt(part.slice(1), 8)]));
      else if (part[1] === 'x') chunks.push(Buffer.from([parseInt(part.slice(2), 16)]));
      else if (part[1] === 'u' || part[1] === 'U') chunks.push(Buffer.from(String.fromCodePoint(parseInt(part.slice(2), 16))));
      else if (part[1] in escapes) chunks.push(Buffer.from(escapes[part[1]]));
      else return null;
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  } catch { return null; }
}

function cliConversationTitle(file, cascadeId = path.basename(file).replace(/\.db$/i, '')) {
  const root = path.dirname(path.dirname(file));
  const annotation = /^[\w-]+$/.test(cascadeId)
    ? annotationTitle(path.join(root, 'annotations', `${cascadeId}.pbtxt`)) : null;
  // An explicit empty title clears a rename; don't resurrect the index's old value.
  return (annotation !== null ? annotation : cliSummaryTitles(root).get(String(cascadeId).toLowerCase())) || null;
}

// ---------- daemon RPC（参考 agy-reader internal/daemon + discovery） ----------
const RPC_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const RPC_TIMEOUT_MS = 30_000;
let daemonCache = null; // { baseUrl, token }：探测成功后缓存
let daemonDownAt = 0; // 上次失败时间；60s 内不重试（serve 常驻进程中 daemon 可能中途启动）
const DOWN_RETRY_MS = 60_000;

/** daemon 日志候选：旧格式单文件 + 新格式按时间戳分目录（新格式端口行在 ls-main.log） */
function daemonLogCandidates() {
  const appData = process.env.APPDATA;
  if (!appData) return [];
  const out = [];
  const legacy = path.join(appData, 'Antigravity', 'logs', 'language_server.log');
  if (fs.existsSync(legacy)) out.push(legacy);
  const newRoot = path.join(appData, 'Antigravity IDE', 'logs');
  try {
    const subs = fs.readdirSync(newRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => path.join(newRoot, d.name, 'ls-main.log'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => mtimeOf(b) - mtimeOf(a));
    out.push(...subs.slice(0, 3)); // 最新几个会话日志目录足够
  } catch { /* 目录不存在 */ }
  return out;
}

/** 从日志端口行猜 daemon 地址（未验证活性） */
function daemonFromLogs() {
  for (const logPath of daemonLogCandidates()) {
    try {
      const tail = fs.readFileSync(logPath, 'utf8').slice(-8192);
      const ports = [...tail.matchAll(/listening on random port at (\d+) for HTTP/g)];
      if (ports.length) return `http://127.0.0.1:${ports.at(-1)[1]}`;
    } catch { /* 单个日志不可读继续 */ }
  }
  return null;
}

/** 从旧版 main.log 提取 --csrf_token（仅当旧版 IDE 仍在运行时有效；新版日志不记录） */
function csrfFromLegacyLog() {
  const appData = process.env.APPDATA;
  if (!appData) return '';
  try {
    const data = fs.readFileSync(path.join(appData, 'Antigravity', 'logs', 'main.log'), 'utf8');
    const toks = [...data.matchAll(/--csrf_token[= ]([^\s"']+)/g)];
    return toks.length ? toks.at(-1)[1] : '';
  } catch { return ''; }
}

/** 进程扫描：命令行里的 --csrf_token 最可靠；netstat 端口按 PID 配对（未验证活性） */
async function daemonFromProcesses() {
  const found = []; // { baseUrl, token }
  let procs = [];
  try {
    if (process.platform === 'win32') {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((resolve) => execFile('powershell', [
        '-NoProfile', '-Command',
        // 旧版 IDE：language_server_*.exe；新版（Antigravity VS Code 扩展/CLI）：agy.exe --hub --hub-port=N --csrf_token=…，同一套 RPC
        "Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%' OR Name = 'agy.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ], { timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout)));
      const list = out ? JSON.parse(out) : [];
      for (const p of Array.isArray(list) ? list : [list]) {
        if (p?.ProcessId && p?.CommandLine) procs.push({ pid: p.ProcessId, cmd: p.CommandLine });
      }
    } else {
      const { execFile } = await import('node:child_process');
      const out = await new Promise((resolve) => execFile('ps', ['-eo', 'pid,args'], { timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout)));
      for (const line of String(out).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*(?:language_server\S*|\bagy\b.*--hub).*)/);
        if (m) procs.push({ pid: m[1], cmd: m[2] });
      }
    }
  } catch { /* 进程扫描失败返回空 */ }
  if (!procs.length) return found;

  // 监听端口按 PID 分组
  const portsByPid = new Map();
  try {
    const { execFile } = await import('node:child_process');
    const cmd = process.platform === 'win32' ? ['netstat', '-ano'] : ['netstat', '-tlnp'];
    const out = await new Promise((resolve) => execFile(cmd[0], cmd.slice(1), { timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout)));
    for (const line of String(out).split('\n')) {
      const m = line.match(/TCP\s+\S+?:(\d+)\s+\S+\s+LISTEN\w*\s+(\d+)/);
      if (m) {
        if (!portsByPid.has(m[2])) portsByPid.set(m[2], []);
        portsByPid.get(m[2]).push(m[1]);
      }
    }
  } catch { /* 无端口信息 */ }

  for (const p of procs) {
    const tok = (p.cmd.match(/--csrf_token[= ]([^\s"']+)/) || [])[1] || '';
    // agy --hub 直接在命令行给出 HTTP 端口（另一个监听端口是 HTTPS），先试它
    const hub = (p.cmd.match(/--hub-port[= ](\d+)/) || [])[1];
    if (hub) found.push({ baseUrl: `http://127.0.0.1:${hub}`, token: tok });
    for (const port of portsByPid.get(String(p.pid)) || []) {
      if (port === hub) continue;
      found.push({ baseUrl: `http://127.0.0.1:${port}`, token: tok });
    }
  }
  return found;
}

/** 探测地址是否为 daemon 的 HTTP RPC 端口：无效 method 返回 404（HTTPS 端口会协议失败）。
 *  注意 404 不验证 CSRF（校验在路由之后），token 错误由正式调用 403 时的换候选重试兜住。 */
async function probeDaemon(d) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const headers = { 'Content-Type': 'application/json' };
    if (d.token) headers['x-codeium-csrf-token'] = d.token;
    const res = await fetch(d.baseUrl + RPC_PREFIX + '__probe__', {
      method: 'POST', headers, body: '{}', signal: ctl.signal,
    });
    clearTimeout(timer);
    return res.status === 200 || res.status === 404;
  } catch { return false; }
}

/** 综合 env/日志/进程发现 daemon，探测通过后缓存 */
async function discoverDaemon() {
  if (daemonCache) return daemonCache;
  if (process.env.ANTIGRAVITY_DAEMON_URL) {
    daemonCache = { baseUrl: process.env.ANTIGRAVITY_DAEMON_URL, token: process.env.ANTIGRAVITY_CSRF_TOKEN || '' };
    return daemonCache;
  }
  const candidates = [];
  const fromLog = daemonFromLogs();
  // 日志候选不带 token：日志端口与 token 可能来自不同版本的 daemon（错配会 403），
  // 无 CSRF 的 CLI daemon 直接可用；IDE daemon 由进程扫描候选提供正确 token
  if (fromLog) candidates.push({ baseUrl: fromLog, token: '' });
  candidates.push(...(await daemonFromProcesses()));
  for (const d of candidates) {
    if (await probeDaemon(d)) {
      daemonCache = d;
      return d;
    }
  }
  return null;
}

async function rpcCall(method, body) {
  const d = await discoverDaemon();
  if (!d) {
    const err = new Error('daemon 未发现（Antigravity 未运行？）');
    err.noDaemon = true;
    throw err;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (d.token) headers['x-codeium-csrf-token'] = d.token;
    const res = await fetch(d.baseUrl + RPC_PREFIX + method, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal,
    });
    if (res.status === 403) {
      // token 与 daemon 不匹配：作废当前候选，换下一个（不同 daemon 进程 token 不同）
      daemonCache = null;
      const err = new Error('daemon 403（CSRF token 不匹配）');
      err.badToken = true;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`daemon HTTP ${res.status}`);
      err.http = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e instanceof TypeError || e?.name === 'AbortError') {
      // fetch 网络层失败（连接拒绝/DNS/超时）：标记供 fetchTrajectory 全局降级
      e.network = true;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 两步取回解密 trajectory；daemon 离线/会话不存在返回 null */
export async function fetchTrajectory(cascadeId, _retried = false) {
  if (daemonDownAt && Date.now() - daemonDownAt < DOWN_RETRY_MS) return null;
  daemonDownAt = 0;
  let resp;
  try {
    await rpcCall('LoadTrajectory', { cascadeId });
    resp = await rpcCall('GetCascadeTrajectory', { cascadeId });
  } catch (err) {
    if (err.badToken && !_retried) return fetchTrajectory(cascadeId, true); // 换候选重试一次
    if (err.noDaemon || err.network) {
      daemonCache = null; // 发现信息失效，重置
      daemonDownAt = Date.now(); // 60s 内不再逐个重试
      log.warn('antigravity', `daemon 不可达（${err.message}），跳过 .pb 回填。开着 Antigravity/agy 时重跑 sync 可回填。`);
    }
    // 其余（HTTP 4xx/5xx）：daemon 活着但该 cascadeId 不在其数据目录
    // （如 Antigravity 的 daemon 遇到 windsurf-next 会话）——仅本次失败，静默跳过
    return null;
  }
  const traj = resp?.trajectory;
  return traj && typeof traj === 'object' ? traj : null;
}

// ---------- 扩展版（agy.exe）conversations/*.db：protobuf-in-SQLite ----------
// 字段编号经实证映射（2026-09，agy CLI 1.1.23 schema user_version=1），预览期可能变动——
// 解析按防御式编写：任何一层取不到字段就跳过该步，不让单个 payload 破坏整个会话。
/** packed repeated varint（protobuf wire type 2 里连续的 varint） */
function packedVarints(buf) {
  const out = [];
  let value = 0, shift = 0;
  for (const byte of buf || []) {
    value += (byte & 0x7f) * 2 ** shift;
    if (byte & 0x80) { shift += 7; continue; }
    out.push(value); value = 0; shift = 0;
  }
  return out;
}

/**
 * 每次模型调用（gen_metadata 一行）覆盖的步骤 → 实际响应模型名。
 * data: f2 = 步骤下标（packed varint，对应 JSON 的 generatorMetadata.stepIndices），
 *       f1 = chatModel：f1.f19 = 实际响应模型（如 gemini-3.8-flash-exp-a，灰度名也在这里），
 *       f1.f20 里的 model_enum 只是 MODEL_PLACEHOLDER_Mxxx 内部编号，不用。2026-10-12 实测。
 */
function stepModelsFromDb(db, P) {
  const byStep = new Map();
  let rows = [];
  try { rows = db.prepare('SELECT data FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx').all(); } catch { return byStep; }
  for (const r of rows) {
    const top = P(Buffer.from(r.data));
    const chat = top.find((f) => f.field === 1);
    const model = chat ? P(chat.buf).find((f) => f.field === 19)?.buf?.toString('utf8') : null;
    if (!model || !/^[\w.:/-]{2,80}$/.test(model)) continue;
    for (const f of top.filter((x) => x.field === 2)) {
      for (const idx of f.buf ? packedVarints(f.buf) : [f.v]) if (Number.isInteger(idx)) byStep.set(idx, model);
    }
  }
  return byStep;
}

function parseTrajectoryDb(filePath) {
  let db;
  try { db = new DatabaseSync(filePath, { readOnly: true }); } catch { return null; } // 被agy.exe占用则下轮重试
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (!tables.has('trajectory_meta') || !tables.has('steps')) return null;
    const meta = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 1').get();
    const cascadeId = meta?.cascade_id || path.basename(filePath).replace(/\.db$/i, '');
    const rows = db.prepare('SELECT idx, step_type, step_payload FROM steps WHERE step_payload IS NOT NULL ORDER BY idx').all();
    const P = (buf) => { try { return parsePb(buf); } catch { return []; } };
    const textOf = (f) => (f?.buf ? f.buf.toString('utf8') : '');
    const modelByStep = tables.has('gen_metadata') ? stepModelsFromDb(db, P) : new Map();

    const messages = [];
    // New CLI tool calls omit Cwd entirely. The opened workspace is persisted
    // separately, including in conversations without any tool calls. Prefer it
    // over incidental command directories (e.g. temp folders or another repo).
    let workspacePath = null;
    if (tables.has('trajectory_metadata_blob')) {
      const blob = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get()?.data;
      const fields = blob ? P(Buffer.from(blob)) : [];
      const candidates = fields.filter(f => f.field === 1 && f.buf)
        .map(f => textOf(f1(P(f.buf), 1)));
      candidates.push(textOf(f1(fields, 7)));
      for (const candidate of candidates) {
        try { workspacePath = normalizeWorkspacePath(candidate); } catch { /* malformed URI; try fallback */ }
        if (workspacePath) break;
      }
    }
    let firstTs = null;
    let lastTs = null;
    for (const r of rows) {
      const before = messages.length;
      const top = P(Buffer.from(r.step_payload));
      // 步骤时间：envelope(f5).f1 = { f1: 秒, f2: 纳秒部分 }
      let ts = null;
      const env = top.find((f) => f.field === 5);
      if (env) {
        const t = P(env.buf).find((f) => f.field === 1);
        const sec = t ? P(t.buf).find((x) => x.field === 1)?.v : null;
        if (sec) ts = new Date(sec * 1000).toISOString();
      }
      if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }

      switch (r.step_type) {
        case 14: { // 用户输入：f19.f2 原文（f19.f3.f1 为渲染版，同文）
          const f19 = top.find((f) => f.field === 19);
          if (!f19) break;
          const inner = P(f19.buf);
          let text = textOf(inner.find((f) => f.field === 2));
          if (!text) {
            const f3 = inner.find((f) => f.field === 3);
            text = f3 ? textOf(P(f3.buf).find((x) => x.field === 1)) : '';
          }
          text = text.trim();
          if (!text) break; // 空文本 = 附件/审批类输入
          messages.push({ role: 'user', createdAt: ts, text: clip(text) });
          break;
        }
        case 15: { // agent 步骤：f20.f3=thinking，f20.f1（兜底 f8）=回复，f20.f7=工具调用
          const f20 = top.find((f) => f.field === 20);
          if (!f20) break;
          const inner = P(f20.buf);
          const thinking = textOf(inner.find((f) => f.field === 3));
          if (thinking.trim()) messages.push({ role: 'thinking', createdAt: ts, text: clip(thinking) });
          const reply = textOf(inner.find((f) => f.field === 1)) || textOf(inner.find((f) => f.field === 8));
          if (reply.trim()) messages.push({ role: 'assistant', createdAt: ts, text: clip(reply) });
          const f7 = inner.find((f) => f.field === 7);
          if (f7) {
            const call = P(f7.buf);
            const name = textOf(call.find((f) => f.field === 2)) || 'tool';
            const args = textOf(call.find((f) => f.field === 3));
            if (!workspacePath) {
              try { workspacePath = normalizeWorkspacePath(JSON.parse(args)?.Cwd); } catch { /* 非 JSON 参数 */ }
            }
            messages.push({ role: 'tool', createdAt: ts, text: `🔧 ${name}\n${clip(prettyJson(args), 10_000)}`, raw: null });
          }
          break;
        }
        case 17: { // 错误：f24.f1 摘要 / f24.f3 详情
          const f24 = top.find((f) => f.field === 24);
          if (!f24) break;
          const inner = P(f24.buf);
          const msg = (textOf(inner.find((f) => f.field === 1)) || textOf(inner.find((f) => f.field === 3))).trim();
          if (!msg) break;
          messages.push({ role: 'tool', createdAt: ts, text: `❌ ${clip(msg)}` });
          break;
        }
        default:
          break; // 132=执行镜像（参数与 15 重复、结果加密）、101=子代理通知、23=总结快照：跳过
      }
      const model = modelByStep.get(Number(r.idx));
      if (model) for (let i = before; i < messages.length; i++) if (messages[i].role !== 'user') messages[i].model = model;
    }
    if (!messages.length) return null;
    const firstUser = messages.find((m) => m.role === 'user');
    return {
      agentSessionId: cascadeId,
      workspacePath: workspacePath ? normalizeWorkspacePath(workspacePath) : null,
      title: cliConversationTitle(filePath, cascadeId)
        || (firstUser ? firstUser.text.split('\n')[0] : '(无标题会话)').slice(0, 80),
      createdAt: firstTs,
      updatedAt: lastTs,
      messages,
    };
  } finally {
    db.close();
  }
}

// ---------- sidecar（agy-reader 契约：<uuid>.trajectory.json，.pb 旁边） ----------
export function sidecarFor(pbPath) {
  return pbPath.replace(/\.pb$/i, '.trajectory.json');
}
export function writeSidecar(scPath, traj) {
  const dir = path.dirname(scPath);
  const tmp = path.join(dir, `.trajectory-${process.pid}-${Date.now()}.json.tmp`);
  const data = JSON.stringify(traj) + '\n';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, scPath);
}

// ---------- trajectory steps → messages ----------
/** ISO 纳秒时间戳（2026-01-01T00:00:01.000000000Z）截断为 JS 可解析的毫秒精度 */
function isoFix(s) {
  if (typeof s !== 'string' || !s) return null;
  try {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch { /* 继续兜底 */ }
  try { return new Date(s.slice(0, 23) + 'Z').toISOString(); } catch { return null; }
}

const MAX_TOOL_TEXT = 50_000;
function clip(s, n = MAX_TOOL_TEXT) {
  if (typeof s !== 'string' || s.length <= n) return s || '';
  return s.slice(0, n) + `\n…（截断，共 ${s.length} 字符）`;
}
function prettyJson(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
/** daemon 的输出字段可能是字符串或 {stdout,stderr} 对象 */
function outputText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const parts = [];
    for (const k of ['stdout', 'stderr', 'output', 'text', 'full']) {
      if (typeof v[k] === 'string' && v[k]) parts.push(v[k]);
    }
    if (parts.length) return parts.join('\n');
    try { return JSON.stringify(v, null, 2); } catch { return ''; }
  }
  return String(v);
}
/** codeAction.actionResult → ```diff 块（agy-reader FormattedDiff 同逻辑） */
function diffText(actionResult) {
  const lines = actionResult?.edit?.diff?.unifiedDiff?.lines;
  if (!Array.isArray(lines) || !lines.length) return '';
  const out = ['```diff'];
  for (const l of lines) {
    const t = l.type || '';
    out.push((t.endsWith('INSERT') ? '+' : t.endsWith('DELETE') ? '-' : ' ') + (l.text || ''));
  }
  out.push('```');
  return out.join('\n');
}

/** generatorMetadata[].stepIndices → chatModel.responseModel（每步 metadata 里只有 MODEL_PLACEHOLDER_Mxx 编号） */
function stepModelsFromJson(traj) {
  const byStep = new Map();
  for (const g of Array.isArray(traj?.generatorMetadata) ? traj.generatorMetadata : []) {
    const model = g?.chatModel?.responseModel;
    if (typeof model !== 'string' || !model || /^MODEL_/.test(model)) continue;
    for (const idx of Array.isArray(g.stepIndices) ? g.stepIndices : []) if (Number.isInteger(idx)) byStep.set(idx, model);
  }
  return byStep;
}

function stepsToMessages(steps, modelByStep = new Map()) {
  const msgs = [];
  for (const [index, st] of (steps || []).entries()) {
    const at = isoFix(st?.metadata?.createdAt);
    const model = modelByStep.get(index) || null;
    const push = (role, text) => {
      if (text && text.trim()) msgs.push({ role, createdAt: at, text, raw: null, ...(model && role !== 'user' ? { model } : {}) });
    };
    switch (st.type) {
      case 'CORTEX_STEP_TYPE_USER_INPUT': {
        push('user', st.userInput?.userResponse);
        break;
      }
      case 'CORTEX_STEP_TYPE_PLANNER_RESPONSE': {
        const pr = st.plannerResponse || {};
        push('thinking', pr.thinking);
        push('assistant', pr.response);
        if (Array.isArray(pr.toolCalls) && pr.toolCalls.length) {
          const lines = pr.toolCalls.map((tc) =>
            `🔧 ${tc.name || '(tool)'}\n${clip(prettyJson(tc.argumentsJson || ''), 10_000)}`);
          push('tool', lines.join('\n\n'));
        }
        break;
      }
      case 'CORTEX_STEP_TYPE_RUN_COMMAND': {
        const rc = st.runCommand || {};
        let text = `$ ${rc.commandLine || rc.proposedCommandLine || ''}`;
        if (rc.cwd) text += `\n(cwd: ${rc.cwd})`;
        const out = outputText(rc.combinedOutput);
        if (out) text += `\n${clip(out)}`;
        if (typeof rc.exitCode === 'number') text += `\n(exit code ${rc.exitCode})`;
        push('tool', text);
        break;
      }
      case 'CORTEX_STEP_TYPE_VIEW_FILE': {
        const vf = st.viewFile || {};
        const loc = vf.startLine ? `:${vf.startLine}${vf.endLine ? `-${vf.endLine}` : ''}` : '';
        push('tool', `📖 ${vf.absolutePathUri || ''}${loc}（${vf.numLines ?? '?'} 行）\n${clip(vf.content || '', 4000)}`);
        break;
      }
      case 'CORTEX_STEP_TYPE_CODE_ACTION': {
        const ca = st.codeAction || {};
        let text = `✏️ ${ca.description || 'code action'}`;
        const file = ca.actionSpec?.command?.file;
        const rel = file && Object.values(file.workspaceUrisToRelativePaths || {})[0];
        if (rel || file?.absoluteUri) text += `\n文件: ${rel || file.absoluteUri}`;
        const d = diffText(ca.actionResult);
        if (d) text += `\n${clip(d, 20_000)}`;
        push('tool', text);
        break;
      }
      case 'CORTEX_STEP_TYPE_GREP_SEARCH': {
        const gs = st.grepSearch || {};
        push('tool', `🔎 grep ${gs.caseInsensitive ? '-i ' : ''}"${gs.query || ''}" ${gs.searchPathUri || ''}\n${clip(outputText(gs.matchPerLine))}`);
        break;
      }
      case 'CORTEX_STEP_TYPE_LIST_DIRECTORY': {
        const ld = st.listDirectory || {};
        push('tool', `📁 ${ld.directoryPathUri || ''}\n${clip(outputText(ld.results))}`);
        break;
      }
      case 'CORTEX_STEP_TYPE_ERROR_MESSAGE': {
        const e = st.errorMessage?.error?.userErrorMessage || st.errorMessage?.error?.modelErrorMessage;
        push('tool', `❌ ${e || 'error'}`);
        break;
      }
      case 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE': {
        push('system', `ℹ️ ${st.systemMessage?.message || ''}${st.systemMessage?.eventType ? ` (${st.systemMessage.eventType})` : ''}`);
        break;
      }
      default:
        break; // checkpoint/invoke_subagent 等不渲染为消息
    }
  }
  return msgs;
}

/** 解密 trajectory → 单会话对象 */
export function trajectoryToSession(traj) {
  const cascadeId = traj.cascadeId || traj.trajectoryId;
  if (!cascadeId) return null;
  const hints = summaryHints();
  const hint = hints.get(String(cascadeId).toLowerCase()) || {};
  const steps = Array.isArray(traj.steps) ? traj.steps : [];
  const messages = stepsToMessages(steps, stepModelsFromJson(traj));

  // 标题：官方摘要 > checkpoint 意图（取首行）> 首条用户消息
  let title = hint.title;
  if (!title) {
    const cps = steps.filter((s) => s.checkpoint?.userIntent || s.checkpoint?.sessionSummary).map((s) => s.checkpoint);
    title = cps.at(-1)?.userIntent || cps.at(-1)?.sessionSummary;
  }
  if (!title) title = messages.find((m) => m.role === 'user')?.text?.split('\n')[0];
  title = String(title || '(无标题会话)').split('\n')[0].slice(0, 120);

  // 工作区：摘要索引 > 命令 cwd > 文件 URI 目录推断
  let workspacePath = hint.workspacePath || null;
  if (!workspacePath) {
    const cwd = steps.map((s) => s.runCommand?.cwd).find(Boolean);
    if (cwd) workspacePath = normalizeWorkspacePath(cwd);
  }
  if (!workspacePath) {
    const uri = steps.map((s) => s.viewFile?.absolutePathUri
      || s.codeAction?.actionSpec?.command?.file?.absoluteUri
      || s.grepSearch?.searchPathUri).find(Boolean);
    if (uri) {
      const p = normalizeWorkspacePath(uri);
      workspacePath = p ? path.dirname(p) : null;
    }
  }

  const times = messages.map((m) => m.createdAt).filter(Boolean);
  const created = isoFix(traj.metadata?.createdAt) || hint.createdAt || times[0] || null;
  const updated = times.at(-1) || created;
  return {
    agentSessionId: cascadeId,
    workspacePath,
    title,
    createdAt: created,
    updatedAt: updated,
    messages: messages.length ? messages : [{ role: 'assistant', createdAt: created, text: title, raw: null }],
  };
}

export const antigravityAdapter = {
  id: 'antigravity',

  watchRoots() {
    const roots = [];
    const g = globalDb();
    if (g && fs.existsSync(path.dirname(g))) roots.push(path.dirname(g));
    const w = wsDir();
    if (w && fs.existsSync(w)) roots.push(w);
    // Include the sibling summary DB and annotations directory so renames wake
    // the watcher without needing a new message in conversations/.
    for (const d of conversationDirs()) roots.push(path.dirname(d));
    return roots;
  },

  discover() {
    const sources = [];
    const g = globalDb();
    if (g && fs.existsSync(g)) sources.push({ path: g, ...statOf(g) });
    const w = wsDir();
    if (w) for (const f of listFiles(w, '.jsonl')) sources.push(f);
    for (const dir of conversationDirs()) {
      for (const f of listFiles(dir, '.pb')) sources.push(f);
      for (const f of listFiles(dir, '.trajectory.json')) sources.push(f);
      for (const f of listFiles(dir, '.db')) sources.push(f); // 扩展版（agy.exe）trajectory 库
    }
    return sources;
  },

  fingerprint(file) {
    if (!/\.db$/i.test(file.path)) return fingerprint(file);
    // Version this parser fix so unchanged historical DBs are backfilled once.
    // WAL-only appends also need to invalidate the fingerprint before checkpoint.
    let wal = '-';
    try { const st = fs.statSync(file.path + '-wal'); if (st.size) wal = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* no WAL */ }
    return `ag-db-v3:${fingerprint(file)}:${wal}:${JSON.stringify(cliConversationTitle(file.path))}`;
  },

  async parseFile(filePath) {
    if (/\.db$/i.test(filePath)) return parseTrajectoryDb(filePath);
    if (filePath.endsWith('.jsonl')) {
      const parsed = await parseSessionFile(filePath);
      if (!parsed) return null;
      if (!parsed.workspacePath) parsed.workspacePath = workspaceOf(filePath, parsed);
      return parsed;
    }
    if (/\.trajectory\.json$/i.test(filePath)) {
      // 已解密 sidecar（agy-reader 或本工具写入）
      let traj;
      try { traj = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
      return trajectoryToSession(traj);
    }
    if (/\.pb$/i.test(filePath)) {
      const sc = sidecarFor(filePath);
      const pbMtime = mtimeOf(filePath);
      if (fs.existsSync(sc) && mtimeOf(sc) >= pbMtime) return null; // sidecar 新鲜，由其自投
      let traj = await fetchTrajectory(path.basename(filePath, '.pb'));
      if (traj) {
        try { writeSidecar(sc, traj); } catch { /* 缓存写失败不影响本轮回填 */ }
      } else if (fs.existsSync(sc)) {
        // daemon 离线但有旧 sidecar：先用旧数据（下次 daemon 在线时由 sidecar 刷新链路补新）
        try { traj = JSON.parse(fs.readFileSync(sc, 'utf8')); } catch { traj = null; }
      }
      if (!traj) return RETRY_LATER; // 完全无数据：下轮重试
      return trajectoryToSession(traj);
    }
    // globalStorage/state.vscdb：读摘要索引（多会话数组）
    const tmp = path.join(os.tmpdir(), `ae-ag-${Date.now()}.vscdb`);
    fs.copyFileSync(filePath, tmp);
    try {
      const db = new DatabaseSync(tmp, { readOnly: true });
      const row = db.prepare(
        "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.trajectorySummaries'"
      ).get();
      db.close();
      const value = row ? (typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('base64')) : null;
      return value ? parseSummaries(value) : [];
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
    }
  },
};

function statOf(p) {
  const st = fs.statSync(p);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}
export function mtimeOf(p) {
  try { return Math.round(fs.statSync(p).mtimeMs); } catch { return 0; }
}
