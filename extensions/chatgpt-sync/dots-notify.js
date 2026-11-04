// Dot 新消息提醒：Dot 的一轮没有结束信号（消息元数据为空、状态恒为 active，先秒回一句确认再陆续发进度和结果，
// 还会主动发消息；2026-10-09 实测）。所以不按"一轮结束"提醒，而是在你不在看时收集 Dot 新发的消息，
// 连续静默一段时间（默认 3 分钟）后合并成一条桌面通知。
//
// 只看消息行的出现与归属（.message-row[data-message-id]、self 类），不读消息正文。
(() => {
  if (globalThis.__cvDotsNotify) return;
  const ROW = '.message-row[data-message-id]';
  const ACK_WINDOW_MS = 15000;          // 你发消息后 15 秒内的那句简短确认不算
  const DEFAULT_QUIET_SEC = 180;
  const MAX_SEEN = 5000;
  let seen = new Set();
  let primedFor = null;
  let lastSelfAt = 0;
  let pending = null;                   // { count, firstAt, lastAt, timer }
  let settings = { notify: true, dotsQuietSec: DEFAULT_QUIET_SEC };
  let scanTimer = null;

  const dotsId = () => globalThis.__cvDots?.dotsId?.() || null;
  const enabled = () => (!globalThis.__cvPage || globalThis.__cvPage.can()) && settings.notify !== false;
  const away = () => document.visibilityState !== 'visible' || !document.hasFocus();
  const quietMs = () => {
    const sec = Number(settings.dotsQuietSec);
    return (Number.isFinite(sec) && sec >= 30 && sec <= 3600 ? sec : DEFAULT_QUIET_SEC) * 1000;
  };

  function drop() {
    if (pending?.timer) clearTimeout(pending.timer);
    pending = null;
  }

  function fire() {
    const batch = pending;
    pending = null;
    if (!batch?.count || !enabled() || !dotsId()) return;
    if (!away()) return;                // 回来看过了就不打扰
    try {
      void Promise.resolve(chrome.runtime.sendMessage({ type: 'dotsMessages', count: batch.count,
        firstAt: batch.firstAt, lastAt: batch.lastAt,
        title: (document.title || '').replace(/^ChatGPT\s*[-–—]\s*/, '').trim() })).catch(() => {});
    } catch (err) { globalThis.__cvPage?.report('dots.notify', err); }
  }

  function arm(now) {
    pending ||= { count: 0, firstAt: now, lastAt: now, timer: null };
    pending.count++;
    pending.lastAt = now;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(fire, quietMs());
  }

  /** 扫一遍消息行：只把排在已见消息之后的新行当作新消息（往上翻加载的历史不算）。 */
  function scan(now = Date.now()) {
    const id = dotsId();
    if (!id || !enabled()) { drop(); primedFor = null; return; }
    const rows = [...document.querySelectorAll(ROW)];
    const idOf = row => row.getAttribute('data-message-id');
    if (primedFor !== id) {
      if (!rows.length) return;         // 消息列表还没渲染出来，先别建基线
      seen = new Set(rows.map(idOf));
      primedFor = id;
      drop();
      return;
    }
    let lastSeenIndex = -1;
    rows.forEach((row, i) => { if (seen.has(idOf(row))) lastSeenIndex = i; });
    rows.forEach((row, i) => {
      const mid = idOf(row);
      if (!mid || seen.has(mid)) return;
      seen.add(mid);
      if (i < lastSeenIndex) return;    // 插在已见消息之前：历史回补
      if (row.classList.contains('self')) { lastSelfAt = now; drop(); return; }
      if (now - lastSelfAt < ACK_WINDOW_MS) return;
      if (!away()) return;              // 正在看，不用提醒
      arm(now);
    });
    if (seen.size > MAX_SEEN) seen = new Set(rows.map(idOf));
  }

  function schedule() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 500);
  }

  async function loadSettings() {
    try {
      settings = await chrome.storage.local.get({ notify: true, dotsQuietSec: DEFAULT_QUIET_SEC });
    } catch (err) { globalThis.__cvPage?.report('dots.notify.settings', err); }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.notify || changes.dotsQuietSec)) void loadSettings();
    });
  } catch { /* 扩展重载后的旧页面 */ }
  void loadSettings();

  // 新消息由 ChatGPT 推到页面后才渲染成行；后台标签页也会更新 DOM。再加 30 秒一次的兜底扫描。
  const observer = new MutationObserver(() => { if (dotsId()) schedule(); });
  const start = () => { if (document.body) observer.observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  setInterval(() => { if (dotsId()) scan(); }, 30000);
  // 回到页面就算看过了，取消待发的提醒。
  const back = () => { if (!away()) drop(); };
  document.addEventListener('visibilitychange', back);
  window.addEventListener('focus', back);

  globalThis.__cvDotsNotify = { scan, status: () => ({ primed: primedFor, pending: pending ? { count: pending.count,
    firstAt: pending.firstAt, lastAt: pending.lastAt } : null, quietSec: quietMs() / 1000 }) };
})();
