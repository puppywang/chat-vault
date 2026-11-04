import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { antigravityAdapter } from '../src/adapters/antigravity.js';
import { openDb, upsertSession } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { startWatcher } from '../src/watcher.js';

const varint = n => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const bytes = (field, value) => { const b = typeof value === 'string' ? Buffer.from(value) : value; return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]); };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-ag-title-'));
  fs.mkdirSync(path.join(root, 'conversations'));
  fs.mkdirSync(path.join(root, 'annotations'));
  const file = path.join(root, 'conversations', 'title-session.db');
  const annotation = path.join(root, 'annotations', 'title-session.pbtxt');
  const summaryFile = path.join(root, 'conversation_summaries.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE steps (idx INTEGER,step_type INTEGER,step_payload BLOB)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run('title-session');
  db.prepare('INSERT INTO steps VALUES (0,14,?)').run(bytes(19, bytes(2, '首条用户提问')));
  db.close();
  const summary = new DatabaseSync(summaryFile);
  summary.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY,title TEXT)');
  summary.prepare('INSERT INTO conversation_summaries VALUES (?,?)').run('title-session', '摘要标题');
  summary.close();
  t.after(() => {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = () => { const s = fs.statSync(file); return { path: file, size: s.size, mtimeMs: s.mtimeMs }; };
  return { root, file, annotation, summaryFile, source };
}

test('正式标题优先：重命名记录 > 摘要库 > 首条提问；清空标题不会恢复旧名称', async t => {
  const { file, annotation } = fixture(t);
  assert.equal((await antigravityAdapter.parseFile(file)).title, '摘要标题');
  fs.writeFileSync(annotation, 'title:"Ubuntu Desktop Repairing Guide" last_user_view_time:{seconds:1}');
  assert.equal((await antigravityAdapter.parseFile(file)).title, 'Ubuntu Desktop Repairing Guide');
  fs.writeFileSync(annotation, 'title:""');
  assert.equal((await antigravityAdapter.parseFile(file)).title, '首条用户提问');
});

test('protobuf text 的中文八进制字节、引号、反斜杠可正确解码', async t => {
  const { file, annotation } = fixture(t);
  const title = '修复 Ubuntu "桌面" D:\\项目';
  const encoded = [...Buffer.from(title)].map(b => '\\' + b.toString(8).padStart(3, '0')).join('');
  fs.writeFileSync(annotation, `title:"${encoded}"`);
  assert.equal((await antigravityAdapter.parseFile(file)).title, title);
  fs.writeFileSync(annotation, 'title:"A \\"quoted\\" C:\\\\Temp"');
  assert.equal((await antigravityAdapter.parseFile(file)).title, 'A "quoted" C:\\Temp');
  fs.writeFileSync(annotation, 'title:"bad\\qescape"');
  assert.equal((await antigravityAdapter.parseFile(file)).title, '摘要标题');
});

test('只改 annotation 标题也增量同步，消息正文和其他 agent 保持不变', async t => {
  const { root, file, annotation, source } = fixture(t);
  const db = openDb(path.join(root, 'vault.sqlite'));
  const discover = antigravityAdapter.discover;
  try {
    antigravityAdapter.discover = () => [source()];
    upsertSession(db, 'codex', 'unrelated.jsonl', 'unchanged', {
      agentSessionId: 'unrelated', title: '不改此标题', messages: [{ role: 'user', text: '不改此正文' }],
    });
    await runSync(db, { agents: ['antigravity'], full: true });
    const original = source();
    const messages = db.prepare('SELECT session_id,seq,role,content_text FROM messages ORDER BY session_id,seq').all();
    const oldFp = antigravityAdapter.fingerprint(source());
    fs.writeFileSync(annotation, 'title:"新的正式标题"');
    assert.deepEqual(source(), original, '对话源文件没有变化');
    assert.notEqual(antigravityAdapter.fingerprint(source()), oldFp);
    const result = await runSync(db, { agents: ['antigravity'] });
    assert.equal(result.updated, 1);
    assert.equal(result.failed, 0);
    assert.equal(db.prepare('SELECT title FROM sessions WHERE agent=?').get('antigravity').title, '新的正式标题');
    assert.equal(db.prepare('SELECT title FROM sessions WHERE agent=?').get('codex').title, '不改此标题');
    assert.deepEqual(db.prepare('SELECT session_id,seq,role,content_text FROM messages ORDER BY session_id,seq').all(), messages);
    // Viewing a conversation updates the annotation too, but must not reparse messages.
    fs.writeFileSync(annotation, 'title:"新的正式标题" last_user_view_time:{seconds:99}');
    assert.equal((await runSync(db, { agents: ['antigravity'] })).skipped, 1);
  } finally { antigravityAdapter.discover = discover; db.close(); }
});

test('摘要库只写 WAL 的标题更新使指纹失效，缺失或坏摘要库仍可读完整对话', async t => {
  const { file, summaryFile, source } = fixture(t);
  const writer = new DatabaseSync(summaryFile);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    const old = antigravityAdapter.fingerprint(source());
    const before = fs.statSync(summaryFile);
    writer.prepare('UPDATE conversation_summaries SET title=?').run('WAL 重命名');
    assert.equal(fs.statSync(summaryFile).mtimeMs, before.mtimeMs);
    assert.notEqual(antigravityAdapter.fingerprint(source()), old);
    assert.equal((await antigravityAdapter.parseFile(file)).title, 'WAL 重命名');
  } finally { writer.close(); }
  const other = fixture(t);
  fs.writeFileSync(other.summaryFile, 'not a database');
  assert.equal((await antigravityAdapter.parseFile(other.file)).title, '首条用户提问');
  fs.unlinkSync(other.summaryFile);
  assert.equal((await antigravityAdapter.parseFile(other.file)).title, '首条用户提问');
});

test('监听父目录中的标题 annotation，无需发送新消息', { timeout: 6000 }, async t => {
  let watcher;
  t.after(() => watcher?.stop());
  const { root, annotation } = fixture(t);
  let wake;
  const observed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('标题变化未触发监听')), 2500);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  watcher = startWatcher({ roots: [root], debounceMs: 15, cooldownMs: 15, onSync: async () => wake(), log: () => {} });
  fs.writeFileSync(annotation, 'title:"重命名"');
  await observed;
});
