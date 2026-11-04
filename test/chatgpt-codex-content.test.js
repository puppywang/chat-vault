import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../extensions/chatgpt-sync/${name}.js`, import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const ROOT = '01a0c40e-6e82-7033-8301-b436bf06d0ad';
const CHILD = '01a0c410-2e99-7fa1-8efb-f3c7e2f3c79f';
const ORIGIN = 'https://chatgpt.com';
const flush = () => new Promise(resolve => setImmediate(resolve));
const conversation = (id, node = 'latest') => ({ conversation_id: id, current_node: node, update_time: 1,
  mapping: { [node]: { parent: null, message: { id: node, author: { role: 'assistant' },
    metadata: { codex_sub_agent_activity: { agentThreadId: CHILD } }, content: { parts: [] } } } } });
function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body,
    headers: { get: name => headers[name.toLowerCase()] ?? null } };
}
// 0.13.18 起普通 /c/ 对话不再自己读历史：数据只由页面交来（page-conversation.js → postMessage）。
function fixture({ ready = true } = {}) {
  const requests = [], lookups = [], callbacks = {}, intervals = [], stored = {}, storageListeners = [], messageListeners = [];
  let listener;
  let now = Date.parse('2026-10-01T00:00:00Z');
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ console, Date: Clock, AbortController,
    crypto: { randomUUID: () => 'fixture-run' }, performance: { now: () => 0 },
    location: { pathname: `/c/${A}`, origin: ORIGIN },
    document: { body: {}, title: 'fixture', visibilityState: 'visible', hasFocus: () => true, addEventListener() {} },
    window: { __cvTurns: { watchStreaming(end, start, begin) { Object.assign(callbacks, { end, start, begin }); },
      isStreaming: () => false, clear() {} },
      addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn); }, postMessage() {} },
    chrome: { storage: { local: { get: async defaults => ({ ...defaults,
      auto: false, durations: false, injectionEnabled: true, syncEnabled: true }),
      set: async values => { Object.assign(stored, values); } },
      onChanged: { addListener(fn) { storageListeners.push(fn); } } }, runtime: {
      onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async () => ({ ok: true }) } },
    __cvCodexThread: { async resolve(conv, token, { signal }) {
      signal.throwIfAborted();
      lookups.push(conv);
      const auth = typeof token === 'function' ? await token() : token;
      assert.equal(auth, 'fixture-token');
      return { candidates: [{ threadId: ROOT, url: `https://chatgpt.com/local/${ROOT}?hostId=local` }] };
    } },
    fetch: async url => {
      requests.push(url);
      if (url === '/api/auth/session') return response(200, { accessToken: 'fixture-token' });
      throw new Error(`不应自己读历史：${url}`);
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout() {},
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
  });
  context.globalThis = context;
  vm.runInContext(read('conversation-merge'), context);
  vm.runInContext(read('content'), context);
  const deliver = data => messageListeners.forEach(fn => fn({ source: context.window, origin: ORIGIN, data }));
  if (ready) deliver({ __chatVaultPageConversationV1: true, kind: 'hello' });
  const request = message => new Promise(resolve => listener(message, {}, resolve));
  return { context, requests, lookups, callbacks, stored,
    /** 页面自己读到一份对话（整棵树） */
    page(conv) { deliver({ __chatVaultPageConversationV1: true, kind: 'conversation', shape: 'full',
      conversationId: conv.conversation_id, text: JSON.stringify(conv), receivedAtMs: now, serverDate: null }); },
    pause() { for (const fn of storageListeners) fn({ cvConversationPauseV1: { newValue: { at: now, reason: '429' } } }, 'local'); },
    sync: () => request({ type: 'syncNow' }),
    lookup: (id, deepScan = false) => request({ type: 'resolveCodexThread', deepScan,
      conversationId: id || context.location.pathname.split('/').at(-1) }),
    advance(ms) { now += ms; },
    route(id, check = true) { context.location.pathname = `/c/${id}`; if (check) intervals[0](); },
    now: () => now,
  };
}
const historyRequests = f => f.requests.filter(url => url.startsWith('/backend-api/conversation'));

test('页面读到的对话可反复复用：同步与多次查找都不读历史', async () => {
  const f = fixture();
  f.page(conversation(A));
  assert.equal((await f.sync()).ok, true);
  assert.equal((await f.lookup()).ok, true);
  assert.equal((await f.lookup()).ok, true);
  assert.equal(historyRequests(f).length, 0);
  assert.equal(f.lookups.length, 2);
  assert.equal(f.lookups[0], f.lookups[1]);
});

