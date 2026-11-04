const $auto = document.getElementById('auto');
const $injectionEnabled = document.getElementById('injectionEnabled');
const $syncEnabled = document.getElementById('syncEnabled');
const $diagnostics = document.getElementById('diagnostics');
const $durations = document.getElementById('durations');
const $speedMetrics = document.getElementById('speedMetrics');
const $dotsTitle = document.getElementById('dotsTitle');
const $stalledTurn = document.getElementById('stalledTurn');
const $notify = document.getElementById('notify');
const $notifyMinSec = document.getElementById('notifyMinSec');
const $recoveryReadMinMin = document.getElementById('recoveryReadMinMin');
const $dotsQuietSec = document.getElementById('dotsQuietSec');
const $port = document.getElementById('port');
const $sync = document.getElementById('sync');
const $status = document.getElementById('status');
const $codexThread = document.getElementById('codexThread');
const $codexThreadDeep = document.getElementById('codexThreadDeep');
const $convMode = document.getElementById('convMode');
const $codexThreadDiagnostics = document.getElementById('codexThreadDiagnostics');
// 页面各模块的版本都取自扩展清单（page-state.js），与弹窗所在扩展同源。
const codexLookupVersion = () => chrome.runtime.getManifest().version;
const $codexThreadStatus = document.getElementById('codexThreadStatus');
const $codexThreadCandidates = document.getElementById('codexThreadCandidates');
let codexBusy = false;
let codexCanContinue = false;
// 深度（全量历史）查找只作兜底：Work 对话普通查找未命中或暂停时才提供；Chat 模式没有 Codex 线程可找。
let codexDeepOffered = false;
// 当前页对话类型（来自页面诊断快照，不额外请求）：Chat 模式没有 Codex 会话，不提供查找入口。
let pageMode = 'unknown';

const $splitTarget = document.getElementById('splitTarget');
const $codexUsage = document.getElementById('codexUsage');
const $codexRelookup = document.getElementById('codexRelookup');
// 已记录的「对话 → Codex 根线程」：有就直接打开，不再查找（查找核验成功或推送中断核对时写入）。
let linkedThreadId = null;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 弹窗作用的标签页。Chrome 分屏（splitViewId）下 active 不一定是用户正在操作的那一侧：
 * 询问两侧页面最后一次点击/按键/聚焦的时刻取最近者，并在顶部提供手动切换。
 */
