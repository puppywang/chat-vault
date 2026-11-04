// Pi 会话里「哪个 ChatGPT 对话做了什么」：pi 的 jsonl 里每条由 Chappie 产生的 assistant 记录都带
// message.chappie = { chatId, requestId: "wfr_<hex>/<分支>" }，而 ChatGPT 对话的消息 metadata.request_id 是同一个 wfr_<hex>。
// 据此按请求 ID 汇总 pi 侧的真实活动（工具调用次数、改过的文件、首末时间），让 ChatGPT 说「没连上 / 没改」时有据可查。
//
// 会话文件可达 1GB（总量 2.4GB，2026-10-12），所以：只索引被问到的会话；按字节偏移增量读追加部分；只解析含 "chappie" 的行；
// 索引落盘（~/.chat-vault/pi-activity-index.json），重启后从断点继续。首次建索引在后台跑，查询不等它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_REQUESTS_PER_FILE = 300;
const MAX_FILES_PER_REQUEST = 60;
const SAVE_DEBOUNCE_MS = 2000;
const EDIT_TOOLS = new Set(['edit', 'write']);

const requestBase = id => (typeof id === 'string' ? (/^(wfr_[0-9a-f]{16,64})/i.exec(id)?.[1] || null) : null)?.toLowerCase() || null;

/** 一行 jsonl → 若是 Chappie 发起的 assistant 记录，返回 { base, chatTail, at, tools: [{name, path}] } */
export function activityOf(line) {
  if (!line.includes('"chappie"')) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const message = entry?.message;
  if (entry?.type !== 'message' || message?.role !== 'assistant' || !message.chappie) return null;
  const base = requestBase(message.chappie.requestId);
  if (!base) return null;
  const tools = [];
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part?.type !== 'toolCall' || typeof part.name !== 'string') continue;
    const args = part.arguments || {};
    const p = args.path || args.file_path || args.filePath || null;
    tools.push({ name: part.name, path: typeof p === 'string' ? p : null });
  }
  const text = (Array.isArray(message.content) ? message.content : []).some(c => c?.type === 'text' && c.text?.trim());
  return { base, chatTail: String(message.chappie.chatId || '').slice(-4), at: entry.timestamp || null, tools, text };
}