test('页面还没读到时，同时点击的查找一起等页面数据，只查一次', async () => {
  const f = fixture();
  const first = f.lookup(), second = f.lookup();
  await flush();
  f.page(conversation(A));
  const results = await Promise.all([first, second]);
  assert.ok(results.every(result => result.ok));
  assert.equal(historyRequests(f).length, 0);
  assert.equal(f.lookups.length, 1);
});

test('页面后来读到新分支：查找用最新的页面数据', async () => {
  const f = fixture();
  f.page(conversation(A));
  await f.sync();
  f.page(conversation(A, 'new-branch'));
  assert.equal((await f.lookup()).ok, true);
  assert.equal(f.lookups[0].current_node, 'new-branch');
  assert.equal(historyRequests(f).length, 0);
});

test('切换对话不会使用旧对话的页面数据；即使路由轮询尚未执行也校验 ID', async () => {
  for (const check of [true, false]) {
    const f = fixture();
    f.page(conversation(A));
    await f.sync();
    f.route(B, check);
    f.page(conversation(B));
    assert.equal((await f.lookup(B)).ok, true);
    assert.equal(f.lookups[0].conversation_id, B);
    assert.equal(historyRequests(f).length, 0);
  }
});

test('等页面数据时切换了路由：旧查找立即落空，迟到的旧对话数据不进入当前对话', async () => {
  const f = fixture();
  const old = f.lookup(A);
  await flush();
  f.route(B);
  const result = await old;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PAGE_DATA');
  f.page(conversation(A));          // 迟到的旧对话：当前路由是 B，丢弃
  f.page(conversation(B));
  assert.equal((await f.lookup(B)).ok, true);
  assert.deepEqual(f.lookups.map(c => c.conversation_id), [B]);
});

test('普通对话从不自己读历史：页面脚本未就绪时直接报错，连登录态也不取', async () => {
  const f = fixture({ ready: false });
  const result = await f.lookup();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_PAGE_DATA');
  assert.match(result.error, /刷新/);
  const sync = await f.sync();
  assert.equal(sync.ok, true);
  assert.match(sync.skipped, /刷新/);
  assert.equal(f.requests.length, 0);
});

test('429 暂停读取期间，页面数据照常可用', async () => {
  const f = fixture();
  f.pause();
  f.page(conversation(A));
  assert.equal((await f.sync()).ok, true);
  assert.equal((await f.lookup()).ok, true);
  assert.equal(historyRequests(f).length, 0);
});

test('真实解析器处理无关联快照时，重复点击不再请求历史或登录态', async () => {
  const f = fixture();
  delete f.context.__cvCodexThread;
  vm.runInContext(read('codex-thread'), f.context);
  const conv = conversation(A);
  conv.mapping.latest.message.metadata = { debug_sonic_thread_id: 'thread_6abd2b7aee64833382a14d4e9a46fdc8' };
  f.page(conv);
  await f.sync();
  for (let i = 0; i < 2; ++i) {
    const result = await f.lookup();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOOKUP_CHAT_MODE');
    assert.match(result.error, /Chat 模式/);
  }
  assert.equal(f.requests.length, 0);
});

test('深度查找传递模式和模块版本，结构化失败保留诊断信息', async () => {
  const f = fixture();
  f.page(conversation(A));
  f.context.__cvCodexThread.version = '0.13.0';
  f.context.__cvCodexThread.resolve = async (_conv, _token, options) => {
    assert.equal(options.deepScan, true);
    throw Object.assign(new Error('partial lookup'), { code: 'LOOKUP_INCOMPLETE',
      diagnostics: { scope: 'history', partial: true, failures: [{ code: 429 }] } });
  };
  const result = await f.lookup(A, true);
  assert.equal(result.ok, false);
  assert.equal(result.lookupVersion, '0.13.0');
  assert.equal(result.code, 'LOOKUP_INCOMPLETE');
  assert.equal(result.diagnostics.failures[0].code, 429);
});

test('同一对话不同查找模式不混用在途任务；旧任务被取消', async () => {
  const f = fixture();
  f.page(conversation(A));
  const modes = [];
  f.context.__cvCodexThread.resolve = async (_conv, _token, { signal, deepScan }) => {
    modes.push(deepScan);
    if (!deepScan) await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    signal.throwIfAborted();
    return { candidates: [{ threadId: ROOT }] };
  };
  const quick = f.lookup(A);
  await flush();
  const deep = await f.lookup(A, true);
  assert.equal(deep.ok, true);
  assert.equal((await quick).ok, false);
  assert.deepEqual(modes, [false, true]);
  assert.equal(historyRequests(f).length, 0);
});

