// Kiro Chat API 日志回填（kiro adapter 的 afterSync 钩子）
// workspace-sessions/<b64>/<uuid>.json 只持久化 ack 文本（助手全篇 "On it."）与用户输入，
// 真实执行轨迹（助手全文、每步工具调用 toolUses 与结果 toolResults）只出现在 IDE 日志的
// Chat API 请求体里： %APPDATA%/Kiro/logs/<启动时间>/window*/exthost/output_logging*/5-Q Chat API*.log
// 每个请求行 = {"request":{"conversationState":{"conversationId","history":[...],"currentMessage":{...}}}}，
// history 随轮次累积 → 每会话取最长 history + 各请求 currentMessage 即可拼出全量对话。
// 429 限流产生的 {"request":{"$metadata":{...}}} 行没有 conversationState，自然跳过。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readJsonl } from '../util.js';
import { upsertSession } from '../db.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { log } from '../log.js';

const GATE_KEY = 'kiro-chatlogs://global'; // 回填总闸指纹：全部日志 stat 哈希 + json 重写脏标记
const BACKFILL_VERSION = 2; // 重建算法版本：逻辑变更时 +1，强制全量重扫重灌
const MAX_TOOL_JSON = 4000; // 与 claude adapter 一致：TodoWrite 类任务清单需要完整 JSON
const MAX_RESULT_TEXT = 2000;

export function logsRoot() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Kiro', 'logs') : null;
}

function wsSessionsDir() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions') : null;
}

/** 全部 Chat API 请求日志（含轮转的 .1.log），mtime 升序 ≈ 时间序 */
function chatApiLogs() {
  const root = logsRoot();
  if (!root || !fs.existsSync(root)) return [];
  return listFiles(root, '.log')
    .filter((f) => /Chat API/i.test(path.basename(f.path)))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

const isoMs = (ms) => (typeof ms === 'number' && ms ? new Date(ms).toISOString() : null);

/** content（字符串/数组/对象）→ 文本 */
function toText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(toText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    for (const k of ['text', 'content', 'value']) {
      if (content[k] != null) return toText(content[k]);
    }
    return '';
  }
  return String(content);
}

/** 用户输入剥离请求层注入的 EnvironmentContext（打开的文件/激活编辑器等噪音） */
function cleanUserText(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/<EnvironmentContext>[\s\S]*?<\/EnvironmentContext>/g, '')
    .replace(/<EnvironmentContext>[\s\S]*$/i, '') // 半写块兜底
    .trim();
}

/** Kiro 把系统注入也记成 user 历史，且每次请求重复注入一份（数百份 16KB 噪音会淹没真实发言） */
const INJECT_PREFIXES = ['<key_kiro_features>', 'You are operating in a workspace', '## Included Rules ('];
const isSystemInjection = (s) => INJECT_PREFIXES.some((p) => s.startsWith(p));

/** 解析单个日志文件 → Map(conversationId -> {history, lastCurrent, hits}) */
async function parseLogFile(file) {
  const convs = new Map();
  await readJsonl(file.path, (obj) => {
    const cs = obj?.request?.conversationState;
    const id = cs?.conversationId;
    if (!id) return true;
    let c = convs.get(id);
    if (!c) {
      c = { history: [], lastCurrent: null, hits: 0 };
      convs.set(id, c);
    }
    const h = Array.isArray(cs.history) ? cs.history : [];
    if (h.length > c.history.length) c.history = h; // 只保留最长的历史快照
    if (cs.currentMessage) c.lastCurrent = cs.currentMessage;
    c.hits++;
    return true;
  });
  return convs;
}

/** 跨文件合并（会话可能跨 IDE 启动续聊） */
async function collectConversations(logs) {
  const merged = new Map();
  for (const file of logs) {
    let part;
    try {
      part = await parseLogFile(file);
    } catch (err) {
      log.warn('sync', `kiro 回填: ${path.basename(file.path)} 解析失败 ${err.message}`);
      continue;
    }
    for (const [id, c] of part) {
      const m = merged.get(id);
      if (!m) {
        merged.set(id, { ...c });
        continue;
      }
      if (c.history.length > m.history.length) m.history = c.history;
      if (c.lastCurrent) m.lastCurrent = c.lastCurrent; // mtime 升序，后写胜
      m.hits += c.hits;
    }
  }
  return merged;
}

