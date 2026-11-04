import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/speed.js', import.meta.url), 'utf8');
const CONV = '11111111-1111-1111-1111-111111111111';
const MARKER = '__chatVaultStreamMetricsV1';

function fixture(stored = {}) {
  const listeners = new Map();
  const window = { addEventListener: (type, fn) => listeners.set(type, fn) };
  const location = { pathname: `/c/${CONV}`, origin: 'https://chatgpt.com' };
  const calls = [];
  const chrome = { runtime: { sendMessage: async message => {
    calls.push(message);
    return { ok: true, tokens: message.texts.join('').length };
  } }, storage: { local: {
    get: async keys => {
      if (Array.isArray(keys)) return Object.fromEntries(keys
        .filter(key => Object.hasOwn(stored, key)).map(key => [key, stored[key]]));
      return { ...keys, ...stored };
    },
    set: async values => { Object.assign(stored, values); },
  },
    onChanged: { addListener() {} } } };
  const context = { window, location, chrome, globalThis: {}, Date: { now: () => 1000 } };
  vm.runInNewContext(source, context);
  const emit = (value, sourceWindow = window) => listeners.get('message')({
    source: sourceWindow, origin: location.origin,
    data: { [MARKER]: true, requestId: 1, conversationId: CONV,
      userMessageId: 'u1', requestStartMs: 1000, firstTextAtMs: null,
      completedAtMs: null, outputTokens: null, ...value },
  });
  return { speed: context.globalThis.__cvSpeed, emit, location, calls, stored, chrome };
}

