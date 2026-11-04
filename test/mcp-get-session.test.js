import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, upsertSession } from '../src/db.js';
import { toolExec } from '../src/mcp-tools.js';

function fixture(t) {
  const root = fileURLToPath(new URL('../.tmp/', import.meta.url));
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'mcp-get-session-'));
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
  upsertSession(db, 'codex', 'fixture.jsonl', 'test', {
    agentSessionId: 'test-thread', title: '人工审核 #32707', workspacePath: 'D:\\test',
    messages: [{ role: 'user', text: '继续处理', createdAt: '2026-10-28T15:07:26Z' }],
  });
  return { db, id: db.prepare('SELECT id FROM sessions').get().id };
}

test('a title number mistaken for a session ID returns a useful not-found error instead of null.session', async t => {
  const { db } = fixture(t);
  for (const args of [{ session_id: 32707 }, { session_id: 32707, around_seq: 5 }]) {
    await assert.rejects(toolExec(db, 'get_session', args), error => {
      assert.ok(!(error instanceof TypeError));
      assert.match(error.message, /会话不存在: 32707/);
      assert.match(error.message, /search_conversations/);
      assert.match(error.message, /session_id/);
      return true;
    });
  }
});

test('existing sessions remain readable by ID, including a page beyond their final message', async t => {
  const { db, id } = fixture(t);
  const first = await toolExec(db, 'get_session', { session_id: id, limit: 1 });
  assert.equal(first.id, id);
  assert.equal(first.title, '人工审核 #32707');
  assert.equal(first.messages[0].content, '继续处理');
  const pastEnd = await toolExec(db, 'get_session', { session_id: id, offset: 100 });
  assert.equal(pastEnd.id, id);
  assert.deepEqual(pastEnd.messages, []);
});

test('missing, nonpositive, fractional and unsafe session IDs fail validation before lookup', async t => {
  const { db } = fixture(t);
  for (const session_id of [undefined, null, '', 0, -1, 1.5, 'not-an-id', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(toolExec(db, 'get_session', { session_id }), /session_id 必须是正整数/);
  }
});
