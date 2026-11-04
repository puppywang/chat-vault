// Read-only Codex lookup. No thread/start, resume, turn/start or source mutations.
(() => {
  if (globalThis.__cvCodexThread) return;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SOCKET_URL = 'wss://codex-cloud-backend.chatgpt.com/';
  const COLLAB_TOOLS = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent']);
  // thread/turns/list: turn status for the stalled-turn check (thread/read rejects includeTurns=true).
  const READ_METHODS = new Set(['initialize', 'thread/list', 'thread/read', 'thread/items/list', 'thread/turns/list']);
  const isId = value => typeof value === 'string' && UUID.test(value);
  // ChatGPT 网页建的 Codex 根线程有两种来源：chatgpt_cca（Work 对话里由 Codex 执行，2026-10-15 已被服务端全部删除）、
  // codex_work_web（另一个 Work 入口，仍在）。
  const WEB_ORIGINATORS = new Set(['chatgpt_cca', 'codex_work_web']);
  const CHAT_MODE_MESSAGE = '当前分支是 Chat 模式（没有 Work 标记：async_source、工作活动或子 agent）。'
    + 'Chat 模式的轮次由 Pro 后台执行，背后没有 Codex 线程，无需查找。';
  // Work 根线程在该轮用户消息发出后数秒内创建（实测 20 秒）；只用来缩小待查范围，身份仍靠精确 ID。
  const ROOT_WINDOW_SEC = 600;
  // async_source 有三种格式，只有 conversation-turn 是 Work（Codex 执行）；bon-user 是 Chat 模式的
  // Pro 后台任务（Sonic），ghostrider 是另一类后台任务，二者背后都没有 Codex 线程（2026-10-09 本地数据核对）。
  const isWorkSource = value => typeof value === 'string' && /(?:^|:)conversation-turn-[^:]+/.test(value);
  const idKey = value => isId(value) ? value.toLowerCase() : null;
  const normalizeUserText = value => typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  function threadUrl(id) {
    if (!isId(id)) throw new Error('Codex thread ID 无效');
    return `https://chatgpt.com/local/${id}?hostId=local`;
  }

  function conversationEvidence(conversation) {
    const mapping = conversation?.mapping || {};
    const senders = new Set(), agents = new Set(), workspaces = new Set(), visited = new Set();
    const users = new Set(), workTurns = new Set(), workUsers = new Set(), workTimes = [], userTimes = [];
    let workMarked = false; // Work 轮次的助手/工具消息同样带 conversation-turn 格式的 async_source
    // 另一种 Work 入口（线程 originator=codex_work_web，2026-10-15 核对 6abc3c97 ↔ 01a0ef4c）：没有 async_source，
    // 只有助手消息的 Work 模型名（*-wm）和 working_turn_id。从新到旧遍历，所以先遇到助手、再遇到本轮的用户消息。
    let pendingWorkTurn = false;
    let firstUserText = null, firstUserId = null;
    let nodeId = conversation?.current_node;
    if (!nodeId || !mapping[nodeId]) throw new Error('当前对话分支尚未加载完整，请稍后重试');
    // Active branch only, newest first. Shared ancestors may legitimately belong to several chats.
    while (nodeId) {
      if (visited.has(nodeId)) throw new Error('当前对话分支包含循环引用');
      visited.add(nodeId);
      const node = mapping[nodeId];
      if (!node) throw new Error('当前对话分支尚未加载完整，请稍后重试');
      const message = node.message;
      const metadata = message?.metadata || {};
      if (message?.author?.role === 'user' && !metadata.is_visually_hidden_from_conversation) {
        const parts = Array.isArray(message.content?.parts) ? message.content.parts : [];
        // An image-only first message must not silently become a later text message.
        firstUserText = parts.filter(part => typeof part === 'string').join('\n').trim() || null;
        firstUserId = idKey(message.id);
        if (firstUserId) users.add(firstUserId);
        if (Number.isFinite(message.create_time)) userTimes.push(message.create_time);
        // Work 模式（前端 tpp）的轮次：用户消息带 async_source，这一轮由 Codex 根线程执行。
        if ((isWorkSource(metadata.async_source) || pendingWorkTurn) && firstUserId) {
          workUsers.add(firstUserId);
          if (Number.isFinite(message.create_time)) workTimes.push(message.create_time);
        }
        pendingWorkTurn = false;
      }
      if (isWorkSource(metadata.async_source)) workMarked = true;
      if (message?.author?.role === 'assistant' && (/-wm$/.test(metadata.model_slug || '') || isId(metadata.working_turn_id))) {
        workMarked = true;
        pendingWorkTurn = true;
      }
      const agentId = idKey(metadata.codex_sub_agent_activity?.agentThreadId);
      if (agentId) agents.add(agentId);
      const call = metadata.codex_collab_agent_tool_call;
      if (call && COLLAB_TOOLS.has(call.tool) && (call.type == null || call.type === 'collabAgentToolCall')) {
        if (isId(call.senderThreadId)) senders.add(idKey(call.senderThreadId));
        for (const id of Array.isArray(call.receiverThreadIds) ? call.receiverThreadIds : [])
          if (isId(id)) agents.add(idKey(id));
        for (const id of Object.keys(call.agentsStates || {})) if (isId(id)) agents.add(idKey(id));
      }
      // Verified live: group_id == Codex turnId + ':' + an actual activity item_id.
      // Do not regex arbitrary message text, request_id, Sonic IDs, or unrelated metadata.
      if (message?.author?.role === 'assistant') {
        for (const group of Array.isArray(metadata.work_activity?.groups) ? metadata.work_activity.groups : []) {
          const key = group?.group_id;
          if (typeof key !== 'string' || key[36] !== ':' || !isId(key.slice(0, 36))) continue;
          if (Array.isArray(group.items) && group.items.some(item => item?.item_id === key.slice(37)))
            workTurns.add(idKey(key.slice(0, 36)));
        }
      }
      const content = JSON.stringify(message?.content || {});
      for (const match of content.matchAll(/\/workspace\/scratch\/[0-9a-f]+(?![\w-])/gi)) workspaces.add(match[0]);
      nodeId = node.parent;
    }
    // 没有任何 Work 标记的分支是 Chat 模式（Pro 走 Sonic 后台）：背后没有 Codex 根线程可找。
    const mode = workMarked || workTurns.size || agents.size || senders.size ? 'work' : 'chat';
    return { senderThreadIds: [...senders], agentThreadIds: [...agents], workspaces: [...workspaces],
      firstUserText, firstUserId, userMessageIds: [...users], workActivityTurnIds: [...workTurns],
      workUserMessageIds: [...workUsers], workTimes, userTimes, mode };
  }

  /**
   * 当前分支按轮次分类（纯本地计算，不发请求）：一轮从一条可见用户消息开始，
   * 该轮任一消息带 conversation-turn 格式的 async_source、工作活动、子 agent 或协作记录即为 Work，否则为 Chat。
   */
  /** 当前分支逐轮分类；chain 有环时返回 null。 */
  function classifyTurns(conversation) {
    const mapping = conversation?.mapping || {}, chain = [], seen = new Set();
    for (let key = conversation?.current_node; key; key = mapping[key]?.parent) {
      if (seen.has(key) || !mapping[key]) return null;
      seen.add(key);
      if (mapping[key].message) chain.push(mapping[key].message);
    }
    // 证据分三档：codex（工作活动/子 agent/协作记录，或 Work 模型名 -wm）> worker（只有 conversation-turn：
    // 走持久 worker，普通 Chat 也用过这条通道，未必有 Codex 线程）> chat。
    const turns = [];
    for (const message of chain.reverse()) {
      const metadata = message?.metadata || {};
      if (message?.author?.role === 'user' && !metadata.is_visually_hidden_from_conversation) turns.push({ id: message.id, codex: false, worker: false });
      const turn = turns[turns.length - 1];
      if (!turn) continue;
      if (metadata.work_activity?.groups?.length || metadata.codex_sub_agent_activity || metadata.codex_collab_agent_tool_call
        || /-wm$/.test(metadata.model_slug || '')) turn.codex = true;
      if (isWorkSource(metadata.async_source)) turn.worker = true;
    }
    return turns.map(turn => ({ id: turn.id, kind: turn.codex ? 'codex' : turn.worker ? 'worker' : 'chat' }));
  }

  function conversationModes(conversation) {
    const turns = classifyTurns(conversation);
    if (!turns) return { mode: 'unknown', turns: 0, workTurns: 0, chatTurns: 0, lastTurn: null };
    const codexTurns = turns.filter(t => t.kind === 'codex').length, workerTurns = turns.filter(t => t.kind === 'worker').length;
    const chatTurns = turns.length - codexTurns - workerTurns;
    const mode = !turns.length ? 'unknown' : !chatTurns ? codexTurns ? 'work' : 'worker' : chatTurns === turns.length ? 'chat' : 'mixed';
    return { mode, turns: turns.length, codexTurns, workerTurns, chatTurns, workTurns: codexTurns + workerTurns,
      lastTurn: turns.length ? turns[turns.length - 1].kind : null };
  }

  /** 页面总览面板用：用户消息 id → codex | worker | chat。 */
  function turnKinds(conversation) {
    return Object.fromEntries((classifyTurns(conversation) || []).filter(t => t.id).map(t => [t.id, t.kind]));
  }

  // 建立 WebSocket 与单次读取分开计时：实测握手多数 <3 秒，但页面正反复下载大对话时出现过 12 秒（2026-10-09）。
  async function connect(token, { WebSocketImpl = globalThis.WebSocket, signal,
    timeoutMs = 15000, openTimeoutMs = Math.max(30000, timeoutMs), createId = () => crypto.randomUUID(), allowMethods = [] } = {}) {
    // 默认只放行读取类方法；个别调用方（检查能否恢复）显式追加 thread/resume。
    const allowed = new Set([...READ_METHODS, ...allowMethods]);
    if (!token) throw new Error('当前未登录 ChatGPT');
    signal?.throwIfAborted();
    const socket = new WebSocketImpl(SOCKET_URL,
      ['codex-app-server', 'codex-client.browser', `openai-bearer.${token}`]);
    const pending = new Map();
    let closed = false, rejectOpen;
    let connectTimer;
    const abort = () => close(new Error('查找已取消'));
    function close(error = new Error('Codex 连接已关闭')) {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      signal?.removeEventListener('abort', abort);
      rejectOpen?.(error);
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
      pending.clear();
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    }
    const opened = new Promise((resolve, reject) => {
      rejectOpen = reject;
      socket.addEventListener('open', () => { clearTimeout(connectTimer); resolve(); }, { once: true });
      connectTimer = setTimeout(() => close(Object.assign(new Error(`连接 Codex 超过 ${Math.round(openTimeoutMs / 1000)} 秒仍未建立；网络可能拥塞（例如页面正在反复下载大对话），请稍后重试`), { code: 'CODEX_CONNECT_TIMEOUT' })), openTimeoutMs);
    });
    socket.addEventListener('error', () => close(new Error('无法连接 Codex 服务，请检查登录状态后重试')));
    socket.addEventListener('close', () => close());
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const task = pending.get(message?.id);
      if (!task) return;
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) {
        const error = new Error(message.error.message || '读取 Codex thread 失败');
        error.code = message.error.code;
        task.reject(error);
      } else task.resolve(message.result);
    });
    signal?.addEventListener('abort', abort, { once: true });
    function request(method, params, { timeoutMs: callTimeoutMs = timeoutMs } = {}) {
      if (!allowed.has(method)) return Promise.reject(new Error('此入口仅支持读取 Codex thread'));
      if (closed || socket.readyState !== 1) return Promise.reject(new Error('Codex 连接已关闭'));
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = createId();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('读取 Codex thread 超时，请稍后重试'), { code: 'CODEX_REQUEST_TIMEOUT' }));
        }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    }
    try {
      await opened;
      await request('initialize', {
        clientInfo: { name: 'codex-browser', title: 'Codex Browser', version: 'browser' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      socket.send(JSON.stringify({ method: 'initialized' }));
      return { request, close };
    } catch (error) { close(); throw error; }
  }

  function summary(thread, matchedBy, extra = {}) {
    if (!isId(thread?.id)) throw new Error('Codex 服务返回的 thread ID 无效');
    return { threadId: thread.id, sessionId: thread.sessionId || null,
      url: threadUrl(thread.id), matchedBy, name: thread.name || null,
      model: thread.model || null, createdAt: thread.createdAt ?? null,
      confidence: ['workspace', 'first-user-message'].includes(matchedBy) ? 'candidate' : 'verified', ...extra };
  }

  async function readRoot(client, observedId, matchedBy = 'subagent', signal) {
    const visited = new Set();
    let id = observedId;
    while (id) {
      signal?.throwIfAborted();
      if (visited.has(id)) throw new Error('Codex 父线程包含循环引用');
      if (visited.size >= 32) throw new Error('Codex 父线程层级过深，查找未完成');
      visited.add(id);
      const { thread } = await client.request('thread/read', { threadId: id, includeTurns: false });
      if (idKey(thread?.id) !== id) throw new Error('Codex 服务返回的 thread 与请求不一致');
      const parent = thread.parentThreadId || thread.source?.subAgent?.thread_spawn?.parent_thread_id;
      if (parent != null) {
        if (!isId(parent)) throw new Error('Codex 父 thread ID 无效');
        id = idKey(parent);
      } else if (thread.threadSource === 'subagent' && isId(thread.sessionId) && idKey(thread.sessionId) !== id) {
        id = idKey(thread.sessionId);
      } else {
        if (thread.threadSource === 'subagent' || (id === observedId && matchedBy === 'subagent'))
          throw new Error('子 agent 未返回可关联的主 thread');
        if (matchedBy === 'collab-sender' && !WEB_ORIGINATORS.has(thread.originator))
          throw new Error('协作记录未指向可核验的 ChatGPT 主 Codex thread');
        return summary(thread, matchedBy);
      }
    }
  }

  function nextPage(result, seen, label) {
    if (!Array.isArray(result?.data)) throw new Error(`Codex ${label}列表格式无效`);
    const cursor = result.nextCursor ?? null;
    if (cursor != null && (typeof cursor !== 'string' || !cursor)) throw new Error(`Codex ${label}分页游标无效`);
    if (cursor && seen.has(cursor)) throw new Error(`Codex ${label}列表分页未向前推进`);
    if (cursor) seen.add(cursor);
    return cursor;
  }

  // Progress is page-local and partitioned by a credential/evidence digest, never by chat ID alone.
  const progressCache = new Map();
  function clearProgress() { progressCache.clear(); }
  function progressEvidence(evidence) {
    // Newly appended explanations can mention more cwd examples. Those weak hints do not invalidate
    // already-read ID pages; workspace candidates are recomputed against the catalogue each time.
    return JSON.stringify([evidence.userMessageIds, evidence.workActivityTurnIds,
      evidence.firstUserId, evidence.firstUserText]);
  }
  async function cachedProgress(conversation, evidence, token) {
    const bytes = new TextEncoder().encode(JSON.stringify([token, conversation.conversation_id || conversation.id, progressEvidence(evidence)]));
    const key = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      value => value.toString(16).padStart(2, '0')).join('');
    const now = Date.now();
    for (const [id, entry] of progressCache) if (now - entry.at > 30 * 60 * 1000) progressCache.delete(id);
    let entry = progressCache.get(key);
    if (!entry) entry = { state: {}, at: now };
    entry.at = now;
    progressCache.delete(key);
    progressCache.set(key, entry);
    while (progressCache.size > 8) progressCache.delete(progressCache.keys().next().value);
    return entry.state;
  }

  async function inventoryMatches(client, evidence, options) {
    const { signal, deepScan = false } = options;
    const maxRequests = options.maxRequests ?? (deepScan ? 240 : 80);
    const maxItemPages = options.maxItemPages ?? (deepScan ? 80 : 8);
    const concurrency = options.concurrency ?? 4;
    const initialPageSize = options.itemPageSize ?? (deepScan ? 100 : 20);
    const maxDurationMs = options.maxDurationMs ?? 20000;
    for (const value of [maxRequests, maxItemPages, concurrency, initialPageSize, maxDurationMs])
      if (!Number.isInteger(value) || value < 1) throw new Error('Codex 查找预算必须是正整数');
    if (concurrency > 4 || initialPageSize > 100) throw new Error('Codex 查找最多 4 路并发、每页最多 100 条');
    const state = deepScan ? options.scanState || {} : {};
    const evidenceKey = progressEvidence(evidence);
    if (state.evidenceKey !== evidenceKey || state.direction !== (deepScan ? 'desc' : 'asc')) {
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, { evidenceKey, direction: deepScan ? 'desc' : 'asc', roots: new Map(),
        lists: [false, true].map(archived => ({ archived, cursor: null, seen: [], done: false })),
        totalRequests: 0, totalItemPages: 0, slices: 0, refresh: false });
    }
    const resumed = state.slices > 0;
    ++state.slices;
    // A completed search refreshes the catalogue on the next click. Unchanged roots retain their result.
    if (state.refresh) {
      state.lists = [false, true].map(archived => ({ archived, cursor: null, seen: [], done: false }));
      for (const root of state.roots.values()) root.inCatalogue = false;
      state.refresh = false;
    }
    const startedAt = Date.now(), pauseReasons = new Set();
    const diagnostics = { scope: deepScan ? 'history' : 'root-heads', resumed, listPages: 0, itemPages: 0,
      rootsListed: 0, rootsChecked: 0, rootsCompleted: 0, rootsPending: 0, rootsFailed: 0,
      requests: 0, historyLimited: 0, limitedRoots: 0, failures: [], partial: false, paused: false };
    function pause(code, message) {
      pauseReasons.add(code);
      return Object.assign(new Error(message), { code, lookupPause: true });
    }
    function checkBudget() {
      signal?.throwIfAborted();
      if (diagnostics.requests >= maxRequests) throw pause('request-budget', '本批读取预算已用完');
      if (Date.now() - startedAt >= maxDurationMs) throw pause('time-budget', '本批读取时间已到');
    }
    async function request(method, params) {
      checkBudget();
      ++diagnostics.requests;
      ++state.totalRequests;
      const result = await client.request(method, params);
      signal?.throwIfAborted();
      return result;
    }
    const fail = (stage, error, threadId = null) => {
      signal?.throwIfAborted();
      if (error.lookupPause) return;
      diagnostics.failures.push({ stage, threadId, message: error.message, code: error.code ?? null });
    };
    for (const list of state.lists) {
      if (list.done) continue;
      try {
        do {
          const result = await request('thread/list', { limit: 100, cursor: list.cursor,
            sortKey: 'updated_at', modelProviders: null, archived: list.archived, useStateDbOnly: true });
          ++diagnostics.listPages;
          const seen = new Set(list.seen), cursor = nextPage(result, seen, 'thread');
          const accepted = [];
          for (const thread of result.data) {
            if (!WEB_ORIGINATORS.has(thread?.originator) || thread.parentThreadId || thread.threadSource === 'subagent'
              || thread.source?.subAgent?.thread_spawn?.parent_thread_id) continue;
            if (!isId(thread.id)) throw new Error('Codex 服务返回的 thread ID 无效');
            accepted.push(thread);
          }
          for (const thread of accepted) {
            const id = idKey(thread.id);
            const revision = JSON.stringify([thread.updatedAt ?? null, thread.createdAt ?? null, thread.cwd ?? null]);
            let root = state.roots.get(id);
            if (!root || root.revision !== revision) {
              root = { thread, revision, cursor: null, seen: [], pageSize: initialPageSize, pages: 0,
                done: false, firstUserSeen: false, oldestUserMatches: false, exact: null, text: null,
                latestItemAtMs: null, oldestItemAtMs: null, exhausted: false };
              state.roots.set(id, root);
            }
            root.thread = thread;
            root.inCatalogue = true;
          }
          // A cursor is committed only after the complete page has been validated.
          list.cursor = cursor;
          list.seen = [...seen];
          list.done = !cursor;
        } while (!list.done);
      } catch (error) { fail('thread/list', error); }
      if (pauseReasons.size) break;
    }
    const catalogueComplete = state.lists.every(list => list.done);
    if (catalogueComplete) for (const [id, root] of state.roots) if (!root.inCatalogue) state.roots.delete(id);
    const roots = [...state.roots.values()];
    diagnostics.rootsListed = roots.length;
    const userPositions = new Map(evidence.userMessageIds.map((id, index) => [id, index]));
    const workTurns = new Set(evidence.workActivityTurnIds);
    const inspectItems = userPositions.size || workTurns.size || evidence.firstUserText;
    const attempted = new Set(), failed = new Set(), pagesThisSlice = new Map();
    let queue = inspectItems ? roots.filter(root => !root.done) : [];
    const resumeIndex = queue.findIndex(root => root.thread.id === state.nextRootId);
    if (resumeIndex > 0) queue = [...queue.slice(resumeIndex), ...queue.slice(0, resumeIndex)];
    if (!inspectItems) for (const root of roots) root.done = true;
    async function readPage(root) {
      const thread = root.thread;
      let page;
      try {
        for (;;) {
          try {
            page = await request('thread/items/list', { threadId: thread.id, cursor: root.cursor,
              limit: root.pageSize, sortDirection: state.direction });
            break;
          } catch (error) {
            signal?.throwIfAborted();
            if (error.lookupPause || root.pageSize <= 1 || !/decoded message length too large/i.test(error.message)) throw error;
            root.pageSize = Math.max(1, Math.floor(root.pageSize / 2));
          }
        }
        attempted.add(thread.id);
        const seen = new Set(root.seen), cursor = nextPage(page, seen, 'item');
        let matched = root.exact, firstUserSeen = root.firstUserSeen, oldestUserMatches = root.oldestUserMatches;
        let latest = root.latestItemAtMs, oldest = root.oldestItemAtMs;
        for (const row of page.data) {
          const item = row?.item || row;
          if (!item || typeof item.type !== 'string') throw new Error('Codex item 结构无效');
          const timestamp = row?.startedAtMs;
          if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
            latest = latest == null ? timestamp : Math.max(latest, timestamp);
            oldest = oldest == null ? timestamp : Math.min(oldest, timestamp);
          }
          const clientId = item.type === 'userMessage' ? idKey(item.clientId) : null;
          if (clientId && userPositions.has(clientId)) {
            const candidate = summary(thread, 'user-message-id', { matchedUserMessageId: clientId,
              matchedTurnId: isId(row?.turnId) ? row.turnId : null, branchIndex: userPositions.get(clientId) });
            if (!matched || candidate.branchIndex < (matched.branchIndex ?? Infinity)) matched = candidate;
          } else if (!matched && workTurns.has(idKey(row?.turnId))) {
            matched = summary(thread, 'work-activity-turn', { matchedTurnId: row.turnId });
          }
          if (item.type === 'userMessage' && (deepScan || !firstUserSeen)) {
            firstUserSeen = true;
            const text = (Array.isArray(item.content) ? item.content : []).filter(part => typeof part?.text === 'string')
              .map(part => part.text).join('\n');
            oldestUserMatches = !!((!clientId || !evidence.firstUserId) && evidence.firstUserText
              && normalizeUserText(text) === normalizeUserText(evidence.firstUserText));
          }
        }
        ++diagnostics.itemPages;
        ++state.totalItemPages;
        pagesThisSlice.set(thread.id, (pagesThisSlice.get(thread.id) || 0) + 1);
        Object.assign(root, { cursor, seen: [...seen], pages: root.pages + 1, firstUserSeen,
          oldestUserMatches, exact: matched, latestItemAtMs: latest, oldestItemAtMs: oldest });
        if (matched) root.done = true;
        else if (!cursor || (!deepScan && firstUserSeen)) {
          root.done = true;
          root.exhausted = !cursor;
          if (cursor) ++diagnostics.historyLimited;
          if (oldestUserMatches) root.text = summary(thread, 'first-user-message');
        }
      } catch (error) {
        if (!error.lookupPause) { attempted.add(thread.id); failed.add(thread.id); }
        fail('thread/items/list', error, thread.id);
      }
    }
    // 普通查找先只读「创建时间落在本对话 Work 轮次前后 ROOT_WINDOW_SEC 内」的根线程：根线程在该轮发出后
    // 数秒内创建，通常只有 1–3 个。窗口内精确命中即停；未命中再退回检查全部根线程开头。
    const anchors = evidence.workTimes?.length ? evidence.workTimes : evidence.userTimes || [];
    const createdSec = root => {
      const value = root.thread.createdAt;
      return typeof value === 'number' && Number.isFinite(value) ? (value > 1e12 ? value / 1000 : value) : null;
    };
    const nearWork = root => {
      const created = createdSec(root);
      return created != null && anchors.some(at => Math.abs(created - at) <= ROOT_WINDOW_SEC);
    };
    let deferred = [];
    if (!deepScan && anchors.length) {
      const near = queue.filter(nearWork);
      if (near.length) {
        deferred = queue.filter(root => !near.includes(root));
        queue = near;
      }
      diagnostics.windowRoots = near.length;
    }
    async function drain() {
      // Round-robin pages: one large old thread cannot consume the entire batch before others get a page.
      while (queue.length && !pauseReasons.size) {
        signal?.throwIfAborted();
        try { checkBudget(); } catch (error) { if (!error.lookupPause) throw error; break; }
        const batch = queue.splice(0, Math.min(concurrency, maxRequests - diagnostics.requests));
        await Promise.all(batch.map(root => readPage(root)));
        for (const root of batch) if (!root.done && !failed.has(root.thread.id)) {
          if ((pagesThisSlice.get(root.thread.id) || 0) >= maxItemPages) {
            ++diagnostics.limitedRoots;
          } else queue.push(root);
        }
        // Keep the scheduler position too: a one-page batch must not always restart at root #1.
        state.nextRootId = queue[0]?.thread.id || null;
      }
    }
    await drain();
    if (deferred.length) {
      if (roots.some(root => root.exact) && !failed.size) {
        // 窗口内已由精确 ID 命中：其余根线程开头不必再读，也不计为未完成。
        for (const root of deferred) root.done = true;
        diagnostics.rootsSkippedByWindow = deferred.length;
      } else {
        diagnostics.windowFallback = true;
        queue = deferred;
        await drain();
      }
    }
    if (diagnostics.limitedRoots) pauseReasons.add('page-budget');
    const exact = roots.filter(root => root.exact).map(root => root.exact);
    const textMatches = roots.filter(root => root.text).map(root => root.text);
    const workspaceMatches = roots.filter(root => evidence.workspaces.includes(root.thread.cwd))
      .map(root => summary(root.thread, 'workspace'));
    const candidates = exact.length ? exact : textMatches.length ? textMatches : workspaceMatches;
    candidates.sort((a, b) => (a.branchIndex ?? Infinity) - (b.branchIndex ?? Infinity)
      || (b.createdAt || 0) - (a.createdAt || 0) || a.threadId.localeCompare(b.threadId));
    diagnostics.rootsChecked = roots.filter(root => root.pages > 0 || attempted.has(root.thread.id)).length;
    diagnostics.rootsCompleted = roots.filter(root => root.done).length;
    diagnostics.rootsPending = roots.length - diagnostics.rootsCompleted;
    diagnostics.rootsFailed = failed.size;
    diagnostics.rootsMatched = roots.filter(root => root.exact).length;
    diagnostics.rootsExhausted = roots.filter(root => root.exhausted).length;
    diagnostics.totalItemPages = state.totalItemPages;
    diagnostics.totalRequests = state.totalRequests;
    diagnostics.slices = state.slices;
    diagnostics.catalogueComplete = catalogueComplete;
    diagnostics.partial = !catalogueComplete || diagnostics.rootsPending > 0 || diagnostics.failures.length > 0;
    diagnostics.paused = diagnostics.partial && pauseReasons.size > 0;
    diagnostics.pauseReasons = [...pauseReasons];
    diagnostics.canContinue = deepScan && diagnostics.partial;
    const observedDates = roots.map(root => root.latestItemAtMs).filter(value => value != null);
    diagnostics.latestObservedItemAtMs = observedDates.length ? Math.max(...observedDates) : null;
    state.refresh = !diagnostics.partial;
    return { candidates, diagnostics };
  }

  function lookupResult(candidates, diagnostics) {
    const paused = diagnostics?.paused === true;
    return { candidates, diagnostics, status: paused ? 'paused' : 'matched',
      canContinue: diagnostics?.canContinue === true,
      message: paused ? diagnostics.canContinue
        ? `本批查找已暂停：完成 ${diagnostics.rootsCompleted}/${diagnostics.rootsListed} 个根线程的定位检查。进度已保留，点击“继续查找”读取剩余页。`
        : '普通查找达到本批范围，请使用深度查找继续检查。' : null,
      requiresConfirmation: !!diagnostics?.partial || candidates.length !== 1
        || candidates.some(candidate => candidate.confidence !== 'verified') };
  }

  async function resolve(conversation, token, { client: suppliedClient, ...options } = {}) {
    const evidence = conversationEvidence(conversation);
    if (evidence.mode === 'chat') {
      const error = new Error(CHAT_MODE_MESSAGE);
      error.code = 'LOOKUP_CHAT_MODE';
      error.diagnostics = { scope: 'mode', mode: 'chat', requests: 0, partial: false };
      throw error;
    }
    if (!evidence.senderThreadIds.length && !evidence.agentThreadIds.length && !evidence.workspaces.length
      && !evidence.firstUserText && !evidence.userMessageIds.length && !evidence.workActivityTurnIds.length)
      throw new Error('当前对话没有返回可关联的 Codex thread：当前分支缺少协作线程、用户消息 ID、工作活动或文本线索');
    options.signal?.throwIfAborted();
    const auth = suppliedClient ? null : typeof token === 'function' ? await token() : token;
    if (options.deepScan && !options.scanState && !suppliedClient)
      options.scanState = await cachedProgress(conversation, evidence, auth);
    const client = suppliedClient || await connect(auth, options);
    const errors = [], direct = new Map();
    try {
      for (const senderId of evidence.senderThreadIds) {
        try {
          const candidate = await readRoot(client, senderId, 'collab-sender', options.signal);
          direct.set(candidate.threadId, candidate);
        } catch (error) {
          options.signal?.throwIfAborted();
          errors.push(error);
        }
      }
      if (direct.size && !options.deepScan) return lookupResult([...direct.values()],
        { scope: 'metadata', partial: errors.length > 0, failures: errors.map(error => ({ message: error.message })) });
      if (!direct.size) for (const childId of evidence.agentThreadIds) {
        try {
          const candidate = await readRoot(client, childId, 'subagent', options.signal);
          direct.set(candidate.threadId, candidate);
          // The ordinary button locates the newest readable relation; deep scan enumerates history too.
          if (!options.deepScan) return lookupResult([candidate], { scope: 'metadata', partial: false, failures: [] });
          break;
        } catch (error) {
          options.signal?.throwIfAborted();
          errors.push(error);
        }
      }
      const canScan = evidence.userMessageIds.length || evidence.workActivityTurnIds.length
        || evidence.firstUserText || evidence.workspaces.length;
      if (canScan) {
        const result = await inventoryMatches(client, evidence, options);
        if (direct.size) {
          for (const candidate of result.candidates) if (candidate.confidence === 'verified') direct.set(candidate.threadId, candidate);
          result.candidates = [...direct.values()];
        }
        if (result.candidates.length || result.diagnostics.paused)
          return lookupResult(result.candidates, result.diagnostics);
        const { diagnostics } = result;
        let error;
        if (diagnostics.partial) {
          error = new Error(`Codex 读取遇到错误：完成 ${diagnostics.rootsCompleted}/${diagnostics.rootsListed} 个根线程的定位检查；`
            + (diagnostics.failures[0]?.message || '线程列表尚未完整读取')
            + (diagnostics.canContinue ? '。进度已保留，可继续重试未读页。' : '。不能据此判断没有对应线程。'));
          error.code = 'LOOKUP_INCOMPLETE';
        } else {
          error = new Error(options.deepScan
            ? '已检查当前账号可读的云端根线程历史，未找到精确 ID 或首条用户消息匹配；这不证明该对话从未存在 Codex thread。'
            : '未在当前账号根线程开头找到用户消息 ID、工作活动或首条用户消息匹配。可用“深度查找”检查后续历史；未找到不等于没有。');
          error.code = 'LOOKUP_NO_MATCH';
        }
        error.diagnostics = diagnostics;
        throw error;
      }
      if (direct.size) return lookupResult([...direct.values()],
        { scope: 'metadata', partial: errors.length > 0, failures: errors.map(error => ({ message: error.message })) });
      if (errors.length) throw new Error(`无法读取对应的主 Codex thread：${errors[0].message}`);
      throw new Error('未找到与当前对话关联的 Codex thread');
    } finally { client.close(); }
  }

  /**
   * 列出 ChatGPT 网页（Work 模式）创建的 Codex Cloud 根线程，供弹窗复用旧线程。只读：thread/list。
   * 只留根线程（originator 为 chatgpt_cca 或 codex_work_web、无父线程、不是子 agent）。thread/list 不带标题（name、preview 实测为空），
   * 标题由 ChatVault 归档补。
   */
  async function listRoots(token, { archived = false, maxPages = 5, connectImpl = connect } = {}) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20) throw new Error('Codex 线程列表页数无效');
    const client = await connectImpl(token);
    try {
      const roots = [], seen = new Set();
      let cursor = null, pages = 0;
      do {
        const result = await client.request('thread/list', { limit: 100, cursor, sortKey: 'updated_at',
          modelProviders: null, archived, useStateDbOnly: true });
        ++pages;
        cursor = nextPage(result, seen, 'thread');
        for (const thread of result.data) {
          if (!WEB_ORIGINATORS.has(thread?.originator) || thread.parentThreadId || thread.threadSource === 'subagent'
            || thread.source?.subAgent?.thread_spawn?.parent_thread_id || !isId(thread.id)) continue;
          roots.push({ threadId: idKey(thread.id), url: threadUrl(thread.id), name: thread.name || thread.preview || null,
            model: thread.model || null, reasoningEffort: thread.reasoningEffort || null,
            cwd: thread.cwd || thread.environments?.[0]?.cwd || null, status: thread.status?.type || null,
            createdAt: thread.createdAt ?? null, updatedAt: thread.updatedAt ?? thread.recencyAt ?? null, archived });
        }
      } while (cursor && pages < maxPages);
      // 云端环境状态（environment/status）不再查：实测与线程能不能用无关（离线时 01a12a0c 照样能用），能不能用看「检查能否恢复」。
      return { threads: roots, truncated: !!cursor, pages };
    } finally { client.close(); }
  }

  /**
   * 检查线程能不能恢复：对每个线程发一次 thread/resume（和打开线程页时页面自己发的一样，不发消息、不改设置）。
   * 2026-10-14 实测：被拒的线程约 15 秒返回 -32603（grpcStatusCode 9 FAILED_PRECONDITION），能恢复的 0.8 秒到 5 分钟不等，
   * 所以单个最多等 timeoutMs，超时记为 timeout（服务端可能还在恢复）。每出一个结果就回调一次。
   */
  async function probeResume(token, threadIds, { onResult = () => {}, timeoutMs = 120000, concurrency = 3, connectImpl = connect } = {}) {
    const ids = [...new Set(threadIds.map(idKey).filter(Boolean))];
    if (!ids.length) return [];
    const client = await connectImpl(token, { allowMethods: ['thread/resume'] });
    const results = [];
    try {
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const threadId = ids[next++];
          const startedAt = Date.now();
          let result;
          try {
            const r = await client.request('thread/resume', { threadId }, { timeoutMs });
            result = { threadId, outcome: 'resumed', resumeKind: typeof r?.resumeKind === 'string' ? r.resumeKind : null };
          } catch (error) {
            const timedOut = error.code === 'CODEX_REQUEST_TIMEOUT';
            result = { threadId, outcome: timedOut ? 'timeout' : 'failed', error: timedOut ? null : String(error.message || error).slice(0, 200) };
          }
          result.ms = Date.now() - startedAt;
          result.at = Date.now();
          results.push(result);
          try { onResult(result); } catch { /* 回调失败不影响后面的检查 */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
      return results;
    } finally { client.close(); }
  }


  globalThis.__cvCodexThread = { version: globalThis.__cvPage?.version || 'unknown', threadUrl, conversationEvidence, conversationModes, turnKinds, connect, resolve, clearProgress, listRoots, probeResume };
})();
