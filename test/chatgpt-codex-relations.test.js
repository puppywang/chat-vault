import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/codex-thread.js', import.meta.url), 'utf8');
const context = { setTimeout, clearTimeout };
vm.runInNewContext(source, context);
const api = context.__cvCodexThread;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ROOT = '01a0c40e-6e82-7033-8301-b436bf06d0ad';
const OTHER = '01a0ce5b-5fcd-7352-9c6f-1fb93a8bcedc';
const TURN = '01a0c40e-8ebf-7533-8cd0-8a9a38741a15';
const plain = value => JSON.parse(JSON.stringify(value));
const root = (id = ROOT, extra = {}) => ({ id, originator: 'chatgpt_cca', parentThreadId: null, ...extra });
const WORK = { async_source: 'saserver-test.fck9d:conversation-turn-fixture:NZ' };
const user = (id, parts = ['same prompt'], metadata = {}) => ({ id, author: { role: 'user' }, content: { parts }, metadata: { ...WORK, ...metadata } });
const work = (id = TURN, extra = {}) => ({ author: { role: 'assistant' }, metadata: {
  work_activity: { groups: [{ group_id: id + ':exec-one', items: [{ item_id: 'exec-one' }] }] }, ...extra } });
function conversation(messages = [user(A)]) {
  return { conversation_id: C, current_node: 'n' + (messages.length - 1),
    mapping: Object.fromEntries(messages.map((message, i) => ['n' + i, { parent: i ? 'n' + (i - 1) : null, message }])) };
}
const item = (clientId = A, text = 'same prompt', turnId = TURN) => ({ turnId,
  item: { id: 'cloud-item', type: 'userMessage', clientId, content: [{ type: 'text', text }] } });
const page = (data, nextCursor = null) => ({ data, nextCursor });
function client(handler, roots = [root()]) {
  return { calls: [], closed: false,
    async request(method, params) {
      this.calls.push([method, plain(params)]);
      if (method === 'thread/list') return page(params.archived ? [] : roots);
      return handler(method, params);
    }, close() { this.closed = true; } };
}
const run = (conv, connection, options = {}) => api.resolve(conv, null, { client: connection, ...options });

test('提取全部当前分支用户 ID；不丢图片首条，不采集隐藏用户或旁支', () => {
  const conv = conversation([user(A, [{ content_type: 'image_asset_pointer' }]), user(B), user(C, ['hidden'],
    { is_visually_hidden_from_conversation: true })]);
  conv.mapping.alternate = { parent: null, message: user(ROOT) };
  const evidence = api.conversationEvidence(conv);
  assert.deepEqual(plain(evidence.userMessageIds), [B, A]);
  assert.equal(evidence.firstUserText, null);
  assert.equal(evidence.firstUserId, A);
});

test('工作活动 ID 必须来自助手的类型字段并与组内 item_id 严格对应', () => {
  const conv = conversation([work()]);
  assert.deepEqual(plain(api.conversationEvidence(conv).workActivityTurnIds), [TURN]);
  for (const mutate of [
    m => { m.author.role = 'user'; },
    m => { m.metadata.work_activity.groups[0].items[0].item_id = 'unrelated'; },
    m => { m.metadata.work_activity.groups[0].group_id = 'thread_sonic:exec-one'; },
    m => { m.metadata.work_activity = { groups: 'not-an-array' }; },
    m => { m.metadata = { group_id: TURN + ':exec-one' }; },
  ]) {
    const message = work(); mutate(message);
    message.content = { parts: [TURN + ':exec-one'] };
    assert.deepEqual(plain(api.conversationEvidence(conversation([message])).workActivityTurnIds), []);
  }
});

test('clientId 精确关联不依赖正文；图片对话也可定位', async () => {
  const connection = client(() => page([item(A, 'not the chat text')]));
  const result = await run(conversation([user(A, [{ content_type: 'image_asset_pointer' }])]), connection);
  assert.equal(result.candidates[0].matchedBy, 'user-message-id');
  assert.equal(result.candidates[0].matchedUserMessageId, A);
  assert.equal(result.candidates[0].confidence, 'verified');
  assert.equal(result.requiresConfirmation, false);
  assert.equal(connection.closed, true);
});

test('工作活动 turnId 可独立证明关联，无需协作或用户消息正文', async () => {
  const connection = client(() => page([{ turnId: TURN, item: { type: 'mcpToolCall', id: 'exec-one' } }]));
  const result = await run(conversation([work()]), connection);
  assert.equal(result.candidates[0].matchedBy, 'work-activity-turn');
  assert.equal(result.candidates[0].matchedTurnId, TURN);
  assert.equal(result.requiresConfirmation, false);
});

