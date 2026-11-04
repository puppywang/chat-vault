import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/codex-thread.js', import.meta.url), 'utf8');
const context = { setTimeout, clearTimeout, crypto: { randomUUID: () => 'request-' + ++sequence } };
let sequence = 0;
vm.runInNewContext(source, context);
const api = context.__cvCodexThread;
const ROOT = '01a0c40e-6e82-7033-8301-b436bf06d0ad';
const CHILD = '01a0c410-2e99-7fa1-8efb-f3c7e2f3c79f';
const OLD = '01a0c414-b96d-75d2-ade8-512b6c1888ce';
const OTHER = '01a0f178-337c-76ad-ab15-57376055ec42';
const CWD = '/workspace/scratch/fb4e644952df';
const plain = value => JSON.parse(JSON.stringify(value));
// 取证结果里与分类/时间窗口相关的新字段另有用例覆盖；这里只核对关联证据本身。
const core = value => { const { mode, workUserMessageIds, workTimes, userTimes, ...rest } = plain(value); return rest; };
// Work 模式的分支带 async_source；Chat 模式（work: false）没有 Codex 线程可找。
const WORK = { async_source: 'saserver-test.fck9d:conversation-turn-fixture:NZ' };
function conversation({ agents = true, workspace = true, work = true } = {}) {
  return { current_node: 'latest', mapping: {
    first: { parent: null, message: { metadata: { ...(work ? WORK : {}), ...(agents ? { codex_sub_agent_activity: { agentThreadId: OLD } } : {}) },
      content: { parts: workspace ? [`cwd: ${CWD}`] : [] } } },
    latest: { parent: 'first', message: { metadata: agents ? { codex_sub_agent_activity: { agentThreadId: CHILD } } : {} } },
    alternate: { parent: 'first', message: { metadata: { codex_sub_agent_activity: { agentThreadId: OTHER } },
      content: { parts: ['/workspace/scratch/000000000000'] } } },
  } };
}
function client(handler) {
  return { calls: [], closed: false, async request(method, params) {
    this.calls.push([method, plain(params)]); return handler(method, params);
  }, close() { this.closed = true; } };
}
function collab(conv, node, senderThreadId, extra = {}) {
  conv.mapping[node].message.metadata.codex_collab_agent_tool_call = {
    type: 'collabAgentToolCall', tool: 'wait', senderThreadId, receiverThreadIds: [], agentsStates: {}, ...extra,
  };
  return conv;
}

test('只从当前分支提取最新子 agent 和精确工作目录', () => {
  assert.deepEqual(core(api.conversationEvidence(conversation())), {
    senderThreadIds: [], agentThreadIds: [CHILD, OLD], workspaces: [CWD], firstUserText: null,
    firstUserId: null, userMessageIds: [], workActivityTurnIds: [],
  });
  assert.throws(() => api.conversationEvidence({ current_node: 'absent', mapping: {} }), /分支尚未加载完整/);
  const cyclic = conversation(); cyclic.mapping.first.parent = 'latest';
  assert.throws(() => api.conversationEvidence(cyclic), /循环引用/);
});

test('协作发送者与接收者仅取当前分支，最新记录优先，状态表也提供子线程 ID', () => {
  const conv = conversation({ agents: false, workspace: false });
  collab(conv, 'latest', ROOT, { receiverThreadIds: [CHILD, 'invalid'], agentsStates: { [OLD]: { status: 'completed' } } });
  collab(conv, 'first', OTHER);
  collab(conv, 'alternate', CHILD);
  assert.deepEqual(core(api.conversationEvidence(conv)), {
    senderThreadIds: [ROOT, OTHER], agentThreadIds: [CHILD, OLD], workspaces: [], firstUserText: null,
    firstUserId: null, userMessageIds: [], workActivityTurnIds: [],
  });
});

