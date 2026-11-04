import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/content.js', import.meta.url), 'utf8');

test('首次进入同一对话只安排一次同步，文本变化不触发整轮重画', async () => {
  const timers = [];
  const intervals = [];
  const observers = [];
  const listeners = new Map();
  let streamingChecks = 0;
  const document = {
    body: {}, visibilityState: 'visible',
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const context = vm.createContext({
    document,
    location: { pathname: '/c/6ab57c4f-5a4c-83ec-ade9-f4a84c69d90f' },
    window: { __cvTurns: {
      watchStreaming() {},
      isStreaming() { streamingChecks++; return false; },
    } },
    chrome: {
      storage: { local: { get: async (defaults) => defaults }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} } },
    },
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
    },
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      timers.push(entry);
      return entry;
    },
    clearTimeout: (entry) => { if (entry) entry.cancelled = true; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); },
    crypto: { randomUUID: () => 'test-run' },
    console,
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.filter((timer) => timer.ms === 1500 && !timer.cancelled).length, 1);
  intervals.find((interval) => interval.ms === 1000).fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.filter((timer) => timer.ms === 1500 && !timer.cancelled).length, 1);

  // 给懒加载观察器一份已取到的对话。文本增量没有新消息锚点，不应排队整轮渲染。
  vm.runInContext('lastConv = { mapping: {} }', context);
  const observe = observers[0];
  observe([{ addedNodes: [{ nodeType: 3 }] }]);
  observe([{ addedNodes: [{ nodeType: 1, classList: { contains: () => false },
    hasAttribute: () => false, querySelector: () => null }] }]);
  assert.equal(timers.filter((timer) => timer.ms === 600).length, 0);
  assert.equal(streamingChecks, 0);

  observe([{ addedNodes: [{ nodeType: 1, classList: { contains: () => false },
    matches: () => true }] }]);
  assert.equal(timers.filter((timer) => timer.ms === 600).length, 1);
  assert.equal(streamingChecks, 1);

  listeners.get('visibilitychange')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.filter((timer) => timer.ms === 1500 && !timer.cancelled).length, 1);
});

test('刷新后的历史轮次先恢复测速数据，再绘制徽标和悬浮列表', async () => {
  const order = [];
  let finishHydration;
  const hydration = new Promise(resolve => { finishHydration = resolve; });
  const context = vm.createContext({
    document: { body: {}, visibilityState: 'hidden', addEventListener() {} },
    location: { pathname: '/c/6ab57c4f-5a4c-83ec-ade9-f4a84c69d90f' },
    window: { __cvTurns: { watchStreaming() {}, isStreaming: () => false,
      renderTurns: () => { order.push('render'); return { turns: 1, anchored: 1 }; } } },
    __cvSpeed: { hydrate: () => { order.push('hydrate'); return hydration; } },
    chrome: { storage: { local: { get: async defaults => defaults },
      onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    crypto: { randomUUID: () => 'test-run' }, performance: { now: () => 0 }, console,
  });
  vm.runInContext(source, context);
  vm.runInContext('paintTurns({ conversation_id: "6ab57c4f-5a4c-83ec-ade9-f4a84c69d90f", mapping: {} })', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['hydrate']);
  finishHydration();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['hydrate', 'render']);
});

test('Codex Cloud 页：turn/completed 转发到达且不在看时发一次完成通知；已在跑的轮次不报用时', async () => {
  const THREAD = '01a12a0c-a652-7599-a770-0e76576cdff3';
  const sent = [];
  const onMessage = [];
  const window = { __cvTurns: { watchStreaming() {}, isStreaming: () => false },
    addEventListener: (name, fn) => { if (name === 'message') onMessage.push(fn); } };
  const document = { body: {}, visibilityState: 'hidden', hasFocus: () => false, title: 'ChatGPT', addEventListener() {} };
  const context = vm.createContext({
    document, window,
    location: { pathname: `/local/${THREAD}`, origin: 'https://chatgpt.com' },
    __cvCodexCloud: { conversationId: path => /^\/local\/([0-9a-f-]{36})/.exec(path)?.[1] ? `codex-${THREAD}` : null },
    chrome: { storage: { local: { get: async defaults => defaults }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async msg => { sent.push(msg); } } },
    MutationObserver: class { observe() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval() {},
    crypto: { randomUUID: () => 'test-run' }, performance: { now: () => 0 }, console,
  });
  vm.runInContext(source, context);
  vm.runInContext(`lastConv = { conversation_id: "codex-${THREAD}", title: "Codex Cloud · [$chappie](app://asdk_x) 连接 01a12a09" }`, context);
  const post = data => onMessage.forEach(fn => fn({ source: window, origin: 'https://chatgpt.com',
    data: { __chatVaultStreamMetricsV1: true, conversationId: `codex-${THREAD}`, ...data } }));
  const settle = () => new Promise(resolve => setImmediate(resolve));

  post({ requestId: 1, codexSend: true, requestStartMs: 1000, completedAtMs: null });   // 进行中：不通知
  post({ requestId: 1, codexSend: true, requestStartMs: 1000, completedAtMs: 91000 });
  post({ requestId: 1, codexSend: true, requestStartMs: 1000, completedAtMs: 91000 });  // token 用量更新后的重复转发
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0] }, { type: 'turnDone', ms: 90000, kind: 'codex', resumed: false, title: '$chappie 连接 01a12a09' });

  post({ requestId: 2, codexSend: true, requestStartMs: 1000, completedAtMs: 6000 });   // 短于最短时长
  post({ requestId: 3, codexSend: false, requestStartMs: 1000, completedAtMs: 6000 });  // 打开页面时已在跑
  post({ requestId: 4, conversationId: 'codex-other', codexSend: true, requestStartMs: 0, completedAtMs: 99000 });
  await settle();
  assert.deepEqual(sent.slice(1).map(m => [m.resumed, m.ms]), [[true, 5000]]);
});
