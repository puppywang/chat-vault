import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const pageSource = fs.readFileSync(new URL('../extensions/chatgpt-sync/page-conversation.js', import.meta.url), 'utf8');
const contentSource = fs.readFileSync(new URL('../extensions/chatgpt-sync/content.js', import.meta.url), 'utf8');
const mergeSource = fs.readFileSync(new URL('../extensions/chatgpt-sync/conversation-merge.js', import.meta.url), 'utf8');
const CONV = '6ac75682-92dc-83ec-ab7f-9cea94338208';
const ORIGIN = 'https://chatgpt.com';
const flush = () => new Promise(resolve => setImmediate(resolve));

function response(body, { ok = true, type = 'application/json; charset=utf-8' } = {}) {
  return { ok, status: ok ? 200 : 500, body,
    headers: { get: name => ({ 'content-type': type, date: 'Thu, 08 Oct 2026 15:00:00 GMT' })[name.toLowerCase()] ?? null },
    clone() { return { text: async () => body }; } };
}

function mainWorld() {
  const listeners = [], posted = [];
  const window = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, origin) => { assert.equal(origin, ORIGIN); posted.push(data); },
  };
  const calls = [];
  window.fetch = (input, init) => { calls.push([input, init]); return Promise.resolve(response('{"mapping":{}}')); };
  const context = { window, location: { href: `${ORIGIN}/c/${CONV}`, origin: ORIGIN }, URL };
  vm.runInNewContext(pageSource, context);
  const send = data => listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data }));
  return { window, posted, calls, send, conversations: () => posted.filter(p => p.kind === 'conversation') };
}

test('只克隆页面自己的 GET 对话响应；content.js 报到前留住最新一份', async () => {
  const m = mainWorld();
  const r = m.window.fetch(`/backend-api/conversation/${CONV}`);
  await flush(); await flush();
  assert.equal(m.conversations().length, 0, '尚未报到，不投递');
  m.send({ __chatVaultPageConversationReadyV1: true });
  assert.equal(m.posted[0].kind, 'hello');
  const [got] = m.conversations();
  assert.equal(got.conversationId, CONV);
  assert.equal(got.text, '{"mapping":{}}');
  assert.equal(got.serverDate, 'Thu, 08 Oct 2026 15:00:00 GMT');
  assert.equal((await r).body, '{"mapping":{}}', '交给页面的 Response 原样返回');
  m.send({ __chatVaultPageConversationReadyV1: true });
  assert.equal(m.conversations().length, 1, '交付后即释放，不重复投递');
});

test('其他请求一律不碰：POST、子路径、带查询串、失败与非 JSON 响应', async () => {
  const m = mainWorld();
  m.send({ __chatVaultPageConversationReadyV1: true });
  m.window.fetch(`/backend-api/conversation/${CONV}`, { method: 'POST' });
  m.window.fetch(`/backend-api/conversation/${CONV}/stream_status`);
  m.window.fetch(`/backend-api/conversation/${CONV}?x=1`);
  m.window.fetch('/backend-api/f/conversation', { method: 'POST' });
  m.window.fetch(`https://example.com/backend-api/conversation/${CONV}`);
  await flush(); await flush();
  assert.equal(m.conversations().length, 0);
  // 包装在加载时就绑定了原生 fetch：用返回 HTML 的原生 fetch 另起一个实例
  const failing = (() => {
    const listeners = [], posted = [];
    const window = { addEventListener: (t, fn) => listeners.push(fn), postMessage: d => posted.push(d),
      fetch: () => Promise.resolve(response('<html>', { type: 'text/html' })) };
    vm.runInNewContext(pageSource, { window, location: { href: `${ORIGIN}/`, origin: ORIGIN }, URL });
    listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data: { __chatVaultPageConversationReadyV1: true } }));
    window.fetch(`/backend-api/conversation/${CONV}`);
    return posted;
  })();
  await flush(); await flush();
  assert.equal(failing.filter(p => p.kind === 'conversation').length, 0, '非 JSON 不投递');
});