test('协作发送者直接核验主 thread，只需一次读取且优先于子 agent 与工作目录', async () => {
  const connection = client((_method, { threadId }) => ({ thread: {
    id: threadId, originator: 'chatgpt_cca', parentThreadId: null, sessionId: OTHER,
  } }));
  const result = await api.resolve(collab(conversation(), 'latest', ROOT), 'token', { client: connection });
  assert.equal(result.candidates[0].threadId, ROOT);
  assert.equal(result.candidates[0].matchedBy, 'collab-sender');
  assert.equal(result.candidates[0].url, `https://chatgpt.com/local/${ROOT}?hostId=local`);
  assert.deepEqual(connection.calls, [['thread/read', { threadId: ROOT, includeTurns: false }]]);
  assert.equal(connection.closed, true);
});

test('只有协作记录、没有子 agent 活动或工作目录时也能定位主 thread', async () => {
  const connection = client(() => ({ thread: { id: ROOT, originator: 'chatgpt_cca' } }));
  const conv = collab(conversation({ agents: false, workspace: false }), 'latest', ROOT);
  assert.equal((await api.resolve(conv, 'token', { client: connection })).candidates[0].threadId, ROOT);
});

test('协作发送者本身是子线程时仍追溯父线程，不直接打开子线程', async () => {
  const connection = client((_method, { threadId }) => ({ thread: threadId === CHILD
    ? { id: CHILD, parentThreadId: ROOT, originator: 'codex_cli_rs' }
    : { id: ROOT, originator: 'chatgpt_cca' } }));
  const conv = collab(conversation({ agents: false, workspace: false }), 'latest', CHILD);
  assert.equal((await api.resolve(conv, 'token', { client: connection })).candidates[0].threadId, ROOT);
  assert.equal(connection.calls.length, 2);
});

test('协作发送者不可读时可回退子 agent，Dots 记录不能被当作 ChatGPT 主线程', async () => {
  const connection = client((_method, { threadId }) => {
    if (threadId === OTHER) throw new Error('thread not found');
    return { thread: threadId === CHILD ? { id: CHILD, parentThreadId: ROOT } : { id: ROOT } };
  });
  const result = await api.resolve(collab(conversation(), 'latest', OTHER), 'token', { client: connection });
  assert.equal(result.candidates[0].matchedBy, 'subagent');
  assert.equal(result.candidates[0].threadId, ROOT);
  const dots = client(() => ({ thread: { id: ROOT, originator: 'orbit_cca_web' } }));
  await assert.rejects(api.resolve(collab(conversation({ agents: false, workspace: false }), 'latest', ROOT),
    'token', { client: dots }), /未指向可核验的 ChatGPT 主 Codex thread/);
  assert.equal(dots.closed, true);
});

test('仅有协作接收者或状态表的子线程 ID 时仍能追溯主 thread', async () => {
  for (const extra of [{ receiverThreadIds: [CHILD] }, { agentsStates: { [CHILD]: { status: 'completed' } } }]) {
    const connection = client((_method, { threadId }) => ({ thread: threadId === CHILD
      ? { id: CHILD, parentThreadId: ROOT } : { id: ROOT } }));
    const conv = collab(conversation({ agents: false, workspace: false }), 'latest', null, extra);
    const result = await api.resolve(conv, 'token', { client: connection });
    assert.equal(result.candidates[0].threadId, ROOT);
    assert.equal(result.candidates[0].matchedBy, 'subagent');
  }
});

test('任意同名字段和格式不符的协作记录不会被作为关联依据', async () => {
  for (const extra of [{ type: 'unrelated' }, { tool: 'unrecognized' }, { senderThreadId: 'thread_sonic',
    receiverThreadIds: 'invalid', agentsStates: { invalid: {} } }]) {
    const conv = collab(conversation({ agents: false, workspace: false }), 'latest', ROOT, extra);
    await assert.rejects(api.resolve(conv, 'token'), /没有返回可关联/);
  }
});