let chosenTabId = null, splitTabs = [];
async function probeInteraction(tab) {
  let timer;
  try {
    const reply = await Promise.race([chrome.tabs.sendMessage(tab.id, { type: 'diagnosticProbe' }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1200); })]);
    return Number.isFinite(reply?.last_interaction_at) ? reply.last_interaction_at : 0;
  } catch { return 0; } finally { clearTimeout(timer); }
}
async function targetTab() {
  if (chosenTabId != null) {
    try { return await chrome.tabs.get(chosenTabId); } catch { chosenTabId = null; }
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const none = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1;
  if (!active || active.splitViewId == null || active.splitViewId === none) { splitTabs = []; paintSplit(); return active; }
  splitTabs = (await chrome.tabs.query({ currentWindow: true })).filter(tab => tab.splitViewId === active.splitViewId)
    .sort((a, b) => a.index - b.index);
  if (splitTabs.length < 2) { splitTabs = []; paintSplit(); return active; }
  const scores = await Promise.all(splitTabs.map(async tab => ({ tab, at: await probeInteraction(tab) })));
  const best = scores.reduce((a, b) => (b.at > a.at || (b.at === a.at && (b.tab.lastAccessed || 0) > (a.tab.lastAccessed || 0))) ? b : a);
  chosenTabId = best.tab.id;
  paintSplit();
  return best.tab;
}
function paintSplit() {
  if (!$splitTarget) return;
  $splitTarget.hidden = splitTabs.length < 2;
  if ($splitTarget.hidden) return;
  $splitTarget.replaceChildren();
  splitTabs.forEach((tab, i) => {
    const button = document.createElement('button');
    button.className = tab.id === chosenTabId ? 'pick on' : 'pick';
    button.textContent = `${i ? '右' : '左'}：${(tab.title || tab.url || '').slice(0, 18)}`;
    button.title = tab.url || '';
    button.addEventListener('click', () => {
      chosenTabId = tab.id;
      paintSplit();
      $codexThreadCandidates.replaceChildren();
      $codexThreadStatus.textContent = ''; $codexThreadDiagnostics.textContent = '';
      codexDeepOffered = false; codexCanContinue = false; linkedThreadId = null;
      void checkPageHealth();
    });
    $splitTarget.append(button);
  });
}

/** Chappie 隧道状态（判断逻辑在 tunnel-status.js，与后台角标共用），与当前标签页无关。 */
const $tunnel = document.getElementById('tunnel');
const $tunnelPort = document.getElementById('tunnelPort');
async function paintTunnel() {
  if (!$tunnel || !globalThis.__cvTunnel) return;
  const { tunnelPort } = await chrome.storage.local.get({ tunnelPort: 8080 }).catch(() => ({ tunnelPort: 8080 }));
  const state = await globalThis.__cvTunnel.check({ port: tunnelPort, fetchImpl: globalThis.fetch });
  $tunnel.hidden = state.code === 'off';
  if ($tunnel.hidden) return;
  $tunnel.className = `hint ${state.kind}`;
  $tunnel.textContent = state.text;
  $tunnel.title = state.title;
  // 打开弹窗时顺便让后台按最新结果刷新角标，不必等下一次定时检查。
  try { void chrome.runtime.sendMessage({ type: 'tunnelStatus', state }).catch(() => {}); } catch { /* 后台不在也不影响显示 */ }
}

const fmtTokens = n => !Number.isFinite(n) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
/** 已记录的 Codex 线程用量（只读扩展本地，不发请求）。Chat 页面按已知关联找到线程。 */
async function storedLink(conv) {
  if (!conv || conv.startsWith('dots-')) return null;
  const keys = [`cvCodexLinkV1:${conv}`, `cvWorkRoundV1:${conv}`];
  const stored = await chrome.storage.local.get(keys).catch(() => ({}));
  return [stored?.[keys[0]]?.threadId, stored?.[keys[1]]?.threadId].find(id => THREAD_ID.test(id || ''))?.toLowerCase() || null;
}
async function paintUsage(tab) {
  if (!$codexUsage) return;
  $codexUsage.textContent = '';
  const local = /^https:\/\/chatgpt\.com\/local\/([0-9a-f-]{36})/i.exec(tab?.url || '')?.[1]?.toLowerCase();
  linkedThreadId = local ? null : await storedLink(tabConversation(tab));
  applyControls();
  const threadId = local || linkedThreadId;
  if (!threadId) return;
  const key = `cvCodexUsageV1:${threadId}`;
  const usage = (await chrome.storage.local.get(key).catch(() => ({})))?.[key];
  const total = usage?.total;
  if (!total) {
    if (local) $codexUsage.textContent = '尚未收到 Codex 用量推送：页面打开线程或执行一轮后才会出现。';
    return;
  }
  const contextWindow = usage.modelContextWindow, last = usage.last?.totalTokens;
  const context = Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(last) ? ` · 最近一次请求占上下文 ${Math.round(last * 100 / contextWindow)}%` : "";
  const when = usage.updatedAt ? new Date(usage.updatedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  $codexUsage.textContent = `Codex 用量${local ? '' : '（关联线程）'}：输入 ${fmtTokens(total.inputTokens)}（缓存 ${fmtTokens(total.cachedInputTokens)}）`
    + ` · 输出 ${fmtTokens(total.outputTokens)}（推理 ${fmtTokens(total.reasoningOutputTokens)}）${context}${when ? ` · 截至 ${when}` : ''}`;
  $codexUsage.title = `线程 ${threadId}；累计值来自 Codex 推送的 thread/tokenUsage/updated，只在页面开着时记录。`;
}

function tabConversation(tab) {
  const match = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(c|dots)\/([0-9a-f-]{36})(?:[/?#]|$)/i.exec(tab?.url || '');
  return match ? (match[1] === 'dots' ? 'dots-' : '') + match[2] : null;
}
async function openCodexCandidate(tabId, conversationId, candidate) {
  if (tabConversation(await chrome.tabs.get(tabId)) !== conversationId)
    throw new Error('当前对话已变化，请重新打开扩展后重试');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate?.threadId || ''))
    throw new Error('返回的 Codex thread ID 无效');
  await chrome.tabs.create({ url: `https://chatgpt.com/local/${candidate.threadId}?hostId=local` });
}
function codexBasis(candidate) {
  const labels = { 'user-message-id': '用户消息 ID 一致', 'work-activity-turn': '工作活动 turn ID 一致',
    'collab-sender': '协作发送者核验', subagent: '子线程父链核验', dots: 'Dots thread ID',
    'first-user-message': '仅首条文本相同（候选）', workspace: '仅工作目录相同（候选）' };
  return labels[candidate.matchedBy] || '未标明关联依据';
}
function paintCodexDiagnostics(diagnostics) {
  if (!diagnostics) { $codexThreadDiagnostics.textContent = ''; return; }
  const scope = diagnostics.scope === 'association' ? '后台标识关联诊断（未扫描全量历史）' : diagnostics.scope === 'metadata' ? '当前分支元数据' : diagnostics.scope === 'history'
    ? '根线程历史' : '根线程开头（未穷尽后续历史）';
  const parts = [scope];
  if (Number.isInteger(diagnostics.sonicCount)) parts.push(`发现 ${diagnostics.sonicCount} 个后台标识${Number.isInteger(diagnostics.sampleCount) ? `，本次核验 ${diagnostics.sampleCount} 个` : ''}`);
  for (const probe of diagnostics.probes || [])
    if (probe.state === 'route-unsupported') parts.push(probe.reason || '当前入口不支持该 placement');
  if (Number.isInteger(diagnostics.rootsListed)) {
    parts.push(`已完成 ${diagnostics.rootsCompleted ?? '—'}/${diagnostics.rootsListed} 个根线程`);
    parts.push(`已开始 ${diagnostics.rootsChecked ?? 0} 个，剩余 ${diagnostics.rootsPending ?? '—'} 个`);
  }
  if (Number.isInteger(diagnostics.itemPages)) parts.push(`本批 ${diagnostics.itemPages} 页 items`);
  if (Number.isInteger(diagnostics.totalItemPages)) parts.push(`累计 ${diagnostics.totalItemPages} 页`);
  if (diagnostics.resumed) parts.push('已从上次断点继续');
  if (diagnostics.failures?.length) parts.push(`${diagnostics.failures.length} 项读取失败：${diagnostics.failures[0].message || diagnostics.failures[0].code || '未知原因'}`);
  if (diagnostics.limitedRoots) parts.push(`${diagnostics.limitedRoots} 个线程达到本批页数上限`);
  if (diagnostics.paused) parts.push('本批暂停，未读页进度已保留');
  else if (diagnostics.partial) parts.push('查找未完成，不能据此排除其他线程');
  $codexThreadDiagnostics.textContent = parts.join(' · ');
}
async function lookupCodexThread(deepScan = false) {
  if (codexBusy || !$injectionEnabled.checked) return;
  codexBusy = true;
  applyControls();
  $codexThreadCandidates.replaceChildren();
  paintCodexDiagnostics(null);
  $codexThreadStatus.textContent = deepScan ? '正在只读检查云端根线程历史…' : '正在查找对应的 Codex thread…';
  try {
    const tab = await targetTab();
    const conversationId = tabConversation(tab);
    if (!conversationId) throw new Error('请在 ChatGPT 对话或 Dots 页面使用此功能');
    let result;
    try { result = await chrome.tabs.sendMessage(tab.id, { type: 'resolveCodexThread', conversationId, deepScan }); }
    catch { throw new Error('请重载扩展并刷新当前 ChatGPT 页面后重试'); }
    if (!result || result.lookupVersion !== codexLookupVersion())
      throw new Error('当前页面的 Codex 查找模块尚未更新；请重载扩展并刷新此页面后重试');
    codexCanContinue = result.canContinue === true || result.diagnostics?.canContinue === true;
    codexDeepOffered = result.ok === true && ['no-match', 'paused'].includes(result.status);
    paintCodexDiagnostics(result.diagnostics);
    if (!result.ok) throw new Error(result.error || '查找 Codex thread 失败');
    if (result.conversationId !== conversationId || !Array.isArray(result.candidates))
      throw new Error('未取得当前对话对应的 Codex thread');
    if (['paused', 'no-match', 'chat-mode', 'mapping-unavailable', 'route-unsupported', 'read-error'].includes(result.status) && !result.candidates.length) {
      $codexThreadStatus.textContent = result.message || '本次未取得可验证的关联。';
      if (result.journalSaved === false) $codexThreadStatus.textContent += '（诊断持久化失败）';
      return;
    }
    if (!result.candidates.length) throw new Error('未取得当前对话对应的 Codex thread');
    if (result.candidates.some(candidate => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate?.threadId || '')))
      throw new Error('返回的 Codex thread ID 无效');
    if (!deepScan && result.candidates.length === 1 && result.requiresConfirmation === false
      && result.candidates[0].confidence === 'verified' && !result.diagnostics?.partial) {
      await openCodexCandidate(tab.id, conversationId, result.candidates[0]);
      $codexThreadStatus.textContent = `已打开 ${result.candidates[0].threadId} · ${codexBasis(result.candidates[0])}`;
      linkedThreadId = result.candidates[0].threadId.toLowerCase();   // 页面已记下关联，下次直接打开
    } else {
      $codexThreadStatus.textContent = result.candidates.some(candidate => candidate.confidence !== 'verified')
        ? '以下仅为候选，未证明属于此对话；请核对后选择：'
        : result.diagnostics?.partial ? '已找到以下关联，但查找未完成；请选择要打开的记录：'
          : '已找到当前分支的关联记录（可能包含共享祖先）；请选择要打开的 thread：';
      for (const candidate of result.candidates) {
        const button = document.createElement('button');
        button.style.marginTop = '6px';
        const created = candidate.createdAt ? new Date(candidate.createdAt * 1000).toLocaleString('zh-CN') : '';
        button.textContent = [codexBasis(candidate), candidate.name || candidate.model, created, candidate.threadId].filter(Boolean).join(' · ');
        button.title = [candidate.matchedUserMessageId && `message.id = ${candidate.matchedUserMessageId}`,
          candidate.matchedTurnId && `turnId = ${candidate.matchedTurnId}`].filter(Boolean).join('\n');
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await openCodexCandidate(tab.id, conversationId, candidate);
            $codexThreadStatus.textContent = `已打开 ${candidate.threadId} · ${codexBasis(candidate)}`;
          } catch (error) { $codexThreadStatus.textContent = error.message; }
          finally { button.disabled = false; }
        });
        $codexThreadCandidates.append(button);
      }
    }
  } catch (error) { $codexThreadStatus.textContent = error.message; }
  finally { codexBusy = false; applyControls(); }
}
async function openLinkedThread() {
  if (codexBusy) return;
  codexBusy = true;
  applyControls();
  try {
    const tab = await targetTab();
    const conversationId = tabConversation(tab);
    if (!conversationId) throw new Error('请在 ChatGPT 对话页面使用此功能');
    const threadId = await storedLink(conversationId);
    if (!threadId) { linkedThreadId = null; codexBusy = false; return lookupCodexThread(false); }
    await openCodexCandidate(tab.id, conversationId, { threadId });
    $codexThreadStatus.textContent = `已打开已关联的 ${threadId}`;
  } catch (error) { $codexThreadStatus.textContent = error.message; }
  finally { codexBusy = false; applyControls(); }
}
$codexThread.addEventListener('click', () => linkedThreadId ? openLinkedThread() : lookupCodexThread(false));
$codexRelookup?.addEventListener('click', () => lookupCodexThread(false));
$codexThreadDeep.addEventListener('click', () => lookupCodexThread(true));
function show(text, kind = '') {
  $status.textContent = text;
  $status.className = kind;
}