test('页面注入关闭后不再克隆', async () => {
  const m = mainWorld();
  m.send({ __chatVaultPageConversationReadyV1: true });
  m.send({ __chatVaultPageConversationControlV1: true, enabled: false });
  m.window.fetch(`/backend-api/conversation/${CONV}`);
  await flush(); await flush();
  assert.equal(m.conversations().length, 0);
});

function contentWorld({ fetchImpl = null } = {}) {
  const timers = [], listeners = [], fetches = [], sent = [], posted = [], writes = [], watchers = [];
  const location = { pathname: `/c/${CONV}`, origin: ORIGIN };
  const window = {
    __cvTurns: { watchStreaming(cb) { watchers.push(cb); }, isStreaming: () => false, renderTurns: () => ({ turns: 1, anchored: 2 }) },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, origin) => { assert.equal(origin, ORIGIN); posted.push(data); },
  };
  const context = vm.createContext({
    document: { body: {}, visibilityState: 'visible', addEventListener() {}, hasFocus: () => true, querySelectorAll: () => [] },
    location, window,
    fetch: async (url, init) => {
      fetches.push(String(url));
      const custom = fetchImpl ? await fetchImpl(String(url), init) : null;
      return custom || { ok: true, status: 200, json: async () => ({ accessToken: 't' }), headers: { get: () => null } };
    },
    chrome: {
      storage: { local: { get: async (defaults) => typeof defaults === 'object' ? defaults : {}, set: async (v) => { writes.push(v); } }, onChanged: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, sendMessage: async (msg) => { sent.push(msg); return { ok: true }; } },
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cancelled = true; },
    setInterval: () => 1, clearInterval() {},
    crypto: { randomUUID: () => 'run' }, performance: { now: () => 0 }, console, JSON, Date, Promise,
  });
  context.globalThis = context;
  vm.runInContext(mergeSource, context);
  vm.runInContext(contentSource, context);
  const deliver = data => listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data }));
  const runTimers = async ms => { for (let i = 0; i < 5; i++) await flush(); for (const t of timers.filter(x => x.ms === ms && !x.cancelled)) { t.cancelled = true; await t.fn(); } await flush(); };
  return { fetches, sent, posted, deliver, runTimers, timers, writes, watchers };
}

test('进入对话：复用页面自己的对话响应上传，不再下载整段对话', async () => {
  const c = contentWorld();
  assert.ok(c.posted.some(p => p.__chatVaultPageConversationReadyV1 === true), 'content.js 启动即报到');
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  const conv = { conversation_id: CONV, current_node: 'n0', update_time: 100, mapping: { n0: { id: 'n0', message: null, parent: null } } };
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', conversationId: CONV,
    text: JSON.stringify(conv), receivedAtMs: Date.now(), serverDate: null });
  await flush(); await flush();
  await c.runTimers(1500);   // 进入对话的 settle 同步
  await flush();
  assert.equal(c.fetches.filter(u => u.includes('/backend-api/conversation/')).length, 0, '没有自行下载对话');
  const uploads = c.sent.filter(m => m.type === 'sync');
  assert.equal(uploads.length, 1, '同一份数据只上传一次');
  assert.equal(uploads[0].payload.conversation.conversation_id, CONV);
  assert.equal(c.fetches.filter(u => u.includes('/api/auth/session')).length, 0, '无图片时不读登录态');
});

test('页面脚本未应答（旧注册/未刷新）：不自己下载，也不上传', async () => {
  const c = contentWorld();
  await c.runTimers(1500);
  await flush(); await flush();
  assert.equal(c.fetches.filter(u => u.includes('/backend-api/conversation')).length, 0);
  assert.equal(c.sent.filter(m => m.type === 'sync').length, 0);
});

test('别的对话或格式不对的数据不被采用', async () => {
  const c = contentWorld();
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', conversationId: '11111111-1111-1111-1111-111111111111',
    text: JSON.stringify({ conversation_id: '11111111-1111-1111-1111-111111111111', current_node: 'n', mapping: {} }) });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', conversationId: CONV, text: '{not json' });
  await flush();
  assert.equal(c.sent.filter(m => m.type === 'sync').length, 0);
});