/** history/currentMessage 条目 → 归档消息列表（约定与 claude adapter 对齐） */
function toMessages(conv) {
  const messages = [];
  const push = (role, text, raw) => {
    const t = String(text ?? '');
    if (t.trim()) messages.push({ role, createdAt: null, text: t, raw: raw ?? null });
  };
  const nameById = new Map(); // toolUseId -> 工具名（结果标注用）
  let lastUserText = null;

  const resultText = (tr) => {
    const c = tr?.content;
    const t = Array.isArray(c)
      ? c.map((x) => x?.text ?? (x?.json != null ? JSON.stringify(x.json) : '')).filter(Boolean).join('\n')
      : toText(c);
    return t.slice(0, MAX_RESULT_TEXT);
  };
  const emitUser = (um) => {
    const trs = um?.userInputMessageContext?.toolResults;
    if (Array.isArray(trs) && trs.length) {
      push('tool', trs.map((r) => {
        const name = nameById.get(r?.toolUseId);
        const st = r?.status && r.status !== 'success' ? `!${r.status}` : '';
        return `[tool_result${name ? ':' + name : ''}${st}] ${resultText(r)}`;
      }).join('\n'), { type: 'tool_result' });
    }
    const text = cleanUserText(um?.content);
    if (text && !isSystemInjection(text)) {
      push('user', text);
      lastUserText = text;
    }
  };
  const emitAssistant = (am) => {
    const text = toText(am?.content);
    const tus = Array.isArray(am?.toolUses) ? am.toolUses : [];
    for (const t of tus) if (t?.toolUseId) nameById.set(t.toolUseId, t.name || t.toolUseId);
    if (tus.length) {
      // 含工具调用的轮次归 tool 角色（claude adapter 同约定），纯文本才是 assistant
      push('tool', [text, ...tus.map((t) => `[tool:${t?.name || '?'}] ${JSON.stringify(t?.input ?? {}).slice(0, MAX_TOOL_JSON)}`)]
        .filter(Boolean).join('\n'), { type: 'assistant_tool' });
    } else {
      push('assistant', text);
    }
  };

  for (const h of Array.isArray(conv.history) ? conv.history : []) {
    if (h?.userInputMessage) emitUser(h.userInputMessage);
    else if (h?.assistantResponseMessage) emitAssistant(h.assistantResponseMessage);
  }
  // 最后一个用户请求从未进入任何 history（末次请求 429 后放弃/会话结束）→ 补进对话
  const last = conv.lastCurrent?.userInputMessage;
  if (last) {
    const text = cleanUserText(last.content);
    if (text && text !== lastUserText) emitUser(last);
  }
  return messages;
}

/** workspace-sessions 元数据：convId -> 所属目录 / sessions.json 索引条目（懒读） */
function wsIndexLoader() {
  const root = wsSessionsDir();
  const fileOwner = new Map(); // convId -> 工作区目录
  if (root && fs.existsSync(root)) {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(root, e.name);
      try {
        for (const f of fs.readdirSync(d)) {
          if (f.endsWith('.json') && f !== 'sessions.json') fileOwner.set(f.slice(0, -5), d);
        }
      } catch { /* 目录不可读跳过 */ }
    }
  }
  const idxCache = new Map(); // dir -> Map(sessionId -> entry)
  const loadIdx = (d) => {
    if (!idxCache.has(d)) {
      const m = new Map();
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(d, 'sessions.json'), 'utf8'));
        if (Array.isArray(arr)) for (const e of arr) if (e?.sessionId) m.set(e.sessionId, e);
      } catch { /* 无索引 */ }
      idxCache.set(d, m);
    }
    return idxCache.get(d);
  };
  return { fileOwner, loadIdx };
}

function buildSession(id, conv, wsIndex) {
  const messages = toMessages(conv);
  if (!messages.length) return null;
  const dir = wsIndex.fileOwner.get(id);
  const ent = dir ? wsIndex.loadIdx(dir).get(id) : null;
  const firstUser = messages.find((m) => m.role === 'user');
  const created = isoMs(ent?.dateCreated);
  return {
    agentSessionId: id,
    workspacePath: ent?.workspaceDirectory ? normalizeWorkspacePath(ent.workspaceDirectory) : null,
    title: String(ent?.title || firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
    createdAt: created,
    updatedAt: created,
    messages,
  };
}

/**
 * 日志回填入口。总闸指纹 = 全部日志 stat 哈希 + json 重写脏标记：
 * json 文件本轮被重写时（touched 非空）即使日志没变也要重扫——
 * 否则稀疏 json 解析会覆盖掉已回填的富内容。
 * 返回 {created, updated} 计入本轮 summary；无变化返回 null。
 */
export async function backfillKiroFromLogs(db, touched = new Set()) {
  const logs = chatApiLogs();
  const fp = crypto.createHash('sha1').update(
    `v${BACKFILL_VERSION}|` + logs.map((f) => `${f.path}:${f.size}:${f.mtimeMs}`).join('|') + (touched.size ? '|dirty' : '')
  ).digest('hex');
  const gate = db.prepare('SELECT fingerprint FROM sync_state WHERE source_path = ?').get(GATE_KEY);
  if (gate && gate.fingerprint === fp) return null;

  const t0 = Date.now();
  const convs = await collectConversations(logs);
  const wsIndex = wsIndexLoader();
  const summary = { created: 0, updated: 0 };
  const getFp = db.prepare('SELECT fingerprint FROM sync_state WHERE source_path = ?');
  for (const [id, conv] of convs) {
    const parsed = buildSession(id, conv, wsIndex);
    if (!parsed) continue;
    const contentFp = crypto.createHash('sha1').update(JSON.stringify(parsed.messages)).digest('hex');
    const sourcePath = `kiro-chatlog://${id}`;
    const prev = getFp.get(sourcePath);
    if (!touched.has(id) && prev && prev.fingerprint === contentFp) continue;
    const r = upsertSession(db, 'kiro', sourcePath, contentFp, parsed);
    summary[r === 'created' ? 'created' : 'updated']++;
  }
  db.prepare(
    `INSERT INTO sync_state(source_path, agent, fingerprint, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET fingerprint=excluded.fingerprint, synced_at=excluded.synced_at, agent=excluded.agent`
  ).run(GATE_KEY, 'kiro', fp, new Date().toISOString());
  log.info('sync', `kiro 日志回填: ${convs.size} 会话, +${summary.created} 新建 / ${summary.updated} 回填, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return summary;
}
