import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/stalled-turn.js', import.meta.url), 'utf8');
const CONV = '6ac74eb0-2270-83ec-a4de-e6daf6513094';
const USER = '204dfa99-0f1d-44ea-97d1-ce1ca0588991';
const ROOT = '01a11a8b-97be-70fc-b163-a428fd770853';
const TURN = '01a11a8b-b637-7458-bfd2-18af03d490fe';
const READS = new Set(['thread/read', 'thread/items/list', 'thread/turns/list', 'thread/list', 'initialize']);

function conversation({ work = true, turnId = TURN } = {}) {
  const user = { id: USER, author: { role: 'user' }, content: { parts: ['task'] },
    metadata: work ? { async_source: `saserver-nz:conversation-turn-x:NZ` } : {} };
  const reply = { id: 'a1', author: { role: 'assistant' }, content: { parts: [] }, metadata: work ? {
    work_activity: { groups: [{ group_id: `${turnId}:exec-1`, items: [{ item_id: 'exec-1' }] }] } } : {} };
  return { conversation_id: CONV, current_node: 'n1', mapping: {
    n0: { id: 'n0', message: user, parent: null }, n1: { id: 'n1', message: reply, parent: 'n0' } } };
}

function fixture({ streamStatus = 'IS_STREAMING', turns = [{ id: TURN, status: 'completed', durationMs: 7469000,
  startedAt: 1791446726, completedAt: 1791454195 }], items = [], loaded = null, resolveError = null } = {}) {
  let now = 1_000_000;
  const els = {};
  const element = () => ({ style: {}, textContent: '', title: '', className: '', href: '', addEventListener(type, fn) { this[type] = fn; } });
  const body = { children: [], appendChild(node) { this.children.push(node); } };
  const document = { body, querySelectorAll: () => [], createElement() {
    const host = { remove() { body.children = body.children.filter(x => x !== host); }, attachShadow() {
      const root = { set innerHTML(_) { for (const k of ['t', 'a', 'r', 'x', 'b']) els[k] = element(); },
        getElementById: id => els[id], querySelector: sel => sel === '.b' ? els.b : null };
      host.shadowRoot = root; return root; } };
    return host; } };
  const stored = {}, fetches = [], rpc = [], loads = [];
  let reloads = 0;
  let streaming = true, speed = { userMessageId: USER, lastFrameAtMs: null };
  const fetch = async url => { fetches.push(url);
    return { ok: true, status: 200, json: async () => ({ status: streamStatus }) }; };
  const client = { request: async (method, params) => {
    rpc.push(method);
    assert.ok(READS.has(method), `只允许读方法：${method}`);
    if (method === 'thread/turns/list') return { data: turns };
    if (method === 'thread/items/list') return { data: items, nextCursor: null };
    throw new Error('unexpected ' + method);
  }, close() { this.closed = true; } };
  const context = {
    document, fetch, Date: class extends Date { static now() { return now; } },
    setInterval: () => 1, clearInterval() {},
    chrome: { storage: { local: { get: async key => ({ [key]: stored[key] }), set: async v => Object.assign(stored, v) } } },
  };
  context.globalThis = context;
  context.__cvTurns = { isStreaming: () => streaming };
  context.__cvSpeed = { snapshot: () => speed };
  context.__cvCodexThread = {
    connect: async () => client,
    resolve: async (conv, token, { client: shared }) => {
      assert.equal(conv.mapping.n0.message.id, USER, '只传 ID 与结构字段');
      assert.equal(conv.mapping.n0.message.content.parts.length, 0, '不传正文');
      shared.close();
      if (resolveError) throw Object.assign(new Error(resolveError), { code: 'LOOKUP_NO_MATCH' });
      return { candidates: [{ threadId: ROOT }], requiresConfirmation: false };
    },
    threadUrl: id => `https://chatgpt.com/local/${id}?hostId=local`,
  };
  vm.runInNewContext(source, context);
  const api = context.__cvStalledTurn;
  api.attach({ conversationId: () => CONV, accessToken: async () => 'token',
    reload: () => { reloads++; },
    loadConversation: async id => { loads.push(id); if (loaded) api.observeConversation(loaded); } });
  return { api, els, body, fetches, rpc, loads, client, stored, get reloads() { return reloads; },
    advance: ms => { now += ms; }, setStreaming: v => { streaming = v; }, setSpeed: v => { speed = v; } };
}

