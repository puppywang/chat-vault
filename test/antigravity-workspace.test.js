import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { antigravityAdapter } from '../src/adapters/antigravity.js';
import { startWatcher } from '../src/watcher.js';
import { openDb, upsertSession } from '../src/db.js';
import { runSync } from '../src/sync.js';

const varint = n => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const bytes = (field, value) => { const b = typeof value === 'string' ? Buffer.from(value) : value; return Buffer.concat([varint(field * 8 + 2), varint(b.length), b]); };
const fixture = (t, metadata, cwd) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-ag-workspace-'));
  const file = path.join(dir, 'session.db');
  t.after(() => {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB);');
  db.prepare('INSERT INTO trajectory_meta VALUES (?)').run('workspace-test');
  db.prepare('INSERT INTO steps VALUES (0, 14, ?)').run(bytes(19, bytes(2, '聊天里提到 D:\\OtherProject 并不代表打开了它')));
  if (metadata !== undefined) {
    db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB)');
    if (metadata !== null) db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', metadata);
  }
  if (cwd) db.prepare('INSERT INTO steps VALUES (1, 15, ?)').run(bytes(20, bytes(7, Buffer.concat([
    bytes(2, 'run_command'), bytes(3, JSON.stringify({ Cwd: cwd })),
  ]))));
  db.close();
  return { dir, file };
};

test('独立元数据的 workspace URI 恢复无工具调用会话的工作区，并优先于工具 Cwd', async t => {
  const metadata = Buffer.concat([bytes(1, bytes(1, 'file:///d:/HomeProject/Opened%20Folder')), bytes(7, 'file:///d%3A/OtherDirectory')]);
  const { file } = fixture(t, metadata, 'C:\\Temp\\command-directory');
  const session = await antigravityAdapter.parseFile(file);
  assert.equal(session.workspacePath, 'D:\\HomeProject\\Opened Folder');
  assert.equal(session.messages.length, 2);
  const { file: chatOnly } = fixture(t, metadata);
  assert.equal((await antigravityAdapter.parseFile(chatOnly)).workspacePath, session.workspacePath);
});

test('缺少 workspace 列表时接受 f7 编码盘符 URI，损坏候选不阻断后续目录', async t => {
  const metadata = Buffer.concat([bytes(1, bytes(1, 'file:///%broken%')), bytes(7, 'file:///d%3A/HomeProject/cli-request-monitor')]);
  const { file } = fixture(t, metadata);
  assert.equal((await antigravityAdapter.parseFile(file)).workspacePath, 'D:\\HomeProject\\cli-request-monitor');
});

test('旧格式/空元数据/损坏元数据仍使用 Cwd；没有可靠目录时保留未知', async t => {
  for (const metadata of [undefined, null, Buffer.from([0xff])]) {
    const { file } = fixture(t, metadata, 'D:\\Legacy\\Project');
    assert.equal((await antigravityAdapter.parseFile(file)).workspacePath, 'D:\\Legacy\\Project');
  }
  const { file } = fixture(t);
  assert.equal((await antigravityAdapter.parseFile(file)).workspacePath, null);
});

test('旧指纹会触发历史回填；数据库只写 WAL 也能触发重新解析', async t => {
  const { file } = fixture(t, bytes(7, 'file:///d%3A/Before'));
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    const base = fs.statSync(file);
    const source = { path: file, size: base.size, mtimeMs: Math.round(base.mtimeMs) };
    const first = antigravityAdapter.fingerprint(source);
    assert.notEqual(first, `${source.size}:${source.mtimeMs}`);
    db.prepare('UPDATE trajectory_metadata_blob SET data=?').run(bytes(7, 'file:///d%3A/After'));
    assert.equal(fs.statSync(file).mtimeMs, base.mtimeMs, '此时主库尚未 checkpoint');
    assert.notEqual(antigravityAdapter.fingerprint(source), first);
    assert.equal((await antigravityAdapter.parseFile(file)).workspacePath, 'D:\\After');
  } finally { db.close(); }
});

test('文件监听识别 Antigravity .db 和 .db-wal 变化', { timeout: 8000 }, async t => {
  let watcher;
  t.after(() => watcher?.stop()); // Stop probes before fixture cleanup.
  const { dir, file } = fixture(t);
  let wake = null, count = 0;
  watcher = startWatcher({ roots: [dir], debounceMs: 15, cooldownMs: 15,
    onSync: async () => { count++; wake?.(); }, log: () => {} });
  for (const target of [file, file + '-wal']) {
    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { wake = null; reject(new Error(`未观察到 ${path.basename(target)} 变化`)); }, 2500);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
    fs.appendFileSync(target, Buffer.from([0]));
    await observed;
  }
  assert.ok(count >= 2);
});

test('全量同步回填工作区且保留消息；其他 agent 的会话和统计保持不变', async t => {
  const { dir, file } = fixture(t, bytes(1, bytes(1, 'file:///d:/HomeProject/Opened')));
  const db = openDb(path.join(dir, 'vault.sqlite'));
  const originalDiscover = antigravityAdapter.discover;
  try {
    const parsed = await antigravityAdapter.parseFile(file);
    upsertSession(db, 'antigravity', file, 'old-parser-fingerprint', { ...parsed, workspacePath: null });
    for (const agent of ['codex', 'copilot']) upsertSession(db, agent, `${agent}.jsonl`, 'unchanged', {
      agentSessionId: agent, title: agent, workspacePath: 'D:\\Unrelated',
      messages: [{ role: 'user', text: '保持这个内容', createdAt: '2026-10-01T00:00:00Z' }],
    });
    const unrelated = () => db.prepare("SELECT s.*,w.path FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE agent<>'antigravity' ORDER BY s.id").all();
    const before = unrelated();
    const beforeMessages = db.prepare('SELECT role,content_text FROM messages WHERE session_id=(SELECT id FROM sessions WHERE agent=?)').all('antigravity');
    antigravityAdapter.discover = () => [{ path: file, size: fs.statSync(file).size, mtimeMs: fs.statSync(file).mtimeMs }];
    const summary = await runSync(db, { agents: ['antigravity'], full: true });
    assert.equal(summary.failed, 0);
    assert.equal(summary.updated, 1);
    assert.equal(db.prepare('SELECT w.path FROM sessions s JOIN workspaces w ON w.id=s.workspace_id WHERE s.agent=?').get('antigravity').path, 'D:\\HomeProject\\Opened');
    assert.deepEqual(db.prepare('SELECT role,content_text FROM messages WHERE session_id=(SELECT id FROM sessions WHERE agent=?)').all('antigravity'), beforeMessages);
    assert.deepEqual(unrelated(), before);
  } finally { antigravityAdapter.discover = originalDiscover; db.close(); }
});
