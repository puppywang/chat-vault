// 隔离世界：SSE/WS 助手文本仅传到扩展后台用 tiktoken 计数，不写入 ChatVault。
// ≈TPS 是已捕获助手文本的输出速度，不等于模型的总 output_tokens。
(() => {
  // 同一环境被重复注入（补注入与注册注入撞在一起）时不起第二份：两份标题脚本互改曾锁死整个渲染进程。
  if (globalThis.__cvSpeed) return;
  const MARKER = '__chatVaultStreamMetricsV1';
  let enabled = true;
  let epoch = 0;
  let active = null;
  const observed = new Map();
  const recent = new Map();
  const tokenizing = new Set();
  const pendingTokens = new Map();
  const messageCounts = new Map();
  const STORAGE_PREFIX = 'cvTurnSpeedV1:';
  const loadedKeys = new Set();
  const loading = new Map();
  const pendingWrites = new Map();
  let persistenceError = null;
  const dotsCounted = new Map();

  // Codex 页面 /local/<thread> 记作 codex-<thread>，与 page-stream.js 的 Codex 观测一致。
  const codexThread = path => /^\/local\/([0-9a-fA-F-]{36})/.exec(path || '')?.[1]?.toLowerCase() || null;
  const conversationId = (path = location.pathname) => globalThis.__cvDots?.conversationId(path)
    || /\/c\/([0-9a-fA-F-]{36})/.exec(path)?.[1]
    || (codexThread(path) ? `codex-${codexThread(path)}` : null);
  const keyOf = (convId, userMessageId) => `${convId}:${userMessageId}`;
  const storageKey = (convId, userMessageId) => `${STORAGE_PREFIX}${keyOf(convId, userMessageId)}`;

  function persistMetric(convId, userMessageId, metric) {
    if (!enabled || !convId || !userMessageId || typeof chrome === 'undefined'
      || !chrome.storage?.local?.set
      || (!Number.isFinite(metric?.ttftMs) && !Number.isFinite(metric?.tps))) return;
    const key = storageKey(convId, userMessageId);
    const record = { ...metric, userMessageId, savedAtMs: Date.now() };
    const write = () => chrome.storage.local.set({ [key]: record });
    const previous = pendingWrites.get(key);
    let pending;
    try { pending = previous ? previous.catch(() => {}).then(write) : write(); }
    catch (err) { persistenceError = err?.message || 'speed_storage_failed'; return; }
    pendingWrites.set(key, pending);
    void pending.then(() => { persistenceError = null; }, (err) => {
      persistenceError = err?.message || 'speed_storage_failed';
    }).finally(() => {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
    });
  }

  async function hydrate(conv) {
    if (!enabled || typeof chrome === 'undefined' || !chrome.storage?.local?.get) return;
    const convId = conv?.conversation_id || conv?.id || conversationId();
    if (!convId) return;
    const generation = epoch;
    if (conv.cv_source === 'dots') {
      let round = null;
      const rounds = [];
      const messages = Object.values(conv.mapping || {}).map(n => n.message)
        .filter(Boolean).sort((a, b) => a.create_time - b.create_time);
      // Dot 的消息整条送达，没有 token 增量：不算 TTFT/TPS，改记「首条回复」用时（你发出 → Dot 第一条消息，
      // 都用接口时间戳）以及本轮条数与 token 数。
      for (const message of messages) {
        if (message.author?.role === 'user') {
          round = { userMessageId: message.id, userAt: message.create_time, firstReplyAt: null, count: 0, texts: [] };
          rounds.push(round);
        } else if (round && message.author?.role === 'assistant') {
          round.firstReplyAt ??= message.create_time;
          round.count++;
          round.texts.push(...(message.content?.parts || []).filter(p => typeof p === 'string'));
        }
      }
      await Promise.all(rounds.map(async r => {
        const key = keyOf(convId, r.userMessageId), signature = JSON.stringify(r.texts);
        if (dotsCounted.get(key) === signature) return;
        const result = await chrome.runtime.sendMessage({ type: 'countStreamTokens', texts: r.texts });
        if (!enabled || generation !== epoch) return;
        const firstReplyMs = Number.isFinite(r.firstReplyAt) && Number.isFinite(r.userAt)
          ? Math.max(0, Math.round((r.firstReplyAt - r.userAt) * 1000)) : null;
        recent.set(key, { userMessageId: r.userMessageId, source: 'dots-message',
          ttftMs: firstReplyMs, tps: null, ttftReason: firstReplyMs == null ? '等待首条回复' : null, tpsReason: '整条送达',
          messageCount: r.count,
          tokenCount: result?.ok ? result.tokens : null, tokenizer: 'o200k_base',
          tokenizerError: result?.ok ? null : result?.error || 'tokenizer_unavailable' });
        if (result?.ok) dotsCounted.set(key, signature);
      }));
      return;
    }
    if (loading.has(convId)) await loading.get(convId);
    const ids = new Set(Object.values(conv?.mapping || {})
      .map(node => node?.message).filter(message => message?.author?.role === 'user'
        && typeof message.id === 'string').map(message => message.id));
    const keys = [...ids].map(id => storageKey(convId, id)).filter(key => !loadedKeys.has(key));
    if (!keys.length) return;
    const task = chrome.storage.local.get(keys).then(values => {
      if (!enabled || generation !== epoch) return;
      for (const key of keys) {
        loadedKeys.add(key);
        const value = values?.[key];
        const userMessageId = key.slice(STORAGE_PREFIX.length + convId.length + 1);
        if (value?.source !== 'network' || value.userMessageId !== userMessageId
          || (!Number.isFinite(value.ttftMs) && !Number.isFinite(value.tps))) continue;
        const id = keyOf(convId, userMessageId);
        if (!recent.has(id)) recent.set(id, value);
      }
    }).catch(err => { persistenceError = err?.message || 'speed_storage_failed'; });
    loading.set(convId, task);
    try { await task; } finally { if (loading.get(convId) === task) loading.delete(convId); }
  }

  function stats(value, resumed = false, includeDiagnostics = false) {
    if (!value) return null;
    // Codex 页面打开时这一轮已在跑（没看到本页发出的 turn/start）：起点未知，只给 TPS。
    if (value.codexSend === false) resumed = true;
    const ttftMs = !resumed && Number.isFinite(value.firstTextAtMs)
      && Number.isFinite(value.requestStartMs)
      ? Math.max(0, value.firstTextAtMs - value.requestStartMs) : null;
    const durationMs = value.tokenLastTextAtMs - value.firstTextAtMs;
    const tps = Number.isInteger(value.tokenCount) && value.tokenCount > 0
      && Number.isInteger(value.tokenTextChunks) && value.tokenTextChunks >= 2
      && Number.isFinite(durationMs) && durationMs > 0
      ? value.tokenCount * 1000 / durationMs : null;
    return { userMessageId: value.userMessageId || null, source: 'network', ttftMs, tps,
      ttftReason: ttftMs != null ? null : resumed ? '缺少原始起点' : value.error ? '采集异常' : '等待首段文本',
      tpsReason: tps != null ? null : value.tokenizerError ? '分词失败' : resumed ? '缺少原始起点'
        : value.firstTextAtMs == null ? '等待文本' : value.tokenCount == null ? '正在分词' : '等待续片',
      outputTokens: value.outputTokens ?? null,
      tokenCount: value.tokenCount ?? null, tokenizer: 'o200k_base',
      tokenizerError: value.tokenizerError ?? null,
      textChars: value.textChars ?? null,
      textChunks: value.textChunks ?? null,
      sseFrames: value.sseFrames ?? null,
      wsFrames: value.wsFrames ?? null,
      ...(includeDiagnostics ? { eventShapes: value.eventShapes ?? [] } : {}),
      lastFrameAtMs: value.lastFrameAtMs ?? null,
      streamError: value.error ?? null,
      usageAvailable: value.outputTokens != null,
      serverTtfvtMs: value.serverTtfvtMs ?? null,
      requestStartMs: value.requestStartMs, firstTextAtMs: value.firstTextAtMs ?? null,
      completedAtMs: value.completedAtMs ?? null, lastChangeAt: value.lastTextAtMs ?? null };
  }

  // page-stream.js only hooks the original send POST (/backend-api/(f/)conversation); the
  // post-refresh /f/conversation/resume request does not match. An observation from this
  // document carrying the round's user message ID is therefore that round's original start.
  // The DOM "resumed" guess (new chat leaving `/`, route re-entry) must not override it.
  // Codex 页面没有消息 id：本页亲眼看到的 turn/start（且不早于这一轮被发现的时刻 15 秒）就是原始起点。
  const verifiedStart = (value, round) => !!value && Number.isFinite(value.requestStartMs)
    && ((!!round?.userMessageId && value.userMessageId === round.userMessageId)
      || (value.codexSend === true && value.requestStartMs >= (round?.startMs ?? Infinity) - 15000));
  const roundResumed = round => !!round?.resumed && !verifiedStart(round.observation, round);

  function rememberLive(value) {
    if (value.userMessageId && !value.resumedRequest) {
      recent.set(keyOf(value.conversationId, value.userMessageId), stats(value));
    }
  }

  function matchesRound(value, round) {
    if (!round || value.conversationId !== conversationId(round.path)) return false;
    if (round.userMessageId && value.userMessageId) return round.userMessageId === value.userMessageId;
    return Number.isFinite(value.requestStartMs) && value.requestStartMs >= round.startMs - 10000;
  }

  async function countPending(id) {
    if (tokenizing.has(id)) return;
    tokenizing.add(id);
    const generation = epoch;
    try {
      while (enabled && generation === epoch && pendingTokens.get(id)?.size) {
        const queue = pendingTokens.get(id);
        const [messageIndex, sample] = queue.entries().next().value;
        queue.delete(messageIndex);
        if (!queue.size) pendingTokens.delete(id);
        const result = await chrome.runtime.sendMessage({ type: 'countStreamTokens', texts: [sample.text] });
        const current = observed.get(id);
        if (!enabled || generation !== epoch || !current) continue;
        if (!result?.ok) {
          current.tokenizerError = result?.error || 'tokenizer_unavailable';
          continue;
        }
        current.tokenizerError = null;
        const counts = messageCounts.get(id) || new Map();
        const previous = counts.get(messageIndex);
        if (sample.revision < (previous?.revision || 0)) continue;
        counts.set(messageIndex, { revision: sample.revision, tokens: result.tokens,
          lastTextAtMs: sample.lastTextAtMs, textChunks: sample.textChunks });
        messageCounts.set(id, counts);
        current.tokenCount = [...counts.values()].reduce((sum, item) => sum + item.tokens, 0);
        current.tokenLastTextAtMs = Math.max(...[...counts.values()].map(item => item.lastTextAtMs));
        current.tokenTextChunks = Math.max(...[...counts.values()].map(item => item.textChunks));
        if (matchesRound(current, active)) active.observation = current;
        rememberLive(current);
        if (current.persistUserMessageId) {
          persistMetric(current.conversationId, current.persistUserMessageId, stats(current));
        }
      }
    } catch (err) {
      const current = observed.get(id);
      if (enabled && generation === epoch && current) current.tokenizerError = err?.message || 'tokenizer_unavailable';
      globalThis.__cvPage?.report('speed.tokenize', err);
    }
    finally {
      tokenizing.delete(id);
      if (enabled && pendingTokens.get(id)?.size) void countPending(id);
    }
  }

  function receive(event) {
    if (!enabled || event.source !== window || event.origin !== location.origin) return;
    const value = event.data;
    if (value?.[MARKER] !== true || !Number.isInteger(value.requestId)
      || typeof value.conversationId !== 'string' || !Number.isFinite(value.requestStartMs)) return;
    const id = `${value.conversationId}:${value.requestId}`;
    if (value.kind === 'tokenize') {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage
        && typeof value.text === 'string' && Number.isInteger(value.messageIndex)
        && Number.isInteger(value.revision)) {
        const queue = pendingTokens.get(id) || new Map();
        queue.set(value.messageIndex, value);
        pendingTokens.set(id, queue);
        void countPending(id);
      }
      return;
    }
    const previous = observed.get(id);
    const reading = { ...value,
      userMessageId: value.userMessageId || previous?.userMessageId || previous?.persistUserMessageId || null,
      persistUserMessageId: previous?.persistUserMessageId || null,
      resumedRequest: previous?.resumedRequest || false,
      tokenCount: previous?.tokenCount ?? null,
      tokenLastTextAtMs: previous?.tokenLastTextAtMs ?? null,
      tokenTextChunks: previous?.tokenTextChunks ?? null,
      tokenizerError: previous?.tokenizerError ?? null };
    observed.set(id, reading);
    if (observed.size > 50) {
      const oldest = observed.keys().next().value;
      observed.delete(oldest); messageCounts.delete(oldest); pendingTokens.delete(oldest);
    }
    if (matchesRound(reading, active)) {
      active.observation = reading;
      if (active.resumed) reading.resumedRequest = !verifiedStart(reading, active);
    }
    if (active && !roundResumed(active) && matchesRound(reading, active)
      && reading.completedAtMs != null) {
      reading.persistUserMessageId = active.userMessageId || reading.userMessageId;
      reading.userMessageId ||= reading.persistUserMessageId;
    }
    rememberLive(reading);
    if (reading.persistUserMessageId
      && (previous?.textChars !== reading.textChars
        || previous?.completedAtMs !== reading.completedAtMs
        || previous?.outputTokens !== reading.outputTokens)) {
      persistMetric(reading.conversationId, reading.persistUserMessageId, stats(reading));
    }
  }

  function beginRound({ startMs, userMessageId = null, resumed = false } = {}) {
    if (!enabled) return;
    active = { path: location.pathname, startMs: Number.isFinite(startMs) ? startMs : Date.now(),
      userMessageId, resumed, observation: null };
    for (const value of observed.values()) {
      if (matchesRound(value, active)) {
        active.observation = value;
        if (resumed) value.resumedRequest = !verifiedStart(value, active);
      }
    }
  }

  function snapshot() {
    if (!enabled || !active || active.path !== location.pathname) return null;
    if (active.path.startsWith('/dots/')) {
      const known = active.userMessageId && recent.get(keyOf(conversationId(active.path), active.userMessageId));
      return known || { source: 'dots-message', userMessageId: active.userMessageId, messageCount: 0,
        tokenCount: 0, ttftMs: null, tps: null, ttftReason: '等待首条回复', tpsReason: '整条送达' };
    }
    return stats(active.observation, roundResumed(active), true) || {
      userMessageId: active.userMessageId, source: 'network', ttftMs: null, tps: null,
      ttftReason: active.resumed ? '缺少原始起点' : '等待请求', tpsReason: active.resumed ? '缺少原始起点' : '等待文本',
      outputTokens: null, usageAvailable: false, lastChangeAt: null };
  }

  function correctRound({ startMs, userMessageId, resumed }) {
    if (!active || active.path !== location.pathname || active.userMessageId !== userMessageId) return;
    active.startMs = startMs;
    // Preserve actual observed original requests. Otherwise mark F5 continuation
    // explicitly instead of waiting forever for an original POST that already ran.
    if (resumed && !active.observation) active.resumed = true;
  }

  function finishRound({ userMessageId = null } = {}) {
    if (!active) return null;
    let value = snapshot();
    if (active.path.startsWith('/dots/')) { active = null; return value; }
    if (roundResumed(active)) { active = null; return value; }
    const convId = conversationId(active.path);
    const id = userMessageId || active.userMessageId || value?.userMessageId;
    if (value && convId && id) {
      if (active.observation) {
        active.observation.userMessageId = id;
        active.observation.persistUserMessageId = id;
        value = stats(active.observation);
        persistMetric(convId, id, value);
      }
      recent.set(keyOf(convId, id), { ...value, userMessageId: id });
    }
    active = null;
    return value;
  }

  function lookup(convId, userMessageId) {
    if (!enabled || !convId || !userMessageId) return null;
    if (conversationId(active?.path) === convId && active?.userMessageId === userMessageId) return snapshot();
    return recent.get(keyOf(convId, userMessageId)) || null;
  }

  function status() {
    return { enabled, active: snapshot(), latest: recent.size ? [...recent.values()].at(-1) : null,
      persistenceError };
  }
  function reset() { active = null; }
  function setEnabled(value) {
    if (enabled !== !!value) epoch++;
    enabled = !!value;
    if (!enabled) { active = null; observed.clear(); recent.clear(); pendingTokens.clear();
      messageCounts.clear(); loadedKeys.clear(); }
    if (!enabled) dotsCounted.clear();
  }

  window.addEventListener('message', receive);
  if (globalThis.__cvPage) {
    setEnabled(globalThis.__cvPage.can('speedMetrics'));
    globalThis.__cvPage.subscribe(() => setEnabled(globalThis.__cvPage.can('speedMetrics')));
  } else if (typeof chrome !== 'undefined') {
    Promise.resolve().then(() => chrome.storage.local.get({ speedMetrics: true }))
      .then(({ speedMetrics }) => setEnabled(speedMetrics)).catch(() => setEnabled(false));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.speedMetrics) setEnabled(changes.speedMetrics.newValue);
    });
  }
  globalThis.__cvSpeed = { beginRound, correctRound, noteMutation() {}, sample() {}, snapshot, finishRound,
    lookup, hydrate, reset, setEnabled, status };
})();
