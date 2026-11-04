// Agent runtime control plane.  This module is deliberately transport-agnostic:
// it persists a run before starting a child process, streams normalized events,
// and never writes to an agent's source/archive directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AGENTS } from './db.js';

const ALLOWED_AGENTS = new Set(['claude-code', 'codex', 'copilot']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
// These are transport-level choices, not a claim that every model supports
// every value.  A connector can therefore refuse an invalid flag before it
// launches a child process.  Model-specific fallback remains the CLI's job.
const AGENT_EFFORTS = Object.freeze({
  codex: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  copilot: ['low', 'medium', 'high', 'xhigh', 'max'],
});
const USER_INPUT_TYPES = new Set(['text', 'image', 'localImage', 'audio', 'localAudio']);
const MAX_INPUT_BYTES = 48 * 1024 * 1024;
// Browser uploads are base64 encoded before they reach this module.  Keeping
// the raw media total below 35 MiB leaves room for that expansion inside the
// 48 MiB serialized-input limit and the HTTP request limit.
const MAX_TOTAL_MEDIA_BYTES = 35 * 1024 * 1024;
const CODEX_MODEL_CACHE_MS = 5 * 60 * 1000;
let codexModelCache = { expiresAt: 0, value: null, pending: null };
// Deliberately list the types we can hand to a connector instead of accepting
// arbitrary image/* or audio/* browser MIME types.  The browser picker is
// only a convenience; create() remains the enforcement point for API users.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/heic', 'image/heif']);
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/aac', 'audio/flac']);
const IMAGE_EXTENSIONS = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif' });
const AUDIO_EXTENSIONS = Object.freeze({ '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.aac': 'audio/aac', '.flac': 'audio/flac' });
const RUNTIME_INPUT_DIR = path.join(os.homedir(), '.chat-vault', 'runtime-inputs');
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function commandCandidates(command) {
  if (!command) return null;
  if (path.isAbsolute(command)) return [command];
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return [];
    return String(r.stdout || '').split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  } catch { return []; }
}

function executableCommand(command) {
  for (const candidate of commandCandidates(command)) {
    try {
      const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: 'ignore' });
      if (r.status === 0) return candidate;
    } catch { /* try the next PATH candidate */ }
  }
  return null;
}

function findCodex() {
  if (process.env.CHATVAULT_CODEX_BIN) return executableCommand(process.env.CHATVAULT_CODEX_BIN);
  const codex = executableCommand('codex');
  if (codex) return codex;
  if (process.platform === 'win32') {
    const base = path.join(os.homedir(), '.vscode', 'extensions');
    try {
      const dirs = fs.readdirSync(base).filter((x) => x.startsWith('openai.chatgpt-')).sort().reverse();
      for (const d of dirs) {
        const p = path.join(base, d, 'bin', 'windows-x86_64', 'codex.exe');
        if (executableCommand(p)) return p;
      }
    } catch { /* extension not installed */ }
  }
  return null;
}

export function detectConnectors() {
  const claude = executableCommand(process.env.CHATVAULT_CLAUDE_BIN || 'claude');
  const copilot = executableCommand(process.env.CHATVAULT_COPILOT_BIN || 'copilot');
  const codex = findCodex();
  return {
    'claude-code': { available: !!claude, transport: 'cli', command: claude },
    codex: { available: !!codex, transport: 'app-server', command: codex },
    copilot: { available: !!copilot, transport: 'cli', command: copilot },
  };
}

class JsonRpcProcess extends EventEmitter {
  constructor(command, args, opts = {}) {
    super();
    this.child = spawn(command, args, { cwd: opts.cwd || process.cwd(), env: { ...process.env, ...(opts.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.consume(d));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => this.emit('stderr', d));
    this.child.on('error', (e) => this.fail(e));
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal });
      this.fail(new Error(`connector exited (${code ?? signal ?? 'unknown'})`));
    });
  }
  consume(data) {
    this.buf += data;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { this.emit('line', line); continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(String(msg.id)); if (!p) continue;
        this.pending.delete(String(msg.id));
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else this.emit('message', msg);
    }
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, timeout = 30000) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`${method} timeout`)); }, timeout);
      this.pending.set(String(id), { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send(msg);
    });
  }
  send(msg) { if (!this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  fail(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }
  kill() { try { this.child.kill(); } catch { /* */ } }
}

function normalizeCodexModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = typeof raw.model === 'string' && raw.model.trim()
    ? raw.model.trim()
    : (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null);
  if (!model) return null;
  const supportedReasoningEfforts = (Array.isArray(raw.supportedReasoningEfforts) ? raw.supportedReasoningEfforts : [])
    .map((effort) => typeof effort === 'string'
      ? { reasoningEffort: effort }
      : { reasoningEffort: effort?.reasoningEffort, description: effort?.description })
    .filter((effort) => typeof effort.reasoningEffort === 'string' && effort.reasoningEffort.trim())
    .map((effort) => ({
      reasoningEffort: effort.reasoningEffort.trim(),
      ...(typeof effort.description === 'string' && effort.description.trim() ? { description: effort.description.trim() } : {}),
    }));
  return {
    id: typeof raw.id === 'string' ? raw.id : model,
    model,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : model,
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
    isDefault: raw.isDefault === true,
    ...(typeof raw.defaultReasoningEffort === 'string' && raw.defaultReasoningEffort.trim() ? { defaultReasoningEffort: raw.defaultReasoningEffort.trim() } : {}),
    supportedReasoningEfforts,
    inputModalities: (Array.isArray(raw.inputModalities) ? raw.inputModalities : []).filter((x) => typeof x === 'string'),
  };
}

