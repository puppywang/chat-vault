import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/dots.js', import.meta.url), 'utf8');
const thread = '01a0f178-337c-76ad-ab15-57376055ec42';
const dot = { id: 'aeon-1', display_name: 'little', messaging_room_id: 'room-1' };
const room = { id: 'room-1', name: 'little', members: [
  { account_user_id: 'human', role: 'user' }, { account_user_id: 'bot', role: 'user', aeon_id: dot.id },
], created_at: '2026-09-30T08:00:00Z', updated_at: '2026-09-30T09:00:00Z' };
function message(i) {
  return { id: `room~CalpicoMessage~Sentinel_${String(i).padStart(32, '0')}`,
    role: 'user', account_user_id: i % 2 ? 'bot' : 'human',
    created_at: new Date(Date.parse(room.created_at) + i * 1000).toISOString(),
    content: { text: `message ${i}`, attachments: [{ name: 'keep-me.zip' }] } };
}
function fixture() {
  const context = vm.createContext({ location: { pathname: `/dots/${thread}` },
    document: { querySelectorAll: () => [] } });
  vm.runInContext(source, context);
  return context.__cvDots;
}

test('直接打开 dots 识别独立会话键，成员身份而非 role 区分助手', () => {
  const dots = fixture();
  assert.equal(dots.conversationId(), `dots-${thread}`);
  assert.equal(dots.conversationId(`/c/${thread}`), thread);
  assert.equal(dots.conversationId('/settings'), null);
  const conv = dots.normalize(thread, dot, room, [message(1), message(0)]);
  assert.equal(conv.mapping[message(1).id].message.author.role, 'assistant');
  assert.equal(conv.mapping[message(0).id].message.author.role, 'user');
  assert.equal(conv.mapping[message(0).id].message.metadata.dots_message.content.attachments[0].name, 'keep-me.zip');
  assert.equal(conv.current_node, message(1).id);
  assert.equal(conv.mapping[message(1).id].parent, message(0).id);
});

test('dots 按 before 回补完整历史，null prev_cursor 不截成32条；后续只补到缓存交集', async () => {
  const dots = fixture(), paths = [];
  let all = Array.from({ length: 58 }, (_, i) => message(i));
  const get = async path => {
    paths.push(path);
    if (path.includes('/by-thread/')) return dot;
    if (!path.includes('/messages?')) return room;
    const url = new URL(path, 'https://chatgpt.com');
    const before = url.searchParams.get('before');
    const until = before ? all.findIndex(m => m.id === before) : all.length;
    return { items: all.slice(Math.max(0, until - 32), until), prev_cursor: null };
  };
  const conv = await dots.fetchConversation(thread, get);
  assert.equal(Object.keys(conv.mapping).length, 58);
  assert.equal(paths.filter(p => p.includes('before=')).length, 1);
  paths.length = 0;
  all = Array.from({ length: 100 }, (_, i) => message(i));
  const updated = await dots.fetchConversation(thread, get);
  assert.equal(Object.keys(updated.mapping).length, 100);
  assert.equal(paths.filter(p => p.includes('before=')).length, 1, '断开期间>32条消息也不漏掉');
  assert.equal(paths.filter(p => p.includes('/by-thread/')).length, 0);
});

test('dots 缺少可靠身份时拒绝把所有 user 消息当成人类提问', () => {
  assert.throws(() => fixture().normalize(thread, dot, { ...room, members: [] }, [message(0)]), /成员身份/);
});

test('dots 历史输出分词缓存；不伪造 TTFT/TPS，改记首条回复用时与条数', async () => {
  const context = vm.createContext({ location: { pathname: `/dots/${thread}`, origin: 'https://chatgpt.com' },
    document: { querySelectorAll: () => [] }, window: { addEventListener() {} },
    chrome: { storage: { local: { get: async defaults => defaults }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async request => { calls++; return { ok: true, tokens: request.texts.join('').length }; } } } });
  let calls = 0;
  vm.runInContext(source, context);
  const speedSource = fs.readFileSync(new URL('../extensions/chatgpt-sync/speed.js', import.meta.url), 'utf8');
  vm.runInContext(speedSource, context);
  const conv = context.__cvDots.normalize(thread, dot, room, [message(0), message(1)]);
  await context.__cvSpeed.hydrate(conv);
  await context.__cvSpeed.hydrate(conv);
  const metric = context.__cvSpeed.lookup(conv.conversation_id, message(0).id);
  assert.equal(calls, 1);
  assert.equal(metric.tokenCount, 'message 1'.length);
  assert.equal(metric.ttftMs, 1000, '首条回复：你发出 → Dot 第一条消息（接口时间戳）');
  assert.equal(metric.messageCount, 1);
  assert.equal(metric.tps, null);
  assert.equal(metric.tpsReason, '整条送达');
  assert.equal(metric.source, 'dots-message');
});

test('dots 归一化消息复用原有分轮逻辑，并区分无回复的最后一轮', () => {
  // Deterministic local fixture; no access to the user's database or browser in tests.
  const dots = fixture(), conv = dots.normalize(thread, dot, room, [message(0), message(1), message(2)]);
  const context = vm.createContext({ location: { pathname: `/dots/${thread}` } });
  vm.runInContext(fs.readFileSync(new URL('../extensions/chatgpt-sync/turns.js', import.meta.url), 'utf8'), context);
  const turns = context.__cvTurns.turnsOf(conv);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].count, 1);
  assert.equal(turns[0].ms, 1000);
  assert.equal(turns[1].count, 0);
});

test('dots 冷启动会获取房间并渲染；SPA 离开后旧异步结果不能重画', async () => {
  const timers = [], intervals = [], rendered = [];
  let cleared = 0;
  const location = { pathname: `/dots/${thread}` };
  const context = vm.createContext({ location,
    document: { body: {}, visibilityState: 'visible', addEventListener() {} },
    window: { __cvTurns: { watchStreaming() {}, isStreaming: () => false,
      clear: () => { cleared++; }, renderTurns: conv => { rendered.push(conv); return { turns: 1, anchored: 1 }; } } },
    chrome: { storage: { local: { get: async defaults => ({ ...defaults, auto: false }) },
      onChanged: { addListener() {} } }, runtime: { onMessage: { addListener() {} } } },
    fetch: async path => {
      const body = path === '/api/auth/session' ? { accessToken: 'test-only' }
        : path.includes('/by-thread/') ? dot : path.includes('/messages?') ? { items: [message(0), message(1)] } : room;
      return { ok: true, headers: { get: () => null }, json: async () => body };
    },
    MutationObserver: class { observe() {} },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout() {}, setInterval: (fn, ms) => intervals.push({ fn, ms }),
    crypto: { randomUUID: () => 'test-run' }, performance: { now: () => 0 }, console,
  });
  vm.runInContext(source, context);
  vm.runInContext(fs.readFileSync(new URL('../extensions/chatgpt-sync/content.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  timers.find(t => t.ms === 1500).fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].conversation_id, `dots-${thread}`);
  const oldConv = rendered[0];
  location.pathname = `/c/${thread}`;
  intervals.find(t => t.ms === 1000).fn();
  context.paintTurns(oldConv);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleared, 1);
  assert.equal(rendered.length, 1, 'dots 旧回包不能污染普通对话');
});
