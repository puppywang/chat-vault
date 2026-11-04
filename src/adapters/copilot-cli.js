// GitHub Copilot（Copilot CLI / SDK 引擎）事件流解析，供 copilot adapter 调用
// 数据源: ~/.copilot/session-state/<sdkSessionId>/events.jsonl
//
// VS Code 1.14x 起 Copilot 聊天改由 Copilot CLI agent host 承载（agent-host.db 里
// provider=copilotcli），不再写 workspaceStorage/<hash>/chatSessions/*.jsonl。对话正文
// 全在 CLI 的事件流里；VS Code 侧 %APPDATA%/Code/agentSessionData/<vscodeId>/session.db
// 只存元数据，其中 defaultChatProviderData.sdkSessionId 指回这里，customTitle 是界面上
// 显示的会话标题。终端里直接跑 copilot CLI 的会话也落在同一目录。
//
// 每行一个事件 {type, data, id, timestamp, parentId}，用到的类型：
//   session.start / session.resume      会话头（sessionId、context.cwd、selectedModel）
//   session.model_change                切模型（newModel、reasoningEffort）
//   session.binary_asset                用户粘贴图片的 base64（按 assetId 被 user.message 附件引用）
//   user.message                        content 是原文（VS Code 会在末尾追加 <reminder> 附件说明）
//   assistant.message                   content 正文 + reasoningText 思考 + toolRequests 工具调用
//   tool.execution_complete             工具结果（result.content 或 error.message）
//   session.compaction_complete         上下文压缩摘要
//   session.error / session.warning / abort / system.notification  过程状态，按系统消息留档
// hook.* / assistant.turn_* / session.usage_record / system.message（系统提示词）等不产生消息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl, slimJson } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { saveImages } from '../imagestore.js';

const TOOL_ARGS_LIMIT = 4000;
const TOOL_RESULT_LIMIT = 2000;
const NOTICE_LIMIT = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sessionStateDir() {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

function agentSessionDataDir() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Code', 'agentSessionData') : null;
}

/** 每个会话目录下的 events.jsonl（不递归：files/ 里是 agent 自己写的产物） */
export function listCliSessionFiles() {
  const root = sessionStateDir();
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !UUID_RE.test(e.name)) continue;
    const p = path.join(root, e.name, 'events.jsonl');
    try {
      const st = fs.statSync(p);
      out.push({ path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    } catch { /* 只有锁文件、还没写事件 */ }
  }
  return out;
}

export function isCliEventsFile(filePath) {
  return path.basename(filePath).toLowerCase() === 'events.jsonl'
    && path.resolve(path.dirname(path.dirname(filePath))).toLowerCase() === path.resolve(sessionStateDir()).toLowerCase();
}

// VS Code 侧标题：sdkSessionId → customTitle。按 session.db 的 mtime 缓存，
// 目录里大多是空会话（只有 2 个元数据键），每轮只重读变过的。
const titleCache = new Map(); // dir -> { mtimeMs, sdk, title }

function readVscodeMeta(dbPath) {
  let db = null, tmp = null;
  try {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      // VS Code 占用时退回快照
      tmp = path.join(os.tmpdir(), `ae-copilot-${process.pid}-${Date.now()}.db`);
      fs.copyFileSync(dbPath, tmp);
      for (const ext of ['-wal', '-shm']) {
        try { fs.copyFileSync(dbPath + ext, tmp + ext); } catch { /* 无 */ }
      }
      db = new DatabaseSync(tmp, { readOnly: true });
    }
    const rows = db.prepare(
      "SELECT key, value FROM session_metadata WHERE key IN ('defaultChatProviderData', 'customTitle')"
    ).all();
    const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let sdk = null;
    try { sdk = JSON.parse(meta.defaultChatProviderData || '{}').sdkSessionId || null; } catch { /* 损坏 */ }
    const title = typeof meta.customTitle === 'string' && meta.customTitle.trim() ? meta.customTitle.trim() : null;
    return { sdk, title };
  } catch {
    return { sdk: null, title: null };
  } finally {
    try { db?.close(); } catch { /* 已关 */ }
    if (tmp) for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(tmp + ext, { force: true }); } catch { /* 忽略 */ } }
  }
}

