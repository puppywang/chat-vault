// Kiro adapter
// 主数据源: %APPDATA%\Kiro\User\globalStorage\kiro.kiroagent\workspace-sessions\<base64(wsPath)>\
//   <uuid>.json —— 每文件一个会话 {history:[{message:{role, content:[{type:"text",text}]}}]}；
//   同目录 sessions.json 为索引（sessionId/title/dateCreated/workspaceDirectory）。
//   目录名是 workspace 路径的 base64（ZDpc... → d:\Work\sample-lib）。
// 辅数据源: ~/.kiro/sessions/cli/<uuid>.jsonl（Kiro CLI）
//   {version:"v1", kind:"Prompt"|"AssistantMessage", data:{content:[{kind:"text"|"toolUse"}], meta:{timestamp}}}。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { backfillKiroFromLogs, logsRoot } from './kiro-chatlog.js';

function wsSessionsDir() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions') : null;
}
function cliDir() {
  return path.join(os.homedir(), '.kiro', 'sessions', 'cli');
}

const iso = (ms) => (typeof ms === 'number' && ms ? new Date(ms).toISOString()
  : typeof ms === 'string' && /^\d+$/.test(ms) ? new Date(Number(ms)).toISOString() : null);

/** content（字符串/数组/对象）→ 文本 */
function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(toText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    for (const k of ['text', 'content', 'value', 'message']) {
      if (content[k] != null) return toText(content[k]);
    }
    return '';
  }
  return String(content);
}

/** workspace-sessions/<b64>/<uuid>.json → 会话 */
function chatFileToSession(file) {
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const history = Array.isArray(d?.history) ? d.history : null;
  if (!history) return null;
  const messages = [];
  for (const h of history) {
    const role = String(h?.message?.role || '').toLowerCase();
    const r = role === 'user' || role === 'human' ? 'user'
      : role === 'assistant' || role === 'ai' || role === 'model' ? 'assistant'
        : role.includes('tool') ? 'tool' : role.includes('system') ? 'system' : null;
    if (!r) continue;
    const c = h.message.content;
    if (Array.isArray(c)) {
      for (const part of c) {
        if (part?.type === 'text' && part.text?.trim()) {
          messages.push({ role: r, createdAt: null, text: part.text, raw: null });
        } else if (part?.type === 'tool-invocation' || part?.type === 'tool_use' || part?.toolName) {
          const args = JSON.stringify(part.args ?? part.input ?? {}).slice(0, 500);
          messages.push({ role: 'tool', createdAt: null, text: `🔧 ${part.toolName || part.type}: ${args}`, raw: null });
        }
      }
    } else {
      const text = toText(c);
      if (text.trim()) messages.push({ role: r, createdAt: null, text, raw: null });
    }
  }
  if (!messages.length) return null;

  const sessionId = path.basename(file, '.json');
  // 索引：同目录 sessions.json（title/dateCreated/workspaceDirectory）
  let title = null, created = null, ws = null;
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'sessions.json'), 'utf8'));
    const ent = (Array.isArray(idx) ? idx : []).find((x) => x.sessionId === sessionId);
    title = ent?.title;
    created = iso(ent?.dateCreated);
    ws = ent?.workspaceDirectory || null;
  } catch { /* 无索引 */ }
  if (!ws) {
    // 目录名 base64 解码兜底
    try { ws = Buffer.from(path.basename(path.dirname(file)), 'base64').toString('utf8'); } catch { /* */ }
  }
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    agentSessionId: sessionId,
    workspacePath: ws ? normalizeWorkspacePath(ws) : null,
    title: String(title || firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
    createdAt: created,
    updatedAt: created,
    messages,
  };
}

/** Kiro CLI jsonl → 会话 */
async function cliToSession(jsonlPath) {
  const sid = path.basename(jsonlPath, '.jsonl');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(path.dirname(jsonlPath), sid + '.json'), 'utf8')); } catch { /* 无元数据 */ }
  const messages = [];
  await readJsonl(jsonlPath, (r) => {
    const kind = r?.kind;
    const data = r?.data;
    if (!kind || !data) return true;
    const at = data.meta?.timestamp ? iso(data.meta.timestamp * 1000) : null;
    if (kind === 'Prompt') {
      const text = toText(data.content?.map((c) => c?.kind === 'text' ? c.data : '').filter(Boolean).join('\n'));
      if (text.trim()) messages.push({ role: 'user', createdAt: at, text, raw: null });
    } else if (kind === 'AssistantMessage') {
      for (const c of Array.isArray(data.content) ? data.content : []) {
        if (c?.kind === 'text' && c.data?.trim()) {
          messages.push({ role: 'assistant', createdAt: at, text: c.data, raw: null });
        } else if (c?.kind === 'toolUse' && c.data) {
          const t = typeof c.data === 'string' ? c.data : toText(c.data);
          if (t.trim()) messages.push({ role: 'tool', createdAt: at, text: `🔧 ${t.slice(0, 2000)}`, raw: null });
        }
      }
    }
    return true;
  });
  if (!messages.length) return null;
  const firstUser = messages.find((m) => m.role === 'user');
  const times = messages.map((m) => m.createdAt).filter(Boolean).sort();
  return {
    agentSessionId: sid,
    workspacePath: meta.cwd || null,
    title: String(meta.title || firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
    createdAt: meta.created_at || times[0] || null,
    updatedAt: times.at(-1) || meta.updated_at || null,
    messages,
  };
}

export const kiroAdapter = {
  id: 'kiro',

  watchRoots() {
    const roots = [];
    const w = wsSessionsDir();
    if (w && fs.existsSync(w)) roots.push(w);
    const c = cliDir();
    if (c && fs.existsSync(c)) roots.push(c);
    // Chat API 日志：回填数据源，活跃期日志增长也要触发 sync
    const l = logsRoot();
    if (l && fs.existsSync(l)) roots.push(l);
    return roots;
  },

  discover() {
    const out = [];
    const w = wsSessionsDir();
    if (w && fs.existsSync(w)) {
      for (const f of listFiles(w, '.json')) {
        if (path.basename(f.path) !== 'sessions.json') out.push(f);
      }
    }
    const c = cliDir();
    if (c && fs.existsSync(c)) for (const f of listFiles(c, '.jsonl')) out.push(f);
    return out;
  },

  fingerprint,

  async parseFile(filePath) {
    if (filePath.endsWith('.jsonl')) return await cliToSession(filePath);
    return chatFileToSession(filePath);
  },

  /** 后处理：Chat API 日志回填（json 只存 ack 文本，真实轨迹在 IDE 日志里） */
  async afterSync(db, { touched } = {}) {
    return backfillKiroFromLogs(db, touched);
  },
};
