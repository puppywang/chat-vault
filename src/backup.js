// 远端备份：一致性快照 → 去派生索引 → 自检 → 推送 → 远端校验与周/月档保留
// 设计见 docs/BACKUP-DESIGN.md
// - 默认在单个只读事务中直接复制业务表，不复制 FTS、不做第二次整库 VACUUM
// - 快照去掉 external-content FTS 索引（占 1/3 体积、压缩率极差、布局反复重排），恢复时 rebuild
// - restic 分块加密去重，经 SSH 的 REST stdio 上传；保留原 ssh/rsync 回退通路
// - 远端只放行受限分发脚本 chatvault-recvd，验证通过前绝不删本地快照
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { readConfig } from './config.js';
import { log } from './log.js';
import { createDataSnapshot } from './backup-snapshot.js';
import { pushRestic, runRestic } from './backup-restic.js';

export const SNAPSHOT_NAME = 'chat-vault.db';
export const MANIFEST_NAME = 'manifest.json';
export const STATE_FILE = path.join(os.homedir(), '.chat-vault', 'backup-state.json');
const REMOTE_HELPER = 'chatvault-recvd';
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15'];

/** 备份配置：默认值 + config 覆盖（默认值需与 src/config.js 的 DEFAULTS.backup 保持一致） */
export function backupConfig(cfg = readConfig()) {
  return {
    enabled: false,
    host: '',
    dir: '/srv/backup/chatvault',
    transport: 'auto',
    resticBinary: '',
    resticPasswordFile: '',
    resticRepository: '',
    stagingDir: '',
    keepLocal: 3,
    keepWeekly: 8,
    keepMonthly: 3,
    excludeFts: true,
    timeoutSec: 900,
    ...(cfg.backup || {}),
  };
}

export function defaultStagingDir(backup) {
  return backup.stagingDir || path.join(os.homedir(), '.chat-vault', 'backup-staging');
}

