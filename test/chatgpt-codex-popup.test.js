import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const popup = fs.readFileSync(new URL('../extensions/chatgpt-sync/popup.js', import.meta.url), 'utf8');
const CONVERSATION = '6ab12a88-b654-83ec-b94f-02e4022102b9';
const THREAD = '01a0c40e-6e82-7033-8301-b436bf06d0ad';
const OTHER = '01a0f178-337c-76ad-ab15-57376055ec42';
function element() {
  return { handlers: {}, style: {}, children: [], checked: false, disabled: false, textContent: '',
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
}
async function fixture({ result, lookup, injectionEnabled = true, url, health = false } = {}) {
  const elements = new Map(['auto', 'injectionEnabled', 'syncEnabled', 'diagnostics', 'durations', 'speedMetrics',
    'dotsTitle', 'stalledTurn', 'notify', 'notifyMinSec', 'port', 'sync', 'status', 'convMode', 'codexThread',
    'codexThreadStatus', 'codexThreadCandidates', 'codexThreadDeep', 'codexThreadDiagnostics',
    ...(health ? ['pageHealth'] : [])].map(id => [id, element()]));
  const state = { tab: { id: 123, url: url || `https://chatgpt.com/c/${CONVERSATION}` }, opened: [], messages: [] };
  const values = { injectionEnabled, syncEnabled: false, auto: false, notify: false, diagnostics: false };
  const context = { setTimeout, clearTimeout, document: { getElementById: id => elements.get(id), createElement: element },
    chrome: { storage: { onChanged: { addListener() {} }, local: { get: async () => values,
      set: async update => Object.assign(values, update) } },
    // health: 打开弹窗即做页面健康检查（会额外发一条 diagnosticProbe）；其余用例不需要。
    runtime: { sendMessage: async () => ({ ok: true }), getManifest: () => ({ version: '0.13.0' }) },
    tabs: { query: async () => [state.tab], get: async () => state.tab,
      sendMessage: async (_tabId, message) => { state.messages.push(message); return lookup ? lookup() : result; },
      create: async options => { state.opened.push(options); return {}; } } } };
  vm.runInNewContext(popup, context);
  await new Promise(resolve => setImmediate(resolve));
  return { state, elements, click: () => elements.get('codexThread').handlers.click(),
    deep: () => elements.get('codexThreadDeep').handlers.click() };
}
const resolved = candidates => ({ ok: true, lookupVersion: '0.13.0', conversationId: CONVERSATION,
  requiresConfirmation: candidates.length !== 1, candidates: candidates.map(candidate =>
    ({ confidence: 'verified', matchedBy: 'user-message-id', ...candidate })) });

test('明确点击后在新标签页打开精确 thread URL，同步暂停仍可使用', async () => {
  const f = await fixture({ result: resolved([{ threadId: THREAD }]) });
  assert.equal(f.elements.get('sync').disabled, true);
  assert.equal(f.elements.get('codexThread').disabled, false);
  assert.equal(f.state.messages.length, 0);
  await f.click();
  assert.equal(f.state.messages[0].type, 'resolveCodexThread');
  assert.equal(f.state.messages[0].conversationId, CONVERSATION);
  assert.equal(f.state.opened[0].url, `https://chatgpt.com/local/${THREAD}?hostId=local`);
  assert.equal(f.elements.get('codexThread').disabled, false);
  const disabled = await fixture({ injectionEnabled: false });
  assert.equal(disabled.elements.get('codexThread').disabled, true);
});

test('等待查询期间切换了对话，不打开旧 thread', async () => {
  let finish;
  const f = await fixture({ lookup: () => new Promise(resolve => { finish = resolve; }) });
  const click = f.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.elements.get('codexThread').disabled, true);
  f.state.tab = { id: 123, url: `https://chatgpt.com/c/${OTHER}` };
  finish(resolved([{ threadId: THREAD }]));
  await click;
  assert.equal(f.state.opened.length, 0);
  assert.match(f.elements.get('codexThreadStatus').textContent, /对话已变化/);
});

test('多个匹配需要选择；选择时再次检查来源对话', async () => {
  const f = await fixture({ result: resolved([{ threadId: THREAD, model: 'gpt-6-astra' }, { threadId: OTHER }]) });
  await f.click();
  assert.equal(f.state.opened.length, 0);
  const choices = f.elements.get('codexThreadCandidates').children;
  assert.equal(choices.length, 2);
  await choices[1].handlers.click();
  assert.equal(f.state.opened[0].url, `https://chatgpt.com/local/${OTHER}?hostId=local`);
  f.state.tab = { id: 123, url: 'https://chatgpt.com/' };
  await choices[0].handlers.click();
  assert.equal(f.state.opened.length, 1);
  assert.match(f.elements.get('codexThreadStatus').textContent, /对话已变化/);
});

