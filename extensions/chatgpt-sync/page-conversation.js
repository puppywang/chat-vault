// MAIN world：复用页面自己发出的对话读取响应，交给隔离世界的 content.js，
// 免得扩展为同一份数据再下载一次（大对话 2–23 MB，重复下载容易触发 429）。
//
// 两种形态（2026-10-09 实测新前端改用后者，卡住时每 ~15 秒拉一次）：
//   GET /backend-api/conversation/<id>                  整段对话（mapping 树，含旁支）
//   GET /backend-api/conversations/<id>?num_turns=N&…   当前分支的消息列表（messages + page_info，可分页）
// 克隆响应体，不改请求，也不读取或转发请求头里的登录凭证。唯一例外是下面的断流恢复轮询：stream_status
// 仍是 IS_STREAMING 时把上一份对话响应还给页面（页面这一轮本来就会丢弃它），不再走网络。
// content.js 在 document_idle 才加载，页面首个请求往往更早返回：先留住最近一份，等它报到后再交付。
(() => {
  const MARKER = '__chatVaultPageConversationV1';
  if (window[MARKER] || typeof window.fetch !== 'function') return;
  window[MARKER] = true;
  const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
  const FULL = new RegExp(`^/backend-api/conversation/${UUID}$`, 'i');
  const BRANCH = new RegExp(`^/backend-api/conversations/${UUID}$`, 'i');
  const nativeFetch = window.fetch;
  let enabled = true, listenerReady = false, pending = null, epoch = 0, controlInstance = 0;
  let recoveryNetMinMs = 5 * 60e3;   // 恢复轮询按对话限频；由扩展设置下发，0 = 不限（见下方断流恢复轮询）

  const post = payload => window.postMessage({ [MARKER]: true, kind: 'conversation', ...payload }, location.origin);
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.__chatVaultPageConversationControlV1 === true) {
      // 只听最新的隔离实例；扩展重载后旧实例迟到的「关闭」不能把新实例刚打开的采集关掉。
      const from = Number.isFinite(data.instance) ? data.instance : 0;
      if (from < controlInstance) return;
      controlInstance = from;
      // 扩展设置「恢复轮询同一对话至少隔几分钟读一次」（旧版隔离脚本不带这个字段，保持默认）
      if (Number.isFinite(data.recoveryReadMinMs) && data.recoveryReadMinMs >= 0) recoveryNetMinMs = data.recoveryReadMinMs;
      const next = data.enabled === true;
      if (next !== enabled) epoch++;
      enabled = next;
      if (!enabled) pending = null;
    } else if (data?.__chatVaultPageConversationReadyV1 === true) {
      listenerReady = true;
      window.postMessage({ [MARKER]: true, kind: 'hello' }, location.origin);
      if (pending) { const value = pending; pending = null; post(value); }
    }
  });

  function targetOf(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (method !== 'GET' || url.origin !== location.origin) return null;
      const full = !url.search && FULL.exec(url.pathname)?.[1];
      if (full) return { id: full.toLowerCase(), shape: 'full', query: null };
      const branch = BRANCH.exec(url.pathname)?.[1];
      return branch ? { id: branch.toLowerCase(), shape: 'branch', query: url.search.slice(0, 200) } : null;
    } catch { return null; }
  }

  function deliver(text, response, target, generation) {
    if (!enabled || generation !== epoch) return;
    const payload = { conversationId: target.id, shape: target.shape, query: target.query, text,
      receivedAtMs: Date.now(), serverDate: response.headers.get('date') || null };
    if (listenerReady) post(payload);
    else pending = payload;          // 只留最新一份，交付后立即释放
  }

  // 发送请求里的模式字段（只观测）：社区报告 Work 请求带 product_experience=work、模型名以 -wm 结尾。
  // 只取下列字段和顶层字段名，不取消息正文、附件或任何凭证。
  const SEND = /^\/backend-api\/(?:f\/)?conversation$/;
  const SEND_FIELDS = ['product_experience', 'requested_model_experience', 'temporal_conversation_turn', 'model',
    'thinking_effort', 'action', 'conversation_origin'];
  function observeSend(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href);
      if (String(init?.method || input?.method || 'GET').toUpperCase() !== 'POST' || url.origin !== location.origin
        || !SEND.test(url.pathname) || typeof init?.body !== 'string') return;
      const body = JSON.parse(init.body);
      const user = Array.isArray(body.messages) ? body.messages.findLast(m => m?.author?.role === 'user') : null;
      const fields = Object.fromEntries(SEND_FIELDS.filter(k => body[k] != null)
        .map(k => [k, typeof body[k] === 'object' ? JSON.stringify(body[k]).slice(0, 200) : body[k]]));
      if (body.conversation_mode?.kind) fields.conversation_mode = body.conversation_mode.kind;
      window.postMessage({ [MARKER]: true, kind: 'send', conversationId: typeof body.conversation_id === 'string' ? body.conversation_id : null,
        userMessageId: typeof user?.id === 'string' ? user.id : null, fields, keys: Object.keys(body).sort().slice(0, 80),
        path: url.pathname, sentAtMs: Date.now() }, location.origin);
    } catch { /* 观测失败不影响页面请求 */ }
  }

  // Codex 页面（chatgpt.com/local/<thread>）与 codex-cloud-backend 的 WebSocket：只取 thread/tokenUsage/updated
  // 通知里的数字（线程累计 total、最近一次请求 last、上下文窗口），其余消息一概不看。打开线程（resume）时
  // 服务端会先推一次累计值；content.js 报到前按线程留最新一份。
  const CODEX_WS = /^wss:\/\/codex-cloud-backend\.chatgpt\.com\//i;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const usagePending = new Map();
  const count = value => Number.isFinite(value) && value >= 0 ? value : null;
  const breakdown = b => b && typeof b === 'object' ? { totalTokens: count(b.totalTokens), inputTokens: count(b.inputTokens),
    cachedInputTokens: count(b.cachedInputTokens), cacheWriteInputTokens: count(b.cacheWriteInputTokens),
    outputTokens: count(b.outputTokens), reasoningOutputTokens: count(b.reasoningOutputTokens) } : null;
  function onCodexMessage(data) {
    if (!enabled || typeof data !== 'string' || !data.includes('thread/tokenUsage/updated')) return;
    let parsed; try { parsed = JSON.parse(data); } catch { return; }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      const params = message?.params, usage = params?.tokenUsage;
      if (message?.method !== 'thread/tokenUsage/updated' || !usage || !UUID_RE.test(params.threadId || '')) continue;
      const payload = { kind: 'codexUsage', threadId: params.threadId.toLowerCase(),
        turnId: UUID_RE.test(params.turnId || '') ? params.turnId.toLowerCase() : null,
        total: breakdown(usage.total), last: breakdown(usage.last), modelContextWindow: count(usage.modelContextWindow), at: Date.now() };
      if (listenerReady) window.postMessage({ [MARKER]: true, ...payload }, location.origin);
      else usagePending.set(payload.threadId, payload);
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.__chatVaultPageConversationReadyV1 !== true) return;
    for (const payload of usagePending.values()) window.postMessage({ [MARKER]: true, ...payload }, location.origin);
    usagePending.clear();
  });
  const nativeWebSocket = window.WebSocket;
  if (typeof nativeWebSocket === 'function') window.WebSocket = new Proxy(nativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      try { if (CODEX_WS.test(String(args[0]))) socket.addEventListener('message', event => onCodexMessage(event.data)); }
      catch { /* 观测失败不影响页面连接 */ }
      return socket;
    },
  });

  // 账号额度：页面打开对话时自己会 POST /backend-api/conversation/init，返回 blocked_features（如「功能将受限至
  // 10月17日」，Pro Lite 每周 50 次 Pro 用完）、model_limits、limits_progress（深度研究、生图剩余次数）。
  // 只复用这份响应、只取这几个字段，不额外请求。
  const LIMITS = /^\/backend-api\/conversation\/init$/;
  let pendingLimits = null;
  function isLimitsRequest(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href);
      return url.origin === location.origin && LIMITS.test(url.pathname)
        && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST';
    } catch { return false; }
  }
  async function captureLimits(response) {
    if (!response?.ok) return;
    const j = JSON.parse(await response.clone().text());
    const pick = ({ blocked_features, model_limits, limits_progress, default_model_slug, intended_default_model_slug }) =>
      ({ blocked_features, model_limits, limits_progress, default_model_slug, intended_default_model_slug });
    const payload = { kind: 'limits', limits: pick(j || {}), receivedAtMs: Date.now() };
    if (listenerReady) window.postMessage({ [MARKER]: true, ...payload }, location.origin);
    else pendingLimits = payload;
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.__chatVaultPageConversationReadyV1 !== true) return;
    if (pendingLimits) { const value = pendingLimits; pendingLimits = null; window.postMessage({ [MARKER]: true, ...value }, location.origin); }
  });

  // 断流恢复轮询（698524 包的 transport recovery）：每轮并发读 stream_status 和对话（num_turns=10，约 485 KB），
  // 只要这轮 stream_status 仍是 IS_STREAMING，读到的对话直接丢弃，下一轮再来（Sonic 每 10 秒一轮、最长 120 分钟）。
  // 对话读取按账号限流（2026-10-15 实测约每分钟放行一次），几个卡住的标签页一起轮询就把额度吃光，刷新页面也会
  // 「无法加载此对话」。所以：同一轮 stream_status 说 IS_STREAMING 时，把这个 URL 上一份成功响应原样还给页面，
  // 不走网络；COMPLETE / FAILURE / 读不到状态 / 没有缓存时照常请求。stream_status 本身不受这个限流。
  //
  // 0.13.23：缓存上限 32M 字符太小——Work 长轮次的对话涨到 75 MB 后从不入缓存，这一招悄悄失效，后台标签页的
  // 恢复循环（服务端给这类轮次下发 poll_interval 10s、最长 240 分钟）就一直在网络上读整段对话，撞 429 后按
  // Retry-After 约 30 秒一次，把账号额度占满，另一个标签页打开对话直接「无法加载」（2026-10-20 实测）。现在：
  //   - 单份缓存放宽到 128M 字符，总量按 160M 字符淘汰最旧的；
  //   - 本轮 IS_STREAMING、手上又没有可还的缓存时，同一对话 N 分钟（扩展设置，默认 5，0 = 不限）内只放行一次网络读取，其余直接回 429
  //     （带 Retry-After），页面的恢复循环照它退避。读回来的对话页面本来就会丢弃，不影响显示。
  const STATUS = new RegExp(`^/backend-api/conversation/${UUID}/stream_status$`, 'i');
  const PAIR_MS = 1500, PAIR_WAIT_MS = 400, RECOVERY_MS = 5 * 60e3, CACHE_MAX = 3;
  const CACHE_MAX_CHARS = 128e6, CACHE_BUDGET_CHARS = 160e6;
  const statusSeen = new Map();   // 对话 id → { at, status: Promise<string|null> }
  const lastBodies = new Map();   // 路径+查询串 → { text, contentType }
  const netReadAt = new Map();    // 对话 id → 最近一次真正走网络读对话的时刻
  const served = new WeakSet();
  const canGate = typeof Response === 'function' && typeof setTimeout === 'function';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function statusIdOf(input, init) {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href);
      if (String(init?.method || input?.method || 'GET').toUpperCase() !== 'GET' || url.origin !== location.origin) return null;
      return STATUS.exec(url.pathname)?.[1]?.toLowerCase() || null;
    } catch { return null; }
  }
  const keyOf = input => { try { const u = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url, location.href); return u.pathname + u.search; } catch { return null; } };

  function noteStreamStatus(id, response) {
    const status = Promise.resolve(response).then(r => r?.ok ? r.clone().text() : null)
      .then(text => { const s = text ? JSON.parse(text)?.status : null; return typeof s === 'string' ? s : null; })
      .catch(() => null);
    statusSeen.set(id, { at: Date.now(), status });
  }

  function remember(key, response, text) {
    if (!key || text.length > CACHE_MAX_CHARS) return;
    lastBodies.delete(key);
    lastBodies.set(key, { text, contentType: response.headers.get('content-type') || 'application/json' });
    let total = 0;
    for (const body of lastBodies.values()) total += body.text.length;
    while (lastBodies.size > CACHE_MAX || (lastBodies.size > 1 && total > CACHE_BUDGET_CHARS)) {
      const oldest = lastBodies.keys().next().value;
      total -= lastBodies.get(oldest).text.length;
      lastBodies.delete(oldest);
    }
  }

  // 本轮的 stream_status：恢复轮询里两条请求几乎同时发出，先后不定；不在轮询里（5 分钟内没见过）就不等。
  async function pairedStatus(id) {
    let seen = statusSeen.get(id);
    if (!seen || Date.now() - seen.at > RECOVERY_MS) return null;
    if (Date.now() - seen.at > PAIR_MS) {
      const since = seen.at, until = Date.now() + PAIR_WAIT_MS;
      while (Date.now() < until && statusSeen.get(id).at === since) await delay(25);
      seen = statusSeen.get(id);
      if (seen.at === since) return null;
    }
    return seen.status;
  }

  function networkRead(self, args, target) {
    netReadAt.set(target.id, Date.now());
    return nativeFetch.apply(self, args);
  }

  async function gatedFetch(self, args, target, key) {
    const status = await pairedStatus(target.id);
    if (status !== 'IS_STREAMING' || args[1]?.signal?.aborted) return networkRead(self, args, target);
    const cached = lastBodies.get(key);
    if (cached) {
      const response = new Response(cached.text, { status: 200, headers: { 'content-type': cached.contentType } });
      served.add(response);
      window.postMessage({ [MARKER]: true, kind: 'recoverySkip', conversationId: target.id, at: Date.now() }, location.origin);
      return response;
    }
    const last = netReadAt.get(target.id);
    const waitMs = last == null || recoveryNetMinMs <= 0 ? 0 : recoveryNetMinMs - (Date.now() - last);
    if (waitMs > 0) {
      const response = new Response(JSON.stringify({ detail: 'ChatVault: recovery read throttled' }), { status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(Math.ceil(waitMs / 1000)) } });
      served.add(response);
      window.postMessage({ [MARKER]: true, kind: 'recoveryThrottle', conversationId: target.id, at: Date.now(), waitMs }, location.origin);
      return response;
    }
    return networkRead(self, args, target);
  }

  window.fetch = function (...args) {
    if (enabled) observeSend(args[0], args[1]);
    const statusId = statusIdOf(args[0], args[1]);
    const target = statusId ? null : targetOf(args[0], args[1]);
    const key = target ? keyOf(args[0]) : null;
    const recovering = canGate && target && statusSeen.has(target.id)
      && Date.now() - statusSeen.get(target.id).at <= RECOVERY_MS;
    const response = recovering ? gatedFetch(this, args, target, key)
      : target ? networkRead(this, args, target) : nativeFetch.apply(this, args);
    if (statusId) noteStreamStatus(statusId, response);
    if (enabled && isLimitsRequest(args[0], args[1])) void Promise.resolve(response).then(captureLimits).catch(() => {});
    if (target) {
      const generation = epoch;
      void Promise.resolve(response).then(async r => {
        if (served.has(r) || (!enabled && !canGate) || !r?.ok || !/json/i.test(r.headers?.get('content-type') || '')) return;
        const text = await r.clone().text();
        if (canGate) remember(key, r, text);
        if (enabled) deliver(text, r, target, generation);
      }).catch(() => {});
    }
    return response;
  };

  // 整页打开 /c/<id> 时，服务端渲染会先预取对话：成功时对话随 HTML 流下来（React Router 的 loaderData，
  // 'conversation-layout.route'.conversation 是个 Promise，值为 { status:'loaded', conversation }），页面直接
  // 拿来用、不再发 GET——上面的 fetch 包装就看不到它（2026-10-19 实测：此时扩展一直「尚未取得对话数据」）。
  // 被限流时值为 { status:'rate_limited', retryAfterMs }，页面会自己再读一次，照常走 fetch 包装。
  // 只读这一份已在页面内存里的数据，不发请求；等 HTML 流完最多 2 分钟。
  const SSR_POLL_MS = 500, SSR_POLL_MAX = 240;
  const routeConversationId = () => /^\/c\/([0-9a-f-]{36})(?:\/|$)/i.exec(location.pathname || '')?.[1]?.toLowerCase() || null;
  function ssrConversationPromise() {
    const loaderData = window.__reactRouterContext?.state?.loaderData;
    if (!loaderData || typeof loaderData !== 'object') return null;
    for (const value of Object.values(loaderData)) {
      const p = value && typeof value === 'object' ? value.conversation : null;
      if (p && typeof p.then === 'function') return p;
    }
    return null;
  }
  function captureSsrConversation() {
    const id = routeConversationId();
    if (!id || typeof setTimeout !== 'function') return;
    const generation = epoch;
    let tries = 0;
    const tick = () => {
      if (generation !== epoch || routeConversationId() !== id) return;
      const pending = ssrConversationPromise();
      if (!pending) { if (++tries < SSR_POLL_MAX) setTimeout(tick, SSR_POLL_MS); return; }
      Promise.resolve(pending).then(result => {
        const conv = result?.status === 'loaded' ? result.conversation : null;
        if (!conv || typeof conv !== 'object' || routeConversationId() !== id) return;
        const shape = Array.isArray(conv.messages) ? 'branch' : conv.mapping && typeof conv.mapping === 'object' ? 'full' : null;
        if (!shape) return;
        deliver(JSON.stringify(conv), { headers: { get: () => null } }, { id, shape, query: null }, generation);
      }).catch(() => { /* 预取失败页面会自己再读 */ });
    };
    tick();
  }
  captureSsrConversation();
})();