test('首条用户消息完整匹配 Codex root 的首条 userMessage，换行差异不影响匹配', async () => {
  const prompt = '第一行\r\n第二行\n第三行';
  const conv = conversation({ agents: false, workspace: false });
  conv.mapping.latest.message.author = { role: 'user' };
  conv.mapping.latest.message.content = { parts: [prompt] };
  const connection = client((method, params) => {
    if (method === 'thread/list') return { data: [
      { id: ROOT, originator: 'chatgpt_cca', parentThreadId: null, createdAt: 2 },
      { id: OTHER, originator: 'chatgpt_cca', parentThreadId: null, createdAt: 1 },
      { id: CHILD, originator: 'orbit_cca_web', parentThreadId: null, createdAt: 3 },
    ], nextCursor: null };
    if (method === 'thread/items/list') return { data: [{ item: {
      type: 'userMessage', content: [{ type: 'input_text', text: params.threadId === ROOT ? '第一行\n第二行\n第三行' : 'different' }],
    } }] };
    throw new Error('unexpected RPC');
  });
  const result = await api.resolve(conv, 'token', { client: connection });
  assert.deepEqual(plain(result.candidates.map(candidate => candidate.threadId)), [ROOT]);
  assert.equal(result.candidates[0].matchedBy, 'first-user-message');
  assert.equal(connection.calls.filter(([method]) => method === 'thread/items/list').length, 2);
});

test('首条消息匹配支持归档 root，并返回多个相同内容候选', async () => {
  const conv = conversation({ agents: false, workspace: false });
  conv.mapping.latest.message.author = { role: 'user' };
  conv.mapping.latest.message.content = { parts: ['same prompt'] };
  let page = 0;
  const connection = client((method, params) => {
    if (method === 'thread/list') {
      ++page;
      return { data: [{ id: page === 1 ? ROOT : OTHER, originator: 'chatgpt_cca', parentThreadId: null, createdAt: page }], nextCursor: null };
    }
    if (method === 'thread/items/list') return { data: [{ item: { type: 'userMessage', content: [{ text: 'same prompt' }] } }] };
    throw new Error('unexpected RPC');
  });
  const result = await api.resolve(conv, 'token', { client: connection });
  assert.deepEqual(plain(result.candidates.map(candidate => candidate.threadId)), [OTHER, ROOT]);
  assert.equal(result.candidates.every(candidate => candidate.matchedBy === 'first-user-message'), true);
});

test('没有首条用户文本时不会盲目扫描 thread/list', async () => {
  const conv = conversation({ agents: false, workspace: false });
  const connection = client(() => { throw new Error('must not call'); });
  await assert.rejects(api.resolve(conv, 'token', { client: connection }), /没有返回可关联/);
  assert.equal(connection.calls.length, 0);
});

test('首条用户消息没有匹配时给出内容指纹原因，而不是误报工作目录', async () => {
  const conv = conversation({ agents: false, workspace: false });
  conv.mapping.latest.message.author = { role: 'user' };
  conv.mapping.latest.message.content = { parts: ['unique prompt'] };
  const connection = client(method => method === 'thread/list' ? { data: [], nextCursor: null } : { data: [] });
  await assert.rejects(api.resolve(conv, 'token', { client: connection }), /首条用户消息匹配/);
  assert.equal(connection.closed, true);
});

test('子 agent 追溯主 thread，使用 thread.id 而非共享的 sessionId，最后关闭连接', async () => {
  const connection = client((_method, { threadId }) => ({ thread: threadId === CHILD
    ? { id: CHILD, parentThreadId: ROOT, sessionId: ROOT }
    : { id: ROOT, sessionId: OTHER, parentThreadId: null } }));
  const result = await api.resolve(conversation(), 'token', { client: connection });
  assert.equal(result.candidates[0].threadId, ROOT);
  assert.equal(result.candidates[0].url, `https://chatgpt.com/local/${ROOT}?hostId=local`);
  assert.deepEqual(connection.calls, [
    ['thread/read', { threadId: CHILD, includeTurns: false }],
    ['thread/read', { threadId: ROOT, includeTurns: false }],
  ]);
  assert.equal(connection.closed, true);
});