// ---- 0.12.9：新前端的分页分支接口 + 发送请求字段观测 ----
test('也克隆新前端的 /backend-api/conversations/<id>?num_turns=… 当前分支消息列表', async () => {
  const m = mainWorld();
  m.send({ __chatVaultPageConversationReadyV1: true });
  m.window.fetch(`/backend-api/conversations/${CONV}?num_turns=10&include_has_versions=true`);
  await flush(); await flush();
  const [got] = m.conversations();
  assert.equal(got.shape, 'branch');
  assert.equal(got.query, '?num_turns=10&include_has_versions=true');
  m.window.fetch(`/backend-api/conversation/${CONV}`);
  await flush(); await flush();
  assert.equal(m.conversations()[1].shape, 'full');
});

test('发送请求只观测模式字段与顶层字段名，不带正文', async () => {
  const m = mainWorld();
  m.window.fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({
    conversation_id: CONV, model: 'gpt-6.1-sol-wm', product_experience: 'work', thinking_effort: 'max',
    messages: [{ id: '11111111-1111-4111-8111-111111111111', author: { role: 'user' }, content: { parts: ['SECRET PROMPT'] } }] }) });
  const send = m.posted.find(p => p.kind === 'send');
  assert.equal(send.conversationId, CONV);
  assert.equal(send.userMessageId, '11111111-1111-4111-8111-111111111111');
  assert.equal(send.fields.product_experience, 'work');
  assert.equal(send.fields.model, 'gpt-6.1-sol-wm');
  assert.ok(send.keys.includes('messages'));
  assert.equal(JSON.stringify(send).includes('SECRET PROMPT'), false);
});

function branchPage(updateTime, complete = true) {
  return JSON.stringify({ conversation_id: CONV, update_time: updateTime, current_node: 'b',
    page_info: { has_previous_page: !complete, has_next_page: false, start_cursor: 'a', end_cursor: 'b' },
    messages: [{ id: 'a', author: { role: 'user' }, content: { parts: ['p'] }, metadata: {}, create_time: 1 },
      { id: 'b', author: { role: 'assistant' }, content: { parts: ['r'] }, metadata: {}, create_time: 2 }] });
}

test('页面分支与已上传的内容相同：不重复上传，也不自己下载', async () => {
  const c = contentWorld();
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  // 先由页面交来整段对话完成一次上传（与随后的分页是同一批消息）
  const page = JSON.parse(branchPage(100));
  const full = { conversation_id: CONV, current_node: 'b', update_time: 100, mapping: {
    root: { id: 'root', message: null, parent: null }, a: { id: 'a', message: page.messages[0], parent: 'root' },
    b: { id: 'b', message: page.messages[1], parent: 'a' } } };
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', shape: 'full', conversationId: CONV,
    text: JSON.stringify(full), receivedAtMs: Date.now(), serverDate: null });
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(c.sent.filter(m => m.type === 'sync').length, 1);
  // 页面随后读当前分支：内容没变
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', shape: 'branch', conversationId: CONV,
    text: branchPage(100), receivedAtMs: Date.now(), serverDate: null });
  for (let i = 0; i < 6; i++) await flush();
  const fetchesBefore = c.fetches.length;
  await c.runTimers(120000);   // 定时回补
  assert.equal(c.fetches.filter(u => u.includes('/backend-api/conversation')).length, 0, '没有自行下载');
  assert.equal(c.fetches.length, fetchesBefore);
  assert.equal(c.sent.filter(m => m.type === 'sync').length, 1, '没有重复上传');
});

test('不完整的分支（has_previous_page=true）不替代整段快照，也不上传', async () => {
  const c = contentWorld();
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', shape: 'branch', conversationId: CONV,
    text: branchPage(200, false), receivedAtMs: Date.now(), serverDate: null });
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(c.sent.filter(m => m.type === 'sync' && m.payload.conversation.cv_branch).length, 0, '分支形态从不当整段上传');
});

