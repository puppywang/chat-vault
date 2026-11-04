import { rememberCodexLookup } from './codex-lookup-journal.js';
// 对话同步和只读标签页诊断都由扩展后台发往本机 ChatVault。
//
// 必须由 background 发这个请求：它有 host_permissions，不受 CORS 约束；而 ChatVault
// 的 /api/ingest/chatgpt 刻意不发 CORS 头，所以普通网页跨源写不进去，只有扩展能写。
import { syncPageInjection, injectOpenTabs, injectTab } from './injection.js';
import { refreshDotsTitles } from './dots-title-background.js';
import { countTexts } from './tokenizer.js';
import { createMeasuredWriter } from './measured-durations.js';
import { createBadge } from './badge.js';
import { createSyncChunks } from './sync-chunks.js';
import './tunnel-status.js';

const rememberMeasured = createMeasuredWriter(chrome.storage.local);

const DEFAULTS = { port: 8377, auto: true, syncEnabled: true,
  injectionEnabled: true, diagnostics: false };

let injectionUpdate = Promise.resolve();
function updateInjection() {
  injectionUpdate = injectionUpdate.catch(() => {}).then(async () => {
    const { injectionEnabled, speedMetrics } = await chrome.storage.local.get({
      injectionEnabled: DEFAULTS.injectionEnabled, speedMetrics: true });
    return syncPageInjection(injectionEnabled, chrome.scripting, speedMetrics);
  });
  return injectionUpdate;
}
// 安装/更新/重新加载：已打开标签页里的旧脚本已与扩展断开，先更新注册，再给这些标签页补注入。
chrome.runtime.onInstalled.addListener(() => {
  void updateInjection().then(async () => {
    const { injectionEnabled, speedMetrics } = await chrome.storage.local.get({ injectionEnabled: DEFAULTS.injectionEnabled, speedMetrics: true });
    const summary = await injectOpenTabs({ enabled: injectionEnabled, speedMetrics });
    await chrome.storage.local.set({ lastReinjection: { ...summary, at: new Date().toISOString(),
      version: chrome.runtime.getManifest().version } });
  }).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => { void updateInjection().catch(console.error); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.injectionEnabled || changes.speedMetrics)) {
    void updateInjection().catch(console.error);
  }
  if (area === 'local' && ['injectionEnabled', 'syncEnabled', 'auto', 'durations', 'diagnostics'].some((k) => changes[k])) {
    void postDiagnostic({ source: 'background', event: 'settings.changed',
      changes: Object.fromEntries(Object.entries(changes)
        .filter(([k]) => ['injectionEnabled', 'syncEnabled', 'auto', 'durations', 'diagnostics'].includes(k))
        .map(([k, v]) => [k, v.newValue])) });
  }
});
void updateInjection().catch(console.error);

async function postDiagnostic(event) {
  try {
    const { diagnostics, port } = await chrome.storage.local.get(DEFAULTS);
    if (!diagnostics) return { skipped: true };
    const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/chatgpt-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...event, background_ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`诊断事件写入失败: HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    console.warn('[ChatVault diagnostics]', err);
    return { ok: false, error: err.message };
  }
}

async function endpoint() {
  const { port } = await chrome.storage.local.get({ port: DEFAULTS.port });
  return `http://127.0.0.1:${port}/api/ingest/chatgpt`;
}

// 30 秒采样一次：即使 ChatGPT 标签页的 renderer 卡死，service worker 仍可
// 获取标签页元信息并记录内容脚本的超时。Chrome MV3 alarms 能唤醒休眠的 worker。
const DIAGNOSTIC_ALARM = 'chatgpt-tab-diagnostics';
const DOTS_TITLE_ALARM = 'chatgpt-dots-title';
const TUNNEL_ALARM = 'chappie-tunnel-health';
const badge = createBadge();

// 扩展自己读对话时角标显示「↓」：按标签页计数（同一页可能并发），超过 2 分钟没结束的视为丢失、不再点亮。
const fetchActivity = new Map();   // tabId -> { n, at }
function paintFetchActivity() {
  const now = Date.now();
  for (const [tabId, e] of fetchActivity) if (e.n <= 0 || now - e.at > 120_000) fetchActivity.delete(tabId);
  void badge.fetching(fetchActivity.size > 0);
}
chrome.tabs.onRemoved.addListener(tabId => { if (fetchActivity.delete(tabId)) paintFetchActivity(); });
// 读对话因 429 全局暂停（content.js 写 cvConversationPauseV1，弹窗「恢复读取」清掉）：角标显示「停」。
const CONVERSATION_PAUSE_KEY = 'cvConversationPauseV1';
void chrome.storage.local.get({ [CONVERSATION_PAUSE_KEY]: null }).then(o => badge.paused(!!o?.[CONVERSATION_PAUSE_KEY])).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CONVERSATION_PAUSE_KEY]) void badge.paused(!!changes[CONVERSATION_PAUSE_KEY].newValue);
});