test('子 agent 返回的嵌套父线程字段也能追溯主 thread', async () => {
  const connection = client((_method, { threadId }) => ({ thread: threadId === CHILD
    ? { id: CHILD, source: { subAgent: { thread_spawn: { parent_thread_id: ROOT } } } }
    : { id: ROOT } }));
  assert.equal((await api.resolve(conversation(), 'token', { client: connection })).candidates[0].threadId, ROOT);
});

test('工作目录回退完整翻页并检查归档，排除 Dots 和子线程', async () => {
  const connection = client((_method, { archived, cursor }) => {
    if (archived) return { data: [{ id: ROOT, cwd: CWD, originator: 'chatgpt_cca' }], nextCursor: null };
    if (!cursor) return { data: [{ id: OTHER, cwd: CWD, originator: 'orbit_cca_web' },
      { id: CHILD, cwd: CWD, originator: 'chatgpt_cca', parentThreadId: ROOT }], nextCursor: 'next' };
    return { data: [{ id: ROOT, cwd: CWD, originator: 'chatgpt_cca' }], nextCursor: null };
  });
  const result = await api.resolve(conversation({ agents: false }), 'token', { client: connection });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].threadId, ROOT);
  assert.deepEqual(connection.calls.map(([, p]) => [p.archived, p.cursor]), [[false, null], [false, 'next'], [true, null]]);
  assert.equal(connection.closed, true);
});

test('多个工作目录匹配返回候选，分页不前进时报错并关闭连接', async () => {
  const connection = client(() => ({ data: [ROOT, OTHER].map(id => ({ id, cwd: CWD, originator: 'chatgpt_cca' })) }));
  assert.equal((await api.resolve(conversation({ agents: false }), 'token', { client: connection })).candidates.length, 2);
  const stuck = client(() => ({ data: [], nextCursor: 'same' }));
  await assert.rejects(api.resolve(conversation({ agents: false }), 'token', { client: stuck }), /分页未向前推进/);
  assert.equal(stuck.closed, true);
});

test('子 agent 不可读时回退工作目录；无匹配时保留错误原因', async () => {
  const connection = client(method => {
    if (method === 'thread/read') throw new Error('thread not found');
    return { data: [{ id: ROOT, cwd: CWD, originator: 'chatgpt_cca' }] };
  });
  assert.equal((await api.resolve(conversation(), 'token', { client: connection })).candidates[0].threadId, ROOT);
  const failed = client(() => { throw new Error('thread not found'); });
  await assert.rejects(api.resolve(conversation({ workspace: false }), 'token', { client: failed }), /thread not found/);
  assert.equal(failed.closed, true);
  await assert.rejects(api.resolve(conversation({ workspace: false, agents: false }), 'token'), /没有返回可关联/);
});

test('Sonic 调试标识不被当作 Codex ID，无关联依据时不读取登录态或建立连接', async () => {
  const conv = conversation({ workspace: false, agents: false });
  conv.mapping.latest.message.metadata.debug_sonic_thread_id = 'thread_6abd2b7aee64833382a14d4e9a46fdc8';
  let authReads = 0;
  await assert.rejects(api.resolve(conv, async () => { ++authReads; return 'token'; }), /没有返回可关联/);
  assert.equal(authReads, 0);
});

test('父线程循环或返回错误 thread ID 不会被当作有效匹配', async () => {
  const loop = client((_method, { threadId }) => ({ thread: { id: threadId, parentThreadId: threadId } }));
  await assert.rejects(api.resolve(conversation({ workspace: false }), 'token', { client: loop }), /循环引用/);
  const mismatch = client(() => ({ thread: { id: OTHER } }));
  await assert.rejects(api.resolve(conversation({ workspace: false }), 'token', { client: mismatch }), /与请求不一致/);
});

