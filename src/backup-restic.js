import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './log.js';

export const AUXILIARY_FILES = ['pi-sessions.json', 'pi-activity-index.json', 'chatgpt-request-map.json'];
export const ASSET_DIRECTORIES = ['imports', 'images'];

export function resticSettings(backup) {
  const root = path.join(os.homedir(), '.chat-vault');
  return {
    binary: backup.resticBinary || path.join(root, 'bin', process.platform === 'win32' ? 'restic.exe' : 'restic'),
    passwordFile: backup.resticPasswordFile || path.join(root, 'restic', 'password.txt'),
    repository: backup.resticRepository || 'rclone:chatvault',
    cache: path.join(root, 'restic', 'cache'),
  };
}

// No shell. The SFTP command is parsed by restic, with a strictly bounded host name.
export function resticArgs(backup, command) {
  const settings = resticSettings(backup);
  const args = ['--repo', settings.repository, '--password-file', settings.passwordFile, '--cache-dir', settings.cache, '--json'];
  if (settings.repository.startsWith('rclone:')) {
    if (!/^[A-Za-z0-9_.@:-]+$/.test(backup.host)) throw new Error('restic SSH host 格式无效');
    if (settings.repository !== 'rclone:chatvault') throw new Error('restic 远端入口需为 rclone:chatvault');
    args.push('-o', 'rclone.program=ssh', '-o', `rclone.args=-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ${backup.host} chatvault-recvd restic-stdio`);
  }
  return [...args, ...command];
}

export function runRestic(backup, command, { cwd, timeoutMs = backup.timeoutSec * 1000, onRecord = () => {}, spawnProcess = spawn } = {}) {
  const settings = resticSettings(backup);
  const args = resticArgs(backup, command);
  fs.mkdirSync(settings.cache, { recursive: true });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, RESTIC_PROGRESS_FPS: '0.1' };
    // Explicit configuration wins over ambient credentials / command execution.
    for (const name of ['RESTIC_PASSWORD', 'RESTIC_PASSWORD_COMMAND', 'RESTIC_REPOSITORY', 'RESTIC_REPOSITORY_FILE']) delete env[name];
    const child = spawnProcess(settings.binary, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    let pending = '', stderr = '', output = '', timedOut = false, spawnError = null, callbackError = null;
    const records = [];
    const stop = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const line = (value) => {
      if (!value.trim()) return;
      let record;
      try { record = JSON.parse(value); } catch { return; }
      if (record.message_type !== 'status' && records.length < 1000) records.push(record);
      try { onRecord(record); } catch (error) { callbackError = error; stop(); }
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-16384);
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 16 * 1024 * 1024) { callbackError = new Error('restic JSON 输出超过上限'); stop(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.once('error', error => { spawnError = error; });
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.once('close', code => {
      clearTimeout(timer);
      line(pending);
      if (timedOut) return reject(Object.assign(new Error(`restic ${command[0]} 超时 (${timeoutMs / 1000}s)`), { code: 'ETIMEDOUT' }));
      if (spawnError || callbackError) return reject(spawnError || callbackError);
      // Exit 3 is an incomplete backup, never a successful verified snapshot.
      if (code !== 0) return reject(new Error(`restic ${command[0]} 失败 (${code}): ${(stderr || output).trim().slice(-2000)}`));
      resolve({ records, output, stderr });
    });
  });
}

// Stable paths keep parent detection useful across runs. Snapshot DBs are immutable;
// hard links avoid another multi-GB copy. Auxiliary JSON is copied into this checkpoint.
export function prepareResticInput(snapshotFile, manifestFile, dataRoot) {
  const input = path.join(dataRoot, 'backup-current');
  if (fs.existsSync(input) && (!fs.lstatSync(input).isDirectory() || fs.lstatSync(input).isSymbolicLink())) throw new Error('restic 暂存目录不是普通目录');
  fs.mkdirSync(input, { recursive: true });
  const replaceFile = (source, destination, link = false) => {
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isFile() || fs.lstatSync(destination).isSymbolicLink()) throw new Error('restic 暂存目标不是普通文件');
      fs.unlinkSync(destination);
    }
    if (link) {
      try { fs.linkSync(source, destination); return; }
      catch (error) { if (error.code !== 'EXDEV') throw error; }
    }
    fs.copyFileSync(source, destination);
  };
  for (const [source, name, link] of [[snapshotFile, 'chat-vault.db', true], [manifestFile, 'manifest.json', false]]) {
    replaceFile(source, path.join(input, name), link);
  }
  const sources = ['backup-current/chat-vault.db', 'backup-current/manifest.json'];
  for (const name of AUXILIARY_FILES) {
    const source = path.join(dataRoot, name), dest = path.join(input, name);
    if (fs.existsSync(source)) {
      if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error(`备份源不是普通文件：${name}`);
      // A synchronous read captures one complete atomic-file version.
      const data = fs.readFileSync(source);
      JSON.parse(data.toString('utf8'));
      if (fs.existsSync(dest) && (!fs.lstatSync(dest).isFile() || fs.lstatSync(dest).isSymbolicLink())) throw new Error('restic 索引暂存目标不是普通文件');
      fs.writeFileSync(dest, data);
      sources.push(`backup-current/${name}`);
    } else if (fs.existsSync(dest)) fs.unlinkSync(dest);
  }
  for (const name of ASSET_DIRECTORIES) {
    const file = path.join(dataRoot, name);
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isDirectory() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`备份目录不是普通目录：${name}`);
      sources.push(name);
    }
  }
  return { input, sources };
}

export async function pushRestic(backup, snapshotFile, manifestFile, { onPhase = () => {}, dataRoot = path.join(os.homedir(), '.chat-vault') } = {}) {
  const { sources } = prepareResticInput(snapshotFile, manifestFile, dataRoot);
  let lastLog = 0;
  const uploaded = await runRestic(backup, ['backup', '--host', os.hostname(), '--tag', 'chatvault', '--group-by', 'host,tags', ...sources], {
    cwd: dataRoot,
    onRecord(record) {
      if (record.message_type === 'status' && Date.now() - lastLog > 30000) {
        lastLog = Date.now();
        log.info('backup', `restic 进度 ${record.percent_done == null ? '?' : (record.percent_done * 100).toFixed(1)}%，已处理 ${((record.bytes_done || 0) / 1048576).toFixed(1)} MiB`);
      }
    },
  });
  const summary = uploaded.records.findLast(r => r.message_type === 'summary');
  if (!summary?.snapshot_id) throw new Error('restic 未返回已保存的快照 ID');
  onPhase('verify_remote');
  // Structural verification after every upload; full read-data + restore is a
  // separate acceptance/periodic check, not another full transfer every six hours.
  await runRestic(backup, ['check']);
  const listed = await runRestic(backup, ['snapshots', summary.snapshot_id]);
  const snapshots = listed.records.flatMap(r => Array.isArray(r) ? r : [r]);
  const remote = snapshots.find(s => s.id?.startsWith(summary.snapshot_id));
  if (!remote) throw new Error('restic 已上传快照无法从远端读回');
  return { ok: true, snapshot_id: remote.id, time: remote.time, summary, integrity: 'restic-check-ok' };
}
