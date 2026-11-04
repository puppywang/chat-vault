// Cheap, read-only status snapshots. Scheduler discovery is bounded, cached and
// asynchronous; polling this endpoint never runs SSH or scans the message table.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.js';
import { readState, STATE_FILE } from './backup.js';

const HOUR = 3600000;
const timestamp = (value) => Date.parse(value) || 0;
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function createSyncMonitor({ enabled = false, watching = false, pollIntervalSec = 0, now = Date.now } = {}) {
  const state = { enabled, watching, pollIntervalSec, startedAt: null, finishedAt: null,
    lastSuccessAt: null, running: false, reason: '', summary: null, error: null };
  return {
    start(reason = '') {
      Object.assign(state, { running: true, startedAt: new Date(now()).toISOString(), reason: reason.trim() });
    },
    finish(result) {
      const finishedAt = new Date(now()).toISOString();
      const summary = result.summary ? {
        ...Object.fromEntries(['created', 'updated', 'skipped', 'empty', 'failed'].map(k => [k, Number(result.summary[k]) || 0])),
        failures: (result.summary.failures || []).slice(0, 5).map(x => String(x).slice(0, 500)),
      } : null;
      const error = !result.ok ? String(result.error || '同步失败').slice(0, 2000)
        : summary?.failed ? `${summary.failed} 个数据源文件处理失败` : null;
      Object.assign(state, { running: false, finishedAt, summary, error });
      if (!error) state.lastSuccessAt = finishedAt;
    },
    snapshot() {
      return { ...state, status: !enabled ? 'disabled' : state.running ? 'running' : state.error ? 'failed'
        : !state.finishedAt ? 'unknown' : watching || pollIntervalSec > 0 ? 'ok' : 'paused' };
    },
  };
}

// No user-supplied command/path interpolation. Get-ScheduledTask runs in this
// process only; execFile kills it after 8 s, and close() reaps an in-flight probe.
export function readBackupSchedule({ registerChild = () => {} } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ status: 'unsupported' });
  const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop';
    $t=Get-ScheduledTask -TaskName 'ChatVaultBackup' -ErrorAction SilentlyContinue;
    if (!$t) { @{status='missing'} | ConvertTo-Json -Compress; exit };
    $i=Get-ScheduledTaskInfo -InputObject $t;
    $interval=($t.Triggers | Where-Object {$_.Repetition.Interval} | Select-Object -First 1).Repetition.Interval;
    @{status='ready'; enabled=[bool]$t.Settings.Enabled; running=([string]$t.State -eq 'Running');
      lastRunAt=$(if($i.LastRunTime.Year -gt 2000){$i.LastRunTime.ToUniversalTime().ToString('o')}else{$null});
      nextRunAt=$(if($i.NextRunTime.Year -gt 2000){$i.NextRunTime.ToUniversalTime().ToString('o')}else{$null});
      lastResult=[long]$i.LastTaskResult; interval=$interval} | ConvertTo-Json -Compress`;
  return new Promise((resolve) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 32768, encoding: 'utf8' }, (error, stdout) => {
        registerChild(null);
        if (error) return resolve({ status: 'unavailable', error: '无法读取 Windows 备份计划任务' });
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); }
        catch { resolve({ status: 'unavailable', error: '备份计划任务返回了无效状态' }); }
      });
    registerChild(child);
  });
}

export function backupView({ config, state, lockAt = 0, schedule = {}, now = Date.now(), isAlive = alive }) {
  const backup = config.backup || {};
  const configured = !!(backup.enabled && backup.host);
  const progress = state?.progress;
  const running = !!(progress && lockAt && isAlive(progress.pid));
  const interrupted = !!(progress && !running);
  // A successful scheduled invocation alone is insufficient: a verified remote
  // snapshot must exist. A historical success cannot hide a more recent error.
  const verifiedAt = state?.last_verified_at || state?.last_success_at || null;
  const every = /^PT([\d.]+)H$/.exec(schedule.interval || '');
  const intervalMs = every ? Number(every[1]) * HOUR : 6 * HOUR;
  const overdue = !!verifiedAt && now - timestamp(verifiedAt) > intervalMs + 2 * HOUR;
  const taskFailed = schedule.status === 'ready' && !schedule.running && schedule.lastResult !== 0
    && timestamp(schedule.lastRunAt) > timestamp(state?.last_attempt_at);
  let status = !backup.enabled ? 'disabled' : !configured ? 'unconfigured'
    : running ? 'running' : state?.last_error || interrupted || taskFailed ? 'failed'
    : schedule.status === 'ready' && !schedule.enabled ? 'paused'
    : overdue ? 'overdue' : !verifiedAt ? 'unknown'
    : schedule.status !== 'ready' ? 'unconfirmed' : 'ok';
  if (configured && !running && schedule.running) status = 'running';
  return {
    status, configured, lastSuccessAt: state?.last_success_at || null, lastVerifiedAt: verifiedAt,
    lastAttemptAt: state?.last_attempt_at || null,
    error: state?.last_error || (interrupted ? '上次备份进程已退出，未记录完成结果' : null)
      || (taskFailed ? `计划任务退出码 ${schedule.lastResult}` : null),
    phase: running ? progress.phase : schedule.running ? 'starting' : null,
    startedAt: running ? progress.startedAt : schedule.running ? schedule.lastRunAt : null,
    counts: state?.counts ? { sessions: state.counts.sessions, messages: state.counts.messages } : null,
    sizeBytes: state?.size_bytes || null, schedule,
    // This timestamp refers to a saved remote verification, never a live probe.
    verificationSource: 'saved', overdueAfterHours: intervalMs / HOUR + 2,
  };
}

export function createSyncStatus({ monitor = createSyncMonitor(), config = readConfig, state = readState,
  scheduleReader = readBackupSchedule, now = Date.now, isAlive = alive,
  lockReader = () => { try { return Number(fs.readFileSync(path.join(path.dirname(STATE_FILE), 'backup.lock'), 'utf8')) || 0; } catch { return 0; } },
} = {}) {
  let schedule = { status: 'checking' }, checkedAt = 0, pending = null, child = null, closed = false;
  return {
    snapshot() {
      if (!closed && !pending && (!checkedAt || now() - checkedAt > 60000)) {
        pending = Promise.resolve().then(() => closed ? schedule : scheduleReader({ registerChild: p => { child = p; } }))
          .then(value => { schedule = value; })
          .catch(() => { schedule = { status: 'unavailable', error: '无法读取备份计划任务' }; })
          .finally(() => { checkedAt = now(); pending = null; });
      }
      return { checkedAt: new Date(now()).toISOString(), local: monitor.snapshot(),
        backup: backupView({ config: config(), state: state(), lockAt: lockReader(), schedule, now: now(), isAlive }) };
    },
    close() { closed = true; child?.kill(); },
  };
}
