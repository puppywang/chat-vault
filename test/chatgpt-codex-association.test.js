import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const context = { setTimeout, clearTimeout };
for (const name of ['codex-thread', 'codex-association'])
  vm.runInNewContext(fs.readFileSync(new URL(`../extensions/chatgpt-sync/${name}.js`, import.meta.url), 'utf8'), context);
const api = context.__cvCodexAssociation;
const U = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const NORMAL = '6abfcfdd-d8c8-8324-a638-cd316c8fe523';
const ORIGINAL = 'thread_' + NORMAL.replaceAll('-', '');
function conversation() {
  return { conversation_id: U, current_node: 't', mapping: {
    u: { parent: null, message: { id: U, author: { role: 'user' }, content: { parts: ['prompt'] } } },
    t: { parent: 'u', message: { id: M, author: { role: 'tool' }, metadata: { debug_sonic_thread_id: ORIGINAL } } } } };
}
function client(handler) {
  return { calls: [], closed: false, async request(method, params) {
    this.calls.push({ method, params }); return handler(method, params);
  }, close() { this.closed = true; } };
}
const root = () => ({ thread: { id: NORMAL, originator: 'chatgpt_cca', parentThreadId: null } });
// Work 模式的同一分支：用户消息带 async_source。
function workConversation() {
  const c = conversation();
  c.mapping.u.message.metadata = { async_source: 'saserver-test.fck9d:conversation-turn-fixture:NZ' };
  return c;
}