function applyControls() {
  const canSync = $injectionEnabled.checked && $syncEnabled.checked;
  $auto.disabled = !canSync;
  $sync.disabled = !canSync;
  $codexThread.disabled = codexBusy || !$injectionEnabled.checked;
  $codexThread.hidden = pageMode === 'chat' || pageMode === 'codexPage';
  $codexThread.textContent = linkedThreadId ? '打开 Codex 会话 · 已关联' : '打开对应 Codex 会话';
  $codexThread.title = linkedThreadId ? `直接打开已记录的根线程 ${linkedThreadId}，不再查找` : '只读查找当前对话对应的 Codex 根线程并打开';
  if ($codexRelookup) {
    $codexRelookup.hidden = !linkedThreadId || $codexThread.hidden;
    $codexRelookup.disabled = codexBusy || !$injectionEnabled.checked;
  }
  $sync.hidden = pageMode === 'codexPage';
  $codexThreadDeep.disabled = codexBusy || !$injectionEnabled.checked;
  $codexThreadDeep.hidden = !codexDeepOffered && !codexCanContinue;
  $codexThreadDeep.textContent = codexCanContinue ? '继续查找（从上次断点）' : '深度查找关联 thread';
}

async function load() {
  const { auto, injectionEnabled, syncEnabled, diagnostics, durations, speedMetrics, dotsTitle, stalledTurn, notify, notifyMinSec, dotsQuietSec, recoveryReadMinMin, port, tunnelPort, last } = await chrome.storage.local.get(
    { auto: true, injectionEnabled: true, syncEnabled: true, diagnostics: false,
      durations: true, speedMetrics: true, dotsTitle: true, stalledTurn: true, notify: true, notifyMinSec: 30, dotsQuietSec: 180, recoveryReadMinMin: 5, port: 8377, tunnelPort: 8080, last: null });
  $injectionEnabled.checked = injectionEnabled;
  $syncEnabled.checked = syncEnabled;
  $auto.checked = auto;
  $diagnostics.checked = diagnostics;
  $durations.checked = durations;
  $speedMetrics.checked = speedMetrics;
  $dotsTitle.checked = dotsTitle;
  $stalledTurn.checked = stalledTurn;
  $notify.checked = notify;
  $notifyMinSec.value = notifyMinSec;
  if ($dotsQuietSec) $dotsQuietSec.value = dotsQuietSec;
  if ($recoveryReadMinMin) $recoveryReadMinMin.value = recoveryReadMinMin;
  $port.value = port;
  if ($tunnelPort) $tunnelPort.value = tunnelPort;
  applyControls();
  if (!injectionEnabled) {
    show('页面注入已关闭；刷新 ChatGPT 页后不会再运行内容脚本。');
  } else if (!syncEnabled) {
    show('同步到 ChatVault 已暂停，页面耗时显示仍可使用。');
  } else {
    globalLast = last;
    show('…');   // 当前标签页确定后（checkPageHealth）显示该对话自己的同步结果
  }
}

