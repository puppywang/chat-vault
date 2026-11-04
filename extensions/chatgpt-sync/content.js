// 在 chatgpt.com 页面里跑：认出当前打开的是哪个对话，把它的 JSON 交给 background。
//
// 隐身（2026-10-16）：普通 /c/ 对话不再自己读 /backend-api/conversation*，只用页面自己读到的数据
// （page-conversation.js 克隆交来，conversation-merge.js 合并成一棵树）。读历史按账号限流，约每分钟一次，
// 以前扩展每轮开始、结束、定时各读一次整段对话，很容易 429，还会和页面自己的恢复轮询抢额度。
// 数据结构与官方导出同构（mapping + current_node 的树），ChatVault 复用导出的解析规则；不扒 DOM。
// dots 与 Codex Cloud 走各自的接口，照旧自己取（要 Bearer token：/api/auth/session 返回 accessToken）。

const CHECK_INTERVAL_MS = 1000;   // 轮询 URL 变化（SPA 路由不发 navigation 事件）
const RESYNC_INTERVAL_MS = 120000; // 停在同一个对话里继续聊时的回补间隔
const SETTLE_MS = 1500;           // 切进对话后等一下，避免刚开就抓到半截
const MAX_ASSETS = 20;            // 单个对话最多捞多少张图
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const diag = globalThis.__cvDiag;
const page = globalThis.__cvPage;
const pageEnabled = (key) => !page || page.can(key);
const reportPageError = (stage, error) => page?.report(stage, error);
async function readSettings(defaults) {
  return page ? page.run('settings.read', () => chrome.storage.local.get(defaults))
    : chrome.storage.local.get(defaults);
}
const conversationLoads = new Map();
let loadedConversation = null; // 当前路由已下载的快照；查 Codex 时复用，不依赖耗时开关。
// 页面自己读到的对话：整棵树或当前分支的分页，逐份并进 pageView（同一对话内累积，换对话清空）。
const PAGE_DATA_WAIT_MS = 6000;      // 刚进入对话时等页面自己的读取
let pageView = null;                 // { id, conv, receivedAtMs }
let pageCaptureReady = false;        // 页面侧脚本已应答（旧注册或未刷新时为 false，不等待）
const pageDataWaiters = new Set();
const Merge = globalThis.ChatVaultConversationMerge;
// 只读诊断：received 整棵树 / branchReceived 分页 / reused 复用 / fetched 自行下载（dots、Codex Cloud，及本页跑完一轮后的补读）。
const pageCaptureStats = { received: 0, reused: 0, fetched: 0, lastReceivedAt: null,
  branchReceived: 0, branchPartial: 0, skippedByPage: 0, recoverySkipped: 0, lastRecoverySkipAt: null,
  recoveryThrottled: 0, lastRecoveryThrottleAt: null };
let pageBranchMeta = null;          // 最近一页分页的概况（诊断用）：{ id, updateTime, receivedAtMs, complete }
let conversationRetryAt = 0;
function conversationRateLimitError() {
  const seconds = Math.max(0, Math.ceil((conversationRetryAt - Date.now()) / 1000));
  const error = new Error(seconds ? `ChatGPT 对话接口触发限流（429），请 ${seconds} 秒后重试`
    : 'ChatGPT 对话接口触发限流（429），请稍后重试');
  error.status = 429;
  error.retryAt = conversationRetryAt;
  return error;
}
// dots 与 Codex Cloud 都不是普通 /c/ 对话：不走 /backend-api/conversation，
// 因此既不受它的 429 限流影响，也没有页面快照可复用。
const isAltConversation = (id) => typeof id === 'string'
  && (id.startsWith('dots-') || id.startsWith('codex-'));
// 429 全局暂停（2026-10-16 用户要求）：任一标签页读对话碰到 429，所有标签页都停止自己读对话，
// 直到用户在弹窗里手动恢复。读对话接口按账号限流（x-oai-history-*），各标签页继续重试只会互相抢额度、
// 让页面自己的恢复轮询也接不上。页面交来的快照照常复用（不发请求）。
const PAUSE_KEY = 'cvConversationPauseV1';
let conversationPause = null;
try {
  chrome.storage.local.get({ [PAUSE_KEY]: null }).then(o => { conversationPause = o?.[PAUSE_KEY] || null; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PAUSE_KEY]) conversationPause = changes[PAUSE_KEY].newValue || null;
  });
} catch { /* 单测环境 */ }
function conversationPausedError() {
  const at = new Date(conversationPause?.at || Date.now());
  const error = new Error(`读取对话已暂停：${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')} 碰到限流（429），在扩展弹窗点「恢复读取」后继续`);
  error.status = 429;
  error.paused = true;
  return error;
}
function assertConversationAvailable(id) {
  if (isAltConversation(id)) return;
  if (conversationPause) throw conversationPausedError();
  if (conversationRetryAt > Date.now()) throw conversationRateLimitError();
}
function pauseConversationReads(id, retryAfterSec) {
  conversationPause = { at: Date.now(), conversationId: id, retryAfterSec, reason: '429' };
  try { void chrome.storage.local.set({ [PAUSE_KEY]: conversationPause }).catch(() => {}); } catch { /* 扩展重载后失效 */ }
}
/** 扩展自己读对话时点亮工具栏图标的「↓」：后台按标签页计数，结束时熄灭。 */
function reportFetchActivity(active) {
  try { void chrome.runtime.sendMessage({ type: 'fetchActivity', active }).catch(() => {}); } catch { /* 同上 */ }
}
function rememberConversationRateLimit(response, id = null) {
  const now = Date.now();
  const value = response.headers.get('retry-after')?.trim();
  const seconds = value ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  const serverDate = Date.parse(response.headers.get('date') || '');
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - (Number.isFinite(serverDate) ? serverDate : now))
      : 30000;
  conversationRetryAt = Math.max(conversationRetryAt, now + delay);
  pauseConversationReads(id, Math.round(delay / 1000));
  throw conversationPausedError();
}
/** 自己下载的与页面交来的快照走同一套登记：当前路由快照、轮次校时、Codex 证据。 */
function acceptConversation(id, conv) {
  conv.conversation_id ||= id;
  if (id === conversationId() && conv.conversation_id === id) loadedConversation = { id, conv };
  try { window.__cvTurns?.observeConversation?.(conv, { clockSkewMs }); }
  catch (err) { reportPageError('round.reconcile', err); }
  // 只记本轮是否 Work 模式及 turnId 等结构字段，供推送中断时核对 Codex，不额外请求。
  globalThis.__cvStalledTurn?.observeConversation(conv);
}
function pageConversation(id) { return pageView?.id === id ? pageView.conv : null; }
function waitForPageData(id, ms) {
  if (!pageCaptureReady) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter = { id, resolve };
    waiter.timer = setTimeout(() => { pageDataWaiters.delete(waiter); resolve(null); }, ms);
    pageDataWaiters.add(waiter);
  });
}
// 一轮结束时的补读（见 loadConversation）：按对话限频
const TURN_END_FETCH_MIN_MS = 60_000;
const turnEndFetchAt = new Map();   // 对话 id → 上次补读时刻
function takeTurnEndFetch(id) {
  const last = turnEndFetchAt.get(id);
  if (last != null && Date.now() - last < TURN_END_FETCH_MIN_MS) return false;
  turnEndFetchAt.set(id, Date.now());
  return true;
}
function noPageDataError() {
  const error = new Error(pageCaptureReady
    ? '页面还没读到这个对话：在侧边栏切到别的对话再切回来，页面读到后会自动同步；本页跑完的一轮结束时扩展会补读一次'
    : '页面侧脚本未就绪：刷新这个标签页后再试');
  error.code = 'NO_PAGE_DATA';
  return error;
}
/** 页面读到的一份数据（整棵树或分页）：并进当前对话的 pageView，唤醒等待者。 */
function acceptPageData(id, incoming) {
  const conv = Merge ? Merge.merge(pageConversation(id), incoming) : incoming;
  pageView = { id, conv, receivedAtMs: Date.now() };
  acceptConversation(id, conv);
  for (const waiter of [...pageDataWaiters]) {
    if (waiter.id !== id) continue;
    clearTimeout(waiter.timer); pageDataWaiters.delete(waiter); waiter.resolve(conv);
  }
  return conv;
}
async function loadConversation(id, runId, reason) {
  if (conversationLoads.has(id)) return conversationLoads.get(id);
  if (isAltConversation(id)) assertConversationAvailable(id);
  const task = (async () => {
    if (!isAltConversation(id)) {
      // 只用页面读到的数据；刚进入对话时页面多半正在读，等它一会儿。
      const conv = pageConversation(id) || await waitForPageData(id, PAGE_DATA_WAIT_MS);
      if (!conv && reason === 'turn_end' && takeTurnEndFetch(id)) {
        // 本页新建、全程靠推送跑完的一轮：页面不会再读这个对话，扩展永远等不到页面数据。
        // 只在一轮结束时补读一次（同一对话 60 秒内至多一次），仍走 429 记账与全局暂停。
        const token = await diagnosticStage(runId, 'auth', accessToken);
        const fetched = await fetchConversation(id, token, runId, reason);
        pageCaptureStats.fetched++;
        return { token, conv: acceptPageData(id, fetched), source: 'fetch' };
      }
      if (!conv) throw noPageDataError();
      pageCaptureStats.reused++;
      if (diag?.enabled()) await diag.emit('conversation.reused', { run_id: runId, reason }, true);
      // 不预取登录态；只有确实要下载图片等才取。
      return { token: () => diagnosticStage(runId, 'auth', accessToken), conv, source: 'page' };
    }
    const token = await diagnosticStage(runId, 'auth', accessToken);
    const conv = await fetchConversation(id, token, runId, reason);
    pageCaptureStats.fetched++;
    acceptConversation(id, conv);
    return { token, conv, source: 'fetch' };
  })();
  conversationLoads.set(id, task);
  try { return await task; }
  finally { if (conversationLoads.get(id) === task) conversationLoads.delete(id); }
}

