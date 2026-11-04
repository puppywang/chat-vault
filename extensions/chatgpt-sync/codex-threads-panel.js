// 弹窗「Codex Cloud 线程」块：列出 ChatGPT 网页（Work 模式）创建过的 Codex Cloud 根线程，方便直接打开旧线程复用。
// 线程列表：经任一 ChatGPT 标签页的内容脚本，用页面登录态只读调用 codex-cloud-backend 的 thread/list。
// 标题与来源对话：本机 ChatVault（/api/codex/threads/annotate）+ 扩展自己记下的「对话 → 线程」关联。
// 上次的结果缓存在 chrome.storage.local，打开弹窗先显示缓存，点「刷新」才重新连接。
(() => {
  const $card = document.getElementById('codexCard');
  if (!$card) return;
  const $ = id => document.getElementById(id);
  const $list = $('codexList'), $status = $('codexStatus'), $refresh = $('codexRefresh'), $filter = $('codexFilter');
  const $toggle = $('codexToggle'), $archived = $('codexArchived'), $probeAll = $('codexProbeAll');
  const CACHE_KEY = 'cvCodexThreadsCacheV1';
  const SHOWN = 8;
  let data = null, showAll = false, busy = false, opens = {}, probes = {};

  const say = (text, kind = '') => { $status.textContent = text; $status.className = `hint ${kind}`; };
  const tail = id => `…${String(id || '').split('-').pop()}`;
  const fmtAge = sec => {
    const ms = Date.now() - sec * 1000;
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.round(ms / 60000);
    return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
  };
  const fmtDate = sec => {
    const d = new Date(sec * 1000);
    return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}` : '';
  };
  // ChatVault 标题形如「Codex Cloud · [$chappie](app://…) 连接 …」：去掉前缀与链接地址。
  const cleanTitle = t => String(t || '').replace(/^Codex Cloud\s*·\s*/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  async function chatgptTab() {
    try {
      const tab = await targetTab();
      if (/^https:\/\/chatgpt\.com\//.test(tab?.url || '')) return tab;
    } catch { /* 走下面的兜底 */ }
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/*' });
    return tabs.find(t => !t.discarded) || null;
  }

  /** 扩展本地记下的「对话 → 线程」：查找核验成功（cvCodexLinkV1）或推送中断核对（cvWorkRoundV1）时写入。 */
  async function localLinks() {
    const all = await chrome.storage.local.get(null).catch(() => ({}));
    const byThread = new Map();
    for (const [k, v] of Object.entries(all || {})) {
      const m = /^cv(?:CodexLink|WorkRound)V1:([0-9a-f-]{36})$/i.exec(k);
      const threadId = String(v?.threadId || '').toLowerCase();
      if (!m || !/^[0-9a-f-]{36}$/.test(threadId)) continue;
      if (!byThread.has(threadId)) byThread.set(threadId, new Set());
      byThread.get(threadId).add(m[1].toLowerCase());
    }
    return byThread;
  }

  function badge(status) {
    const s = String(status || '');
    const [cls, text] = s === 'idle' ? ['off', '空闲'] : /active|running|inProgress/i.test(s) ? ['run', '运行中']
      : /error/i.test(s) ? ['wait', '出错'] : ['off', s || '未知'];
    return el('span', `pi-badge ${cls}`, text);
  }

  // 打开线程页的实际结果（内容脚本存的 cvCodexOpenV1:<thread>）。后端没有只读接口能提前查会话还在不在，只能看上次打开的结果。
  async function loadOpens() {
    const all = await chrome.storage.local.get(null).catch(() => ({}));
    opens = {}; probes = {};
    for (const [k, v] of Object.entries(all || {})) {
      const m = /^cvCodex(Open|Probe)V1:([0-9a-f-]{36})$/.exec(k);
      if (m && v?.outcome) (m[1] === 'Open' ? opens : probes)[m[2]] = v;
    }
  }
  const fmtClock = ms => { const d = new Date(ms); return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; };
  // 2026-10-14 纠正：浏览器里每个线程页打开都会自己发 thread/resume（浏览器版的跨标签页协调是空实现，
  // 没有「跟随别的标签页」这回事）。能不能用只看服务端对 resume 的回应：01a12a0c 成功（实测 0.8 秒到 305 秒不等），
  // 01a0c2a3 约 14.6 秒后报 FAILED_PRECONDITION。标签页数只作参考，不代表持有。
  let tabsByThread = {};
  async function loadTabs() {
    tabsByThread = {};
    const tabs = await chrome.tabs.query({ url: 'https://chatgpt.com/local/*' }).catch(() => []);
    for (const tab of tabs) {
      const id = /\/local\/([0-9a-f-]{36})/i.exec(tab.url || '')?.[1]?.toLowerCase();
      if (id) (tabsByThread[id] ||= []).push(tab);
    }
  }
  // 能不能恢复：取「打开线程页时页面自己的恢复」和「列表里点检查」两者中较新的结果。
  function openLine(t) {
    const o = opens[t.threadId], p = probes[t.threadId];
    const latest = [o && { ...o, source: '打开时' }, p && { ...p, source: '检查时' }].filter(Boolean).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    const tabs = tabsByThread[t.threadId] || [];
    const line = el('div', 'pi-head codex-env');
    const secs = ms => ms != null ? `${(ms / 1000).toFixed(1)} 秒` : '';
    if (!latest) {
      const b = el('span', 'pi-badge off', '能否恢复未知');
      b.title = '后端没有只读接口能提前查；点「检查」会替你发一次恢复线程请求，和打开线程页时页面自己发的一样';
      line.append(b);
    } else {
      const [cls, text, tip] = latest.outcome === 'resumed' ? ['on', '可恢复', `恢复线程成功${latest.resumeKind ? `（${latest.resumeKind}）` : ''}，用时 ${secs(latest.ms)}`]
        : latest.outcome === 'warm' ? ['on', '未恢复即可用', '打开后 20 秒内页面没有发恢复线程请求']
        : latest.outcome === 'failed' ? ['wait', '恢复被拒', `服务端拒绝恢复这个线程（${secs(latest.ms)}），打开后会一直「正在加载模型」：${latest.error || '未知错误'}`]
        : latest.outcome === 'timeout' ? ['off', '检查超时', '2 分钟内没有回应，服务端可能还在恢复；稍后再打开或再检查']
        : latest.outcome === 'checking' ? ['run', '检查中', '正在替你发恢复线程请求，最多等 2 分钟']
        : ['off', '检查出错', latest.error || '未知错误'];
      const b = el('span', `pi-badge ${cls}`, text);
      b.title = tip;
      line.append(b, el('span', 'hint', `${latest.source} ${fmtClock(latest.at)}`));
    }
    if (tabs.length) line.append(el('span', 'pi-chip', `${tabs.length} 个标签页开着`));
    if (latest?.outcome !== 'checking') {
      const check = el('button', 'link codex-check', '检查');
      check.title = '替你发一次恢复线程请求，看服务端接不接受';
      check.addEventListener('click', () => probe([t.threadId]));
      line.append(check);
    }
    return line;
  }

  async function probe(threadIds) {
    try {
      const tab = await chatgptTab();
      if (!tab) throw new Error('没有打开的 ChatGPT 标签页；先打开 chatgpt.com 再检查');
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'probeCodexResume', threadIds })
        .catch(() => { throw new Error('ChatGPT 页面没响应；请刷新那个标签页后重试'); });
      if (!reply?.ok) throw new Error(reply?.error || '检查没有开始');
      say(`正在检查 ${reply.started} 个线程能否恢复（同时最多 3 个，单个最多等 2 分钟；关掉弹窗也会继续）`);
    } catch (err) { say(err.message, 'bad'); }
  }

  function row(t) {
    const info = data.annotations?.[t.threadId] || {};
    const archivedTitle = cleanTitle(info.chatvault?.title);
    const box = el('div', 'pi-row codex-row');
    const head = el('div', 'pi-head');
    head.append(badge(t.status));
    const title = el('b', null, archivedTitle || t.name || (t.cwd ? t.cwd.split('/').pop() : '（未归档）'));
    title.title = archivedTitle || t.name || t.threadId;
    head.append(title);
    const idChip = el('span', 'pi-code', tail(t.threadId));
    idChip.title = `${t.threadId}（点击复制）`;
    idChip.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(t.threadId); say('已复制线程 ID。', 'ok'); } catch { say('复制失败', 'bad'); }
    });
    head.append(idChip);
    if (t.archived) head.append(el('span', 'pi-chip', '已归档'));
    box.append(head);
    const sub = [t.model, t.reasoningEffort, t.updatedAt ? `更新 ${fmtAge(t.updatedAt)}` : '', t.createdAt ? `创建 ${fmtDate(t.createdAt)}` : '',
      info.chatvault ? `${info.chatvault.messageCount} 条` : '未归档'].filter(Boolean).join(' · ');
    const subEl = el('div', 'hint pi-sub', sub);
    subEl.title = [sub, t.cwd].filter(Boolean).join('\n');
    box.append(subEl);
    box.append(openLine(t));
    const links = data.linksByThread?.[t.threadId] || [];
    if (links.length) {
      const wrap = el('div', 'pi-drivers');
      for (const l of links.slice(0, 3)) {
        const a = el('div', 'pi-driver');
        a.textContent = l.title || `ChatGPT ${tail(l.conversationId)}`;
        a.title = `${l.via === 'sender' ? '确认：对话里的协作记录指向这个线程' : l.via === 'local' ? '扩展查找核验时记下的关联'
          : '候选：对话里出现过同一个工作目录'}\n点击打开 chatgpt.com/c/${l.conversationId}`;
        if (l.via === 'workspace') a.append(el('span', 'pi-chip', '候选'));
        a.addEventListener('click', () => chrome.tabs.create({ url: `https://chatgpt.com/c/${l.conversationId}` }));
        wrap.append(a);
      }
      box.append(wrap);
    } else box.append(el('div', 'hint pi-sub', '没找到来源对话（可能是在 Codex 页里直接新建的）'));
    const actions = el('div', 'actions');
    const open = el('button', 'secondary', '打开线程');
    open.title = t.url;
    open.addEventListener('click', () => chrome.tabs.create({ url: t.url }));
    actions.append(open);
    box.append(actions);
    return box;
  }

  function paint() {
    $list.replaceChildren();
    if (!data?.threads?.length) { $toggle.hidden = true; return; }
    const q = $filter.value.trim().toLowerCase();
    const match = t => !q || [t.threadId, t.cwd, t.model, cleanTitle(data.annotations?.[t.threadId]?.chatvault?.title),
      ...(data.linksByThread?.[t.threadId] || []).map(l => l.title)].some(v => String(v || '').toLowerCase().includes(q));
    const list = data.threads.filter(match);
    for (const t of showAll || q ? list : list.slice(0, SHOWN)) $list.append(row(t));
    $toggle.hidden = !!q || list.length <= SHOWN;
    $toggle.textContent = showAll ? '收起' : `显示全部 ${list.length} 个`;
  }

  async function annotate(threads) {
    const local = await localLinks();
    const conversationIds = [...new Set([...local.values()].flatMap(s => [...s]))];
    const reply = await chrome.runtime.sendMessage({ type: 'piApi', method: 'POST', path: '/api/codex/threads/annotate',
      body: { threads: threads.map(t => ({ threadId: t.threadId, cwd: t.cwd })), conversationIds } }).catch(err => ({ ok: false, error: err.message }));
    const annotations = reply?.ok ? reply.threads || {} : {};
    const conversations = reply?.ok ? reply.conversations || {} : {};
    const linksByThread = {};
    for (const t of threads) {
      const seen = new Set(), links = [];
      for (const l of annotations[t.threadId]?.links || []) if (l.via === 'sender' && !seen.has(l.conversationId)) { seen.add(l.conversationId); links.push(l); }
      for (const id of local.get(t.threadId) || []) if (!seen.has(id)) { seen.add(id); links.push({ conversationId: id, title: conversations[id]?.title || null, via: 'local' }); }
      for (const l of annotations[t.threadId]?.links || []) if (!seen.has(l.conversationId)) { seen.add(l.conversationId); links.push(l); }
      linksByThread[t.threadId] = links;
    }
    return { annotations, linksByThread, annotateError: reply?.ok ? null : reply?.error || 'ChatVault 未运行' };
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    $refresh.disabled = true;
    say('正在读取 Codex Cloud 线程…（需要连接 Codex 服务，通常几秒）');
    try {
      const tab = await chatgptTab();
      if (!tab) throw new Error('没有打开的 ChatGPT 标签页；先打开 chatgpt.com 再刷新');
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'listCodexThreads', includeArchived: $archived.checked })
        .catch(() => { throw new Error('ChatGPT 页面没响应；请刷新那个标签页后重试'); });
      if (!reply?.ok) throw new Error(reply?.error || '读取失败');
      const threads = [...reply.threads].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      await Promise.all([loadOpens(), loadTabs()]);
      data = { threads, truncated: reply.truncated, fetchedAt: Date.now(), ...await annotate(threads) };
      try { await chrome.storage.local.set({ [CACHE_KEY]: data }); } catch { /* 缓存失败不影响显示 */ }
      paint();
      say(`${threads.length} 个线程${reply.truncated ? '（只取了最近的一部分）' : ''}${data.annotateError ? ` · 标题与来源对话不可用：${data.annotateError}` : ''}`,
        data.annotateError ? 'bad' : 'ok');
    } catch (err) {
      say(err.message, 'bad');
    } finally { busy = false; $refresh.disabled = false; }
  }

  $refresh.addEventListener('click', refresh);
  $probeAll?.addEventListener('click', () => { if (data?.threads?.length) probe(data.threads.map(t => t.threadId)); else say('先点「刷新」读取线程列表'); });
  $archived.addEventListener('change', refresh);
  $filter.addEventListener('input', paint);
  $toggle.addEventListener('click', () => { showAll = !showAll; paint(); });
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && data?.threads && Object.keys(changes).some(k => /^cvCodex(Open|Probe)V1:/.test(k))) loadOpens().then(paint);
  });
  Promise.all([loadOpens(), loadTabs()]).then(() => chrome.storage.local.get({ [CACHE_KEY]: null })).then(o => {
    data = o?.[CACHE_KEY];
    if (!data?.threads) { say('点「刷新」读取 ChatGPT 网页创建过的 Codex Cloud 线程。'); return; }
    paint();
    say(`${data.threads.length} 个线程 · 上次读取 ${fmtAge(data.fetchedAt / 1000)}，点「刷新」更新`);
  }).catch(() => {});
})();
