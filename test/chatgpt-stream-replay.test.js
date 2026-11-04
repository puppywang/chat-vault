import assert from 'node:assert/strict';
import test from 'node:test';
import { createStreamReplay } from '../src/chatgpt-stream-replay.js';
import { snapshotFinishedForUser } from '../src/chatgpt-stream-completion.js';
const CONV = '11111111-1111-1111-1111-111111111111';
test('真实 CDP 时序离线回放：SSE 字节拆包、隐藏工具调用、WS 去重与最终快照对账', () => {
  const replay = createStreamReplay({ conversationId: CONV });
  let seq = 0;
  const send = (method, params, at_ms) => replay.accept({ seq: ++seq, method, params, at_ms });
  send('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({ conversation_id: CONV, messages: [{ id: 'u1', author: { role: 'user' } }] }) } }, 1000);
  send('Network.responseReceived', { requestId: 'r1', response: { mimeType: 'text/event-stream' } }, 1100);
  send('Network.streamResourceContent', { requestId: 'r1', bufferedData: '' }, 1101);
  const text = `data: ${JSON.stringify({ v: { message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你好'] } } } })}\n\n`;
  const bytes = Buffer.from(text), cut = bytes.indexOf(0xe4) + 1;
  send('Network.dataReceived', { requestId: 'r1', data: bytes.subarray(0, cut).toString('base64') }, 1400);
  send('Network.dataReceived', { requestId: 'r1', data: bytes.subarray(cut).toString('base64') }, 1500);
  function ws(value, itemId, at) {
    send('Network.webSocketFrameReceived', { response: { opcode: 1, payloadData: JSON.stringify([{ type: 'message',
      payload: { type: 'conversation-turn-stream', payload: { type: 'stream-item', conversation_id: CONV,
        stream_item_id: itemId, encoded_item: `data: ${JSON.stringify(value)}\n\n` } } }]) } }, at);
  }
  ws({ v: { message: { id: 'a2', author: { role: 'assistant' }, recipient: 'Chappie', content: { content_type: 'code', parts: ['{"cmd":"ls"}'] } } } }, 's1', 2000);
  ws({ p: '/message/content/parts/0', o: 'append', v: '\n' }, 's2', 2500);
  ws({ p: '/message/content/parts/0', o: 'append', v: '\n' }, 's2', 2501);
  send('Capture.snapshot', { conversation: { current_node: 'a2', mapping: {
    u1: { parent: null, message: { id: 'u1', author: { role: 'user' } } },
    a1: { parent: 'u1', message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你好'] } } },
    a2: { parent: 'a1', message: { id: 'a2', author: { role: 'assistant' }, content: { content_type: 'code', parts: ['{"cmd":"ls"}\n'] } } },
  } } }, 3000);
  const report = replay.report(), round = report.rounds[0];
  assert.equal(round.ttft_ms, 500);
  assert.equal(round.messages[1].text, '{"cmd":"ls"}\n');
  assert.equal(round.comparison.status, 'equal');
  assert.equal(round.comparison.expected_tokens, round.token_count);
  assert.equal(report.gaps.length, 0);
});


test('缺少原始请求或首段仅在缓冲区时，回放不伪造 TTFT', () => {
  const replay = createStreamReplay({ conversationId: CONV });
  replay.accept({ method: 'Network.responseReceived', at_ms: 2000, params: { requestId: 'r', response: { mimeType: 'text/event-stream' } } });
  replay.accept({ method: 'Network.streamResourceContent', at_ms: 2001, params: { requestId: 'r', bufferedData: Buffer.from(`data: ${JSON.stringify({ v: { message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['hi'] } } } })}\n\n`).toString('base64') } });
  assert.equal(replay.report().rounds[0].ttft_ms, null);
  assert.equal(replay.report().rounds[0].timing_status, 'original_request_missing');
});


test('F5 续流沿用原始轮次与时间，但不拼接上一条 SSE 连接的残缺 UTF-8 字节', () => {
  const replay = createStreamReplay({ conversationId: CONV });
  let seq = 0;
  const send = (method, params, at_ms) => replay.accept({ seq: ++seq, method, params, at_ms });
  send('Network.requestWillBeSent', { requestId: 'original', request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation',
    postData: JSON.stringify({ conversation_id: CONV, messages: [{ id: 'u1', author: { role: 'user' } }] }) } }, 1000);
  send('Network.responseReceived', { requestId: 'original', response: { mimeType: 'text/event-stream' } }, 1100);
  send('Network.streamResourceContent', { requestId: 'original', bufferedData: '' }, 1101);
  const initial = `data: ${JSON.stringify({ v: { message: { id: 'a1', author: { role: 'assistant' }, content: { parts: ['你'] } } } })}\n\n`;
  const truncated = Buffer.concat([Buffer.from(initial + 'data: {"v":"'), Buffer.from([0xe4])]);
  send('Network.dataReceived', { requestId: 'original', data: truncated.toString('base64') }, 1500);
  send('Network.loadingFailed', { requestId: 'original', errorText: 'net::ERR_ABORTED' }, 1600);
  send('Capture.navigation', { url: `https://chatgpt.com/c/${CONV}` }, 1700);
  send('Network.responseReceived', { requestId: 'resume', response: { mimeType: 'text/event-stream' } }, 1800);
  send('Network.streamResourceContent', { requestId: 'resume', bufferedData: '' }, 1801);
  send('Network.dataReceived', { requestId: 'resume', data: Buffer.from(`data: ${JSON.stringify({ p: '/message/content/parts/0', o: 'append', v: '好' })}\n\n`).toString('base64') }, 2000);
  send('Network.webSocketFrameReceived', { response: { opcode: 1, payloadData: JSON.stringify([{ type: 'message',
    payload: { type: 'conversation-turn-complete', payload: { conversation_id: CONV } } }]) } }, 2200);
  const report = replay.report();
  assert.equal(report.rounds.length, 1);
  assert.equal(report.rounds[0].messages[0].text, '你好');
  assert.equal(report.rounds[0].ttft_ms, 500);
  assert.equal(report.rounds[0].timing_status, 'measured');
  assert.equal(report.rounds[0].turn_status, 'transport_completed_unverified');
  assert.equal(report.rounds[0].state.error, null);
});


test('结束快照必须属于当前用户轮次；旧回复、工具等待和思考回顾均不能触发停止', () => {
  const conversation = { current_node: 'a1', mapping: {
    u1: { parent: null, message: { id: 'u1', author: { role: 'user' } } },
    a1: { parent: 'u1', message: { id: 'a1', author: { role: 'assistant' }, status: 'finished_successfully',
      end_turn: true, content: { content_type: 'text', parts: ['done'] } } },
  } };
  assert.equal(snapshotFinishedForUser(conversation, 'u1'), true);
  assert.equal(snapshotFinishedForUser(conversation, 'u2'), false);
  conversation.mapping.a1.message.content.content_type = 'reasoning_recap';
  assert.equal(snapshotFinishedForUser(conversation, 'u1'), false);
  conversation.mapping.a1.message.author.role = 'tool';
  assert.equal(snapshotFinishedForUser(conversation, 'u1'), false);
});


test('回放工具占位符后的 transport-complete 不会误报整轮完成或空 token 验收成功', () => {
  const replay = createStreamReplay({ conversationId: CONV });
  replay.accept({ seq: 1, at_ms: 1000, method: 'Network.requestWillBeSent', params: { requestId: 'r', request: {
    method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: JSON.stringify({ conversation_id: CONV,
      messages: [{ id: 'u1', author: { role: 'user' } }] }) } } });
  replay.accept({ seq: 2, at_ms: 1100, method: 'Network.webSocketFrameReceived', params: { response: { opcode: 1,
    payloadData: JSON.stringify([{ type: 'message', payload: { type: 'conversation-turn-complete', payload: { conversation_id: CONV, current_message_id: 'tool1' } } }]) } } });
  replay.accept({ seq: 3, at_ms: 1200, method: 'Capture.snapshot', params: { conversation: {
    current_node: 'tool1', mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' } } },
      tool1: { parent: 'u1', message: { id: 'tool1', author: { role: 'tool' }, status: 'in_progress', content: { parts: [] } } },
    },
  } } });
  const round = replay.report().rounds[0];
  assert.equal(round.turn_status, 'transport_completed_unverified');
  assert.equal(round.timing_status, 'assistant_text_missing');
  assert.equal(round.ttft_ms, null);
  assert.equal(round.comparison.status, 'empty_round_unverified');
});