class Socket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.readyState = 0; this.listeners = new Map(); this.sent = [];
    Socket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
  }
  addEventListener(name, fn) {
    const handlers = this.listeners.get(name) || []; handlers.push(fn); this.listeners.set(name, handlers);
  }
  emit(name, event) { for (const handler of this.listeners.get(name) || []) handler(event); }
  reply(message) { this.emit('message', { data: JSON.stringify(message) }); }
  send(text) {
    const message = JSON.parse(text); this.sent.push(message);
    if (message.method === 'initialize') queueMicrotask(() => this.reply({ id: message.id, result: {} }));
  }
  close() { this.readyState = 3; this.emit('close', {}); }
}

test('WebSocket 按 HAR 协议认证初始化，按请求 ID 匹配乱序回复，忽略通知', async () => {
  const connection = await api.connect('test-token', { WebSocketImpl: Socket });
  const socket = Socket.instances.at(-1);
  assert.equal(socket.url, 'wss://codex-cloud-backend.chatgpt.com/');
  assert.deepEqual(plain(socket.protocols), ['codex-app-server', 'codex-client.browser', 'openai-bearer.test-token']);
  assert.equal(socket.sent[0].params.capabilities.requestAttestation, false);
  assert.equal(socket.sent[1].method, 'initialized');
  const first = connection.request('thread/read', { threadId: ROOT });
  const second = connection.request('thread/list', {});
  socket.reply({ method: 'turn/started', params: { threadId: OTHER } });
  socket.reply({ id: socket.sent[3].id, result: { data: [] } });
  socket.reply({ id: socket.sent[2].id, result: { thread: { id: ROOT } } });
  assert.equal((await first).thread.id, ROOT);
  assert.deepEqual(plain(await second), { data: [] });
  await assert.rejects(connection.request('turn/start', {}), /仅支持读取/);
  await assert.rejects(connection.request('thread/resume', {}), /仅支持读取/);
  connection.close();
  assert.equal(socket.readyState, 3);
});

test('有可关联快照时才调用登录态提供函数，并用返回的 token 读取父线程', async () => {
  class LookupSocket extends Socket {
    send(text) {
      super.send(text);
      const message = JSON.parse(text);
      if (message.method === 'thread/read') queueMicrotask(() => this.reply({ id: message.id,
        result: { thread: message.params.threadId === CHILD ? { id: CHILD, parentThreadId: ROOT } : { id: ROOT } } }));
    }
  }
  let authReads = 0;
  const result = await api.resolve(conversation(), async () => { ++authReads; return 'fresh-token'; },
    { WebSocketImpl: LookupSocket });
  assert.equal(authReads, 1);
  assert.equal(result.candidates[0].threadId, ROOT);
  assert.deepEqual(plain(Socket.instances.at(-1).protocols),
    ['codex-app-server', 'codex-client.browser', 'openai-bearer.fresh-token']);
  assert.equal(Socket.instances.at(-1).readyState, 3);
});

test('RPC 错误、超时和取消均会结束等待，关闭连接拒绝未完成请求', async () => {
  const connection = await api.connect('test-token', { WebSocketImpl: Socket, timeoutMs: 20 });
  const socket = Socket.instances.at(-1);
  const failed = connection.request('thread/read', {});
  socket.reply({ id: socket.sent.at(-1).id, error: { code: -32602, message: 'invalid params' } });
  await assert.rejects(failed, error => error.code === -32602 && error.message === 'invalid params');
  await assert.rejects(connection.request('thread/read', {}), /超时/);
  const pending = connection.request('thread/read', {});
  connection.close();
  await assert.rejects(pending, /连接已关闭/);
  const controller = new AbortController();
  const cancellable = await api.connect('test-token', { WebSocketImpl: Socket, signal: controller.signal });
  const waiting = cancellable.request('thread/read', {});
  controller.abort();
  await assert.rejects(waiting, /查找已取消/);
  assert.equal(Socket.instances.at(-1).readyState, 3);
});

test('无登录态或非法 ID 不会建立连接或生成任意链接', async () => {
  await assert.rejects(api.connect(''), /未登录/);
  assert.throws(() => api.threadUrl('../../settings'), /ID 无效/);
});
