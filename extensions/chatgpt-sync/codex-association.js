// Finite, read-only association diagnostics. UUID normalization is NEVER identity proof.
(() => {
  if (globalThis.__cvCodexAssociation) return;
  const version = globalThis.__cvPage?.version || 'unknown';   // 与 page-state.js 同源（扩展清单）
  const route = 'codex-cloud';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sonic = /^thread_([0-9a-f]{32})$/i;
  const id = value => typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null;
  function evidence(conversation) {
    const chain = [], seen = new Set();
    let key = conversation?.current_node;
    if (!key) throw new Error('当前分支尚未加载完整');
    while (key) {
      if (seen.has(key)) throw new Error('当前分支包含循环引用');
      seen.add(key);
      const node = conversation.mapping?.[key];
      if (!node) throw new Error('当前分支尚未加载完整');
      chain.push(node.message);
      key = node.parent;
    }
    let userId = null;
    const observations = new Map();
    for (const message of chain.reverse()) {
      if (message?.author?.role === 'user' && !message.metadata?.is_visually_hidden_from_conversation)
        userId = id(message.id);
      // User-pasted JSON, tool arguments and ordinary text cannot supply an identity.
      if (!['assistant', 'tool'].includes(message?.author?.role)) continue;
      const match = sonic.exec(message?.metadata?.debug_sonic_thread_id || '');
      if (!match) continue;
      const raw = match[1].toLowerCase();
      const originalId = `thread_${raw}`;
      observations.delete(originalId);
      observations.set(originalId, { originalId,
        normalizedId: `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`,
        messageId: id(message.id), userMessageId: userId });
    }
    return [...observations.values()].reverse();
  }
  function classify(error) {
    const text = String(error?.message || '');
    const format = /unsupported placement format version\s+(\d+)/i.exec(text);
    const region = /unsupported placement region\s+(\d+)/i.exec(text);
    if (format || region) return { state: 'route-unsupported', code: 'CODEX_ROUTE_UNSUPPORTED',
      placementVersion: format ? Number(format[1]) : null, placementRegion: region ? Number(region[1]) : null,
      reason: format ? `当前入口不支持 placement 格式版本 ${format[1]}` : `当前入口不支持 placement region ${region[1]}` };
    if (/abort|取消/i.test(text) || error?.name === 'AbortError')
      return { state: 'cancelled', code: 'LOOKUP_CANCELLED', reason: '查找已取消' };
    if (error?.code === 429 || /\b429\b|rate.?limit/i.test(text))
      return { state: 'read-error', code: 'CODEX_RATE_LIMITED', reason: '读取被限流；尚未完成核验' };
    if ([401, 403].includes(error?.code) || /\b(?:401|403)\b|unauthorized|forbidden/i.test(text))
      return { state: 'read-error', code: 'CODEX_AUTH_ERROR', reason: '当前登录上下文无权完成读取' };
    if (/invalid thread id|invalid character/i.test(text))
      return { state: 'invalid-identifier', code: 'CODEX_INVALID_IDENTIFIER', reason: '当前入口不接受此标识格式' };
    if (/timeout|超时/i.test(text))
      return { state: 'read-error', code: 'CODEX_READ_TIMEOUT', reason: '读取超时；不能判断是否匹配' };
    return { state: 'read-error', code: 'CODEX_READ_ERROR', reason: '读取失败；不能判断是否匹配' };
  }
  async function inspect(conversation, token, options = {}) {
    const core = globalThis.__cvCodexThread;
    const all = evidence(conversation), samples = all.slice(0, 3);
    const exactEvidence = core.conversationEvidence(conversation);
    const userIds = new Set(exactEvidence.userMessageIds), turns = new Set(exactEvidence.workActivityTurnIds);
    const diagnostics = { scope: 'association', backend: route, sonicCount: all.length, sampleCount: samples.length,
      requests: 0, itemPages: 0, failures: [], probes: [], partial: false, historyScanned: false };
    if (!samples.length) return { status: 'mapping-unavailable', code: 'CODEX_MAPPING_UNAVAILABLE', candidates: [],
      requiresConfirmation: true, canContinue: false, diagnostics, message: '当前分支没有可用的 Sonic 关联标识。' };
    options.signal?.throwIfAborted();
    const client = options.client || await core.connect(typeof token === 'function' ? await token() : token,
      { ...options, timeoutMs: options.timeoutMs ?? 8000 });
    const candidates = new Map();
    const request = async (method, params) => {
      options.signal?.throwIfAborted();
      ++diagnostics.requests;
      const result = await client.request(method, params);
      options.signal?.throwIfAborted();
      return result;
    };
    try {
      await Promise.all(samples.map(async sample => {
        const probe = { ...sample, backend: route, state: 'unverified' };
        try {
          const response = await request('thread/read', { threadId: sample.normalizedId, includeTurns: false });
          const thread = response?.thread;
          if (id(thread?.id) !== sample.normalizedId) throw new Error('response thread mismatch');
          probe.state = 'readable-unverified';
          // A readable normalized ID is NOT enough. Require independent current-branch ID evidence.
          if (['chatgpt_cca', 'codex_work_web'].includes(thread.originator) && thread.parentThreadId == null
            && thread.threadSource !== 'subagent' && !thread.source?.subAgent) {
            for (const direction of ['desc', 'asc']) {
              const page = await request('thread/items/list', { threadId: thread.id, limit: 20, cursor: null, sortDirection: direction });
              if (!Array.isArray(page?.data)) throw new Error('invalid item page');
              ++diagnostics.itemPages;
              let matched = null;
              for (const row of page.data) {
                const item = row?.item || row;
                if (typeof item?.type !== 'string') throw new Error('invalid item structure');
                const user = item.type === 'userMessage' ? id(item.clientId) : null;
                const turn = id(row?.turnId);
                if ((user && userIds.has(user)) || (turn && turns.has(turn))) {
                  matched = { threadId: id(thread.id), backend: route, confidence: 'verified',
                    matchedBy: user && userIds.has(user) ? 'user-message-id' : 'work-activity-turn',
                    matchedUserMessageId: user && userIds.has(user) ? user : null, matchedTurnId: turn,
                    normalizedFromSonic: true, url: core.threadUrl(id(thread.id)),
                    model: typeof thread.model === 'string' ? thread.model : null,
                    createdAt: thread.createdAt ?? null };
                }
              }
              if (matched) { candidates.set(matched.threadId, matched); probe.state = 'verified'; break; }
              if (!page.nextCursor) break;
            }
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          Object.assign(probe, classify(error));
          if (probe.state === 'read-error') {
            diagnostics.partial = true;
            diagnostics.failures.push({ stage: 'association/read', code: probe.code, message: probe.reason });
          }
        }
        diagnostics.probes.push(probe);
      }));
    } finally { client.close(); }
    diagnostics.probes.sort((a, b) => samples.findIndex(s => s.originalId === a.originalId)
      - samples.findIndex(s => s.originalId === b.originalId));
    if (candidates.size) return { status: 'matched', candidates: [...candidates.values()], diagnostics,
      requiresConfirmation: true, canContinue: false, message: '已通过当前分支消息/活动 ID 独立核验，请选择关联记录。' };
    const unsupported = diagnostics.probes.every(p => p.state === 'route-unsupported');
    const state = diagnostics.partial ? 'read-error' : unsupported ? 'route-unsupported' : 'mapping-unavailable';
    return { status: state, code: diagnostics.partial ? 'CODEX_READ_ERROR' : unsupported ? 'CODEX_ROUTE_UNSUPPORTED' : 'CODEX_MAPPING_UNAVAILABLE',
      candidates: [], diagnostics, requiresConfirmation: true, canContinue: false,
      message: diagnostics.partial ? '关联诊断遇到读取错误；未判定线程不存在。可重试诊断。'
        : unsupported ? '已发现后台标识，但当前 Codex Cloud 入口不支持其 placement 格式。尚未验证 Sonic 与 Codex 的映射；不会自动拼接链接。深度查找只检查当前入口可读的历史。'
          : '已发现后台标识，但尚无独立证据将它关联到当前 Chat。未自动打开；深度查找可检查更多可读历史。' };
  }
  async function lookup(conversation, token, options = {}) {
    const core = globalThis.__cvCodexThread, direct = core.conversationEvidence(conversation);
    // Chat 模式（Pro 走 Sonic 后台）背后没有 Codex 根线程：不探测 Sonic ID，也不扫描账号线程。
    if (direct.mode === 'chat') return { status: 'chat-mode', code: 'CODEX_CHAT_MODE', candidates: [],
      requiresConfirmation: true, canContinue: false,
      diagnostics: { scope: 'mode', mode: 'chat', requests: 0, sonicCount: evidence(conversation).length, partial: false },
      message: 'Chat 模式：当前分支没有 Work 标记（async_source、工作活动或子 agent），这几轮由 Pro 后台执行，没有对应的 Codex 线程。' };
    // Work 对话一律走精确 ID 查找；Sonic 标识诊断（inspect）不再用于 lookup——Sonic 属于 Chat 模式，没有 Codex 线程。
    try { return await core.resolve(conversation, token, options); }
    catch (error) {
      if (error.code !== 'LOOKUP_NO_MATCH') throw error;
      return { status: 'no-match', code: error.code, candidates: [], canContinue: false,
        requiresConfirmation: true, diagnostics: error.diagnostics, message: error.message };
    }
  }
  // Only allowlisted counts and identifiers may be persisted; never token, conversation text, tool body or raw _meta.
  function record(outcome, context = {}) {
    const status = ['matched', 'paused', 'no-match', 'chat-mode', 'route-unsupported', 'mapping-unavailable', 'read-error', 'cancelled'].includes(outcome?.status)
      ? outcome.status : outcome?.ok === false ? 'read-error' : 'matched';
    const d = outcome?.diagnostics || {};
    const statistics = {};
    for (const key of ['requests', 'itemPages', 'totalItemPages', 'rootsListed', 'rootsChecked', 'rootsCompleted',
      'rootsPending', 'rootsFailed', 'sonicCount', 'sampleCount', 'windowRoots', 'rootsSkippedByWindow'])
      if (Number.isSafeInteger(d[key]) && d[key] >= 0) statistics[key] = d[key];
    const safeCode = value => typeof value === 'string' && /^[A-Z_0-9-]{1,64}$/.test(value) ? value : typeof value === 'number' ? value : null;
    const cleanProbe = probe => ({ originalId: sonic.test(probe?.originalId || '') ? probe.originalId : null,
      normalizedId: id(probe?.normalizedId), messageId: id(probe?.messageId), userMessageId: id(probe?.userMessageId),
      state: ['verified', 'readable-unverified', 'route-unsupported', 'invalid-identifier', 'read-error', 'cancelled'].includes(probe?.state) ? probe.state : 'unverified',
      code: safeCode(probe?.code), placementVersion: Number.isSafeInteger(probe?.placementVersion) ? probe.placementVersion : null,
      placementRegion: Number.isSafeInteger(probe?.placementRegion) ? probe.placementRegion : null });
    return { schemaVersion: 1, lookupVersion: version, recordedAt: new Date().toISOString(),
      lookupId: id(context.lookupId), conversationId: id(context.conversationId), branchNodeId: id(outcome?.branchNodeId),
      mode: context.deepScan ? 'history' : 'normal', status, code: safeCode(outcome?.code),
      httpStatus: Number.isInteger(outcome?.httpStatus) && outcome.httpStatus >= 100 && outcome.httpStatus <= 599 ? outcome.httpStatus : null,
      stage: ['conversation-fetch', 'association', 'lookup', 'cancelled'].includes(outcome?.stage) ? outcome.stage : d.scope === 'association' ? 'association' : 'lookup',
      scope: ['metadata', 'association', 'history', 'root-heads', 'mode'].includes(d.scope) ? d.scope : null,
      backend: route, partial: d.partial === true, canContinue: outcome?.canContinue === true || d.canContinue === true,
      statistics, probes: (Array.isArray(d.probes) ? d.probes : []).slice(0, 3).map(cleanProbe),
      candidates: (Array.isArray(outcome?.candidates) ? outcome.candidates : []).slice(0, 20).filter(c => id(c?.threadId)).map(c => ({
        threadId: id(c.threadId), confidence: c.confidence === 'verified' ? 'verified' : 'candidate',
        matchedBy: ['user-message-id', 'work-activity-turn', 'collab-sender', 'subagent', 'workspace', 'first-user-message', 'dots'].includes(c.matchedBy) ? c.matchedBy : 'unknown',
        matchedUserMessageId: id(c.matchedUserMessageId), matchedTurnId: id(c.matchedTurnId) })) };
  }
  globalThis.__cvCodexAssociation = { version, evidence, classify, inspect, lookup, record };
})();