test('Sonic 仅取当前分支结构化助手/工具元数据，保留对应用户锚点', () => {
  const c = conversation();
  c.mapping.other = { parent: null, message: { author: { role: 'tool' }, metadata: { debug_sonic_thread_id: 'thread_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } };
  const result = api.evidence(c);
  assert.equal(result.length, 1); assert.equal(result[0].normalizedId, NORMAL); assert.equal(result[0].userMessageId, U);
  c.mapping.t.message.author.role = 'user'; assert.equal(api.evidence(c).length, 0);
  c.mapping.t.message.author.role = 'tool'; delete c.mapping.t.message.metadata;
  c.mapping.t.message.content = { parts: [JSON.stringify({ debug_sonic_thread_id: ORIGINAL })] };
  assert.equal(api.evidence(c).length, 0);
});

test('缺失节点或循环分支拒绝诊断', () => {
  const c = conversation(); c.mapping.u.parent = 't'; assert.throws(() => api.evidence(c), /循环/);
  delete c.mapping.u; assert.throws(() => api.evidence(c), /完整/);
});

test('placement 拒绝返回入口不支持，零历史扫描，不吞成未找到', async () => {
  const connection = client(() => { throw Object.assign(new Error('post-cutover thread ID x has unsupported placement format version 3'), { code: -32602 }); });
  const result = await api.inspect(conversation(), null, { client: connection });
  assert.equal(result.status, 'route-unsupported'); assert.equal(result.code, 'CODEX_ROUTE_UNSUPPORTED');
  assert.equal(result.candidates.length, 0); assert.equal(result.diagnostics.historyScanned, false);
  assert.equal(result.diagnostics.probes[0].placementVersion, 3); assert.equal(result.diagnostics.failures.length, 0);
  assert.equal(connection.calls.length, 1); assert.equal(connection.calls[0].method, 'thread/read');
  assert.equal(connection.calls[0].params.threadId, NORMAL); assert.equal(connection.closed, true);
});

test('多个后台标识最多只诊断最新三个，不能爆发全账号扫描', async () => {
  const c = conversation(); let parent = 't';
  for (let i = 0; i < 20; ++i) {
    const node = `extra${i}`;
    c.mapping[node] = { parent, message: { author: { role: 'assistant' }, metadata: {
      debug_sonic_thread_id: `thread_aaaaaaaaaaaaaaaaaaaa${String(i).padStart(12, '0')}` } } };
    parent = node;
  }
  c.current_node = parent;
  const connection = client(() => { throw new Error('unsupported placement region 9'); });
  const r = await api.inspect(c, null, { client: connection });
  assert.equal(r.diagnostics.sonicCount, 21); assert.equal(r.diagnostics.sampleCount, 3); assert.equal(connection.calls.length, 3);
  assert.equal(r.diagnostics.probes[0].placementRegion, 9);
});

test('只有 Sonic 标识的 Chat 模式分支：普通与深度查找都直接返回 chat-mode，零请求', async () => {
  for (const deepScan of [false, true]) {
    const connection = client(() => { throw new Error('must not call'); });
    const old = context.__cvCodexThread.resolve;
    context.__cvCodexThread.resolve = async () => { throw new Error('must not resolve'); };
    try {
      const r = await api.lookup(conversation(), null, { client: connection, deepScan });
      assert.equal(r.status, 'chat-mode'); assert.equal(r.code, 'CODEX_CHAT_MODE');
      assert.equal(r.candidates.length, 0); assert.equal(r.canContinue, false);
      assert.equal(r.diagnostics.requests, 0); assert.equal(r.diagnostics.sonicCount, 1);
      assert.equal(connection.calls.length, 0);
      const saved = api.record({ ok: true, ...r }, { conversationId: U });
      assert.equal(saved.status, 'chat-mode'); assert.equal(saved.scope, 'mode');
    } finally { context.__cvCodexThread.resolve = old; }
  }
});

test('规范化 ID 可读仍不足以打开；同文本不同 ID 不冒充验证', async () => {
  const connection = client(method => method === 'thread/read' ? root() : { data: [{
    item: { type: 'userMessage', clientId: M, content: [{ text: 'prompt' }] } }], nextCursor: null });
  const r = await api.inspect(conversation(), null, { client: connection });
  assert.equal(r.status, 'mapping-unavailable'); assert.equal(r.candidates.length, 0);
  assert.equal(r.diagnostics.probes[0].state, 'readable-unverified');
});

test('仅当前分支精确消息 ID 二次核验通过才产生可选链接', async () => {
  const connection = client(method => method === 'thread/read' ? root() : { data: [{
    item: { type: 'userMessage', clientId: U, content: [{ text: 'entirely different text' }] } }], nextCursor: null });
  const r = await api.inspect(conversation(), null, { client: connection });
  assert.equal(r.status, 'matched'); assert.equal(r.candidates[0].confidence, 'verified');
  assert.equal(r.candidates[0].matchedBy, 'user-message-id'); assert.equal(r.requiresConfirmation, true);
  assert.equal(r.candidates[0].threadId, NORMAL); assert.equal(r.candidates[0].backend, 'codex-cloud');
});

test('返回不同 thread 或未验证宿主不开放链接', async () => {
  for (const mutate of [t => { t.id = U; }, t => { t.originator = 'orbit_cca_web'; }, t => { t.parentThreadId = M; }]) {
    const response = root(); mutate(response.thread);
    const connection = client(() => response);
    const r = await api.inspect(conversation(), null, { client: connection });
    assert.equal(r.candidates.length, 0); assert.equal(connection.calls.length, 1);
  }
});

test('明确深度查询保持原路径，不强制改为Sonic诊断', async () => {
  const old = context.__cvCodexThread.resolve;
  context.__cvCodexThread.resolve = async (_c, _t, o) => ({ marker: o.deepScan });
  try { assert.equal((await api.lookup(workConversation(), null, { deepScan: true })).marker, true); }
  finally { context.__cvCodexThread.resolve = old; }
});

test('现有强元数据关联优先于Sonic候选', async () => {
  const old = context.__cvCodexThread.resolve;
  context.__cvCodexThread.resolve = async () => ({ strong: true });
  try {
    const c = conversation(); c.mapping.t.message.metadata.codex_collab_agent_tool_call = { tool: 'wait', senderThreadId: M };
    assert.equal((await api.lookup(c, null)).strong, true);
  } finally { context.__cvCodexThread.resolve = old; }
});

test('已完成未命中成为独立结果；真错误仍拒绝', async () => {
  const old = context.__cvCodexThread.resolve;
  context.__cvCodexThread.resolve = async () => { throw Object.assign(new Error('no match'), { code: 'LOOKUP_NO_MATCH', diagnostics: { partial: false } }); };
  try { assert.equal((await api.lookup(workConversation(), null, { deepScan: true })).status, 'no-match'); }
  finally { context.__cvCodexThread.resolve = old; }
});

test('网络超时与429分类保留，混合结果不宣称全部路由拒绝', async () => {
  for (const [text, code] of [['读取超时', 'CODEX_READ_TIMEOUT'], ['rate limited 429', 'CODEX_RATE_LIMITED']]) {
    const connection = client(() => { throw new Error(text); });
    const r = await api.inspect(conversation(), null, { client: connection });
    assert.equal(r.status, 'read-error'); assert.equal(r.diagnostics.failures[0].code, code);
    assert.equal(r.diagnostics.partial, true);
  }
});

test('取消会关闭连接，未开启额外历史读取', async () => {
  const controller = new AbortController();
  const connection = client(() => { controller.abort(); return root(); });
  await assert.rejects(api.inspect(conversation(), null, { client: connection, signal: controller.signal }), /abort/i);
  assert.equal(connection.closed, true); assert.equal(connection.calls.length, 1);
});

test('诊断记录白名单不保存正文、凭证、原始报错或任意路由', () => {
  const r = api.record({ status: 'read-error', error: 'Bearer secret-text', code: 'CODEX_READ_ERROR',
    token: 'secret-text', stage: 'conversation-fetch', diagnostics: { scope: 'association', sonicCount: 28,
      request: { body: 'private-user' }, failures: [{ message: 'secret-text' }], probes: [{ originalId: ORIGINAL,
        normalizedId: NORMAL, state: 'route-unsupported', code: 'CODEX_ROUTE_UNSUPPORTED', placementVersion: 3,
        token: 'secret-text', reason: 'secret-text' }] } }, { conversationId: U, lookupId: M });
  assert.equal(r.stage, 'conversation-fetch'); assert.equal(r.statistics.sonicCount, 28);
  assert.equal(r.probes[0].placementVersion, 3); assert.doesNotMatch(JSON.stringify(r), /secret-text|private-user/);
});