// ---- 0.12.10：Codex 页面 thread/tokenUsage/updated ----
function codexWorld() {
  const listeners = [], posted = [], sockets = [];
  class FakeSocket { constructor(url) { this.url = url; this.handlers = {}; sockets.push(this); }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    emit(data) { for (const fn of this.handlers.message || []) fn({ data }); } }
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); }, postMessage: d => posted.push(d),
    fetch: () => Promise.resolve(response('{}')), WebSocket: FakeSocket };
  vm.runInNewContext(pageSource, { window, location: { href: `${ORIGIN}/local/x`, origin: ORIGIN }, URL, Proxy, Reflect });
  const send = data => listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data }));
  return { window, posted, send, usage: () => posted.filter(p => p.kind === 'codexUsage') };
}
const THREAD = '01a11a8b-97be-70fc-b163-a428fd770853';
const usageMessage = (extra = {}) => JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: THREAD,
  turnId: '01a11a8b-b637-7458-bfd2-18af03d490fe', tokenUsage: { modelContextWindow: 400000,
    total: { totalTokens: 1500000, inputTokens: 1400000, cachedInputTokens: 1200000, cacheWriteInputTokens: 0, outputTokens: 100000, reasoningOutputTokens: 60000 },
    last: { totalTokens: 250000, inputTokens: 240000, cachedInputTokens: 230000, cacheWriteInputTokens: 0, outputTokens: 10000, reasoningOutputTokens: 5000 }, ...extra } } });

test('Codex 页面的用量推送：只取数字；content.js 报到前按线程缓存，报到后交付', () => {
  const w = codexWorld();
  const socket = new w.window.WebSocket('wss://codex-cloud-backend.chatgpt.com/');
  socket.emit(usageMessage());
  assert.equal(w.usage().length, 0, '报到前不投递');
  w.send({ __chatVaultPageConversationReadyV1: true });
  const [u] = w.usage();
  assert.equal(u.threadId, THREAD);
  assert.equal(u.total.inputTokens, 1400000);
  assert.equal(u.last.totalTokens, 250000);
  assert.equal(u.modelContextWindow, 400000);
  socket.emit(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: THREAD, delta: 'SECRET' } }));
  socket.emit(usageMessage({ total: { inputTokens: -5, outputTokens: 'x' } }));
  assert.equal(w.usage().length, 2);
  assert.equal(w.usage()[1].total.inputTokens, null, '非法数字不采用');
  assert.equal(JSON.stringify(w.posted).includes('SECRET'), false, '不转发其他消息内容');
  const other = new w.window.WebSocket('wss://example.com/ws');
  other.emit(usageMessage());
  assert.equal(w.usage().length, 2, '只看 codex-cloud-backend 的连接');
});

test('content.js 收到用量推送后节流写入扩展本地，按线程分别记录', async () => {
  const c = contentWorld();
  const child = '01a11a8d-2582-76c4-9f03-de9e51424485';
  const total = n => ({ totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'codexUsage', threadId: THREAD, turnId: '01a11a8b-b637-7458-bfd2-18af03d490fe', total: total(100), last: total(10), modelContextWindow: 400000, at: 1 });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'codexUsage', threadId: THREAD, turnId: '01a11a8b-b637-7458-bfd2-18af03d490fe', total: total(200), last: total(20), modelContextWindow: 400000, at: 2 });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'codexUsage', threadId: child, turnId: null, total: total(50), last: total(5), modelContextWindow: 400000, at: 3 });
  assert.equal(c.writes.length, 0, '节流：不逐条写');
  await c.runTimers(3000);
  const merged = Object.assign({}, ...c.writes);
  assert.equal(merged[`cvCodexUsageV1:${THREAD}`].total.inputTokens, 200, '同一线程取最新累计值');
  assert.equal(Object.keys(merged[`cvCodexUsageV1:${THREAD}`].turns).length, 1);
  assert.equal(merged[`cvCodexUsageV1:${child}`].total.inputTokens, 50, '子 agent 线程单独记录');
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'codexUsage', threadId: 'not-a-uuid', total: total(1) });
  await c.runTimers(3000);
  assert.equal(c.writes.some(w => Object.keys(w).some(k => k.includes('not-a-uuid'))), false);
});