// This is deliberately a separate, short-lived app-server connection.  It
// performs only initialize + model/list, never opens, resumes, or forks a
// Codex thread.  The result is installation/account specific, so callers must
// not treat it as a hard-coded product catalog.
async function listCodexModels({ refresh = false } = {}) {
  const cached = codexModelCache.value;
  if (!refresh && cached && codexModelCache.expiresAt > Date.now()) return cached;
  if (codexModelCache.pending) return codexModelCache.pending;
  const bin = findCodex();
  if (!bin) throw new Error('Codex app-server not found; install Codex or set CHATVAULT_CODEX_BIN');
  const pending = (async () => {
    const rpc = new JsonRpcProcess(bin, ['app-server']);
    try {
      await rpc.request('initialize', { clientInfo: { name: 'chat-vault', title: 'ChatVault', version: '0.4.1' }, capabilities: {} }, 15_000);
      rpc.notify('initialized', {});
      const models = [];
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const result = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 15_000);
        for (const raw of Array.isArray(result?.data) ? result.data : []) {
          const model = normalizeCodexModel(raw);
          if (model && raw.hidden !== true) models.push(model);
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
        if (!cursor) break;
      }
      const seen = new Set();
      const value = {
        models: models.filter((model) => !seen.has(model.model) && seen.add(model.model)),
        fetchedAt: now(),
      };
      codexModelCache = { expiresAt: Date.now() + CODEX_MODEL_CACHE_MS, value, pending: null };
      return value;
    } finally {
      rpc.kill();
    }
  })();
  codexModelCache = { ...codexModelCache, pending };
  try {
    return await pending;
  } finally {
    if (codexModelCache.pending === pending) codexModelCache = { ...codexModelCache, pending: null };
  }
}

function normalizeCodexMessage(msg) {
  const method = msg.method || '';
  const p = msg.params || {};
  if (/delta/i.test(method) && typeof p.delta === 'string') return { type: 'delta', text: p.delta, raw: msg };
  if (/agentMessage|assistantMessage/i.test(method)) {
    const text = p.text || p.message?.content || p.item?.text || p.item?.content;
    if (typeof text === 'string') return { type: 'message', text, raw: msg };
  }
  if (/approval/i.test(method) || /requestUserInput/i.test(method)) return { type: 'approval_request', kind: method, requestId: msg.id, payload: p, raw: msg };
  if (/turn\/started/i.test(method)) return { type: 'started', turnId: p.turn?.id || p.turnId || p.id, raw: msg };
  if (/turn\/completed|turn\/failed/i.test(method)) {
    const status = p.turn?.status || (/failed/i.test(method) ? 'failed' : 'completed');
    if (status !== 'completed') return { type: 'error', message: p.turn?.error?.message || `Codex turn ${status}`, raw: msg };
    return { type: 'completed', status, raw: msg };
  }
  if (/error/i.test(method)) return { type: 'error', message: p.message || p.error?.message || p.error || 'Codex error', raw: msg };
  return { type: 'notification', method, payload: p, raw: msg };
}

function parseCliLine(agent, line) {
  let obj; try { obj = JSON.parse(line); } catch { return { type: 'delta', text: line }; }
  const streamDelta = obj.event?.type === 'content_block_delta' && obj.event?.delta?.type === 'text_delta'
    ? obj.event.delta.text : null;
  if (typeof streamDelta === 'string' && streamDelta) return { type: 'delta', text: streamDelta, raw: obj };
  const text = obj.delta || obj.text || obj.content || obj.message?.content || obj.result?.content;
  if (typeof text === 'string' && text) return { type: 'delta', text, raw: obj };
  if (obj.type === 'error' || obj.error || obj.is_error === true) return { type: 'error', message: obj.error?.message || obj.result || String(obj.error || 'connector error'), raw: obj };
  if (obj.type === 'result' || obj.type === 'done' || obj.finished) return { type: 'completed', status: 'completed', raw: obj };
  return { type: 'notification', payload: obj };
}

function mimeExtension(mime) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif' };
  return map[mime.toLowerCase()] || 'bin';
}

function parseDataUrl(value) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value || '');
  if (!m) throw new Error('附件必须是 base64 data URL');
  const data = m[2];
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('附件 base64 编码无效');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new Error('附件内容为空');
  if (bytes.toString('base64') !== data) throw new Error('附件 base64 编码无效');
  return { mime: m[1].toLowerCase(), data, bytes };
}

function localImageContent(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_EXTENSIONS[ext];
  if (!mime) throw new Error('不支持的本地图片格式');
  return { mime, data: fs.readFileSync(filePath).toString('base64') };
}

