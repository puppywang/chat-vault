import '../extensions/chatgpt-sync/stream-parser.js';
import { countTexts } from '../extensions/chatgpt-sync/tokenizer.js';
import { isFinalAssistantMessage } from './chatgpt-stream-completion.js';
const { createParser, textParts } = globalThis.ChatVaultStreamParser;

function legacy(e) {
  if (e.params) return e;
  const params = { requestId: e.request_id, timestamp: e.monotonic_timestamp };
  if (e.method === 'Network.requestWillBeSent') params.request = { url: e.url, method: e.http_method };
  if (e.method === 'Network.responseReceived') params.response = { url: e.url, mimeType: e.mime_type, status: e.status };
  if (e.method === 'Network.dataReceived') params.data = e.data_base64;
  if (e.method === 'Network.streamResourceContent') params.bufferedData = e.buffered_data_base64;
  if (e.method === 'Network.webSocketFrameReceived') params.response = { payloadData: e.payload_data, opcode: e.opcode };
  return { ...e, params, at_ms: Date.parse(e.at) };
}
export function createStreamReplay({ conversationId = null } = {}) {
  const rounds = [], requests = new Map(), streams = new Map(), latest = new Map(), snapshots = [], gaps = [];
  let offset = null, lastSequence = 0, events = 0;
  function make(id, at, body = {}) {
    const parser = createParser({ conversationId: body.conversation_id || conversationId,
      userMessageId: body.messages?.findLast(m => m.author?.role === 'user')?.id || null,
      requestStartMs: at });
    const round = { request_id: id, parser, buffered_first_text: false, turn_complete: false };
    rounds.push(round); requests.set(id, round);
    streams.set(id, { round, connection: parser.openSse(), bufferReady: false, pending: [], endedAt: null });
    if (parser.state.conversationId) latest.set(parser.state.conversationId, round);
    return round;
  }
  function sse(stream, bytes, at, buffered = false) {
    const round = stream.round;
    const before = round.parser.state.firstTextAtMs;
    stream.connection.consumeBytes(Buffer.from(bytes, 'base64'), at);
    if (buffered && before == null && round.parser.state.firstTextAtMs != null) round.buffered_first_text = true;
    const id = round.parser.state.conversationId;
    if (id) latest.set(id, round);
  }
  function close(stream, at, aborted = false) {
    if (!stream.bufferReady) { stream.endedAt = at; stream.aborted = aborted; return; }
    if (aborted) stream.connection.cancel();
    else stream.connection.end(at);
  }
  function accept(raw) {
    const e = legacy(raw), p = e.params || {};
    events++;
    if (Number.isInteger(e.seq)) {
      if (e.seq !== lastSequence + 1) gaps.push({ reason: 'sequence_gap', expected: lastSequence + 1, actual: e.seq });
      lastSequence = e.seq;
    }
    if (e.method === 'Capture.gap' || e.method === 'Capture.storageError'
      || e.method === 'Capture.commandError' && p.data_gap) gaps.push({ seq: e.seq, ...p });
    if (e.method === 'Network.requestWillBeSent' && Number.isFinite(p.wallTime) && Number.isFinite(p.timestamp)) offset = p.wallTime * 1000 - p.timestamp * 1000;
    const at = Number.isFinite(p.timestamp) && offset != null ? p.timestamp * 1000 + offset : e.at_ms;
    if (e.method === 'Network.requestWillBeSent' && p.request?.method === 'POST'
      && /\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(p.request.url || '')) {
      let body = {};
      try { body = JSON.parse(p.request.postData || '{}'); } catch { gaps.push({ seq: e.seq, reason: 'invalid_request_body' }); }
      make(p.requestId, at, body);
    }
    if (e.method === 'Network.responseReceived' && /text\/event-stream/i.test(p.response?.mimeType || '')) {
      if (!requests.has(p.requestId)) {
        const resumed = latest.get(conversationId);
        if (resumed && !resumed.turn_complete) {
          requests.set(p.requestId, resumed);
          streams.set(p.requestId, { round: resumed, connection: resumed.parser.openSse(), bufferReady: false, pending: [], endedAt: null });
        } else make(p.requestId, null);
      }
    }
    const round = requests.get(p.requestId);
    const stream = streams.get(p.requestId);
    if (e.method === 'Capture.requestBody' && round) {
      try {
        const body = JSON.parse(p.postData);
        round.parser.state.userMessageId ||= body.messages?.findLast(m => m.author?.role === 'user')?.id || null;
        round.parser.state.conversationId ||= body.conversation_id || null;
        if (round.parser.state.conversationId) latest.set(round.parser.state.conversationId, round);
      } catch { gaps.push({ seq: e.seq, reason: 'invalid_request_body' }); }
    }
    if (e.method === 'Network.streamResourceContent' && stream) {
      if (p.bufferedData) sse(stream, p.bufferedData, at, true);
      stream.bufferReady = true;
      for (const pending of stream.pending) sse(stream, pending.data, pending.at);
      stream.pending = [];
      if (stream.endedAt != null) close(stream, stream.endedAt, stream.aborted);
    }
    if (e.method === 'Network.dataReceived' && typeof p.data === 'string' && stream) {
      if (!stream.bufferReady) stream.pending.push({ data: p.data, at });
      else sse(stream, p.data, at);
    }
    if ((e.method === 'Network.loadingFinished' || e.method === 'Network.loadingFailed') && stream) close(stream, at, e.method === 'Network.loadingFailed');
    if (e.method === 'Network.webSocketFrameReceived' && p.response?.opcode === 1) {
      let items;
      try { items = JSON.parse(p.response.payloadData); } catch { return; }
      for (const item of Array.isArray(items) ? items : [items]) {
        const envelope = item?.payload, entry = envelope?.payload;
        if (!entry || (conversationId && entry.conversation_id !== conversationId)) continue;
        if (envelope.type === 'conversation-turn-stream' && entry.type === 'stream-item') {
          let r = latest.get(entry.conversation_id);
          if (!r) r = make(`resumed:${entry.turn_id || entry.conversation_id}`, null, { conversation_id: entry.conversation_id });
          r.parser.consumeWs(entry.encoded_item, at, entry.stream_item_id);
        } else if (envelope.type === 'conversation-turn-complete') {
          const r = latest.get(entry.conversation_id);
          if (r) { r.turn_complete = true; r.parser.finish(at); }
        }
      }
    }
    if (e.method === 'Capture.snapshot' && p.conversation?.mapping) snapshots.push(p.conversation);
    if (e.method === 'Network.getResponseBody' && /\/conversation\/[0-9a-f-]{36}(?:\?|$)/i.test(p.url || '')) {
      try {
        const data = JSON.parse(p.base64Encoded ? Buffer.from(p.body, 'base64').toString('utf8') : p.body);
        if (data.mapping) snapshots.push(data);
      } catch { gaps.push({ seq: e.seq, reason: 'invalid_snapshot_body' }); }
    }
  }
  function snapshotRound(conv, userId) {
    const branch = []; let id = conv.current_node; const seen = new Set();
    while (id && conv.mapping[id] && !seen.has(id)) { seen.add(id); branch.push(conv.mapping[id].message); id = conv.mapping[id].parent; }
    branch.reverse();
    const start = branch.findIndex(m => m?.id === userId);
    if (start < 0) return null;
    const next = branch.findIndex((m, i) => i > start && m?.author?.role === 'user');
    const segment = branch.slice(start + 1, next < 0 ? undefined : next);
    return { completed: isFinalAssistantMessage(segment.at(-1)), messages: segment.filter(m => m?.author?.role === 'assistant'
      && m.content?.content_type !== 'model_editable_context').map(m => ({ id: m.id,
        text: textParts(m).map(([, text]) => text).join('') })) };
  }
  function report() {
    for (const [id, stream] of streams) if (stream.pending.length) {
      gaps.push({ request_id: id, reason: 'missing_sse_buffer_ack' });
      for (const pending of stream.pending) sse(stream, pending.data, pending.at);
      stream.pending = [];
    }
    return { version: 1, events, last_sequence: lastSequence, gaps,
      rounds: rounds.map(r => {
        r.parser.flush();
        const state = r.parser.state, messages = r.parser.messages().map(m => ({ ...m, tokens: countTexts([m.text]) }));
        const tokens = messages.reduce((n, m) => n + m.tokens, 0);
        const duration = state.lastTextAtMs - state.firstTextAtMs;
        const timed = Number.isFinite(state.requestStartMs) && Number.isFinite(state.firstTextAtMs) && !r.buffered_first_text && !gaps.length && !state.error;
        let reference = null;
        for (const conv of snapshots) reference = snapshotRound(conv, state.userMessageId) || reference;
        const expected = new Map(reference?.messages.map(m => [m.id, m]));
        const actual = new Map(messages.map(m => [m.id, m]));
        const differences = reference == null ? null : [...new Set([...expected.keys(), ...actual.keys()])]
          .filter(id => expected.get(id)?.text !== actual.get(id)?.text).map(id => ({ id,
            expected: expected.get(id) || null, actual: actual.get(id) || null }));
        return { request_id: r.request_id, conversation_id: state.conversationId, user_message_id: state.userMessageId,
          turn_status: reference?.completed ? 'completed' : r.turn_complete ? 'transport_completed_unverified' : 'completion_not_observed',
          timing_status: !Number.isFinite(state.requestStartMs) ? 'original_request_missing' : r.buffered_first_text ? 'first_text_buffered'
            : gaps.length ? 'capture_gap' : state.error ? 'parse_error' : state.firstTextAtMs == null ? 'assistant_text_missing' : 'measured',
          ttft_ms: timed ? state.firstTextAtMs - state.requestStartMs : null,
          tps: timed && duration > 0 && state.textChunks >= 2 ? tokens * 1000 / duration : null,
          token_count: tokens, tokenizer: 'o200k_base', state, messages,
          comparison: reference == null ? { status: 'snapshot_or_user_id_missing' }
            : { status: differences.length ? 'different' : !reference.completed && !messages.length ? 'empty_round_unverified' : 'equal',
              expected_tokens: countTexts(reference.messages.map(m => m.text)), differences } };
      }) };
  }
  return { accept, report };
}
