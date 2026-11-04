// 备份核心（快照/去 FTS/自检/清单/暂存裁剪）——全程离线，不碰真实 ~/.chat-vault：
// 在 import 之前改写 USERPROFILE/HOME，使 config、state、日志都落到临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-backup-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.AE_LOG_LEVEL = 'error'; // 别把 info 写进日志文件

const { openDb } = await import('../src/db.js');
const { ftsPrepare } = await import('../src/fts.js');
const { createDataSnapshot } = await import('../src/backup-snapshot.js');
const { createSnapshot, stripDerived, inspectSnapshot, runBackup, backupConfig, defaultStagingDir, pruneLocalSnapshots, sha256File, writeState, readState, STATE_FILE, confirmRemoteSnapshot, pushStream, verifyPreparedSnapshot, restoreBackup } = await import('../src/backup.js');

test.after(() => {
  if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界');
  fs.rmSync(home, { recursive: true, force: true });
});

/** 造一个小库：1 会话 / 2 消息，FTS 索引与生产一致（external content + 拆字文本） */
function makeDb(name) {
  const file = path.join(home, name);
  const db = openDb(file);
  try {
    db.prepare(`INSERT INTO sessions(agent, agent_session_id, title, created_at, updated_at, message_count)
                VALUES ('codex','sess-1','备份测试','2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',2)`).run();
    const sid = db.prepare('SELECT id FROM sessions').get().id;
    const ins = db.prepare(`INSERT INTO messages(session_id, seq, role, created_at, content_text, content_raw, fts_text, model, effort, images)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const insFts = db.prepare('INSERT INTO messages_fts(rowid, fts_text) VALUES (?, ?)');
    const rows = [['user', '帮我看看入水检测'], ['assistant', 'chat 关键词在这里']];
    rows.forEach(([role, text], i) => {
      const r = ins.run(sid, i, role, '2026-01-02T00:00:00Z', text, null, ftsPrepare(text), 'gpt-5', null, null);
      insFts.run(r.lastInsertRowid, ftsPrepare(text));
    });
  } finally {
    db.close();
  }
  return file;
}

test('快照是自洽副本：一致、无 -wal 尾巴、行数与源库一致', async () => {
  const dbPath = makeDb('db-snapshot.db');
  const out = path.join(home, 'staging', 'snap', 'chat-vault.db');
  createSnapshot(dbPath, out);

  assert.ok(fs.existsSync(out));
  assert.equal(fs.existsSync(out + '-wal'), false);
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(Object.values(db.prepare('PRAGMA journal_mode').get())[0], 'delete');
  assert.equal(Object.values(db.prepare('SELECT count(*) FROM messages').get())[0], 2);
  db.close();
});

test('去掉 FTS 后体积更小，且 rebuild 能把检索能力恢复回来', async () => {
  const dbPath = makeDb('db-strip.db');
  const out = path.join(home, 'staging', 'snap2', 'chat-vault.db');
  createSnapshot(dbPath, out);
  const full = fs.statSync(out).size;

  assert.equal(stripDerived(out), true);
  const stripped = fs.statSync(out).size;
  assert.ok(stripped < full, `expected ${stripped} < ${full}`);

  const db = new DatabaseSync(out);
  assert.equal(Object.values(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name LIKE 'messages_fts%'").get())[0], 0);
  // 恢复路径：重建索引后必须能按中文子串与英文词命中
  db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(fts_text, content='messages', content_rowid='id', tokenize='unicode61')");
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  const hits = (q) => Object.values(db.prepare('SELECT count(*) c FROM messages_fts WHERE messages_fts MATCH ?').get(q))[0];
  assert.equal(hits('"入 水 检 测"'), 1);
  assert.equal(hits('"chat"'), 1);
  db.close();
});

test('自检报告完整性与行数，供本地/远端对照', async () => {
  const dbPath = makeDb('db-inspect.db');
  const out = path.join(home, 'staging', 'snap3', 'chat-vault.db');
  createSnapshot(dbPath, out);
  const info = inspectSnapshot(out);
  assert.equal(info.integrity, 'ok');
  assert.deepEqual(
    { sessions: info.counts.sessions, messages: info.counts.messages },
    { sessions: 1, messages: 2 },
  );
  assert.equal(info.lastUpdatedAt, '2026-01-02T00:00:00Z');
  assert.ok(info.pages.count > 0);
});

test('直接无 FTS 快照固定 WAL 读取点，复制所有业务表、索引及 AUTOINCREMENT 高水位', () => {
  const source = makeDb('data-only-source.db');
  const live = new DatabaseSync(source);
  live.exec(`CREATE TABLE extras(a INTEGER,b INTEGER,PRIMARY KEY(a,b));
    INSERT INTO extras(rowid,a,b) VALUES(42,1,2);
    CREATE TABLE compact(k TEXT PRIMARY KEY,v TEXT) WITHOUT ROWID;
    INSERT INTO compact VALUES('key','正文');
    INSERT INTO ai_chats(id,created_at,question) VALUES(100,'now','removed'); DELETE FROM ai_chats;
    PRAGMA user_version=7; PRAGMA application_id=1234;`);
  live.prepare("INSERT INTO notes(thread_id,path,content,created_at,updated_at) VALUES('t','file','完整内容','now','now')").run();
  const destination = path.join(home, 'data-only.db');
  let advanced = false;
  const result = createDataSnapshot(source, destination, { onTable() {
    if (advanced) return;
    advanced = true;
    live.exec("INSERT INTO sessions(agent,agent_session_id) VALUES('codex','new-after-read-point')");
  } });
  assert.equal(result.baseline.sessions, 1);
  assert.equal(live.prepare('SELECT count(*) n FROM sessions').get().n, 2);
  const restored = new DatabaseSync(destination);
  try {
    assert.equal(restored.prepare('SELECT count(*) n FROM sessions').get().n, 1);
    assert.equal(restored.prepare('SELECT rowid FROM extras').get().rowid, 42);
    assert.equal(restored.prepare('SELECT v FROM compact').get().v, '正文');
    assert.equal(restored.prepare('SELECT content FROM notes').get().content, '完整内容');
    assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(restored.prepare('PRAGMA application_id').get().application_id, 1234);
    assert.equal(restored.prepare("SELECT seq FROM sqlite_sequence WHERE name='ai_chats'").get().seq, 100);
    assert.equal(restored.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'messages_fts%'").get().n, 0);
    assert.ok(restored.prepare("SELECT sql FROM sqlite_schema WHERE name='idx_messages_user_text'").get().sql.includes('<= 64'));
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
    restored.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(fts_text,content='messages',content_rowid='id',tokenize='unicode61'); INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    assert.equal(restored.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH '\"入 水 检 测\"'").get().n, 1);
  } finally { restored.close(); live.close(); }
  assert.equal(fs.existsSync(destination + '-wal'), false);
});

test('直接快照遇到未知虚表拒绝丢数据，失败产物清理；不覆盖现有快照', () => {
  const source = makeDb('unknown-virtual-source.db');
  const live = new DatabaseSync(source);
  live.exec('CREATE VIRTUAL TABLE another_search USING fts5(content)');
  live.close();
  const destination = path.join(home, 'unknown-virtual.db');
  assert.throws(() => createDataSnapshot(source, destination), /未支持的虚表/);
  assert.equal(fs.existsSync(destination), false);
  fs.writeFileSync(destination, 'preserve me');
  assert.throws(() => createDataSnapshot(source, destination), /已存在/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'preserve me');
});

test('dry-run 只做本地快照，不联网、不写状态', async () => {
  const dbPath = makeDb('db-dryrun.db');
  const stagingDir = path.join(home, 'staging-dry');
  const cfg = { backup: { enabled: false, host: '', stagingDir, excludeFts: true } };
  const r = await runBackup({ dbPath, version: 'test', opts: { dryRun: true }, cfg });

  assert.equal(r.dryRun, true);
  assert.ok(fs.existsSync(r.snapshot));
  assert.equal(r.manifest.integrity_check, 'ok');
  assert.equal(r.manifest.snapshot.fts_included, false);
  assert.equal(r.manifest.counts.messages, 2);
  assert.equal(fs.existsSync(STATE_FILE), false);
  const dirs = fs.readdirSync(stagingDir);
  assert.equal(dirs.length, 1);
  assert.ok(fs.existsSync(path.join(stagingDir, dirs[0], 'manifest.json')));
});

test('快照生成后源库继续入库，仍接受快照时刻的一致副本', async () => {
  const dbPath = makeDb('db-live-growth.db');
  const cfg = { backup: { enabled: false, stagingDir: path.join(home, 'staging-growth'), excludeFts: true } };
  // runBackup reaches asynchronous hashing after making and inspecting the snapshot.
  // A concurrent watcher may commit new rows before the backup finishes.
  const pending = runBackup({ dbPath, version: 'test', opts: { dryRun: true }, cfg });
  const live = new DatabaseSync(dbPath);
  try {
    const sid = live.prepare('SELECT id FROM sessions').get().id;
    live.prepare("INSERT INTO messages(session_id, seq, role, content_text, fts_text) VALUES (?, 2, 'user', '新增消息', '新 增 消 息')").run(sid);
  } finally {
    live.close();
  }
  const result = await pending;
  assert.equal(result.manifest.counts.messages, 2);
  assert.equal(inspectSnapshot(result.snapshot).counts.messages, 2);
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(source.prepare('SELECT count(*) AS n FROM messages').get().n, 3);
  } finally {
    source.close();
  }
});

test('未配置 host 时拒绝推送（不会去联网）', async () => {
  const dbPath = makeDb('db-nohost.db');
  await assert.rejects(
    () => runBackup({ dbPath, version: 'test', opts: {}, cfg: { backup: { enabled: false, host: '', stagingDir: path.join(home, 'staging-x') } } }),
    /备份未启用/,
  );
});

test('备份锁保护超过 30 分钟仍在运行的进程，创建后未写完的锁也不会被覆盖', async () => {
  const saved = readState();
  const lock = path.join(path.dirname(STATE_FILE), 'backup.lock');
  const cfg = { backup: { enabled: true, host: 'never-contacted' } };
  const attempt = () => runBackup({ cfg, dbPath: path.join(home, 'should-not-open.db') });
  try {
    writeState({ progress: { pid: process.pid, startedAt: new Date(Date.now() - 3600000).toISOString() } });
    fs.writeFileSync(lock, String(Date.now() - 3600000));
    assert.equal((await attempt()).reason, 'locked');
    writeState({ progress: null }); fs.writeFileSync(lock, '');
    assert.equal((await attempt()).reason, 'locked');
    assert.equal(fs.readFileSync(lock, 'utf8'), '');
    assert.equal(fs.existsSync(path.join(home, 'should-not-open.db')), false);
  } finally {
    fs.unlinkSync(lock);
    if (saved) fs.writeFileSync(STATE_FILE, JSON.stringify(saved));
    else if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  }
});

test('恢复拒绝活动数据目录、非空目录、无效快照 ID，现有文件保持原样', async () => {
  const cfg = { backup: { enabled: true, host: 'unused', transport: 'restic' } };
  const current = path.join(home, '.chat-vault');
  await assert.rejects(() => restoreBackup({ cfg, target: path.join(current, 'restore') }), /现用数据目录以外/);
  const occupied = path.join(home, 'occupied-restore'); fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'keep.txt'), 'keep');
  await assert.rejects(() => restoreBackup({ cfg, target: occupied }), /必须为空/);
  await assert.rejects(() => restoreBackup({ cfg, target: path.join(home, 'not-created'), snapshotId: 'bad-id' }), /有效快照/);
  assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(home, 'not-created')), false);
  fs.mkdirSync(current, { recursive: true });
  const alias = path.join(home, 'linked-active-data');
  fs.symlinkSync(current, alias, 'junction');
  try {
    await assert.rejects(() => restoreBackup({ cfg, target: path.join(alias, 'not-created') }), /现用数据目录以外/);
    assert.equal(fs.existsSync(path.join(current, 'not-created')), false);
  } finally { fs.unlinkSync(alias); }
});

test('快照阶段失败也记录错误，并保留上次成功备份信息', async () => {
  const dbPath = path.join(home, 'corrupt-source.db');
  fs.writeFileSync(dbPath, 'not a SQLite database');
  const lastSuccess = '2026-01-01T00:00:00Z';
  writeState({ last_success_at: lastSuccess, last_success_sha256: 'a'.repeat(64) });
  const cfg = { backup: { enabled: true, host: 'must-not-connect.invalid', stagingDir: path.join(home, 'staging-failure') } };
  await assert.rejects(runBackup({ dbPath, version: 'test', cfg }), /database/);
  const state = readState();
  assert.equal(state.last_success_at, lastSuccess);
  assert.equal(state.last_success_sha256, 'a'.repeat(64));
  assert.match(state.last_error, /database/);
  assert.equal(state.progress, null, '失败应结束进度状态');
  assert.ok(Date.parse(state.last_attempt_at) > Date.parse(lastSuccess));
  assert.equal(fs.existsSync(path.join(path.dirname(STATE_FILE), 'backup.lock')), false);
});

test('暂存裁剪只留最新 N 份', () => {
  const stagingDir = path.join(home, 'staging-keep');
  for (const name of ['20260101-010101', '20260102-010101', '20260103-010101', 'not-a-snapshot']) {
    fs.mkdirSync(path.join(stagingDir, name), { recursive: true });
  }
  const removed = pruneLocalSnapshots(stagingDir, 2);
  assert.deepEqual(removed, ['20260101-010101']);
  assert.deepEqual(fs.readdirSync(stagingDir).sort(), ['20260102-010101', '20260103-010101', 'not-a-snapshot']);
});

test('无变化也必须确认远端：拒绝连接失败、无效清单、错误 SHA，成功时才接受', async () => {
  const hash = 'a'.repeat(64);
  for (const result of [
    { code: 255, stdout: '' },
    { code: 0, stdout: 'not JSON' },
    { code: 0, stdout: JSON.stringify({ ok: true }) },
    { code: 0, stdout: JSON.stringify({ ok: true, manifest: { snapshot: { sha256: 'b'.repeat(64) } } }) },
  ]) {
    await assert.rejects(confirmRemoteSnapshot({}, hash, { runSsh: async () => result }), /远端确认失败/);
  }
  const remote = { ok: true, manifest: { snapshot: { sha256: hash } } };
  assert.deepEqual(await confirmRemoteSnapshot({}, hash, { runSsh: async (_cfg, cmd, opts) => {
    assert.equal(cmd, 'chatvault-recvd status');
    assert.equal(opts.timeoutMs, 60000);
    return { code: 0, stdout: JSON.stringify(remote) };
  } }), remote);
});

test('配置默认值与校验', () => {
  const merged = backupConfig({ backup: { host: 'myhost' } });
  assert.equal(merged.host, 'myhost');
  assert.equal(merged.dir, '/srv/backup/chatvault');
  assert.equal(merged.keepLocal, 3);
  assert.equal(merged.excludeFts, true);
  assert.equal(defaultStagingDir({ stagingDir: 'D:\\x' }), 'D:\\x');
  assert.ok(defaultStagingDir({}).startsWith(home));
});

test('sha256 与文件内容一致（传输前后比对用）', async () => {
  const file = path.join(home, 'blob.bin');
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 7, 7));
  const hex = await sha256File(file);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(hex, (await sha256File(file)));
});

// Real child processes exercise stdin backpressure, gzip, close/error ordering
// and timeout cleanup. No SSH connection or production database is used.
function uploadChild(script, capture) {
  return (_cmd, args, options) => {
    assert.ok(args.includes('BatchMode=yes'));
    assert.equal(options.windowsHide, true);
    const child = spawn(process.execPath, ['-e', script], options);
    capture.child = child;
    return child;
  };
}

test('SSH gzip 上传等待真实接收进程完成，返回实际压缩字节数', async () => {
  const file = path.join(home, 'upload.bin');
  fs.writeFileSync(file, randomBytes(128 * 1024));
  const capture = {};
  const result = await pushStream({ host: 'offline-test' }, file, 'incoming/current.db', 5000, {
    progressMs: 0,
    spawnProcess: uploadChild(`
      const zlib = require('node:zlib');
      const gunzip = zlib.createGunzip();
      let bytes = 0;
      gunzip.on('data', chunk => { bytes += chunk.length; });
      gunzip.on('end', () => process.exit(bytes === 131072 ? 0 : 2));
      process.stdin.pipe(gunzip);
    `, capture),
  });
  assert.equal(result.bytes, 131072);
  assert.ok(result.compressedBytes > 0);
  assert.equal(capture.child.exitCode, 0);
});

test('SSH 提前拒绝时保留远端错误，不只显示 EPIPE', async () => {
  const file = path.join(home, 'upload-rejected.bin');
  fs.writeFileSync(file, randomBytes(2 * 1024 * 1024));
  const capture = {};
  await assert.rejects(pushStream({ host: 'offline-test' }, file, 'incoming/current.db', 5000, {
    progressMs: 0,
    spawnProcess: uploadChild(`process.stderr.write('remote disk full\\n'); process.exit(23);`, capture),
  }), error => {
    assert.match(error.message, /remote disk full/);
    assert.match(error.message, /incoming\/current.db/);
    assert.match(error.message, /23/);
    return true;
  });
  assert.equal(capture.child.exitCode, 23);
});

test('SSH close 先于 pipeline 完成时，不会丢失退出事件而永久等待', async () => {
  const file = path.join(home, 'upload-early-close.bin');
  fs.writeFileSync(file, 'small manifest');
  const capture = {};
  const result = await pushStream({ host: 'offline-test' }, file, 'incoming/manifest.json', 2000, {
    progressMs: 0,
    spawnProcess: (cmd, args, options) => {
      const child = uploadChild(`process.stdin.resume();`, capture)(cmd, args, options);
      const input = child.stdin;
      // Delay the pipeline's finish until after the real child's close. This
      // deterministically exercises the ordering that the old implementation lost.
      child.stdin = new Writable({
        write(chunk, encoding, callback) { input.write(chunk, encoding, callback); },
        final(callback) {
          child.once('close', () => setImmediate(callback));
          input.end();
        },
        destroy(error, callback) { input.destroy(error); callback(error); },
      });
      return child;
    },
  });
  assert.equal(result.bytes, Buffer.byteLength('small manifest'));
  assert.equal(capture.child.exitCode, 0);
});

test('SSH 传输卡住超时明确报 ETIMEDOUT，并确认子进程已退出', async () => {
  const file = path.join(home, 'upload-timeout.bin');
  fs.writeFileSync(file, randomBytes(2 * 1024 * 1024));
  const capture = {};
  await assert.rejects(pushStream({ host: 'offline-test' }, file, 'incoming/current.db', 400, {
    progressMs: 0,
    spawnProcess: uploadChild(`process.stdin.pause(); setInterval(() => {}, 1000);`, capture),
  }), error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.match(error.message, /上传超时/);
    assert.match(error.message, /gzip/);
    return true;
  });
  assert.ok(capture.child.exitCode !== null || capture.child.signalCode !== null);
  assert.throws(() => process.kill(capture.child.pid, 0), /ESRCH/);
});

test('stdin 已写完但 SSH 未退出，也受上传期限约束', async () => {
  const file = path.join(home, 'upload-close-timeout.bin');
  fs.writeFileSync(file, 'small manifest');
  const capture = {};
  await assert.rejects(pushStream({ host: 'offline-test' }, file, 'incoming/manifest.json', 400, {
    progressMs: 0,
    spawnProcess: uploadChild(`process.stdin.resume(); setInterval(() => {}, 1000);`, capture),
  }), error => error.code === 'ETIMEDOUT');
  assert.throws(() => process.kill(capture.child.pid, 0), /ESRCH/);
});

test('SSH 可执行文件启动失败被捕获，不产生未处理的 error 事件', async () => {
  const file = path.join(home, 'upload-spawn-failure.bin');
  fs.writeFileSync(file, 'manifest');
  await assert.rejects(pushStream({ host: 'offline-test' }, file, 'incoming/manifest.json', 2000, {
    progressMs: 0,
    spawnProcess: (_cmd, _args, options) => spawn(path.join(home, 'missing-ssh.exe'), [], options),
  }), error => error.code === 'ENOENT' && /missing-ssh/.test(error.message));
});

test('本地上传文件不存在时，不创建 SSH 进程', async () => {
  await assert.rejects(pushStream({}, path.join(home, 'missing.db'), 'incoming/current.db', 1000, {
    spawnProcess: () => { throw new Error('should not spawn'); },
  }), error => error.code === 'ENOENT');
});

test('重传复用已完成快照，重新校验原清单而不生成新快照', async () => {
  const dbPath = makeDb('db-retry.db');
  const cfg = { backup: { enabled: false, stagingDir: path.join(home, 'staging-retry'), excludeFts: true } };
  const first = await runBackup({ dbPath, opts: { dryRun: true }, cfg });
  const dir = path.dirname(first.snapshot);
  const originalManifest = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
  const retry = await runBackup({ dbPath: path.join(home, 'not-needed.db'), opts: { dryRun: true, retrySnapshot: dir }, cfg });
  assert.equal(retry.snapshot, first.snapshot);
  assert.equal(fs.readdirSync(cfg.backup.stagingDir).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), originalManifest);
  assert.equal(retry.manifest.snapshot.sha256, first.manifest.snapshot.sha256);
});

test('重传拒绝 staging 外目录、被篡改清单及被篡改的快照', async () => {
  const dbPath = makeDb('db-retry-invalid.db');
  const backup = { enabled: false, stagingDir: path.join(home, 'staging-retry-invalid'), excludeFts: true };
  const first = await runBackup({ dbPath, opts: { dryRun: true }, cfg: { backup } });
  const dir = path.dirname(first.snapshot);
  await assert.rejects(verifyPreparedSnapshot(backup, home), /staging/);
  const file = path.join(dir, 'manifest.json');
  const original = fs.readFileSync(file, 'utf8');
  const changed = JSON.parse(original);
  changed.counts.messages++;
  fs.writeFileSync(file, JSON.stringify(changed));
  await assert.rejects(verifyPreparedSnapshot(backup, dir), /不一致/);
  fs.writeFileSync(file, original);
  const db = new DatabaseSync(first.snapshot);
  db.exec("UPDATE sessions SET title='changed after snapshot'");
  db.close();
  await assert.rejects(verifyPreparedSnapshot(backup, dir), /不一致/);
});

test('Windows 上传超时同时结束模拟 ProxyJump 子进程', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(home, 'upload-tree-timeout.bin');
  const pidFile = path.join(home, 'upload-grandchild.pid');
  fs.writeFileSync(file, randomBytes(512 * 1024));
  const capture = {};
  await assert.rejects(pushStream({ host: 'offline-test' }, file, 'incoming/current.db', 1000, {
    progressMs: 0,
    spawnProcess: uploadChild(`
      const {spawn}=require('node:child_process');
      const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
      fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));
      process.stdin.pause(); setInterval(()=>{},1000);
    `, capture),
  }), error => error.code === 'ETIMEDOUT');
  const grandchildPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(capture.child.pid, 0), /ESRCH/);
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
});