function dataUrlByteLength(value) {
  const comma = String(value || '').indexOf(',');
  if (comma < 0) return 0;
  const data = String(value).slice(comma + 1);
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function inputSummary(input) {
  return input.map((item) => {
    if (!item || typeof item !== 'object') return { type: 'invalid' };
    if (item.type === 'text') {
      const text = typeof item.text === 'string' ? item.text : '';
      return { type: 'text', text: text.length > 500 ? `${text.slice(0, 500)}…` : text };
    }
    if (item.url) return {
      type: item.type,
      url: item.url.startsWith('data:') ? `${item.url.slice(0, item.url.indexOf(',') + 1)}…` : item.url,
      bytes: item.url.startsWith('data:') ? (Number.isFinite(item.bytes) ? item.bytes : dataUrlByteLength(item.url)) : null,
    };
    return { type: item.type, path: item.path };
  });
}

// Preserve the user's text for audit/debugging, but replace the base64 body as
// soon as it is no longer needed by the spawned connector.  This is separate
// from inputSummary(), whose text truncation is intended only for API display.
function redactInput(input) {
  return input.map((item) => {
    if (!item || typeof item !== 'object') return { type: 'invalid' };
    if (item.type === 'text') return { type: 'text', text: typeof item.text === 'string' ? item.text : '' };
    if (item.url) return {
      type: item.type,
      url: item.url.startsWith('data:') ? `${item.url.slice(0, item.url.indexOf(',') + 1)}…` : item.url,
      bytes: item.url.startsWith('data:') ? (Number.isFinite(item.bytes) ? item.bytes : dataUrlByteLength(item.url)) : null,
    };
    return { type: item.type, path: item.path };
  });
}

function isCodexApprovalRequest(method) {
  return /requestApproval|requestUserInput/i.test(method || '') || /^(execCommandApproval|applyPatchApproval)$/i.test(method || '');
}

function isLegacyCodexApproval(method) {
  return /^(execCommandApproval|applyPatchApproval)$/i.test(method || '');
}

// Connector notifications can include the original UserInput (and therefore a
// data URL) in their raw payload.  Run events are exposed through SSE, so keep
// them useful for diagnostics without turning the event log into an attachment
// transport or leaking a large base64 payload back to the browser.
function safeEventPayload(value, key = '', depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^data:[^,]*,/i.test(value)) return `${value.slice(0, value.indexOf(',') + 1)}…`;
    if (key === 'data' && value.length > 256) return `[redacted binary data: ${value.length} characters]`;
    return value.length > 12_000 ? `${value.slice(0, 12_000)}… [truncated]` : value;
  }
  if (depth >= 8) return '[truncated nested payload]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeEventPayload(item, '', depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([k, v]) => [k, safeEventPayload(v, k, depth + 1)]));
  }
  return String(value);
}

function removeRuntimeInputDir(dir) {
  const base = path.resolve(RUNTIME_INPUT_DIR);
  const target = path.resolve(dir);
  if (!target.toLowerCase().startsWith(base.toLowerCase() + path.sep)) return;
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* cleanup never masks the run result */ }
}

