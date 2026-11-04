import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/stream-parser.js', import.meta.url), 'utf8')
  + fs.readFileSync(new URL('../extensions/chatgpt-sync/page-stream.js', import.meta.url), 'utf8');
const CONV = '11111111-1111-1111-1111-111111111111';

test('追加文本约每秒触发一次分词，首段和结束立即发送累计文本', () => {
  const parserSource = fs.readFileSync(new URL('../extensions/chatgpt-sync/stream-parser.js', import.meta.url), 'utf8');
  const context = { TextDecoder };
  vm.runInNewContext(parserSource, context);
  const samples = [];
  const parser = context.ChatVaultStreamParser.createParser({ conversationId: CONV,
    requestStartMs: 1000, onText: sample => samples.push(sample) });
  const send = (event, atMs) => parser.consumeSse(`data: ${JSON.stringify(event)}\n\n`, atMs);
  send({ message: { id: 'a1', author: { role: 'assistant' },
    content: { content_type: 'text', parts: ['a'] } } }, 2000);
  assert.deepEqual(samples.map(sample => sample.text), ['a']);
  send({ p: '/message/content/parts/0', o: 'append', v: 'b' }, 2200);
  send({ v: 'c' }, 2900);
  assert.equal(samples.length, 1, '未到一秒不因每个续片重复分词');
  send({ v: 'd' }, 3000);
  assert.deepEqual(samples.map(sample => sample.text), ['a', 'abcd']);
  send({ v: 'e' }, 3100);
  send({ type: 'message_stream_complete' }, 3200);
  assert.deepEqual(samples.map(sample => sample.text), ['a', 'abcd', 'abcde']);
  assert.equal(samples.at(-1).lastTextAtMs, 3100);
});

function fixture(frames, contentType = 'text/event-stream', abortAfterChunks = false) {
  const posted = [];
  const encoder = new TextEncoder();
  const bytes = encoder.encode(frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''));
  const cut = bytes.indexOf(0xe4) + 1; // 故意把中文 UTF-8 切开
  const chunks = [bytes.slice(0, cut), bytes.slice(cut)];
  let clones = 0;
  let fetches = 0;
  let now = 1000;
  const response = {
    ok: true, headers: { get: () => contentType },
    clone() {
      clones++;
      let index = 0;
      return { body: { getReader() {
        return { async read() {
          if (index >= chunks.length) {
            if (abortAfterChunks) throw new Error('stream cancelled');
            return { done: true };
          }
          now += 500;
          return { done: false, value: chunks[index++] };
        }, releaseLock() {} };
      } } };
    },
  };
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(value) { this.listeners.get('message')?.({ data: JSON.stringify(value) }); }
  }
  const window = {
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    fetch: async () => { fetches++; return response; },
    postMessage: (value) => posted.push(value),
    WebSocket: FakeWebSocket,
  };
  const context = { window, location: { href: `https://chatgpt.com/c/${CONV}`,
    pathname: `/c/${CONV}`, origin: 'https://chatgpt.com' }, URL, TextDecoder,
  Date: { now: () => now } };
  vm.runInNewContext(source, context);
  return { window, response, posted, advance: (ms) => { now += ms; },
    counts: () => ({ clones, fetches }) };
}

