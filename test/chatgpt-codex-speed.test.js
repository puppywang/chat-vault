import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => fs.readFileSync(new URL(`../extensions/chatgpt-sync/${name}`, import.meta.url), 'utf8');
const THREAD = '01a121d4-1829-724c-9fcb-1357e0f885fa';
const OTHER = '01a121d4-0000-724c-9fcb-bbbc122a28b9';
const URL_ = 'wss://codex-cloud-backend.chatgpt.com/';

/** page-stream.js（MAIN）+ speed.js（隔离世界）共用一个 window，postMessage 同步转交。 */
function setup() {
  let now = 10_000;
  const listeners = [];
  const timers = [];
  const location = { pathname: `/local/${THREAD}`, origin: 'https://chatgpt.com', href: `https://chatgpt.com/local/${THREAD}?hostId=local` };
  const window = {
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: data => { for (const fn of listeners) fn({ source: window, origin: location.origin, data }); },
  };
  class FakeWebSocket {
    constructor(url) { this.url = url; this.sent = []; this.handlers = []; }
    addEventListener(type, fn) { if (type === 'message') this.handlers.push(fn); }
    send(data) { this.sent.push(data); }
    push(...messages) { for (const fn of this.handlers) fn({ data: JSON.stringify(messages.length === 1 ? messages[0] : messages) }); }
  }
  window.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' } });
  window.WebSocket = FakeWebSocket;
  const tokens = [];
  const chrome = { runtime: { sendMessage: async m => { tokens.push(m.texts.join('')); return { ok: true, tokens: m.texts.join('').length }; } },
    storage: { local: { get: async k => (Array.isArray(k) ? {} : { ...k }), set: async () => {} }, onChanged: { addListener() {} } } };
  const context = { window, location, chrome, TextDecoder, TextEncoder, URL, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; }, clearTimeout: () => {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(read('stream-parser.js'), context);
  vm.runInContext(read('page-stream.js'), context);
  vm.runInContext(read('speed.js'), context);
  const socket = new context.window.WebSocket(URL_);
  const advance = ms => { now += ms; for (const t of timers.splice(0)) if (t.at <= now) t.fn(); else timers.push(t); };
  return { speed: context.__cvSpeed, socket, advance, at: () => now, tokens, location, window };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const delta = (text, itemId = 'msg1', method = 'item/agentMessage/delta') => ({ method, params: { threadId: THREAD, turnId: 't1', itemId, delta: text } });

test('Codex 页面：本页发出的 turn/start 是原始起点，首段增量给出 TTFT，分词后给出 ≈TPS', async () => {
  const p = setup();
  p.socket.send(JSON.stringify({ id: 7, method: 'turn/start', params: { threadId: THREAD, input: [] } }));
  p.speed.beginRound({ startMs: p.at() + 300, resumed: true });   // 页面靠停止按钮发现这一轮，DOM 判为续接
  p.advance(500);
  p.socket.push({ method: 'turn/started', params: { threadId: THREAD, turn: { id: 't1' } } });
  p.advance(2500);
  p.socket.push(delta('先想一下', 'r1', 'item/reasoning/summaryTextDelta'));
  p.advance(1000);
  p.socket.push(delta('Hello'));
  p.advance(1000);
  p.socket.push(delta(' world'));
  p.advance(1500);
  p.socket.push({ method: 'turn/completed', params: { threadId: THREAD, turn: { id: 't1', status: 'completed' } } });
  await settle(); await settle();
  const s = p.speed.snapshot();
  assert.equal(s.ttftMs, 3000, 'turn/start → 首段文本');
  assert.ok(s.tps > 0, `应有 ≈TPS：${JSON.stringify(s)}`);
  assert.equal(s.tokenCount, '先想一下'.length + 'Hello world'.length, '推理摘要和回复分别分词后求和');
  assert.ok(p.tokens.includes('Hello world'));
});

test('页面打开时这一轮已在跑（没看到 turn/start）：只给 TPS，TTFT 标缺少原始起点', async () => {
  const p = setup();
  p.speed.beginRound({ startMs: p.at(), resumed: true });
  p.socket.push(delta('a'));
  p.advance(1000);
  p.socket.push(delta('bc'));
  p.advance(1200);
  await settle(); await settle();
  const s = p.speed.snapshot();
  assert.equal(s.ttftMs, null);
  assert.equal(s.ttftReason, '缺少原始起点');
  assert.ok(s.tps > 0);
});

test('其他线程（子 agent）的增量不算进本页这一轮', async () => {
  const p = setup();
  p.socket.send(JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: THREAD } }));
  p.speed.beginRound({ startMs: p.at(), resumed: true });
  p.socket.push({ method: 'item/agentMessage/delta', params: { threadId: OTHER, turnId: 'x', itemId: 'o', delta: 'noise' } });
  p.advance(1500);
  await settle();
  const s = p.speed.snapshot();
  assert.equal(s.ttftMs, null);
  assert.equal(s.ttftReason, '等待首段文本');
});

