// Codex Cloud 根线程 ↔ ChatGPT 网页对话：给 chatgpt-sync 弹窗的「Codex Cloud 线程」列表补标题和来源对话。
//
// thread/list 不带标题，也不带是从哪个对话发起的，这里用两类本地证据补：
//   1. ChatVault 已归档的 Codex Cloud 线程（agent = codex-cloud，agent_session_id = codex-<thread>）→ 标题、消息数；
//   2. 已归档的 ChatGPT 对话（~/.chat-vault/imports/chatgpt/live/*.json）：
//      - 协作工具调用元数据里的 senderThreadId 等于线程 ID → 确认（Work 模式的主线程就是 sender）；
//      - 对话正文里出现线程的工作目录 /workspace/scratch/<hex> → 候选（目录名会被引用、复述，不当身份证明）。
//   扩展自己记下的「对话 → 线程」（cvCodexLinkV1 / cvWorkRoundV1）由弹窗合并，这里只负责给这些对话补标题。
// 只读本地文件和库里有索引的列（UNIQUE(agent, agent_session_id)），不扫消息表。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE = /\/workspace\/scratch\/[0-9a-f]{6,}(?![\w-])/gi;
const MAX_IDS = 500;

/** 一段已归档对话里的 Codex 证据：senderThreadId（确认）与工作目录（候选）。 */
export function conversationCodexEvidence(conv) {
  const senders = new Set(), workspaces = new Set();
  for (const node of Object.values(conv?.mapping || {})) {
    const m = node?.message;
    if (!m) continue;
    const call = m.metadata?.codex_collab_agent_tool_call;
    if (call && UUID.test(call.senderThreadId || '')) senders.add(call.senderThreadId.toLowerCase());
    const text = JSON.stringify(m.content || '');
    for (const match of text.matchAll(WORKSPACE)) workspaces.add(match[0]);
  }
  return { senders: [...senders], workspaces: [...workspaces] };
}

export function createCodexThreadLinks({ homeDir = os.homedir(), fsImpl = fs,
  liveDir = path.join(homeDir, '.chat-vault', 'imports', 'chatgpt', 'live') } = {}) {
  const cache = new Map();   // file -> { key, entry }

  /** 按文件 mtime+size 增量解析；首次约 1 秒量级（实测 57 个文件 93MB）。 */
  function scan() {
    let names = [];
    try { names = fsImpl.readdirSync(liveDir).filter(n => n.endsWith('.json')); } catch { return []; }
    const alive = new Set();
    const entries = [];
    for (const name of names) {
      const file = path.join(liveDir, name);
      alive.add(file);
      let stat;
      try { stat = fsImpl.statSync(file); } catch { continue; }
      const key = `${stat.mtimeMs}:${stat.size}`;
      let hit = cache.get(file);
      if (!hit || hit.key !== key) {
        let entry = null;
        try {
          const conv = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
          const id = conv?.conversation_id || conv?.id;
          if (UUID.test(id || '')) {
            entry = { conversationId: id.toLowerCase(), title: conv.title || null,
              updatedAt: Number.isFinite(conv.update_time) ? new Date(conv.update_time * 1000).toISOString() : null,
              ...conversationCodexEvidence(conv) };
          }
        } catch { /* 写到一半或损坏的文件：下次 mtime 变了再读 */ }
        hit = { key, entry };
        cache.set(file, hit);
      }
      if (hit.entry) entries.push(hit.entry);
    }
    for (const file of cache.keys()) if (!alive.has(file)) cache.delete(file);
    return entries;
  }

  function lookupSessions(db, agent, ids) {
    const out = new Map();
    if (!db || !ids.length) return out;
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const marks = chunk.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, agent_session_id, title, message_count, updated_at FROM sessions
        WHERE agent = ? AND agent_session_id IN (${marks})`).all(agent, ...chunk);
      for (const r of rows) out.set(r.agent_session_id, { sessionId: r.id, title: r.title,
        messageCount: r.message_count, updatedAt: r.updated_at });
    }
    return out;
  }

  /**
   * threads: [{ threadId, cwd }]；conversationIds: 扩展本地记下的关联对话（只补标题）。
   * 返回 { threads: { [threadId]: { chatvault, links: [{ conversationId, title, updatedAt, via }] } },
   *        conversations: { [conversationId]: { title, updatedAt, sessionId } } }
   */
  function annotate(db, { threads = [], conversationIds = [] } = {}) {
    const list = threads.filter(t => UUID.test(t?.threadId || '')).slice(0, MAX_IDS)
      .map(t => ({ threadId: t.threadId.toLowerCase(), cwd: typeof t.cwd === 'string' ? t.cwd : null }));
    const convIds = [...new Set(conversationIds.filter(id => UUID.test(id || '')).map(id => id.toLowerCase()))].slice(0, MAX_IDS);
    const entries = scan();
    const archived = lookupSessions(db, 'codex-cloud', list.map(t => `codex-${t.threadId}`));
    const out = {};
    for (const t of list) {
      const links = [];
      for (const e of entries) {
        const via = e.senders.includes(t.threadId) ? 'sender'
          : t.cwd && e.workspaces.includes(t.cwd) ? 'workspace' : null;
        if (via) links.push({ conversationId: e.conversationId, title: e.title, updatedAt: e.updatedAt, via });
      }
      links.sort((a, b) => (a.via === b.via ? 0 : a.via === 'sender' ? -1 : 1) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
      out[t.threadId] = { chatvault: archived.get(`codex-${t.threadId}`) || null, links: links.slice(0, 5) };
    }
    const byId = new Map(entries.map(e => [e.conversationId, e]));
    const fromDb = lookupSessions(db, 'chatgpt', convIds.filter(id => !byId.has(id)));
    const conversations = {};
    for (const id of convIds) {
      const e = byId.get(id), r = fromDb.get(id);
      if (e || r) conversations[id] = { title: e?.title || r?.title || null, updatedAt: e?.updatedAt || r?.updatedAt || null,
        sessionId: r?.sessionId ?? null };
    }
    return { threads: out, conversations };
  }

  return { annotate, _scan: scan };
}