test('扩展重载：旧隔离实例迟到的「关闭」不能关掉新实例刚打开的采集', async () => {
  const m = mainWorld();
  m.send({ __chatVaultPageConversationReadyV1: true });
  m.send({ __chatVaultPageConversationControlV1: true, enabled: true, instance: 2000 });   // 新实例
  m.send({ __chatVaultPageConversationControlV1: true, enabled: false });                  // 旧版实例（无 instance）
  m.send({ __chatVaultPageConversationControlV1: true, enabled: false, instance: 1000 });  // 更早的实例
  m.window.fetch(`/backend-api/conversation/${CONV}`);
  await flush(); await flush();
  assert.equal(m.conversations().length, 1, '仍在采集');
  m.send({ __chatVaultPageConversationControlV1: true, enabled: false, instance: 2000 });  // 最新实例自己关闭
  m.window.fetch(`/backend-api/conversation/${CONV}`);
  await flush(); await flush();
  assert.equal(m.conversations().length, 1, '最新实例的关闭仍然生效');
});

test('账号额度：复用页面自己的 conversation/init 响应，只取额度字段，content.js 报到前先留住', async () => {
  const listeners = [], posted = [];
  const window = { addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); }, postMessage: data => posted.push(data) };
  const body = JSON.stringify({ type: 'conversation_detail_metadata', banner_info: null, secret_field: 'x',
    blocked_features: [{ description: '功能将受限至 10月17日。回答质量可能会降低。', limit: 50, resets_after: '2026-10-17T10:26:24Z' }],
    model_limits: [{ model_slug: 'gpt-6-pro', resets_after: '2026-10-17T10:26:24Z' }],
    limits_progress: [{ feature_name: 'deep_research', remaining: 125, reset_after: '2026-11-14T13:17:38Z' }], default_model_slug: 'gpt-6-thinking' });
  window.fetch = () => Promise.resolve(response(body));
  vm.runInNewContext(pageSource, { window, location: { href: `${ORIGIN}/c/${CONV}`, origin: ORIGIN }, URL });
  await window.fetch('/backend-api/conversation/init', { method: 'POST', body: '{}' });
  await window.fetch('/backend-api/conversation/init');   // GET 不算
  await flush(); await flush();
  assert.equal(posted.filter(p => p.kind === 'limits').length, 0, '尚未报到，不投递');
  listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data: { __chatVaultPageConversationReadyV1: true } }));
  const got = posted.filter(p => p.kind === 'limits');
  assert.equal(got.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(got[0].limits).sort())),
    ['blocked_features', 'default_model_slug', 'intended_default_model_slug', 'limits_progress', 'model_limits']);
  assert.equal(got[0].limits.blocked_features[0].limit, 50);
  assert.ok(!JSON.stringify(got[0]).includes('secret_field'), '只转发额度字段');
});

// ---- 0.13.17：断流恢复轮询里 stream_status 仍是 IS_STREAMING 时，对话读取不走网络 ----
function recoveryWorld({ rateLimited = false } = {}) {
  const listeners = [], posted = [], calls = [];
  let streamStatus = 'IS_STREAMING', offsetMs = 0;
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); }, postMessage: d => posted.push(d) };
  window.fetch = (input) => {
    calls.push(String(input));
    if (String(input).endsWith('/stream_status')) return Promise.resolve(response(JSON.stringify({ status: streamStatus })));
    if (rateLimited) return Promise.resolve(response('{"detail":"rate limited"}', { ok: false }));
    return Promise.resolve(response(`{"n":${calls.length}}`));
  };
  // 时钟可拨快（测 5 分钟限频），但仍随真实时间走，配对等待的循环才能结束
  const RealDate = Date;
  const ClockDate = class extends RealDate { static now() { return RealDate.now() + offsetMs; } };
  vm.runInNewContext(pageSource, { window, location: { href: `${ORIGIN}/c/${CONV}`, origin: ORIGIN }, URL, Response, setTimeout, Date: ClockDate });
  listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data: { __chatVaultPageConversationReadyV1: true } }));
  const branch = `/backend-api/conversations/${CONV}?num_turns=10&include_has_versions=true`;
  const status = `/backend-api/conversation/${CONV}/stream_status`;
  const control = data => listeners.forEach(fn => fn({ source: window, origin: ORIGIN,
    data: { __chatVaultPageConversationControlV1: true, enabled: true, instance: 1, ...data } }));
  return { window, posted, calls, branch, status, control, set: s => { streamStatus = s; }, advance: ms => { offsetMs += ms; },
    network: () => calls.filter(u => u === branch).length, skips: () => posted.filter(p => p.kind === 'recoverySkip').length,
    throttles: () => posted.filter(p => p.kind === 'recoveryThrottle').length };
}
const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };

