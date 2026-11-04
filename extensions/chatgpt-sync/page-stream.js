// MAIN world transport hook; parsing is shared with the offline replay runner.
(() => {
  const MARKER = '__chatVaultStreamMetricsV1';
  if (window[MARKER] || typeof window.fetch !== 'function' || !globalThis.ChatVaultStreamParser) return;
  window[MARKER] = true;
  const nativeFetch = window.fetch, nativeWebSocket = window.WebSocket;
  const observers = new Map();
  const readers = new Set();
  let enabled = true;
  let epoch = 0;
  let controlInstance = 0;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.__chatVaultStreamControlV1 !== true) return;
    // 只听最新的隔离实例（见 page-state.js）。
    const from = Number.isFinite(event.data.instance) ? event.data.instance : 0;
    if (from < controlInstance) return;
    controlInstance = from;
    const next = event.data.enabled === true;
    if (next !== enabled) epoch++;
    enabled = next;
    if (!enabled) {
      observers.clear();
      for (const reader of readers) void reader.cancel().catch(() => {});
      readers.clear();
    }
  });
  let nextRequestId = 0;
  function register(id, parser) {
    if (!id) return;
    observers.delete(id); observers.set(id, parser);
    if (observers.size > 8) observers.delete(observers.keys().next().value);
  }
  function matches(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href);
      return String(init?.method || input?.method || 'GET').toUpperCase() === 'POST'
        && ['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
        && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname);
    } catch { return false; }
  }
  async function observe(responsePromise, startedAtMs, init) {
    const generation = epoch;
    const current = () => enabled && generation === epoch;
    const requestId = ++nextRequestId;
    let body;
    try { if (typeof init?.body === 'string') body = JSON.parse(init.body); } catch { /* stream identifies it */ }
    let id = body?.conversation_id || /^\/c\/([0-9a-fA-F-]{36})/.exec(location.pathname)?.[1] || null;
    let parser;
    parser = ChatVaultStreamParser.createParser({ conversationId: id, requestStartMs: startedAtMs,
      userMessageId: body?.messages?.findLast(m => m.author?.role === 'user')?.id || null,
      onProgress(state) {
        if (!current()) return;
        if (state.conversationId !== id) {
          if (observers.get(id) === parser) observers.delete(id);
          id = state.conversationId; register(id, parser);
        }
        window.postMessage({ [MARKER]: true, requestId, ...state }, location.origin);
      },
      onText(sample) { if (current()) window.postMessage({ [MARKER]: true, kind: 'tokenize', requestId, ...sample }, location.origin); },
    });
    register(id, parser);
    window.postMessage({ [MARKER]: true, requestId, ...parser.state }, location.origin);
    try {
      const response = await responsePromise;
      if (!current()) return;
      if (!response?.ok || !/text\/event-stream/i.test(response.headers?.get('content-type') || '')) return;
      const reader = response.clone().body?.getReader();
      if (!reader) { parser.state.error = 'missing_stream_body'; parser.readFailed(); return; }
      readers.add(reader);
      try {
        while (current()) {
          const { done, value } = await reader.read();
          if (done || !current()) break;
          parser.consumeSseBytes(value, Date.now());
        }
        parser.endSse(Date.now());
      } finally { readers.delete(reader); reader.releaseLock(); }
    } catch { parser.readFailed(); }
  }
  // Codex 页面（chatgpt.com/local/<thread>）：codex-cloud-backend 的 JSON-RPC。
  // 客户端发 turn/start → 服务端推 turn/started、item/agentMessage/delta、item/reasoning/*Delta、turn/completed，
  // 另有 thread/tokenUsage/updated（线程累计 total）。方法名与参数结构核对自 VS Code Codex 扩展 26.917。
  const CODEX_WS = /^wss:\/\/codex-cloud-backend\.chatgpt\.com\//i;
  const CODEX_TEXT = new Set(['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta']);
  const codexThread = () => /^\/local\/([0-9a-f-]{36})/i.exec(location.pathname)?.[1]?.toLowerCase() || null;
  const codexTotals = new Map();       // threadId -> 最近一次累计 outputTokens
  let codexTurn = null;
  function codexPost(turn) {
    turn.progressTimer = null;
    if (!enabled || turn.generation !== epoch) return;
    window.postMessage({ [MARKER]: true, requestId: turn.requestId, conversationId: `codex-${turn.threadId}`,
      userMessageId: null, codexSend: turn.sent, requestStartMs: turn.requestStartMs,
      firstTextAtMs: turn.firstTextAtMs, lastTextAtMs: turn.lastTextAtMs, completedAtMs: turn.completedAtMs,
      outputTokens: turn.outputTokens, textChars: turn.textChars, textChunks: turn.textChunks,
      sseFrames: 0, wsFrames: turn.wsFrames, lastFrameAtMs: turn.lastFrameAtMs,
      serverTtfvtMs: null, error: null, eventShapes: [] }, location.origin);
  }
  function codexTokenize(turn) {
    turn.tokenTimer = null;
    if (!enabled || turn.generation !== epoch) return;
    for (const item of turn.items.values()) {
      if (!item.dirty || !item.text) continue;
      item.dirty = false;
      window.postMessage({ [MARKER]: true, kind: 'tokenize', requestId: turn.requestId,
        conversationId: `codex-${turn.threadId}`, requestStartMs: turn.requestStartMs, revision: ++item.revision,
        messageIndex: item.index, messageId: item.id, firstTextAtMs: turn.firstTextAtMs,
        lastTextAtMs: item.lastTextAtMs, textChunks: turn.textChunks, text: item.text }, location.origin);
    }
  }
  // 进度约 4 次/秒、分词约 1 次/秒；首段文本与结束时立即发。
  function codexFlush(turn, now = false) {
    if (now) {
      clearTimeout(turn.progressTimer); clearTimeout(turn.tokenTimer);
      codexPost(turn); codexTokenize(turn); return;
    }
    turn.progressTimer ??= setTimeout(() => codexPost(turn), 250);
    turn.tokenTimer ??= setTimeout(() => codexTokenize(turn), 1000);
  }
  function codexStart(threadId, atMs, sent, turnId = null) {
    if (codexTurn && !codexTurn.completedAtMs) codexFlush(codexTurn, true);
    codexTurn = { requestId: ++nextRequestId, generation: epoch, threadId, turnId, sent, requestStartMs: atMs,
      firstTextAtMs: null, lastTextAtMs: null, completedAtMs: null, outputTokens: null,
      baseline: codexTotals.get(threadId) ?? null, textChars: 0, textChunks: 0, wsFrames: 0, lastFrameAtMs: null,
      items: new Map(), progressTimer: null, tokenTimer: null };
    codexPost(codexTurn);
    return codexTurn;
  }
  /** 当前这一轮；页面打开时轮次已在跑（没看到 turn/start）就按首个事件建一轮，只算 TPS 不算 TTFT。 */
  function codexCurrent(threadId, turnId, now) {
    const turn = codexTurn;
    if (turn && turn.threadId === threadId && !turn.completedAtMs && (!turnId || !turn.turnId || turn.turnId === turnId)) {
      turn.turnId ||= turnId;
      return turn;
    }
    return codexStart(threadId, now, false, turnId);
  }
  function onCodexSend(data) {
    if (!enabled || typeof data !== 'string' || !data.includes('"turn/start"')) return;
    let parsed; try { parsed = JSON.parse(data); } catch { return; }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const threadId = String(message?.params?.threadId || '').toLowerCase();
      if (message?.method === 'turn/start' && threadId && threadId === codexThread()) codexStart(threadId, Date.now(), true);
    }
  }
  function onCodexMessage(data) {
    if (!enabled || typeof data !== 'string' || !data.includes('"method"')) return;
    let parsed; try { parsed = JSON.parse(data); } catch { return; }
    const now = Date.now(), page = codexThread();
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const method = message?.method, params = message?.params;
      const threadId = String(params?.threadId || '').toLowerCase();
      if (!method || !threadId) continue;
      if (method === 'thread/tokenUsage/updated') {
        const total = params.tokenUsage?.total?.outputTokens;
        if (Number.isFinite(total)) codexTotals.set(threadId, total);
        const turn = codexTurn;
        if (turn && turn.threadId === threadId && Number.isFinite(total) && Number.isFinite(turn.baseline)) {
          turn.outputTokens = Math.max(0, total - turn.baseline);
          codexFlush(turn);
        }
        continue;
      }
      if (threadId !== page) continue;   // 子 agent 等其他线程不算本页这一轮
      if (method === 'turn/started') {
        const turn = codexTurn;
        if (turn && turn.threadId === threadId && turn.sent && !turn.turnId && !turn.completedAtMs) turn.turnId = params.turn?.id || null;
        else codexStart(threadId, now, false, params.turn?.id || null);
      } else if (CODEX_TEXT.has(method) && typeof params.delta === 'string' && params.delta) {
        const turn = codexCurrent(threadId, params.turnId || null, now);
        const key = params.itemId || method;
        let item = turn.items.get(key);
        if (!item) turn.items.set(key, item = { id: key, index: turn.items.size, text: '', revision: 0, dirty: false, lastTextAtMs: now });
        item.text += params.delta;
        item.dirty = true;
        item.lastTextAtMs = now;
        const first = turn.firstTextAtMs == null;
        turn.firstTextAtMs ??= now;
        turn.lastTextAtMs = now;
        turn.textChars += params.delta.length;
        turn.textChunks++;
        turn.wsFrames++;
        turn.lastFrameAtMs = now;
        codexFlush(turn, first);
      } else if (method === 'turn/completed') {
        const turn = codexTurn;
        if (!turn || turn.threadId !== threadId || turn.completedAtMs) continue;
        if (turn.turnId && params.turn?.id && params.turn.id !== turn.turnId) continue;
        turn.completedAtMs = now;
        codexFlush(turn, true);
      }
    }
  }

  // Codex 页卡在「正在加载…」时，用它看是哪个 JSON-RPC 请求没有回应（只记方法名、时刻和错误，不记内容）。
  // 读取：页面 MAIN 世界里 window.__cvCodexRpc.snapshot()（CDP Runtime.evaluate 即可）。
  const rpc = { sockets: 0, events: [], pending: new Map(), done: [], notices: new Map() };
  const rpcNote = (kind, extra) => { rpc.events.push({ at: Date.now(), kind, ...extra }); if (rpc.events.length > 50) rpc.events.shift(); };
  function rpcSend(data, socketNo) {
    if (typeof data !== 'string' || data.length > 200000) return;
    let parsed; try { parsed = JSON.parse(data); } catch { return; }
    if (codexThread() !== armedThread) watchOpen();   // 页面内切到另一个线程
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m?.id == null || typeof m.method !== 'string') continue;
      const threadId = m.method === 'thread/resume' ? String(m.params?.threadId || '').toLowerCase() || null : null;
      if (threadId && threadId === codexThread()) resumeSeen = true;
      rpc.pending.set(`${socketNo}:${m.id}`, { socket: socketNo, id: String(m.id), method: m.method, sentAt: Date.now(), threadId });
      if (rpc.pending.size > 200) rpc.pending.delete(rpc.pending.keys().next().value);
    }
  }

  // 打开线程页的结果：后端还挂着会话时页面不发 thread/resume（直接可用）；要恢复时，成功返回 resumeKind，
  // 失败就一直卡在「正在加载模型」（2026-10-14 01a0c2a3：-32603，grpcStatusCode 9）。后端没有只读接口能提前查，
  // 所以只记实际观察到的结果，交给内容脚本存起来，弹窗的线程列表显示。
  const RESUME_MARKER = '__cvCodexResumeV1';
  let resumeSeen = false, openTimer = null, armedThread = null;
  const postOpen = (threadId, outcome, extra = {}) => {
    if (!threadId) return;
    try { window.postMessage({ [RESUME_MARKER]: true, threadId, outcome, at: Date.now(), ...extra }, location.origin); } catch { /* 观测失败不影响页面 */ }
  };
  function watchOpen() {
    // 连接建立后 20 秒内本页线程没发 thread/resume，就记为「直接打开」。
    clearTimeout(openTimer);
    resumeSeen = false;
    const threadId = armedThread = codexThread();
    if (!threadId) return;
    openTimer = setTimeout(() => { if (!resumeSeen && codexThread() === threadId) postOpen(threadId, 'warm'); }, 20000);
  }
  function resumeFinished(req, data, error) {
    if (!req.threadId) return;
    let resumeKind = null;
    if (!error) { try { resumeKind = JSON.parse(data)?.result?.resumeKind ?? null; } catch { /* 结果太大或不是 JSON */ } }
    postOpen(req.threadId, error ? 'failed' : 'resumed', { ms: Date.now() - req.sentAt, resumeKind, error });
  }
  function rpcReceive(data, socketNo) {
    if (typeof data !== 'string') return;
    const head = data.slice(0, 400);
    // 服务端推送的通知（没有 id、有 method）：只数方法名和首末时刻，页面可能在等某个通知。
    const notice = /^\s*\{\s*"method"\s*:\s*"([^"]{1,80})"/.exec(head)?.[1];
    if (notice) {
      const n = rpc.notices.get(notice) || { method: notice, count: 0, firstAt: Date.now() };
      n.count++; n.lastAt = Date.now();
      rpc.notices.set(notice, n);
      if (rpc.notices.size > 100) rpc.notices.delete(rpc.notices.keys().next().value);
    }
    const id = /^\s*\{\s*"id"\s*:\s*(?:"([^"]+)"|(\d+))/.exec(head) || /"id"\s*:\s*(?:"([^"]+)"|(\d+))\s*,\s*"(?:result|error)"/.exec(head);
    if (!id) return;
    const key = `${socketNo}:${id[1] ?? id[2]}`, req = rpc.pending.get(key);
    if (!req) return;
    rpc.pending.delete(key);
    // error 对象里可能先有嵌套的 data（如 {"code":-32603,"data":{"grpcStatusCode":9},"message":…}），不能用 [^}] 截断。
    // 只认顶层的 error（成功结果里的条目也可能带 error 字段）。
    const topError = /^\s*\{\s*(?:"jsonrpc"\s*:\s*"[^"]*"\s*,\s*)?(?:"id"\s*:\s*(?:"[^"]*"|\d+)\s*,\s*)?"error"\s*:\s*\{/.exec(head);
    const error = !topError ? null
      : /"message"\s*:\s*"([^"]{0,160})/.exec(data.slice(topError[0].length, topError[0].length + 1200))?.[1] || '(error without message)';
    rpc.done.push({ ...req, ms: Date.now() - req.sentAt, error });
    if (rpc.done.length > 200) rpc.done.shift();
    if (req.method === 'thread/resume') resumeFinished(req, data, error);
  }
  window.__cvCodexRpc = { snapshot: (limit = 40) => {
    const now = Date.now();
    return { sockets: rpc.sockets, events: rpc.events.map(e => ({ ...e, agoMs: now - e.at })),
      pending: [...rpc.pending.values()].map(r => ({ ...r, waitingMs: now - r.sentAt })),
      recent: rpc.done.slice(-Math.min(200, Math.max(1, limit))),
      notices: [...rpc.notices.values()].map(n => ({ ...n, firstAgoMs: now - n.firstAt, lastAgoMs: now - n.lastAt })) };
  } };

  if (typeof nativeWebSocket === 'function') window.WebSocket = new Proxy(nativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      if (CODEX_WS.test(String(args[0]))) {
        try {
          const socketNo = ++rpc.sockets;
          rpcNote('create', { socket: socketNo });
          socket.addEventListener('open', () => { rpcNote('open', { socket: socketNo }); watchOpen(); });
          socket.addEventListener('close', e => rpcNote('close', { socket: socketNo, code: e.code, reason: String(e.reason || '').slice(0, 120) }));
          socket.addEventListener('error', () => rpcNote('error', { socket: socketNo }));
          const send = socket.send;
          socket.send = function (data) {
            try { onCodexSend(data); } catch { /* 观测失败不影响页面发送 */ }
            try { rpcSend(data, socketNo); } catch { /* 同上 */ }
            return send.call(this, data);
          };
          socket.addEventListener('message', e => {
            try { rpcReceive(e.data, socketNo); } catch { /* 同上 */ }
            try { onCodexMessage(e.data); } catch { /* 同上 */ }
          });
        } catch { /* 同上 */ }
        return socket;
      }
      socket.addEventListener('message', e => {
        if (!enabled) return;
        if (typeof e.data !== 'string' || (!e.data.includes('"stream-item"')
          && !e.data.includes('"conversation-turn-complete"'))) return;
        let items;
        try { items = JSON.parse(e.data); } catch { return; }
        for (const item of Array.isArray(items) ? items : [items]) {
          const envelope = item?.payload, entry = envelope?.payload;
          if (item?.type !== 'message' || !entry) continue;
          const parser = observers.get(entry.conversation_id);
          if (envelope.type === 'conversation-turn-stream' && entry.type === 'stream-item') {
            parser?.consumeWs(entry.encoded_item, Date.now(), entry.stream_item_id);
          } else if (envelope.type === 'conversation-turn-complete') parser?.finish(Date.now());
        }
      });
      return socket;
    },
  });
  window.fetch = function(...args) {
    if (!enabled || !matches(args[0], args[1])) return nativeFetch.apply(this, args);
    const at = Date.now(), response = nativeFetch.apply(this, args);
    void observe(response, at, args[1]).catch(() => {});
    return response;
  };
})();
