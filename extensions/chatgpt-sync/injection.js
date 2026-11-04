// Chrome 的动态声明才能真正控制下一次导航是否注入；注销不会移除已在页面运行的脚本。
export const SCRIPT_ID = 'chatvault-chatgpt-page';
export const NETWORK_SCRIPT_ID = 'chatvault-chatgpt-network-speed';
export const PAGE_CONVERSATION_SCRIPT_ID = 'chatvault-chatgpt-page-conversation';
const DESIRED_SCRIPT = {
  id: SCRIPT_ID,
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  js: ['page-state.js', 'dots.js', 'dots-title.js', 'dots-notify.js', 'diagnostics.js', 'speed.js', 'turns.js', 'codex-thread.js', 'codex-cloud.js', 'codex-association.js', 'stalled-turn.js', 'conversation-merge.js', 'content.js'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  allFrames: false,
  persistAcrossSessions: true,
};
const NETWORK_SCRIPT = {
  id: NETWORK_SCRIPT_ID,
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  js: ['stream-parser.js', 'page-stream.js'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  persistAcrossSessions: true,
};

// 复用页面自己的对话请求，与测速开关无关：页面注入开启即注册。
const PAGE_CONVERSATION_SCRIPT = {
  id: PAGE_CONVERSATION_SCRIPT_ID,
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  js: ['page-conversation.js'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  persistAcrossSessions: true,
};

export async function syncPageInjection(enabled, scripting = chrome.scripting, speedMetrics = true) {
  const registered = await scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID, NETWORK_SCRIPT_ID, PAGE_CONVERSATION_SCRIPT_ID] });
  const desired = enabled ? [DESIRED_SCRIPT, PAGE_CONVERSATION_SCRIPT, ...(speedMetrics ? [NETWORK_SCRIPT] : [])] : [];
  const wanted = new Set(desired.map((script) => script.id));
  const unwanted = registered.filter((script) => !wanted.has(script.id)).map((script) => script.id);
  if (unwanted.length) await scripting.unregisterContentScripts({ ids: unwanted });
  const missing = desired.filter((script) => !registered.some((current) => current.id === script.id));
  if (missing.length) await scripting.registerContentScripts(missing);
  const keys = ['matches', 'js', 'runAt', 'world', 'allFrames', 'persistAcrossSessions'];
  const changed = desired.filter((script) => {
    const current = registered.find((item) => item.id === script.id);
    return current && keys.some((key) => JSON.stringify(current[key]) !== JSON.stringify(script[key]));
  });
  if (changed.length) await scripting.updateContentScripts(changed);
  return { enabled: !!enabled, registered: !!enabled, network_registered: !!enabled && !!speedMetrics };
}

/**
 * 扩展安装/更新/重新加载后，已打开标签页里的旧内容脚本与扩展断开（无响应），动态注册只对之后的导航生效。
 * 这里给已打开的 ChatGPT 标签页补注入：先探测隔离环境里是否还留着旧实例——若 Chrome 复用了同一环境，
 * 重复执行会撞上顶层 let 重复声明，因此只提示刷新；否则补注入。MAIN world 脚本自带标记，已有则不重复包装。
 */
export async function injectTab(tabId, { scripting = chrome.scripting, speedMetrics = true } = {}) {
  const [probe] = await scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
    func: () => typeof globalThis.__cvPage !== 'undefined' });
  if (probe?.result === true) return { tabId, status: 'needs-refresh' };
  await scripting.executeScript({ target: { tabId }, world: 'MAIN',
    files: [...PAGE_CONVERSATION_SCRIPT.js, ...(speedMetrics ? NETWORK_SCRIPT.js : [])] });
  await scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: DESIRED_SCRIPT.js });
  return { tabId, status: 'injected' };
}

export async function injectOpenTabs({ enabled = true, speedMetrics = true, scripting = chrome.scripting, tabs = chrome.tabs } = {}) {
  if (!enabled) return { injected: 0, needsRefresh: 0, failed: 0, results: [] };
  const open = await tabs.query({ url: DESIRED_SCRIPT.matches });
  const results = [];
  for (const tab of open) {
    if (tab.discarded || tab.status === 'unloaded') { results.push({ tabId: tab.id, status: 'skipped-discarded' }); continue; }
    try { results.push(await injectTab(tab.id, { scripting, speedMetrics })); }
    catch (error) { results.push({ tabId: tab.id, status: 'failed', error: String(error?.message || error).slice(0, 200) }); }
  }
  const count = status => results.filter(r => r.status === status).length;
  return { injected: count('injected'), needsRefresh: count('needs-refresh'), failed: count('failed'), results };
}