test('测速关闭再开启，旧异步分词结果不得写进新的采集代际', async () => {
  const f = fixture();
  await new Promise(resolve => setImmediate(resolve));
  let finish;
  f.chrome.runtime.sendMessage = () => new Promise(resolve => { finish = resolve; });
  f.speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  f.emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  f.emit({ kind: 'tokenize', revision: 1, messageIndex: 0, text: 'old', lastTextAtMs: 5000, textChunks: 3 });
  f.speed.setEnabled(false); f.speed.setEnabled(true);
  f.speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  f.emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  finish({ ok: true, tokens: 999 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.speed.snapshot().tokenCount, null);
});

test('已知发送时刻早于刷新：没有原始 POST 时明确缺少起点，但保留实际抓到的原始流', async () => {
  const f = fixture();
  f.speed.beginRound({ startMs: 15000, userMessageId: 'u1' });
  f.speed.correctRound({ startMs: 1000, userMessageId: 'other', resumed: true });
  assert.equal(f.speed.snapshot().ttftReason, '等待请求');
  f.speed.correctRound({ startMs: 1000, userMessageId: 'u1', resumed: true });
  assert.equal(f.speed.snapshot().ttftReason, '缺少原始起点');
  f.speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  f.emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  f.speed.correctRound({ startMs: 1000, userMessageId: 'u1', resumed: true });
  assert.equal(f.speed.snapshot().ttftMs, 1000, '真实捕获的原始流不被 DOM 恢复猜测覆盖');
});

test('TTFT 来自网络流；tiktoken 结果未到前不猜 TPS', async () => {
  const { speed, emit } = fixture();
  speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  assert.equal(speed.snapshot().ttftMs, null);
  emit({ firstTextAtMs: 10562, lastTextAtMs: 10562, textChunks: 1 });
  assert.equal(speed.snapshot().ttftMs, 9562);
  assert.equal(speed.snapshot().tps, null);
  assert.equal(speed.snapshot().source, 'network');
  emit({ kind: 'tokenize', revision: 1, messageIndex: 0, text: '你好',
    firstTextAtMs: 10562, lastTextAtMs: 10562, textChunks: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(speed.snapshot().tokenCount, 2);
  assert.equal(speed.snapshot().tps, null, '单片输出无可信速度');
});

test('所有助手文本计数后，按首末文本到达时间计算≈TPS；刷新续接不伪造 TTFT', async () => {
  const { speed, emit, location, calls } = fixture();
  speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3, completedAtMs: 6000 });
  emit({ kind: 'tokenize', revision: 2, messageIndex: 0, text: 'abcdef',
    firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(speed.snapshot().ttftMs, 1000);
  assert.equal(speed.snapshot().tokenCount, 6);
  assert.equal(speed.snapshot().tps, 2);
  speed.beginRound({ startMs: 1000, userMessageId: 'u1', resumed: true });
  assert.equal(speed.snapshot().ttftMs, 1000, '本页亲见的原始 POST 不因 DOM 续接猜测作废');
  location.pathname = '/c/22222222-2222-2222-2222-222222222222';
  assert.equal(speed.snapshot(), null);
  // 真正的 F5：新文档没见过原始 POST（resume 走 /f/conversation/resume，不被拦截）。
  const reloaded = fixture();
  reloaded.speed.beginRound({ startMs: 1000, userMessageId: 'u1', resumed: true });
  assert.equal(reloaded.speed.snapshot().ttftMs, null);
  assert.equal(reloaded.speed.snapshot().ttftReason, '缺少原始起点');
});

test('新对话从 / 跳到 /c/<id> 被 DOM 判为续接：本页原始 POST 仍给出 TTFT 并持久化', async () => {
  const { speed, emit, location, stored } = fixture();
  location.pathname = '/';
  emit({ requestStartMs: 1000 });
  location.pathname = `/c/${CONV}`;
  speed.reset();
  speed.beginRound({ startMs: 3000, userMessageId: 'u1', resumed: true });
  emit({ firstTextAtMs: 28700, lastTextAtMs: 31700, textChunks: 3, textChars: 6 });
  emit({ kind: 'tokenize', revision: 1, messageIndex: 0, text: 'abcdef',
    firstTextAtMs: 28700, lastTextAtMs: 31700, textChunks: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(speed.snapshot().ttftMs, 27700);
  assert.equal(speed.snapshot().ttftReason, null);
  assert.equal(speed.snapshot().tps, 2);
  emit({ firstTextAtMs: 28700, lastTextAtMs: 31700, textChunks: 3, textChars: 6, completedAtMs: 32000 });
  speed.finishRound({ userMessageId: 'u1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stored[`cvTurnSpeedV1:${CONV}:u1`].ttftMs, 27700);
  assert.equal(speed.lookup(CONV, 'u1').ttftMs, 27700);
});

test('回复期间切走再切回：路由重入不作废已捕获的原始起点', async () => {
  const { speed, emit, location, stored } = fixture();
  speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  emit({ firstTextAtMs: 2000, lastTextAtMs: 3000, textChunks: 2 });
  location.pathname = '/c/22222222-2222-2222-2222-222222222222';
  speed.reset();
  location.pathname = `/c/${CONV}`;
  speed.beginRound({ startMs: 9000, userMessageId: 'u1', resumed: true });
  speed.correctRound({ startMs: 1000, userMessageId: 'u1', resumed: true });
  assert.equal(speed.snapshot().ttftMs, 1000);
  emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3, completedAtMs: 6000 });
  speed.finishRound({ userMessageId: 'u1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stored[`cvTurnSpeedV1:${CONV}:u1`].ttftMs, 1000);
});

test('续接轮只认同一用户消息的原始 POST：其他消息的观测不能冒充起点', async () => {
  const { speed, emit, stored } = fixture();
  emit({ userMessageId: 'u0', firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  speed.beginRound({ startMs: 1000, userMessageId: 'u1', resumed: true });
  assert.equal(speed.snapshot().ttftMs, null);
  assert.equal(speed.snapshot().ttftReason, '缺少原始起点');
  speed.finishRound({ userMessageId: 'u1' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(Object.hasOwn(stored, `cvTurnSpeedV1:${CONV}:u1`), false);
});

test('多条助手消息分别分词后求和，不重复传输整轮文本', async () => {
  const { speed, emit, calls } = fixture();
  speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  emit({ kind: 'tokenize', revision: 1, messageIndex: 0, text: 'hello',
    firstTextAtMs: 2000, lastTextAtMs: 3000, textChunks: 1 });
  emit({ kind: 'tokenize', revision: 2, messageIndex: 1, text: 'world',
    firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(call => call.texts[0]), ['hello', 'world']);
  assert.equal(speed.snapshot().tokenCount, 10);
  assert.equal(speed.snapshot().tps, 10 / 3);
});

test('伪造消息和禁用测速不产生数值', () => {
  const { speed, emit } = fixture();
  speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  emit({ firstTextAtMs: 2000 }, {});
  assert.equal(speed.snapshot().ttftMs, null);
  speed.setEnabled(false);
  emit({ firstTextAtMs: 2000 });
  assert.equal(speed.snapshot(), null);
  assert.equal(speed.lookup(CONV, 'u1'), null);
});

test('完成轮次持久化测速，F5 后按会话用户消息 ID 恢复', async () => {
  const stored = {};
  const first = fixture(stored);
  first.speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  first.emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3,
    textChars: 6, completedAtMs: 6000,
    eventShapes: [{ keys: 'v', messageRole: 'assistant', count: 1 }] });
  assert.equal(first.speed.snapshot().eventShapes[0].messageRole, 'assistant');
  first.emit({ kind: 'tokenize', revision: 1, messageIndex: 0, text: 'abcdef',
    firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  first.speed.finishRound();
  await new Promise(resolve => setTimeout(resolve, 0));
  const key = `cvTurnSpeedV1:${CONV}:u1`;
  assert.equal(stored[key].ttftMs, 1000);
  assert.equal(stored[key].tps, 2);
  assert.equal(stored[key].tokenCount, 6);
  assert.equal(Object.hasOwn(stored[key], 'text'), false, '存数值，不存助手正文');
  assert.equal(Object.hasOwn(stored[key], 'eventShapes'), false,
    '协议结构只用于当前轮诊断，不持久化到每轮记录');

  const reloaded = fixture(stored);
  await reloaded.speed.hydrate({ conversation_id: CONV,
    mapping: { user: { message: { id: 'u1', author: { role: 'user' } } } } });
  assert.equal(reloaded.speed.lookup(CONV, 'u1').ttftMs, 1000);
  assert.equal(reloaded.speed.lookup(CONV, 'u1').tps, 2);
  assert.equal(reloaded.speed.lookup(CONV, 'u1').tokenCount, 6);
});

test('轮次结束后才完成的分词结果仍更新持久化数据', async () => {
  const { speed, emit, stored } = fixture();
  speed.beginRound({ startMs: 1000, userMessageId: 'u1' });
  emit({ firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3,
    textChars: 6, completedAtMs: 6000 });
  speed.finishRound();
  emit({ kind: 'tokenize', revision: 1, messageIndex: 0, text: 'abcdef',
    firstTextAtMs: 2000, lastTextAtMs: 5000, textChunks: 3 });
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = stored[`cvTurnSpeedV1:${CONV}:u1`];
  assert.equal(saved.tokenCount, 6);
  assert.equal(saved.tps, 2);
});

test('刷新续接的局部测量不会覆盖已保存的原始轮次指标', async () => {
  const key = `cvTurnSpeedV1:${CONV}:u1`;
  const saved = { source: 'network', userMessageId: 'u1', ttftMs: 1000,
    tps: 2, tokenCount: 6 };
  const stored = { [key]: saved };
  const { speed, emit } = fixture(stored);
  await speed.hydrate({ conversation_id: CONV,
    mapping: { user: { message: { id: 'u1', author: { role: 'user' } } } } });
  // F5 后的新文档看不到 u1 的原始 POST；同页其他用户消息的观测也不能顶替。
  speed.beginRound({ startMs: 5000, userMessageId: 'u1', resumed: true });
  emit({ userMessageId: 'u0', requestStartMs: 5000, firstTextAtMs: 6000, lastTextAtMs: 6000,
    textChunks: 1, textChars: 2, completedAtMs: 7000 });
  speed.finishRound();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stored[key], saved);
  assert.equal(speed.lookup(CONV, 'u1').ttftMs, 1000);
  assert.equal(speed.lookup(CONV, 'u1').tps, 2);
});