/** 底部只显示当前标签页所在对话的最后同步；不是对话页时才显示全局最近一次并注明。 */
let globalLast = null;
async function paintLastSync(tab) {
  if (!$injectionEnabled.checked || !$syncEnabled.checked) return;
  const line = (rec, prefix = '') => {
    const when = new Date(rec.at).toLocaleTimeString('zh-CN', { hour12: false });
    show(`${prefix}${when} ${rec.ok ? '已同步' : '失败'}：${rec.summary}`, rec.ok ? 'ok' : 'bad');
  };
  const conv = tabConversation(tab);
  if (conv) {
    const key = `cvLastSyncV1:${conv}`;
    const rec = (await chrome.storage.local.get(key).catch(() => ({})))?.[key];
    if (rec) return line(rec);
    if (globalLast?.conversationId === conv) return line(globalLast);
    return show('此对话尚未同步到 ChatVault。');
  }
  if (globalLast) return line(globalLast, '最近一次（其他对话）：');
  show('还没同步过。打开一个对话即可。');
}

const $refresh = document.getElementById('refresh');
$refresh?.addEventListener('click', async () => {
  $refresh.disabled = true;
  chosenTabId = null; splitTabs = [];
  $codexThreadCandidates.replaceChildren();
  $codexThreadStatus.textContent = ''; $codexThreadDiagnostics.textContent = '';
  codexDeepOffered = false; codexCanContinue = false; linkedThreadId = null;
  applyControls();
  try {
    globalLast = (await chrome.storage.local.get({ last: null }))?.last || null;
    await Promise.all([checkPageHealth(), paintTunnel().catch(() => {})]);
  } finally { $refresh.disabled = false; }
});