export function createActivityIndex({ homeDir = os.homedir(), fsImpl = fs, sessionsRoot = path.join(homeDir, '.pi', 'agent', 'sessions'),
  indexFile = path.join(homeDir, '.chat-vault', 'pi-activity-index.json'), saveDelayMs = SAVE_DEBOUNCE_MS } = {}) {
  let index = { version: 1, files: {} };
  try { const loaded = JSON.parse(fsImpl.readFileSync(indexFile, 'utf8')); if (loaded?.version === 1 && loaded.files) index = loaded; } catch { /* 首次或坏文件：重建 */ }
  const running = new Map();   // file -> Promise
  let saveTimer = null;
  const pathCache = new Map(); // sessionId -> file

  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fsImpl.mkdirSync(path.dirname(indexFile), { recursive: true });
        fsImpl.writeFileSync(`${indexFile}.tmp`, JSON.stringify(index));
        fsImpl.renameSync(`${indexFile}.tmp`, indexFile);
      } catch { /* 索引写不进不影响查询 */ }
    }, saveDelayMs);
    saveTimer.unref?.();
  }

  function fileOf(sessionId) {
    const cached = pathCache.get(sessionId);
    if (cached && fsImpl.existsSync(cached)) return cached;
    let dirs = [];
    try { dirs = fsImpl.readdirSync(sessionsRoot); } catch { return null; }
    for (const dir of dirs) {
      let files = [];
      try { files = fsImpl.readdirSync(path.join(sessionsRoot, dir)); } catch { continue; }
      const hit = files.find(f => f.endsWith(`_${sessionId}.jsonl`));
      if (hit) { const full = path.join(sessionsRoot, dir, hit); pathCache.set(sessionId, full); return full; }
    }
    return null;
  }

  function record(state, a) {
    const r = state.requests[a.base] ||= { chatTail: a.chatTail, calls: 0, byTool: {}, files: [], filesCount: 0, first: a.at, last: a.at, replies: 0 };
    if (a.at && (!r.first || a.at < r.first)) r.first = a.at;
    if (a.at && (!r.last || a.at > r.last)) r.last = a.at;
    if (a.text) r.replies++;
    for (const t of a.tools) {
      r.calls++;
      r.byTool[t.name] = (r.byTool[t.name] || 0) + 1;
      if (EDIT_TOOLS.has(t.name) && t.path && !r.files.includes(t.path)) {
        r.filesCount++;
        if (r.files.length < MAX_FILES_PER_REQUEST) r.files.push(t.path);
      }
    }
  }

  function trim(state) {
    const keys = Object.keys(state.requests);
    if (keys.length <= MAX_REQUESTS_PER_FILE) return;
    keys.sort((a, b) => String(state.requests[a].last).localeCompare(String(state.requests[b].last)));
    for (const k of keys.slice(0, keys.length - MAX_REQUESTS_PER_FILE)) delete state.requests[k];
  }

  /** 从上次的字节偏移读到文件尾；文件变小（被重写）就从头来 */
  function update(file) {
    if (running.has(file)) return running.get(file);
    const task = (async () => {
      let size;
      try { size = fsImpl.statSync(file).size; } catch { return; }
      let state = index.files[file];
      if (!state || state.offset > size) state = index.files[file] = { offset: 0, size: 0, requests: {} };
      if (state.offset === size) return;
      await new Promise((resolve) => {
        const stream = fsImpl.createReadStream(file, { start: state.offset, end: size - 1 });
        let carry = Buffer.alloc(0);
        let consumed = state.offset;
        stream.on('data', (chunk) => {
          let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
          let start = 0;
          for (let nl = buf.indexOf(10, start); nl !== -1; nl = buf.indexOf(10, start)) {
            const line = buf.toString('utf8', start, nl);
            const a = activityOf(line);
            if (a) record(state, a);
            consumed += nl - start + 1;
            start = nl + 1;
          }
          carry = buf.subarray(start);
        });
        stream.on('end', () => { state.offset = consumed; state.size = size; resolve(); });   // 未换行的尾巴留到下次
        stream.on('error', () => resolve());
      });
      trim(state);
      save();
    })().finally(() => running.delete(file));
    running.set(file, task);
    return task;
  }

  /**
   * 汇总这些会话里属于这些请求 ID 的活动。waitMs 内能读完就带最新结果，读不完先回已有的并标 indexing。
   */
  async function query({ sessionIds = [], requestIds = [], waitMs = 1500 } = {}) {
    const bases = new Set(requestIds.map(requestBase).filter(Boolean));
    const files = [...new Set(sessionIds)].map(id => [id, fileOf(id)]).filter(([, f]) => f);
    const pendingTasks = files.map(([, f]) => update(f));
    let indexing = false;
    if (pendingTasks.length) {
      const done = Promise.all(pendingTasks).then(() => true);
      indexing = !(await Promise.race([done, new Promise(r => setTimeout(() => r(false), waitMs))]));
    }
    const activity = [];
    if (bases.size) {
      for (const [sessionId, file] of files) {
        const state = index.files[file];
        if (!state) continue;
        for (const base of bases) {
          const r = state.requests[base];
          if (r) activity.push({ sessionId, requestId: base, ...r, files: r.files.slice(0, 30) });
        }
      }
    }
    activity.sort((a, b) => String(b.last).localeCompare(String(a.last)));
    return { activity, indexing };
  }

  /**
   * 每个会话最近被哪些请求（≈ ChatGPT 对话的一次执行）驱动过，按最近活动倒序。一个 pi 会话常被多个对话同时驱动
   * （实测 art-ios：…5ean 与 …uGGu），所以返回列表而不是一个。waitMs 很短：列表接口不能被首次建索引拖慢。
   */
  async function recent({ sessionIds = [], limit = 5, waitMs = 300 } = {}) {
    const files = [...new Set(sessionIds)].map(id => [id, fileOf(id)]).filter(([, f]) => f);
    const tasks = files.map(([, f]) => update(f));
    let indexing = false;
    if (tasks.length) indexing = !(await Promise.race([Promise.all(tasks).then(() => true), new Promise(r => setTimeout(() => r(false), waitMs))]));
    const out = new Map();
    for (const [sessionId, file] of files) {
      const reqs = Object.entries(index.files[file]?.requests || {}).map(([requestId, r]) => ({ requestId, chatTail: r.chatTail, calls: r.calls, filesCount: r.filesCount, first: r.first, last: r.last }));
      reqs.sort((a, b) => String(b.last).localeCompare(String(a.last)));
      out.set(sessionId, { last: reqs[0]?.last || null, total: reqs.length, recent: reqs.slice(0, limit) });
    }
    return { bySession: out, indexing };
  }

  return { query, recent, update, fileOf, _index: () => index };
}
