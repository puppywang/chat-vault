// 页面推送中断、但 Work 模式的 Codex 轮次其实已经结束时，给出提示和 Codex 链接。
//
// 背景（2026-10-08 实测）：Work 模式（前端代号 tpp，用户消息带 async_source）的一轮交给 Codex 根线程
// 持久执行；页面只是订阅推送。推送断开后刷新，/f/conversation/resume 可能 410「Stream cache expired」，
// /stream_status 却一直是 IS_STREAMING，而 Codex 那边这一轮早已 completed。答复只在 Codex 页面里。
//
// 只读：stream_status、Codex thread/read | thread/items/list | thread/turns/list。不发送、不 resume、
// 不重试，不改写页面消息。只有本轮在 Codex 里被 turnId 或用户消息 clientId 精确对上，才给出结论。
//
// 补充（2026-10-18 实测）：拿不到 Codex 结论的相位（核对失败 / 无证据 / Chat 模式 / 被限流）原先完全静默，
// 而卡片只认「Codex 已验证」的相位 —— 于是页面推送和 Codex 一起卡住时可以静默几个小时（当天 13:30 起
// 的一轮直到手动刷新才暴露）。现在只要停止按钮仍在、页面静默满 STALL_ALERT_MS，就给一条通用告警（附
// 「刷新」按钮），流帧恢复或本轮结束时自动撤掉。
(() => {
  if (globalThis.__cvStalledTurn) return;
  const TICK_MS = 30_000;              // 轻量检查：只读 DOM 与本页测速状态
  const IDLE_MS = 5 * 60_000;          // 停止按钮在、但这么久没有新流帧，才去问服务端
  const STALL_ALERT_MS = 15 * 60_000;  // 还没有 Codex 结论时，页面静默这么久就先给通用告警
  const STATUS_RECHECK_MS = 2 * 60_000;
  const CODEX_RECHECK_MS = 5 * 60_000;
  const TURN_SCAN_PAGES = 5;           // 按用户消息 clientId 反查本轮 turn 的分页上限
  const STORAGE_PREFIX = 'cvWorkRoundV1:';
  const BANNER_ID = 'chatvault-stalled-turn';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idKey = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
  const SHOWN = new Set(['codex-completed', 'codex-failed', 'codex-running']);
  // 停在「页面还在流式、却没有 Codex 结论」的相位：页面静默超时后不再默不作声
  const UNCONFIRMED = new Set(['error', 'no-evidence', 'unverified', 'chat-mode', 'rate-limited']);

  let deps = null, tickTimer = null, round = null, host = null;
  const evidenceByConversation = new Map();
  const page = () => globalThis.__cvPage;
  const enabled = () => !page() || page().can('stalledTurn');
  const report = (stage, error) => page()?.report?.(`stalled.${stage}`, error);

  /** 当前分支最后一轮：是否 Work 模式，以及能精确指认 Codex 的结构字段（不含正文）。 */
  function roundEvidence(conv) {
    const mapping = conv?.mapping || {}, chain = [], seen = new Set();
    for (let key = conv?.current_node; key; key = mapping[key]?.parent) {
      if (seen.has(key) || !mapping[key]) return null;
      seen.add(key);
      if (mapping[key].message) chain.push(mapping[key].message);
    }
    chain.reverse();
    const visibleUser = m => m?.author?.role === 'user' && !m.metadata?.is_visually_hidden_from_conversation;
    const index = chain.findLastIndex(visibleUser);
    if (index < 0 || !idKey(chain[index].id)) return null;
    const user = chain[index], groups = new Map(), agents = new Map();
    for (const message of chain.slice(index + 1)) {
      if (message?.author?.role !== 'assistant') continue;
      for (const group of message.metadata?.work_activity?.groups || []) {
        const key = group?.group_id;
        if (typeof key !== 'string' || key[36] !== ':' || !idKey(key.slice(0, 36))) continue;
        if (!group.items?.some?.(item => item?.item_id === key.slice(37))) continue;
        const turnId = idKey(key.slice(0, 36));
        if (!groups.has(turnId)) groups.set(turnId, { group_id: key, items: [{ item_id: key.slice(37) }] });
      }
      const agent = message.metadata?.codex_sub_agent_activity;
      const agentId = idKey(agent?.agentThreadId);
      if (agentId && !agents.has(agentId)) agents.set(agentId, { type: agent.type ?? 'subAgentActivity', agentThreadId: agentId });
    }
    return { conversationId: conv.conversation_id || conv.id || null, userMessageId: idKey(user.id),
      userCreateTime: Number.isFinite(user.create_time) ? user.create_time : null,
      workMode: /(?:^|:)conversation-turn-[^:]+/.test(user.metadata?.async_source || ''), turnIds: [...groups.keys()],
      groups: [...groups.values()], agents: [...agents.values()], threadId: null, savedAt: Date.now() };
  }

  /** 交给 __cvCodexThread.resolve 的最小分支：只有 ID 与已验证的结构字段。 */
  function minimalConversation(evidence) {
    // 只为已确认是 Work 模式的轮次构造：带上 async_source 标记，resolve 才会按 Work 对话查找。
    const messages = [{ id: evidence.userMessageId, author: { role: 'user' }, content: { parts: [] },
      metadata: evidence.workMode ? { async_source: 'stalled-turn:conversation-turn-replay' } : {}, create_time: evidence.userCreateTime ?? undefined }];
    if (evidence.groups.length) messages.push({ id: 'cv-work', author: { role: 'assistant' }, content: { parts: [] },
      metadata: { work_activity: { groups: evidence.groups } } });
    evidence.agents.forEach((activity, i) => messages.push({ id: `cv-agent-${i}`, author: { role: 'assistant' },
      content: { parts: [] }, metadata: { codex_sub_agent_activity: activity } }));
    return { conversation_id: evidence.conversationId, current_node: `n${messages.length - 1}`,
      mapping: Object.fromEntries(messages.map((message, i) => [`n${i}`, { id: `n${i}`, message, parent: i ? `n${i - 1}` : null }])) };
  }

  async function persist(evidence) {
    try { await chrome.storage.local.set({ [STORAGE_PREFIX + evidence.conversationId]: evidence }); }
    catch (error) { report('persist', error); }
  }

  function observeConversation(conv) {
    if (!enabled()) return;
    try {
      const evidence = roundEvidence(conv);
      if (!evidence?.conversationId || evidence.conversationId.startsWith('dots-')) return;
      const previous = evidenceByConversation.get(evidence.conversationId);
      if (previous?.userMessageId === evidence.userMessageId) evidence.threadId = previous.threadId;
      const same = previous && JSON.stringify({ ...previous, savedAt: 0 }) === JSON.stringify({ ...evidence, savedAt: 0 });
      evidenceByConversation.set(evidence.conversationId, evidence);
      if (!same) void persist(evidence);
    } catch (error) { report('observe', error); }
  }

  async function evidenceFor(convId, userMessageId, allowLoad) {
    const match = value => value?.userMessageId === userMessageId ? value : null;
    let found = match(evidenceByConversation.get(convId));
    if (!found) {
      try {
        const stored = (await chrome.storage.local.get(STORAGE_PREFIX + convId))?.[STORAGE_PREFIX + convId];
        found = match(stored);
        if (found) evidenceByConversation.set(convId, found);
      } catch (error) { report('evidence.read', error); }
    }
    if (!found && allowLoad && deps?.loadConversation) {
      // 每轮至多主动读一次；之后靠 content.js 的定时同步回调 observeConversation 更新证据。
      await deps.loadConversation(convId);      // 走 content.js 的限流记账；成功时会回调 observeConversation
      found = match(evidenceByConversation.get(convId));
    }
    return found;
  }

  async function streamStatus(convId, token) {
    const r = await fetch(`/backend-api/conversation/${convId}/stream_status`,
      { headers: { Authorization: `Bearer ${token}` }, credentials: 'include' });
    if (r.status === 404) return 'UNAVAILABLE';
    if (!r.ok) throw Object.assign(new Error(`读取 stream_status 失败 (${r.status})`), { httpStatus: r.status });
    return (await r.json())?.status ?? null;
  }

  /** 按 clientId 找到本轮的 userMessage，返回它所属的 turnId（只看最近几页）。 */
  async function turnOfUserMessage(client, threadId, userMessageId) {
    let cursor = null;
    for (let i = 0; i < TURN_SCAN_PAGES; i++) {
      const page = await client.request('thread/items/list', { threadId, cursor, limit: 20, sortDirection: 'desc' });
      for (const row of page?.data || []) {
        if (row?.item?.type === 'userMessage' && idKey(row.item.clientId) === userMessageId) return idKey(row.turnId);
      }
      cursor = page?.nextCursor ?? null;
      if (!cursor) return null;
    }
    return null;
  }

  async function codexTurn(evidence, token) {
    const api = globalThis.__cvCodexThread;
    if (!api?.connect) throw new Error('Codex 查找模块未加载');
    const client = await api.connect(token, { timeoutMs: 15000 });
    try {
      let threadId = evidence.threadId;
      if (!threadId) {
        // resolve 结束时会 close 传入的 client；包一层，让同一连接继续读取 turn。
        const shared = { request: (method, params) => client.request(method, params), close() {} };
        const result = await api.resolve(minimalConversation(evidence), null, { client: shared });
        if (result.requiresConfirmation || result.candidates?.length !== 1)
          return { verified: false, reason: '对应 Codex 根线程不唯一或未经验证' };
        threadId = result.candidates[0].threadId;
        evidence.threadId = threadId;
        void persist(evidence);
      }
      const turns = (await client.request('thread/turns/list', { threadId, limit: 5, sortDirection: 'desc' }))?.data || [];
      let turn = turns.find(t => evidence.turnIds.includes(idKey(t?.id)));
      if (!turn) {
        const owner = await turnOfUserMessage(client, threadId, evidence.userMessageId);
        turn = owner ? turns.find(t => idKey(t?.id) === owner) : null;
      }
      if (!turn) return { verified: false, threadId, reason: 'Codex 线程中没有找到与本轮精确对应的 turn' };
      return { verified: true, threadId, url: api.threadUrl(threadId), turnId: turn.id, status: turn.status ?? null,
        startedAt: turn.startedAt ?? null, completedAt: turn.completedAt ?? null, durationMs: turn.durationMs ?? null,
        error: turn.error ? String(turn.error.message || JSON.stringify(turn.error)).slice(0, 200) : null };
    } finally { client.close(); }
  }

  function phaseOf(status) {
    if (status === 'completed') return 'codex-completed';
    if (['failed', 'interrupted', 'cancelled', 'canceled', 'error'].includes(status)) return 'codex-failed';
    return 'codex-running';
  }

  async function inspect(current) {
    const token = await deps.accessToken();
    const status = await streamStatus(current.convId, token);
    current.streamStatus = status;
    if (status !== 'IS_STREAMING') {
      current.phase = 'chat-not-streaming';
      current.nextAt = Date.now() + STATUS_RECHECK_MS;
      return;
    }
    let evidence;
    const allowLoad = !current.loadAttempted;
    current.loadAttempted = true;
    try { evidence = await evidenceFor(current.convId, current.userMessageId, allowLoad); }
    catch (error) {
      current.phase = error.status === 429 ? 'rate-limited' : 'no-evidence';
      current.error = error.message;
      current.nextAt = Math.max(error.retryAt || 0, Date.now() + STATUS_RECHECK_MS);
      return;
    }
    if (!evidence) { current.phase = 'no-evidence'; current.nextAt = Date.now() + STATUS_RECHECK_MS; return; }
    if (!evidence.workMode) {
      // Chat 模式（Sonic）背后没有 Codex 轮次可查；不扫描账号线程。
      current.phase = 'chat-mode';
      current.nextAt = Date.now() + CODEX_RECHECK_MS;
      return;
    }
    const codex = await codexTurn(evidence, token);
    current.codex = codex;
    current.phase = codex.verified ? phaseOf(codex.status) : 'unverified';
    current.nextAt = Date.now() + (current.phase === 'codex-running' || current.phase === 'unverified'
      ? CODEX_RECHECK_MS : STATUS_RECHECK_MS);
  }

  function currentUserMessageId() {
    const speed = globalThis.__cvSpeed?.snapshot?.();
    const fromSpeed = idKey(speed?.userMessageId);
    if (fromSpeed) return fromSpeed;
    const nodes = document.querySelectorAll('[data-message-author-role="user"][data-message-id]');
    return idKey(nodes[nodes.length - 1]?.getAttribute('data-message-id'));
  }

  async function check() {
    try {
      const convId = deps?.conversationId?.();
      if (!enabled() || !convId || convId.startsWith('dots-') || !globalThis.__cvTurns?.isStreaming?.()) return clear();
      const userMessageId = currentUserMessageId();
      if (!userMessageId) return;
      const now = Date.now(), key = `${convId}:${userMessageId}`;
      if (round?.key !== key) { clear(); round = { key, convId, userMessageId, firstSeenAt: now, phase: 'watching' }; }
      const speed = globalThis.__cvSpeed?.snapshot?.();
      const lastFrame = idKey(speed?.userMessageId) === userMessageId && Number.isFinite(speed?.lastFrameAtMs) ? speed.lastFrameAtMs : 0;
      round.lastActivityAt = Math.max(round.firstSeenAt, lastFrame);
      round.silenceMs = now - round.lastActivityAt;   // 通用告警按它计时
      if (round.silenceMs < IDLE_MS) {
        // 流帧又来了：推送已恢复，撤掉提示。
        if (round.phase !== 'watching') { round = { ...round, phase: 'watching', codex: null, nextAt: 0 }; render(); }
        return;
      }
      if (round.busy || (round.nextAt && now < round.nextAt)) return;
      const current = round;
      current.busy = true;
      current.error = null;
      try { await inspect(current); }
      catch (error) {
        current.phase = 'error'; current.error = error.message;
        current.nextAt = Date.now() + CODEX_RECHECK_MS;
        report('inspect', error);
      } finally {
        current.busy = false;
        current.checkedAt = Date.now();
        if (round === current) render();
      }
    } catch (error) { report('check', error); }
  }

  const fmtDur = ms => {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };
  const fmtClock = sec => Number.isFinite(sec) ? new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '';

  /** 拿不到 Codex 结论、页面又静默太久：返回静默毫秒数，否则 null。 */
  function stallAlert() {
    if (!round || round.dismissed || !UNCONFIRMED.has(round.phase)) return null;
    return Number.isFinite(round.silenceMs) && round.silenceMs >= STALL_ALERT_MS ? round.silenceMs : null;
  }

  function reloadPage() {
    try {
      if (typeof deps?.reload === 'function') deps.reload();
      else globalThis.location?.reload?.();
    } catch (error) { report('reload', error); }
  }

  function render() {
    const c = round?.codex;
    const verified = !!(round && !round.dismissed && SHOWN.has(round.phase) && c?.url);
    const alertMs = verified ? null : stallAlert();
    if (!verified && alertMs == null) { host?.remove(); host = null; return; }
    const text = !verified ? `页面推送已中断 · 已 ${fmtDur(alertMs)} 无新内容`
      : round.phase === 'codex-completed'
        ? `Codex 已完成本轮${c.durationMs ? `（用时 ${fmtDur(c.durationMs)}` : '（'}${c.completedAt ? `，结束于 ${fmtClock(c.completedAt)}）` : '）'} · 页面未收到结果`
        : round.phase === 'codex-failed' ? `Codex 本轮已结束（${c.status}）· 页面未收到结果`
          : `页面推送已中断 · Codex 仍在执行${c.startedAt ? `（始于 ${fmtClock(c.startedAt)}）` : ''}`;
    const tip = verified
      ? `ChatGPT stream_status 仍为 ${round.streamStatus}；Work 模式对应的 Codex 根线程 ${c.threadId} 中，`
        + `本轮 turn ${c.turnId} 状态为 ${c.status}${c.error ? `（${c.error}）` : ''}。该对话的自动同步已暂停，避免反复读取触发 429。`
      : `ChatGPT stream_status 仍为 ${round.streamStatus || '未知'}，但页面已 ${fmtDur(alertMs)} 没有收到新内容；`
        + `${round.phase === 'chat-mode' ? '本轮是 Chat 模式，没有 Codex 轮次可核对'
          : round.error ? `本轮未能核对 Codex 轮次（${round.error}）` : '本轮未能在 Codex 侧精确核对'}。`
        + '页面收不到推送不等于本轮停了：Work 模式的一轮在后台继续执行，工具调用照常落到 Pi 等执行端，'
        + '以执行端会话（ChatVault 里关联的 Pi 对话）的进展为准。可点「刷新」让页面按服务端状态重绘，'
        + '但服务端记录也可能滞后于实际执行。不要用停止按钮结束本轮——那会取消仍在工作的任务。'
        + `确认在正常执行时直接关掉这条提示（${fmtDur(STALL_ALERT_MS)} 内不再出现）。`;
    if (!host) {
      host = document.createElement('div');
      host.id = BANNER_ID;
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
      <style>
        :host { all: initial; display: block; position: fixed; right: 16px; top: 64px; z-index: 2147483000; }
        ${globalThis.__cvTurns?.floatCss || ''}
        .b { display: flex; align-items: center; gap: 10px; max-width: 320px; padding: 7px 11px; border-radius: 10px;
             font: 500 12.5px/1.5 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
             color: #e4e4e7; background: rgba(24,24,27,.94); box-shadow: 0 4px 16px rgba(0,0,0,.28);
             border: 1px solid rgba(255,255,255,.12); border-left: 3px solid #f59e0b; }
        .b.done { border-left-color: #10a37f; }
        a, #r { color: #3ddc97; font-weight: 700; white-space: nowrap; text-decoration: none; }
        a:hover, #r:hover { text-decoration: underline; }
        button { all: unset; cursor: pointer; color: #a1a1aa; padding: 0 2px; font-size: 15px; }
        #r { font-size: 12.5px; color: #3ddc97; }
      </style>
      <div class="b"><span id="t"></span><a id="a" target="_blank" rel="noopener">打开 Codex</a><button id="r" title="刷新页面，让 ChatGPT 按服务端状态重绘">刷新</button><button id="x" title="关闭">×</button></div>`;
      root.getElementById('x').addEventListener('click', () => { if (round) round.dismissed = true; render(); });
      root.getElementById('r').addEventListener('click', () => { reloadPage(); });
      // 与计时器、总览胶囊同列（最上方），不再单独压在页面右上角工具栏下。
      const mount = globalThis.__cvTurns?.mountFloat;
      if (typeof mount === 'function') mount(host, 'stalled');
      else document.body.appendChild(host);
    }
    const root = host.shadowRoot;
    root.querySelector('.b').className = verified && round.phase === 'codex-completed' ? 'b done' : 'b';
    root.getElementById('t').textContent = text;
    root.querySelector('.b').title = tip;
    root.getElementById('a').href = verified ? c.url : '';
    root.getElementById('a').style.display = verified ? '' : 'none';
    root.getElementById('r').style.display = verified ? 'none' : '';
  }

  function clear() { round = null; render(); }

  /** 本轮已确认交给 Codex、页面却仍在等推送时，暂停该对话的自动同步。 */
  function pausesSync(convId) { return !!round && round.convId === convId && SHOWN.has(round.phase); }

  function status() {
    if (!round) return { enabled: enabled(), phase: 'idle' };
    const { busy, dismissed, ...rest } = round;
    return { enabled: enabled(), ...rest, busy: !!busy, dismissed: !!dismissed,
      syncPaused: pausesSync(round.convId), stallAlert: stallAlert() != null };
  }

  function attach(dependencies) {
    deps = dependencies;
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { void check(); }, TICK_MS);
    page()?.subscribe?.(() => { if (!enabled()) clear(); });
  }

  globalThis.__cvStalledTurn = { attach, observeConversation, check, pausesSync, status, clear,
    roundEvidence, minimalConversation, constants: { TICK_MS, IDLE_MS, STALL_ALERT_MS, STATUS_RECHECK_MS, CODEX_RECHECK_MS } };
})();