test('恢复轮询：同一轮 stream_status 为 IS_STREAMING 时还给页面上一份对话，不走网络', async () => {
  const w = recoveryWorld();
  const [first] = await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);   // 第一轮：没有缓存，照常请求
  assert.equal(await first.clone().text(), '{"n":1}');
  await settle();
  const [second] = await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(w.network(), 1, '第二轮没有再读对话');
  assert.equal(await second.text(), '{"n":1}', '原样还给上一份');
  assert.equal(w.skips(), 1);
  await settle();
  assert.equal(w.posted.filter(p => p.kind === 'conversation').length, 1, '还回去的旧响应不当新快照交给 content.js');
});

test('恢复轮询：对话请求先于 stream_status 发出也能配对', async () => {
  const w = recoveryWorld();
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  await settle();
  await new Promise(r => setTimeout(r, 1600));   // 超过配对窗口：上一轮的 stream_status 不能算本轮
  const conv = w.window.fetch(w.branch);
  await new Promise(r => setTimeout(r, 60));
  w.window.fetch(w.status);
  await conv;
  assert.equal(w.network(), 1);
  assert.equal(w.skips(), 1);
});

test('恢复轮询：stream_status 不再是 IS_STREAMING 时照常读对话', async () => {
  const w = recoveryWorld();
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  await settle();
  await new Promise(r => setTimeout(r, 1600));   // 真实轮询每轮至少隔 5 秒，不会配到上一轮的状态
  w.set('COMPLETE');
  const [fresh] = await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(w.network(), 2);
  assert.notEqual(await fresh.clone().text(), '{"n":1}');
  assert.equal(w.skips(), 0);
});

test('恢复轮询没有可还的缓存（一直被 429）：同一对话 5 分钟内只放行一次网络读取，其余回 429 并带 Retry-After', async () => {
  const w = recoveryWorld({ rateLimited: true });
  const [first] = await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);   // 网络读取，被真实限流
  assert.equal(first.status, 500, '真实响应原样交给页面');
  await settle();
  await new Promise(r => setTimeout(r, 1600));   // 下一轮（真实间隔 ≥ 10 秒）
  const [second] = await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(w.network(), 1, '5 分钟内不再走网络');
  assert.equal(second.status, 429);
  const retryAfter = Number(second.headers.get('retry-after'));
  assert.ok(retryAfter > 290 && retryAfter <= 300, `Retry-After=${retryAfter}`);
  assert.equal(w.throttles(), 1);
  await settle();
  assert.equal(w.posted.filter(p => p.kind === 'conversation').length, 0, '限流回应不当快照交付');
  w.advance(5 * 60e3);                            // 5 分钟后放行一次
  await new Promise(r => setTimeout(r, 1600));
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(w.network(), 2);
  assert.equal(w.throttles(), 1);
});

test('限频间隔取自扩展设置：1 分钟时 Retry-After 随之变短，0 时不限频', async () => {
  const w = recoveryWorld({ rateLimited: true });
  w.control({ recoveryReadMinMs: 60e3 });
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  await settle();
  await new Promise(r => setTimeout(r, 1600));
  const [limited] = await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter > 50 && retryAfter <= 60, `Retry-After=${retryAfter}`);
  w.control({ recoveryReadMinMs: 0, instance: 2 });
  await new Promise(r => setTimeout(r, 1600));
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(w.network(), 2, '设为 0 后不再限频');
  assert.equal(w.throttles(), 1);
});

