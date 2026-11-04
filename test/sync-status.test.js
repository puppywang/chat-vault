import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { backupView, createSyncMonitor, createSyncStatus } from '../src/sync-status.js';
import { openDb } from '../src/db.js';
import { startServer } from '../src/server.js';

const now = Date.parse('2026-10-24T02:00:00+08:00');
const at = hours => new Date(now + hours * 3600000).toISOString();
const config = { backup: { enabled: true, host: 'private-host', dir: '/secret/remote', privateKey: 'secret-key' },
  llm: { apiKey: 'secret-token' } };
const state = { last_success_at: at(-1), last_attempt_at: at(-1), counts: { sessions: 10, messages: 100 },
  last_snapshot: 'C:/secret/path', remote: { private: 'not-for-api' } };
const schedule = { status: 'ready', enabled: true, running: false, lastResult: 0, interval: 'PT6H', nextRunAt: at(3) };
const view = options => backupView({ config, state, schedule, now, ...options });

test('本地扫描：尚未完成、部分失败、恢复和自动扫描停用分开报告', () => {
  const monitor = createSyncMonitor({ enabled: true, watching: true, now: () => now });
  assert.equal(monitor.snapshot().status, 'unknown');
  monitor.start(' 启动');
  assert.equal(monitor.snapshot().status, 'running');
  monitor.finish({ ok: true, summary: { created: 2, failed: 1, failures: ['源文件无法读取'] } });
  assert.equal(monitor.snapshot().status, 'failed');
  assert.equal(monitor.snapshot().lastSuccessAt, null);
  assert.deepEqual(monitor.snapshot().summary.failures, ['源文件无法读取']);
  monitor.start(); monitor.finish({ ok: true, summary: { skipped: 10 } });
  assert.equal(monitor.snapshot().status, 'ok');
  assert.equal(monitor.snapshot().lastSuccessAt, at(0));
  monitor.start(); monitor.finish({ ok: false, error: 'worker exited' });
  assert.equal(monitor.snapshot().status, 'failed');
  assert.equal(monitor.snapshot().lastSuccessAt, at(0));
  const manual = createSyncMonitor({ enabled: true });
  manual.finish({ ok: true });
  assert.equal(manual.snapshot().status, 'paused');
  assert.equal(createSyncMonitor().snapshot().status, 'disabled');
});

test('历史成功和计划任务退出 0 均不能掩盖最新失败或缺少云端确认', () => {
  assert.equal(view().status, 'ok');
  const failed = view({ state: { ...state, last_error: 'upload failed', last_attempt_at: at(-0.5) } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastSuccessAt, at(-1));
  assert.equal(view({ state: null }).status, 'unknown');
  assert.equal(view({ state: { last_success_at: at(-9) } }).status, 'overdue');
  assert.equal(view({ state: { ...state, last_success_at: at(-20), last_verified_at: at(-1) } }).status, 'ok');
  assert.equal(view({ schedule: { ...schedule, enabled: false } }).status, 'paused');
  assert.equal(view({ schedule: { status: 'missing' } }).status, 'unconfirmed');
  assert.equal(view({ schedule: { ...schedule, lastResult: 1, lastRunAt: at(-0.5) } }).status, 'failed');
  assert.equal(view({ schedule: { ...schedule, lastResult: 1, lastRunAt: at(-2) } }).status, 'ok');
  assert.equal(view({ config: { backup: { enabled: false } } }).status, 'disabled');
  assert.equal(view({ config: { backup: { enabled: true } } }).status, 'unconfigured');
});

test('残留进度不是运行中：必须有锁且所属进程仍在，死进程显示中断', () => {
  const progress = { pid: 123, startedAt: at(-0.1), phase: 'upload' };
  const runningState = { ...state, progress };
  assert.equal(view({ state: runningState, lockAt: now, isAlive: () => true }).status, 'running');
  assert.equal(view({ state: runningState, lockAt: now, isAlive: () => false }).status, 'failed');
  assert.equal(view({ state: runningState, lockAt: 0, isAlive: () => true }).status, 'failed');
  assert.equal(view({ schedule: { ...schedule, running: true, lastResult: 267009 } }).status, 'running');
});

test('状态轮询不等待慢计划任务；同一查询合并且缓存一分钟', async () => {
  let release, calls = 0, clock = now;
  const provider = createSyncStatus({ config: () => config, state: () => state, lockReader: () => 0,
    now: () => clock, scheduleReader: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  assert.equal(provider.snapshot().backup.schedule.status, 'checking');
  await Promise.resolve();
  for (let i = 0; i < 50; i++) provider.snapshot();
  assert.equal(calls, 1);
  release(schedule);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(provider.snapshot().backup.schedule.status, 'ready');
  assert.equal(calls, 1);
  clock += 61000;
  provider.snapshot(); await Promise.resolve();
  assert.equal(calls, 2);
  release(schedule); provider.close();
});

test('HTTP 状态接口不缓存、不暴露凭据或原始备份配置', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatvault-sync-status-'));
  const dbPath = path.join(dir, 'test.db'), db = openDb(dbPath);
  const provider = createSyncStatus({ config: () => config, state: () => state,
    lockReader: () => 0, scheduleReader: async () => schedule });
  const server = startServer(db, { port: 0, dbPath, syncStatus: provider });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界');
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (e) { if (i === 19) throw e; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  });
  if (!server.listening) await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/sync-status`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text();
  assert.doesNotMatch(body, /secret|private|C:\//);
  assert.equal(JSON.parse(body).backup.lastSuccessAt, at(-1));
});
