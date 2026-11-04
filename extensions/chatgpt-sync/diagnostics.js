// 页面侧轻量诊断。关键阶段先等后台确认落盘，页面崩溃时仍能看到最后一个 start。
(() => {
  const HEARTBEAT_MS = 5000;
  const navId = crypto.randomUUID();
  let enabled = false;
  let lastBeat = performance.now();
  let longTaskObserver = null;
  let longTasks = [];
  let mutationBatches = 0;
  let mutationRecords = 0;
  let renders = 0;
  let renderTotalMs = 0;
  let renderMaxMs = 0;

  function conversationId() {
    return /\/c\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(location.pathname)?.[1] || null;
  }

  function setEnabled(value) {
    enabled = value === true;
    if (enabled && !longTaskObserver && typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ at_ms: Math.round(entry.startTime), duration_ms: Math.round(entry.duration) });
        }
      });
      longTaskObserver.observe({ type: 'longtask' });
    } else if (!enabled && longTaskObserver) {
      longTaskObserver.disconnect();
      longTaskObserver = null;
      longTasks = [];
    }
  }

  const ready = globalThis.__cvPage ? globalThis.__cvPage.ready : Promise.resolve()
    .then(() => chrome.storage.local.get({ diagnostics: false })).then(({ diagnostics }) => {
    setEnabled(diagnostics);
    if (enabled) void emit('navigation.start', { url: location.href }, true);
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (globalThis.__cvPage) return;
    if (area === 'local' && changes.diagnostics) {
      setEnabled(changes.diagnostics.newValue);
      if (enabled) void emit('diagnostics.enabled', {}, true);
    }
  });
  globalThis.__cvPage?.subscribe(() => {
    const wasEnabled = enabled;
    setEnabled(globalThis.__cvPage.can('diagnostics'));
    if (enabled && !wasEnabled) void emit('diagnostics.enabled', {}, true);
  });

  async function emit(event, details = {}, durable = false) {
    if (!enabled) return false;
    const payload = { source: 'content', event, ts: new Date().toISOString(),
      perf_ms: Math.round(performance.now()), nav_id: navId,
      conversation_id: conversationId(),
      dots_id: /^\/dots\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(location.pathname)?.[1] || null,
      visibility: document.visibilityState, ...details };
    const send = async () => {
      let timeout;
      try {
        const result = await Promise.race([
          chrome.runtime.sendMessage({ type: 'diagnosticEvent', event: payload }),
          new Promise((resolve) => { timeout = setTimeout(() => resolve({ ok: false }), 2500); }),
        ]);
        return result?.ok === true;
      } catch { return false; } finally { clearTimeout(timeout); }
    };
    if (durable) return send();
    void send();
    return true;
  }

  function recordMutation(count) {
    if (!enabled) return;
    mutationBatches++;
    mutationRecords += count;
  }
  function recordRender(ms) {
    if (!enabled) return;
    renders++;
    renderTotalMs += ms;
    renderMaxMs = Math.max(renderMaxMs, ms);
  }

  setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, Math.round(now - lastBeat - HEARTBEAT_MS));
    lastBeat = now;
    if (!enabled) return;
    const heap = performance.memory;
    const snapshot = { lag_ms: lag, js_heap_used_bytes: heap?.usedJSHeapSize ?? null,
      js_heap_limit_bytes: heap?.jsHeapSizeLimit ?? null,
      mutation_batches: mutationBatches, mutation_records: mutationRecords,
      render_count: renders, render_total_ms: Math.round(renderTotalMs),
      render_max_ms: Math.round(renderMaxMs), long_tasks: longTasks };
    mutationBatches = 0;
    mutationRecords = 0;
    renders = 0;
    renderTotalMs = 0;
    renderMaxMs = 0;
    longTasks = [];
    void emit('heartbeat', snapshot);
  }, HEARTBEAT_MS);

  globalThis.__cvDiag = { navId, ready, enabled: () => enabled, emit, recordMutation, recordRender };
})();