test('显式 clientId 不同，即使首条完整文本相同也不能视为同一对话', async () => {
  const connection = client(() => page([item(B)]));
  await assert.rejects(run(conversation(), connection), error => error.code === 'LOOKUP_NO_MATCH');
});

test('缺失 clientId 时文本相同只能作为待确认候选', async () => {
  const connection = client(() => page([item(null)]));
  const result = await run(conversation(), connection);
  assert.equal(result.candidates[0].matchedBy, 'first-user-message');
  assert.equal(result.candidates[0].confidence, 'candidate');
  assert.equal(result.requiresConfirmation, true);
});

test('精确 ID 优先于正文和 cwd 候选，不误把另一条同正文 thread 打开', async () => {
  const connection = client((_method, { threadId }) => page([item(threadId === ROOT ? null : A)]), [root(), root(OTHER)]);
  const result = await run(conversation(), connection);
  assert.deepEqual(plain(result.candidates.map(c => c.threadId)), [OTHER]);
  assert.equal(result.candidates[0].matchedBy, 'user-message-id');
});

test('一个 Chat 可关联多个根线程，按当前分支消息的新旧排序而非时间猜测', async () => {
  const connection = client((_method, { threadId }) => page([item(threadId === ROOT ? A : B)]),
    [root(ROOT, { createdAt: 999 }), root(OTHER, { createdAt: 1 })]);
  const result = await run(conversation([user(A), user(B)]), connection);
  assert.deepEqual(plain(result.candidates.map(c => c.threadId)), [OTHER, ROOT]);
  assert.equal(result.requiresConfirmation, true);
});

test('共享祖先在分支里保留关联，不从已剪掉的旁支取得证据', async () => {
  const conv = conversation([user(A), user(B)]);
  conv.mapping.discarded = { parent: 'n0', message: user(C) };
  const connection = client((_method, { threadId }) => page([item(threadId === ROOT ? A : C)]), [root(), root(OTHER)]);
  const result = await run(conv, connection);
  assert.deepEqual(plain(result.candidates.map(c => c.threadId)), [ROOT]);
});

test('首条用户 item 在第二页时继续翻页，不受旧的前五条限制', async () => {
  const connection = client((_method, { cursor }) => cursor
    ? page([item(A)]) : page(Array.from({ length: 7 }, () => ({ type: 'agentMessage', text: 'setup' })), 'next'));
  const result = await run(conversation(), connection);
  assert.equal(result.candidates[0].threadId, ROOT);
  assert.equal(result.diagnostics.itemPages, 2);
});

test('普通查找说明仅检查开头；深度查找覆盖后续用户消息', async () => {
  const handler = (_method, { cursor }) => cursor ? page([item(A)]) : page([item(B, 'old')], 'next');
  const shallow = client(handler);
  await assert.rejects(run(conversation(), shallow), error => {
    assert.equal(error.code, 'LOOKUP_NO_MATCH');
    assert.equal(error.diagnostics.historyLimited, 1);
    assert.equal(error.diagnostics.scope, 'root-heads');
    assert.match(error.message, /深度查找/);
    return true;
  });
  const deep = await run(conversation(), client(handler), { deepScan: true });
  assert.equal(deep.candidates[0].matchedBy, 'user-message-id');
  assert.equal(deep.diagnostics.itemPages, 2);
  assert.equal(deep.diagnostics.scope, 'history');
});

test('读取失败不能当作不存在，也不能自动打开未完成扫描中的唯一候选', async () => {
  const failed = client(() => { throw Object.assign(new Error('rate limited'), { code: 429 }); });
  await assert.rejects(run(conversation(), failed), error => {
    assert.equal(error.code, 'LOOKUP_INCOMPLETE');
    assert.match(error.message, /rate limited/);
    assert.equal(error.diagnostics.failures[0].code, 429);
    return true;
  });
  const partial = client((_method, { threadId }) => {
    if (threadId === OTHER) throw new Error('permission denied');
    return page([item(A)]);
  }, [root(), root(OTHER)]);
  const result = await run(conversation(), partial);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.partial, true);
  assert.equal(result.requiresConfirmation, true);
});

