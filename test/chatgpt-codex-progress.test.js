import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/codex-thread.js', import.meta.url), 'utf8');
const context = { setTimeout, clearTimeout, TextEncoder, crypto: webcrypto };
vm.runInNewContext(source, context);
const api = context.__cvCodexThread;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const R = '01a0c40e-6e82-7033-8301-b436bf06d0ad';
const root = (id = R, updatedAt = 1) => ({ id, updatedAt, originator: 'chatgpt_cca', parentThreadId: null });
const conv = (id = A) => ({ conversation_id: 'fixture-chat', current_node: 'u',
  mapping: { u: { parent: null, message: { id, author: { role: 'user' }, content: { parts: ['prompt'] },
    metadata: { async_source: 'saserver-test.fck9d:conversation-turn-fixture:NZ' } } } } });
const item = clientId => ({ item: { type: 'userMessage', clientId, content: [{ text: 'different' }] } });
const page = (data, nextCursor = null) => ({ data, nextCursor });
function client(roots, handler) {
  return { calls: [], closed: false, async request(method, params) {
    this.calls.push([method, { ...params }]);
    if (method === 'thread/list') return page(params.archived ? [] : typeof roots === 'function' ? roots() : roots);
    return handler(params);
  }, close() { this.closed = true; } };
}
const resolve = (connection, state, options = {}, conversation = conv()) => api.resolve(conversation, null,
  { client: connection, deepScan: true, scanState: state, ...options });
const noMatch = promise => assert.rejects(promise, error => error.code === 'LOOKUP_NO_MATCH' && !error.diagnostics.partial);