/** 快照目录名：本地时间 + pid，排序即时间序 */
function snapshotStamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/** VACUUM INTO：读一致性快照，自带 journal_mode=delete（无 -wal/-shm 尾巴），顺带回收空闲页 */
export function createSnapshot(dbPath, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.rmSync(outFile, { force: true });
  const db = new DatabaseSync(dbPath, { timeout: 60000 });
  try {
    db.exec(`VACUUM INTO '${outFile.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return outFile;
}

/** 丢掉派生数据：messages_fts 是 external-content 索引，可由 messages.fts_text 全量 rebuild */
export function stripDerived(file) {
  const db = new DatabaseSync(file);
  try {
    const has = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='messages_fts'").get().c > 0;
    if (!has) return false;
    db.exec('DROP TABLE messages_fts');
    db.exec('VACUUM');
    return true;
  } finally {
    db.close();
  }
}

/** 自检：完整性与行数，用来和本地库对照（不一致就不推） */
export function inspectSnapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const one = (sql) => Object.values(db.prepare(sql).get())[0];
    const integrity = one('PRAGMA integrity_check');
    const hasLinks = one("SELECT count(*) FROM sqlite_master WHERE name='session_links'") > 0;
    const counts = {
      sessions: one('SELECT count(*) FROM sessions'),
      messages: one('SELECT count(*) FROM messages'),
      workspaces: one('SELECT count(*) FROM workspaces'),
      links: hasLinks ? one('SELECT count(*) FROM session_links') : 0,
    };
    const lastUpdatedAt = one('SELECT max(updated_at) FROM sessions') ?? null;
    const pages = {
      size: one('PRAGMA page_size'),
      count: one('PRAGMA page_count'),
      free: one('PRAGMA freelist_count'),
    };
    return { integrity, counts, lastUpdatedAt, pages };
  } finally {
    db.close();
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

/** 只读计数：单个读取事务内取得同一时刻的行数与最新时间。 */
export function probeLiveDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const one = (sql) => Object.values(db.prepare(sql).get())[0];
    const hasLinks = one("SELECT count(*) FROM sqlite_master WHERE name='session_links'") > 0;
    return {
      sessions: one('SELECT count(*) FROM sessions'),
      messages: one('SELECT count(*) FROM messages'),
      workspaces: one('SELECT count(*) FROM workspaces'),
      links: hasLinks ? one('SELECT count(*) FROM session_links') : 0,
      lastUpdatedAt: one('SELECT max(updated_at) FROM sessions') ?? null,
    };
  } finally {
    db.close();
  }
}

function buildManifest(backup, file, info, { dbPath, version }) {
  const stat = fs.statSync(file);
  return {
    version: 1,
    tool: { name: 'chat-vault', version },
    created_at: new Date().toISOString(),
    host: os.hostname(),
    source_db: path.basename(dbPath),
    snapshot: {
      file: SNAPSHOT_NAME,
      size: stat.size,
      sha256: info.sha256,
      fts_included: !backup.excludeFts,
      journal_mode: 'delete',
    },
    integrity_check: info.integrity,
    counts: info.counts,
    last_updated_at: info.lastUpdatedAt,
    pages: info.pages,
    retention: { keep_weekly: backup.keepWeekly, keep_monthly: backup.keepMonthly },
  };
}

/** 本地暂存裁剪：只删最老的，保留份数由 keepLocal 决定（推送失败也不会无限制堆） */
export function pruneLocalSnapshots(stagingDir, keep) {
  if (!fs.existsSync(stagingDir)) return [];
  const dirs = fs.readdirSync(stagingDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}(-\d+)?$/.test(d.name))
    .map((d) => d.name)
    .sort();
  const removed = [];
  while (dirs.length > keep) {
    const name = dirs.shift();
    fs.rmSync(path.join(stagingDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

export function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

export function writeState(patch) {
  const prev = readState() || {};
  const next = { ...prev, ...patch };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, STATE_FILE);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 传输
// ---------------------------------------------------------------------------

/** 有 rsync 就用 rsync（原地 delta），否则退化为 ssh 流式 gzip 全量 */
export function detectTransport(backup) {
  if (backup.transport === 'ssh') return { kind: 'ssh' };
  if (backup.transport === 'rsync') return { kind: 'rsync' };
  return { kind: fs.existsSync('/usr/bin/rsync') || whichRsync() ? 'rsync' : 'ssh' };
}

function whichRsync() {
  const exts = (process.env.PATHEXT || '.EXE').split(';');
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      try { if (dir && fs.existsSync(path.join(dir, 'rsync' + ext))) return true; } catch { /* 无权限的 PATH 项 */ }
    }
  }
  return false;
}

// ProxyJump may create a second local ssh.exe. Reap the owned tree on Windows.
function killTransfer(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.once('error', () => child.kill('SIGKILL'));
}

function sshRun(backup, remoteCmd, { timeoutMs = backup.timeoutSec * 1000, collectStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const args = [...SSH_OPTS, backup.host, remoteCmd];
    const child = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'] });
    let out = '';
    let err = '';
    if (collectStdout) child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
    const timer = setTimeout(() => { killTransfer(child); reject(new Error(`ssh 超时 (${Math.round(timeoutMs / 1000)}s): ${remoteCmd.slice(0, 80)}`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function run(cmd, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
    const timer = timeoutMs ? setTimeout(() => { killTransfer(child); reject(new Error(`${cmd} 超时`)); }, timeoutMs) : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

/** rsync 原地 delta：远端 current.db 既是 delta 基底也是本次产物 */
async function pushRsync(backup, localFile, remoteRel, timeoutMs) {
  const remote = `${backup.host}:${remoteRel}`;
  const args = [
    '-a', '--inplace', '--partial', '--compress', '--no-perms', '--no-owner', '--no-group',
    '-e', `ssh ${SSH_OPTS.join(' ')}`, localFile, remote,
  ];
  const r = await run('rsync', args, { timeoutMs });
  if (r.code !== 0) throw new Error(`rsync 失败 (${r.code}): ${(r.stderr || r.stdout).trim().slice(-400)}`);
  return { bytes: fs.statSync(localFile).size, note: 'rsync --inplace' };
}

/** 流式 gzip + ssh 'recv --gzip <rel>'：无 rsync 时的全量通道 */
export async function pushStream(backup, localFile, remoteRel, timeoutMs, { spawnProcess = spawn, progressMs = 30000 } = {}) {
  const bytes = fs.statSync(localFile).size;
  const child = spawnProcess('ssh', [...SSH_OPTS, backup.host, `${REMOTE_HELPER} recv --gzip ${remoteRel}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  let spawnError = null;
  // Register before starting the pipeline: short uploads or early SSH failures
  // may close before stdin's pipeline promise has settled.
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', (d) => { out += d; if (out.length > 8192) out = out.slice(-8192); });
  child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
  const source = fs.createReadStream(localFile);
  const gzip = zlib.createGzip({ level: 6 });
  const startedAt = Date.now();
  let compressedBytes = 0;
  let lastDataAt = startedAt;
  let timedOut = false;
  let pipelineError = null;
  gzip.on('data', (chunk) => { compressedBytes += chunk.length; lastDataAt = Date.now(); });
  const progress = () => `${(source.bytesRead / 1048576).toFixed(1)}/${(bytes / 1048576).toFixed(1)} MiB，` +
    `gzip ${(compressedBytes / 1048576).toFixed(1)} MiB，${((Date.now() - startedAt) / 1000).toFixed(1)}s，` +
    `无新压缩输出 ${Math.floor((Date.now() - lastDataAt) / 1000)}s`;
  const terminate = (reason) => {
    source.destroy(reason);
    gzip.destroy(reason);
    child.stdin.destroy(reason);
    killTransfer(child);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(new Error('SSH upload deadline exceeded'));
  }, timeoutMs);
  const progressTimer = progressMs > 0 ? setInterval(() => log.info('backup', `上传进度 ${remoteRel}：${progress()}`), progressMs) : null;
  try {
    try {
      await pipeline(source, gzip, child.stdin);
    } catch (error) {
      pipelineError = error;
      // Give an SSH error/diagnostic already in flight a chance to reach close.
      // A local read error must also terminate SSH rather than leave a receiver.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') terminate(error);
    }
    const { code, signal } = await closed;
    const detail = (err || out).trim().slice(-1200);
    if (timedOut) {
      throw Object.assign(new Error(`ssh 上传超时 (${Math.round(timeoutMs / 1000)}s)，${remoteRel}：${progress()}` +
        (detail ? `；SSH: ${detail}` : '')), { code: 'ETIMEDOUT' });
    }
    if (spawnError || code !== 0 || pipelineError) {
      const cause = spawnError || pipelineError;
      throw Object.assign(new Error(`ssh 上传失败 (${code ?? signal ?? 'spawn'})，${remoteRel}：${progress()}` +
        (detail ? `；SSH: ${detail}` : '') + (cause ? `；${cause.message}` : ''), { cause }),
      { code: spawnError?.code || pipelineError?.code || 'SSH_UPLOAD_FAILED' });
    }
  } finally {
    clearTimeout(timer);
    if (progressTimer) clearInterval(progressTimer);
  }
  return { bytes, compressedBytes, note: 'ssh + gzip' };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 远端助手统一输出单行 JSON，这里从末尾往前找出第一个能解析的行（容忍夹杂的日志/warning） */
function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* 继续往前找 */ }
  }
  return null;
}