test('item 分页循环和非法回包显式标记查找未完成', async () => {
  for (const handler of [
    () => page([{ type: 'agentMessage' }], 'same'),
    () => ({ data: 'invalid' }),
    () => page([{}]),
  ]) {
    await assert.rejects(run(conversation(), client(handler), { deepScan: true }), error => {
      assert.equal(error.code, 'LOOKUP_INCOMPLETE');
      assert.equal(error.diagnostics.partial, true);
      return true;
    });
  }
});

test('消息过大时缩小同一游标的页大小；其他错误不盲目重试', async () => {
  let sizes = [];
  const connection = client((_method, params) => {
    sizes.push(params.limit);
    if (params.limit > 5) throw new Error('decoded message length too large');
    return page([item(A)]);
  });
  const result = await run(conversation(), connection);
  assert.deepEqual(sizes, [20, 10, 5]);
  assert.equal(result.candidates[0].threadId, ROOT);
  assert.equal(result.diagnostics.partial, false);
});

test('单批预算和页数上限产生可续查暂停，不冒充RPC失败或无匹配', async () => {
  const budget = client(() => { throw new Error('must not call after budget'); });
  const first = await run(conversation(), budget, { deepScan: true, maxRequests: 2 });
  assert.equal(first.status, 'paused');
  assert.equal(first.canContinue, true);
  assert.equal(first.diagnostics.requests, 2);
  assert.equal(first.diagnostics.failures.length, 0);
  assert.equal(first.diagnostics.rootsCompleted, 0);
  const limited = client(() => page([item(B)], 'more'));
  const next = await run(conversation(), limited, { deepScan: true, maxItemPages: 1 });
  assert.equal(next.diagnostics.limitedRoots, 1);
  assert.equal(next.status, 'paused');
  assert.equal(next.diagnostics.failures.length, 0);
  assert.equal(next.canContinue, true);
});

test('并发扫描最多四个，防止 Promise.all 对整个账号突发请求', async () => {
  let active = 0, maximum = 0;
  const roots = Array.from({ length: 11 }, (_, i) => root(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
  const connection = client(async () => {
    ++active; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    --active;
    return page([item(A)]);
  }, roots);
  const result = await run(conversation(), connection);
  assert.equal(maximum, 4);
  assert.equal(result.candidates.length, 11);
});

test('取消会关闭连接并停止发出新的历史请求', async () => {
  const controller = new AbortController();
  const connection = client(() => {
    controller.abort(); return page([item(B)], 'next');
  });
  await assert.rejects(run(conversation(), connection, { signal: controller.signal, deepScan: true }), /abort/i);
  assert.equal(connection.calls.filter(([method]) => method === 'thread/items/list').length, 1);
  assert.equal(connection.closed, true);
});

test('列表归档/非归档去重，排除 Dots 和嵌套子线程', async () => {
  const connection = client(() => page([item(A)]));
  const request = connection.request.bind(connection);
  connection.request = async (method, params) => method === 'thread/list' ? page([
    root(), root(OTHER, { originator: 'orbit_cca_web' }),
    root(B, { threadSource: 'subagent' }), root(C, { source: { subAgent: { thread_spawn: { parent_thread_id: ROOT } } } }),
  ]) : request(method, params);
  const result = await run(conversation(), connection);
  assert.equal(result.diagnostics.rootsListed, 1);
  assert.equal(result.diagnostics.rootsChecked, 1);
  assert.equal(result.candidates[0].threadId, ROOT);
});

test('只有协作字段的深度查找仍返回已验证关系；多个发送者不只取第一个', async () => {
  const message = sender => ({ metadata: { codex_collab_agent_tool_call: {
    type: 'collabAgentToolCall', tool: 'wait', senderThreadId: sender } } });
  const connection = client((_method, { threadId }) => ({ thread: root(threadId) }));
  const result = await run(conversation([message(ROOT), message(OTHER)]), connection, { deepScan: true });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.requiresConfirmation, true);
});

// ---- 0.12.6：按模式分流 + 创建时间窗口 ----
const NEAR = '01a11a8b-97be-70fc-b163-a428fd770853';
const FAR1 = '01a0aaaa-0000-7000-8000-171584182fb9';
const FAR2 = '01a0aaaa-0000-7000-8000-5b570d7ae0e3';
const SENT = 1791446703; // Work 轮次用户消息的 create_time（秒）

test('Chat 模式（分支上没有任何 Work 标记）：不连接、不读登录态，直接说明没有 Codex 线程', async () => {
  const chat = conversation([{ id: A, author: { role: 'user' }, content: { parts: ['p'] }, metadata: {} },
    { author: { role: 'assistant' }, metadata: { debug_sonic_thread_id: 'thread_6abfcfddd8c88324a638aeca6c412fa7' } }]);
  assert.equal(api.conversationEvidence(chat).mode, 'chat');
  let tokenReads = 0;
  const connection = client(() => { throw new Error('must not call'); });
  await assert.rejects(api.resolve(chat, async () => { ++tokenReads; return 't'; }, { client: connection }),
    error => error.code === 'LOOKUP_CHAT_MODE' && /Chat 模式/.test(error.message) && error.diagnostics.requests === 0);
  assert.equal(connection.calls.length, 0);
  assert.equal(tokenReads, 0);
});

test('只有助手消息带 async_source 也算 Work 模式；时间锚点只取 Work 用户消息', () => {
  const conv = conversation([{ id: A, author: { role: 'user' }, content: { parts: ['p'] }, metadata: {}, create_time: SENT },
    { author: { role: 'assistant' }, metadata: { async_source: 'saserver-x:conversation-turn-y:NZ' }, create_time: SENT + 3600 }]);
  const evidence = api.conversationEvidence(conv);
  assert.equal(evidence.mode, 'work');
  assert.equal(evidence.workTimes.length, 0);
  assert.equal(JSON.stringify(evidence.userTimes), JSON.stringify([SENT]));
});

test('普通查找先查创建时间在 Work 轮次附近的根线程：精确命中即停，其余根线程不读', async () => {
  const conv = conversation([{ ...user(A), create_time: SENT }]);
  const connection = client((method, params) => {
    assert.equal(params.threadId, NEAR, '只读取窗口内的根线程');
    return page([item(A)]);
  }, [root(FAR1, { createdAt: SENT - 86400 }), root(NEAR, { createdAt: SENT + 20 }), root(FAR2, { createdAt: SENT + 7200 })]);
  const result = await run(conv, connection);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].threadId, NEAR);
  assert.equal(result.candidates[0].matchedBy, 'user-message-id');
  assert.equal(result.requiresConfirmation, false, '唯一精确结果可直接打开');
  assert.equal(result.diagnostics.windowRoots, 1);
  assert.equal(result.diagnostics.rootsSkippedByWindow, 2);
  assert.equal(result.diagnostics.partial, false);
  assert.equal(connection.calls.filter(([m]) => m === 'thread/items/list').length, 1);
});

