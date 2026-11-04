// 每轮耗时徽标 + 进行中计时器（注入 ChatGPT 页面，全部包在 Shadow DOM 里）
//
// 优先按消息 id 锚定徽标；页面不提供 id 时，尝试用户消息文本与会话 API 匹配。
// 两者都不可用时仍显示总览面板，并在诊断探针中暴露候选节点数。
//
// 样式全部放进 Shadow DOM：ChatGPT 自己的 CSS 进不来，我们的也污染不到它。

const TURN_ATTR = 'data-cv-turn';        // 已挂过徽标的锚点，避免重复注入
const HOST_CLASS = 'cv-turn-host';
const PANEL_ID = 'cv-turn-panel';
const TIMER_ID = 'cv-turn-timer';
const PANEL_POSITION_KEY = 'cvTurnPanelPosition';
const TIMER_POSITION_KEY = 'cvTurnTimerPosition';
// 计时器、总览胶囊、推送中断提示共用右下角一列：互不遮挡，整列一起拖动。
const DOCK_ID = 'cv-float-dock';
const DOCK_POSITION_KEY = 'cvFloatDockPositionV1';
const PANEL_OPEN_KEY = 'cvTurnPanelOpenV1';
const FLOAT_ORDER = { stalled: 1, panel: 2, timer: 3 };
const FLOAT_FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
/** 所有页面浮层共用的外观；各浮层只补自己的布局。 */
const FLOAT_CSS = `
  :host([data-cv-docked]) { position: static !important; }
  .cv-card { box-sizing: border-box; padding: 5px 11px; border-radius: 10px;
    font: 500 12px/1.55 ${FLOAT_FONT}; font-variant-numeric: tabular-nums; color: #e4e4e7;
    background: rgba(24,24,27,.94); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 4px 16px rgba(0,0,0,.28); }
  .cv-muted { color: #a1a1aa; }
  .cv-grip { cursor: grab; touch-action: none; user-select: none; }
  .cv-grip:active { cursor: grabbing; }
  a { color: #3ddc97; font-weight: 600; text-decoration: none; white-space: nowrap; }
  a:hover { text-decoration: underline; }`;
const MESSAGE_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SPEED_TIP = 'TTFT=会话请求到首个助手文本；out=用 tiktoken o200k_base 统计 SSE/WS 中已捕获的全部助手文本（含工具调用和下发的推理文本），不含工具返回及未下发内容；≈TPS=out÷首段到末段文本耗时，是本轮累计平均速度。新增续片约每秒分词更新，首段、完整消息快照和结束时立即更新。';
const TURNS_VERSION = globalThis.__cvPage?.version || 'unknown';
let lastTimerError = null;
let timerReloadRequired = false;

function reportTimerError(stage, err) {
  globalThis.__cvPage?.report(stage, err);
  const message = err?.message || String(err);
  if (/extension context invalidated/i.test(message)) timerReloadRequired = true;
  if (lastTimerError?.stage === stage && lastTimerError.message === message) return;
  lastTimerError = { stage, message, at: Date.now() };
  console.debug('[ChatVault timer]', stage, message);
}