test('只克隆目标 SSE；UTF-8 拆包和无路径续片拼为同一助手文本', async () => {
  const { window, response, posted, counts } = fixture([
    { type: 'input_message', input_message: { id: 'u1' }, conversation_id: CONV },
    { v: { message: { author: { role: 'assistant' }, channel: 'final',
      content: { content_type: 'text', parts: [''] } } } },
    { p: '/message/content/parts/0', o: 'append', v: '你好' },
    { v: '，世界' },
    { type: 'server_ste_metadata', metadata: { server_ttfvt_ms: 900 } },
    { type: 'message_stream_complete' },
  ]);
  assert.equal(await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' }), response);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(counts(), { clones: 1, fetches: 1 });
  const latest = posted.filter(value => value.kind !== 'tokenize').at(-1);
  const tokenSample = posted.filter(value => value.kind === 'tokenize').at(-1);
  assert.equal(latest.userMessageId, 'u1');
  assert.equal(latest.firstTextAtMs, 2000, JSON.stringify(latest));
  assert.equal(latest.outputTokens, null);
  assert.equal(latest.textChunks, 2);
  assert.equal(latest.serverTtfvtMs, 900);
  assert.ok(latest.completedAtMs >= latest.firstTextAtMs);
  assert.equal(tokenSample.text, '你好，世界');
  assert.equal(JSON.stringify(posted.filter(value => value.kind !== 'tokenize')).includes('你好'), false,
    '普通指标不传正文，仅后台分词快照传');
  assert.ok(latest.eventShapes.some(shape => shape.messageRole === 'assistant'
    && shape.contentType === 'text'));
  assert.ok(latest.eventShapes.some(shape => shape.path === '/message/content/parts/#'));
  assert.equal(JSON.stringify(latest.eventShapes).includes('你好'), false,
    '协议形状诊断不得包含正文');
});

test('非会话请求与非 SSE 响应不克隆；有服务端 usage 才转发输出 token', async () => {
  const { window, posted, counts } = fixture([
    { type: 'input_message', input_message: { id: 'u2' }, conversation_id: CONV },
    { v: { message: { author: { role: 'assistant' }, channel: 'final',
      content: { content_type: 'text', parts: ['hello'] } } } },
    { type: 'message_stream_complete', usage: { output_tokens: 50 } },
  ]);
  await window.fetch('https://chatgpt.com/backend-api/conversation/init', { method: 'POST' });
  assert.equal(counts().clones, 0);
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.filter(value => value.kind !== 'tokenize').at(-1).outputTokens, 50);
  assert.equal(counts().clones, 1);

  const other = fixture([], 'application/json');
  await other.window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  assert.equal(other.counts().clones, 0);
});

test('兼容 WS 直接 message 快照，完整分析和 Chappie 调用文本参与计数，工具返回不计入', async () => {
  const { window, posted } = fixture([]);
  const socket = new window.WebSocket('wss://example.test');
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  function emit(message, id) {
    socket.emit([{ type: 'message', payload: { type: 'conversation-turn-stream', payload: { type: 'stream-item',
      conversation_id: CONV, stream_item_id: id, encoded_item: `data: ${JSON.stringify({ conversation_id: CONV, error: null, error_code: null, message })}\n\n` } } }]);
  }
  emit({ id: 'a1', author: { role: 'assistant' }, channel: 'analysis', content: { content_type: 'text', parts: ['计划'] } }, 's1');
  emit({ id: 'a2', author: { role: 'assistant' }, recipient: 'Chappie', content: { content_type: 'code', text: '{"cmd":"ls"}' } }, 's2');
  emit({ id: 't1', author: { role: 'tool' }, content: { content_type: 'text', parts: ['not an output token'] } }, 's3');
  socket.emit([{ type: 'message', payload: { type: 'conversation-turn-complete', payload: { conversation_id: CONV } } }]);
  const samples = posted.filter(value => value.kind === 'tokenize');
  assert.ok(samples.some(s => s.messageId === 'a1' && s.text === '计划'));
  assert.ok(samples.some(s => s.messageId === 'a2' && s.text === '{"cmd":"ls"}'));
  assert.equal(samples.some(s => s.messageId === 't1'), false);
  const state = posted.filter(value => value.kind !== 'tokenize').at(-1);
  assert.equal(state.textChars, '计划{"cmd":"ls"}'.length);
  assert.ok(state.eventShapes.some(s => s.messageRole === 'assistant' && s.contentType === 'code'));
});