test('窗口内没有命中：退回检查全部根线程开头，结论仍以精确 ID 为准', async () => {
  const conv = conversation([{ ...user(A), create_time: SENT }]);
  const connection = client((method, params) => page([item(params.threadId === FAR2 ? A : B)]),
    [root(NEAR, { createdAt: SENT + 20 }), root(FAR1, { createdAt: SENT - 86400 }), root(FAR2, { createdAt: SENT + 7200 })]);
  const result = await run(conv, connection);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].threadId, FAR2);
  assert.equal(result.diagnostics.windowFallback, true);
  assert.equal(connection.calls.filter(([m]) => m === 'thread/items/list').length, 3);
});

test('深度查找不受时间窗口影响', async () => {
  const conv = conversation([{ ...user(A), create_time: SENT }]);
  const connection = client((method, params) => page(params.threadId === NEAR ? [item(A)] : [item(B)]),
    [root(NEAR, { createdAt: SENT + 20 }), root(FAR1, { createdAt: SENT - 86400 })]);
  const result = await run(conv, connection, { deepScan: true });
  assert.equal(result.diagnostics.windowRoots, undefined);
  assert.equal(connection.calls.filter(([m]) => m === 'thread/items/list').length, 2);
});

test('按轮次判断对话类型：纯 Work、纯 Chat、混合与空分支（纯本地，不发请求）', () => {
  const W = { async_source: 'saserver-x:conversation-turn-y:NZ' };
  const chatUser = id => ({ id, author: { role: 'user' }, content: { parts: ['p'] }, metadata: {} });
  const reply = (metadata = {}) => ({ author: { role: 'assistant' }, metadata });
  const modes = messages => plain(api.conversationModes(conversation(messages)));
  // 只有 conversation-turn 标记：走持久 worker，未见 Codex 活动 → worker 档。
  assert.deepEqual(modes([user(A), reply(), user(B), reply()]),
    { mode: 'worker', turns: 2, codexTurns: 0, workerTurns: 2, chatTurns: 0, workTurns: 2, lastTurn: 'worker' });
  // 有工作活动的轮次是 codex 档；整段没有 Chat 轮次即为 Work 模式。
  assert.deepEqual(modes([user(A), work(), user(B), reply()]),
    { mode: 'work', turns: 2, codexTurns: 1, workerTurns: 1, chatTurns: 0, workTurns: 2, lastTurn: 'worker' });
  assert.deepEqual(modes([chatUser(A), reply({ debug_sonic_thread_id: 'thread_6abfcfddd8c88324a638aeca6c412fa7' })]),
    { mode: 'chat', turns: 1, codexTurns: 0, workerTurns: 0, chatTurns: 1, workTurns: 0, lastTurn: 'chat' });
  // 用户消息没带标记，但该轮助手消息带 conversation-turn 或工作活动。
  assert.deepEqual(modes([chatUser(A), reply(W), chatUser(B), work(), chatUser(C), reply()]),
    { mode: 'mixed', turns: 3, codexTurns: 1, workerTurns: 1, chatTurns: 1, workTurns: 2, lastTurn: 'chat' });
  // Work 模型名以 -wm 结尾（社区报告 gpt-5.6-sol-wm；本机 gpt-6.1-sol-wm）。
  assert.equal(modes([chatUser(A), reply({ model_slug: 'gpt-6.1-sol-wm' })]).mode, 'work');
  assert.equal(api.conversationModes({ current_node: null, mapping: {} }).mode, 'unknown');
  // 页面总览面板按用户消息 id 取每轮类型（W/C 标签）。
  assert.deepEqual(plain(api.turnKinds(conversation([chatUser(A), reply(W), chatUser(B), work(), chatUser(C), reply()]))),
    { [A]: 'worker', [B]: 'codex', [C]: 'chat' });
  assert.deepEqual(plain(api.turnKinds({ current_node: null, mapping: {} })), {});
});