async function diagnosticStage(runId, stage, task, details = {}) {
  await diag?.ready;
  if (!diag?.enabled()) return task();
  await diag.emit(`${stage}.start`, { run_id: runId, ...details }, true);
  const started = performance.now();
  try {
    const result = await task();
    await diag.emit(`${stage}.end`, { run_id: runId, duration_ms: Math.round(performance.now() - started) }, true);
    return result;
  } catch (err) {
    await diag.emit(`${stage}.error`, { run_id: runId,
      duration_ms: Math.round(performance.now() - started), error: err.message }, true);
    throw err;
  }
}

let currentId = conversationId();
let timer = null;
let settleTimer = null;
let settleGeneration = 0;
let lastSynced = { id: null, key: '' }; // 与上次上传的是同一份（Merge.signature）就不重复上传
let busy = false;
let lastConv = null;   // 最近一次取到的对话，供懒加载补画耗时用
let clockSkewMs = 0;   // 本机时钟 − 服务端时钟（见 fetchConversation）
let paintGeneration = 0;
let paintRetryTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !lastConv) return;
  const id = conversationId();
  // 新记下 Codex 关联后，总览面板里的 Work 行随即出现「Codex ↗」。
  if (changes.speedMetrics || (id && (changes[`cvCodexLinkV1:${id}`] || changes[`cvWorkRoundV1:${id}`]))) paintTurns(lastConv);
});

function conversationId(path = location.pathname) {
  // /local/<thread-id> 是 Codex Cloud，独立归档键，不与 /c/ 对话混用
  const codex = globalThis.__cvCodexCloud?.conversationId(path);
  if (codex) return codex;
  if (globalThis.__cvDots) return globalThis.__cvDots.conversationId(path);
  const m = /\/c\/([0-9a-fA-F-]{36})/.exec(path);
  return m ? m[1] : null;
}

async function accessToken() {
  const r = await fetch('/api/auth/session', { credentials: 'include' });
  if (!r.ok) throw new Error(`读取登录态失败 (${r.status})`);
  const j = await r.json();
  if (!j?.accessToken) throw new Error('当前未登录 ChatGPT');
  return j.accessToken;
}

