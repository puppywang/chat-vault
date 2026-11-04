// 同步 dots 自己的实时状态到标题：优先底部状态区，其次当前 dot 的状态控件。
// 不读取最后一条消息，不凭消息/动画推断任务状态，也不依赖布局序号 XPath。
(() => {
  // 同一环境被重复注入（补注入与注册注入撞在一起）时不起第二份：两份标题脚本互改曾锁死整个渲染进程。
  if (globalThis.__cvDotsTitle) return;
  const STATUS_SELECTOR = '[class~="group/aeon-status"]';
  const DOCK_SELECTOR = '[role="status"][aria-hidden], [class~="contents"][aria-hidden]';
  const RELEVANT = `${DOCK_SELECTOR}, ${STATUS_SELECTOR}`;
  const VERSION = globalThis.__cvPage?.version || 'unknown';
  let enabled = false;
  let thread = null;
  let originalTitle = '';
  let appliedTitle = null;
  let pending = null;
  let status = null;
  let observed = [];
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  // Observed sidebar variants include "Active 2分钟前"; recency is availability,
  // not a task. Accept only known relative-time suffixes, never "Active <task>".
  const availabilityLabel = label => /^(?:空闲|idle|活跃|active)$/i.test(label)
    || /^(?:活跃|active)\s*(?:刚刚|just now|\d+(?:\.\d+)?\s*(?:秒|分钟|小时|天|周|个月|年)前|\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|secs?|mins?|[smhdw])(?:\s+ago)?)$/i.test(label);
  const excerpt = text => {
    const chars = Array.from(clean(text));
    return chars.slice(0, 64).join('') + (chars.length > 64 ? '…' : '');
  };
  const routeId = () => globalThis.__cvDots?.dotsId() ||
    /^\/dots\/([0-9a-f-]{36})(?:\/|$)/i.exec(location.pathname)?.[1] || null;

  function visible(el) {
    if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function readPage() {
    const name = clean(originalTitle).replace(/\s*[-|·]\s*ChatGPT$/i, '');
    // 同一张底部卡片上同时有 dot 名称和状态；用这个关联避免读到别的 dot 或通知。
    // 空闲时 role=status 和子节点会消失，但 aria-hidden 的占位 span 保留，仍需观察它。
    // 2026-10-10 起状态放进了顶部头像卡（group/orbit-profile），名字节点只是 .truncate、文字是 dot 自己的短名（如「dot」），
    // 与标题「你的 Dot」对不上：在头像卡里的状态区直接认作当前 dot 的。
    const docks = [...document.querySelectorAll(DOCK_SELECTOR)].filter(region =>
      !region.closest('.message-list') &&
      (clean(region.parentElement?.querySelector(':scope > .truncate.font-medium')?.textContent) === name
        || !!region.closest('[class~="group/orbit-profile"]')));
    const dockStates = docks.map(region => {
      const textNode = region.querySelector('.line-clamp-2') || region.firstElementChild;
      return { region, textNode, text: clean(textNode?.textContent) };
    });
    const live = dockStates.find(item => item.region.getAttribute('role') === 'status' &&
      item.region.getAttribute('aria-hidden') !== 'true' && item.text && visible(item.textNode));
    const controls = [...document.querySelectorAll(STATUS_SELECTOR)].filter(control => {
      const label = clean(control.getAttribute('aria-label')).replace(/^(?:pause|resume|暂停|继续|恢复)\s*/i, '');
      return label === name;
    });
    const header = controls.find(visible) || controls[0];
    // 控件可能在收起的侧栏中：它的 aria-describedby 仍提供当前 dot 的实际状态，
    // 不要因控件不可见而丢弃，更不能把 hover 时显示的「Pause little」当状态。
    const description = (header?.getAttribute('aria-describedby') || '').split(/\s+/)
      .map(id => id && document.getElementById(id)).find(node => clean(node?.textContent));
    const label = clean(description?.textContent || header?.firstElementChild?.textContent);
    const control = header?.getAttribute('aria-label') || '';
    const paused = /暂停|paused/i.test(label) || /^(?:resume\b|继续|恢复)/i.test(control);
    // 已识别的当前 dot 底部卡片保留隐藏的空状态占位时，才有页面空闲证据。
    // 活跃/Active 是启用状态；侧栏若有真正的工作状态，仍优先保留，不误报空闲。
    // 头像卡里的占位节点退场后仍保留上一次的文字（实测「正在思考」+ aria-hidden=true、无 role），不能要求为空。
    const idleEvidence = !live && dockStates.some(item => item.region.getAttribute('aria-hidden') === 'true' &&
      item.region.getAttribute('role') !== 'status'
      && (!item.text || !!item.region.closest('[class~="group/orbit-profile"]')))
      && header?.getAttribute('aria-busy') !== 'true' && (!label || availabilityLabel(label));
    const state = paused ? (/暂停|paused/i.test(label) ? label : '已暂停') : live?.text || (idleEvidence ? '空闲' : label || null);
    const source = paused ? 'dots-status-control' : live ? 'dots-live-status'
      : idleEvidence ? 'dots-idle-status' : label ? 'dots-status-control' : 'dots-status-unavailable';
    return { state, source, idleEvidence, rawStatus: live?.text || label || null, observed_at: new Date().toISOString(),
      nodes: [...docks, header, description].filter(Boolean) };
  }

  // 原题名去掉开头的「[状态] 」前缀：扩展重载时新旧两份脚本会同时改标题，彼此把对方加过前缀的标题当原题名，
  // 前缀越叠越长（2026-10-10「[空闲] [空闲] …」把整个渲染进程卡死，同站的其他标签页一起无响应）。
  const bareTitle = title => String(title || '').replace(/^(?:\[[^\]]{0,80}\]\s*)+/, '');
  // 改写限流：1 秒内超过 4 次就暂停 10 秒，任何互相改写都不可能锁死主线程。
  let titleWrites = [];
  let titleMutedUntil = 0;
  function writeTitle(next) {
    const now = Date.now();
    if (now < titleMutedUntil) return;
    titleWrites = titleWrites.filter(at => now - at < 1000);
    titleWrites.push(now);
    if (titleWrites.length > 4) {
      titleMutedUntil = now + 10000;
      globalThis.__cvPage?.report('dots.title', new Error('标题被反复改写，暂停 10 秒'));
      return;
    }
    document.title = next;
  }

  function release() {
    clearTimeout(pending);
    pending = null;
    // 路由已改写标题时不要用旧的 dots 名称覆盖它。
    if (appliedTitle !== null && document.title === appliedTitle) writeTitle(originalTitle);
    appliedTitle = null;
    thread = null;
    status = null;
    statusObserver.disconnect();
    observed = [];
  }

  function update() {
    const id = routeId();
    if (!enabled || !id) { release(); return null; }
    if (thread !== id) {
      release();
      thread = id;
      originalTitle = bareTitle(document.title);
    } else if (document.title !== appliedTitle) {
      originalTitle = bareTitle(document.title);
    }
    const page = readPage();
    if (page.nodes.length !== observed.length || page.nodes.some((node, i) => node !== observed[i])) {
      statusObserver.disconnect();
      observed = page.nodes;
      for (const node of observed) statusObserver.observe(node, { subtree: true, childList: true,
        characterData: true, attributes: true,
        attributeFilter: ['role', 'aria-label', 'aria-describedby', 'aria-hidden', 'class', 'style', 'hidden'] });
    }
    // 没有真实状态时保留题名，不用回复正文和「状态未知」凑一个看似实时的状态。
    const next = page.state ? `[${excerpt(page.state)}] ${clean(originalTitle) || 'Dots'}` : originalTitle;
    appliedTitle = next;
    status = { enabled, dots_id: thread, state: page.state, status_text: page.state,
      version: VERSION, raw_status: page.rawStatus, idle_evidence: page.idleEvidence,
      source: page.source, observed_at: page.observed_at, title: next };
    if (document.title !== next) writeTitle(next);
    return snapshot();
  }

  function schedule() {
    if (!enabled || !routeId() || pending !== null) return;
    // 合并同一秒内的状态变更，不因工具卡片或动画反复读写标题。
    pending = setTimeout(() => { pending = null; update(); }, 1000);
  }

  function noteMutation(records) {
    if (!enabled || !routeId() || pending !== null) return;
    for (const record of records) {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      if (target?.closest?.(RELEVANT) || [...(record.addedNodes || []), ...(record.removedNodes || [])].some(node => node.nodeType === 1 &&
        (node.matches?.(RELEVANT) || node.querySelector?.(RELEVANT)))) { schedule(); return; }
    }
  }

  function snapshot() { return status ? { ...status } : { enabled, version: VERSION, dots_id: routeId(), state: null }; }
  const statusObserver = new MutationObserver(schedule);
  // ChatGPT 会自行更新 <title>。保留它的真实题名后重加状态，不叠加前缀。
  // 不在观察回调里同步重写（回调是微任务，两份脚本互改会形成永不让出主线程的循环）；交给 schedule 合并到 1 秒后。
  const titleObserver = new MutationObserver(() => {
    if (document.title === appliedTitle) return;
    schedule();
  });
  function setEnabled(value) {
    enabled = value;
    titleObserver.disconnect();
    if (enabled && document.head) titleObserver.observe(document.head, { childList: true, characterData: true, subtree: true });
    update();
  }
  async function loadSettings() {
    try {
      const settings = await chrome.storage.local.get({ dotsTitle: true, injectionEnabled: true });
      setEnabled(!!settings.dotsTitle && !!settings.injectionEnabled);
    } catch (err) { globalThis.__cvPage?.report('dots.settings', err); setEnabled(false); }
  }
  let ready;
  if (globalThis.__cvPage) {
    globalThis.__cvPage.subscribe(() => setEnabled(globalThis.__cvPage.can('dotsTitle')));
    ready = globalThis.__cvPage.ready;
  } else {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.dotsTitle || changes.injectionEnabled)) void loadSettings();
    });
    ready = loadSettings();
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') update(); });
  globalThis.__cvDotsTitle = { update, noteMutation, snapshot, ready };
})();