test('async_source 只有 conversation-turn 格式算 Work；bon-user（Pro 后台）与 ghostrider 属于 Chat 模式', async () => {
  const chatUser = id => ({ id, author: { role: 'user' }, content: { parts: ['p'] }, metadata: {} });
  const reply = source => ({ author: { role: 'assistant' }, metadata: { async_source: source } });
  const tool = source => ({ author: { role: 'tool' }, metadata: { async_source: source } });
  // 6ac28258 实测形态：助手/工具消息带 bon-user，另有 Sonic 标识
  const sonicPro = conversation([chatUser(A), reply('saserver-newzealandnorth-prod.fck9d:bon-user-cbMWSSfb4PieLlOc02h5L7Ea-952ece39-4770-441c-b991-7d8d86aa8d00:NZ'),
    tool('saserver-newzealandnorth-prod.fck9d:bon-user-cbMWSSfb4PieLlOc02h5L7Ea-952ece39-4770-441c-b991-7d8d86aa8d00:NZ'),
    { author: { role: 'assistant' }, metadata: { debug_sonic_thread_id: 'thread_6abfcfddd8c88324a638aeca6c412fa7' } },
    chatUser(B), reply('saserver-x.fck9d:ghostrider-abc:NZ')]);
  assert.equal(api.conversationEvidence(sonicPro).mode, 'chat');
  assert.equal(api.conversationModes(sonicPro).mode, 'chat');
  const connection = client(() => { throw new Error('must not call'); });
  await assert.rejects(run(sonicPro, connection), error => error.code === 'LOOKUP_CHAT_MODE');
  assert.equal(connection.calls.length, 0);
  // Work 轮次：没有工具调用、只有 conversation-turn 标记，同样算 Work
  const plainWork = conversation([chatUser(A), reply('saserver-nz.fck9d:conversation-turn-0af367b0-e858-4a9b-98fb-6a41ee9f1ebb:NZ')]);
  assert.equal(api.conversationEvidence(plainWork).mode, 'work', '查找仍会尝试');
  assert.equal(api.conversationModes(plainWork).mode, 'worker', '显示为持久 worker，未确认 Codex');
});

test('WebSocket 建立与单次读取分开计时：握手超时给出可识别的错误码', async () => {
  class NeverOpens { constructor() { this.readyState = 0; } addEventListener() {} close() { this.readyState = 3; } send() {} }
  await assert.rejects(api.connect('token', { WebSocketImpl: NeverOpens, timeoutMs: 5, openTimeoutMs: 30 }),
    error => error.code === 'CODEX_CONNECT_TIMEOUT' && /网络可能拥塞/.test(error.message));
});
