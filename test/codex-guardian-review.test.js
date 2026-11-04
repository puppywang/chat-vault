import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { codexAdapter } from '../src/adapters/codex.js';
import { openDb, upsertSession } from '../src/db.js';
import { listSessions, searchMessages, stats, getSessionDetail } from '../src/query.js';
import { HAS_ZSTD_STREAM } from '../src/util.js';

function fixture(t) {
  const root = fileURLToPath(new URL('../.tmp/', import.meta.url));
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'codex-guardian-'));
  const db = openDb(path.join(dir, 'test.db'));
  t.after(() => {
    db.close();
    assert.equal(path.dirname(dir), path.resolve(root));
    assert.ok(!fs.lstatSync(dir).isSymbolicLink());
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name), entry = fs.lstatSync(file);
      assert.ok(entry.isFile() && !entry.isSymbolicLink());
      fs.unlinkSync(file);
    }
    fs.rmdirSync(dir);
  });
  return { dir, db };
}

function rollout(dir, metadata = {}, { compressed = false } = {}) {
  const id = randomUUID(), at = '2026-10-28T13:50:58.657Z';
  const rows = [
    { timestamp: at, type: 'session_meta', payload: { id, cwd: 'D:\\test\\guardian', ...metadata } },
    { timestamp: at, type: 'turn_context', payload: { model: 'codex-auto-review', effort: 'low' } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Guardian review search-fixture-marker' }] } },
    { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'review result' }] } },
  ];
  const text = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const file = path.join(dir, `rollout-2026-10-28T13-50-58-${id}.jsonl${compressed ? '.zst' : ''}`);
  fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text);
  return file;
}

test('Guardian source markers hide new and previously imported reviews while retaining their contents', async t => {
  const { dir, db } = fixture(t);
  const parent = randomUUID();
  for (const marker of [{ thread_source: 'guardian_review' }, { source: { subagent: { other: 'guardian' } } }]) {
    const file = rollout(dir, { parent_thread_id: parent, ...marker });
    const review = await codexAdapter.parseFile(file);
    assert.equal(review.hidden, true);
    assert.match(review.title, /^自动审核/);
    assert.doesNotMatch(review.title, /子agent/);
    // An old import already exists and must keep its stable ID and messages.
    const legacy = { ...review }; delete legacy.hidden;
    upsertSession(db, 'codex', file, 'v3', legacy);
    const oldId = listSessions(db)[0].id;
    upsertSession(db, 'codex', file, 'v4', review);
    assert.equal(listSessions(db).length, 0);
    assert.ok(listSessions(db, { hiddenOnly: true }).some(s => s.id === oldId));
    assert.equal(getSessionDetail(db, oldId).messages.length, 2);
  }
  assert.equal(stats(db).totals.sessions, 0);
  assert.equal(searchMessages(db, { q: 'search-fixture-marker' }).length, 0);
});

test('ordinary sessions and real subagents are not hidden by Guardian-looking titles or models; manual hides persist', async t => {
  const { dir, db } = fixture(t);
  for (const metadata of [{}, { parent_thread_id: randomUUID(), source: { subagent: { thread_spawn: { parent_thread_id: randomUUID() } } } }]) {
    const file = rollout(dir, metadata), parsed = await codexAdapter.parseFile(file);
    assert.equal(parsed.hidden, undefined);
    upsertSession(db, 'codex', file, 'v4', parsed);
    const session = listSessions(db).find(s => s.title === parsed.title);
    assert.ok(session);
    db.prepare('UPDATE sessions SET hidden=1 WHERE id=?').run(session.id);
    upsertSession(db, 'codex', file, 'v4-next', { ...parsed, hidden: false });
    assert.equal(db.prepare('SELECT hidden FROM sessions WHERE id=?').get(session.id).hidden, 1);
  }
});

test('compressed Guardian rollouts use the same metadata filter', { skip: !HAS_ZSTD_STREAM }, async t => {
  const { dir } = fixture(t);
  const parsed = await codexAdapter.parseFile(rollout(dir, { thread_source: 'guardian_review' }, { compressed: true }));
  assert.equal(parsed.hidden, true);
  assert.equal(parsed.messages.length, 2);
});