test('超过旧上限（32M 字符）的对话也进缓存，恢复轮询照样不走网络', async () => {
  const big = `{"pad":"${'x'.repeat(33e6)}"}`;
  const listeners = [], posted = [], calls = [];
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); }, postMessage: d => posted.push(d) };
  window.fetch = (input) => {
    calls.push(String(input));
    if (String(input).endsWith('/stream_status')) return Promise.resolve(response('{"status":"IS_STREAMING"}'));
    return Promise.resolve(response(big));
  };
  vm.runInNewContext(pageSource, { window, location: { href: `${ORIGIN}/c/${CONV}`, origin: ORIGIN }, URL, Response, setTimeout });
  const branch = `/backend-api/conversations/${CONV}?num_turns=10&include_has_versions=true`;
  const status = `/backend-api/conversation/${CONV}/stream_status`;
  await Promise.all([window.fetch(branch), window.fetch(status)]);
  await settle();
  const [again] = await Promise.all([window.fetch(branch), window.fetch(status)]);
  assert.equal(calls.filter(u => u === branch).length, 1, '第二轮用缓存');
  assert.equal((await again.text()).length, big.length);
});

test('限频只管 IS_STREAMING 的恢复轮询：本轮结束（COMPLETE）照常读', async () => {
  const w = recoveryWorld({ rateLimited: true });
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  await settle();
  await new Promise(r => setTimeout(r, 1600));
  w.set('COMPLETE');
  await Promise.all([w.window.fetch(w.branch), w.window.fetch(w.status)]);
  assert.equal(w.network(), 2, '拿最终结果不受 5 分钟限制');
  assert.equal(w.throttles(), 0);
});

test('不在恢复轮询里（没见过 stream_status）：对话请求直接走网络，不等待', async () => {
  const w = recoveryWorld();
  await w.window.fetch(w.branch);
  await settle();
  await w.window.fetch(w.branch);
  assert.equal(w.network(), 2);
  assert.equal(w.skips(), 0);
});

test('超大对话分块发给后台：每块不切开代理对，拼回与整段序列化一致', async () => {
  // runtime.sendMessage 单条上限 64 MiB；8M 码元一块。两种奇偶对齐保证切点一定落在代理对上过一次。
  for (const pad of ['', 'x']) {
    const c = contentWorld();
    c.deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
    const text = '😀'.repeat(4.3e6);
    const conv = { conversation_id: CONV, title: `big${pad}`, current_node: 'n1', update_time: 100, mapping: {
      n0: { id: 'n0', message: null, parent: null, children: ['n1'] },
      n1: { id: 'n1', parent: 'n0', children: [], message: { id: 'n1', author: { role: 'tool' }, create_time: 1,
        content: { content_type: 'text', parts: [text] } } } } };
    c.deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', conversationId: CONV,
      text: JSON.stringify(conv), receivedAtMs: Date.now(), serverDate: null });
    await flush(); await flush();
    await c.runTimers(1500);
    for (let i = 0; i < 20 && !c.sent.some(m => m.type === 'sync'); i++) await flush();
    const chunks = c.sent.filter(m => m.type === 'syncChunk');
    const final = c.sent.filter(m => m.type === 'sync');
    assert.equal(final.length, 1, `pad=${JSON.stringify(pad)}：上传一次`);
    assert.equal(final[0].payload, undefined, '大对话不再整份塞进单条消息');
    assert.equal(final[0].uploadId, chunks[0].uploadId);
    assert.ok(chunks.length >= 2);
    for (const [i, ch] of chunks.entries()) {
      assert.equal(ch.index, i);
      assert.equal(ch.total, chunks.length);
      assert.ok(ch.data.length <= 8 * 1024 * 1024);
      if (i < chunks.length - 1) assert.ok(!/[\uD800-\uDBFF]$/.test(ch.data), '块尾不是高代理');
    }
    const joined = chunks.map(ch => ch.data).join('');
    const parsed = JSON.parse(joined);
    assert.equal(parsed.conversation.conversation_id, CONV);
    assert.equal(parsed.conversation.mapping.n1.message.content.parts[0], text, '拼回后正文无损');
  }
});