/** No-change uploads still need a reachable remote with the matching verified
 * manifest. Never clear an error or refresh verification from a local SHA alone. */
export async function confirmRemoteSnapshot(backup, sha256, { runSsh = sshRun } = {}) {
  const check = await runSsh(backup, `${REMOTE_HELPER} status`, { timeoutMs: 60000 });
  const remote = parseLastJson(check.stdout);
  if (check.code !== 0 || !remote?.ok || remote.manifest?.snapshot?.sha256 !== sha256) {
    throw new Error('无变化快照的远端确认失败，请检查连接或使用 --force 重新上传');
  }
  return remote;
}

function requireHost(backup) {
  if (!backup.enabled) throw new Error('备份未启用：config.json 里设 backup.enabled=true');
  if (!backup.host) throw new Error('未配置 backup.host（ssh 别名或 user@host）');
  if (!backup.dir || backup.dir[0] !== '/') throw new Error('backup.dir 需为远端绝对路径');
}

/** 并发保护：计划任务与手动同时跑会互相覆盖远端 current.db，抢不到锁的直接退出 */
function acquireLock() {
  const file = path.join(path.dirname(STATE_FILE), 'backup.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // A crash between exclusive creation and writing can leave an empty file.
  const stale = readLock(file) || (fs.existsSync(file) ? fs.statSync(file).mtimeMs : null);
  const pid = readState()?.progress?.pid;
  let active = false;
  if (pid) { try { process.kill(pid, 0); active = true; } catch (e) { active = e.code === 'EPERM'; } }
  if (stale && (active || Date.now() - stale < 30 * 60000)) return { file, held: false, age: stale };
  if (stale) fs.unlinkSync(file);
  try { fs.writeFileSync(file, String(Date.now()), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return { file, held: false }; throw error; }
  return { file, held: true };
}

function readLock(file) {
  try { return Number(fs.readFileSync(file, 'utf8')) || null; } catch { return null; }
}

function releaseLock(lock) {
  if (lock?.held) { try { fs.rmSync(lock.file, { force: true }); } catch { /* 已被清理 */ } }
}

/**
 * 备份一次。dry-run 只做本地快照+自检（不联网）。
 * 返回 { skipped?, snapshot, manifest, remote? }
 */
export async function runBackup({ dbPath, version = '0.0.0', opts = {}, cfg = readConfig() } = {}) {
  const backup = backupConfig(cfg);
  const dryRun = !!opts.dryRun;
  if (!dryRun) requireHost(backup);
  else if (!backup.host) log.warn('backup', '未配置 backup.host，dry-run 只做本地快照');

  const lock = dryRun ? null : acquireLock();
  if (lock && !lock.held) {
    log.warn('backup', '已有备份锁，本次跳过');
    return { skipped: true, reason: 'locked' };
  }

  try {
    if (!dryRun) writeState({ last_attempt_at: new Date().toISOString(),
      progress: { pid: process.pid, startedAt: new Date().toISOString(), phase: 'snapshot' } });
    return await runBackupLocked({ dbPath, version, opts, cfg, backup, dryRun });
  } catch (error) {
    if (!dryRun) {
      try {
        writeState({ last_attempt_at: new Date().toISOString(), last_error: String(error?.message || error).slice(0, 2000), progress: null });
      } catch (stateError) {
        log.error('backup', '备份失败状态保存失败', stateError);
      }
    }
    log.error('backup', '备份失败', error);
    throw error;
  } finally {
    releaseLock(lock);
  }
}

async function runBackupLocked({ dbPath, version, opts, backup, dryRun }) {
  const phase = (name) => {
    if (!dryRun) writeState({ progress: { ...readState()?.progress, phase: name } });
  };
  const stagingDir = defaultStagingDir(backup);
  const dir = opts.retrySnapshot ? path.resolve(opts.retrySnapshot) : path.join(stagingDir, snapshotStamp());
  const snapshotFile = path.join(dir, SNAPSHOT_NAME);
  const manifestFile = path.join(dir, MANIFEST_NAME);

  const t0 = Date.now();
  const timings = {};
  let info, sha256, manifest, finalBytes, ftsDropped;
  if (opts.retrySnapshot) {
    phase('verify_local');
    ({ info, sha256, manifest, finalBytes } = await verifyPreparedSnapshot(backup, dir));
    Object.assign(timings, manifest.timings || {});
    log.info('backup', `重传已校验快照 ${path.basename(dir)}：${info.counts.sessions} 会话 / ${info.counts.messages} 消息`);
  } else {
    let baseline;
    if (backup.excludeFts) {
      ({ baseline, ftsDropped } = createDataSnapshot(dbPath, snapshotFile));
    } else {
      createSnapshot(dbPath, snapshotFile);
      baseline = probeLiveDb(snapshotFile);
      ftsDropped = false;
    }
    timings.snapshot_ms = Date.now() - t0;
    const bytes = fs.statSync(snapshotFile).size;
    phase('verify_local');
    let started = Date.now();
    info = inspectSnapshot(snapshotFile);
    timings.integrity_ms = Date.now() - started;
    if (info.integrity !== 'ok') throw new Error(`快照完整性检查失败: ${info.integrity}`);
    if (Object.entries(info.counts).some(([key, value]) => baseline[key] !== value) || baseline.lastUpdatedAt !== info.lastUpdatedAt) {
      throw new Error('快照裁剪前后的数据不一致，拒绝上传');
    }
    phase('hash');
    started = Date.now();
    sha256 = await sha256File(snapshotFile);
    timings.hash_ms = Date.now() - started;
    const live = opts.skipLiveProbe ? null : probeLiveDb(dbPath);
    if (live && (live.sessions !== info.counts.sessions || live.messages !== info.counts.messages)) {
      log.info('backup', `源库在快照后继续变化：快照 ${info.counts.sessions}/${info.counts.messages}，当前 ${live.sessions}/${live.messages}；保留快照时刻的一致副本`);
    }

    manifest = buildManifest(backup, snapshotFile, { ...info, sha256 }, { dbPath, version });
    manifest.timings = timings;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
    finalBytes = fs.statSync(snapshotFile).size;
    log.info('backup', `快照 ${snapshotStamp()} 完成：${(bytes / 1048576).toFixed(1)} MiB，${info.counts.sessions} 会话 / ${info.counts.messages} 消息；生成 ${(timings.snapshot_ms / 1000).toFixed(1)}s，完整性 ${(timings.integrity_ms / 1000).toFixed(1)}s，哈希 ${(timings.hash_ms / 1000).toFixed(1)}s`);
  }

  if (dryRun) {
    pruneLocalSnapshots(stagingDir, backup.keepLocal);
    return { dryRun: true, snapshot: snapshotFile, manifest, ftsDropped };
  }

  const prev = readState();
  if (backup.transport === 'restic') {
    phase('upload');
    const started = Date.now();
    const remote = await pushRestic(backup, snapshotFile, manifestFile, { onPhase: phase, dataRoot: path.dirname(path.resolve(dbPath)) });
    timings.upload_verify_ms = Date.now() - started;
    phase('retention');
    await runRestic(backup, ['forget', '--tag', 'chatvault', '--host', os.hostname(), '--group-by', 'host,tags',
      '--keep-last', '3', '--keep-daily', '7', '--keep-weekly', String(backup.keepWeekly), '--keep-monthly', String(backup.keepMonthly)]);
    let lastPrune = prev?.restic_last_prune_at;
    if (Date.now() - (Date.parse(lastPrune) || 0) > 7 * 86400000) {
      await runRestic(backup, ['prune']);
      lastPrune = new Date().toISOString();
    }
    const now = new Date().toISOString();
    const state = writeState({ last_attempt_at: now, last_success_at: now, last_verified_at: now,
      last_error: null, progress: null, last_snapshot: snapshotFile, last_success_sha256: sha256,
      transport: 'restic', remote, counts: info.counts, size_bytes: finalBytes, timings,
      elapsed_ms: Date.now() - t0, restic_last_prune_at: lastPrune });
    pruneLocalSnapshots(stagingDir, backup.keepLocal);
    log.info('backup', `restic 完成：${remote.snapshot_id.slice(0, 8)}，新增存储 ${((remote.summary.data_added_packed || 0) / 1048576).toFixed(1)} MiB，总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { snapshot: snapshotFile, manifest, remote, state, transport: { kind: 'restic' } };
  }
  if (!opts.force && prev && prev.transport !== 'restic' && prev.last_success_sha256 === sha256) {
    phase('verify_remote');
    await confirmRemoteSnapshot(backup, sha256);
    writeState({ last_attempt_at: new Date().toISOString(), last_verified_at: new Date().toISOString(),
      last_error: null, progress: null });
    log.info('backup', '自上次成功推送以来库无变化，跳过上传（要强制加 --force）');
    pruneLocalSnapshots(stagingDir, backup.keepLocal);
    return { skipped: true, snapshot: snapshotFile, manifest };
  }

  const transport = detectTransport(backup);
  const remoteBase = backup.dir.replace(/\/+$/, '');
  const remoteDb = 'incoming/current.db';
  const remoteManifest = 'incoming/manifest.json';
  const timeoutMs = backup.timeoutSec * 1000;
  log.info('backup', `推送 → ${backup.host}:${remoteBase}（${transport.kind === 'rsync' ? 'rsync --inplace' : 'ssh 流式 gzip'}）`);

  const t1 = Date.now();
  phase('upload');
  let pushed;
  if (transport.kind === 'rsync') {
    pushed = await pushRsync(backup, snapshotFile, remoteDb, timeoutMs);
    await pushRsync(backup, manifestFile, remoteManifest, timeoutMs);
  } else {
    pushed = await pushStream(backup, snapshotFile, remoteDb, timeoutMs);
    await pushStream(backup, manifestFile, remoteManifest, timeoutMs);
  }
  log.info('backup', `已上传 ${(pushed.bytes / 1048576).toFixed(1)}MB（${pushed.note}），开始远端校验`);
  phase('verify_remote');

  const verifyCmd = `${REMOTE_HELPER} finalize ${sha256} ${info.counts.sessions} ${info.counts.messages} ${info.counts.workspaces} ${backup.keepWeekly} ${backup.keepMonthly}`;
  const vr = await sshRun(backup, verifyCmd, { timeoutMs });
  const remote = parseLastJson(vr.stdout);
  if (vr.code !== 0 || !remote?.ok) {
    const detail = remote?.error || vr.stderr.trim().slice(-300) || `exit ${vr.code}`;
    writeState({ last_attempt_at: new Date().toISOString(), last_error: String(detail), last_snapshot: snapshotFile });
    throw new Error(`远端校验失败：${detail}`);
  }

  const state = writeState({
    last_attempt_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(),
    last_verified_at: new Date().toISOString(),
    last_error: null,
    progress: null,
    last_snapshot: snapshotFile,
    last_success_sha256: sha256,
    transport: transport.kind,
    remote,
    counts: info.counts,
    size_bytes: finalBytes,
    elapsed_ms: Date.now() - t1,
  });
  const removed = pruneLocalSnapshots(stagingDir, backup.keepLocal);
  if (removed.length) log.info('backup', `暂存裁剪：删除 ${removed.join(', ')}`);
  log.info('backup', `推送完成（${((Date.now() - t1) / 1000).toFixed(1)}s）：远端 ${remote.verified_size_mb}MB，完整性 ${remote.integrity}，` +
    `会话 ${remote.counts.sessions} / 消息 ${remote.counts.messages}`);
  return { snapshot: snapshotFile, manifest, remote, state, transport };
}

/** Explicit recovery of a completed staging snapshot; never trust its manifest alone. */
export async function verifyPreparedSnapshot(backup, directory) {
  const staging = fs.realpathSync(defaultStagingDir(backup));
  const dir = path.resolve(directory);
  if (path.dirname(dir) !== staging || !/^\d{8}-\d{6}(-\d+)?$/.test(path.basename(dir)) || fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('重传目录必须是本备份 staging 下的普通快照目录');
  }
  for (const name of [SNAPSHOT_NAME, MANIFEST_NAME]) {
    const stat = fs.lstatSync(path.join(dir, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('重传快照必须为普通文件');
  }
  const file = path.join(dir, SNAPSHOT_NAME);
  const manifestFile = path.join(dir, MANIFEST_NAME);
  if (fs.statSync(manifestFile).size > 65536) throw new Error('重传清单过大');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const info = inspectSnapshot(file);
  const sha256 = await sha256File(file);
  const finalBytes = fs.statSync(file).size;
  if (manifest.version !== 1 || manifest.tool?.name !== 'chat-vault' || manifest.snapshot?.file !== SNAPSHOT_NAME ||
      info.integrity !== 'ok' || manifest.integrity_check !== 'ok' || manifest.snapshot.sha256 !== sha256 ||
      manifest.snapshot.size !== finalBytes || Object.entries(info.counts).some(([k, v]) => manifest.counts?.[k] !== v) ||
      manifest.last_updated_at !== info.lastUpdatedAt) {
    throw new Error('重传快照与清单的哈希、完整性或行数不一致，拒绝上传');
  }
  return { manifest, info, sha256, finalBytes };
}

/** 状态：本地 state 文件 + 远端清单（只读，不产生副作用） */
export async function backupStatus({ cfg = readConfig() } = {}) {
  const backup = backupConfig(cfg);
  const state = readState();
  let remote = null;
  let error = null;
  if (backup.host) {
    try {
      if (backup.transport === 'restic') {
        const r = await runRestic(backup, ['snapshots', '--tag', 'chatvault', '--host', os.hostname(), '--latest', '1'], { timeoutMs: 60000 });
        remote = { ok: true, snapshots: r.records.flatMap(x => Array.isArray(x) ? x : [x]) };
      } else {
        const r = await sshRun(backup, `${REMOTE_HELPER} status`, { timeoutMs: 60000 });
        remote = r.code === 0 ? parseLastJson(r.stdout) : null;
        if (r.code !== 0) error = (r.stderr || r.stdout).trim().slice(-300);
      }
    } catch (e) {
      error = String(e.message || e);
    }
  }
  return { configured: !!(backup.enabled && backup.host), backup, state, remote, error };
}

/** Restore into an empty, separate directory, then verify the original manifest. */
export async function restoreBackup({ target, snapshotId = 'latest', cfg = readConfig() } = {}) {
  const backup = backupConfig(cfg);
  requireHost(backup);
  if (backup.transport !== 'restic') throw new Error('此恢复入口需配置 backup.transport=restic');
  if (!target || !/^(?:latest|[a-f0-9]{8,64})$/.test(snapshotId)) throw new Error('恢复需指定空目录及有效快照 ID');
  const destination = path.resolve(target);
  const dataRoot = path.join(os.homedir(), '.chat-vault');
  // Resolve existing ancestors too: a parent junction must not redirect into
  // the active data directory when the final destination doesn't exist yet.
  let ancestor = destination;
  const suffix = [];
  while (!fs.existsSync(ancestor)) { suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const canonical = path.join(fs.realpathSync(ancestor), ...suffix);
  const relative = path.relative(fs.existsSync(dataRoot) ? fs.realpathSync(dataRoot) : dataRoot, canonical);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('恢复目录必须位于现用数据目录以外');
  if (fs.existsSync(destination)) {
    if (!fs.lstatSync(destination).isDirectory() || fs.lstatSync(destination).isSymbolicLink() || fs.readdirSync(destination).length) throw new Error('恢复目录必须为空且不是链接');
  } else fs.mkdirSync(destination, { recursive: true });
  await runRestic(backup, ['restore', snapshotId, '--tag', 'chatvault', '--host', os.hostname(), '--target', destination, '--verify']);
  // Relative input paths produce /backup-current; tolerate drive prefixes in
  // snapshots imported from another restic client without guessing the DB file.
  const matches = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'backup-current' && fs.existsSync(path.join(full, SNAPSHOT_NAME))) matches.push(full);
      else walk(full);
    }
  };
  walk(destination);
  if (matches.length !== 1) throw new Error('恢复后未找到唯一的数据库检查点');
  const file = path.join(matches[0], SNAPSHOT_NAME);
  const manifest = JSON.parse(fs.readFileSync(path.join(matches[0], MANIFEST_NAME), 'utf8'));
  const info = inspectSnapshot(file), sha256 = await sha256File(file);
  if (manifest.tool?.name !== 'chat-vault' || info.integrity !== 'ok' || manifest.snapshot?.sha256 !== sha256 ||
      manifest.snapshot.size !== fs.statSync(file).size || Object.entries(info.counts).some(([k, v]) => manifest.counts?.[k] !== v)) {
    throw new Error('恢复数据库与原清单的完整性、哈希或行数不一致');
  }
  const result = { ok: true, snapshotId, target: destination, database: file, sha256, counts: info.counts, integrity: info.integrity };
  fs.writeFileSync(path.join(destination, 'restore-verification.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
