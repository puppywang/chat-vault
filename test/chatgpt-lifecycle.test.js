import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createMeasuredWriter } from '../extensions/chatgpt-sync/measured-durations.js';

const read = name => fs.readFileSync(new URL(`../extensions/chatgpt-sync/${name}.js`, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

test('统一生命周期保留加载期间的开关变更；上下文失效后所有订阅者停机', async () => {
  let resolveSettings, change, heartbeat;
  const controls = [], notices = [];
  const context = vm.createContext({ console,
    location: { origin: 'https://chatgpt.com' },
    window: { postMessage: m => controls.push(m) },
    chrome: { runtime: { id: 'fixture' }, storage: {
      local: { get: () => new Promise(resolve => { resolveSettings = resolve; }) },
      onChanged: { addListener: fn => { change = fn; } },
    } }, setInterval: fn => { heartbeat = fn; return 1; }, clearInterval() {}, setTimeout: () => 0,
  });
  vm.runInContext(read('page-state'), context);
  const page = context.__cvPage;
  page.subscribe(snapshot => notices.push(snapshot.phase));
  change({ injectionEnabled: { newValue: false } }, 'local');
  resolveSettings({ injectionEnabled: true });
  await page.ready;
  assert.equal(page.snapshot().phase, 'disabled');
  assert.equal(controls.at(-1).enabled, false);
  change({ injectionEnabled: { newValue: true } }, 'local');
  assert.equal(page.can('durations'), true);
  assert.equal(controls.at(-1).enabled, true);
  context.chrome.runtime.id = undefined;
  heartbeat();
  assert.equal(page.snapshot().phase, 'reload_required');
  assert.equal(controls.at(-1).enabled, false);
  assert.equal(notices.at(-1), 'reload_required');
  await assert.rejects(page.run('test', () => assert.fail('must not execute')), /invalidated/);
});

// 0.13.18 起普通 /c/ 对话不再自己读历史：数据由页面交来（page-conversation.js → postMessage）。
const pageData = id => ({ conversation_id: id, current_node: 'newer', update_time: 1,
  mapping: { old: { message: { id: 'u1', author: { role: 'user' }, create_time: 1 } },
    newer: { message: { id: 'u-other-branch', author: { role: 'user' }, create_time: 2 } } } });
function contentFixture() {
  const callbacks = {}, requests = [], messages = [], timers = [], rendered = [], messageListeners = [];
  const values = { auto: false, syncEnabled: true, durations: true, injectionEnabled: true };
  const context = vm.createContext({ console, performance: { now: () => 0 },
    crypto: { randomUUID: () => 'test-run' },
    location: { pathname: `/c/${A}`, origin: 'https://chatgpt.com' },
    document: { body: {}, title: 'A', visibilityState: 'visible', hasFocus: () => true, addEventListener() {} },
    window: { __cvTurns: { watchStreaming(end, start, begin) { Object.assign(callbacks, { end, start, begin }); },
      isStreaming: () => false, renderTurns(conv) { rendered.push(conv); return { turns: 1, anchored: 1 }; } },
      addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn); }, postMessage() {} },
    __cvSpeed: { hydrate: async () => {} },
    chrome: { storage: { local: { get: async defaults => ({ ...defaults, ...values }) }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async message => { messages.push(message); return { ok: true }; } } },
    fetch: async url => { requests.push(url); throw new Error(`不应自己发请求：${url}`); },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout() {}, setInterval() {}, clearInterval() {},
  });
  context.globalThis = context;
  vm.runInContext(read('conversation-merge'), context);
  vm.runInContext(read('content'), context);
  const deliver = data => messageListeners.forEach(fn => fn({ source: context.window, origin: 'https://chatgpt.com', data }));
  deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  return { context, callbacks, requests, messages, timers, rendered, values,
    page(conv) { deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', shape: 'full',
      conversationId: conv.conversation_id, text: JSON.stringify(conv), receivedAtMs: Date.now(), serverDate: null }); } };
}

test('旧轮次结束期间切换路由，存储与回查始终归旧对话，不触发新对话同步', async () => {
  const f = contentFixture();
  f.page(pageData(A));
  await flush();
  const done = f.callbacks.end({ path: `/c/${A}`, measuredMs: 1000, startedAtMs: 1000, endedAtMs: 2000 });
  f.context.location.pathname = `/c/${B}`;
  await done;
  assert.equal(f.requests.length, 0, '回查用页面数据，不读历史');
  const write = f.messages.find(m => m.type === 'rememberMeasured');
  assert.equal(write.conversationId, A);
  assert.equal(f.messages.some(m => m.type === 'sync'), false);
});

test('起点回查优先精确用户消息 ID，不取其它分支较新的消息', async () => {
  const f = contentFixture();
  f.page(pageData(A));
  const value = await f.callbacks.start({ path: `/c/${A}`, userMessageId: 'u1' });
  assert.equal(value.id, 'u1');
  assert.equal(value.ms, 1000);
});

test('刷新耗时与起点回查都用页面数据；测速失败不妨碍徽标绘制', async () => {
  const f = contentFixture();
  f.context.__cvSpeed.hydrate = async () => { throw new Error('tokenizer offline'); };
  f.page(pageData(A));
  await flush();
  const before = f.rendered.length;
  await Promise.all([vm.runInContext('refreshTurns()', f.context), f.callbacks.start({ path: `/c/${A}`, userMessageId: 'u1' })]);
  await flush();
  assert.equal(f.requests.length, 0);
  assert.equal(f.rendered.length, before + 1);
});

test('测速恢复未结束时路由切换，迟到结果不得重画旧会话', async () => {
  const f = contentFixture();
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  f.context.__cvSpeed.hydrate = () => gate;
  f.page(pageData(A));
  await vm.runInContext('refreshTurns()', f.context);
  await flush();
  f.context.location.pathname = `/c/${B}`;
  finish(); await flush();
  assert.equal(f.rendered.length, 0);
});

test('多个标签页并发保存耗时不丢记录，单次存储失败不会毒化队列', async () => {
  let data = { turnDurations: {} }, fail = false;
  const writer = createMeasuredWriter({
    get: async () => structuredClone(data),
    set: async value => { await flush(); if (fail) { fail = false; throw new Error('quota'); } data = structuredClone(value); },
  });
  const value = { measuredMs: 10, startedAtMs: 1, endedAtMs: 11, userMessageId: 'u1' };
  await Promise.all([writer({ ...value, conversationId: A }), writer({ ...value, conversationId: B })]);
  assert.equal(Object.keys(data.turnDurations).length, 2);
  fail = true;
  await assert.rejects(writer({ ...value, conversationId: A, userMessageId: 'bad' }), /quota/);
  await writer({ ...value, conversationId: A, userMessageId: 'u2' });
  assert.equal(Object.keys(data.turnDurations).length, 3);
});
