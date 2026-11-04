import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { codexAdapter, dedupeCompressedRollouts, rolloutSiblingPath } from '../src/adapters/codex.js';
import { HAS_ZSTD_STREAM, listFiles, readJsonl } from '../src/util.js';

// Codex compresses rollouts untouched for 7 days into rollout-….jsonl.zst
// (features.local_thread_store_compression). A compressed rollout must read
// exactly like the plain one, or older sessions drop out of ChatVault.

const ID = '01a13648-e640-7b41-9790-83cc1b591fc5';
const NAME = `rollout-2026-10-01T01-21-49-${ID}.jsonl`;

function syntheticRollout() {
  const lines = [
    { timestamp: '2026-10-01T01:21:49.000Z', type: 'session_meta', payload: { id: ID, cwd: 'D:\\work\\demo', timestamp: '2026-10-01T01:21:49.000Z' } },
    { timestamp: '2026-10-01T01:21:50.000Z', type: 'turn_context', payload: { cwd: 'D:\\work\\demo', model: 'gpt-6.1-sol', effort: 'high' } },
    { timestamp: '2026-10-01T01:21:51.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'compress me please' }] } },
    { timestamp: '2026-10-01T01:21:55.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' } },
    { timestamp: '2026-10-01T01:21:56.000Z', type: 'response_item', payload: { type: 'function_call_output', output: 'a.txt\nb.txt' } },
    { timestamp: '2026-10-01T01:22:00.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done: two files' }] } },
  ];
  // Enough repetition that the compressed file spans several stream chunks.
  const filler = { timestamp: '2026-10-01T01:22:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: 'x'.repeat(2000) } };
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + Array.from({ length: 200 }, () => JSON.stringify(filler)).join('\n') + '\n';
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-zst-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a compressed rollout parses exactly like the plain one', { skip: !HAS_ZSTD_STREAM }, async () => {
  const dir = tempDir();
  const plain = path.join(dir, NAME);
  const text = syntheticRollout();
  fs.writeFileSync(plain, text);
  const zst = path.join(dir, 'z', NAME + '.zst');
  fs.mkdirSync(path.dirname(zst));
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(text)));

  const a = await codexAdapter.parseFile(plain);
  const b = await codexAdapter.parseFile(zst);
  assert.ok(a && a.messages?.length >= 3, 'plain rollout produced messages');
  assert.deepEqual(b, a);
});

test('the session id is the same for both suffixes', { skip: !HAS_ZSTD_STREAM }, async () => {
  const dir = tempDir();
  // No session_meta: the id falls back to the file name.
  const text = JSON.stringify({ timestamp: '2026-10-01T01:21:51.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }) + '\n';
  const zst = path.join(dir, NAME + '.zst');
  fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(text)));
  const parsed = await codexAdapter.parseFile(zst);
  assert.equal(parsed.agentSessionId, ID);
});

test('a truncated compressed rollout fails instead of reading half', { skip: !HAS_ZSTD_STREAM }, async () => {
  const dir = tempDir();
  const full = zlib.zstdCompressSync(Buffer.from(syntheticRollout()));
  const zst = path.join(dir, NAME + '.zst');
  fs.writeFileSync(zst, full.subarray(0, Math.floor(full.length / 2)));
  await assert.rejects(() => readJsonl(zst, () => {}));
});

test('during compression the plain rollout wins, as in Codex', () => {
  const files = [
    { path: path.join('s', NAME), size: 10, mtimeMs: 1 },
    { path: path.join('s', NAME + '.zst'), size: 3, mtimeMs: 2 },
    { path: path.join('s', 'rollout-other.jsonl.zst'), size: 3, mtimeMs: 2 },
  ];
  assert.deepEqual(dedupeCompressedRollouts(files).map((f) => path.basename(f.path)), [NAME, 'rollout-other.jsonl.zst']);
});

test('listFiles accepts several suffixes', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'b.jsonl.zst'), '');
  fs.writeFileSync(path.join(dir, 'c.txt'), '');
  assert.deepEqual(listFiles(dir, ['.jsonl', '.jsonl.zst']).map((f) => path.basename(f.path)).sort(), ['a.jsonl', 'b.jsonl.zst']);
  assert.deepEqual(listFiles(dir).map((f) => path.basename(f.path)), ['a.jsonl']);
});

test('a rollout that changed representation is found again', () => {
  assert.equal(rolloutSiblingPath('/x/' + NAME), '/x/' + NAME + '.zst');
  assert.equal(rolloutSiblingPath('/x/' + NAME + '.zst'), '/x/' + NAME);
  assert.equal(rolloutSiblingPath('/x/session.json'), null);
  assert.equal(codexAdapter.siblingPath, rolloutSiblingPath);
});