$auto.addEventListener('change', () => chrome.storage.local.set({ auto: $auto.checked }));
$syncEnabled.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ syncEnabled: $syncEnabled.checked });
    applyControls();
    show($syncEnabled.checked ? '同步到 ChatVault 已启用。' : '同步到 ChatVault 已暂停；页面脚本仍在运行。');
  } catch (err) { $syncEnabled.checked = !$syncEnabled.checked; applyControls(); show(err.message, 'bad'); }
});
$injectionEnabled.addEventListener('change', async () => {
  const enabled = $injectionEnabled.checked;
  $injectionEnabled.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'setInjection', enabled });
    if (!result?.ok) throw new Error(result?.error || '切换注入失败');
    applyControls();
    show(enabled ? '已启用页面注入；请刷新 ChatGPT 标签页后生效。'
      : '已停止后续注入及同步；请刷新 ChatGPT 标签页，移除已运行的脚本。', 'ok');
  } catch (err) {
    $injectionEnabled.checked = !enabled;
    applyControls();
    show(err.message, 'bad');
  } finally { $injectionEnabled.disabled = false; }
});
$diagnostics.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ diagnostics: $diagnostics.checked });
    if (!$diagnostics.checked) return show('诊断日志已关闭。');
    const result = await chrome.runtime.sendMessage({ type: 'diagnosticPing' });
    show(result?.ok ? `诊断日志已开启：${result.file}`
      : `诊断日志已开启，但尚未落盘：${result?.error || '请重启 ChatVault 服务'}`, result?.ok ? 'ok' : 'bad');
  } catch (err) { show(`诊断日志开关失败：${err.message}`, 'bad'); }
});
$durations.addEventListener('change', () => chrome.storage.local.set({ durations: $durations.checked }));
$speedMetrics.addEventListener('change', () => chrome.storage.local.set({ speedMetrics: $speedMetrics.checked }));
$dotsTitle.addEventListener('change', () => chrome.storage.local.set({ dotsTitle: $dotsTitle.checked }));
$stalledTurn.addEventListener('change', () => chrome.storage.local.set({ stalledTurn: $stalledTurn.checked }));
$notify.addEventListener('change', () => chrome.storage.local.set({ notify: $notify.checked }));
$notifyMinSec.addEventListener('change', () => {
  const v = Number($notifyMinSec.value);
  if (Number.isFinite(v) && v >= 0 && v <= 3600) chrome.storage.local.set({ notifyMinSec: Math.round(v) });
});
$recoveryReadMinMin?.addEventListener('change', () => {
  const v = Number($recoveryReadMinMin.value);
  if (Number.isFinite(v) && v >= 0 && v <= 60) chrome.storage.local.set({ recoveryReadMinMin: Math.round(v) });
});
$dotsQuietSec?.addEventListener('change', () => {
  const v = Number($dotsQuietSec.value);
  if (Number.isFinite(v) && v >= 30 && v <= 3600) chrome.storage.local.set({ dotsQuietSec: Math.round(v) });
});
$tunnelPort?.addEventListener('change', async () => {
  const value = Number($tunnelPort.value);
  if (Number.isInteger(value) && value >= 0 && value < 65536) { await chrome.storage.local.set({ tunnelPort: value }); void paintTunnel(); }
});
$port.addEventListener('change', () => {
  const port = Number($port.value);
  if (Number.isInteger(port) && port > 0 && port < 65536) chrome.storage.local.set({ port });
});