const IDLE = 5 * 60_000 + 1;
const STALL = 15 * 60_000 + 1;

test('Codex 已完成、页面仍 IS_STREAMING：提示打开 Codex，并暂停该对话的自动同步', async () => {
  const f = fixture();
  f.api.observeConversation(conversation());
  await f.api.check();
  assert.equal(f.fetches.length, 0, '刚开始观察不问服务端');
  f.advance(IDLE);
  await f.api.check();
  assert.deepEqual(f.fetches, [`/backend-api/conversation/${CONV}/stream_status`]);
  assert.equal(f.api.status().phase, 'codex-completed', f.api.status().error);
  assert.match(f.els.t.textContent, /Codex 已完成本轮（用时 2h04m/);
  assert.equal(f.els.a.href, `https://chatgpt.com/local/${ROOT}?hostId=local`);
  assert.equal(f.body.children.length, 1);
  assert.equal(f.api.pausesSync(CONV), true);
  assert.ok(f.client.closed, '连接用完即关');
  assert.equal(f.loads.length, 0, '已有证据时不读整段对话');
  f.setStreaming(false);
  await f.api.check();
  assert.equal(f.body.children.length, 0, '本轮结束撤掉提示');
  assert.equal(f.api.pausesSync(CONV), false);
});

test('stream_status 不是 IS_STREAMING：不连接 Codex', async () => {
  const f = fixture({ streamStatus: 'IS_IDLE' });
  f.api.observeConversation(conversation());
  await f.api.check(); f.advance(IDLE); await f.api.check();
  assert.equal(f.api.status().phase, 'chat-not-streaming');
  assert.equal(f.rpc.length, 0);
  assert.equal(f.body.children.length, 0);
});

test('Chat 模式（无 async_source）：不扫描 Codex 线程', async () => {
  const f = fixture();
  f.api.observeConversation(conversation({ work: false }));
  await f.api.check(); f.advance(IDLE); await f.api.check();
  assert.equal(f.api.status().phase, 'chat-mode');
  assert.equal(f.rpc.length, 0);
  assert.equal(f.api.pausesSync(CONV), false);
});

test('Codex 里找不到与本轮精确对应的 turn：不下结论', async () => {
  const f = fixture({ turns: [{ id: '01a11a8b-0000-7000-8000-b4b996a6fd4c', status: 'completed' }],
    items: [{ turnId: '01a11a8b-0000-7000-8000-b4b996a6fd4c', item: { type: 'userMessage', clientId: '11111111-1111-4111-8111-111111111111' } }] });
  f.api.observeConversation(conversation());
  await f.api.check(); f.advance(IDLE); await f.api.check();
  assert.equal(f.api.status().phase, 'unverified');
  assert.equal(f.body.children.length, 0);
  assert.equal(f.api.pausesSync(CONV), false);
});

test('Codex 仍在执行：提示页面推送中断；流帧恢复后撤掉', async () => {
  const f = fixture({ turns: [{ id: TURN, status: 'inProgress', startedAt: 1791446726 }] });
  f.api.observeConversation(conversation());
  await f.api.check(); f.advance(IDLE); await f.api.check();
  assert.equal(f.api.status().phase, 'codex-running');
  assert.match(f.els.t.textContent, /页面推送已中断 · Codex 仍在执行/);
  f.setSpeed({ userMessageId: USER, lastFrameAtMs: 1_000_000 + IDLE + 1000 });
  f.advance(2000);
  await f.api.check();
  assert.equal(f.body.children.length, 0);
  assert.equal(f.api.status().phase, 'watching');
});