function vscodeTitleOf(sdkSessionId) {
  const root = agentSessionDataDir();
  if (!root) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  let found = null;
  for (const e of entries) {
    // 带后缀的同名目录是子对话/工具上下文，没有会话级元数据
    if (!e.isDirectory() || !UUID_RE.test(e.name)) continue;
    const dbPath = path.join(root, e.name, 'session.db');
    let mtimeMs;
    try { mtimeMs = fs.statSync(dbPath).mtimeMs; } catch { continue; }
    let c = titleCache.get(e.name);
    if (!c || c.mtimeMs !== mtimeMs) {
      c = { mtimeMs, ...readVscodeMeta(dbPath) };
      titleCache.set(e.name, c);
    }
    if (c.sdk === sdkSessionId && c.title) found = c.title;
  }
  return found;
}

/** workspace.yaml 里的 name（CLI 用首条提问当默认名，user_named=true 才是用户起的） */
function yamlName(filePath) {
  try {
    const text = fs.readFileSync(path.join(path.dirname(filePath), 'workspace.yaml'), 'utf8');
    if (!/^user_named:\s*true\s*$/m.test(text)) return null;
    const m = /^name:\s*(.+)$/m.exec(text);
    return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
  } catch {
    return null;
  }
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…(截断，共 ${text.length} 字符)` : text;
}

function iso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return null;
}

/** 形如 customendpoint/CPA/deepseek-v4.1-flash-free，与 chatSessions 源一致取末段展示 */
function shortModel(id) {
  return typeof id === 'string' && id ? id.split('/').pop() : null;
}

/** VS Code 在用户原文后追加的 <reminder> 附件说明不是用户写的，去掉 */
function cleanUserText(text) {
  return String(text ?? '').replace(/\s*<reminder>[\s\S]*?<\/reminder>\s*/g, '\n').trim();
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((x) => x.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

export async function parseCliSession(filePath, agentId) {
  let sessionId = path.basename(path.dirname(filePath));
  let cwd = null;
  let createdAt = null;
  let curModel = null;
  let curEffort = null;
  const assets = new Map();    // assetId -> { data, mime }
  const toolNames = new Map(); // toolCallId -> name
  const messages = [];
  const push = (m) => { messages.push(m); };

  await readJsonl(filePath, (ev) => {
    const at = iso(ev.timestamp);
    const d = ev.data || {};
    const raw = { type: ev.type, id: ev.id, parentId: ev.parentId };

    switch (ev.type) {
      case 'session.start':
        if (typeof d.sessionId === 'string' && d.sessionId) sessionId = d.sessionId;
        createdAt = iso(d.startTime) || at;
        if (d.context?.cwd) cwd = d.context.cwd;
        if (d.selectedModel) curModel = d.selectedModel;
        return;

      case 'session.resume':
        if (d.context?.cwd) cwd = d.context.cwd;
        if (d.selectedModel) curModel = d.selectedModel;
        return;

      case 'session.model_change':
        if (d.newModel) curModel = d.newModel;
        if (d.reasoningEffort !== undefined) curEffort = d.reasoningEffort || null;
        return;

      case 'session.binary_asset':
        if (d.assetId && typeof d.data === 'string' && d.data) assets.set(d.assetId, { data: d.data, mime: d.mimeType });
        return;

      case 'user.message': {
        const text = cleanUserText(d.content);
        const items = [];
        for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
          if (!/^image\//.test(a?.mimeType || '')) continue;
          const asset = a.assetId && assets.get(a.assetId);
          if (asset) {
            items.push(asset);
          } else if (typeof a.path === 'string' && fs.existsSync(a.path)) {
            items.push({ data: fs.readFileSync(a.path).toString('base64'), mime: a.mimeType });
          }
        }
        const images = items.length ? saveImages(agentId, sessionId, `m${messages.length}`, items) : [];
        if (!text && !images.length) return;
        const attachments = (d.attachments || []).map((a) => ({ type: a?.type, name: a?.displayName, path: a?.path || a?.filePath }));
        push({
          role: 'user',
          createdAt: at,
          text: text || '[图片]',
          raw: { ...raw, turnId: d.turnId, delivery: d.delivery, attachments: attachments.length ? slimJson(attachments, 200) : undefined },
          images,
        });
        return;
      }

      case 'assistant.message': {
        const model = shortModel(d.model || curModel);
        const effort = curEffort;
        const think = typeof d.reasoningText === 'string' ? d.reasoningText.trim() : '';
        if (think) push({ role: 'thinking', createdAt: at, text: think, raw: { ...raw, part: 'thinking' }, model, effort });
        const text = typeof d.content === 'string' ? d.content.trim() : '';
        if (text) push({ role: 'assistant', createdAt: at, text, raw: { ...raw, part: 'text', turnId: d.turnId }, model, effort });
        for (const t of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
          const name = t?.name || 'tool';
          if (t?.toolCallId) toolNames.set(t.toolCallId, name);
          push({
            role: 'tool',
            createdAt: at,
            text: `[tool:${name}] ${clip(t?.arguments ?? {}, TOOL_ARGS_LIMIT)}`,
            raw: { ...raw, part: 'toolCall', toolCallId: t?.toolCallId, name },
            model,
          });
        }
        return;
      }

      case 'tool.execution_start':
        if (d.toolCallId && d.toolName && !toolNames.has(d.toolCallId)) toolNames.set(d.toolCallId, d.toolName);
        return;

      case 'tool.execution_complete': {
        const name = toolNames.get(d.toolCallId) || 'tool';
        const failed = d.success === false || !!d.error;
        const body = failed
          ? (d.error?.message || d.result?.content || '')
          : (d.result?.content ?? '');
        const text = clip(body, TOOL_RESULT_LIMIT).trim();
        push({
          role: 'tool',
          createdAt: at,
          text: `[tool_result:${name}${failed ? ' error' : ''}] ${text || '(无输出)'}`,
          raw: { ...raw, toolCallId: d.toolCallId, name, isError: failed, exitCode: d.shellExecution?.exitCode },
        });
        return;
      }

      case 'session.compaction_complete': {
        const summary = typeof d.summaryContent === 'string' ? d.summaryContent.trim() : '';
        if (!summary) return;
        push({
          role: 'system',
          createdAt: at,
          text: `[compaction] ${summary}`,
          raw: { ...raw, preCompactionTokens: d.preCompactionTokens, postCompactionTokens: d.postCompactionTokens },
        });
        return;
      }

      case 'session.error':
      case 'session.warning': {
        const kind = ev.type === 'session.error' ? 'error' : 'warning';
        const sub = d.errorType || d.warningType;
        if (!d.message) return;
        push({ role: 'system', createdAt: at, text: `[${kind}${sub ? `:${sub}` : ''}] ${clip(d.message, NOTICE_LIMIT)}`, raw });
        return;
      }

      case 'abort':
        push({ role: 'system', createdAt: at, text: `[abort] ${d.reason || ''}`.trim(), raw });
        return;

      case 'system.notification': {
        const text = typeof d.content === 'string'
          ? d.content.replace(/<\/?system_notification>/g, '').trim()
          : '';
        if (!text) return;
        push({ role: 'system', createdAt: at, text: `[notification] ${clip(text, NOTICE_LIMIT)}`, raw: { ...raw, kind: d.kind?.type } });
        return;
      }

      default:
        return;
    }
  });

  if (!messages.some((m) => m.role === 'user' || m.role === 'assistant')) return null;
  const title = vscodeTitleOf(sessionId)
    || yamlName(filePath)
    || firstLine(messages.find((m) => m.role === 'user' && m.text !== '[图片]')?.text)
    || '(无标题会话)';
  return {
    agentSessionId: sessionId,
    workspacePath: normalizeWorkspacePath(cwd),
    title,
    createdAt: createdAt || messages[0].createdAt,
    updatedAt: messages[messages.length - 1].createdAt || createdAt,
    messages,
  };
}