// ---- 0.13.22：整页打开时服务端渲染预取到的对话；本页跑完一轮后的补读 ----
function ssrWorld(loaderValue, { delayContext = false } = {}) {
  const listeners = [], posted = [], timers = [];
  const window = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, origin) => { assert.equal(origin, ORIGIN); posted.push(data); },
    fetch: () => Promise.resolve(response('{}')),
  };
  const context = () => ({ state: { loaderData: { 'app.route': {},
    'conversation-layout.route': { conversation: Promise.resolve(loaderValue) } } } });
  if (!delayContext) window.__reactRouterContext = context();
  vm.runInNewContext(pageSource, { window, location: { href: `${ORIGIN}/c/${CONV}`, origin: ORIGIN, pathname: `/c/${CONV}` },
    URL, Response, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  listeners.forEach(fn => fn({ source: window, origin: ORIGIN, data: { __chatVaultPageConversationReadyV1: true } }));
  return { window, posted, timers, context, conversations: () => posted.filter(p => p.kind === 'conversation') };
}

test('整页打开时服务端已预取（loaded）：把 HTML 里那份分支交给 content.js，不发请求', async () => {
  const branch = JSON.parse(branchPage(300));
  const w = ssrWorld({ status: 'loaded', conversation: branch, requestDurationMs: 420 });
  await flush(); await flush();
  const [got] = w.conversations();
  assert.ok(got, '已交付');
  assert.equal(got.conversationId, CONV);
  assert.equal(got.shape, 'branch');
  assert.deepEqual(JSON.parse(got.text), branch);
});

test('服务端预取被限流（rate_limited）：不交付，等页面自己再读', async () => {
  const w = ssrWorld({ status: 'rate_limited', requestDurationMs: 599, retryAfterMs: 8000 });
  await flush(); await flush();
  assert.equal(w.conversations().length, 0);
});

test('React Router 上下文晚于脚本出现：轮询等到它，再交付', async () => {
  const branch = JSON.parse(branchPage(301));
  const w = ssrWorld({ status: 'loaded', conversation: branch }, { delayContext: true });
  await flush();
  assert.equal(w.conversations().length, 0);
  assert.equal(w.timers.length, 1, '还没出现上下文：排了下一次检查');
  w.window.__reactRouterContext = w.context();
  w.timers.shift().fn();
  await flush(); await flush();
  assert.equal(w.conversations().length, 1);
});

test('本页新建、跑完一轮后页面不再读：一轮结束时补读一次并上传，60 秒内不重复', async () => {
  const conv = { conversation_id: CONV, current_node: 'b', update_time: 500, mapping: {
    root: { id: 'root', message: null, parent: null, children: ['a'] },
    a: { id: 'a', parent: 'root', children: ['b'], message: { id: 'a', author: { role: 'user' }, create_time: 1, content: { parts: ['q'] } } },
    b: { id: 'b', parent: 'a', children: [], message: { id: 'b', author: { role: 'assistant' }, create_time: 2, content: { parts: ['r'] } } } } };
  const c = contentWorld({ fetchImpl: async (url) => url.endsWith(`/backend-api/conversation/${CONV}`)
    ? { ok: true, status: 200, json: async () => conv, headers: { get: () => null } } : null });
  c.deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  assert.equal(c.watchers.length, 1);
  // 进入对话时的那次同步先跑完（等不到页面数据，不补读）
  await c.runTimers(1500);
  await c.runTimers(6000);
  assert.equal(c.fetches.filter(u => u.includes('/backend-api/conversation/')).length, 0, '进入对话时不自己下载');
  const endTurn = async () => {
    void c.watchers[0]({ measuredMs: 1000, startedAtMs: 1, endedAtMs: 2, userMessageId: 'a', path: `/c/${CONV}` });
    for (let i = 0; i < 10; i++) await flush();
    for (const t of c.timers.filter(x => x.ms === 1500 && !x.cancelled)) { t.cancelled = true; void t.fn(); }
    for (let i = 0; i < 10; i++) await flush();
    await c.runTimers(6000);   // 先等页面数据，等不到才补读
    for (let i = 0; i < 20; i++) await flush();
  };
  await endTurn();
  const reads = () => c.fetches.filter(u => u.endsWith(`/backend-api/conversation/${CONV}`)).length;
  assert.equal(reads(), 1, '补读一次');
  const uploads = c.sent.filter(m => m.type === 'sync');
  assert.equal(uploads.length, 1, '补读后上传');
  assert.equal(uploads[0].payload.conversation.current_node, 'b');
  await endTurn();
  assert.equal(reads(), 1, '60 秒内不再补读（第二轮已有页面数据可用）');
});