test('流帧持续到达：不请求任何接口', async () => {
  const f = fixture();
  f.api.observeConversation(conversation());
  await f.api.check();
  for (let i = 0; i < 20; i++) {
    f.advance(60_000);
    f.setSpeed({ userMessageId: USER, lastFrameAtMs: 1_000_000 + (i + 1) * 60_000 - 1000 });
    await f.api.check();
  }
  assert.equal(f.fetches.length, 0);
});

test('刷新后没有本轮证据：每轮至多主动读一次对话，之后靠定时同步', async () => {
  const f = fixture({ loaded: null });
  await f.api.check();
  for (let i = 0; i < 4; i++) { f.advance(IDLE); await f.api.check(); }
  assert.equal(f.loads.length, 1);
  assert.equal(f.api.status().phase, 'no-evidence');
});

test('证据按对话持久化，刷新后的新页面可直接使用', async () => {
  const first = fixture();
  first.api.observeConversation(conversation());
  await new Promise(resolve => setImmediate(resolve));
  const saved = first.stored[`cvWorkRoundV1:${CONV}`];
  assert.equal(saved.userMessageId, USER);
  assert.equal(saved.workMode, true);
  assert.equal(JSON.stringify(saved.turnIds), JSON.stringify([TURN]));
  assert.equal(JSON.stringify(saved).includes('task'), false, '不存正文');
});

test('Codex 核对失败 + 页面静默超时：给通用推送中断告警（可刷新、可关闭）', async () => {
  const f = fixture({ resolveError: '未在当前账号根线程开头找到用户消息 ID、工作活动或首条用户消息匹配。可用“深度查找”检查后续历史；未找到不等于没有。' });
  f.api.observeConversation(conversation());
  await f.api.check(); f.advance(IDLE); await f.api.check();
  assert.equal(f.api.status().phase, 'error');
  assert.equal(f.api.status().stallAlert, false, '刚过 5 分钟静默先不打扰');
  assert.equal(f.body.children.length, 0);
  f.advance(STALL); await f.api.check();
  assert.equal(f.api.status().stallAlert, true);
  assert.equal(f.body.children.length, 1);
  assert.match(f.els.t.textContent, /^页面推送已中断 · 已 \d+m 无新内容$/);
  assert.match(f.els.b.title, /未能核对 Codex 轮次/);
  assert.match(f.els.b.title, /深度查找/);
  assert.equal(f.els.a.style.display, 'none', '没有 Codex 链接就不显示');
  assert.notEqual(f.els.r.style.display, 'none', '给出刷新按钮');
  assert.equal(f.api.pausesSync(CONV), false, '通用告警不改自动同步行为');
  f.els.r.click();
  assert.equal(f.reloads, 1);
  f.els.x.click();
  assert.equal(f.body.children.length, 0, '可手动关掉');
  f.setSpeed({ userMessageId: USER, lastFrameAtMs: 1_000_000 + IDLE + STALL });
  f.advance(1000);
  await f.api.check();
  assert.equal(f.api.status().phase, 'watching', '流帧恢复后相位复位');
  assert.equal(f.api.status().stallAlert, false);
});

test('Chat 模式页面静默超时：同样给出通用告警，且不扫账号线程', async () => {
  const f = fixture();
  f.api.observeConversation(conversation({ work: false }));
  await f.api.check(); f.advance(IDLE); await f.api.check();
  assert.equal(f.api.status().phase, 'chat-mode');
  assert.equal(f.body.children.length, 0);
  f.advance(STALL); await f.api.check();
  assert.equal(f.api.status().stallAlert, true);
  assert.match(f.els.b.title, /Chat 模式/);
  assert.equal(f.els.r.style.display, '', '通用告警提供刷新按钮');
  assert.equal(f.rpc.length, 0, 'Chat 模式不扫账号线程');
  f.setStreaming(false);
  await f.api.check();
  assert.equal(f.body.children.length, 0, '本轮结束撤掉告警');
});