async function fetchConversation(id, token, runId = crypto.randomUUID(), reason = 'unknown') {
  if (globalThis.__cvCodexCloud?.isKey(id)) {
    return diagnosticStage(runId, 'codexCloud.fetch',
      () => globalThis.__cvCodexCloud.fetchConversation(id.slice('codex-'.length), token), { reason });
  }
  if (id.startsWith('dots-')) {
    return globalThis.__cvDots.fetchConversation(id.slice(5), async (path) => {
      const r = await diagnosticStage(runId, 'dots.fetch', () => fetch(path, {
        headers: { Authorization: `Bearer ${token}` }, credentials: 'include',
      }), { reason, path });
      if (!r.ok) throw new Error(`读取 Dots 消息失败 (${r.status})`);
      const d = Date.parse(r.headers.get('date') || '');
      if (Number.isFinite(d)) clockSkewMs = Date.now() - d;
      return diagnosticStage(runId, 'dots.json', () => r.json(), { reason, path });
    });
  }
  assertConversationAvailable(id);
  reportFetchActivity(true);
  let r, conv;
  try {
    r = await diagnosticStage(runId, 'conversation.fetch', () => fetch(`/backend-api/conversation/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    }), { reason });
    if (r.status === 429) rememberConversationRateLimit(r, id);
    if (!r.ok) throw Object.assign(new Error(`读取对话失败 (${r.status})`), { httpStatus: r.status });
    // 响应头的服务端时刻：create_time 是服务端时钟，计时器却用本机 Date.now() 算已用
    // 时间，本机时钟不准就会胡说。记下偏差，换算时补上。实测两者只差几百毫秒。
    const d = Date.parse(r.headers.get('date') || '');
    if (Number.isFinite(d)) clockSkewMs = Date.now() - d;
    conv = await diagnosticStage(runId, 'conversation.json', () => r.json(),
      { reason, content_length: Number(r.headers.get('content-length')) || null });
  } finally { reportFetchActivity(false); }
  if (diag?.enabled()) await diag.emit('conversation.summary', { run_id: runId, reason,
    mapping_nodes: Object.keys(conv?.mapping || {}).length }, true);
  return conv;
}

/** 图片字节不在对话 JSON 里，只有 asset_pointer，要另外按 id 换下载地址 */
function assetIds(conv) {
  const ids = new Set();
  for (const node of Object.values(conv?.mapping || {})) {
    const parts = node?.message?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part && typeof part === 'object'
        && part.content_type === 'image_asset_pointer'
        && typeof part.asset_pointer === 'string') {
        ids.add(part.asset_pointer.slice(part.asset_pointer.lastIndexOf('/') + 1));
      }
    }
  }
  return [...ids].slice(0, MAX_ASSETS);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(blob);
  });
}

async function fetchAsset(id, token) {
  try {
    const meta = await fetch(`/backend-api/files/${id}/download`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    if (!meta.ok) return null;
    const { download_url: url } = await meta.json();
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > MAX_ASSET_BYTES || !blob.type.startsWith('image/')) return null;
    return { mime: blob.type, data: await blobToBase64(blob) };
  } catch {
    return null; // 单张图取不到就算了，正文照样同步
  }
}

async function collectAssets(conv, token) {
  const ids = assetIds(conv);
  if (!ids.length) return null;
  if (typeof token === 'function') token = await token();
  const out = {};
  for (const id of ids) {
    const item = await fetchAsset(id, token);
    if (item) out[id] = item;
  }
  return Object.keys(out).length ? out : null;
}

async function syncNow(force = false, trigger = 'periodic') {
  const id = conversationId();
  if (!id) throw new Error('当前页面不是一个对话（打开某个对话后再试）');
  const { injectionEnabled, syncEnabled } = await readSettings({ injectionEnabled: true, syncEnabled: true });
  if (!injectionEnabled) return { skipped: '页面注入已关闭；刷新页面后将完全移除脚本' };
  if (!syncEnabled) return { skipped: '同步到 ChatVault 已关闭' };
  if (busy) return { skipped: '正在同步中' };
  busy = true;
  const runId = crypto.randomUUID();
  const started = performance.now();
  let result = 'error';
  try {
    await diag?.ready;
    if (diag?.enabled()) await diag.emit('sync.start', { run_id: runId, trigger, force }, true);
    let loaded;
    try { loaded = await loadConversation(id, runId, trigger); }
    catch (err) {
      if (err.code !== 'NO_PAGE_DATA') throw err;
      result = 'no_page_data';
      return { skipped: err.message };
    }
    const { token, conv } = loaded;
    if (!pageEnabled('syncEnabled')) return { skipped: '同步已停止' };
    paintTurns(conv, runId);
    if (!force && lastSynced.id === id && lastSynced.key === Merge?.signature(conv)) {
      pageCaptureStats.skippedByPage++;
      result = 'unchanged';
      return { skipped: '没有新内容' };
    }
    const assets = await diagnosticStage(runId, 'assets', () => collectAssets(conv, token));
    if (!pageEnabled('syncEnabled')) return { skipped: '同步已停止' };
    const reply = await diagnosticStage(runId, 'background.send', () => sendSync({ conversation: conv, assets },
      { run_id: runId, nav_id: diag?.navId || null, conversation_id: id }),
    { mapping_nodes: Object.keys(conv.mapping || {}).length });
    if (reply?.ok) lastSynced = { id, key: Merge?.signature(conv) || '' };
    if (!reply?.ok) throw new Error(reply?.error || '同步失败');
    result = 'synced';
    return reply;
  } catch (err) {
    reportPageError('sync', err);
    if (diag?.enabled()) await diag.emit('sync.error', { run_id: runId, trigger,
      error: err.message, duration_ms: Math.round(performance.now() - started) }, true);
    throw err;
  } finally {
    busy = false;
    if (diag?.enabled()) await diag.emit('sync.end', { run_id: runId, trigger, result,
      duration_ms: Math.round(performance.now() - started) }, true);
  }
}

// runtime.sendMessage 单条消息上限 64 MiB（按序列化后计）。Work 模式的长轮次能让整段对话超过这个数
// （2026-10-19 6ad3e536 归档 65.3 MB 后同步全部失败），所以大对话先序列化、切块发给后台，后台拼回后上传。
// 块按 UTF-16 码元计：中文按 UTF-8 最多 3 字节、JSON 转义最多翻倍，8M 码元离上限留足余量。
const SYNC_CHUNK_CHARS = 8 * 1024 * 1024;

async function sendSync(payload, diagnostic) {
  const json = JSON.stringify(payload);
  if (json.length <= SYNC_CHUNK_CHARS) return chrome.runtime.sendMessage({ type: 'sync', payload, diagnostic });
  const uploadId = crypto.randomUUID();
  const parts = [];
  for (let start = 0; start < json.length;) {
    let end = Math.min(start + SYNC_CHUNK_CHARS, json.length);
    // 不在代理对中间切开：半个代理对经消息序列化会被替换成 U+FFFD
    if (end < json.length && /[\uD800-\uDBFF]/.test(json[end - 1])) end--;
    parts.push([start, end]);
    start = end;
  }
  for (let index = 0; index < parts.length; index++) {
    const [start, end] = parts[index];
    const reply = await chrome.runtime.sendMessage({ type: 'syncChunk', uploadId, index, total: parts.length,
      data: json.slice(start, end) });
    if (!reply?.ok) throw new Error(reply?.error || `分块 ${index + 1}/${parts.length} 传给扩展后台失败`);
  }
  return chrome.runtime.sendMessage({ type: 'sync', uploadId, diagnostic });
}

/**
 * 一轮跑完了：你不在看才发桌面通知。
 * 「在不在看」必须在结束这一刻同步判断——后面有 await，等回来状态可能已经变了。
 */
function notifyIfAway(measuredMs, away, { title = null, kind = 'chat', resumed = false } = {}) {
  if (!away || !Number.isFinite(measuredMs)) return;
  chrome.storage.local.get({ notify: true, notifyMinSec: 30 }).then(({ notify, notifyMinSec }) => {
    // 页面打开时已在跑的一轮，测到的只是后半段，不套最短时长。
    if (!notify || (!resumed && measuredMs < notifyMinSec * 1000)) return;
    chrome.runtime.sendMessage({
      type: 'turnDone',
      ms: measuredMs,
      kind,
      resumed,
      title: title || (document.title || '').replace(/^ChatGPT\s*[-–—]\s*/, '').trim(),
    });
  }).catch(() => { /* 扩展被重载时 chrome.* 会失效 */ });
}

/**
 * 打开 Codex 线程页的实际结果（page-stream.js 观察到后转发）：warm = 后端还挂着会话、没发 thread/resume；
 * resumed = 恢复成功；failed = 恢复失败（页面会一直「正在加载模型」）。存到 cvCodexOpenV1:<thread>，弹窗线程列表显示。
 */
window.addEventListener?.('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const v = event.data;
  if (v?.__cvCodexResumeV1 !== true || !/^[0-9a-f-]{36}$/.test(v.threadId || '')
    || !['warm', 'resumed', 'failed'].includes(v.outcome)) return;
  const record = { outcome: v.outcome, at: Number.isFinite(v.at) ? v.at : Date.now(), ms: Number.isFinite(v.ms) ? v.ms : null,
    resumeKind: typeof v.resumeKind === 'string' ? v.resumeKind.slice(0, 40) : null,
    error: typeof v.error === 'string' ? v.error.slice(0, 200) : null };
  try { void chrome.storage.local.set({ [`cvCodexOpenV1:${v.threadId}`]: record }).catch(() => {}); } catch { /* 扩展重载后 chrome.* 失效 */ }
});

/**
 * Codex Cloud 页（/local/<thread>）一轮结束：以 codex-cloud-backend 推来的 turn/completed 为准
 * （page-stream.js 转发，带 completedAtMs），不靠停止按钮——Codex 页的按钮和普通对话不同，
 * 普通对话的结束回调对 codex- 会话也是直接返回、不发通知的。
 * 同一轮结束后 token 用量更新还会再转发几次，按 requestId 只通知一次。
 */
const codexTurnsNotified = new Set();
function codexNotifyTitle() {
  const id = conversationId();
  const raw = lastConv && (lastConv.conversation_id || lastConv.id) === id ? lastConv.title || '' : '';
  // 标题取自首条提示词，形如「Codex Cloud · [$chappie](app://…) 连接 …」：去掉前缀和链接地址。
  return raw.replace(/^Codex Cloud\s*·\s*/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim() || 'Codex 任务';
}
window.addEventListener?.('message', (event) => {   // 单测里的 window 桩没有 addEventListener
  if (event.source !== window || event.origin !== location.origin) return;
  const v = event.data;
  if (v?.__chatVaultStreamMetricsV1 !== true || v.kind === 'tokenize' || !Number.isFinite(v.completedAtMs)) return;
  if (typeof v.conversationId !== 'string' || !v.conversationId.startsWith('codex-')
    || v.conversationId !== conversationId()) return;
  const key = `${v.conversationId}:${v.requestId}`;
  if (codexTurnsNotified.has(key)) return;
  codexTurnsNotified.add(key);
  if (!pageEnabled()) return;
  const away = document.visibilityState !== 'visible' || !document.hasFocus();
  const ms = Number.isFinite(v.requestStartMs) ? Math.max(0, v.completedAtMs - v.requestStartMs) : 0;
  notifyIfAway(ms, away, { title: codexNotifyTitle(), kind: 'codex', resumed: v.codexSend !== true });
});

const MEASURED_KEY = 'turnDurations';

/** 读实测耗时表 */
async function measuredMap() {
  try {
    const o = await chrome.storage.local.get({ [MEASURED_KEY]: {} });
    return o[MEASURED_KEY] || {};
  } catch { return {}; }
}

/** 已记录的「对话 → Codex 根线程」（查找核验成功或推送中断核对时写入），只读本地，不发请求。 */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function linkedCodexUrl(convId) {
  if (!convId || isAltConversation(convId)) return null;
  try {
    const keys = [`cvCodexLinkV1:${convId}`, `cvWorkRoundV1:${convId}`];
    const stored = await chrome.storage.local.get(keys);
    const threadId = [stored?.[keys[0]]?.threadId, stored?.[keys[1]]?.threadId].find(id => THREAD_ID_RE.test(id || ''));
    return threadId ? `https://chatgpt.com/local/${threadId.toLowerCase()}?hostId=local` : null;
  } catch { return null; }
}

/**
 * 轮次摘要缓存：每次用真实数据画完都存一份（只有 id 与时间，不含正文），下次打开同一对话时
 * 先用它把浮层和徽标画出来，不必等页面读取或下载整段对话（大对话要几秒到几十秒）。最多留 40 个对话。
 */
const TURNS_CACHE_PREFIX = 'cvTurnsCacheV1:';
const TURNS_CACHE_INDEX = 'cvTurnsCacheIndexV1';
const TURNS_CACHE_MAX = 40;
const turnsCacheSignature = new Map();
let livePaintedId = null;    // 本路由已经用真实数据画过：缓存不能再盖回去
async function saveTurnsCache(convId, list, dots, empty = null) {
  const noUserTurns = empty === 'no-user';
  if (!convId || (!list?.length && !noUserTurns) || !window.__cvTurns?.compactTurns) return;
  const last = list[list.length - 1];
  const signature = noUserTurns ? 'no-user' : `${list.length}:${last.endId}:${last.end}:${last.count}`;
  if (turnsCacheSignature.get(convId) === signature) return;
  turnsCacheSignature.set(convId, signature);
  try {
    const { [TURNS_CACHE_INDEX]: index } = await chrome.storage.local.get({ [TURNS_CACHE_INDEX]: [] });
    const next = [convId, ...(Array.isArray(index) ? index : []).filter(id => id !== convId)];
    const evicted = next.splice(TURNS_CACHE_MAX);
    await chrome.storage.local.set({ [TURNS_CACHE_INDEX]: next,
      [TURNS_CACHE_PREFIX + convId]: { convId, dots: !!dots, turns: window.__cvTurns.compactTurns(list), savedAt: Date.now(),
        ...(noUserTurns ? { empty: 'no-user' } : {}) } });
    if (evicted.length) await chrome.storage.local.remove(evicted.map(id => TURNS_CACHE_PREFIX + id));
  } catch (err) { turnsCacheSignature.delete(convId); reportPageError('turns.cache', err); }
}
async function paintCached(id, generation) {
  if (!id || !pageEnabled('durations') || livePaintedId === id) return;
  const key = TURNS_CACHE_PREFIX + id;
  let cache = null;
  try { cache = (await chrome.storage.local.get(key))?.[key] || null; } catch { /* 读不到就只放加载中 */ }
  const stillFirst = () => generation === paintGeneration && conversationId() === id && livePaintedId !== id && pageEnabled('durations');
  if (!stillFirst()) return;
  if (cache?.convId !== id) { window.__cvTurns?.showTurnsLoading?.(id); return; }
  const [measured, codexUrl] = await Promise.all([measuredMap(), linkedCodexUrl(id)]);
  if (!stillFirst()) return;
  try {
    window.__cvTurns?.renderCached?.(cache, { measured, clockSkewMs, codexUrl, streaming: window.__cvTurns.isStreaming() });
  } catch (err) { reportPageError('render.cached', err); }
}

/** 记一条实测耗时：键是「对话 id : 本轮用户消息 id」 */
async function rememberMeasured(convId, startId, { measuredMs, startedAtMs, endedAtMs }) {
  if (!convId || !startId || !Number.isFinite(measuredMs) || measuredMs <= 0
    || !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'rememberMeasured', conversationId: convId,
      userMessageId: startId, measuredMs, startedAtMs, endedAtMs });
    if (!reply?.ok) throw new Error(reply?.error || 'duration_write_failed');
  } catch (err) { reportPageError('duration.persist', err); }
}