$sync.addEventListener('click', async () => {
  $sync.disabled = true;
  show('同步中…');
  try {
    const tab = await targetTab();
    // content script 不在（不是 ChatGPT 页）时 sendMessage 会直接抛
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'syncNow' });
    if (r?.ok) {
      const first = r.sessions?.[0];
      show(r.skipped || (first ? `已同步：${first.title}（${first.messages} 条）` : '已同步'), 'ok');
    } else {
      show(r?.error || '同步失败', 'bad');
    }
  } catch {
    show('请在 ChatGPT 的对话页面打开本扩展', 'bad');
  } finally {
    applyControls();
  }
});

const KIND = { codex: 'Work', worker: '持久 worker', chat: 'Chat' };
const MODE_TEXT = {
  work: m => [`<b>Work 模式</b> · ${m.turns} 轮`, '由 Codex 执行，可打开对应会话'],
  worker: m => [`<b>后台持久执行</b> · ${m.turns} 轮`, '走 conversation-turn 持久 worker，未见 Codex 活动记录；可尝试查找对应会话'],
  mixed: m => [`<b>混合</b> · ${[[m.codexTurns, 'Work'], [m.workerTurns, '持久 worker'], [m.chatTurns, 'Chat']]
    .filter(([n]) => n > 0).map(([n, label]) => `${n} 轮 ${label}`).join('、')}`,
    `最新一轮是 ${KIND[m.lastTurn] || 'Chat'}；Work 部分可打开 Codex 会话`],
  chat: m => [`<b>Chat 模式</b> · ${m.turns} 轮`, '由 Pro 后台执行，没有对应的 Codex 会话'],
  dots: () => ['<b>Dots 对话</b>', '可打开对应的 Codex 会话'],
  codexPage: () => ['<b>Codex 会话</b>', '这里就是 Codex 线程页面'],
  unknown: () => ['尚未取得对话数据', '打开对话片刻后再看'],
};
function paintMode(info) {
  if (!$convMode) return;
  const mode = MODE_TEXT[info?.mode] ? info.mode : 'unknown';
  pageMode = mode;
  const n = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  // 兼容 0.12.20 页面：只有 workTurns / lastTurn=work 时按 Work 计。
  const codexTurns = info?.codexTurns != null ? n(info.codexTurns) : n(info?.workTurns);
  const [head, tail] = MODE_TEXT[mode]({ turns: n(info?.turns), codexTurns, workerTurns: n(info?.workerTurns),
    chatTurns: n(info?.chatTurns), lastTurn: info?.lastTurn === 'work' ? 'codex' : KIND[info?.lastTurn] ? info.lastTurn : 'chat' });
  $convMode.className = ['work', 'worker', 'mixed', 'dots', 'codexPage'].includes(mode) ? 'hint work' : mode === 'chat' ? 'hint chat' : 'hint';
  $convMode.innerHTML = `${head}<br>${tail}`;
  applyControls();
}

