import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-restic-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const { resticArgs, prepareResticInput, runRestic } = await import('../src/backup-restic.js');
const { writeConfig, readConfig } = await import('../src/config.js');
const backup = { host: 'backup-alias', timeoutSec: 30, resticBinary: process.execPath };
const fake = (script) => (_cmd, _args, options) => spawn(process.execPath, ['-e', script], options);

test.after(() => {
  assert.equal(path.dirname(home), os.tmpdir());
  fs.rmSync(home, { recursive: true, force: true });
});

test('restic 复用受限 SSH 通道，密码来自文件，不落到参数或日志', () => {
  const args = resticArgs(backup, ['backup', 'backup-current/chat-vault.db']);
  assert.ok(args.includes('--password-file'));
  assert.ok(args.includes('rclone:chatvault'));
  assert.ok(args.some(a => a.includes('backup-alias chatvault-recvd restic-stdio')));
  assert.ok(args.includes('rclone.program=ssh'));
  assert.throws(() => resticArgs({ ...backup, host: 'x; echo bad' }, ['check']), /host 格式/);
  assert.ok(!resticArgs({ ...backup, resticRepository: path.join(home, 'repository') }, ['init']).some(a => a.startsWith('rclone.args=')));
});

test('备份源仅包含一致性 DB、清单、索引和资产，排除配置、WAL 及意外暂存文件', () => {
  const root = path.join(home, 'source');
  fs.mkdirSync(root);
  const snapshot = path.join(root, 'snapshot.db'), manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(snapshot, 'consistent database'); fs.writeFileSync(manifest, '{}');
  fs.writeFileSync(path.join(root, 'pi-sessions.json'), '{"complete":true}');
  fs.writeFileSync(path.join(root, 'config.json'), '{"apiKey":"do-not-back-up"}');
  fs.writeFileSync(path.join(root, 'chat-vault.db-wal'), 'active WAL');
  fs.mkdirSync(path.join(root, 'imports')); fs.mkdirSync(path.join(root, 'images'));
  const prepared = prepareResticInput(snapshot, manifest, root);
  assert.deepEqual(prepared.sources, ['backup-current/chat-vault.db', 'backup-current/manifest.json', 'backup-current/pi-sessions.json', 'imports', 'images']);
  assert.equal(fs.readFileSync(path.join(prepared.input, 'chat-vault.db'), 'utf8'), 'consistent database');
  fs.writeFileSync(path.join(prepared.input, 'accidental-secret.txt'), 'exclude');
  fs.unlinkSync(path.join(root, 'pi-sessions.json'));
  assert.ok(!prepareResticInput(snapshot, manifest, root).sources.some(p => /secret|config|wal|sessions/.test(p)));
  assert.equal(fs.existsSync(path.join(prepared.input, 'pi-sessions.json')), false);
});

test('restic 只保留摘要并解析跨块中文 JSON；完整快照需退出码 0', async () => {
  const result = await runRestic(backup, ['backup'], { spawnProcess: fake(`process.stdout.write(JSON.stringify({message_type:'summary',snapshot_id:'abc',name:'中文'}));`) });
  assert.equal(result.records[0].name, '中文');
  await assert.rejects(() => runRestic(backup, ['backup'], { spawnProcess: fake(`console.error('file changed / incomplete backup');process.exit(3);`) }), /失败 \(3\).*incomplete backup/);
  await assert.rejects(() => runRestic(backup, ['check'], { spawnProcess: fake(`console.error('repository corrupt');process.exit(1);`) }), /repository corrupt/);
});

test('restic 启动失败和超时得到明确错误，子进程结束后才返回', async () => {
  await assert.rejects(() => runRestic({ ...backup, resticBinary: path.join(home, 'missing-restic.exe') }, ['check']), /ENOENT/);
  let pid;
  const spawnProcess = (...args) => { const child = fake('setInterval(()=>{},1000);')(...args); pid = child.pid; return child; };
  await assert.rejects(() => runRestic(backup, ['backup'], { timeoutMs: 200, spawnProcess }), error => error.code === 'ETIMEDOUT');
  assert.throws(() => process.kill(pid, 0));
});

test('restic 配置迁移保留其他字段，拒绝换行和未知传输类型', () => {
  writeConfig({ backup: { transport: 'restic', resticBinary: 'C:/safe/restic.exe', resticPasswordFile: 'C:/private/password.txt' } });
  assert.equal(readConfig().backup.transport, 'restic');
  writeConfig({ backup: { host: 'new-host' } });
  assert.equal(readConfig().backup.resticBinary, 'C:/safe/restic.exe');
  assert.throws(() => writeConfig({ backup: { resticRepository: 'x\ny' } }), /单行/);
  assert.throws(() => writeConfig({ backup: { transport: 'unknown' } }), /transport/);
});
