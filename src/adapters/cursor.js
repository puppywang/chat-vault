// Cursor adapter
// 数据源 1: ~/.cursor/chats/<workspaceHash>/<sessionId>/{meta.json, store.db}
//   meta.json: {title, cwd, createdAtMs, updatedAtMs} —— workspace 直出
//   store.db: blobs(id, data) —— data 为逗号分隔字节串。约 1/3 是明文 JSON 消息
//     {role, content:[{type:'text'|'reasoning'|'tool-call'|'tool-result',...}]}（AI SDK 风格）；
//     其余为 Cursor 私有压缩格式（链式 blob），目前跳过。
// 数据源 2: %APPDATA%\Cursor\User\globalStorage\state.vscdb（Cursor 2.x 起所有会话集中于此，
//   参考 cursaves / cursor-chat-export 的逆向结论）：
//     cursorDiskKV 表  composerData:{UUID}          会话骨架（name/createdAt/unifiedMode）
//                     bubbleId:{cid}:{bid}          消息气泡（type 1=用户 / 2=助手；text、modelInfo）
//     composerHeaders 表                            新会话索引（composerId → workspaceId）
//     workspaceStorage\<hash>\workspace.json        workspaceId(hash) → folder URI
//   旧 workspaceStorage/*/state.vscdb 在本机已迁移为空壳（cursorDiskKV 0 行），不再扫描。
// 消息无逐条时间戳的（store.db 源）按 rowid 排列、时间用会话级；globalStorage 源有逐条 createdAt。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listFiles, fingerprint } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';

function chatsDir() {
  return path.join(os.homedir(), '.cursor', 'chats');
}
function globalDb() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb') : null;
}
function wsDir() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Cursor', 'User', 'workspaceStorage') : null;
}

const iso = (ms) => (typeof ms === 'number' && ms ? new Date(ms).toISOString() : null);
const isoStr = (s) => {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** content（字符串或数组）→ {text, thinking, model} */
function extractContent(content) {
  if (typeof content === 'string') return { text: content, thinking: null, model: null };
  if (!Array.isArray(content)) return { text: null, thinking: null, model: null };
  const texts = [], thinks = [];
  let model = null;
  for (const c of content) {
    if (c?.type === 'text' && c.text) texts.push(c.text);
    else if (c?.type === 'reasoning' && c.text) thinks.push(c.text);
    else if (c?.type === 'redacted-reasoning' && c.data) thinks.push('[redacted reasoning]');
    else if (c?.type === 'tool-call') texts.push(`[tool:${c.toolName || c.toolCallId || 'tool'}] ${JSON.stringify(c.args ?? {}).slice(0, 150)}`);
    else if (c?.type === 'tool-result') {
      const t = typeof c.output === 'string' ? c.output
        : Array.isArray(c.output) ? c.output.filter((x) => x?.type === 'text').map((x) => x.text).join(' ')
        : '';
      texts.push(`[tool_result] ${String(t).slice(0, 300)}`);
    }
    // 模型名藏在 reasoning/redacted-reasoning 块的 providerOptions.cursor.modelName
    if (!model && c?.providerOptions?.cursor?.modelName) {
      model = c.providerOptions.cursor.modelName;
    }
  }
  return { text: texts.join('\n') || null, thinking: thinks.join('\n') || null, model };
}

/** 模型名拆分：claude-4.5-sonnet-thinking → {model, effort}；无后缀则 effort 为空 */
function splitModel(modelName) {
  const m = String(modelName || '').match(/^(.+?)[-_ ](thinking|high|medium|low)$/i);
  if (!m) return { model: modelName || null, effort: null };
  return { model: m[1], effort: m[2].toLowerCase() };
}

/** workspaceId(hash) → 真实路径（workspaceStorage\<hash>\workspace.json 的 folder） */
const wsCache = new Map();
function workspaceById(wsId) {
  if (!wsId || wsId === 'empty-window' || /^\d+$/.test(wsId)) return null;
  if (wsCache.has(wsId)) return wsCache.get(wsId);
  let p = null;
  try {
    const wj = path.join(wsDir(), wsId, 'workspace.json');
    const folder = JSON.parse(fs.readFileSync(wj, 'utf8')).folder;
    p = normalizeWorkspacePath(folder) || null;
  } catch { /* 无映射 */ }
  wsCache.set(wsId, p);
  return p;
}

/** globalStorage/state.vscdb → 多会话数组 */
function parseGlobalVscdb(filePath) {
  // Cursor 运行中库处于 WAL 活动状态：优先只读直开（免 500MB 拷贝），失败再快照
  let db = null, tmp = null;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch {
    tmp = path.join(os.tmpdir(), `ae-cursor-g-${Date.now()}.vscdb`);
    fs.copyFileSync(filePath, tmp);
    for (const ext of ['-wal', '-shm']) {
      try { fs.copyFileSync(filePath + ext, tmp + ext); } catch { /* 无 */ }
    }
    db = new DatabaseSync(tmp, { readOnly: true });
  }
  try {
    const composers = new Map(); // cid → 骨架
    for (const r of db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
      try {
        const c = JSON.parse(r.value);
        if (c?.composerId) composers.set(c.composerId, c);
      } catch { /* 损坏跳过 */ }
    }
    // 消息按 composerId 分组
    const bubbles = new Map(); // cid → [{type,text,model,createdAt}]
    for (const r of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'").all()) {
      try {
        const b = JSON.parse(r.value);
        const cid = String(r.key || '').split(':')[1];
        if (!b || !cid) continue;
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (b.type === 1 && text) {
          // type 1 = 用户
        } else if (b.type !== 2 || !text) {
          continue; // 无文本的 type2 是流式占位/中间态气泡（无任何可恢复字段）
        }
        if (!bubbles.has(cid)) bubbles.set(cid, []);
        bubbles.get(cid).push({
          role: b.type === 1 ? 'user' : 'assistant',
          text,
          model: b.type === 2 ? b.modelInfo?.modelName : null,
          createdAt: isoStr(b.createdAt),
        });
      } catch { /* 损坏跳过 */ }
    }
    // 新索引表：composerId → workspaceId（仅覆盖近期会话）
    const wsByCid = new Map();
    try {
      for (const h of db.prepare('SELECT composerId, workspaceId FROM composerHeaders').all()) {
        wsByCid.set(h.composerId, h.workspaceId);
      }
    } catch { /* 旧版本无此表 */ }

    const sessions = [];
    for (const [cid, c] of composers) {
      const list = (bubbles.get(cid) || []).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
      if (!list.length) continue;
      const firstUser = list.find((m) => m.role === 'user');
      const messages = list.map((m) => {
        const { model, effort } = m.role === 'assistant' ? splitModel(m.model) : { model: null, effort: null };
        return { role: m.role, createdAt: m.createdAt, text: m.text, model, effort, raw: null };
      });
      sessions.push({
        agentSessionId: cid,
        workspacePath: workspaceById(wsByCid.get(cid)),
        title: String(c.name?.trim() || firstUser?.text.split('\n')[0] || '(无标题会话)').slice(0, 120),
        createdAt: iso(c.createdAt) || list[0].createdAt,
        updatedAt: list.at(-1).createdAt || iso(c.createdAt),
        messages,
      });
    }
    return sessions;
  } finally {
    try { db.close(); } catch { /* */ }
    if (tmp) for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmp + ext); } catch { /* 已删 */ }
    }
  }
}