test('Codex 页面请求记录：未回应的 JSON-RPC 请求留在 pending，回应与错误记入 recent，不记内容', async () => {
  const p = setup();
  p.socket.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'secret' } } }));
  p.socket.send(JSON.stringify({ id: 'a2', method: 'model/list', params: {} }));
  p.socket.send(JSON.stringify({ id: 3, method: 'thread/read', params: { threadId: THREAD } }));
  p.socket.send(JSON.stringify({ method: 'initialized' }));   // 通知没有 id，不记
  p.advance(400);
  p.socket.push({ id: 1, result: { userAgent: 'x' } });
  p.socket.push({ id: 3, error: { code: -32600, message: 'thread not found' } });
  p.socket.send(JSON.stringify({ id: 4, method: 'thread/resume', params: { threadId: THREAD } }));
  p.socket.send(JSON.stringify({ id: 5, method: 'thread/items/list', params: {} }));
  p.socket.push({ id: 4, error: { code: -32603, data: { grpcStatusCode: 9 }, message: 'Something went wrong.' } });
  p.socket.push({ id: 5, result: { data: [{ type: 'commandExecution', error: { message: 'not a response error' } }] } });
  p.socket.push({ method: 'thread/status/changed', params: { threadId: THREAD } });
  p.socket.push({ method: 'thread/status/changed', params: { threadId: THREAD } });
  p.advance(2000);
  const snap = JSON.parse(JSON.stringify(p.window.__cvCodexRpc.snapshot()));
  assert.equal(snap.sockets, 1);
  assert.deepEqual(snap.pending.map(r => [r.method, r.id, r.waitingMs]), [['model/list', 'a2', 2400]]);
  assert.deepEqual(snap.recent.map(r => [r.method, r.ms, r.error]), [['initialize', 400, null], ['thread/read', 400, 'thread not found'],
    ['thread/resume', 0, 'Something went wrong.'], ['thread/items/list', 0, null]], '嵌套 data 的错误也认出来；结果里条目的 error 字段不算');
  assert.ok(!JSON.stringify(snap).includes('secret'), '不记请求内容');
  assert.deepEqual(snap.notices.map(n => [n.method, n.count]), [['thread/status/changed', 2]], '服务端通知只计方法名和次数');
  assert.equal(p.window.__cvCodexRpc.snapshot(1).recent.length, 1);
});

test('打开线程页的结果：没发 thread/resume 记为 warm，恢复成功带 resumeKind，恢复失败带错误', async () => {
  const seen = [];
  const p = setup();
  p.window.addEventListener('message', e => { if (e.data?.__cvCodexResumeV1) seen.push(e.data); });
  // 先发一条普通请求：本页线程开始被观察
  p.socket.send(JSON.stringify({ id: 1, method: 'thread/read', params: { threadId: THREAD } }));
  p.advance(20001);
  assert.deepEqual(seen.map(s => [s.threadId, s.outcome]), [[THREAD, 'warm']]);

  const q = setup();
  const got = [];
  q.window.addEventListener('message', e => { if (e.data?.__cvCodexResumeV1) got.push(e.data); });
  q.socket.send(JSON.stringify({ id: 9, method: 'thread/resume', params: { threadId: THREAD } }));
  q.advance(14600);
  q.socket.push({ id: 9, error: { code: -32603, data: { grpcStatusCode: 9 }, message: 'Something went wrong.' } });
  q.advance(20000);
  assert.deepEqual(got.map(s => [s.outcome, s.ms, s.error]), [['failed', 14600, 'Something went wrong.']], '恢复过就不再记 warm');

  const r = setup();
  const ok = [];
  r.window.addEventListener('message', e => { if (e.data?.__cvCodexResumeV1) ok.push(e.data); });
  r.socket.send(JSON.stringify({ id: 2, method: 'thread/resume', params: { threadId: THREAD } }));
  r.advance(800);
  r.socket.push({ id: 2, result: { thread: { id: THREAD }, resumeKind: 'warm' } });
  assert.deepEqual(ok.map(s => [s.outcome, s.resumeKind]), [['resumed', 'warm']]);
});