test('未找到、旧页面脚本和非法 thread ID 均显示原因并恢复按钮', async () => {
  for (const options of [
    { result: { ok: false, error: '未找到对应 thread', lookupVersion: '0.13.0' } },
    { result: undefined },
    { lookup: () => { throw new Error('Receiving end does not exist'); } },
    { result: resolved([{ threadId: '../settings' }]) },
  ]) {
    const f = await fixture(options);
    await f.click();
    assert.equal(f.state.opened.length, 0);
    assert.equal(f.elements.get('codexThread').disabled, false);
    assert.match(f.elements.get('codexThreadStatus').textContent, /未找到|刷新|ID 无效/);
  }
});

test('Dots 来源传递自身 thread 的独立对话键', async () => {
  const f = await fixture({ url: `https://chatgpt.com/dots/${THREAD}`,
    result: { ...resolved([{ threadId: THREAD, matchedBy: 'dots' }]), conversationId: `dots-${THREAD}` } });
  await f.click();
  assert.equal(f.state.messages[0].conversationId, `dots-${THREAD}`);
  assert.equal(f.state.opened[0].url, `https://chatgpt.com/local/${THREAD}?hostId=local`);
});

test('文本或 cwd 单候选仍需确认，不能因为只有一个就自动跳转', async () => {
  for (const matchedBy of ['first-user-message', 'workspace']) {
    const result = resolved([{ threadId: THREAD, matchedBy, confidence: 'candidate' }]);
    result.requiresConfirmation = true;
    const f = await fixture({ result });
    await f.click();
    assert.equal(f.state.opened.length, 0);
    assert.match(f.elements.get('codexThreadStatus').textContent, /未证明/);
    const [choice] = f.elements.get('codexThreadCandidates').children;
    assert.match(choice.textContent, /候选/);
    await choice.handlers.click();
    assert.equal(f.state.opened.length, 1);
  }
});

test('深度查找传递模式、保留依据，并让用户选择而非自动打开', async () => {
  const f = await fixture({ result: { ...resolved([{ threadId: THREAD, matchedUserMessageId: CONVERSATION }]),
    diagnostics: { scope: 'history', rootsListed: 9, rootsChecked: 9, rootsCompleted: 9, rootsPending: 0,
      itemPages: 21, failures: [], partial: false } } });
  await f.deep();
  assert.equal(f.state.messages[0].deepScan, true);
  assert.equal(f.state.opened.length, 0);
  assert.match(f.elements.get('codexThreadCandidates').children[0].textContent, /用户消息 ID 一致/);
  assert.match(f.elements.get('codexThreadDiagnostics').textContent, /9\/9.*21 页/);
});

test('扫描失败和部分结果展示覆盖率；不自动打开部分扫描的唯一结果', async () => {
  const diagnostics = { scope: 'history', rootsListed: 9, rootsChecked: 9, itemPages: 18,
    partial: true, failures: [{ message: '429' }], limitedRoots: 2 };
  const f = await fixture({ result: { ...resolved([{ threadId: THREAD }]), diagnostics } });
  await f.click();
  assert.equal(f.state.opened.length, 0);
  assert.match(f.elements.get('codexThreadStatus').textContent, /查找未完成/);
  assert.match(f.elements.get('codexThreadDiagnostics').textContent, /1 项读取失败.*2 个线程/);
  const failed = await fixture({ result: { ok: false, lookupVersion: '0.13.0', diagnostics,
    error: 'Codex 查找未完成：429', code: 'LOOKUP_INCOMPLETE' } });
  await failed.deep();
  assert.match(failed.elements.get('codexThreadStatus').textContent, /429/);
  assert.match(failed.elements.get('codexThreadDiagnostics').textContent, /不能据此排除/);
});

test('预算暂停是可继续状态，不显示为六项读取失败，完成计数不冒用开始计数', async () => {
  const f = await fixture({ result: { ...resolved([]), status: 'paused', canContinue: true,
    message: '本批查找已暂停，进度已保留。', diagnostics: { scope: 'history', rootsListed: 9,
      rootsChecked: 9, rootsCompleted: 3, rootsPending: 6, itemPages: 238, totalItemPages: 238,
      paused: true, partial: true, canContinue: true, failures: [] } } });
  await f.deep();
  assert.equal(f.state.opened.length, 0);
  assert.match(f.elements.get('codexThreadStatus').textContent, /本批查找已暂停/);
  assert.match(f.elements.get('codexThreadDeep').textContent, /继续查找/);
  assert.match(f.elements.get('codexThreadDiagnostics').textContent, /已完成 3\/9.*已开始 9 个，剩余 6 个/);
  assert.doesNotMatch(f.elements.get('codexThreadDiagnostics').textContent, /读取失败|已完成 9\/9/);
  await f.deep();
  assert.equal(f.state.messages.length, 2);
  assert.equal(f.state.messages[1].deepScan, true);
});