/**
 * 画每轮耗时。徽标要等 ChatGPT 把消息渲染出来才有锚点，所以隔一会儿重试几次
 * （长对话是懒加载的，往上滚会出现新的锚点，交给后面的 MutationObserver 补）。
 */
function paintTurns(conv, runId = crypto.randomUUID()) {
  if (!pageEnabled('durations')) return;
  const convId = conv.conversation_id || conv.id;
  if (convId && convId !== conversationId()) return;
  const generation = ++paintGeneration;
  clearTimeout(paintRetryTimer);
  paintRetryTimer = null;
  lastConv = conv;
  const draw = async (attempt) => {
    try {
      const [{ durations }, measured, codexUrl] = await Promise.all([
        readSettings({ durations: true }), measuredMap(), linkedCodexUrl(convId),
        Promise.resolve().then(() => globalThis.__cvSpeed?.hydrate(conv))
          .catch(err => reportPageError('speed.hydrate', err)),
      ]);
      if (!durations || !pageEnabled('durations') || generation !== paintGeneration
        || ((conv.conversation_id || conv.id) && (conv.conversation_id || conv.id) !== conversationId())) return;
      const summary = await diagnosticStage(runId, `render.paint_${attempt}`, () => {
        const started = performance.now();
        let kinds = null;
        try { kinds = conv.mapping ? globalThis.__cvCodexThread?.turnKinds?.(conv) || null : null; }
        catch (err) { reportPageError('render.kinds', err); }
        const result = window.__cvTurns?.renderTurns(conv, {
          streaming: window.__cvTurns.isStreaming(), measured, clockSkewMs, kinds, codexUrl,
        });
        diag?.recordRender(performance.now() - started);
        livePaintedId = conv.conversation_id || conv.id || conversationId();
        if (result?.list) void saveTurnsCache(livePaintedId, result.list, conv.cv_source === 'dots', result.empty || null);
        return result;
      });
      if (diag?.enabled()) void diag.emit('render.summary', { run_id: runId, attempt,
        turns: summary?.turns ?? null, anchored: summary?.anchored ?? null });
      // 消息锚点尚未出现时只补试一次；后续懒加载交给下面的观察器。
      if (summary?.turns > 0 && summary.anchored === 0 && attempt === 0) {
        paintRetryTimer = setTimeout(() => {
          paintRetryTimer = null;
          if (generation === paintGeneration) void draw(1);
        }, 1200);
      }
    } catch (err) { reportPageError('render', err); console.debug('[ChatVault] 重画耗时失败', err.message); }
  };
  void draw(0);
}

/** 只为画耗时而取一次对话（自动同步关掉时走这条） */
async function refreshTurns() {
  const id = conversationId();
  if (!id) return;
  try {
    const { durations, injectionEnabled } = await readSettings({ durations: true, injectionEnabled: true });
    if (!durations || !injectionEnabled || !pageEnabled('durations')) return;
    const { conv } = await loadConversation(id, crypto.randomUUID(), 'refresh_turns');
    paintTurns(conv);
  } catch (err) {
    if (err.code === 'NO_PAGE_DATA') return;   // 页面还没读到，等它读到时会补画
    reportPageError('refresh', err);
    console.debug('[ChatVault] 取耗时失败', err.message);
  }
}