export class RunManager extends EventEmitter {
  constructor(db, opts = {}) {
    super(); this.db = db; this.processes = new Map(); this.queues = new Map();
    this.allowLan = !!opts.allowLan; this.onSync = opts.onSync || null;
    // Child processes cannot survive a server restart as a usable connection.
    // Make persisted state honest instead of leaving runs permanently shown as
    // "running" or "waiting for approval" after ChatVault comes back up.
    const interrupted = this.db.prepare("SELECT id FROM runs WHERE status IN ('queued','running','waiting_approval')").all();
    for (const row of interrupted) {
      const error = 'ChatVault 服务在此运行结束前重启';
      this.db.prepare('UPDATE runs SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?').run('failed', error, now(), now(), row.id);
      this._redactRunInput(row.id);
      this._event(row.id, 'failed', { error });
    }
  }
  capabilities() {
    const connectors = detectConnectors();
    return {
      agents: Object.fromEntries([...ALLOWED_AGENTS].map((a) => [a, {
        ...connectors[a], label: AGENTS[a]?.label || a, modes: a === 'copilot' ? ['new', 'resume'] : ['new', 'resume', 'fork'], efforts: AGENT_EFFORTS[a],
      }])),
      models: [],
    };
  }
  async models(agent = 'codex', opts = {}) {
    if (agent !== 'codex') throw new Error('当前仅支持读取本机 Codex 的模型目录');
    return listCodexModels(opts);
  }
  _isKnownWorkspacePath(raw, { file = false, directory = false } = {}) {
    if (typeof raw !== 'string' || !raw.trim()) return false;
    const target = path.resolve(raw);
    const workspaces = this.db.prepare('SELECT path FROM workspaces').all();
    const allowed = workspaces.some((r) => {
      const root = path.resolve(r.path);
      return target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(root.toLowerCase() + path.sep);
    });
    if (!allowed) return false;
    if (!file && !directory) return true;
    try {
      const realTarget = fs.realpathSync(target);
      const stat = fs.statSync(realTarget);
      if (file && !stat.isFile()) return false;
      if (directory && !stat.isDirectory()) return false;
      // A lexical in-workspace symlink must neither turn the attachment API
      // into an arbitrary local-file reader nor run a connector outside an
      // indexed workspace.
      return workspaces.some((r) => {
        // Workspaces are historical sync records, so a deleted project can
        // remain in this table.  It must not make every otherwise-valid
        // workspace fail the realpath containment check.
        let realRoot;
        try { realRoot = fs.realpathSync(path.resolve(r.path)); }
        catch { return false; }
        return realTarget.toLowerCase() === realRoot.toLowerCase()
          || realTarget.toLowerCase().startsWith(realRoot.toLowerCase() + path.sep);
      });
    } catch { return false; }
  }
  _validateInput(input, agent) {
    let totalMediaBytes = 0;
    const addMediaBytes = (bytes) => {
      totalMediaBytes += bytes;
      if (totalMediaBytes > MAX_TOTAL_MEDIA_BYTES) throw new Error(`附件合计不能超过 ${MAX_TOTAL_MEDIA_BYTES / 1024 / 1024}MB`);
    };
    for (const item of input) {
      if (item.type === 'text') {
        if (typeof item.text !== 'string') throw new Error('文本 input 无效');
        if (item.text.length > 200_000) throw new Error('单条文本不能超过 200,000 字符');
        continue;
      }
      if (agent !== 'codex' && (item.type === 'audio' || item.type === 'localAudio')) {
        throw new Error(`${AGENTS[agent]?.label || agent} 当前连接器不支持音频附件；请使用 Codex 发送音频`);
      }
      if (item.type === 'image' || item.type === 'audio') {
        if (typeof item.url !== 'string') throw new Error(`${item.type} url 无效`);
        const media = parseDataUrl(item.url);
        const allowedMimes = item.type === 'image' ? IMAGE_MIMES : AUDIO_MIMES;
        if (!allowedMimes.has(media.mime)) throw new Error(`不支持的${item.type === 'image' ? '图片' : '音频'} MIME 类型：${media.mime}`);
        addMediaBytes(media.bytes.length);
      } else {
        if (typeof item.path !== 'string' || !this._isKnownWorkspacePath(item.path, { file: true })) {
          throw new Error(`${item.type} path 必须是已知工作区内的现有文件`);
        }
        const stat = fs.statSync(item.path);
        const extension = path.extname(item.path).toLowerCase();
        const allowedExtensions = item.type === 'localImage' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
        if (!allowedExtensions[extension]) throw new Error(`不支持的本地${item.type === 'localImage' ? '图片' : '音频'}格式`);
        addMediaBytes(stat.size);
      }
    }
  }
  _runtimeSession(body, source, mode) {
    const agent = body.agent || source?.agent;
    if (source?.agent && body.agent && body.agent !== source.agent) throw new Error('agent 与归档会话不匹配');
    if (!ALLOWED_AGENTS.has(agent)) throw new Error('agent must be claude-code, codex, or copilot');
    // A fork/new run gets its own runtime session; otherwise replacing the
    // stored native id would make a later Resume of the archived parent open
    // the child thread instead.
    const sessionAgentId = mode === 'resume' ? (source?.agent_session_id || body.agent_session_id || null) : null;
    const requestedCwd = body.cwd || source?.workspace_path || null;
    const workspace = requestedCwd ? path.resolve(requestedCwd) : null;
    if (!workspace) throw new Error('运行需要归档会话的工作区，或显式提供 cwd');
    if (!this._isKnownWorkspacePath(workspace, { directory: true })) throw new Error('cwd 必须是已知工作区内的现有目录');
    let row = sessionAgentId ? this.db.prepare('SELECT * FROM runtime_sessions WHERE agent=? AND agent_session_id=?').get(agent, sessionAgentId) : null;
    if (!row) {
      const t = now();
      const sid = source?.id || null;
      const r = this.db.prepare(`INSERT INTO runtime_sessions(session_id,agent,agent_session_id,workspace_path,model,connector,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,?)`).run(sid, agent, sessionAgentId, workspace, body.model || null, agent === 'codex' ? 'app-server' : 'cli', 'idle', t, t);
      row = this.db.prepare('SELECT * FROM runtime_sessions WHERE id=?').get(Number(r.lastInsertRowid));
    } else if (source?.id && !row.session_id) this.db.prepare('UPDATE runtime_sessions SET session_id=?,updated_at=? WHERE id=?').run(source.id, now(), row.id);
    return row;
  }
  create(body = {}) {
    const requestedInput = Array.isArray(body.input) ? body.input : [{ type: 'text', text: String(body.input || '') }];
    if (!requestedInput.length || requestedInput.some((x) => !x || typeof x !== 'object' || !USER_INPUT_TYPES.has(x.type))) throw new Error('input 必须是受支持的 UserInput 数组');
    const input = requestedInput.map((x) => x.type === 'text'
      ? { type: 'text', text: x.text }
      : x.type === 'image' || x.type === 'audio'
        ? { type: x.type, url: x.url }
        : { type: x.type, path: x.path });
    if (!input.some((x) => x.type !== 'text' || String(x.text || '').trim())) throw new Error('缺少 input');
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_INPUT_BYTES) throw new Error('多媒体输入总大小不能超过 48MB');
    const source = body.session_id ? this.db.prepare('SELECT s.*, w.path workspace_path FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.id=?').get(body.session_id) : null;
    if (body.session_id && !source) throw new Error('会话不存在');
    const mode = ['new', 'resume', 'fork'].includes(body.mode) ? body.mode : 'resume';
    const effort = body.effort == null ? null : String(body.effort);
    const agent = body.agent || source?.agent;
    if (!ALLOWED_AGENTS.has(agent)) throw new Error('agent must be claude-code, codex, or copilot');
    this._validateInput(input, agent);
    if (effort && agent === 'codex' && !/^[a-z][a-z0-9_-]{0,31}$/i.test(effort)) {
      throw new Error('Codex 的 effort 必须是简短的字母数字标识');
    }
    if (effort && agent !== 'codex' && !AGENT_EFFORTS[agent]?.includes(effort)) {
      throw new Error(`${AGENTS[agent]?.label || agent} 的 effort 必须为 ${AGENT_EFFORTS[agent]?.join('/') || '受支持的值'}`);
    }
    if (body.idempotency_key) {
      const old = this.db.prepare('SELECT * FROM runs WHERE idempotency_key=?').get(String(body.idempotency_key));
      if (old) return this.get(old.id);
    }
    const rs = this._runtimeSession(body, source, mode);
    const id = uid(), t = now();
    this.db.prepare(`INSERT INTO runs(id,runtime_session_id,mode,parent_agent_session_id,input,model,effort,cwd,status,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, rs.id, mode, source?.agent_session_id || body.agent_session_id || null, JSON.stringify(input), body.model || null, effort, body.cwd || rs.workspace_path || null, 'queued', body.idempotency_key ? String(body.idempotency_key) : null, t, t);
    this._event(id, 'queued', { mode, agent: rs.agent, input: inputSummary(input) });
    this._enqueue(id, rs.id);
    return this.get(id);
  }
  get(id) {
    const row = this.db.prepare(`SELECT r.*, rs.agent,rs.agent_session_id,rs.workspace_path,rs.connector FROM runs r JOIN runtime_sessions rs ON rs.id=r.runtime_session_id WHERE r.id=?`).get(id);
    if (!row) return null;
    try { row.input = inputSummary(JSON.parse(row.input)); } catch { row.input = [{ type: 'unavailable' }]; }
    row.events = this.db.prepare('SELECT seq,type,payload,created_at FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1').all(id).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
    return row;
  }
  events(id, after = 0, limit = 1000) {
    return this.db.prepare('SELECT seq,type,payload,created_at FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit).map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
  }
  approvals(id) {
    return this.db.prepare('SELECT * FROM approvals WHERE run_id=? ORDER BY created_at').all(id).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }
  resolveApproval(runId, approvalId, decision, response = null) {
    const a = this.db.prepare('SELECT * FROM approvals WHERE id=? AND run_id=?').get(approvalId, runId);
    if (!a) throw new Error('approval not found');
    if (a.status !== 'pending') return a;
    let payload;
    if (/requestUserInput$/i.test(a.kind)) {
      if (!response || typeof response.answers !== 'object') throw new Error('缺少用户问题的 answers');
      payload = { answers: response.answers };
      decision = 'answered';
    } else if (/permissions\/requestApproval$/i.test(a.kind)) {
      if (!['allow', 'deny', 'always', 'cancel'].includes(decision)) throw new Error('invalid decision');
      const requested = JSON.parse(a.payload || '{}').permissions || {};
      payload = decision === 'allow' || decision === 'always'
        ? { permissions: requested, scope: decision === 'always' ? 'session' : 'turn' }
        : { permissions: { fileSystem: { entries: [] }, network: { enabled: false } }, scope: 'turn' };
    } else {
      if (!['allow', 'deny', 'always', 'cancel'].includes(decision)) throw new Error('invalid decision');
      if (isLegacyCodexApproval(a.kind)) {
        const codexDecision = {
          allow: 'approved',
          always: 'approved_for_session',
          deny: { denied: { rejection: 'Denied in ChatVault' } },
          cancel: 'abort',
        }[decision];
        payload = { decision: codexDecision };
      } else {
        const codexDecision = { allow: 'accept', always: 'acceptForSession', deny: 'decline', cancel: 'cancel' }[decision];
        payload = { decision: codexDecision };
      }
    }
    this.db.prepare('UPDATE approvals SET status=?,decision=?,resolved_at=? WHERE id=?').run('resolved', decision, now(), approvalId);
    const p = this.processes.get(runId); if (p?.rpc && a.request_id != null) p.rpc.send({ jsonrpc: '2.0', id: Number(a.request_id) || a.request_id, result: payload });
    this.db.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='waiting_approval'").run(now(), runId);
    this._event(runId, 'approval_resolved', { approvalId, decision });
    return this.db.prepare('SELECT * FROM approvals WHERE id=?').get(approvalId);
  }
  cancel(id) {
    const r = this.db.prepare('SELECT runtime_session_id,status FROM runs WHERE id=?').get(id); if (!r) return null;
    if (!TERMINAL.has(r.status)) {
      this.db.prepare('UPDATE runs SET status=?,finished_at=?,updated_at=? WHERE id=?').run('cancelled', now(), now(), id);
      this._redactRunInput(id);
      this._event(id, 'cancelled', {});
      if (r.status === 'queued') {
        const queue = this.queues.get(r.runtime_session_id);
        const index = queue?.indexOf(id) ?? -1;
        if (index >= 0) queue.splice(index, 1);
      }
      const proc = this.processes.get(id);
      if (proc?.rpc) {
        if (proc.threadId && proc.turnId) {
          proc.rpc.request('turn/interrupt', { threadId: proc.threadId, turnId: proc.turnId }, 5000).catch(() => proc.rpc.kill());
        } else proc.rpc.kill();
      } else proc?.child?.kill();
    }
    return this.get(id);
  }
  _event(runId, type, payload = {}) {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 seq FROM run_events WHERE run_id=?').get(runId);
    // Persist the same scrubbed form that reaches SSE subscribers.  Raw
    // connector notifications can echo UserInput, which may include a large
    // data URL; runs.input retains the original only until the connector has
    // consumed it, while the event log remains safe to read and replay.
    const safePayload = safeEventPayload(payload);
    const ev = { runId, seq: row.seq, type, payload: safePayload, created_at: now() };
    this.db.prepare('INSERT INTO run_events(run_id,seq,type,payload,created_at) VALUES(?,?,?,?,?)').run(runId, ev.seq, type, JSON.stringify(safePayload), ev.created_at);
    this.emit('event', ev); this.emit(`run:${runId}`, ev); return ev;
  }
  _redactRunInput(runId) {
    const row = this.db.prepare('SELECT input FROM runs WHERE id=?').get(runId);
    if (!row) return;
    try {
      const input = JSON.parse(row.input);
      if (Array.isArray(input)) this.db.prepare('UPDATE runs SET input=?,updated_at=? WHERE id=?').run(JSON.stringify(redactInput(input)), now(), runId);
    } catch { /* corrupt historical input must not mask a run result */ }
  }
  _enqueue(id, sessionId) {
    const q = this.queues.get(sessionId) || []; q.push(id); this.queues.set(sessionId, q); if (q.length === 1) this._start(id, sessionId);
  }
  async _start(id, sessionId) {
    const run = this.db.prepare(`SELECT r.*,rs.session_id source_session_id,rs.agent,rs.agent_session_id,rs.workspace_path,rs.connector FROM runs r JOIN runtime_sessions rs ON rs.id=r.runtime_session_id WHERE r.id=?`).get(id);
    if (!run || TERMINAL.has(run.status)) {
      const queue = this.queues.get(sessionId) || [];
      if (queue[0] === id) queue.shift();
      if (queue.length) this._start(queue[0], sessionId); else this.queues.delete(sessionId);
      return;
    }
    this.db.prepare('UPDATE runtime_sessions SET status=?,updated_at=? WHERE id=?').run('running', now(), sessionId);
    this.db.prepare('UPDATE runs SET status=?,started_at=?,updated_at=? WHERE id=?').run('running', now(), now(), id); this._event(id, 'started', { agent: run.agent });
    try { if (run.agent === 'codex') await this._codex(run); else await this._cli(run); }
    catch (e) {
      // cancel() intentionally terminates the child, which also rejects its
      // await. Preserve the explicit cancelled state instead of relabelling it
      // as a connector failure.
      if (this.db.prepare('SELECT status FROM runs WHERE id=?').get(id)?.status !== 'cancelled') {
        const error = typeof e?.message === 'string' ? e.message : String(e);
        this.db.prepare('UPDATE runs SET status=?,error=?,finished_at=?,updated_at=? WHERE id=?').run('failed', error, now(), now(), id);
        this._redactRunInput(id);
        this._event(id, 'failed', { error });
      }
    }
    this._redactRunInput(id);
    // A completed connector process is not yet a completed ChatVault turn:
    // its native transcript still needs to pass through the normal source
    // adapters.  Await that scan before releasing the next queued turn so an
    // SSE client has one definitive "archive is ready" boundary to refresh
    // from, rather than guessing from raw connector notifications.
    await this._syncArchive(id, run);
    const q = this.queues.get(sessionId) || [];
    if (q[0] === id) q.shift();
    if (q.length) {
      this.db.prepare('UPDATE runtime_sessions SET status=?,updated_at=? WHERE id=?').run('queued', now(), sessionId);
      this._start(q[0], sessionId);
    } else {
      this.queues.delete(sessionId);
      this.db.prepare('UPDATE runtime_sessions SET status=?,updated_at=? WHERE id=?').run('idle', now(), sessionId);
    }
  }
  async _syncArchive(runId, run) {
    if (!this.onSync) {
      this._event(runId, 'archive_sync_skipped', { reason: 'sync disabled' });
      return;
    }
    this._event(runId, 'archive_syncing', {});
    try {
      const result = await this.onSync({ runId, agent: run.agent, sessionId: run.source_session_id || null });
      // The built-in CLI callback reports operational failures as { ok:false }
      // so watcher failures can be logged without causing an unhandled promise.
      // Preserve that distinction for API clients waiting on this event stream.
      if (result && result.ok === false) throw new Error(result.error || 'archive sync failed');
      this._event(runId, 'archive_synced', {});
    } catch (err) {
      const error = typeof err?.message === 'string' ? err.message : String(err);
      this._event(runId, 'archive_sync_failed', { error: error.slice(0, 2000) });
    }
  }
  _waitForCodexCompletion(runId, rpc) {
    let settled = false;
    let resolve;
    const cleanup = () => {
      this.off(`run:${runId}`, onEvent);
      rpc.off('exit', onExit);
    };
    const settle = (event) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(event);
    };
    const onEvent = (event) => {
      if (event.type === 'native_completed' || event.type === 'error') settle(event);
    };
    const onExit = () => settle({ type: 'error', message: 'Codex exited' });
    const promise = new Promise((done) => { resolve = done; });
    this.on(`run:${runId}`, onEvent);
    rpc.once('exit', onExit);
    return { promise, cleanup };
  }
  async _codex(run) {
    const bin = findCodex(); if (!bin) throw new Error('codex app-server not found; install Codex or set CHATVAULT_CODEX_BIN');
    const rpc = new JsonRpcProcess(bin, ['app-server'], { cwd: run.cwd || process.cwd() });
    const processInfo = { rpc, threadId: null, turnId: null }; this.processes.set(run.id, processInfo);
    rpc.on('stderr', (x) => this._event(run.id, 'stderr', { text: String(x).slice(-4000) }));
    rpc.on('message', (m) => this._handleCodex(run, rpc, m));
    try {
      await rpc.request('initialize', { clientInfo: { name: 'chat-vault', title: 'ChatVault', version: '0.4.1' }, capabilities: {} }); rpc.notify('initialized', {});
      let threadId = run.mode === 'fork' ? run.parent_agent_session_id : run.agent_session_id;
      // An archived thread can have been created with a different approval or
      // sandbox setting.  Every entry path resets the runtime to ChatVault's
      // interactive local policy rather than silently inheriting `never` or
      // an auto-reviewer from the previous client.
      const threadOptions = {
        cwd: run.cwd || null,
        model: run.model || null,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      };
      if (run.mode === 'new' || !threadId) {
        const t = await rpc.request('thread/start', threadOptions);
        threadId = t?.thread?.id || t?.id || t?.threadId;
      } else if (run.mode === 'fork') {
        const t = await rpc.request('thread/fork', { threadId, ...threadOptions, ephemeral: false });
        threadId = t?.thread?.id || t?.threadId || t?.id;
      } else {
        await rpc.request('thread/resume', { threadId, ...threadOptions, excludeTurns: true });
      }
      if (!threadId) throw new Error('Codex did not return thread id');
      processInfo.threadId = threadId;
      this.db.prepare('UPDATE runtime_sessions SET agent_session_id=?,status=?,updated_at=? WHERE id=?').run(threadId, 'running', now(), run.runtime_session_id);
      let input; try { input = JSON.parse(run.input); } catch { input = [{ type: 'text', text: String(run.input || '') }]; }
      // Register before turn/start.  A very short turn can emit its terminal
      // notification before the request response arrives.
      const completion = this._waitForCodexCompletion(run.id, rpc);
      let turn;
      try {
        const turnRequest = rpc.request('turn/start', { threadId, input, cwd: run.cwd || null, model: run.model || null, effort: run.effort || null });
        this._redactRunInput(run.id);
        turn = await turnRequest;
      } catch (err) {
        completion.cleanup();
        throw err;
      }
      const turnId = turn?.turn?.id || turn?.id || null; processInfo.turnId = turnId;
      this.db.prepare('UPDATE runs SET native_turn_id=?,updated_at=? WHERE id=?').run(turnId, now(), run.id); this._event(run.id, 'turn_started', { threadId, turnId });
      const outcome = await completion.promise;
      completion.cleanup();
      if (outcome.type === 'error') throw new Error(outcome.payload?.message || outcome.message || 'Codex error');
      if (this.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id)?.status !== 'cancelled') {
        this.db.prepare('UPDATE runs SET status=?,finished_at=?,updated_at=? WHERE id=?').run('completed', now(), now(), run.id); this._event(run.id, 'completed', {});
      }
    } finally {
      rpc.kill(); this.processes.delete(run.id);
    }
  }
  _handleCodex(run, rpc, msg) {
    if (msg.id !== undefined && msg.method && isCodexApprovalRequest(msg.method)) {
      const aid = uid(); this.db.prepare('INSERT INTO approvals(id,run_id,request_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)').run(aid, run.id, String(msg.id), msg.method, JSON.stringify(msg.params || {}), now()); this.db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run('waiting_approval', now(), run.id);
      this._event(run.id, /requestUserInput/i.test(msg.method) ? 'user_input_requested' : 'approval_requested', { approvalId: aid, kind: msg.method, payload: msg.params || {} }); return;
    }
    const ev = normalizeCodexMessage(msg);
    if (ev.type === 'started' && ev.turnId) {
      const processInfo = this.processes.get(run.id);
      if (processInfo) processInfo.turnId = ev.turnId;
    }
    if (ev.type === 'completed') this._event(run.id, 'native_completed', ev.raw); else if (ev.type === 'error') this._event(run.id, 'error', { message: ev.message }); else this._event(run.id, ev.type, ev.type === 'delta' || ev.type === 'message' ? { text: ev.text, raw: ev.raw } : ev.payload || ev.raw || {});
  }
  async _cli(run) {
    const configured = run.agent === 'claude-code' ? (process.env.CHATVAULT_CLAUDE_BIN || 'claude') : (process.env.CHATVAULT_COPILOT_BIN || 'copilot');
    const cmd = executableCommand(configured);
    if (!cmd) throw new Error(`${configured} CLI not found or no longer exists`);
    let input; try { input = JSON.parse(run.input); } catch { input = [{ type: 'text', text: String(run.input || '') }]; }
    if (run.agent === 'copilot' && run.mode === 'fork') throw new Error('Copilot CLI 目前没有可用于程序化调用的 fork 参数；请选择“新建会话”或“继续当前会话”');
    const text = input.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    const media = input.filter((x) => x.type !== 'text');
    let args, stdin = null, cleanup = () => {};
    if (run.agent === 'claude-code') {
      if (media.some((x) => x.type === 'audio' || x.type === 'localAudio')) throw new Error('Claude Code 当前连接器支持图片，但不支持音频附件；请使用 Codex 发送音频');
      // A CLI turn is a one-shot child process.  Inheriting every globally
      // configured MCP server here can leave its grandchildren alive after
      // Claude exits, with the workspace held as their CWD.  Use an explicit
      // empty configuration so this runtime neither leaks those processes
      // nor gives a browser-submitted turn ambient third-party MCP access.
      const isolatedMcpArgs = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
      if (media.length) {
        const content = [];
        for (const item of input) {
          if (item.type === 'text') content.push({ type: 'text', text: item.text });
          else if (item.type === 'image') {
            if (!item.url.startsWith('data:')) throw new Error('Claude 图片附件目前必须使用 data URL');
            const image = parseDataUrl(item.url);
            if (!image.mime.startsWith('image/')) throw new Error('Claude 附件必须是图片');
            content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } });
          } else if (item.type === 'localImage') {
            const image = localImageContent(item.path);
            content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } });
          }
        }
        args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...isolatedMcpArgs];
        stdin = JSON.stringify({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }) + '\n';
      } else args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...isolatedMcpArgs];
    } else {
      if (media.some((x) => x.type === 'audio' || x.type === 'localAudio')) throw new Error('Copilot CLI 当前仅支持图片附件，不支持音频附件；请使用 Codex 发送音频');
      const attachments = [];
      const tempDir = path.join(RUNTIME_INPUT_DIR, run.id);
      try {
        for (const [index, item] of media.entries()) {
          if (item.type === 'localImage') attachments.push(item.path);
          else if (item.type === 'image') {
            if (!item.url.startsWith('data:')) throw new Error('Copilot 图片附件目前必须使用 data URL');
            const image = parseDataUrl(item.url);
            if (!image.mime.startsWith('image/')) throw new Error('Copilot 附件必须是图片');
            fs.mkdirSync(tempDir, { recursive: true });
            const filePath = path.join(tempDir, `${index + 1}.${mimeExtension(image.mime)}`);
            fs.writeFileSync(filePath, image.bytes, { mode: 0o600 });
            attachments.push(filePath);
          }
        }
      } catch (err) { removeRuntimeInputDir(tempDir); throw err; }
      cleanup = () => removeRuntimeInputDir(tempDir);
      args = ['--prompt', text || '请分析所附图片。', '--output-format', 'json'];
      for (const attachment of attachments) args.push('--attachment', attachment);
    }
    if (run.model) {
      if (run.agent === 'copilot') args.push(`--model=${run.model}`);
      else args.push('--model', run.model);
    }
    if (run.effort) {
      if (run.agent === 'copilot') args.push(`--effort=${run.effort}`);
      else args.push('--effort', run.effort);
    }
    const resumeId = run.mode === 'fork' ? run.parent_agent_session_id : run.agent_session_id;
    if (run.mode !== 'new' && resumeId) args.push('--resume', resumeId);
    if (run.mode === 'fork' && run.agent === 'claude-code') args.push('--fork-session');
    const child = spawn(cmd, args, { cwd: run.cwd || process.cwd(), stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true }); this.processes.set(run.id, { child });
    child.stdout.setEncoding('utf8'); let buf = ''; let streamError = null;
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = parseCliLine(run.agent, line);
        if (ev.type === 'error' && !streamError) streamError = ev.message || 'connector reported an error';
        // A stream's trailing result record is not a successful completion if
        // it already emitted an API error (Claude exits 0 in that situation).
        const type = ev.type === 'completed' && streamError ? 'notification' : ev.type;
        this._event(run.id, type, ev.type === 'delta' ? { text: ev.text, raw: ev.raw } : ev);
      }
    });
    child.stderr.on('data', (d) => this._event(run.id, 'stderr', { text: String(d).slice(-4000) }));
    if (stdin) child.stdin.end(stdin);
    // The child now owns either its stdin data or private temporary
    // attachments.  Do not retain a data URL in SQLite for the rest of a
    // potentially long-running agent turn.
    this._redactRunInput(run.id);
    try {
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))); });
      // Claude can emit an API/error envelope but still return exit code 0.
      // Treat that as a failed turn; otherwise the persisted run and UI claim
      // success despite the submitted input having been rejected.
      if (streamError) throw new Error(streamError);
      if (this.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id)?.status !== 'cancelled') {
        this.db.prepare('UPDATE runs SET status=?,finished_at=?,updated_at=? WHERE id=?').run('completed', now(), now(), run.id); this._event(run.id, 'completed', {});
      }
    } finally {
      cleanup(); this.processes.delete(run.id);
    }
  }
  close() { for (const p of this.processes.values()) { p.rpc?.kill(); p.child?.kill(); } this.processes.clear(); }
}

export function runtimeStatus(db, { includeConnectors = true } = {}) {
  const rows = db.prepare("SELECT status,COUNT(*) count FROM runs GROUP BY status").all();
  const status = { runs: Object.fromEntries(rows.map((r) => [r.status, r.count])) };
  if (includeConnectors) status.connectors = detectConnectors();
  return status;
}