test('旧版页面即使返回看似成功的 thread 也要求刷新，不绕过新确认规则', async () => {
  const f = await fixture({ result: { ...resolved([{ threadId: THREAD }]), lookupVersion: '0.11.3' } });
  await f.click();
  assert.equal(f.state.opened.length, 0);
  assert.match(f.elements.get('codexThreadStatus').textContent, /尚未更新.*刷新/);
});

test('并发点击只发一个查找请求，两个按钮均禁用，注入关闭也禁用深度入口', async () => {
  let finish;
  const f = await fixture({ lookup: () => new Promise(resolve => { finish = resolve; }) });
  const first = f.click();
  await new Promise(resolve => setImmediate(resolve));
  await f.deep();
  assert.equal(f.state.messages.length, 1);
  assert.equal(f.elements.get('codexThreadDeep').disabled, true);
  finish(resolved([{ threadId: THREAD }]));
  await first;
  assert.equal(f.elements.get('codexThreadDeep').disabled, false);
  const disabled = await fixture({ injectionEnabled: false });
  await disabled.deep();
  assert.equal(disabled.state.messages.length, 0);
  assert.equal(disabled.elements.get('codexThreadDeep').disabled, true);
});

test('Sonic入口拒绝单独呈现，不打开链接、不误导为预算耗尽', async () => {
  const f = await fixture({ result: { ...resolved([]), status: 'route-unsupported', code: 'CODEX_ROUTE_UNSUPPORTED',
    message: '已发现后台标识，但当前入口不支持 placement。', diagnostics: { scope: 'association', sonicCount: 28,
      sampleCount: 3, requests: 3, probes: [{ state: 'route-unsupported', reason: 'placement version 3' }], failures: [] } } });
  await f.click();
  assert.equal(f.state.opened.length, 0); assert.match(f.elements.get('codexThreadStatus').textContent, /placement/);
  assert.match(f.elements.get('codexThreadDiagnostics').textContent, /未扫描全量历史/);
  assert.doesNotMatch(f.elements.get('codexThreadStatus').textContent, /预算|重载扩展/);
});

test('正常查找完成未命中不误报结果格式错误', async () => {
  const f = await fixture({ result: { ...resolved([]), status: 'no-match', message: '当前读取范围内未找到匹配。' } });
  await f.click(); assert.equal(f.state.opened.length, 0);
  assert.match(f.elements.get('codexThreadStatus').textContent, /当前读取范围/);
});

test('深度查找只作兜底：默认隐藏；Work 对话未命中才出现；Chat 模式不出现', async () => {
  const noMatch = { ok: true, lookupVersion: '0.13.0', conversationId: CONVERSATION, status: 'no-match', code: 'LOOKUP_NO_MATCH',
    candidates: [], requiresConfirmation: true, canContinue: false, message: '未找到', diagnostics: { scope: 'root-heads', partial: false } };
  const chatMode = { ok: true, lookupVersion: '0.13.0', conversationId: CONVERSATION, status: 'chat-mode', code: 'CODEX_CHAT_MODE',
    candidates: [], requiresConfirmation: true, canContinue: false, message: 'Chat 模式：没有对应的 Codex 线程。',
    diagnostics: { scope: 'mode', mode: 'chat', requests: 0, partial: false } };
  let next = noMatch;
  const f = await fixture({ lookup: () => next });
  const deep = f.elements.get('codexThreadDeep');
  assert.equal(deep.hidden, true, '打开弹窗时不提供深度查找');
  await f.click();
  assert.equal(deep.hidden, false, 'Work 对话普通查找未命中后提供兜底');
  next = chatMode;
  await f.click();
  assert.equal(deep.hidden, true, 'Chat 模式没有 Codex 线程可找');
  assert.match(f.elements.get('codexThreadStatus').textContent, /Chat 模式/);
});

test('Chat 模式不提供 Codex 入口，并说明原因；Work 模式显示轮数', async () => {
  const chat = await fixture({ health: true, result: { conversation_mode: { mode: 'chat', turns: 3, workTurns: 0, chatTurns: 3, lastTurn: 'chat' } } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(chat.elements.get('codexThread').hidden, true);
  assert.match(chat.elements.get('convMode').innerHTML, /Chat 模式<\/b> · 3 轮/);
  assert.match(chat.elements.get('convMode').innerHTML, /没有对应的 Codex 会话/);
  const work = await fixture({ health: true, result: { conversation_mode: { mode: 'work', turns: 2, workTurns: 2, chatTurns: 0, lastTurn: 'work' } } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(work.elements.get('codexThread').hidden, false);
  assert.match(work.elements.get('convMode').innerHTML, /Work 模式<\/b> · 2 轮/);
  const hostile = await fixture({ health: true, result: { conversation_mode: { mode: 'chat', turns: '<img src=x>' } } });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(hostile.elements.get('convMode').innerHTML.includes('<img'), false, '计数只接受整数');
});
