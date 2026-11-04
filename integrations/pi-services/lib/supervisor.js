// 服务监管进程：node supervisor.js <spec.json>
//
// 由 core.js 以「分离 + 隐藏窗口」方式拉起，独立于 Pi 会话存活。它负责：
//   - 按 spec 拉起子进程（隐藏窗口，stdout/stderr 追加到 out.log，超过上限轮转一次）
//   - 定期写 state.json（含心跳），子进程退出时记下退出码
//   - TTL 到期结束整个进程树（有界：一次性作业和探针不会被遗忘在后台）
//   - restart 策略（on-failure / always），指数退避，有次数上限
//   - 看到 stop 标记就不再重启，写 stopped 后退出
// 状态只由本进程写（监管进程已死时才由 core.js 代写）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killTree } from './platform.js';

const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const dir = path.dirname(specPath);
const statePath = path.join(dir, 'state.json');
const stopPath = path.join(dir, 'stop');
const logPath = path.join(dir, 'out.log');
const MAX_LOG_BYTES = Number(spec.maxLogBytes) > 0 ? Number(spec.maxLogBytes) : 20 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;
const BACKOFF_MS = Number(spec.restartBackoffMs) > 0 ? Number(spec.restartBackoffMs) : 2000;
const MAX_RESTARTS = Number.isInteger(spec.maxRestarts) && spec.maxRestarts >= 0 ? spec.maxRestarts : 5;

let state = { generation: spec.generation, supervisorPid: process.pid, status: 'starting', restarts: 0,
	ttlDeadline: spec.ttlSeconds > 0 ? new Date(Date.now() + spec.ttlSeconds * 1000).toISOString() : null };
let child = null;
let ttlFired = false;
let finished = false;

function writeState(patch) {
	state = { ...state, ...patch, generation: spec.generation, supervisorPid: process.pid, heartbeatAt: new Date().toISOString() };
	const tmp = `${statePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
	for (let i = 0; i < 5; i++) {
		try { fs.renameSync(tmp, statePath); return; } catch { /* 读者正占用：稍后再试 */ }
		const until = Date.now() + 50; while (Date.now() < until) { /* 短暂自旋 */ }
	}
	try { fs.copyFileSync(tmp, statePath); fs.rmSync(tmp, { force: true }); } catch { /* 下一次心跳再写 */ }
}

const stopRequested = () => fs.existsSync(stopPath);
// 另一次 start 换了 generation：本监管进程已过时，退出且不再写状态
function superseded() {
	try { return JSON.parse(fs.readFileSync(specPath, 'utf8')).generation !== spec.generation; } catch { return false; }
}

function appendLog(line) {
	try { fs.appendFileSync(logPath, line); } catch { /* 日志不可写不影响运行 */ }
}

function rotateLog() {
	try {
		if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`);
	} catch { /* 不存在或被占用 */ }
}

function launch() {
	if (finished) return;
	rotateLog();
	const cmdText = Array.isArray(spec.command) ? spec.command.join(' ') : spec.command;
	appendLog(`\n=== ${new Date().toISOString()} start #${state.restarts + 1}: ${cmdText} (cwd ${spec.cwd || dir}) ===\n`);
	let fd = null;
	try {
		fd = fs.openSync(logPath, 'a');
		const opts = { cwd: spec.cwd || undefined, env: { ...process.env, ...(spec.env || {}) },
			windowsHide: true, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32' };
		child = Array.isArray(spec.command)
			? spawn(spec.command[0], spec.command.slice(1), opts)
			: spawn(spec.command, { ...opts, shell: true });
	} catch (err) {
		if (fd != null) fs.closeSync(fd);
		appendLog(`=== spawn failed: ${err.message} ===\n`);
		writeState({ status: 'failed', pid: null, exitedAt: new Date().toISOString(), exitCode: null, lastError: err.message });
		return finish();
	}
	fs.closeSync(fd);   // 子进程已持有自己的句柄
	child.once('error', (err) => {
		appendLog(`=== spawn error: ${err.message} ===\n`);
		writeState({ status: 'failed', pid: null, exitedAt: new Date().toISOString(), exitCode: null, lastError: err.message });
		finish();
	});
	child.once('exit', onExit);
	if (child.pid) writeState({ status: 'running', pid: child.pid, startedAt: new Date().toISOString(), exitCode: null, exitedAt: null });
}

function onExit(code, signal) {
	const exitedAt = new Date().toISOString();
	appendLog(`=== ${exitedAt} exit code=${code}${signal ? ` signal=${signal}` : ''} ===\n`);
	child = null;
	if (finished || superseded()) return finish(false);
	if (stopRequested()) {
		writeState({ status: 'stopped', exitedAt, exitCode: code, signal: signal || null });
		return finish();
	}
	if (ttlFired) {
		writeState({ status: 'ttl_expired', exitedAt, exitCode: code, signal: signal || null });
		return finish();
	}
	const wantsRestart = spec.restart === 'always' || (spec.restart === 'on-failure' && code !== 0);
	if (wantsRestart && state.restarts < MAX_RESTARTS) {
		const delay = Math.min(60_000, BACKOFF_MS * 2 ** state.restarts);
		writeState({ status: 'restarting', restarts: state.restarts + 1, lastExit: { code, signal: signal || null, at: exitedAt },
			pid: null, nextStartAt: new Date(Date.now() + delay).toISOString() });
		setTimeout(launch, delay);
		return;
	}
	writeState({ status: code === 0 ? 'exited' : 'failed', exitedAt, exitCode: code, signal: signal || null, pid: null });
	finish();
}

function finish(clean = true) {
	if (finished) return;
	finished = true;
	clearInterval(heartbeat);
	clearTimeout(ttlTimer);
	if (clean) try { fs.rmSync(stopPath, { force: true }); } catch { /* ignore */ }
	setTimeout(() => process.exit(0), 50);
}

const heartbeat = setInterval(() => {
	if (finished) return;
	if (superseded()) {
		// 被新的 start 取代：子进程交由新一代处理（core.js 在 replace 时已结束它）
		if (child?.pid) void killTree(child.pid);
		return finish(false);
	}
	writeState({});
}, HEARTBEAT_MS);

let ttlTimer = null;
if (state.ttlDeadline) {
	ttlTimer = setTimeout(async () => {
		ttlFired = true;
		appendLog(`=== ${new Date().toISOString()} ttl ${spec.ttlSeconds}s reached: killing process tree ===\n`);
		if (child?.pid) await killTree(child.pid);
		else { writeState({ status: 'ttl_expired', exitedAt: new Date().toISOString() }); finish(); }
	}, spec.ttlSeconds * 1000);
}

writeState({});
launch();