/** 自动同步：切到新对话、或停在同一对话里聊了一阵，都回补一次 */
function schedule() {
  clearTimeout(timer);
  if (!pageEnabled()) return;
  timer = setTimeout(async () => {
    try {
      const { auto } = await readSettings({ auto: true });
      // 推送中断且已确认交给 Codex 的轮次：反复读取大对话只会撞 429，等页面恢复或换对话。
      if (auto && pageEnabled('syncEnabled') && document.visibilityState === 'visible'
        && !globalThis.__cvStalledTurn?.pausesSync(conversationId())) await syncNow(false, 'periodic');
    } catch (err) { reportPageError('schedule', err); console.debug('[ChatVault]', err.message); }
    finally { schedule(); }
  }, RESYNC_INTERVAL_MS);
}

async function onConversationChanged() {
  const generation = ++settleGeneration;
  clearTimeout(settleTimer);
  const id = conversationId();
  const { auto, injectionEnabled, syncEnabled } = await readSettings(
    { auto: true, injectionEnabled: true, syncEnabled: true });
  if (!injectionEnabled || !pageEnabled() || generation !== settleGeneration) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (!pageEnabled() || conversationId() !== id) return;
    if (globalThis.__cvStalledTurn?.pausesSync(id)) return;
    // 开了自动同步就顺带画耗时（syncNow 里会画），关了则只取一次画耗时
    if (auto && syncEnabled) syncNow(false, 'conversation_changed').catch((err) => console.debug('[ChatVault]', err.message));
    else refreshTurns();
  }, SETTLE_MS);
}

function checkRoute() {
  if (!pageEnabled()) return;
  const id = conversationId();
  if (id === currentId) return;
  codexLookup?.controller.abort();
  globalThis.__cvCodexThread?.clearProgress?.();
  lastCodexLookup = null;
  currentId = id;
  // 还在等旧对话页面数据的读取：页面不会再读旧对话了，立即落空
  for (const waiter of [...pageDataWaiters]) {
    if (waiter.id === id) continue;
    clearTimeout(waiter.timer); pageDataWaiters.delete(waiter); waiter.resolve(null);
  }
  globalThis.__cvDotsTitle?.update();
  // SPA 路由切换时必须撤掉旧会话浮层、徽标和异步重画，不能把 /c/ 历史留在 dots 上。
  ++paintGeneration;
  clearTimeout(paintRetryTimer);
  lastConv = null;
  loadedConversation = null;
  if (pageView?.id !== id) pageView = null;   // 页面可能已先交来新路由的数据
  window.__cvTurns?.clear?.();
  livePaintedId = null;
  if (id) void paintCached(id, paintGeneration);
  if (id) void onConversationChanged().catch(err => reportPageError('route', err));
}
let routeInterval = setInterval(checkRoute, CHECK_INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (pageEnabled() && document.visibilityState === 'visible' && conversationId())
    void onConversationChanged().catch(err => reportPageError('visibility', err));
});

// 弹窗里的「立即同步」：强制重传，忽略 update_time 未变的短路
let codexLookup = null;
let lastCodexLookup = null;
async function resolveCodexThread(expectedId, deepScan = false) {
  await page?.ready;
  if (!pageEnabled()) throw new Error('页面注入已关闭；请先启用并刷新此页面');
  const id = conversationId();
  if (!id || id !== expectedId) throw new Error('当前对话已变化，请重新打开扩展后重试');
  if (!globalThis.__cvCodexThread) throw new Error('请重载扩展并刷新当前 ChatGPT 页面');
  const dotsId = globalThis.__cvDots?.dotsId();
  if (dotsId) return { conversationId: id, candidates: [{ threadId: dotsId,
    url: globalThis.__cvCodexThread.threadUrl(dotsId), matchedBy: 'dots', confidence: 'verified' }],
    lookupVersion: globalThis.__cvCodexThread.version, requiresConfirmation: false };
  if (codexLookup?.id === id && codexLookup.deepScan === deepScan) return codexLookup.task;
  codexLookup?.controller.abort();
  const controller = new AbortController();
  const unsubscribe = page?.subscribe(() => { if (!pageEnabled()) controller.abort(); });
  const task = (async () => {
    const runId = crypto.randomUUID();
    // 在途下载优先，随后复用当前路由快照；没有快照时才拉取 conversation。
    // 缓存不保留登录 token，且无关联依据时无需再次读取登录态。
    let snapshot;
    try {
      snapshot = conversationLoads.has(id) ? await conversationLoads.get(id)
        : loadedConversation?.id === id ? { conv: loadedConversation.conv,
          token: () => diagnosticStage(runId, 'auth', accessToken) }
          : await loadConversation(id, runId, 'codex-thread');
    } catch (error) { error.stage = 'conversation-fetch'; error.code ||= 'CONVERSATION_READ_FAILED'; throw error; }
    const { token, conv } = snapshot;
    if (id !== conversationId()) throw new Error('当前对话已变化，请重新打开扩展后重试');
    const branchNodeId = conv.current_node;
    const resolver = globalThis.__cvCodexAssociation || globalThis.__cvCodexThread;
    const result = await resolver.lookup?.(conv, token, { signal: controller.signal, deepScan })
      ?? await resolver.resolve(conv, token, { signal: controller.signal, deepScan });
    controller.signal.throwIfAborted();
    if (id !== conversationId()) throw new Error('当前对话已变化，请重新打开扩展后重试');
    if (loadedConversation?.id === id && loadedConversation.conv.current_node !== branchNodeId) {
      // Appending assistant/tool messages is not a branch switch. Reject only when the queried node
      // is no longer an ancestor of the current snapshot (or the new chain is incomplete/cyclic).
      const latest = loadedConversation.conv, seen = new Set();
      let node = latest.current_node;
      while (node && node !== branchNodeId && !seen.has(node)) {
        seen.add(node);
        node = latest.mapping?.[node]?.parent;
      }
      if (node !== branchNodeId) throw new Error('当前对话分支已变化，请重新查找 Codex thread');
    }
    return { conversationId: id, branchNodeId, lookupVersion: globalThis.__cvCodexThread.version, ...result };
  })();
  codexLookup = { id, deepScan, task, controller };
  try { return await task; }
  finally { unsubscribe?.(); if (codexLookup?.task === task) codexLookup = null; }
}

