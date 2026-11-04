// One lifecycle/settings owner for the isolated page scripts. This version identifies
// the code in this document, not a newly reloaded extension service worker.
(() => {
  if (globalThis.__cvPage) return;
  // 取自本文档注入时的扩展清单：注入后不会再变，所以仍能识别「这份页面代码」的版本，升级也不必再逐个文件改号。
  const version = (() => { try { return chrome.runtime.getManifest().version; } catch { return 'unknown'; } })();
  const defaults = { injectionEnabled: true, durations: true, speedMetrics: true,
    dotsTitle: true, stalledTurn: true, syncEnabled: true, auto: true, diagnostics: false,
    recoveryReadMinMin: 5 };   // 恢复轮询按对话限频（分钟，0 = 不限），交给 MAIN 世界的 page-conversation.js
  const recoveryReadMinMs = () => {
    const v = Number(settings.recoveryReadMinMin);
    return Number.isFinite(v) && v >= 0 && v <= 60 ? Math.round(v) * 60e3 : defaults.recoveryReadMinMin * 60e3;
  };
  let settings = { ...defaults }, loaded = false, invalid = false, lastError = null;
  const subscribers = new Set();
  const changedBeforeLoad = new Set();
  // 扩展重载时新旧两份隔离脚本会同时存在一小会儿：旧的在心跳里发现失效后会发「关闭」，
  // 可能晚于新实例的「开启」（2026-10-09 实测：旧标签页从此不再采集发送与推流）。
  // 开关消息带上本实例的启动时刻，MAIN 世界只听最新实例的。
  const instance = Date.now() + Math.random() / 10;
  const can = key => loaded && !invalid && settings.injectionEnabled && (!key || settings[key] === true);
  const snapshot = () => ({ version, phase: invalid ? 'reload_required' : !loaded ? 'loading' :
    settings.injectionEnabled ? 'ready' : 'disabled', settings: { ...settings }, last_error: lastError });
  function publish() {
    for (const fn of subscribers) {
      try { fn(snapshot()); } catch (err) { console.debug('[ChatVault lifecycle]', err.message); }
    }
    window.postMessage({ __chatVaultStreamControlV1: true, enabled: can('speedMetrics'), instance }, location.origin);
    window.postMessage({ __chatVaultPageConversationControlV1: true, enabled: can(), instance,
      recoveryReadMinMs: recoveryReadMinMs() }, location.origin);
  }
  function report(stage, err) {
    const message = err?.message || String(err);
    if (lastError?.stage !== stage || lastError.message !== message) lastError = { stage, message, at: Date.now() };
    if (!invalid && /extension context invalidated/i.test(message)) { invalid = true; publish(); }
  }
  async function run(stage, task) {
    if (invalid) throw new Error('Extension context invalidated. 请刷新此页面');
    try { return await task(); } catch (err) { report(stage, err); throw err; }
  }
  const ready = run('settings.load', () => chrome.storage.local.get(defaults))
    .then(value => {
      for (const key of Object.keys(defaults)) if (!changedBeforeLoad.has(key)) settings[key] = value[key] ?? defaults[key];
      loaded = true; publish();
    })
    .catch(() => { loaded = true; invalid = true; publish(); });
  // 兼容不认 instance 的旧版 MAIN 脚本：旧实例 2 秒心跳内就会发出「关闭」，之后再补发两次当前状态。
  void ready.then(() => { for (const delay of [3000, 6000]) setTimeout(() => { if (!invalid) publish(); }, delay); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || invalid) return;
    let changed = false;
    for (const key of Object.keys(defaults)) if (changes[key]) {
      if (!loaded) changedBeforeLoad.add(key);
      settings[key] = changes[key].newValue ?? defaults[key]; changed = true;
    }
    if (changed) publish();
  });
  // Existing pages survive extension reload, but their chrome.* bindings do not.
  // Detect that without downloading conversations or repeatedly calling storage.
  const heartbeat = setInterval(() => {
    try {
      if (!chrome.runtime.id) report('context', new Error('Extension context invalidated.'));
    } catch (err) { report('context', err); }
    if (invalid) clearInterval(heartbeat);
  }, 2000);
  globalThis.__cvPage = { version, ready, can, run, report, snapshot,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } };
})();
