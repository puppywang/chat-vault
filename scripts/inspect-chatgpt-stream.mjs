import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = path.resolve(process.argv[2] || '');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const shapes = new Map(), roles = new Map(), snapshots = [], lifecycle = [], requests = [], envelopes = new Map();
let seenRequest = false, assistantExamples = [], seq = 0;
function messageInfo(message) {
  return { id: message?.id, role: message?.author?.role, channel: message?.channel, recipient: message?.recipient,
    content_type: message?.content?.content_type, status: message?.status, end_turn: message?.end_turn,
    text_chars: message?.content?.parts?.reduce((n, p) => n + (typeof p === 'string' ? p.length : 0), 0),
    create_time: message?.create_time };
}
function inspectEvent(value, transport, at) {
  if (Array.isArray(value)) { for (const item of value) inspectEvent(item, transport, at); return; }
  if (!value || typeof value !== 'object') return;
  const message = value.message || value.v?.message;
  const shape = { keys: Object.keys(value).sort(), type: value.type || null, op: value.o || null,
    path: value.p ?? null, value_type: Array.isArray(value.v) ? 'array' : typeof value.v,
    value_keys: value.v && typeof value.v === 'object' && !Array.isArray(value.v) ? Object.keys(value.v).sort() : null,
    role: message?.author?.role || null, content_type: message?.content?.content_type || null,
    after_request: seenRequest, transport };
  const key = JSON.stringify(shape), existing = shapes.get(key);
  if (existing) existing.count++;
  else shapes.set(key, { ...shape, count: 1 });
  if (message) {
    const role = `${seenRequest ? 'after' : 'before'}:${message.author?.role}:${message.content?.content_type}`;
    roles.set(role, (roles.get(role) || 0) + 1);
    if (message.author?.role === 'assistant' && message.content?.content_type !== 'model_editable_context'
      && assistantExamples.length < 8) assistantExamples.push({ seq, at, ...messageInfo(message),
        message_keys: Object.keys(message), content_keys: Object.keys(message.content || {}) });
  }
}
function sse(text, transport, at) {
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(s => s.startsWith('data:')).map(s => s.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { inspectEvent(JSON.parse(data), transport, at); } catch { /* only complete frames here */ }
  }
}
for (const file of fs.readdirSync(root).filter(f => /^batch-\d+-\d+\.jsonl$/.test(f)).sort()) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(root, file)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const e = JSON.parse(line), p = e.params || {}; seq = e.seq;
    if (e.method === 'Network.requestWillBeSent' && p.request?.method === 'POST'
      && /\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(p.request.url || '')) {
      seenRequest = true;
      let body = {}; try { body = JSON.parse(p.request.postData); } catch { /* body may be fetched later */ }
      requests.push({ seq, at: e.at_ms, request_id: p.requestId, conversation_id: body.conversation_id,
        messages: body.messages?.map(messageInfo) });
    }
    if (e.method.startsWith('Capture.') && e.method !== 'Capture.snapshot') lifecycle.push({ seq, at: e.at_ms, method: e.method,
      conversation_id: p.conversation_id, reason: p.reason, error: p.error, turn_id: p.turn_id, keys: Object.keys(p) });
    if (e.method === 'Capture.snapshot') {
      const conv = p.conversation;
      const branch = []; let id = conv.current_node; const visited = new Set();
      while (id && conv.mapping?.[id] && !visited.has(id)) {
        visited.add(id); branch.push({ node_id: id, ...messageInfo(conv.mapping[id].message) }); id = conv.mapping[id].parent;
      }
      snapshots.push({ seq, at: e.at_ms, current_node: conv.current_node, mapping_nodes: Object.keys(conv.mapping || {}).length,
        last_branch_messages: branch.reverse().slice(-10) });
    }
    if (e.method === 'Network.webSocketFrameReceived' && p.response?.opcode === 1) {
      let parsed; try { parsed = JSON.parse(p.response.payloadData); } catch { continue; }
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        const envelope = item?.payload, entry = envelope?.payload;
        const key = `${item?.type}:${envelope?.type}`; envelopes.set(key, (envelopes.get(key) || 0) + 1);
        if (entry?.conversation_id !== manifest.conversation_id) continue;
        if (typeof entry.encoded_item === 'string') sse(entry.encoded_item, 'ws', e.at_ms);
      }
    }
    if (e.method === 'Network.streamResourceContent' && p.bufferedData) sse(Buffer.from(p.bufferedData, 'base64').toString('utf8'), 'sse_buffer', e.at_ms);
    if (e.method === 'Network.dataReceived' && typeof p.data === 'string') sse(Buffer.from(p.data, 'base64').toString('utf8'), 'sse_chunk', e.at_ms);
  }
}
console.log(JSON.stringify({ capture_id: manifest.capture_id, requests, lifecycle, snapshots,
  roles: Object.fromEntries(roles), envelopes: Object.fromEntries(envelopes), assistant_examples: assistantExamples,
  shapes: [...shapes.values()] }, null, 2));