/** 对话里出现过的 UUID（连接文案、Chappie 工具参数等），交给 ChatVault 匹配已知的 pi 会话；只用已取到的快照，不发请求。 */
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
let piCandidateCache = null;
function piCandidates() {
  const snapshot = loadedConversation?.id === conversationId() ? loadedConversation.conv : null;
  if (!snapshot) return [];
  if (piCandidateCache?.conv === snapshot) return piCandidateCache.ids;
  const own = new Set([snapshot.conversation_id, conversationId()].filter(Boolean).map(s => String(s).replace(/^codex-/, '').toLowerCase()));
  // 长对话里 UUID 很多（工具结果里的消息 id 等），把紧跟在「Chappie / Pi 会话 / sessionId」后面的排在前面，总量封顶，免得真正的会话 id 被挤掉。
  const near = new Set(), rest = new Set();
  const KEY = /(?:chappie|pi 会话|pi session|sessionid|session_id|session id|--session-id)[^0-9a-f]{0,80}([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
  for (const node of Object.values(snapshot.mapping || {})) {
    const message = node?.message, content = message?.content;
    if (!content) continue;
    const chunks = [];
    if (Array.isArray(content.parts)) for (const part of content.parts) chunks.push(typeof part === 'string' ? part : JSON.stringify(part ?? ''));
    if (typeof content.text === 'string') chunks.push(content.text);
    const text = chunks.join(' ');
    for (const hit of text.matchAll(KEY)) { const id = hit[1].toLowerCase(); if (!own.has(id) && id !== message.id) near.add(id); }
    if (rest.size < 150) for (const hit of text.match(UUID_ANY) || []) { const id = hit.toLowerCase(); if (!own.has(id) && id !== message.id) rest.add(id); }
  }
  piCandidateCache = { conv: snapshot, ids: [...near, ...[...rest].filter(id => !near.has(id))].slice(0, 150) };
  return piCandidateCache.ids;
}

/** 对话消息的 request_id（wfr_…，Temporal workflow）：pi 侧每条 Chappie 记录带同一个 ID，据此统计这个对话在 Pi 里做了什么。 */
let requestIdCache = null;
function conversationRequestIds() {
  const snapshot = loadedConversation?.id === conversationId() ? loadedConversation.conv : null;
  if (!snapshot) return [];
  if (requestIdCache?.conv === snapshot) return requestIdCache.ids;
  const ids = new Set();
  for (const node of Object.values(snapshot.mapping || {})) {
    const id = /^(wfr_[0-9a-f]{16,64})/i.exec(String(node?.message?.metadata?.request_id || ''))?.[1];
    if (id) ids.add(id.toLowerCase());
    if (ids.size >= 20) break;
  }
  requestIdCache = { conv: snapshot, ids: [...ids] };
  return requestIdCache.ids;
}

/** 当前对话按轮次的 Work/Chat 分类，只用已取到的快照，不发请求；同一快照只算一次。 */
let modeCache = null;
function conversationMode() {
  if (globalThis.__cvDots?.dotsId()) return { mode: 'dots' };
  const snapshot = loadedConversation?.id === conversationId() ? loadedConversation.conv : null;
  if (!snapshot || !globalThis.__cvCodexThread?.conversationModes) return { mode: 'unknown' };
  if (modeCache?.conv !== snapshot || modeCache.node !== snapshot.current_node)
    modeCache = { conv: snapshot, node: snapshot.current_node, value: globalThis.__cvCodexThread.conversationModes(snapshot) };
  return modeCache.value;
}

/** 把文本插进 ChatGPT 输入框（ProseMirror contenteditable）；失败时让弹窗退回复制。 */
function insertComposerText(text) {
  // ChatGPT 对话页：#prompt-textarea；Codex 页（/local/）：裸的 div.ProseMirror[role=textbox]，没有 form 也没有 data-placeholder（2026-10-12 实测）。
  const editor = [...document.querySelectorAll('#prompt-textarea, [contenteditable="true"][data-placeholder], form [contenteditable="true"], '
    + '.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"]')].find(el => el.getClientRects().length > 0);
  if (!editor || typeof text !== 'string' || !text) return { ok: false, error: '找不到输入框' };
  editor.focus();
  try {
    const selection = window.getSelection();
    if (selection && editor.contains(selection.anchorNode) === false) {
      const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
      selection.removeAllRanges(); selection.addRange(range);
    }
    const existing = (editor.textContent || '').trim();
    const inserted = document.execCommand('insertText', false, (existing ? '\n' : '') + text);
    if (!inserted) return { ok: false, error: 'insertText 被拒绝' };
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'insertComposerText') { sendResponse(insertComposerText(msg.text)); return; }
  if (msg?.type === 'probeCodexResume') {
    // 弹窗「检查能否恢复」：立即回复，检查在本页后台跑（弹窗关了也继续），每个结果写到 cvCodexProbeV1:<thread>，弹窗监听 storage 刷新。
    const ids = (Array.isArray(msg.threadIds) ? msg.threadIds : []).filter(id => /^[0-9a-f-]{36}$/i.test(id || '')).slice(0, 50);
    const prober = globalThis.__cvCodexThread?.probeResume;
    if (!prober) { sendResponse({ ok: false, error: '页面的 Codex 模块尚未更新；请刷新此页面后重试' }); return; }
    if (!ids.length) { sendResponse({ ok: false, error: '没有要检查的线程' }); return; }
    const save = (id, record) => { try { void chrome.storage.local.set({ [`cvCodexProbeV1:${id.toLowerCase()}`]: record }).catch(() => {}); } catch { /* 扩展重载后失效 */ } };
    for (const id of ids) save(id, { outcome: 'checking', at: Date.now() });
    const done = new Set();
    (async () => {
      try {
        await prober(await accessToken(), ids, { onResult: r => { done.add(r.threadId); save(r.threadId, r); } });
      } catch (err) {
        // 连接中途断了：已有结果的保留，其余记为出错
        for (const id of ids) if (!done.has(id.toLowerCase())) save(id, { outcome: 'error', at: Date.now(), error: String(err.message || err).slice(0, 200) });
      }
    })();
    sendResponse({ ok: true, started: ids.length });
    return;
  }
  if (msg?.type === 'listCodexThreads') {
    // 弹窗「Codex Cloud 线程」卡片：用本页登录态只读列出根线程（含已归档的可选）。
    (async () => {
      const lister = globalThis.__cvCodexThread?.listRoots;
      if (!lister) throw new Error('页面的 Codex 模块尚未更新；请刷新此页面后重试');
      const token = await accessToken();
      const active = await lister(token, { archived: false });
      const archived = msg.includeArchived ? await lister(token, { archived: true, maxPages: 2 }) : { threads: [], truncated: false };
      return { ok: true, threads: [...active.threads, ...archived.threads], truncated: active.truncated || archived.truncated };
    })().then(sendResponse, err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg?.type === 'resolveCodexThread') {
    const lookupId = crypto.randomUUID();
    const finish = async outcome => {
      if (globalThis.__cvCodexAssociation) {
        const record = globalThis.__cvCodexAssociation.record(outcome, {
          lookupId, conversationId: msg.conversationId, deepScan: msg.deepScan === true });
        lastCodexLookup = record;
        try {
          const saved = await chrome.runtime.sendMessage({ type: 'rememberCodexLookup', record });
          outcome.journalSaved = saved?.ok === true;
        } catch { outcome.journalSaved = false; }
      }
      sendResponse(outcome);
    };
    resolveCodexThread(msg.conversationId, msg.deepScan === true).then(result => {
      const only = result?.candidates?.length === 1 && result.candidates[0].confidence === 'verified' && !result.requiresConfirmation
        ? result.candidates[0].threadId : null;
      // 记下「对话 → Codex 根线程」，弹窗在 Chat 页面也能显示该线程已记录的用量。
      if (only && /^[0-9a-f-]{36}$/.test(msg.conversationId || '')) {
        try { void chrome.storage.local.set({ [`cvCodexLinkV1:${msg.conversationId}`]: { threadId: only, at: new Date().toISOString() } }).catch(() => {}); }
        catch { /* 关联记录失败不影响打开 */ }
      }
      return finish({ ok: true, ...result });
    },
      error => finish({ ok: false, status: error.name === 'AbortError' ? 'cancelled' : 'read-error',
        error: error.message, code: error.code || null, stage: error.stage || 'lookup', httpStatus: error.httpStatus || null,
        diagnostics: error.diagnostics || null, lookupVersion: globalThis.__cvCodexThread?.version }));
    return true;
  }
  if (msg?.type === 'refreshDotsTitle') {
    sendResponse(globalThis.__cvDotsTitle?.update() || { skipped: '标题模块未加载' });
    return;
  }
  if (msg?.type === 'diagnosticProbe') {
    // 完全只读：不请求 conversation API，不遍历完整对话 JSON，也不触发同步。
    const started = performance.now();
    const heap = performance.memory;
    sendResponse({
      page_runtime: page?.snapshot() || { version: 'legacy', phase: 'unknown' },
      last_codex_lookup: lastCodexLookup?.conversationId === conversationId() ? lastCodexLookup : null,
      title: document.title,
      ready_state: document.readyState,
      visibility: document.visibilityState,
      has_focus: document.hasFocus(),
      conversation_id: globalThis.__cvDots?.dotsId() ? null : conversationId(),
      dots_id: globalThis.__cvDots?.dotsId() || null,
      conversation_key: conversationId(),
      // 后台标签页不遍历 DOM，避免对多个长对话做无意义的周期性扫描。
      rendered_message_count: document.visibilityState === 'visible'
        ? document.querySelectorAll('[data-message-id]').length : null,
      user_node_count: document.visibilityState === 'visible'
        ? document.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], [data-user-message-bubble], .message-row.self[data-message-id]').length : null,
      assistant_node_count: document.visibilityState === 'visible'
        ? document.querySelectorAll('[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-chatgpt-selection-message-id], .message-row:not(.self)[data-message-id]').length : null,
      stop_button_present: !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]'),
      waiting_for_dots_message: globalThis.__cvDots?.isWaiting() || false,
      dots_title: globalThis.__cvDotsTitle?.snapshot() || null,
      dots_notify: globalThis.__cvDotsNotify?.status() || null,
      turn_timer: globalThis.__cvTurns?.status?.() || null,
      speed_metrics: window.__cvSpeed?.status?.() || null,
      stalled_turn: globalThis.__cvStalledTurn?.status?.() || null,
      page_capture: { ready: pageCaptureReady, ...pageCaptureStats, branch: pageBranchMeta },
      last_send: lastSend,
      last_interaction_at: lastInteractionAt,
      codex_usage: [...codexUsage.values()].map(({ dirty, turns, ...v }) => ({ ...v, turnCount: Object.keys(turns || {}).length })).slice(-5),
      conversation_mode: conversationMode(),
      pi_candidates: piCandidates(),
      request_ids: conversationRequestIds(),
      js_heap_used_bytes: heap?.usedJSHeapSize ?? null,
      js_heap_limit_bytes: heap?.jsHeapSizeLimit ?? null,
      navigation_age_ms: Math.round(performance.now()),
      probe_work_ms: Math.round(performance.now() - started),
    });
    return;
  }
  if (msg?.type !== 'syncNow') return;
  syncNow(true, 'manual')
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});