export const cursorAdapter = {
  id: 'cursor',

  watchRoots() {
    const roots = [chatsDir()];
    const g = globalDb();
    if (g && fs.existsSync(path.dirname(g))) roots.push(path.dirname(g));
    return roots;
  },

  discover() {
    const out = listFiles(chatsDir(), '.db').filter((f) => f.path.endsWith('store.db'));
    const g = globalDb();
    if (g && fs.existsSync(g)) {
      const st = fs.statSync(g);
      out.push({ path: g, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    }
    return out;
  },

  fingerprint(file) {
    // 库文件与其 -wal 取最新（会话进行中数据常在 wal）
    let fp = `${file.size}:${file.mtimeMs}`;
    try {
      const w = fs.statSync(file.path + '-wal');
      fp += `:${w.size}:${Math.round(w.mtimeMs)}`;
    } catch { /* 无 wal */ }
    return fp;
  },

  async parseFile(filePath) {
    if (/globalStorage[\\/]state\.vscdb$/i.test(filePath)) return parseGlobalVscdb(filePath);

    // ~/.cursor/chats/<hash>/<sid>/store.db（新版散文件架构）
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), 'meta.json'), 'utf8')); } catch { /* 无 meta */ }
    const sessionId = path.basename(path.dirname(filePath));

    const tmp = path.join(os.tmpdir(), `ae-cursor-${Date.now()}.db`);
    fs.copyFileSync(filePath, tmp);
    try { fs.copyFileSync(filePath + '-wal', tmp + '-wal'); } catch { /* 无 wal */ }
    const messages = [];
    try {
      const db = new DatabaseSync(tmp, { readOnly: true });
      const rows = db.prepare('SELECT data FROM blobs ORDER BY rowid').all();
      for (const r of rows) {
        const buf = Buffer.from(String(r.data).split(',').map(Number));
        if (buf.length === 0 || buf[0] !== 0x7b) continue; // 只取明文 JSON blob
        let o;
        try { o = JSON.parse(buf.toString('utf8')); } catch { continue; }
        const role = o.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
        const { text, thinking, model } = extractContent(o.content);
        if (role === 'assistant' && thinking) {
          messages.push({ role: 'thinking', createdAt: null, text: thinking, raw: null });
        }
        if (!text) continue;
        if (role === 'user' && /^(<user_info>|<timestamp>|<system|<environment)/.test(text)) continue;
        const { model: mName, effort } = role === 'assistant' ? splitModel(model) : { model: null, effort: null };
        messages.push({ role, createdAt: null, text, model: mName, effort, raw: null });
      }
      db.close();
    } finally {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmp + ext); } catch { /* 已删 */ }
      }
    }
    if (!messages.length) return null;
    const firstUser = messages.find((m) => m.role === 'user');
    return {
      agentSessionId: sessionId,
      workspacePath: meta.cwd || null,
      title: meta.title || (firstUser ? firstUser.text.split('\n')[0].slice(0, 80) : '(无标题会话)'),
      createdAt: iso(meta.createdAtMs),
      updatedAt: iso(meta.updatedAtMs),
      messages,
    };
  },
};
