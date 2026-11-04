// 弹窗「Pi 会话」块：选目录 → 新建/恢复 pi 会话（Windows Terminal 新 tab）→ 生成 Chappie 连接文案 → 停止 / 历史。
// 数据与进程操作都在本机 ChatVault（/api/pi/*），这里只做界面；经 background 的 piApi 转发。
// 依赖 popup.js 的全局 targetTab()（分屏下作用于最后操作的一侧）。
(() => {
  const $card = document.getElementById('piCard');
  if (!$card) return;
  const $ = id => document.getElementById(id);
  const $broker = $('piBroker'), $workspace = $('piWorkspace'), $custom = $('piWorkspaceCustom'), $list = $('piSessionList');
  const $launch = $('piLaunch'), $status = $('piStatus'), $refresh = $('piRefresh'), $toggle = $('piToggle');
  let workspaces = [], sessions = [], brokerOnline = false, busy = false, showAll = false;
  let currentRequestIds = new Set();
  let lastMatches = [], loadRetries = 0;   // 当前标签页对话的请求 ID（来自探针），用来标出「当前」对话

  const api = (method, path, body) => chrome.runtime.sendMessage({ type: 'piApi', method, path, body });
  const say = (text, kind = '') => { if ($status) { $status.textContent = text; $status.className = `hint ${kind}`; } };
  const key = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const tail = id => { const parts = String(id || '').split('-'); return parts.length > 1 ? `…${parts[parts.length - 1]}` : String(id || ''); };
  const fmtAge = iso => {
    const ms = Date.now() - Date.parse(iso || '');
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.round(ms / 60000);
    return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.floor(m / 60)} 小时前` : `${Math.floor(m / 1440)} 天前`;
  };

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
  async function insert(text) {
    try {
      const tab = await targetTab();
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab?.url || '')) throw new Error('当前不是 ChatGPT 页面');
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'insertComposerText', text });
      if (!reply?.ok) throw new Error(reply?.error || '插入失败');
      return true;
    } catch (err) {
      const copied = await copy(text);
      say(`${err.message}；${copied ? '已改为复制到剪贴板' : '复制也失败了'}`, copied ? '' : 'bad');
      return false;
    }
  }

  function selectedCwd() {
    const custom = ($custom?.value || '').trim();
    return custom || $workspace?.value || '';
  }

  function paintWorkspaces() {
    if (!$workspace) return;
    const current = $workspace.value;
    $workspace.replaceChildren();
    for (const w of workspaces) {
      const option = document.createElement('option');
      option.value = w.path;
      const tail = [w.onlineSessions ? `${w.onlineSessions} 在线` : '', w.exists ? '' : '目录不存在', w.pinned ? '★' : ''].filter(Boolean).join(' · ');
      option.textContent = `${w.path}${tail ? `  (${tail})` : ''}`;
      option.disabled = !w.exists;
      $workspace.append(option);
    }
    if (current && workspaces.some(w => w.path === current)) $workspace.value = current;
    else chrome.storage.local.get({ piWorkspace: '' }).then(({ piWorkspace }) => {
      if (piWorkspace && workspaces.some(w => w.path === piWorkspace)) { $workspace.value = piWorkspace; paintSessions(); }
    }).catch(() => {});
  }

  function button(text, title, onClick, cls = 'pick') {
    const b = document.createElement('button');
    b.className = cls; b.textContent = text; b.title = title || '';
    b.addEventListener('click', async () => { b.disabled = true; try { await onClick(b); } finally { b.disabled = false; } });
    return b;
  }

  /** 状态 badge：执行中 / 在线 / 启动中 / 离线 */
  function statusBadge(s) {
    const [cls, text, tip] = s.running ? ['run', '执行中', '正在执行任务']
      : s.online ? ['on', '在线', '已连上 Chappie']
        : s.pid ? ['wait', '启动中', '进程已在，尚未连上 Chappie']
          : ['off', '离线', s.lastLaunchAt ? `上次启动 ${fmtAge(s.lastLaunchAt)}` : '未运行'];
    const b = document.createElement('span'); b.className = `pi-badge ${cls}`; b.textContent = text; b.title = tip;
    return b;
  }
  function chip(text, title, cls = '') {
    const c = document.createElement('span'); c.className = `pi-chip ${cls}`.trim(); c.textContent = text; if (title) c.title = title;
    return c;
  }
  /** 会话头：状态 badge · 名字 · UUID 末段 · 对话数；第二行目录（需要时）与离线时长 */
  function sessionHead(s, { showDir = false, linked = false, usedHere = false } = {}) {
    const wrap = document.createElement('div'); wrap.className = 'pi-headwrap';
    const head = document.createElement('div'); head.className = 'pi-head';
    const name = document.createElement('b'); name.textContent = (s.cwd || '').split(/[\\/]+/).filter(Boolean).pop() || s.name || s.id;
    name.title = `${s.name || ''}
${s.id}
${s.cwd || ''}${s.startedAt ? `
启动于 ${new Date(s.startedAt).toLocaleString('zh-CN')}` : ''}`;
    // UUID 末段（12 位）单独给出来，方便和 pi 里 /session、ChatGPT 对话里的 id 对照
    const code = document.createElement('code'); code.className = 'pi-code'; code.textContent = tail(s.id); code.title = `${s.id}（点击复制）`;
    code.addEventListener('click', async () => say(await copy(s.id) ? `已复制会话 ID ${s.id}` : '复制失败', 'ok'));
    head.append(statusBadge(s), name, code);
    if (linked) head.append(chip('当前对话', '这个对话里出现过此会话 ID', 'linked'));
    if (s.bindingCount) head.append(chip(`${s.bindingCount} 个对话`, '已绑定到这个 pi 会话的 ChatGPT 对话数（Chappie 记录）'));
    // 30 分钟内还有别的对话在驱动这个会话：提醒可能互相踩改动
    // 只对「当前对话正在用的会话」提醒；与当前对话无关的会话被谁驱动不算冲突
    const inUse = usedHere || linked || linkedIds.has(s.id) || (s.drivers || []).some(d => currentRequestIds.has(d.requestId));
    const othersActive = (s.drivers || []).filter(d => !currentRequestIds.has(d.requestId) && Date.now() - Date.parse(d.last || '') < 30 * 60e3);
    if (inUse && othersActive.length && currentRequestIds.size) head.append(chip(`另有 ${othersActive.length} 个对话活跃`, '30 分钟内还有其他 ChatGPT 对话在操作这个 Pi 会话，注意互相覆盖改动', 'warn'));
    wrap.append(head);
    const sub = [showDir && s.cwd ? s.cwd : '', s.lastActivityAt ? `最近活动 ${hhmm(s.lastActivityAt)}（${fmtAge(s.lastActivityAt)}）` : '',
      !s.online && !s.pid && s.lastLaunchAt && !s.lastActivityAt ? `上次启动 ${fmtAge(s.lastLaunchAt)}` : '',
      s.chatvault?.messageCount ? `已归档 ${s.chatvault.messageCount} 条` : ''].filter(Boolean).join(' · ');
    if (sub) { const line = document.createElement('div'); line.className = 'pi-sub hint'; line.textContent = sub; line.title = s.cwd || ''; wrap.append(line); }
    const drivers = driversBlock(s);
    if (drivers) wrap.append(drivers);
    return wrap;
  }

  /** 最近驱动这个 pi 会话的 ChatGPT 对话（最多 3 个；一个会话可同时被多个对话驱动） */
  function driversBlock(s) {
    const list = (s.drivers || []).slice(0, 3);
    if (!list.length) return null;
    const box = document.createElement('div'); box.className = 'pi-drivers';
    for (const d of list) {
      const row = document.createElement(d.conversation?.conversationId ? 'a' : 'div');
      row.className = `pi-driver${currentRequestIds.has(d.requestId) ? ' current' : ''}`;
      if (d.conversation?.conversationId) {
        row.href = `https://chatgpt.com/c/${d.conversation.conversationId}`;
        row.addEventListener('click', ev => { ev.preventDefault(); chrome.tabs.create({ url: row.href }); });
      }
      const name = document.createElement('span'); name.className = 'pi-driver-name';
      name.textContent = d.conversation?.title || `ChatGPT …${d.chatTail || '????'}（未归档）`;
      const meta = document.createElement('span'); meta.className = 'pi-driver-meta';
      meta.textContent = `${currentRequestIds.has(d.requestId) ? '当前 · ' : ''}${hhmm(d.last)} · ${d.calls} 次${d.filesCount ? ` · 改 ${d.filesCount} 个文件` : ''}`;
      row.title = [d.conversation?.title || '', `${d.requestId}（ChatGPT …${d.chatTail}）`, `${hhmm(d.first)}–${hhmm(d.last)}，${fmtAge(d.last)}`,
        d.conversation ? '点击打开这个对话' : '这个对话还没同步到 ChatVault，打开它一次就能显示标题'].filter(Boolean).join('\n');
      row.append(name, meta);
      box.append(row);
    }
    if ((s.driverCount || 0) > list.length) { const more = document.createElement('div'); more.className = 'hint'; more.textContent = `…另有 ${s.driverCount - list.length} 次更早的驱动`; box.append(more); }
    return box;
  }

  function paintSessions() {
    if (!$list) return;
    const cwd = key(selectedCwd());
    const rows = sessions.filter(s => showAll || !cwd || key(s.cwd) === cwd);
    const hiddenOnline = sessions.filter(s => !rows.includes(s) && s.online).length;
    $list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div'); empty.className = 'hint';
      empty.textContent = cwd ? '这个目录还没有 pi 会话。' : '选一个目录，或输入路径。';
      $list.append(empty);
    }
    for (const s of rows) {
      const row = document.createElement('div'); row.className = `pi-row ${s.online ? 'on' : 'off'}${linkedIds.has(s.id) ? ' linked' : ''}`;
      row.append(sessionHead(s, { showDir: showAll, linked: linkedIds.has(s.id) }));
      const actions = document.createElement('div'); actions.className = 'pi-actions';
      if (s.connectText) {
        const insertButton = button('插入文案', s.online ? '把「请用 Chappie 连接…」插进当前 ChatGPT 输入框' : '会话未在线，恢复并连上 Chappie 后可插入文案', async () => { if (await insert(s.connectText)) say('已插入连接文案。', 'ok'); });
        insertButton.disabled = !s.online;
        actions.append(insertButton);
        actions.append(button('复制', s.connectText, async () => say(await copy(s.connectText) ? '已复制连接文案。' : '复制失败', 'ok')));
      }
      if (s.chatvault?.sessionId) {
        actions.append(button('历史', `ChatVault 会话 #${s.chatvault.sessionId} · ${s.chatvault.messageCount ?? '?'} 条`, async () => {
          const { port } = await chrome.storage.local.get({ port: 8377 });
          chrome.tabs.create({ url: `http://127.0.0.1:${port}/#/session/${s.chatvault.sessionId}` });
        }));
      }
      if (s.pid) {
        actions.append(button('停止', '结束这个 tab 的进程树（历史不丢；ChatGPT 侧绑定保留，恢复后续上）', async b => {
          if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = '确认停止'; setTimeout(() => { b.dataset.armed = ''; b.textContent = '停止'; }, 4000); return; }
          const r = await api('POST', `/api/pi/sessions/${s.id}/stop`);
          say(r.ok ? `已停止 ${s.name}` : r.error, r.ok ? 'ok' : 'bad');
          setTimeout(load, 1200);
        }));
      } else if (s.online) {
        const note = document.createElement('span'); note.className = 'hint';
        note.textContent = '终端手动启动 · 在它的终端里退出';
        note.title = '没有带 --session-id 的进程找不到对应 tab；用扩展新建的会话才能在这里停止';
        actions.append(note);
      } else if (s.managed && s.cwd) {
        actions.append(button('恢复', '用同一个会话 ID 再起一次：历史续上，连接文案不变', async () => {
          const r = await api('POST', '/api/pi/sessions', { cwd: s.cwd, id: s.id, name: s.name });
          say(r.ok ? `已恢复 ${r.name}${r.pid ? '' : '（进程尚未出现，稍后刷新）'}` : r.error, r.ok ? 'ok' : 'bad');
          setTimeout(load, 1500);
        }));
      }
      row.append(actions);
      $list.append(row);
    }
    if ($toggle) {
      $toggle.hidden = !hiddenOnline && !showAll && sessions.length <= rows.length;
      $toggle.textContent = showAll ? '只看当前目录' : `显示全部${hiddenOnline ? `（其他目录在线 ${hiddenOnline}）` : ''}`;
    }
    if ($launch) $launch.disabled = busy || !brokerOnline || !selectedCwd();
  }

  async function load() {
    if (busy) return;
    busy = true;
    if ($broker) { $broker.textContent = '正在读取 Pi 会话…'; $broker.className = 'hint'; }
    try {
      const [ws, ss] = await Promise.all([api('GET', '/api/pi/workspaces'), api('GET', '/api/pi/sessions')]);
      if (!ws?.ok && ws?.error) { say(ws.error, 'bad'); $card.classList.add('unavailable'); return; }
      $card.classList.remove('unavailable');
      workspaces = ws.workspaces || [];
      sessions = ss?.sessions || [];
      brokerOnline = !!ss?.broker?.online;
      if ($broker) {
        $broker.textContent = brokerOnline ? `Chappie 在线 · ${sessions.filter(s => s.online).length} 个 pi 会话`
          : ss?.broker?.present ? 'Chappie broker 不在线（隧道未运行），不能新建会话' : 'Chappie 未提供在线表（fork 需 0.5.1-patch.3）；只能按进程判断';
        $broker.className = `hint ${brokerOnline ? 'ok' : 'warn'}`;
      }
      paintWorkspaces();
      paintSessions();
      if (lastMatches.length) paintLinked(lastMatches);   // 驱动者数据随会话列表才到
      // 大会话首次建索引时列表先回，驱动者稍后补齐
      if (ss?.indexing && loadRetries++ < 6) setTimeout(load, 3000);
    } finally { busy = false; if ($launch) $launch.disabled = !brokerOnline || !selectedCwd(); }
  }

  // 当前对话已连接的 pi 会话：对话里出现过的 UUID（连接文案、Chappie 工具参数）交给 ChatVault 匹配；显示在「当前对话」卡片里，
  // 并把目录选中、在列表里标出来。
  const $linked = $('piLinked');
  let linkedIds = new Set();
  let activityBySession = new Map(), activityIndexing = false;
  const TOOL_ORDER = ['bash', 'edit', 'write', 'read'];
  const hhmm = iso => { const d = new Date(iso || ''); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''; };
  /** 「这个对话在 Pi 里做了什么」：来自 pi jsonl 里同一 request_id 的 Chappie 记录（ChatGPT 自己的说法可能不准） */
  function activityLine(acts) {
    const line = document.createElement('div'); line.className = 'pi-activity';
    if (!acts?.length) {
      if (!activityIndexing) return null;
      line.className += ' hint'; line.textContent = '正在统计 Pi 侧记录…';
      return line;
    }
    const calls = acts.reduce((n, a) => n + a.calls, 0);
    const byTool = {}; for (const a of acts) for (const [k, v] of Object.entries(a.byTool || {})) byTool[k] = (byTool[k] || 0) + v;
    const files = [...new Set(acts.flatMap(a => a.files || []))];
    const filesCount = Math.max(files.length, acts.reduce((n, a) => n + (a.filesCount || 0), 0));
    const first = acts.map(a => a.first).filter(Boolean).sort()[0], last = acts.map(a => a.last).filter(Boolean).sort().at(-1);
    const tools = Object.entries(byTool).sort((a, b) => (TOOL_ORDER.indexOf(a[0]) + 1 || 99) - (TOOL_ORDER.indexOf(b[0]) + 1 || 99) || b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`).join(' · ');
    const label = document.createElement('span'); label.className = 'pi-activity-label'; label.textContent = 'Pi 侧记录';
    const body = document.createElement('span');
    body.textContent = `${calls} 次工具调用${filesCount ? ` · 改了 ${filesCount} 个文件` : ''}${first ? ` · ${hhmm(first)}–${hhmm(last)}` : ''}${last ? `（${fmtAge(last)}）` : ''}`;
    line.append(label, body);
    line.title = [`工具：${tools || '无'}`, files.length ? `文件：\n${files.slice(0, 30).join('\n')}${filesCount > 30 ? `\n…共 ${filesCount} 个` : ''}` : '',
      `请求 ${acts.map(a => `${a.requestId}（ChatGPT …${a.chatTail}）`).join('、')}`].filter(Boolean).join('\n');
    return line;
  }
  function paintLinked(matches) {
    lastMatches = matches;
    linkedIds = new Set(matches.map(m => m.id));
    if (!$linked) return;
    $linked.replaceChildren();
    if (!matches.length) return;
    const title = document.createElement('div'); title.className = 'pi-linked-title'; title.textContent = matches.length > 1 ? `已连接 Pi（${matches.length}）` : '已连接 Pi';
    $linked.append(title);
    for (const found of matches) {
      // match 接口不带驱动者统计：用会话列表里同一会话的那份补上（列表晚到时 load() 末尾会重画）
      const full = sessions.find(x => x.id === found.id);
      const m = full ? { ...found, drivers: full.drivers, driverCount: full.driverCount, lastActivityAt: full.lastActivityAt } : found;
      const row = document.createElement('div'); row.className = 'pi-linked-row';
      row.append(sessionHead(m, { showDir: true, usedHere: true }));
      const act = activityLine(activityBySession.get(m.id));
      if (act) row.append(act);
      const actions = document.createElement('div'); actions.className = 'pi-actions';
      row.append(actions);
      if (m.chatvault?.sessionId) actions.append(button('历史', `ChatVault 会话 #${m.chatvault.sessionId}`, async () => {
        const { port } = await chrome.storage.local.get({ port: 8377 });
        chrome.tabs.create({ url: `http://127.0.0.1:${port}/#/session/${m.chatvault.sessionId}` });
      }));
      if (!m.online && m.managed && m.cwd) actions.append(button('恢复', '同一会话 ID 再起一次', async () => {
        const r = await api('POST', '/api/pi/sessions', { cwd: m.cwd, id: m.id, name: m.name });
        say(r.ok ? `已恢复 ${r.name}` : r.error, r.ok ? 'ok' : 'bad');
        setTimeout(load, 1500);
      }));
      $linked.append(row);
    }
    const first = matches.find(m => m.cwd);
    if (first && $workspace && !($custom?.value || '').trim() && workspaces.some(w => key(w.path) === key(first.cwd))) {
      $workspace.value = workspaces.find(w => key(w.path) === key(first.cwd)).path;
    }
    paintSessions();
  }
  let probeSeq = 0;
  async function onProbe(detail, attempt = 0) {
    const reply = detail?.reply;
    const ids = Array.isArray(reply?.pi_candidates) ? reply.pi_candidates : [];
    const reqs = Array.isArray(reply?.request_ids) ? reply.request_ids : [];
    currentRequestIds = new Set(reqs.map(r => String(r).toLowerCase()));
    const seq = attempt ? probeSeq : ++probeSeq;
    if (!ids.length && !reqs.length) {
      paintLinked([]);
      // 对话快照还没取到（Codex 页刚重新注入时常见：连接 codex-cloud-backend 可能要几十秒）：说明原因，别让人以为没关联。
      const page = /^https:\/\/chatgpt\.com\/(?:c|local)\//i.test(detail?.tab?.url || '');
      if ($linked && page && reply && reply.conversation_mode?.mode === 'unknown') {
        $linked.textContent = reply.page_runtime?.last_error?.stage === 'sync'
          ? `对话数据未就绪：${reply.page_runtime.last_error.message}；稍后点「刷新」再看关联` : '对话数据还在读取，稍后点「刷新」再看关联';
      }
      return;
    }
    if ($linked && !attempt) $linked.textContent = `正在核对已连接的 Pi 会话…（对话里出现 ${ids.length} 个 id）`;
    const [r, a] = await Promise.all([
      ids.length ? api('POST', '/api/pi/match', { ids }) : Promise.resolve({ ok: true, matches: [] }),
      reqs.length ? api('POST', '/api/pi/activity', { requestIds: reqs, sessionIds: ids }) : Promise.resolve({ ok: true, activity: [], sessions: [] }),
    ]);
    if (seq !== probeSeq) return;   // 期间换了标签页/刷新过
    const matches = [...(r?.ok ? r.matches || [] : [])];
    // 没写会话 ID、按名字连上的会话：从 Pi 侧记录反查出来
    for (const s of (a?.ok ? a.sessions || [] : [])) if (!matches.some(m => m.id === s.id)) matches.push(s);
    activityBySession = new Map();
    for (const x of (a?.ok ? a.activity || [] : [])) { const list = activityBySession.get(x.sessionId) || []; list.push(x); activityBySession.set(x.sessionId, list); }
    activityIndexing = !!a?.indexing;
    paintLinked(matches);
    if ($linked && r?.ok && !matches.length) $linked.textContent = activityIndexing ? '正在统计 Pi 侧记录…' : '此对话里没有出现已知的 Pi 会话 id';
    else if ($linked && !r?.ok) $linked.textContent = `核对 Pi 会话失败：${r?.error || '未知错误'}`;
    // 大会话首次建索引要几秒：后台建着，隔一会儿再取一次
    if (activityIndexing && attempt < 8) setTimeout(() => { if (seq === probeSeq) void onProbe(detail, attempt + 1); }, 3000);
  }
  document.addEventListener('cv-probe', event => { void onProbe(event.detail); });
  if (globalThis.__cvLastProbe) void onProbe(globalThis.__cvLastProbe);

  $workspace?.addEventListener('change', () => { if ($custom) $custom.value = ''; chrome.storage.local.set({ piWorkspace: $workspace.value }).catch(() => {}); paintSessions(); });
  $custom?.addEventListener('input', paintSessions);
  $toggle?.addEventListener('click', () => { showAll = !showAll; paintSessions(); });
  $refresh?.addEventListener('click', load);
  $launch?.addEventListener('click', async () => {
    const cwd = selectedCwd();
    if (!cwd) return say('先选一个目录。', 'bad');
    $launch.disabled = true;
    say('正在起 pi 会话…');
    try {
      const r = await api('POST', '/api/pi/sessions', { cwd });
      if (!r.ok) return say(r.error || '启动失败', 'bad');
      const copied = await copy(r.connectText);
      say(`已启动 ${r.name}${r.pid ? '' : '（进程尚未出现，稍后刷新）'}；连接文案${copied ? '已复制' : '见列表'}。`, 'ok');
      if ($custom?.value) { chrome.storage.local.set({ piWorkspace: cwd }).catch(() => {}); }
      setTimeout(load, 1500);
    } finally { $launch.disabled = false; }
  });

  void load();
})();