test('复现九线程238页预算耗尽：正常暂停，三批读完630页，不重读已成功页面', async () => {
  const roots = Array.from({ length: 9 }, (_, i) => root(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
  const seen = new Set(), state = {};
  const connection = client(roots, ({ threadId, cursor, sortDirection }) => {
    assert.equal(sortDirection, 'desc');
    const n = Number(cursor || 0), key = `${threadId}/${n}`;
    assert.equal(seen.has(key), false, `duplicate successful page ${key}`);
    seen.add(key);
    return page([item(B)], n === 69 ? null : String(n + 1));
  });
  const first = await resolve(connection, state);
  assert.equal(first.status, 'paused');
  assert.equal(first.canContinue, true);
  assert.equal(first.diagnostics.itemPages, 238);
  assert.equal(first.diagnostics.rootsChecked, 9);
  assert.equal(first.diagnostics.rootsCompleted, 0);
  assert.equal(first.diagnostics.rootsPending, 9);
  assert.equal(first.diagnostics.failures.length, 0);
  const second = await resolve(connection, state);
  assert.equal(second.status, 'paused');
  assert.equal(second.diagnostics.resumed, true);
  assert.equal(second.diagnostics.listPages, 0);
  assert.equal(second.diagnostics.totalItemPages, 478);
  await assert.rejects(resolve(connection, state), error => {
    assert.equal(error.code, 'LOOKUP_NO_MATCH');
    assert.equal(error.diagnostics.rootsCompleted, 9);
    assert.equal(error.diagnostics.rootsExhausted, 9);
    assert.equal(error.diagnostics.rootsPending, 0);
    assert.equal(error.diagnostics.failures.length, 0);
    assert.equal(error.diagnostics.totalItemPages, 630);
    return true;
  });
  assert.equal(seen.size, 630);
  assert.equal(connection.calls.length, 632);
});

test('逐页公平调度：一个超长线程不能阻止其他八个线程完成', async () => {
  const roots = Array.from({ length: 9 }, (_, i) => root(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
  const connection = client(roots, ({ threadId }) => page([item(B)], threadId === roots[0].id ? 'next' : null));
  const result = await resolve(connection, {}, { maxRequests: 11 });
  assert.equal(result.status, 'paused');
  assert.equal(result.diagnostics.rootsCompleted, 8);
  assert.equal(result.diagnostics.rootsPending, 1);
  assert.equal(result.diagnostics.failures.length, 0);
});

test('最新记录优先：有精确ID时不先翻上千条旧记录', async () => {
  const connection = client([root()], params => {
    assert.equal(params.sortDirection, 'desc');
    assert.equal(params.limit, 100);
    return page([item(A)], 'many-older-items');
  });
  const result = await resolve(connection, {});
  assert.equal(result.candidates[0].threadId, R);
  assert.equal(result.diagnostics.itemPages, 1);
  assert.equal(result.diagnostics.rootsCompleted, 1);
  assert.equal(result.diagnostics.rootsMatched, 1);
});

test('真实读取错误保留失败游标，重试不丢页，也不重读已成功第一页', async () => {
  let fail = true;
  const state = {};
  const connection = client([root()], ({ cursor }) => {
    if (!cursor) return page([item(B)], 'second');
    if (fail) throw Object.assign(new Error('permission temporarily unavailable'), { code: 503 });
    return page([item(A)]);
  });
  await assert.rejects(resolve(connection, state), error => {
    assert.equal(error.code, 'LOOKUP_INCOMPLETE');
    assert.equal(error.diagnostics.rootsCompleted, 0);
    assert.equal(error.diagnostics.failures[0].code, 503);
    return true;
  });
  fail = false;
  const result = await resolve(connection, state);
  assert.equal(result.candidates[0].threadId, R);
  assert.deepEqual(connection.calls.filter(([method]) => method === 'thread/items/list').map(([, p]) => p.cursor),
    [null, 'second', 'second']);
});

test('目录分页同样断点续查，即使单批只允许一次请求也不反复读取第一页', async () => {
  const state = {}, calls = [];
  const connection = { close() {}, async request(method, p) {
    calls.push([method, p.archived, p.cursor]);
    if (method === 'thread/list') return p.archived ? page([]) : p.cursor ? page([root()]) : page([], 'next');
    return page([item(A)]);
  } };
  for (let i = 0; i < 3; ++i) {
    const result = await resolve(connection, state, { maxRequests: 1 });
    assert.equal(result.status, 'paused');
    assert.equal(result.diagnostics.failures.length, 0);
  }
  const result = await resolve(connection, state, { maxRequests: 1 });
  assert.equal(result.candidates[0].threadId, R);
  assert.deepEqual(calls.slice(0, 3), [['thread/list', false, null], ['thread/list', false, 'next'], ['thread/list', true, null]]);
});

test('已完成查询只刷新目录；线程更新后重新检查，而不是永久缓存无匹配', async () => {
  let revision = 1;
  const state = {};
  const connection = client(() => [root(R, revision)], () => page([item(revision === 1 ? B : A)]));
  await noMatch(resolve(connection, state));
  await noMatch(resolve(connection, state));
  assert.equal(connection.calls.filter(([m]) => m === 'thread/items/list').length, 1);
  revision = 2;
  const result = await resolve(connection, state);
  assert.equal(result.candidates[0].threadId, R);
  assert.equal(connection.calls.filter(([m]) => m === 'thread/items/list').length, 2);
});

test('倒序扫描不会把最新一条同文本用户消息当作整个线程的首条用户消息', async () => {
  const connection = client([root()], ({ cursor }) => page([{ item: { type: 'userMessage',
    content: [{ text: cursor ? 'earliest different' : 'prompt' }] } }], cursor ? null : 'older'));
  await noMatch(resolve(connection, {}));
});

test('分支用户集合变化会使旧扫描断点失效，不能用另一分支的无匹配结果', async () => {
  const state = {};
  const connection = client([root()], ({ cursor }) => page([item(B)], cursor ? null : 'older'));
  const first = await resolve(connection, state, { maxRequests: 3 });
  assert.equal(first.status, 'paused');
  const next = await resolve(connection, state, { maxRequests: 3 }, conv(B));
  assert.equal(next.candidates[0].matchedUserMessageId, B);
  assert.deepEqual(connection.calls.filter(([m]) => m === 'thread/items/list').map(([, p]) => p.cursor), [null, null]);
});

test('损坏回包不提交游标或已读页数，修复后重试同一页', async () => {
  let broken = true;
  const state = {};
  const connection = client([root()], () => broken ? page([{}], 'bad-cursor') : page([item(A)]));
  await assert.rejects(resolve(connection, state), error => error.code === 'LOOKUP_INCOMPLETE');
  assert.equal(state.totalItemPages, 0);
  assert.equal(state.roots.get(R).cursor, null);
  broken = false;
  assert.equal((await resolve(connection, state)).candidates[0].threadId, R);
});

test('跨批也保留调度位置：极小预算不会每次只读第一个长线程', async () => {
  const roots = Array.from({ length: 9 }, (_, i) => root(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
  const state = {}, checked = [];
  const connection = client(roots, p => {
    checked.push(p.threadId);
    return page([item(B)], String(Number(p.cursor || 0) + 1));
  });
  for (let i = 0; i < 11; ++i) {
    const result = await resolve(connection, state, { maxRequests: 1 });
    assert.equal(result.status, 'paused');
  }
  assert.equal(checked.length, 9);
  assert.equal(new Set(checked).size, 9);
});

test('单批时间上限同样可续查，不报告RPC失败', async () => {
  let clock = 0;
  context.Date = class extends Date { static now() { return clock; } };
  try {
    const state = {};
    const connection = client([root()], ({ cursor }) => {
      clock += 20;
      return page([item(cursor ? A : B)], cursor ? null : 'next');
    });
    const first = await resolve(connection, state, { maxDurationMs: 10 });
    assert.equal(first.status, 'paused');
    assert.equal(first.diagnostics.failures.length, 0);
    assert.equal(first.diagnostics.pauseReasons[0], 'time-budget');
    const second = await resolve(connection, state, { maxDurationMs: 10 });
    assert.equal(second.candidates[0].threadId, R);
    assert.equal(second.diagnostics.resumed, true);
  } finally { delete context.Date; }
});

test('追加工具说明中的工作目录不应让相同用户分支的断点失效', async () => {
  const state = {};
  const connection = client([root()], ({ cursor }) => page([item(cursor ? A : B)], cursor ? null : 'next'));
  assert.equal((await resolve(connection, state, { maxRequests: 3 })).status, 'paused');
  const updated = conv();
  updated.mapping.tool = { parent: 'u', message: { author: { role: 'tool' },
    content: { parts: ['example cwd /workspace/scratch/abcd1234'] } } };
  updated.current_node = 'tool';
  const result = await resolve(connection, state, {}, updated);
  assert.equal(result.candidates[0].threadId, R);
  assert.deepEqual(connection.calls.filter(([m]) => m === 'thread/items/list').map(([, p]) => p.cursor), [null, 'next']);
});

test('取消保留已提交断点，但不会提交取消时还在读取的页', async () => {
  const state = {}, controller = new AbortController();
  let cancel = true;
  const connection = client([root()], ({ cursor }) => {
    if (cursor && cancel) controller.abort();
    return page([item(cursor ? A : B)], cursor ? null : 'second');
  });
  await assert.rejects(resolve(connection, state, { signal: controller.signal }), /abort/i);
  assert.equal(state.totalItemPages, 1);
  assert.equal(state.roots.get(R).cursor, 'second');
  cancel = false;
  assert.equal((await resolve(connection, state)).candidates[0].threadId, R);
  assert.deepEqual(connection.calls.filter(([m]) => m === 'thread/items/list').map(([, p]) => p.cursor), [null, 'second', 'second']);
});

class Socket {
  static calls = [];
  constructor(_url, protocols) {
    this.identity = protocols.at(-1);
    this.readyState = 0;
    this.listeners = new Map();
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(name, fn) { this.listeners.set(name, [...(this.listeners.get(name) || []), fn]); }
  emit(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); }
  send(text) {
    const message = JSON.parse(text);
    if (!message.id) return;
    let result = {};
    if (message.method === 'thread/list') result = page(message.params.archived ? [] : [root()]);
    if (message.method === 'thread/items/list') {
      Socket.calls.push({ identity: this.identity, cursor: message.params.cursor });
      result = page([item(message.params.cursor ? A : B)], message.params.cursor ? null : 'older');
    }
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, result }) }));
  }
  close() { this.readyState = 3; this.emit('close', {}); }
}

test('真实连接路径自动按账号与证据隔离断点，关闭再开弹窗不丢进度，清除后重新开始', async () => {
  api.clearProgress();
  Socket.calls = [];
  const options = { WebSocketImpl: Socket, deepScan: true, maxRequests: 3 };
  assert.equal((await api.resolve(conv(), 'account-a', options)).status, 'paused');
  assert.equal((await api.resolve(conv(), 'account-a', options)).candidates[0].threadId, R);
  assert.equal((await api.resolve(conv(), 'account-b', options)).status, 'paused');
  assert.deepEqual(Socket.calls.map(v => v.cursor), [null, 'older', null]);
  api.clearProgress();
  assert.equal((await api.resolve(conv(), 'account-a', options)).status, 'paused');
  assert.equal(Socket.calls.at(-1).cursor, null);
});