test('全部助手通道与工具调用文本参与计数，系统/工具结果不参与', async () => {
  const { window, posted } = fixture([
    { type: 'input_message', input_message: { id: 'u3' }, conversation_id: CONV },
    { v: { message: { author: { role: 'system' }, content: { content_type: 'text', parts: ['系统'] } } } },
    { v: { message: { author: { role: 'assistant' }, channel: 'analysis',
      content: { content_type: 'text', parts: ['思考'] } } } },
    { p: '/message/content/parts/0', o: 'append', v: '继续' },
    { v: { message: { author: { role: 'assistant' }, channel: 'analysis',
      content: { content_type: 'thoughts', thoughts: [{ summary: '摘要', content: '细节' }] },
      metadata: { reasoning_title: '检查环境' } } } },
    { v: { message: { author: { role: 'assistant' }, recipient: 'Chappie',
      content: { content_type: 'code', parts: ['{"cmd":"ls"}'] } } } },
    { v: { message: { author: { role: 'tool' }, content: { content_type: 'text', parts: ['工具结果'] } } } },
    { v: { message: { author: { role: 'assistant' }, channel: 'final',
      content: { content_type: 'text', parts: ['完成'] } } } },
    { type: 'message_stream_complete' },
  ]);
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  const samples = new Map(posted.filter(value => value.kind === 'tokenize')
    .map(value => [value.messageIndex, value.text]));
  assert.deepEqual([...samples.values()], ['思考继续', '摘要细节检查环境', '{"cmd":"ls"}', '完成']);
  assert.equal(posted.filter(value => value.kind !== 'tokenize').at(-1).textChunks, 7);
});

test('SSE 请求结束后继续合并 WS stream-item，直到 turn-complete', async () => {
  const { window, posted, advance } = fixture([
    { type: 'input_message', input_message: { id: 'u4' }, conversation_id: CONV },
  ]);
  const socket = new window.WebSocket('wss://chatgpt.com/backend-api/ws');
  assert.ok(socket instanceof window.WebSocket);
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.filter(value => value.kind !== 'tokenize').at(-1).firstTextAtMs, null);
  advance(2000);
  const send = (event, streamItemId) => socket.emit([{ type: 'message', topic_id: 'topic',
    payload: { type: 'conversation-turn-stream', payload: { type: 'stream-item',
      conversation_id: CONV, stream_item_id: streamItemId,
      encoded_item: `event: delta\ndata: ${JSON.stringify(event)}\n\n` } } }]);
  send({ o: 'add', v: { message: { id: 'a1', author: { role: 'assistant' },
    channel: 'commentary', content: { content_type: 'text', parts: ['正在'] } } } }, 's1');
  advance(1000);
  send({ p: '/message/content/parts/0', o: 'append', v: '检查' }, 's2');
  send({ p: '/message/content/parts/0', o: 'append', v: '检查' }, 's2');
  send({ v: { message: { id: 'tool1', author: { role: 'tool' },
    content: { content_type: 'text', parts: ['工具结果'] } } } }, 's3');
  send({ v: { message: { id: 'a2', author: { role: 'assistant' },
    channel: 'final', content: { content_type: 'text', parts: ['完成'] } } } }, 's4');
  socket.emit([{ type: 'message', payload: { type: 'conversation-turn-complete',
    payload: { conversation_id: CONV, current_message_id: 'a2' } } }]);
  const latest = posted.filter(value => value.kind !== 'tokenize').at(-1);
  assert.equal(latest.userMessageId, 'u4');
  assert.equal(latest.firstTextAtMs, 4000);
  assert.equal(latest.wsFrames, 4);
  assert.equal(latest.textChunks, 3);
  assert.equal(latest.completedAtMs, 5000);
  const samples = new Map(posted.filter(value => value.kind === 'tokenize')
    .map(value => [value.messageIndex, value.text]));
  assert.deepEqual([...samples.values()], ['正在检查', '完成']);
});