/** 页面读到的一页当前分支（/backend-api/conversations/<id>?num_turns=…）：并进 pageView，有变化就上传。 */
function onPageBranch(id, page, data) {
  const branch = Merge?.branchToConversation(id, page);
  if (!branch) return;
  const complete = branch.cv_branch.complete;
  pageCaptureStats.branchReceived++;
  if (!complete) pageCaptureStats.branchPartial++;
  pageCaptureStats.lastReceivedAt = new Date().toISOString();
  const d = Date.parse(data.serverDate || '');
  if (Number.isFinite(d) && Number.isFinite(data.receivedAtMs)) clockSkewMs = data.receivedAtMs - d;
  pageBranchMeta = { id, updateTime: page.update_time ?? null, receivedAtMs: Date.now(), complete };
  const conv = acceptPageData(id, branch);   // 内含轮次校时、Work 证据、卡住检测
  if (conversationLoads.has(id)) return;
  void readSettings({ auto: true, syncEnabled: true }).then(({ auto, syncEnabled }) => {
    if (id !== conversationId()) return;
    // 上传的是页面已读到的数据，不发请求；服务端把分页并进已归档的整棵树。
    if (auto && syncEnabled && pageEnabled('syncEnabled') && Merge.signature(conv) !== lastSynced.key) return syncNow(false, 'page_branch');
    paintTurns(conv);
  }).catch(err => reportPageError('page.sync', err));
}

/** Codex 页面推来的 thread/tokenUsage/updated：按线程合并，按轮次留最后一次累计值，节流写入扩展本地。 */
const codexUsage = new Map();
let codexUsageFlush = null;
function onCodexUsage(data) {
  if (!pageEnabled()) return;
  const id = typeof data.threadId === 'string' && /^[0-9a-f-]{36}$/.test(data.threadId) ? data.threadId : null;
  if (!id || !data.total) return;
  const entry = codexUsage.get(id) || { threadId: id, turns: {} };
  Object.assign(entry, { total: data.total, last: data.last || null, modelContextWindow: data.modelContextWindow ?? null,
    updatedAt: new Date(Number.isFinite(data.at) ? data.at : Date.now()).toISOString(), dirty: true });
  if (data.turnId) {
    entry.turns[data.turnId] = { total: data.total, at: entry.updatedAt };
    const ids = Object.keys(entry.turns);
    for (const old of ids.slice(0, Math.max(0, ids.length - 50))) delete entry.turns[old];
  }
  codexUsage.set(id, entry);
  if (codexUsageFlush) return;
  codexUsageFlush = setTimeout(() => {
    codexUsageFlush = null;
    const values = {};
    for (const [threadId, value] of codexUsage) if (value.dirty) {
      value.dirty = false;
      const { dirty, ...record } = value;
      values[`cvCodexUsageV1:${threadId}`] = record;
    }
    try { void chrome.storage.local.set(values).catch(err => reportPageError('codex.usage', err)); }
    catch (err) { reportPageError('codex.usage', err); }
  }, 3000);
}

/** 分屏时弹窗据此判断用户正在操作哪一侧：记录本页最后一次点击/按键/聚焦。 */
let lastInteractionAt = null;
for (const type of ['pointerdown', 'keydown', 'focus']) {
  window.addEventListener?.(type, () => { lastInteractionAt = Date.now(); }, { capture: true, passive: true });
}

/** 发送请求里的模式字段（只观测，不参与分类）：按「对话:用户消息」存一小份，供以后核对 Work 判定。 */
let lastSend = null;
function onPageSend(data) {
  if (!pageEnabled()) return;
  const clean = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : null;
  const record = { conversationId: clean(data.conversationId), userMessageId: clean(data.userMessageId),
    fields: data.fields && typeof data.fields === 'object' ? data.fields : {},
    keys: Array.isArray(data.keys) ? data.keys.filter(k => typeof k === 'string').slice(0, 80) : [],
    path: typeof data.path === 'string' ? data.path : null, sentAt: new Date().toISOString() };
  lastSend = record;
  if (record.userMessageId) {
    const key = `cvSendMetaV1:${record.conversationId || 'new'}:${record.userMessageId}`;
    try { void chrome.storage.local.set({ [key]: record }).catch(err => reportPageError('send.meta', err)); }
    catch (err) { reportPageError('send.meta', err); }
  }
}

/** 页面自己的对话读取响应（MAIN world 克隆）：整段对话或当前分支消息列表。 */
function onPageConversation(data) {
  if (!pageEnabled()) return;
  const id = typeof data.conversationId === 'string' ? data.conversationId : null;
  if (!id || id !== conversationId()) return;   // 只收当前路由的对话
  let conv;
  try { conv = JSON.parse(data.text); } catch (err) { reportPageError('page.conversation', err); return; }
  if (conv && typeof conv === 'object' && Array.isArray(conv.messages) && conv.page_info
    && (!conv.conversation_id || conv.conversation_id === id)) return onPageBranch(id, conv, data);
  if (!conv || typeof conv !== 'object' || typeof conv.mapping !== 'object' || !conv.current_node
    || (conv.conversation_id && conv.conversation_id !== id)) return;
  const d = Date.parse(data.serverDate || '');
  if (Number.isFinite(d) && Number.isFinite(data.receivedAtMs)) clockSkewMs = data.receivedAtMs - d;
  pageCaptureStats.received++;
  pageCaptureStats.lastReceivedAt = new Date().toISOString();
  const merged = acceptPageData(id, conv);
  // 页面自己又读了一次：顺带画耗时、上传，不额外请求。
  if (conversationLoads.has(id)) return;
  void readSettings({ auto: true, syncEnabled: true }).then(({ auto, syncEnabled }) => {
    if (id !== conversationId()) return;
    if (auto && syncEnabled && pageEnabled('syncEnabled') && Merge.signature(merged) !== lastSynced.key)
      return syncNow(false, 'page_snapshot'); // 内部会画耗时
    paintTurns(merged);
  }).catch(err => reportPageError('page.sync', err));
}
window.addEventListener?.('message', (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (data?.__chatVaultPageConversationV1 !== true) return;
  if (data.kind === 'hello') { pageCaptureReady = true; return; }
  if (data.kind === 'conversation' && typeof data.text === 'string') onPageConversation(data);
  if (data.kind === 'send') onPageSend(data);
  if (data.kind === 'codexUsage') onCodexUsage(data);
  if (data.kind === 'recoverySkip') { pageCaptureStats.recoverySkipped++; pageCaptureStats.lastRecoverySkipAt = Date.now(); }
  if (data.kind === 'recoveryThrottle') { pageCaptureStats.recoveryThrottled++; pageCaptureStats.lastRecoveryThrottleAt = Date.now(); }
  if (data.kind === 'limits' && data.limits && typeof data.limits === 'object') {
    // 账号额度：存最新一份给弹窗显示（只有字段名白名单里的几项）
    try { void chrome.storage.local.set({ cvAccountLimitsV1: { at: Number.isFinite(data.receivedAtMs) ? data.receivedAtMs : Date.now(), ...data.limits } }).catch(() => {}); }
    catch { /* 扩展重载后 chrome.* 失效 */ }
  }
});
window.postMessage?.({ __chatVaultPageConversationReadyV1: true }, location.origin);