/** 每分钟读一次本机 otunnel health，异常时在图标角标上提示（不用打开弹窗、也不用等 ChatGPT 报 disconnected）。 */
let tunnelInFlight = null;
function checkTunnel() {
  tunnelInFlight ||= (async () => {
    const { tunnelPort } = await chrome.storage.local.get({ tunnelPort: globalThis.__cvTunnel.DEFAULT_PORT });
    const state = await globalThis.__cvTunnel.check({ port: tunnelPort });
    await badge.tunnel(state);
    await alertTunnel(state);
  })().catch(err => console.debug('[ChatVault tunnel]', err?.message || err)).finally(() => { tunnelInFlight = null; });
  return tunnelInFlight;
}

/**
 * 隧道不可用（红色：未运行，或轮询停滞 5 分钟——ChatGPT 侧报 tunnel-client did not poll）时发一次桌面通知，
 * 恢复后再发一次。未运行要连续两次检查（约 1 分钟）才通知：supervisor 重拉 otunnel 时有 15 秒空档。
 * 状态存 storage.session：service worker 休眠后不会重复通知。
 */
const TUNNEL_ALERT_KEY = 'cvTunnelAlertV1';
async function alertTunnel(state, now = Date.now()) {
  if (!state || state.code === 'off' || state.code === 'foreign') return;
  let record = null;
  try { record = (await chrome.storage.session.get({ [TUNNEL_ALERT_KEY]: null }))[TUNNEL_ALERT_KEY]; } catch { /* 不可用时只是不通知 */ }
  const save = value => chrome.storage.session.set({ [TUNNEL_ALERT_KEY]: value }).catch(() => {});
  const notify = (title, message) => chrome.notifications.create(`cv-tunnel-${now}`, {
    type: 'basic', iconUrl: 'icon128.png', title, message: String(message).slice(0, 200), priority: 2 }, () => void chrome.runtime.lastError);
  if (state.kind === 'bad') {
    if (!record) record = { firstBadAt: now, notified: false };
    if (!record.notified && (state.code !== 'down' || now - record.firstBadAt >= 50_000)) {
      notify('Chappie 隧道不可用：ChatGPT 调不到 Pi', state.text);
      record.notified = true;
    }
    return save(record);
  }
  // 停滞未满 5 分钟（含刚重启、还没成功轮询）不算恢复；只有真正轮询成功才收尾
  if (state.kind !== 'ok' || !record) return;
  if (record.notified) notify('Chappie 隧道已恢复', `中断约 ${globalThis.__cvTunnel.fmtAge((now - record.firstBadAt) / 1000)}，可以让 ChatGPT 继续`);
  return chrome.storage.session.remove(TUNNEL_ALERT_KEY).catch(() => {});
}
const PROBE_TIMEOUT_MS = 2000;
let diagnosticsInFlight = null;

async function probeTab(tab) {
  const started = performance.now();
  let timeout;
  try {
    const page = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'diagnosticProbe' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('页面探针 2 秒未响应')), PROBE_TIMEOUT_MS); }),
    ]);
    return { tab_id: tab.id, window_id: tab.windowId, url: tab.url, title: tab.title,
      active: tab.active, discarded: tab.discarded, tab_status: tab.status,
      probe_status: 'responsive', probe_duration_ms: Math.round(performance.now() - started), page };
  } catch (err) {
    const timedOut = err?.message === '页面探针 2 秒未响应';
    return { tab_id: tab.id, window_id: tab.windowId, url: tab.url, title: tab.title,
      active: tab.active, discarded: tab.discarded, tab_status: tab.status,
      probe_status: timedOut ? 'timeout' : 'unavailable',
      probe_duration_ms: Math.round(performance.now() - started), probe_error: err?.message || String(err) };
  } finally { clearTimeout(timeout); }
}