test('初始响应不是 SSE 时仍保留本轮 WS 观测', async () => {
  const { window, posted, counts, advance } = fixture([], 'application/json');
  const socket = new window.WebSocket('wss://chatgpt.com/backend-api/ws');
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(counts().clones, 0);
  advance(1500);
  socket.emit([{ type: 'message', payload: { type: 'conversation-turn-stream',
    payload: { type: 'stream-item', conversation_id: CONV, stream_item_id: 's1',
      encoded_item: `event: delta\ndata: ${JSON.stringify({ v: { message: {
        id: 'a1', author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['来自 WS'] },
      } } })}\n\n` } } }]);
  const latest = posted.filter(value => value.kind !== 'tokenize').at(-1);
  assert.equal(latest.firstTextAtMs, 2500);
  assert.equal(latest.wsFrames, 1);
  assert.equal(latest.sseFrames, 0);
});

test('收到完成标记后克隆流中断不报错；提前中断仍保留错误', async () => {
  const complete = fixture([
    { v: { message: { id: 'a1', author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['完成'] } } } },
    { type: 'message_stream_complete' },
  ], 'text/event-stream', true);
  await complete.window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  const final = complete.posted.filter(value => value.kind !== 'tokenize').at(-1);
  assert.ok(final.completedAtMs);
  assert.equal(final.error, null);

  const incomplete = fixture([
    { v: { message: { id: 'a2', author: { role: 'assistant' },
      content: { content_type: 'text', parts: ['未完成'] } } } },
  ], 'text/event-stream', true);
  await incomplete.window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(incomplete.posted.filter(value => value.kind !== 'tokenize').at(-1).error,
    'stream_read_failed');
});

test('SSE 克隆流中断后 WS 继续输出时清除误报并保留协议形状', async () => {
  const { window, posted } = fixture([
    { type: 'input_message', input_message: { id: 'u5' }, conversation_id: CONV },
  ], 'text/event-stream', true);
  const socket = new window.WebSocket('wss://chatgpt.com/backend-api/ws');
  await window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(posted.filter(value => value.kind !== 'tokenize').at(-1).error,
    'stream_read_failed');
  socket.emit([{ type: 'message', payload: { type: 'conversation-turn-stream',
    payload: { type: 'stream-item', conversation_id: CONV, stream_item_id: 's1',
      encoded_item: `event: delta\ndata: ${JSON.stringify({ v: { message: {
        id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['恢复'] },
      } } })}\n\n` } } }]);
  const latest = posted.filter(value => value.kind !== 'tokenize').at(-1);
  assert.equal(latest.error, null);
  assert.equal(latest.firstTextAtMs, 2000);
  assert.equal(latest.wsFrames, 1);
  assert.ok(latest.eventShapes.some(shape => shape.messageRole === 'assistant'));
});

test('WS 已接手后 SSE 克隆流再中断不产生误报', async () => {
  const { window, posted } = fixture([], 'text/event-stream', true);
  const socket = new window.WebSocket('wss://chatgpt.com/backend-api/ws');
  const request = window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  socket.emit([{ type: 'message', payload: { type: 'conversation-turn-stream',
    payload: { type: 'stream-item', conversation_id: CONV, stream_item_id: 's1',
      encoded_item: `event: delta\ndata: ${JSON.stringify({ v: { message: {
        id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['继续'] },
      } } })}\n\n` } } }]);
  await request;
  await new Promise(resolve => setImmediate(resolve));
  const latest = posted.filter(value => value.kind !== 'tokenize').at(-1);
  assert.equal(latest.error, null);
  assert.equal(latest.wsFrames, 1);
});

test('关闭采集后 fetch 原样透传且不再克隆；快速重新开启不复活旧请求', async () => {
  const f = fixture([{ message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['old'] } } }]);
  const control = enabled => f.window.listeners.get('message')({ source: f.window,
    origin: 'https://chatgpt.com', data: { __chatVaultStreamControlV1: true, enabled } });
  const request = f.window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' });
  control(false); control(true);
  assert.equal(await request, f.response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts().clones, 0, '上个 epoch 的 response 不进入解析器');
  const observed = f.posted.length;
  control(false);
  assert.equal(await f.window.fetch('https://chatgpt.com/backend-api/f/conversation', { method: 'POST' }), f.response);
  assert.equal(f.counts().fetches, 2);
  assert.equal(f.counts().clones, 0);
  assert.equal(f.posted.length, observed);
});