globalThis.__cvStalledTurn?.attach({ conversationId, accessToken,
  reload: () => location.reload(),
  loadConversation: id => loadConversation(id, crypto.randomUUID(), 'stalled-turn') });
schedule();

/**
 * 取活跃对话里**最新那条用户消息**（不从 current_node 回溯：流式刚开始时服务端的
 * current_node 还没指向新消息，回溯会落到上一轮去）。
 * 返回 { ms: 换算到本机时钟的时刻, id }。
 */
async function newestUserMessage({ path = location.pathname, userMessageId = null } = {}) {
  const id = conversationId(path);
  if (!id) return null;
  const { injectionEnabled } = await readSettings({ injectionEnabled: true });
  if (!injectionEnabled) return null;
  const { conv } = await loadConversation(id, crypto.randomUUID(), 'newest_user_message');
  let best = null;
  for (const node of Object.values(conv.mapping || {})) {
    const m = node?.message;
    if (m?.author?.role !== 'user' || !m.create_time) continue;
    if (userMessageId && m.id !== userMessageId) continue;
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    if (!best || m.create_time > best.create_time) best = m;
  }
  // 换算到本机时钟：计时器用 Date.now() 计算已用时间
  return best ? { ms: best.create_time * 1000 + clockSkewMs, id: best.id } : null;
}

// 进行中的一轮：显示实时计时器；结束后回取一次，把这一轮的真实耗时补上
window.__cvTurns?.watchStreaming(async ({ measuredMs, startedAtMs, endedAtMs, userMessageId, superseded,
  path = location.pathname } = {}) => {
  const id = conversationId(path);
  const away = document.visibilityState !== 'visible' || !document.hasFocus();
  const stillHere = () => location.pathname === path && pageEnabled();
  const { injectionEnabled } = await readSettings({ injectionEnabled: true });
  if (!injectionEnabled || !pageEnabled()) return;
  if (isAltConversation(id)) {
    // dots 与 Codex Cloud 不写普通实测耗时、不在这里发「回复完成」通知（避免每轮结束都回取一次整条 thread）。
    // Codex Cloud 的完成通知由上面的 turn/completed 监听发；dots 由 dots-notify.js 合并后发。
    if (!superseded && stillHere()) void refreshTurns();
    return;
  }
  if (!superseded && stillHere()) notifyIfAway(measuredMs, away);
  // 实测值先落盘，再回取重画 —— 这样重画时就能用上它而不是接口推算值。
  // 本页亲眼看到的用户消息已经有稳定的 message id，无需为了这个 id 再下载整段对话。
  // 刷新后接续的轮次没有可信的本地 id，仍走原来的接口回查。
  const turnId = userMessageId || (!superseded ? (await newestUserMessage({ path }).catch(() => null))?.id : null);
  if (turnId && pageEnabled()) await rememberMeasured(id, turnId, { measuredMs, startedAtMs, endedAtMs });
  if (superseded || !stillHere()) return;
  setTimeout(async () => {
    try {
      const { auto, syncEnabled } = await readSettings({ auto: true, syncEnabled: true });
      if (!stillHere()) return;
      if (auto && syncEnabled) {
        const result = await syncNow(false, 'turn_end');
        // 撞上另一次同步（多半正在等页面数据）：等它结束再来一次，否则本页跑完的一轮可能错过补读
        if (result?.skipped === '正在同步中') {
          await new Promise(resolve => setTimeout(resolve, PAGE_DATA_WAIT_MS + 2000));
          if (stillHere()) await syncNow(false, 'turn_end');
        }
      } else await refreshTurns();
    } catch (err) { reportPageError('round.refresh', err); }
  }, 1500);
}, owner => newestUserMessage(owner).catch(() => null), ({ path = location.pathname } = {}) => {
  // 新一轮开始时取一次最新会话，使总览面板不必等到旧一轮结束才显示新行。
  setTimeout(() => { if (pageEnabled() && location.pathname === path) void refreshTurns(); }, 2000);
});

// 长对话是懒加载的：往上滚出现新消息节点时，用上次取到的数据补画徽标
let repaintTimer = null;
const repaintObserver = new MutationObserver((records) => {
  if (!pageEnabled()) return;
  diag?.recordMutation(records.length);
  globalThis.__cvDotsTitle?.noteMutation(records);
  // 流式输出期间不重画：那会儿 DOM 每秒变动几十次，而且这一轮还没结束、
  // 也没有耗时可标；等 watchStreaming 的 onEnd 回来再统一补
  if (!pageEnabled('durations') || !lastConv || repaintTimer) return;
  // 只在真正出现消息锚点时重画。文本增量、工具卡片和我们自己的徽标变化都不必遍历整段对话。
  let hasNewMessage = false;
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1 || node.classList?.contains('cv-turn-host')) continue;
      if (node.matches?.('[data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids], [data-user-message-bubble], [data-message-author-role], [data-testid="user-message"], [data-testid="assistant-message"]')
        || node.querySelector?.('[data-message-id], [data-chatgpt-selection-message-id], [data-chatgpt-search-message-ids], [data-user-message-bubble], [data-message-author-role], [data-testid="user-message"], [data-testid="assistant-message"]')) {
        hasNewMessage = true;
        break;
      }
    }
    if (hasNewMessage) break;
  }
  if (!hasNewMessage || window.__cvTurns?.isStreaming?.()) return;
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    if (!pageEnabled('durations') || !lastConv || window.__cvTurns?.isStreaming?.()) return;
    if (globalThis.__cvDots?.dotsId()) void refreshTurns();
    else paintTurns(lastConv);
  }, 600);
});
repaintObserver.observe(document.body, { childList: true, subtree: true });

page?.subscribe(() => {
  ++paintGeneration; ++settleGeneration;
  clearTimeout(paintRetryTimer); clearTimeout(settleTimer);
  clearTimeout(repaintTimer); repaintTimer = null;
  if (!pageEnabled()) {
    clearTimeout(timer); clearInterval(routeInterval); routeInterval = null;
    repaintObserver.disconnect();
    window.__cvTurns?.clear?.();
    return;
  }
  if (routeInterval === null) routeInterval = setInterval(checkRoute, CHECK_INTERVAL_MS);
  repaintObserver.observe(document.body, { childList: true, subtree: true });
  checkRoute(); schedule();
  if (lastConv) paintTurns(lastConv);
  else if (conversationId()) {
    void paintCached(conversationId(), paintGeneration);
    void onConversationChanged().catch(err => reportPageError('settings.route', err));
  }
});

// 首次进入（可能直接落在某个对话页上）
if (currentId) void onConversationChanged().catch(err => reportPageError('initial.route', err));