async function sampleDiagnostics() {
  if (diagnosticsInFlight) return diagnosticsInFlight;
  diagnosticsInFlight = (async () => {
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
    const readings = await Promise.all(tabs.map(probeTab));
    const { port } = await chrome.storage.local.get({ port: DEFAULTS.port });
    const res = await fetch(`http://127.0.0.1:${port}/api/diagnostics/chatgpt-tabs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension_version: chrome.runtime.getManifest().version,
        sampled_at: new Date().toISOString(), tabs: readings }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`ChatVault 诊断上报失败: HTTP ${res.status}`);
    void postDiagnostic({ source: 'background', event: 'tab_probe',
      tabs: readings.map((r) => ({ tab_id: r.tab_id, conversation_id: r.page?.conversation_id || /\/c\/([0-9a-f-]{36})(?:\/|$)/i.exec(r.url || '')?.[1] || null,
        dots_id: /\/dots\/([0-9a-f-]{36})(?:\/|$)/i.exec(r.url || '')?.[1] || null,
        probe_status: r.probe_status, probe_duration_ms: r.probe_duration_ms,
        probe_error: r.probe_error || null, js_heap_used_bytes: r.page?.js_heap_used_bytes ?? null })) });
  })().catch((err) => console.debug('[ChatVault diagnostics]', err.message))
    .finally(() => { diagnosticsInFlight = null; });
  return diagnosticsInFlight;
}

function installDiagnosticAlarm() {
  chrome.alarms.create(DIAGNOSTIC_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(DOTS_TITLE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(TUNNEL_ALARM, { periodInMinutes: 1 });
  void sampleDiagnostics();
  void checkTunnel();
  void refreshDotsTitles().catch(console.error);
}
chrome.runtime.onInstalled.addListener(installDiagnosticAlarm);
chrome.runtime.onStartup.addListener(installDiagnosticAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DIAGNOSTIC_ALARM) void sampleDiagnostics();
  if (alarm.name === DOTS_TITLE_ALARM) void refreshDotsTitles().catch(console.error);
  if (alarm.name === TUNNEL_ALARM) void checkTunnel();
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.tunnelPort) void checkTunnel(); });
// 弹窗刚读过一次：直接用它的结果刷新角标，不必等下一次定时检查。
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'tunnelStatus' && sender.id === chrome.runtime.id && !sender.tab) void badge.tunnel(msg.state);
});
chrome.tabs.onActivated.addListener(() => { void sampleDiagnostics(); });
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.status === 'complete' && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || '')) {
    void sampleDiagnostics();
    if (tab.url.includes('/dots/')) void refreshDotsTitles().catch(console.error);
  }
});

function setBadge(ok, error = '') { void badge.syncResult(ok, error); }

// 全局 last 保留兼容；另按对话记一份，弹窗只显示当前标签页所在对话的同步结果。
async function record(last, conversationId = null) {
  const entry = { ...last, conversationId, at: new Date().toISOString() };
  const values = { last: entry };
  if (typeof conversationId === 'string' && /^(dots-)?[0-9a-f-]{36}$/i.test(conversationId)) values[`cvLastSyncV1:${conversationId}`] = entry;
  await chrome.storage.local.set(values);
}

// 大对话分块上传（见 content.js sendSync 与 sync-chunks.js）
const syncChunks = createSyncChunks();

async function ingest(payload, diagnostic = {}) {
  const { syncEnabled, injectionEnabled } = await chrome.storage.local.get(
    { syncEnabled: true, injectionEnabled: true });
  if (!syncEnabled || !injectionEnabled) throw new Error('同步或页面注入已关闭');
  const url = await endpoint();
  const active = (await chrome.storage.local.get({ diagnostics: false })).diagnostics;
  const context = { source: 'background', run_id: diagnostic.run_id || null,
    nav_id: diagnostic.nav_id || null, tab_id: diagnostic.tab_id ?? null,
    conversation_id: diagnostic.conversation_id || null };
  if (active) await postDiagnostic({ ...context, event: 'serialize.start' });
  const serializeStarted = performance.now();
  // 大对话由内容脚本分块送来，已经是序列化好的 JSON 文本
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (active) await postDiagnostic({ ...context, event: 'serialize.end',
    duration_ms: Math.round(performance.now() - serializeStarted), body_chars: json.length });
  let res;
  const uploadStarted = performance.now();
  if (active) await postDiagnostic({ ...context, event: 'upload.start', body_chars: json.length });
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        ...(active ? { 'X-ChatVault-Diagnostic': '1', 'X-ChatVault-Run-Id': context.run_id || '' } : {}) },
      body: json,
    });
  } catch (err) {
    if (active) await postDiagnostic({ ...context, event: 'upload.error',
      duration_ms: Math.round(performance.now() - uploadStarted), error: err.message });
    // 最常见的失败就是 ChatVault 没开着，直说，别让用户去翻控制台
    throw new Error(`连不上 ChatVault（${url}），确认 serve 正在运行、端口是否一致`);
  }
  const body = await res.json().catch(() => ({}));
  if (active) await postDiagnostic({ ...context, event: 'upload.end',
    duration_ms: Math.round(performance.now() - uploadStarted), status: res.status });
  if (!res.ok) throw new Error(body.error || `ChatVault 返回 ${res.status}`);
  return body;
}

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const whole = Math.floor(ms / 1000);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
  if (m) return `${m}m${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// 通知 id -> 发出它的标签页，点通知时跳回去
const notifyTabs = new Map();

/**
 * 一轮跑完了且你不在看 —— 发桌面通知。
 *
 * 为什么由扩展来发：实测 ChatGPT 网页在权限 granted 之后也不注册 Service Worker、
 * 不建推送订阅（采样 8 次全是 0），Web Push 这条链路在网页端根本没接通；设置里的
 * 「回复·推送」是给客户端用的服务端偏好。而扩展本来就精确知道一轮何时结束。
 */
function notifyTurnDone(msg, tabId) {
  const id = `cv-turn-${Date.now()}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icon128.png',
    // 页面打开时已在跑的一轮只测到后半段，不报用时以免误导。
    title: `${msg.kind === 'codex' ? 'Codex 任务完成' : 'ChatGPT 回复完成'}${msg.resumed ? '' : ` · 用时 ${fmtDur(msg.ms)}`}`,
    message: (msg.title || (msg.kind === 'codex' ? 'Codex 任务' : 'ChatGPT 对话')).slice(0, 80),
    priority: 1,
  }, () => {
    if (chrome.runtime.lastError) return;
    if (tabId != null) notifyTabs.set(id, tabId);
  });
}

/** Dot 在你不在看时发来的消息，静默一段时间后合并成一条（由 dots-notify.js 判定）。 */
function notifyDotsMessages(msg, tabId) {
  const count = Number.isInteger(msg.count) && msg.count > 0 ? msg.count : 1;
  const last = Number.isFinite(msg.lastAt) ? new Date(msg.lastAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const id = `cv-dots-${Date.now()}`;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icon128.png',
    title: `Dot 发来 ${count} 条新消息${last ? ` · 最后一条 ${last}` : ''}`,
    message: (msg.title || 'ChatGPT Dot').slice(0, 80),
    priority: 1,
  }, () => {
    if (chrome.runtime.lastError) return;
    if (tabId != null) notifyTabs.set(id, tabId);
  });
}

chrome.notifications.onClicked.addListener((id) => {
  const tabId = notifyTabs.get(id);
  if (tabId != null) {
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (!chrome.runtime.lastError && tab) chrome.windows.update(tab.windowId, { focused: true });
    });
  }
  chrome.notifications.clear(id);
  notifyTabs.delete(id);
});

chrome.notifications.onClosed.addListener((id) => notifyTabs.delete(id));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'rememberCodexLookup') {
    rememberCodexLookup(msg.record, sender).then(sendResponse);
    return true;
  }
  if (msg?.type === 'rememberMeasured') {
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.tab?.url || '')) {
      sendResponse({ ok: false, error: 'invalid_sender' }); return;
    }
    rememberMeasured(msg).then(sendResponse, err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // Pi 会话管理：弹窗 → 本机 ChatVault 的 /api/pi/*（页面脚本不准调用，只认扩展自己的页面）
  if (msg?.type === 'piApi') {
    if (sender.tab || sender.id !== chrome.runtime.id || typeof msg.path !== 'string' || !/^\/api\/(?:pi|codex|chatgpt)\/[A-Za-z0-9._\/-]*$/.test(msg.path)) {
      sendResponse({ ok: false, error: 'invalid_pi_api_request' });
      return;
    }
    (async () => {
      const { port } = await chrome.storage.local.get({ port: DEFAULTS.port });
      const method = ['GET', 'POST', 'DELETE'].includes(msg.method) ? msg.method : 'GET';
      const res = await fetch(`http://127.0.0.1:${port}${msg.path}`, { method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify(msg.body || {}) : undefined });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, ...data, error: res.ok ? data.error : (data.error || `HTTP ${res.status}`) };
    })().then(sendResponse, err => sendResponse({ ok: false, error: /Failed to fetch/i.test(err.message) ? 'ChatVault 未运行' : err.message }));
    return true;
  }
  if (msg?.type === 'countStreamTokens') {
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.tab?.url || '')
      || !Array.isArray(msg.texts) || !msg.texts.every(text => typeof text === 'string')) {
      sendResponse({ ok: false, error: 'invalid_token_count_request' });
      return;
    }
    try {
      sendResponse({ ok: true, tokens: countTexts(msg.texts), encoding: 'o200k_base' });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }
  if (msg?.type === 'diagnosticPing') {
    postDiagnostic({ source: 'background', event: 'diagnostics.ping' }).then(sendResponse);
    return true;
  }
  if (msg?.type === 'setInjection') {
    (async () => {
      const previous = (await chrome.storage.local.get({ injectionEnabled: true })).injectionEnabled;
      try {
        await chrome.storage.local.set({ injectionEnabled: msg.enabled === true });
        await updateInjection();
        return { ok: true };
      } catch (err) {
        try { await chrome.storage.local.set({ injectionEnabled: previous }); await updateInjection(); } catch { /* 保留原始错误 */ }
        return { ok: false, error: err.message };
      }
    })().then(sendResponse);
    return true;
  }
  if (msg?.type === 'diagnosticEvent') {
    postDiagnostic({ ...msg.event, source: 'content', tab_id: sender.tab?.id ?? null })
      .then(sendResponse);
    return true;
  }
  if (msg?.type === 'fetchActivity') {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const e = fetchActivity.get(tabId) || { n: 0, at: Date.now() };
    e.n = Math.max(0, e.n + (msg.active ? 1 : -1));
    e.at = Date.now();
    fetchActivity.set(tabId, e);
    paintFetchActivity();
    return;
  }
  if (msg?.type === 'turnDone') {
    notifyTurnDone(msg, sender.tab?.id);
    return; // 不需要回复
  }
  if (msg?.type === 'dotsMessages') {
    notifyDotsMessages(msg, sender.tab?.id);
    return;
  }
  if (msg?.type === 'reinjectTab' && Number.isInteger(msg.tabId)) {
    chrome.storage.local.get({ injectionEnabled: DEFAULTS.injectionEnabled, speedMetrics: true })
      .then(({ injectionEnabled, speedMetrics }) => {
        if (!injectionEnabled) return { tabId: msg.tabId, status: 'disabled' };
        return injectTab(msg.tabId, { speedMetrics });
      })
      .then(result => sendResponse({ ok: true, ...result }), err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'syncChunk') {
    sendResponse(syncChunks.accept(msg, sender));
    return;
  }
  if (msg?.type !== 'sync') return;
  const syncedId = msg.diagnostic?.conversation_id || msg.payload?.conversation?.conversation_id || null;
  let payload = msg.payload;
  if (msg.uploadId != null) {
    payload = syncChunks.take(msg.uploadId, sender);
    if (typeof payload !== 'string') {
      const error = payload.error;
      void record({ ok: false, summary: error }, syncedId);
      setBadge(false, error);
      sendResponse({ ok: false, error });
      return;
    }
  }
  ingest(payload, { ...msg.diagnostic, tab_id: sender.tab?.id })
    .then(async (body) => {
      const first = body.sessions?.[0];
      const summary = body.skipped ? body.skipped
        : first ? `${first.title}（${first.messages} 条）` : '已同步';
      await record({ ok: true, summary }, syncedId);
      setBadge(true);
      sendResponse({ ok: true, ...body });
    })
    .catch(async (err) => {
      await record({ ok: false, summary: err.message }, syncedId);
      setBadge(false, err.message);
      sendResponse({ ok: false, error: err.message });
    });
  return true; // 异步回复
});
