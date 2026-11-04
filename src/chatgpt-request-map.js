// ChatGPT 请求 ID（wfr_…，Temporal workflow）→ 对话（id、标题）。Pi 侧每条 Chappie 记录只带请求 ID 和 chatId，
// 不带 /c/ 对话 ID；有了这张表，pi 会话就能列出「最近是哪些 ChatGPT 对话在驱动它」。
// 来源：扩展每次同步对话入库时记录（ingest）；已归档的 imports/chatgpt/live/*.json 后台一次性回填。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WFR = /^(wfr_[0-9a-f]{16,64})/i;
const MAX_ENTRIES = 5000;

export function requestIdsOf(conv) {
  const ids = new Set();
  for (const node of Object.values(conv?.mapping || {})) {
    const id = WFR.exec(String(node?.message?.metadata?.request_id || ''))?.[1];
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids];
}

export function createRequestMap({ homeDir = os.homedir(), fsImpl = fs,
  file = path.join(homeDir, '.chat-vault', 'chatgpt-request-map.json'),
  liveDir = path.join(homeDir, '.chat-vault', 'imports', 'chatgpt', 'live'), saveDelayMs = 1500 } = {}) {
  let map = { version: 1, backfilledAt: null, requests: {} };
  try { const loaded = JSON.parse(fsImpl.readFileSync(file, 'utf8')); if (loaded?.version === 1 && loaded.requests) map = loaded; } catch { /* 首次 */ }
  let saveTimer = null, backfill = null;

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const keys = Object.keys(map.requests);
        if (keys.length > MAX_ENTRIES) {
          keys.sort((a, b) => String(map.requests[a].updatedAt).localeCompare(String(map.requests[b].updatedAt)));
          for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map.requests[k];
        }
        fsImpl.mkdirSync(path.dirname(file), { recursive: true });
        fsImpl.writeFileSync(`${file}.tmp`, JSON.stringify(map));
        fsImpl.renameSync(`${file}.tmp`, file);
      } catch { /* 写不进不影响查询 */ }
    }, saveDelayMs);
    saveTimer.unref?.();
  }

  function record(conv) {
    const conversationId = String(conv?.conversation_id || conv?.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return 0;   // dots- / codex- 不是 /c/ 对话
    const title = typeof conv.title === 'string' ? conv.title.slice(0, 120) : null;
    const updatedAt = Number.isFinite(conv.update_time) ? new Date(conv.update_time * 1000).toISOString() : new Date().toISOString();
    let n = 0;
    for (const id of requestIdsOf(conv)) {
      const prev = map.requests[id];
      if (prev?.conversationId === conversationId && prev.title === title && prev.updatedAt === updatedAt) continue;
      map.requests[id] = { conversationId, title, updatedAt };
      n++;
    }
    if (n) save();
    return n;
  }

  /** 已归档对话一次性回填（只做一次；文件逐个解析，不阻塞调用方） */
  function ensureBackfill() {
    if (map.backfilledAt || backfill) return backfill;
    backfill = (async () => {
      let files = [];
      try { files = fsImpl.readdirSync(liveDir).filter(f => /^[0-9a-f-]{36}\.json$/i.test(f)); } catch { files = []; }
      for (const f of files) {
        try { record(JSON.parse(await fsImpl.promises.readFile(path.join(liveDir, f), 'utf8'))); } catch { /* 单个坏文件跳过 */ }
        await new Promise(resolve => setImmediate(resolve));   // 每个文件之间让出事件循环
      }
      map.backfilledAt = new Date().toISOString();
      save();
    })().finally(() => { backfill = null; });
    return backfill;
  }

  function lookup(requestId) {
    const id = WFR.exec(String(requestId || ''))?.[1]?.toLowerCase();
    return id ? map.requests[id] || null : null;
  }

  return { record, lookup, ensureBackfill, _map: () => map };
}