function fmtClock(sec) {
  return new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 时长。秒始终显示——超过一小时也带秒，否则长轮次的计时器看上去像卡住了。
 * 逐级取整而不是各自取余后再四舍五入，避免出现 4h09m60s 这种进位错乱。
 */
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = ms / 1000;
  if (total < 10) return `${total.toFixed(1)}s`;   // 十秒内给一位小数，秒表手感
  const whole = Math.floor(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const ss = String(sec).padStart(2, '0');
  if (h) return `${h}h${String(m).padStart(2, '0')}m${ss}s`;
  if (m) return `${m}m${ss}s`;
  return `${sec}s`;
}

/** out 与 ≈TPS 共用分词结果，不能混入包含隐藏输出的上游 usage。 */
function fmtSpeed(stats) {
  if (!stats) return '';
  if (stats.source === 'dots-message') {
    // Dot 消息整条送达：显示首条回复用时与本轮条数/token，不显示 TTFT/TPS。
    const first = stats.ttftMs == null ? stats.ttftReason || '等待首条回复' : `首条回复 ${fmtDur(stats.ttftMs)}`;
    const out = Number.isInteger(stats.tokenCount) ? stats.tokenCount.toLocaleString('en-US') : '—';
    const count = Number.isInteger(stats.messageCount) && stats.messageCount > 0 ? `（${stats.messageCount} 条）` : '';
    return `${first} · ${out} out${count}`;
  }
  const out = Number.isInteger(stats.tokenCount) && stats.tokenCount >= 0
    ? stats.tokenCount.toLocaleString('en-US') : '—';
  const ttft = stats.ttftMs == null ? stats.ttftReason || '—' : fmtDur(stats.ttftMs);
  const tps = stats.tps == null ? stats.tpsReason || '—' : stats.tps.toFixed(1);
  return `TTFT ${ttft} · ${out} out · ≈TPS ${tps}`;
}

function speedTip(stats) {
  if (stats?.source === 'dots-message') {
    return '首条回复=你发出消息到 Dot 第一条回复的时间（接口时间戳）；out=本轮已送达的 Dot 消息文本用 tiktoken o200k_base 分词，不含未下发的内部工具输出。Dot 消息整条送达、没有 token 增量，所以没有 TTFT/TPS；消息跨度也不代表 Dot 任务结束。';
  }
  return Number.isInteger(stats?.outputTokens) && stats.outputTokens >= 0
    ? `${SPEED_TIP} 上游另报 output_tokens=${stats.outputTokens.toLocaleString('en-US')}，不替代这里的 out 或 TPS 分子。`
    : SPEED_TIP;
}

/**
 * 旧版本只存一个时长，可能把上一轮起点误记到下一轮 id（如 13:24→14:30
 * 误记为 14:08 这轮）。新记录同时存起止时刻，按 API 用户消息时间校验归属。
 */
function measuredMsForTurn(turn, value, clockSkewMs = 0) {
  if (Number.isFinite(value)) {
    // 兼容旧存储，但拒绝明显长于服务端可见轮次的旧错值。
    if (value <= 0 || (turn.count && value > turn.ms + Math.max(180000, turn.ms * 0.25))) return null;
    return value;
  }
  if (!value || !Number.isFinite(value.ms) || !Number.isFinite(value.startedAtMs)
    || !Number.isFinite(value.endedAtMs)) return null;
  if (value.ms <= 0 || Math.abs(value.endedAtMs - value.startedAtMs - value.ms) > 2000) return null;
  if (Math.abs(value.startedAtMs - (turn.start * 1000 + clockSkewMs)) > 120000) return null;
  return value.ms;
}

/** current_node 回溯到根，返回根→叶顺序（与 ChatVault 侧同一套规则） */
function activeChain(conv) {
  const map = conv?.mapping || {};
  let id = conv?.current_node && map[conv.current_node] ? conv.current_node : null;
  if (!id) {
    // current_node 悬空：退而取时间最新的叶子
    let best = null, bestT = -1;
    for (const [nid, node] of Object.entries(map)) {
      if ((node?.children || []).some((c) => map[c])) continue;
      const t = node?.message?.create_time || 0;
      if (t >= bestT) { bestT = t; best = nid; }
    }
    id = best;
  }
  const chain = [];
  const seen = new Set();
  while (id && map[id] && !seen.has(id)) {
    seen.add(id);
    chain.push(map[id]);
    id = map[id].parent;
  }
  return chain.reverse();
}

/**
 * 切分成「轮」：一条用户消息到下一条用户消息之前的全部内容算一轮。
 * 耗时 = 本轮最后一条消息的时间 − 用户提问的时间。
 */
function turnsOf(conv) {
  const turns = [];
  let cur = null;
  for (const node of activeChain(conv)) {
    const m = node.message;
    if (!m || !m.create_time) continue;
    const role = m.author?.role;
    // 隐藏的上下文块（自定义指令等）不是发言，不参与分轮
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    if (role === 'user') {
      if (cur) turns.push(cur);
      const prompt = (m.content?.parts || []).filter((p) => typeof p === 'string').join(' ').trim();
      cur = { startId: m.id, start: m.create_time, endId: m.id, end: m.create_time,
        messageIds: [], count: 0, prompt };
      continue;
    }
    if (!cur) continue;
    cur.end = Math.max(cur.end, conv.cv_source === 'dots' ? (m.update_time || m.create_time) : m.create_time);
    cur.endId = m.id;
    cur.messageIds.push(m.id);
    cur.count++;
  }
  if (cur) turns.push(cur);
  return turns.map((t) => ({ ...t, ms: (t.end - t.start) * 1000 }));
}

function makeBadge(text, title, kind) {
  const host = document.createElement('span');
  host.className = HOST_CLASS;
  host.setAttribute(TURN_ATTR, kind);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; display: block; }
      .b {
        display: inline-flex; align-items: center; gap: 5px;
        margin: ${kind === 'start' ? '0 0 6px' : '8px 0 0'};
        padding: 3px 10px; border-radius: 6px;
        font: 600 12.5px/1.7 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        /* 等宽数字：时长逐秒跳动时宽度不变，徽标不会左右抖 */
        font-variant-numeric: tabular-nums;
        white-space: nowrap; letter-spacing: .1px;
      }
      /* 起止两种给不同的颜色，扫一眼就能分清这一轮从哪开始、到哪结束 */
      .start { color: #6b7280; background: rgba(127,127,127,.10);
               border-left: 3px solid rgba(127,127,127,.45); border-radius: 0 6px 6px 0; }
      .end   { color: #0d8a6a; background: rgba(16,163,127,.12);
               border-left: 3px solid #10a37f; border-radius: 0 6px 6px 0; }
      .dur   { font-size: 13.5px; font-weight: 700; }
      @media (prefers-color-scheme: dark) {
        .start { color: #9ca3af; }
        .end   { color: #3ddc97; background: rgba(16,163,127,.16); }
      }
    </style>
    <span class="b ${kind}" title="${title || ''}">${text}</span>`;
  return host;
}

/** 新版 search/selection 节点就是消息列；旧版 data-message-id 仍用其父列。 */
function badgeHolder(el) {
  if (!el) return null;
  if (el.matches?.('.message-row[data-message-id]')) return el.querySelector?.('.message-content-stack') || el;
  if (el.matches?.('[data-chatgpt-search-message-ids], [data-chatgpt-selection-message-id]')) return el;
  return el.parentElement || el.closest?.('[data-testid^="conversation-turn"]') || el.closest?.('article') || el;
}

/** 把徽标挂到某条消息的列容器里；找不到锚点返回 false */
function attachBadge(el, messageId, text, title, kind, prepend) {
  const holder = badgeHolder(el);
  if (!holder) return false;
  const tag = `${messageId}:${kind}`;
  const existing = [...holder.querySelectorAll(`.${HOST_CLASS}`)].find((h) => h.dataset.cvFor === tag);
  if (existing) {
    const span = existing.shadowRoot?.querySelector('.b');
    // 末尾徽标含内联时长；别先清空再写回，避免每轮重画产生两次无用 DOM 更新。
    if (span && kind !== 'end' && span.textContent !== text) span.textContent = text;
    if (span && span.title !== title) span.title = title;
    return true;
  }
  const badge = makeBadge(text, title, kind);
  badge.dataset.cvFor = tag;
  if (prepend) holder.insertBefore(badge, holder.firstChild);
  else holder.appendChild(badge);
  return true;
}

/** 最近一次拖动真正移动过的时刻：同一次按下松开不再当作点击（展开/收起）。 */
let lastDragMovedAt = 0;

/**
 * 浮层只在拖动结束时写 storage；重画轮次不会重新创建它或丢失拖动位置。
 * anchor='bottom-right' 时按右下角距离定位并保存，内容展开时向上长、不会掉出屏幕底部。
 */
function makeDraggable(host, handle, storageKey, { anchor = 'top-left' } = {}) {
  if (!handle || typeof window === 'undefined') return;
  const corner = anchor === 'bottom-right';
  let touched = false;
  const apply = (left, top) => {
    const box = host.getBoundingClientRect();
    const nextLeft = Math.max(0, Math.min(left, Math.max(0, window.innerWidth - box.width)));
    const nextTop = Math.max(0, Math.min(top, Math.max(0, window.innerHeight - box.height)));
    if (corner) {
      const right = Math.max(0, window.innerWidth - nextLeft - box.width);
      const bottom = Math.max(0, window.innerHeight - nextTop - box.height);
      host.style.left = 'auto';
      host.style.top = 'auto';
      host.style.right = `${right}px`;
      host.style.bottom = `${bottom}px`;
      return { left: nextLeft, top: nextTop, right, bottom };
    }
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
    return { left: nextLeft, top: nextTop };
  };
  const persist = (left, top) => {
    if (typeof chrome !== 'undefined') {
      let value = { left, top };
      if (corner) {
        const box = host.getBoundingClientRect();
        value = { right: Math.max(0, window.innerWidth - left - box.width), bottom: Math.max(0, window.innerHeight - top - box.height) };
      }
      // 扩展重载后的旧隔离上下文会同步 throw，不是只返回 rejected Promise。
      try {
        void Promise.resolve(chrome.storage.local.set({ [storageKey]: value }))
          .catch(err => reportTimerError('position.write', err));
      } catch (err) { reportTimerError('position.write', err); }
    }
  };
  const removeViewportListeners = () => {
    window.removeEventListener('resize', onViewportChange);
    window.visualViewport?.removeEventListener('resize', onViewportChange);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onViewportChange);
  };
  const normalizeToViewport = () => {
    if (!host.isConnected || !handle.isConnected) {
      removeViewportListeners();
      return false;
    }
    const box = host.getBoundingClientRect();
    const styleLeft = Number.parseFloat(host.style.left);
    const styleTop = Number.parseFloat(host.style.top);
    const left = Number.isFinite(styleLeft) ? styleLeft : box.left;
    const top = Number.isFinite(styleTop) ? styleTop : box.top;
    const next = apply(left, top);
    if (Math.abs(next.left - left) > 0.5 || Math.abs(next.top - top) > 0.5) persist(next.left, next.top);
    return true;
  };
  const onViewportChange = () => {
    normalizeToViewport();
  };
  // 调试器、缩放、分屏和 DevTools 都可能改变视口；固定定位的旧坐标不能继续留在屏幕外。
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onViewportChange);
  if (typeof chrome !== 'undefined') {
    try {
      chrome.storage.local.get({ [storageKey]: null }).then((result) => {
        let pos = result?.[storageKey];
        if (corner && Number.isFinite(pos?.right) && Number.isFinite(pos?.bottom)) {
          const box = host.getBoundingClientRect();
          pos = { left: window.innerWidth - pos.right - box.width, top: window.innerHeight - pos.bottom - box.height };
        }
        if (!touched && Number.isFinite(pos?.left) && Number.isFinite(pos?.top)) {
          const next = apply(pos.left, pos.top);
          if (Math.abs(next.left - pos.left) > 0.5 || Math.abs(next.top - pos.top) > 0.5) persist(next.left, next.top);
        }
      }).catch(err => reportTimerError('position.read', err));
    } catch (err) { reportTimerError('position.read', err); }
  }
  let drag = null;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    touched = true;
    const box = host.getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top, x: event.clientX, y: event.clientY, moved: false };
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    // 3px 以内的抖动仍算点击，不挪位置也不写 storage。
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 3 && Math.abs(event.clientY - drag.y) < 3) return;
    drag.moved = true;
    apply(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
  });
  const finish = (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { moved } = drag;
    drag = null;
    handle.releasePointerCapture?.(event.pointerId);
    if (!moved) return;
    lastDragMovedAt = Date.now();
    if (typeof chrome !== 'undefined') {
      const box = host.getBoundingClientRect();
      persist(box.left, box.top);
    }
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  // 内容变高（胶囊展开）后调用，把整块夹回视口内。
  removeViewportListeners.fit = normalizeToViewport;
  return removeViewportListeners;
}

/** 右下角浮层列；宿主环境不支持（测试桩等）时返回 null，由调用方退回各自独立定位。 */
let dockDragCleanups = [];
function floatDock() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
  const existing = document.getElementById(DOCK_ID);
  if (existing?.id === DOCK_ID && typeof existing.insertBefore === 'function' && existing.isConnected !== false) return existing;
  const host = document.createElement('div');
  if (typeof host?.insertBefore !== 'function' || typeof host.attachShadow !== 'function') return null;
  host.id = DOCK_ID;
  host.setAttribute('data-cv-script-version', TURNS_VERSION);
  host.attachShadow({ mode: 'open' }).innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 16px; bottom: 96px; z-index: 2147483000;
              display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: min(340px, calc(100vw - 32px)); }
    </style><slot></slot>`;
  document.body.appendChild(host);
  return host;
}

/** 把浮层按固定次序（中断提示 → 总览 → 计时器）放进右下角列；放不进时直接挂 body。 */
function mountFloat(host, kind) {
  try {
    const dock = floatDock();
    if (dock) {
      const order = FLOAT_ORDER[kind] || 9;
      host.setAttribute('data-cv-docked', kind);
      const next = [...dock.children].find(child => (FLOAT_ORDER[child.getAttribute('data-cv-docked')] || 9) > order);
      dock.insertBefore(host, next || null);
      return dock;
    }
  } catch (err) { reportTimerError('dock.mount', err); }
  document.body.appendChild(host);
  return null;
}

/** 浮层的拖动把手：在列里时拖整列，否则拖它自己（沿用旧位置键）。 */
function dragFloat(host, dock, handle, ownKey) {
  if (!dock) return makeDraggable(host, handle, ownKey);
  const cleanup = makeDraggable(dock, handle, DOCK_POSITION_KEY, { anchor: 'bottom-right' });
  if (cleanup) {
    dockDragCleanups.push(cleanup);
    // 拖动监听随把手一起回收，列表里不留已经移除的浮层。
    const remove = () => { dockDragCleanups = dockDragCleanups.filter(item => item !== cleanup); cleanup(); };
    remove.fit = cleanup.fit;
    return remove;
  }
  return cleanup;
}
function fitDock() { for (const cleanup of dockDragCleanups) cleanup.fit?.(); }

/**
 * 总览面板与消息徽标同时显示；没有可用锚点时它也是保底视图。
 * 默认收成一枚小胶囊（轮数 · 总耗时），点一下展开逐轮明细，不遮挡正文。
 */
let panelDragCleanup = null;
let panelOpen = false;
let panelOpenLoaded = false;
let panelInput = null;
let panelPath = null;
const panelRounds = new Map();

function checkPanelPath() {
  if (panelPath === location.pathname) return;
  panelPath = location.pathname;
  panelInput = null;
  panelRounds.clear();
}

/** 新对话可能一直没有历史快照；用计时器已观测到的轮次补面板，不额外读取会话。 */
function observePanelRound(round, stats, endedAtMs = null) {
  const convId = /\/c\/([0-9a-fA-F-]{36})/.exec(location.pathname)?.[1];
  if (!convId || !round || !Number.isFinite(round.startMs)) return;
  checkPanelPath();
  const previous = panelRounds.get(round);
  const startId = round.id || stats?.userMessageId || previous?.startId || null;
  for (const [key, t] of panelRounds) {
    if (key !== round && startId && t.startId === startId) panelRounds.delete(key);
  }
  panelRounds.set(round, { startId,
    start: round.startMs / 1000, count: 0, messageIds: [],
    liveRunning: endedAtMs === null,
    liveMs: endedAtMs === null ? null : Math.max(0, endedAtMs - round.startMs),
    liveSpeed: stats || null });
  if (panelRounds.size > CACHE_TURNS) panelRounds.delete(panelRounds.keys().next().value);
  if (!panelInput) panelInput = { turns: [], convId, streaming: false, measured: null,
    clockSkewMs: 0, opts: { loading: true } };
  paintPanel();
}

function renderPanel(turns, convId, streaming, measured, clockSkewMs, opts = {}) {
  checkPanelPath();
  panelInput = { turns, convId, streaming, measured, clockSkewMs, opts };
  // 快照已包含的完成轮次以后交给快照；较新的本地轮次仍保留，防止旧快照盖掉当前轮。
  if (!opts.stale && !opts.loading) {
    const byId = new Map(turns.map(t => [t.startId, t]));
    const latest = turns.at(-1)?.start ?? -Infinity;
    for (const [key, t] of panelRounds) {
      const saved = byId.get(t.startId);
      const measuredMs = saved && measuredMsForTurn(saved, measured?.[`${convId}:${t.startId}`], clockSkewMs);
      if (!t.liveRunning && ((saved?.count > 0 && measuredMs != null) || (!saved && t.start < latest))) panelRounds.delete(key);
    }
  }
  paintPanel();
}

const KIND_LABEL = { codex: ['W', 'Work：由 Codex 执行'], worker: ['W', 'Work（持久 worker）：未见 Codex 活动记录'],
  chat: ['C', 'Chat：由 Pro 后台执行，没有 Codex 会话'] };
function paintPanelOpen(host) {
  const card = host.shadowRoot?.getElementById('card');
  const cls = panelOpen ? 'cv-card p open' : 'cv-card p';
  if (card && card.className !== cls) card.className = cls;
  const chev = host.shadowRoot?.getElementById('chev');
  if (chev && chev.textContent !== (panelOpen ? '▾' : '▸')) chev.textContent = panelOpen ? '▾' : '▸';
}
function togglePanel(host) {
  if (Date.now() - lastDragMovedAt < 400) return;   // 刚拖完松手，不算点击
  panelOpen = !panelOpen;
  paintPanelOpen(host);
  fitDock();
  try { void Promise.resolve(chrome.storage.local.set({ [PANEL_OPEN_KEY]: panelOpen })).catch(() => {}); }
  catch { /* 偏好写不进不影响显示 */ }
}
function paintPanel() {
  if (!panelInput) return;
  const { convId, streaming, measured, clockSkewMs, opts } = panelInput;
  let { kinds = null, codexUrl = null, stale = false, loading = false, empty = null } = opts;
  const turns = [...panelInput.turns];
  const indexes = new Map(turns.map((t, i) => [t.startId, i]));
  for (const t of panelRounds.values()) {
    const index = t.startId ? indexes.get(t.startId) : undefined;
    if (index !== undefined) turns[index] = { ...turns[index], ...t };
    else turns.push(t);
  }
  const partial = loading || (!panelInput.turns.length && panelRounds.size > 0);
  if (turns.length) { loading = false; empty = null; }
  const runningAt = i => turns[i].liveRunning ?? (streaming && i === turns.length - 1);
  let host = document.getElementById(PANEL_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = PANEL_ID;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; display: block; position: fixed; right: 16px; bottom: 144px; z-index: 2147483000; }
        ${FLOAT_CSS}
        .p { padding: 4px 11px; }
        .h { display: flex; align-items: center; gap: 8px; justify-content: space-between; white-space: nowrap; }
        .chev { color: #a1a1aa; font-size: 10px; }
        .rows { display: none; max-height: 40vh; min-width: 210px; overflow: auto; margin: 4px 0 2px;
                padding-top: 4px; border-top: 1px solid rgba(255,255,255,.1); color: #a1a1aa; font-size: 11.5px; }
        .p.open .rows { display: block; }
        .r { display: flex; gap: 10px; justify-content: space-between; align-items: baseline; }
        .s { font-size: 11px; color: #8b8b94; margin-bottom: 2px; }
        b { color: #e4e4e7; font-weight: 600; }
        .k { display: inline-block; min-width: 13px; margin-left: 5px; padding: 0 3px; border-radius: 4px;
             font: 700 10px/15px ${FLOAT_FONT}; text-align: center; vertical-align: 1px; }
        .k.w { color: #3ddc97; background: rgba(16,163,127,.22); }
        .k.c { color: #d4d4d8; background: rgba(161,161,170,.2); }
        .r a { margin-left: 6px; font-size: 11px; }
      </style>
      <div class="cv-card p" id="card"><div class="h cv-grip" id="drag" title="点击展开/收起每轮明细 · 按住拖动"><span id="sum"></span><span class="chev" id="chev">▸</span></div><div class="rows" id="rows"></div></div>`;
    const dock = mountFloat(host, 'panel');
    const handle = root.getElementById('drag');
    handle?.addEventListener?.('click', () => togglePanel(host));
    panelDragCleanup = dragFloat(host, dock, handle, PANEL_POSITION_KEY);
    paintPanelOpen(host);
    if (!panelOpenLoaded && typeof chrome !== 'undefined') {
      panelOpenLoaded = true;
      try {
        void Promise.resolve(chrome.storage.local.get({ [PANEL_OPEN_KEY]: false })).then((result) => {
          panelOpen = result?.[PANEL_OPEN_KEY] === true;
          const current = document.getElementById(PANEL_ID);
          if (current) { paintPanelOpen(current); fitDock(); }
        }).catch(() => {});
      } catch { /* 读不到偏好就保持收起 */ }
    }
  }
  const dots = convId.startsWith('dots-');
  const speedEnabled = !globalThis.__cvPage || globalThis.__cvPage.can('speedMetrics');
  const durationOf = (t, i) => {
    if (runningAt(i)) return null;
    if (t.liveMs != null) return t.liveMs;
    if (!t.count) return null;
    return measuredMsForTurn(t, measured?.[`${convId}:${t.startId}`], clockSkewMs) ?? t.ms;
  };
  let totalMs = 0;
  turns.forEach((t, i) => { totalMs += durationOf(t, i) ?? 0; });
  // 全是 Chat 时标签没有信息量，不画。
  const showKinds = !!kinds && turns.some(t => kinds[t.startId] && kinds[t.startId] !== 'chat');
  // 悬浮总览只建最近 20 行；全部历史仍由会话数据和消息徽标保留。
  // 几千轮的长对话不能在每次重画时额外创建几千个悬浮 DOM 节点。
  const offset = Math.max(0, turns.length - 20);
  const rows = turns.slice(offset).map((t, i) => {
    const index = offset + i;
    const running = runningAt(index);
    const ms = durationOf(t, index);
    const label = running ? (dots ? '等待消息' : '进行中') : ms != null ? fmtDur(ms) : '待回复';
    const kind = showKinds ? kinds[t.startId] : null;
    const tag = KIND_LABEL[kind] ? `<i class="k ${kind === 'chat' ? 'c' : 'w'}" title="${KIND_LABEL[kind][1]}">${KIND_LABEL[kind][0]}</i>` : '';
    const link = codexUrl && kind && kind !== 'chat'
      ? `<a href="${codexUrl}" target="_blank" rel="noopener" title="打开对应的 Codex 会话">Codex ↗</a>` : '';
    const speed = speedEnabled ? t.liveSpeed || globalThis.__cvSpeed?.lookup?.(convId, t.startId) : null;
    const detail = speed ? `<div class="s" title="${speedTip(speed)}">${fmtSpeed(speed)}</div>` : '';
    const number = partial ? (running ? '当前轮' : `本页 #${index + 1}`) : `#${index + 1}`;
    return `<div class="r"><span>${number}${tag}${link}</span><b>${label}</b></div>${detail}`;
  }).join('') || `<div class="r">${loading ? '历史轮次待加载' : '暂无'}</div>`;
  const rowsHost = host.shadowRoot.getElementById('rows');
  const html = (offset ? `<div>最近 20 / 共 ${turns.length} 轮</div>` : '') + rows;
  if (rowsHost.innerHTML !== html) rowsHost.innerHTML = html;
  const running = turns.some((_, i) => runningAt(i));
  const tail = running ? (dots ? ' · 等待消息' : ' · 进行中') : stale ? ' · 更新中…' : '';
  const count = partial ? (turns.length === 1 && running ? '当前轮' : `本页 ${turns.length} 轮`) : `${turns.length} 轮`;
  const summary = loading ? '⏱ 加载中…'
    : empty === 'no-user' ? '⏱ 无用户提问，不分轮'
    : `⏱ ${count}${totalMs > 0 ? ` · ${dots ? '跨度 ' : ''}${fmtDur(totalMs)}` : ''}${tail}${partial ? ' · 历史待加载' : ''}`;
  const sum = host.shadowRoot.getElementById('sum');
  if (sum && sum.textContent !== summary) sum.textContent = summary;
  const tip = loading ? '正在读取对话数据'
    : partial ? '先显示本页已观测到的轮次；历史数据加载后自动补全'
    : empty === 'no-user' ? '这段对话只有 assistant 与 tool 记录（连接器/agent 线程），没有用户提问；扩展按「用户提问 → 回复」计轮，因此没有每轮耗时'
    : stale ? '先显示上次记录的轮次，对话数据读取完成后自动更新' : '点击展开/收起每轮明细 · 按住拖动';
  const handle = host.shadowRoot.getElementById('drag');
  if (handle && handle.title !== tip) handle.title = tip;
}

/**
 * 渲染每轮的起止：用户提问上方标「开始 时刻」，本轮末尾标「时长 · 结束 时刻」。
 * 进行中的那一轮不画尾部——它还没有结束时间，由浮动计时器接管。
 */
/** 有消息、却一条 user 记录都没有：连接器/agent 线程（Chappie 等）只有 assistant 与 tool 记录。 */
function hasNoUserMessage(conv) {
  let hasMessage = false;
  for (const node of Object.values(conv?.mapping || {})) {
    const message = node?.message;
    if (!message) continue;
    if (message.author?.role === 'user') return false;
    hasMessage = true;
  }
  return hasMessage;
}

function renderTurns(conv, opts = {}) {
  const turns = turnsOf(conv);
  const convId = conv.conversation_id || conv.id || '';
  // 分不出轮就明说：否则浮层只会停在「加载中」，看不出是没有数据还是没有用户提问。
  if (!turns.length && hasNoUserMessage(conv)) {
    renderPanel([], convId, false, null, 0, { empty: 'no-user' });
    return { turns: 0, anchored: 0, empty: 'no-user', list: turns };
  }
  return { ...renderTurnList(turns, convId, conv.cv_source === 'dots', opts), list: turns };
}

/** 本地缓存的轮次摘要：只存 id 与时间，不存正文；每轮只留最后几条消息 id 供结束徽标定位。 */
const CACHE_TURNS = 200;
function compactTurns(turns) {
  return turns.slice(-CACHE_TURNS).map(t => ({ startId: t.startId, endId: t.endId, start: t.start, end: t.end,
    count: t.count, ms: t.ms, messageIds: (t.messageIds || []).slice(-4) }));
}
/** 页面刚打开、对话数据还没到：先用上次的缓存画出来，标「更新中」；真实数据到了照常覆盖。 */
function renderCached(cache, opts = {}) {
  if (!cache?.convId || !Array.isArray(cache.turns)) return { turns: 0, anchored: 0 };
  // 缓存里记着「没有用户提问」的也照原样画：SPA 内切回该对话时不会退回「加载中」。
  if (cache.empty === 'no-user') {
    renderPanel([], cache.convId, false, null, 0, { empty: 'no-user' });
    return { turns: 0, anchored: 0, empty: 'no-user' };
  }
  return renderTurnList(cache.turns, cache.convId, !!cache.dots, { ...opts, stale: true });
}
/** 连缓存都没有：先放一个「加载中」胶囊占位。 */
function showTurnsLoading(convId) {
  if (!convId || document.getElementById(PANEL_ID)) return;
  renderPanel([], convId, false, null, 0, { loading: true });
}

function renderTurnList(turns, convId, dots, { streaming = false, measured = null, clockSkewMs = 0, kinds = null,
  codexUrl = null, stale = false } = {}) {
  if (!turns.length) {
    checkPanelPath();
    if (panelRounds.size) {
      renderPanel([], convId, streaming, measured, clockSkewMs, { kinds, codexUrl, stale, loading: true });
      return { turns: 0, anchored: 0 };
    }
    panelDragCleanup?.();
    panelDragCleanup = null;
    document.getElementById(PANEL_ID)?.remove();
    return { turns: 0, anchored: 0 };
  }
  // 一次遍历可见消息，后续按 id 查 Map；长对话里逐轮 querySelector 会反复扫描页面。
  const anchors = new Map();
  for (const el of document.querySelectorAll('[data-message-id]')) {
    const id = el.getAttribute('data-message-id');
    if (id && !anchors.has(id)) anchors.set(id, el);
  }
  // 2026-09 主 profile 实测：新版页面没有 data-message-id/role/testid，
  // 但选区和搜索索引仍带 API message UUID。search 属性可含重复/多个 UUID。
  for (const el of document.querySelectorAll('[data-chatgpt-selection-message-id]')) {
    const id = el.getAttribute('data-chatgpt-selection-message-id');
    if (id && !anchors.has(id)) anchors.set(id, el);
  }
  for (const el of document.querySelectorAll('[data-chatgpt-search-message-ids]')) {
    for (const id of el.getAttribute('data-chatgpt-search-message-ids')?.match(MESSAGE_ID_RE) || []) {
      if (!anchors.has(id)) anchors.set(id, el);
    }
  }
  // 当前 ChatGPT 页面可能完全没有 data-message-id。只在用户消息的正文节点
  // 与 API prompt 唯一匹配时挂开始徽标；模糊/重复匹配宁可不挂，避免标错轮次。
  const userNodes = [...document.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"]')];
  const visibleUsers = userNodes.map((el) => ({ el, text: el.textContent?.replace(/\s+/g, ' ').trim() || '' }));
  const byText = new Map();
  for (const item of visibleUsers) {
    if (!byText.has(item.text)) byText.set(item.text, []);
    byText.get(item.text).push(item.el);
  }
  for (const t of turns) {
    if (anchors.has(t.startId) || !t.prompt) continue;
    const prompt = t.prompt.replace(/\s+/g, ' ').trim();
    const candidates = byText.get(prompt) || visibleUsers.filter(({ text }) => text.includes(prompt)).map(({ el }) => el);
    // 同一条消息的外层 role 容器与内层 testid 容器可能同时命中，取最内层。
    const matches = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains?.(other)));
    if (matches.length === 1) anchors.set(t.startId, matches[0]);
  }
  // 图片生成等轮次的最后一条 JSON 记录可能是没有独立页面节点的思考/状态消息。
  // 只要本轮任一非用户消息已有 ID 锚点，就优先使用最后一个实际渲染的消息。
  const lastVisibleAnchorId = (t) => {
    for (let i = t.messageIds.length - 1; i >= 0; i--) {
      if (anchors.has(t.messageIds[i])) return t.messageIds[i];
    }
    return null;
  };
  if (turns.some((t) => t.count > 0 && !lastVisibleAnchorId(t))) {
    const roles = [...document.querySelectorAll(
      '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-testid="user-message"], [data-testid="assistant-message"]')];
    const indexes = new Map(roles.map((el, i) => [el, i]));
    const nextStarts = Array(turns.length).fill(undefined);
    let nextStart;
    for (let i = turns.length - 1; i >= 0; i--) {
      nextStarts[i] = nextStart;
      const idx = indexes.get(anchors.get(turns[i].startId));
      if (idx !== undefined) nextStart = idx;
    }
    turns.forEach((t, i) => {
      if (!t.count || lastVisibleAnchorId(t)) return;
      const from = indexes.get(anchors.get(t.startId));
      if (from === undefined) return;
      const next = nextStarts[i];
      const until = next === undefined ? roles.length : next;
      for (let j = until - 1; j > from; j--) {
        const el = roles[j];
        if (el.getAttribute('data-message-author-role') === 'assistant'
          || el.getAttribute('data-testid') === 'assistant-message') {
          anchors.set(t.endId, el);
          break;
        }
      }
    });
  }
  const endAnchorIds = turns.map((t) => lastVisibleAnchorId(t) || (anchors.has(t.endId) ? t.endId : null));
  let anchored = 0;
  // 本轮"末条消息"在流式过程中会变（先是第一个助手分片，后来是别的），
  // 徽标按 消息id:类型 作键，换了 id 就会又挂一个、旧的留在原地。
  // 所以每次重画都先把不在本次预期集合里的徽标摘掉。
  const expected = new Set();
  turns.forEach((t, i) => {
    expected.add(`${t.startId}:start`);
    if (t.count > 0 && !(streaming && i === turns.length - 1)) expected.add(`${t.endId}:end`);
  });
  for (const h of document.querySelectorAll(`.${HOST_CLASS}`)) {
    if (!expected.has(h.dataset.cvFor)) h.remove();
  }
  turns.forEach((t, i) => {
    const running = streaming && i === turns.length - 1;
    if (attachBadge(anchors.get(t.startId), t.startId, `▷ 开始 ${fmtClock(t.start)}`,
      `本轮开始于 ${new Date(t.start * 1000).toLocaleString()}`, 'start', true)) anchored++;
    // 还没有任何回复的轮次没有耗时可标（否则会出现 ⏱ 0.0s）
    if (running || t.count === 0) return;
    // 接口的 create_time 记的是回答记录创建的时刻，不是流式输出结束的时刻——
    // 普通一问一答会系统性偏小（实测某轮真实 3.8s，接口算出来 2.0s）。
    // 所以在线看着跑完的轮次用计时器实测值，历史轮次才回退到接口推算。
    const real = measuredMsForTurn(t, measured?.[`${convId}:${t.startId}`], clockSkewMs);
    const ms = real ?? t.ms;
    const text = `⏱ <span class="dur">${fmtDur(ms)}</span> · ${dots ? '最新消息' : '结束'} ${fmtClock(t.end)}`;
    const el = anchors.get(endAnchorIds[i]);
    if (!el) return;
    // 尾部徽标带内联标记，attachBadge 只能设 textContent，这里直接补写 innerHTML
    const tip = dots
      ? `本轮已送达 ${t.count} 条 dots 消息；跨度按消息时间戳计算，不表示后台任务结束`
      : `本轮 ${t.count} 条消息${real != null ? '（时长为实测）' : '（时长按接口时间戳推算）'}`;
    if (attachBadge(el, t.endId, '', tip, 'end', false)) {
      const holder = badgeHolder(el);
      const host = [...holder.querySelectorAll(`.${HOST_CLASS}`)]
        .find((h) => h.dataset.cvFor === `${t.endId}:end`);
      const span = host?.shadowRoot?.querySelector('.b');
      if (span && span.innerHTML !== text) span.innerHTML = text;
      anchored++;
    }
  });
  renderPanel(turns, convId, streaming, measured, clockSkewMs, { kinds, codexUrl, stale });
  return { turns: turns.length, anchored };
}

// ---------- 进行中的一轮：实时计时器 ----------

let timerHost = null;
let timerStart = 0;
let timerTick = null;
let timerDragCleanup = null;
let timerDock = null;

/**
 * 显示计时器。startMs 是这一轮真正开始的时刻（那条用户消息的 create_time）。
 *
 * 这里绝不能用 Date.now() 当起点——那测的是"扩展看见流式开始的时刻"，页面一刷新
 * 或长思考期间 ChatGPT 重渲染一次停止按钮，计时就从 0 重来。实测踩过：19:43 发出
 * 的一轮在 23:16 只显示 2m10s。
 */
function showTimer(startMs) {
  if (globalThis.__cvPage && !globalThis.__cvPage.can('durations')) return;
  if (timerHost?.isConnected === false) hideTimer();
  let root = timerHost?.shadowRoot;
  if (timerHost) {
    if (startMs) timerStart = startMs; // 同一轮接口校时可前移也可后移
    if (timerTick !== null) return;
    // 宿主已创建但前次初始化中断：不能只因为节点存在就永久停在 0.0。
  } else {
    timerStart = startMs || Date.now();
    timerHost = document.createElement('div');
    timerHost.id = TIMER_ID;
    timerHost.setAttribute?.('data-cv-script-version', TURNS_VERSION);
    root = timerHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
    <style>
      :host { all: initial; display: block; position: fixed; right: 16px; bottom: 96px; z-index: 2147483000; }
      ${FLOAT_CSS}
      .t { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-color: rgba(16,163,127,.55); }
      #v { font-weight: 700; font-size: 13.5px; color: #3ddc97; }
      .s { color: #a1a1aa; font-size: 11.5px; }
      .s:empty { display: none; }
      .d { width: 7px; height: 7px; border-radius: 50%; background: #10a37f; animation: p 1s infinite; }
      @keyframes p { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    </style>
    <span class="t cv-card cv-grip" title="本轮进行中 · 按住拖动"><span class="d"></span><span id="v">0.0s</span><span class="s" id="from"></span><span class="s" id="speed" title="${SPEED_TIP}"></span></span>`;
    timerDock = mountFloat(timerHost, 'timer');
  }
  const v = root.getElementById('v');
  const from = root.getElementById('from');
  const speed = root.getElementById('speed');
  const paint = () => {
    v.textContent = fmtDur(Date.now() - timerStart);
    from.textContent = `${globalThis.__cvDots?.dotsId() ? '等待消息 · ' : ''}始于 ${fmtClock(timerStart / 1000)}`;
    // 耗时是基本功能；测速模块失败不能阻止首次绘制或后续 tick。
    if (timerReloadRequired) {
      if (speed) {
        const warning = '扩展已重载 · 请刷新页面';
        const explanation = '旧页面与扩展后台的连接已失效。耗时仍在计时，刷新后恢复同步和 TTFT/TPS。';
        if (speed.textContent !== warning) speed.textContent = warning;
        if (speed.title !== explanation) speed.title = explanation;
      }
      return;
    }
    try {
      const stats = globalThis.__cvSpeed?.snapshot();
      const label = fmtSpeed(stats);
      if (speed && speed.textContent !== label) speed.textContent = label;
      const tip = speedTip(stats);
      if (speed && speed.title !== tip) speed.title = tip;
    } catch (err) { reportTimerError('speed.paint', err); }
  };
  paint();
  timerTick = setInterval(paint, 100);
  // 拖动、位置恢复是装饰功能，必须在计时循环就绪之后执行。
  try { timerDragCleanup = dragFloat(timerHost, timerDock, root.querySelector?.('.t'), TIMER_POSITION_KEY); }
  catch (err) { reportTimerError('drag.init', err); }
}

function hideTimer() {
  clearInterval(timerTick);
  timerTick = null;
  timerDragCleanup?.();
  timerDragCleanup = null;
  timerHost?.remove();
  timerHost = null;
}

/** 是否有一轮正在跑：停止按钮存在就是在流式输出 */
function isStreaming() {
  if (globalThis.__cvDots?.dotsId()) return globalThis.__cvDots.isWaiting();
  return !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]');
}

// 每条用户消息第一次出现在页面上的时刻。页面可能没有 data-message-id，
// 此时用稳定的正文指纹识别新一轮；不把 DOM 节点身份当作消息身份（React 会重建节点）。
const seenUser = new Map();
let primed = false;
let trackedPath = location.pathname;
let observedConversation = null;
let reconcileObservedRound = () => {};

// DOM hydration order is not send order. Reuse snapshots already fetched by
// content.js and reconcile only the exact active message ID, without extra GETs.
function observeConversation(conv, { clockSkewMs = 0 } = {}) {
  const id = conv?.conversation_id || conv?.id;
  const current = globalThis.__cvDots?.conversationId()
    || /\/c\/([0-9a-fA-F-]{36})/.exec(location.pathname)?.[1];
  if (!id || id !== current) return;
  const starts = new Map();
  for (const node of Object.values(conv.mapping || {})) {
    const m = node?.message;
    if (m?.author?.role === 'user' && m.id && Number.isFinite(m.create_time)
      && !m.metadata?.is_visually_hidden_from_conversation) starts.set(m.id, m.create_time * 1000 + clockSkewMs);
  }
  observedConversation = { path: location.pathname, starts };
  reconcileObservedRound();
}

function trackUserMessages() {
  if (location.pathname !== trackedPath) {
    seenUser.clear();
    primed = false;
    trackedPath = location.pathname;
  }
  const nodes = document.querySelectorAll('[data-message-author-role="user"], [data-testid="user-message"], [data-user-message-bubble], .message-row.self[data-message-id]');
  if (!nodes.length) return null;
  const last = nodes[nodes.length - 1];
  const id = last.getAttribute('data-message-id')
    || last.getAttribute('data-chatgpt-selection-message-id')
    || last.closest?.('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.match(MESSAGE_ID_RE)?.[0]
    || last.closest?.('[data-turn-key]')?.getAttribute('data-turn-key')?.match(MESSAGE_ID_RE)?.[0]
    || null;
  const body = (last.querySelector?.('.message-body') || last).textContent?.replace(/\s+/g, ' ').trim() || '';
  const key = id ? `id:${id}` : body ? `text:${body}` : null;
  if (key && !seenUser.has(key)) seenUser.set(key, { at: Date.now(), initial: !primed, id, key });
  primed = true;
  return seenUser.get(key) || null;
}

/**
 * 监听流式状态，并给计时器定起点。
 *
 * 判据是「这一轮的用户消息，是不是我们亲眼看着出现的」：
 *  - 是 → 起点就用看见它的那一刻。**不要去问接口**：消息刚发出时还没落库，问了会
 *    取到上一轮那条（实测取到过 119 秒前、甚至 29.7 天前的旧消息）。
 *  - 不是（页面加载/切进对话时它就在了，即正在跑的那一轮）→ 消息早已落库，问接口
 *    拿真实起点。这正是「19:43 发出的一轮，刷新后显示 38s 始于 23:35」的修复点。
 *
 * 用消息 id 而不是「第几次 check」来判断：content script 在 document_idle 注入时
 * 页面往往还没渲染完，停止按钮那会儿不存在，靠调用次数会把"已在跑"误判成"刚开始"。
 * 按 id 追踪还顺带解决了同一轮内停止按钮被重渲染导致计时清零的问题——id 没变，
 * 起点就没变。
 */
function watchStreaming(onEnd, resolveStart, onStart) {
  let streaming = false;
  let active = null;
  let generation = 0;
  let path = location.pathname;
  let enteredAtMs = typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin : Date.now();
  let pendingEnd = null;
  const uiEnabled = () => !globalThis.__cvPage || globalThis.__cvPage.can('durations');
  const runningEnabled = () => !globalThis.__cvPage || globalThis.__cvPage.can();
  const callSpeed = (method, args) => {
    try { return globalThis.__cvSpeed?.[method]?.(args); }
    catch (err) { reportTimerError(`speed.${method}`, err); }
  };
  const invoke = (callback, value, stage) => {
    try { Promise.resolve(callback?.(value)).catch(err => reportTimerError(stage, err)); }
    catch (err) { reportTimerError(stage, err); }
  };
  const paintRound = (round, endedAtMs = null, stats = undefined) => {
    if (!uiEnabled()) return;
    try { observePanelRound(round, stats === undefined ? callSpeed('snapshot') : stats, endedAtMs); }
    catch (err) { reportTimerError('panel.paint', err); }
  };
  reconcileObservedRound = () => {
    if (!runningEnabled() || !streaming || !active?.id || path !== location.pathname
      || observedConversation?.path !== path) return;
    const ms = observedConversation.starts.get(active.id);
    if (!Number.isFinite(ms)) return;
    active.startMs = ms;
    active.confirmed = true;
    // Allow small clock/header rounding error. A request demonstrably predating
    // this document/route is a resumed round even if its DOM appeared later.
    const resumed = ms < enteredAtMs - 2000;
    if (resumed) active.initial = true;
    callSpeed('correctRound', { startMs: ms, userMessageId: active.id, resumed });
    if (uiEnabled()) showTimer(ms);
    paintRound(active);
  };

  const endRound = (superseded = false, endedAt = Date.now()) => {
    if (!streaming) return;
    const startedAtMs = active?.startMs ?? null;
    const measuredMs = startedAtMs == null ? null : Math.max(0, endedAt - startedAtMs);
    const stats = callSpeed('finishRound', { userMessageId: active?.id });
    paintRound(active, endedAt, stats);
    hideTimer();
    streaming = false;
    const ended = active;
    active = null;
    generation++;
    invoke(onEnd, { measuredMs, startedAtMs, endedAtMs: endedAt, path,
      userMessageId: ended?.id && (!ended.initial || ended.confirmed) ? ended.id : null,
      superseded }, 'round.end');
  };

  /** 刷新恢复或缺少 DOM id 时回查；旧请求、上一轮结果绝不能覆盖新一轮。 */
  const backfill = (round, token, attempt = 0) => {
    if (!streaming || active !== round || generation !== token || round.confirmed || attempt > 7) return;
    const owner = { path, userMessageId: round.id };
    Promise.resolve().then(() => resolveStart?.(owner)).then((info) => {
      if (!info?.ms || !streaming || active !== round || generation !== token) return;
      // 本地刚看到新消息，但接口还只有上一轮时，拒绝旧时间并稍后重试。
      if (!round.initial && info.ms < round.at - 10000) return;
      if (round.id && info.id !== round.id) return;
      round.id = info.id;
      round.confirmed = true;
      round.startMs = info.ms;
      if (uiEnabled()) showTimer(info.ms);
      paintRound(round);
    }).catch(() => {}).then(() => {
      if (streaming && active === round && generation === token && !round.confirmed) {
        setTimeout(() => backfill(round, token, attempt + 1), 2000);
      }
    });
  };

  const beginRound = (rec) => {
    streaming = true;
    const token = ++generation;
    active = { key: rec?.key || null, id: rec?.id || null,
      at: rec?.at || Date.now(), initial: rec?.initial ?? true,
      confirmed: !!rec?.id && !rec.initial };
    active.startMs = active.initial ? Date.now() : active.at;
    if (uiEnabled()) showTimer(active.startMs);
    callSpeed('beginRound', { startMs: active.at,
      userMessageId: active.id, resumed: active.initial });
    reconcileObservedRound();
    paintRound(active);
    // 页面恢复时需要真实服务端起点；无 DOM id 时需要异步取得可持久化的 id。
    if (active.initial || !active.id) backfill(active, token);
    if (rec && !rec.initial) invoke(onStart, { path }, 'round.start');
  };

  const check = () => {
    if (!runningEnabled()) return;
    if (location.pathname !== path) {
      path = location.pathname;
      enteredAtMs = Date.now();
      if (pendingEnd) clearTimeout(pendingEnd);
      pendingEnd = null;
      hideTimer();
      streaming = false;
      active = null;
      generation++;
      callSpeed('reset');
    }
    const rec = trackUserMessages();
    const now = isStreaming();
    if (!now) {
      // 停止按钮在重渲染时可能短暂消失；延迟确认，计时仍截在首次消失时刻。
      if (streaming && !pendingEnd) {
        const stoppedAt = Date.now();
        pendingEnd = setTimeout(() => {
          pendingEnd = null;
          if (!isStreaming() && location.pathname === path) endRound(false, stoppedAt);
        }, 1000);
      }
      return;
    }
    if (pendingEnd) { clearTimeout(pendingEnd); pendingEnd = null; }
    if (!streaming) { beginRound(rec); return; }
    callSpeed('sample', Date.now());
    if (uiEnabled()) showTimer(active.startMs);
    if (rec?.key && active?.key && rec.key !== active.key) {
      endRound(true);
      beginRound(rec);
    } else if (rec?.key && !active?.key) {
      active.key = rec.key;
      if (rec.id) active.id = rec.id;
    }
    paintRound(active);
  };
  // 流式输出期间 body 每秒变动几十次，观察器回调必须去抖，
  // 否则每批变动都要跑一次 querySelector
  let pending = null;
  const debounced = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; check(); }, 250);
  };
  const observer = new MutationObserver((records) => {
    callSpeed('noteMutation', records);
    debounced();
  });
  let interval = null;
  const resume = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    interval = setInterval(check, 1000);
  };
  resume();
  let previousSpeed = globalThis.__cvPage?.can('speedMetrics');
  globalThis.__cvPage?.subscribe(() => {
    if (!runningEnabled()) {
      observer.disconnect(); clearInterval(interval); interval = null;
      clearTimeout(pending); pending = null; clearTimeout(pendingEnd); pendingEnd = null;
      generation++; streaming = false; active = null;
      primed = false; seenUser.clear();
      hideTimer(); clearTurns(); callSpeed('reset');
    } else {
      if (interval === null) resume();
      if (!uiEnabled()) { hideTimer(); clearTurns(); }
      const speedEnabled = globalThis.__cvPage.can('speedMetrics');
      if (speedEnabled && !previousSpeed && active) callSpeed('beginRound', {
        startMs: active.at, userMessageId: active.id, resumed: true });
      previousSpeed = speedEnabled;
      check();
    }
  });
  check();
}

// MV3 的 content script 不支持 ES module；同一扩展的多个 content script
// 共享同一个隔离世界的全局作用域，所以挂个命名空间给 content.js 用。
function clearTurns() {
  panelInput = null;
  panelRounds.clear();
  // 实时计时器由 watchStreaming 自己按路径切换；这里不能删除它刚在新页面创建的计时器。
  panelDragCleanup?.();
  panelDragCleanup = null;
  document.getElementById(PANEL_ID)?.remove();
  for (const host of document.querySelectorAll(`.${HOST_CLASS}`)) host.remove();
}
function timerStatus() {
  return { version: TURNS_VERSION, timer_present: !!timerHost, loop_active: timerTick !== null,
    started_at_ms: timerHost ? timerStart : null, elapsed_ms: timerHost ? Math.max(0, Date.now() - timerStart) : null,
    reload_required: timerReloadRequired, last_error: lastTimerError ? { ...lastTimerError } : null };
}

globalThis.__cvTurns = { turnsOf, renderTurns, renderCached, showTurnsLoading, compactTurns, watchStreaming, isStreaming, observeConversation,
  clear: clearTurns, status: timerStatus, mountFloat, floatCss: FLOAT_CSS };