test('查找期间同一分支追加助手消息不会丢弃已完成的查询', async () => {
  const f = fixture();
  f.page(conversation(A));
  let finish;
  f.context.__cvCodexThread.resolve = () => new Promise(resolve => {
    finish = () => resolve({ candidates: [{ threadId: ROOT }] });
  });
  const lookup = f.lookup();
  await flush();
  const next = conversation(A);
  next.mapping.appended = { parent: 'latest', message: { id: 'appended', author: { role: 'assistant' }, content: { parts: [] } } };
  next.current_node = 'appended';
  f.page(next);
  assert.equal((await f.sync()).ok, true);
  finish();
  assert.equal((await lookup).ok, true);
});

test('切换对话清除本页的断点缓存', async () => {
  const f = fixture();
  let clears = 0;
  f.context.__cvCodexThread.clearProgress = () => { ++clears; };
  f.page(conversation(A));
  await f.sync();
  f.route(B);
  assert.equal(clears, 1);
});

test('查找期间同一 URL 的当前分支改变，也拒绝迟到的旧结果', async () => {
  const f = fixture();
  f.page(conversation(A));
  let finish;
  f.context.__cvCodexThread.resolve = () => new Promise(resolve => {
    finish = () => resolve({ candidates: [{ threadId: ROOT }] });
  });
  const lookup = f.lookup();
  await flush();
  f.page(conversation(A, 'new-branch'));
  assert.equal((await f.sync()).ok, true);
  finish();
  const result = await lookup;
  assert.equal(result.ok, false);
  assert.match(result.error, /分支已变化/);
});

test('完整页面链路：只有 Sonic 标识的 Chat 模式直接返回，不连接 Codex，也不启动历史扫描', async () => {
  const f = fixture(); const saved = [], methods = [];
  delete f.context.__cvCodexThread;
  vm.runInContext(read('codex-thread'), f.context);
  vm.runInContext(read('codex-association'), f.context);
  f.context.__cvCodexThread.connect = async () => ({ close() {}, async request(method) {
    methods.push(method); throw new Error('post-cutover thread ID x has unsupported placement format version 3');
  } });
  f.context.chrome.runtime.sendMessage = async m => { if (m.type === 'rememberCodexLookup') saved.push(m.record); return { ok: true }; };
  f.page({ conversation_id: A, current_node: 't', mapping: {
    u: { parent: null, message: { id: A, author: { role: 'user' }, content: { parts: ['prompt'] } } },
    t: { parent: 'u', message: { id: B, author: { role: 'tool' }, metadata: { debug_sonic_thread_id: 'thread_6abfcfddd8c88324a638aeca6c412fa7' } } } } });
  const result = await f.lookup();
  assert.equal(result.ok, true); assert.equal(result.status, 'chat-mode'); assert.equal(result.journalSaved, true);
  assert.equal(methods.length, 0); assert.equal(saved.length, 1); assert.equal(saved[0].status, 'chat-mode');
  assert.equal(saved[0].statistics.requests, 0);
});

test('页面没读到对话时，查找失败记为 conversation-fetch（NO_PAGE_DATA）而非 Codex 无匹配', async () => {
  const f = fixture({ ready: false }); const saved = [];
  vm.runInContext(read('codex-association'), f.context);
  f.context.chrome.runtime.sendMessage = async m => { if (m.type === 'rememberCodexLookup') saved.push(m.record); return { ok: true }; };
  const result = await f.lookup();
  assert.equal(result.ok, false); assert.equal(result.stage, 'conversation-fetch');
  assert.equal(result.code, 'NO_PAGE_DATA'); assert.equal(saved[0].stage, 'conversation-fetch');
  assert.equal(f.lookups.length, 0);
});

test('诊断写盘失败不掩盖已得到的关联诊断结果', async () => {
  const f = fixture();
  f.page(conversation(A));
  vm.runInContext(read('codex-association'), f.context);
  f.context.__cvCodexAssociation.lookup = async () => ({ status: 'mapping-unavailable', candidates: [] });
  f.context.chrome.runtime.sendMessage = async m => { if (m.type === 'rememberCodexLookup') throw new Error('storage failed'); return { ok: true }; };
  const result = await f.lookup();
  assert.equal(result.ok, true); assert.equal(result.status, 'mapping-unavailable'); assert.equal(result.journalSaved, false);
});
