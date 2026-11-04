import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = path.resolve(process.argv[2]);
const userId = process.argv[3];
const targetMessageId = process.argv[4];
let latest = null, at = null;
const updateShapes = new Map(), updates = [], targetUpdates = [];
for (const file of fs.readdirSync(root).filter(f => /^batch-\d+-\d+\.jsonl$/.test(f)).sort()) {
  const reader = readline.createInterface({ input: fs.createReadStream(path.join(root, file)), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line) continue;
    const e = JSON.parse(line), p = e.params || {};
    if (e.method === 'Capture.snapshot') { latest = p.conversation; at = e.at_ms; }
    if (e.method === 'Network.getResponseBody' && /\/conversation\/[0-9a-f-]{36}(?:\?|$)/i.test(p.url || '')) {
      try {
        const value = JSON.parse(p.base64Encoded ? Buffer.from(p.body, 'base64').toString('utf8') : p.body);
        if (value.mapping) { latest = value; at = e.at_ms; }
      } catch { /* non-JSON */ }
    }
    if (e.method === 'Network.webSocketFrameReceived' && p.response?.opcode === 1) {
      let data; try { data = JSON.parse(p.response.payloadData); } catch { continue; }
      for (const value of Array.isArray(data) ? data : [data]) {
        if (targetMessageId && JSON.stringify(value).includes(targetMessageId)) {
          targetUpdates.push({ seq: e.seq, at_ms: e.at_ms, value });
        }
        if (value?.type !== 'conversation-update') continue;
        const shape = { keys: Object.keys(value), payload_type: typeof value.payload,
          payload_keys: value.payload && typeof value.payload === 'object' ? Object.keys(value.payload) : null };
        const key = JSON.stringify(shape); updateShapes.set(key, { ...shape, count: (updateShapes.get(key)?.count || 0) + 1 });
        if (updates.length < 2) updates.push({ seq: e.seq, at_ms: e.at_ms, value });
      }
    }
  }
}
if (!latest) throw new Error('snapshot_missing');
const chain = [], seen = new Set(); let id = latest.current_node;
while (id && latest.mapping[id] && !seen.has(id)) {
  seen.add(id); const node = latest.mapping[id]; chain.push(node.message); id = node.parent;
}
chain.reverse();
const start = chain.findIndex(m => m?.id === userId);
if (start < 0) throw new Error('user_missing');
const next = chain.findIndex((m, i) => i > start && m?.author?.role === 'user');
const messages = chain.slice(start + 1, next < 0 ? undefined : next);
console.log(JSON.stringify({ at, current_node: latest.current_node, messages,
  update_shapes: [...updateShapes.values()], update_examples: updates, target_updates: targetUpdates }, null, 2));