const $reinject = document.getElementById('reinject');
let healthTab = null;
$reinject?.addEventListener('click', async () => {
  if (healthTab?.id == null) return;
  $reinject.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'reinjectTab', tabId: healthTab.id });
    if (!result?.ok) throw new Error(result?.error || '注入失败');
    if (result.status === 'needs-refresh') { show('此标签页里仍有旧脚本占用，请刷新该标签页。', 'bad'); return; }
    if (result.status === 'disabled') { show('页面注入已关闭。', 'bad'); return; }
    $reinject.hidden = true;
    show('已重新注入，正在检查…', 'ok');
    await new Promise(resolve => setTimeout(resolve, 1500));
    await checkPageHealth();
  } catch (err) { show(`重新注入失败：${err.message}`, 'bad'); }
  finally { $reinject.disabled = false; }
});

async function checkPageHealth() {
  const element = document.getElementById('pageHealth');
  if (!element) return;
  const version = chrome.runtime.getManifest().version;
  let timeout;
  try {
    const tab = await targetTab();
    healthTab = tab;
    if ($reinject) $reinject.hidden = true;
    void paintLastSync(tab).catch(() => {});
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab?.url || '')) {
      element.textContent = `扩展 ${version} · 当前不是 ChatGPT 页面`;
      if ($convMode) $convMode.textContent = '当前不是 ChatGPT 对话页';
      return;
    }
    const reply = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'diagnosticProbe' }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('probe_timeout')), 2500); }),
    ]);
    const codexPage = /^https:\/\/chatgpt\.com\/local\/[0-9a-f-]{36}/i.test(tab.url || '');
    paintMode(codexPage ? { mode: 'codexPage' } : reply?.conversation_mode);
    // 给 pi-panel.js：对话里出现过的 UUID → 匹配已知 pi 会话
    // 先留一份：探针可能在 pi-panel.js 加载前就回来了
    globalThis.__cvLastProbe = { reply, tab };
    if (typeof CustomEvent === 'function' && document.dispatchEvent) document.dispatchEvent(new CustomEvent('cv-probe', { detail: { reply, tab } }));
    void paintUsage(tab).catch(() => {});
    const runtime = reply?.page_runtime;
    const pageVersion = runtime?.version || reply?.turn_timer?.version || '未知';
    const valid = pageVersion === version && runtime?.phase === 'ready';
    element.textContent = `扩展 ${version} · 页面 ${pageVersion} · ${valid ? '已就绪' : runtime?.phase === 'disabled'
      ? '注入已关闭' : '请刷新此标签页'}${runtime?.last_error ? ` · ${runtime.last_error.stage}: ${runtime.last_error.message}` : ''}`;
  } catch {
    element.textContent = `扩展 ${version} · 页面脚本未运行（扩展更新后旧脚本会断开）`;
    if ($convMode) { $convMode.className = 'hint'; $convMode.textContent = '页面脚本未运行，无法识别对话类型。'; }
    if ($reinject && $injectionEnabled.checked && healthTab?.id != null) $reinject.hidden = false;
  } finally { clearTimeout(timeout); }
}
load();
void checkPageHealth();
void paintTunnel().catch(() => {});
