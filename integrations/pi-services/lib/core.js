// Pi 服务管理器：给常驻服务与后台作业一个有登记、可查、可停的家。
//
// 背景（2026-10-19 实测）：ChatGPT（Work 模式）经 Chappie 在 Pi 上用自写的 run_hidden.py 把工作台、评测服务
// 和几十个批处理作业以「隐藏 + 分离」方式拉起。Pi 只看到一条 `bash ... (no output)`，进程本身无人登记：
// 父进程退出后它们成了孤儿，用户和下一个 agent 都不知道谁在跑、端口归谁、日志在哪、该不该停。
//
// 每个服务一个目录 <root>/<name>/：
//   spec.json   启动规格（命令、目录、端口、健康检查、TTL、重启策略……），generation 区分每次启动
//   state.json  运行状态（由监管进程写；被接管的进程由本模块写）
//   out.log     子进程 stdout+stderr（超过上限轮转为 out.log.1）
//   stop        停止标记：监管进程看到后不再重启
// 两种来源：
//   supervised  经 supervisor.js 拉起，状态有心跳
//   adopted     接管已在运行的进程（按 PID 或端口），以 PID + 进程创建时刻防 PID 复用误杀
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as defaultPlatform from './platform.js';

export const SUPERVISOR = fileURLToPath(new URL('./supervisor.js', import.meta.url));
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEARTBEAT_STALE_MS = 35_000;
const RUNNING = new Set(['starting', 'running', 'restarting']);
const FINISHED_PRUNE_MS = 7 * 86400_000;

export function defaultRoot() {
	return process.env.PI_SERVICES_HOME || path.join(os.homedir(), '.pi', 'agent', 'services');
}

function defaultNode() {
	return /(^|[\\/])node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node';
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	try { fs.renameSync(tmp, file); } catch { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); }
}

export function validateName(name) {
	if (typeof name !== 'string' || !NAME_RE.test(name)) {
		throw new Error(`invalid service name ${JSON.stringify(name)}: use 1-64 of [A-Za-z0-9._-], starting with a letter or digit`);
	}
	return name;
}

/** 读文件尾部若干行（只读最后一段，不整读大日志） */
export function tailFile(file, { lines = 60, maxChars = 12000, contains = null } = {}) {
	let fd;
	try {
		fd = fs.openSync(file, 'r');
		const size = fs.fstatSync(fd).size;
		const want = Math.min(size, contains ? 2 * 1024 * 1024 : Math.max(64 * 1024, lines * 400));
		const buf = Buffer.alloc(want);
		fs.readSync(fd, buf, 0, want, size - want);
		let text = buf.toString('utf8');
		if (want < size) text = text.slice(text.indexOf('\n') + 1);   // 丢掉被截断的首行
		let all = text.split(/\r?\n/);
		if (all.at(-1) === '') all.pop();
		if (contains) all = all.filter((l) => l.includes(contains));
		let out = all.slice(-lines).join('\n');
		if (out.length > maxChars) out = `…(前面已截断)\n${out.slice(-maxChars)}`;
		return { text: out, totalBytes: size, truncated: want < size || all.length > lines };
	} catch {
		return { text: '', totalBytes: 0, truncated: false };
	} finally {
		if (fd != null) fs.closeSync(fd);
	}
}

export function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '—';
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
	if (d) return `${d}d${h}h`;
	if (h) return `${h}h${String(m).padStart(2, '0')}m`;
	if (m) return `${m}m${String(s % 60).padStart(2, '0')}s`;
	return `${s}s`;
}

export function createServiceManager({ root = defaultRoot(), platform = defaultPlatform, nodePath = defaultNode(),
	supervisorPath = SUPERVISOR, now = () => Date.now() } = {}) {
	const paths = (name) => {
		const dir = path.join(root, validateName(name));
		return { dir, spec: path.join(dir, 'spec.json'), state: path.join(dir, 'state.json'),
			log: path.join(dir, 'out.log'), stop: path.join(dir, 'stop') };
	};
	const load = (name) => {
		const p = paths(name);
		return { p, spec: readJson(p.spec), state: readJson(p.state) };
	};

	function names() {
		try {
			return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name);
		} catch { return []; }
	}

	/**
	 * 当前状态。probe=true 时额外检查端口、健康检查，以及（监管进程已失联时）进程身份；
	 * probe=false 只看 PID/心跳，适合状态栏这类高频刷新。
	 */
	async function status(name, { probe = true } = {}) {
		const { p, spec, state } = load(name);
		if (!spec) return null;
		const t = now();
		const s = state || {};
		let status = s.status || 'unknown';
		let pid = Number.isInteger(s.pid) ? s.pid : null;
		const note = [];
		if (spec.adopted) {
			if (status === 'running') {
				let alive = platform.isAlive(pid);
				if (alive && probe && s.adopted?.createdAt) {
					const info = await platform.queryProcess(pid);
					if (!info || info.createdAt !== s.adopted.createdAt) { alive = false; note.push('PID 已被其他进程复用'); }
				}
				if (!alive) status = 'dead';
			}
		} else if (RUNNING.has(status)) {
			const heartbeatAge = s.heartbeatAt ? t - Date.parse(s.heartbeatAt) : Infinity;
			const supervisorAlive = platform.isAlive(s.supervisorPid) && heartbeatAge < HEARTBEAT_STALE_MS;
			// 刚写下 starting、监管进程还没来得及报到：给它一点时间
			const justCreated = status === 'starting' && !s.supervisorPid && spec.createdAt && t - Date.parse(spec.createdAt) < 15_000;
			if (!supervisorAlive && !justCreated) {
				// 监管进程失联：子进程可能还在（孤儿），也可能 PID 已复用
				let childAlive = platform.isAlive(pid);
				if (childAlive && probe) {
					const info = await platform.queryProcess(pid);
					const exe = Array.isArray(spec.command) ? path.basename(spec.command[0]).toLowerCase() : null;
					if (!info || (exe && !String(info.commandLine || '').toLowerCase().includes(exe.replace(/\.exe$/, '')))) childAlive = false;
				}
				status = childAlive ? 'orphaned' : 'dead';
				note.push('监管进程已不在');
			}
		}
		const alive = ['running', 'orphaned', 'starting', 'restarting'].includes(status);
		const out = {
			name, kind: spec.kind || 'service', source: spec.adopted ? 'adopted' : 'supervised', status, alive,
			pid: alive ? pid : null, supervisorPid: spec.adopted ? null : (s.supervisorPid ?? null),
			port: spec.port ?? null, healthUrl: spec.healthUrl ?? null, cwd: spec.cwd ?? null,
			command: spec.command, description: spec.description || '',
			startedAt: s.startedAt ?? null, exitedAt: s.exitedAt ?? null, exitCode: s.exitCode ?? null,
			restarts: s.restarts ?? 0, ttlDeadline: s.ttlDeadline ?? null,
			createdBy: spec.createdBy ?? null, createdAt: spec.createdAt ?? null, logPath: p.log, note,
		};
		if (out.startedAt && alive) out.uptimeMs = t - Date.parse(out.startedAt);
		if (out.ttlDeadline && alive) out.ttlRemainingMs = Date.parse(out.ttlDeadline) - t;
		if (probe && alive) {
			if (spec.port) out.portOpen = await platform.portOpen(spec.port);
			if (spec.healthUrl) out.health = await platform.httpCheck(spec.healthUrl);
		}
		return out;
	}

	async function list({ probe = true, includeFinished = true } = {}) {
		const out = [];
		for (const name of names()) {
			const st = await status(name, { probe });
			if (!st) continue;
			// 结束超过 7 天的一次性作业自动清掉，免得登记表越积越多
			if (!st.alive && st.kind === 'job' && st.exitedAt && now() - Date.parse(st.exitedAt) > FINISHED_PRUNE_MS) {
				fs.rmSync(paths(name).dir, { recursive: true, force: true });
				continue;
			}
			if (includeFinished || st.alive) out.push(st);
		}
		const order = (s) => (s.alive ? 0 : 1);
		return out.sort((a, b) => order(a) - order(b) || String(b.startedAt || b.createdAt).localeCompare(String(a.startedAt || a.createdAt)));
	}

	function normalizeSpec(input) {
		const name = validateName(input.name);
		const kind = input.kind === 'job' ? 'job' : 'service';
		let command = input.command;
		if (typeof command === 'string') {
			if (!command.trim()) throw new Error('command is empty');
		} else if (Array.isArray(command) && command.length && command.every((c) => typeof c === 'string')) {
			command = [...command];
		} else {
			throw new Error('command must be a non-empty string (run through the shell) or an array [executable, ...args]');
		}
		const restart = input.restart ?? (kind === 'job' ? 'no' : 'on-failure');
		if (!['no', 'on-failure', 'always'].includes(restart)) throw new Error('restart must be no | on-failure | always');
		const ttlSeconds = input.ttlSeconds ?? (kind === 'job' ? 6 * 3600 : 0);
		if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 30 * 86400) throw new Error('ttlSeconds must be an integer 0..2592000');
		if (kind === 'job' && ttlSeconds === 0) throw new Error('jobs must be bounded: ttlSeconds > 0');
		const port = input.port ?? null;
		if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('port must be 1..65535');
		if (input.cwd != null && !fs.existsSync(input.cwd)) throw new Error(`cwd does not exist: ${input.cwd}`);
		if (input.env != null && (typeof input.env !== 'object' || Object.values(input.env).some((v) => typeof v !== 'string'))) {
			throw new Error('env must be an object of string values');
		}
		return { name, kind, command, cwd: input.cwd ?? null, env: input.env ?? null, port,
			healthUrl: input.healthUrl ?? (port && input.healthPath ? `http://127.0.0.1:${port}${input.healthPath}` : null),
			ttlSeconds, restart, maxRestarts: input.maxRestarts ?? 5, restartBackoffMs: input.restartBackoffMs ?? undefined,
			description: input.description ? String(input.description).slice(0, 300) : '', createdBy: input.createdBy ?? null };
	}

	async function isReady(name, kind, spec) {
		const st = await status(name);
		if (!st) return { done: true, st: null };
		if (!st.alive) return { done: true, st };
		if (kind === 'job') return { done: st.status === 'running', st };
		if (st.status !== 'running') return { done: false, st };
		if (spec.port && !st.portOpen) return { done: false, st };
		if (spec.healthUrl && !st.health?.ok) return { done: false, st };
		return { done: true, st };
	}

	/** 启动并等待就绪（服务：端口/健康检查通过；作业：子进程已拉起） */
	async function start(input, { replace = false, readyTimeoutMs = 20_000 } = {}) {
		const spec = normalizeSpec(input);
		const existing = await status(spec.name, { probe: false });
		if (existing?.alive) {
			if (!replace) throw new Error(`${spec.name} is already ${existing.status} (pid ${existing.pid}); use service_restart, or service_start with replace=true`);
			await stop(spec.name);
		}
		if (spec.port && await platform.portOpen(spec.port)) {
			const owner = await platform.findListeningPid(spec.port);
			throw new Error(`port ${spec.port} is already in use${owner ? ` by PID ${owner}` : ''}; stop it or take it over with service_adopt`);
		}
		const p = paths(spec.name);
		fs.mkdirSync(p.dir, { recursive: true });
		fs.rmSync(p.stop, { force: true });
		const full = { ...spec, generation: randomUUID(), createdAt: new Date(now()).toISOString() };
		writeJson(p.spec, full);
		writeJson(p.state, { generation: full.generation, status: 'starting', restarts: 0 });
		const sup = spawn(nodePath, [supervisorPath, p.spec], { cwd: p.dir, detached: true, windowsHide: true, stdio: 'ignore' });
		sup.unref();
		const started = now();
		// 作业：拉起后再看 1.5 秒，秒退的作业直接带回结果；服务：就绪后至少稳定 1 秒，避免拉起即崩被当成就绪
		const settleMs = spec.kind === 'job' ? 1500 : 1000;
		let res;
		for (;;) {
			res = await isReady(spec.name, spec.kind, full);
			const waited = now() - started;
			if (res.st && !res.st.alive) break;                         // 已退出或失败
			if (res.done && waited >= settleMs) break;
			if (waited >= readyTimeoutMs) break;
			await defaultPlatform.sleep(250);
		}
		const st = res.st || await status(spec.name);
		const ready = !!st?.alive && res.done;
		return { ...st, ready, waitedMs: now() - started,
			logTail: st && (!st.alive || !ready) ? tailFile(p.log, { lines: 30, maxChars: 4000 }).text : undefined };
	}

	async function stop(name, { reason = 'stopped by request' } = {}) {
		const { p, spec, state } = load(name);
		if (!spec) throw new Error(`unknown service ${name}`);
		const st = await status(name);
		if (!st.alive) return { ...st, stopped: false, message: `${name} is not running (${st.status})` };
		if (spec.adopted) {
			if (st.status === 'dead') return { ...st, stopped: false };
			const ok = await platform.killTree(st.pid);
			writeJson(p.state, { ...state, status: ok ? 'stopped' : state.status, exitedAt: new Date(now()).toISOString(), stopReason: reason });
			return { ...(await status(name, { probe: false })), stopped: ok };
		}
		fs.writeFileSync(p.stop, reason);
		if (st.pid) await platform.killTree(st.pid);
		// 监管进程看到 stop 标记后会写 stopped 并退出；等它一会儿，不退出就结束它
		for (let i = 0; i < 20 && platform.isAlive(state?.supervisorPid); i++) await defaultPlatform.sleep(150);
		if (platform.isAlive(state?.supervisorPid)) await platform.killTree(state.supervisorPid);
		const after = readJson(p.state) || {};
		if (!['stopped', 'exited', 'failed', 'ttl_expired'].includes(after.status)) {
			writeJson(p.state, { ...after, status: 'stopped', pid: null, exitedAt: new Date(now()).toISOString(), stopReason: reason });
		}
		fs.rmSync(p.stop, { force: true });
		const final = await status(name, { probe: false });
		return { ...final, stopped: !final.alive };
	}

	async function restart(name, { readyTimeoutMs } = {}) {
		const { spec } = load(name);
		if (!spec) throw new Error(`unknown service ${name}`);
		if (spec.adopted && !spec.cwd) {
			throw new Error(`${name} was adopted without cwd; adopt again with cwd (and command) before restarting`);
		}
		await stop(name, { reason: 'restart' });
		const { adopted, generation, createdAt, ...rest } = spec;
		return start({ ...rest, restart: rest.restart ?? 'on-failure' }, { readyTimeoutMs });
	}

	/** 等待作业结束或服务就绪；超时返回当前状态（不阻塞调用方太久） */
	async function wait(name, { timeoutMs = 30_000, until = null } = {}) {
		const { spec } = load(name);
		if (!spec) throw new Error(`unknown service ${name}`);
		const target = until || (spec.kind === 'job' ? 'exit' : 'ready');
		const started = now();
		let st;
		for (;;) {
			st = target === 'exit' ? await status(name, { probe: false }) : (await isReady(name, spec.kind, spec)).st;
			const done = target === 'exit' ? !st.alive : (!st.alive || (st.status === 'running'
				&& (!spec.port || st.portOpen) && (!spec.healthUrl || st.health?.ok)));
			if (done || now() - started >= timeoutMs) {
				const full = target === 'exit' ? await status(name) : st;
				return { ...full, done, waitedMs: now() - started,
					logTail: tailFile(paths(name).log, { lines: done ? 20 : 8, maxChars: 3000 }).text };
			}
			await defaultPlatform.sleep(500);
		}
	}

	function logs(name, opts = {}) {
		const { p, spec } = load(name);
		if (!spec) throw new Error(`unknown service ${name}`);
		if (spec.adopted && !fs.existsSync(p.log)) {
			return { name, logPath: spec.logPath || null, text: '', note: 'adopted process: its output is not captured here' + (spec.logPath ? `; see ${spec.logPath}` : '') };
		}
		return { name, logPath: p.log, ...tailFile(p.log, opts) };
	}

	/** 接管已在运行的进程（按 PID 或端口）。记录创建时刻，之后防止 PID 复用误杀。 */
	async function adopt({ name, pid = null, port = null, command = null, cwd = null, healthUrl = null, description = '', logPath = null, createdBy = null }) {
		validateName(name);
		const existing = await status(name, { probe: false });
		if (existing?.alive) throw new Error(`${name} is already registered and ${existing.status}`);
		let target = pid;
		if (!target && port) target = await platform.findListeningPid(port);
		if (!target) throw new Error(port ? `nothing is listening on port ${port}` : 'pid or port is required');
		const info = await platform.queryProcess(target);
		if (!info) throw new Error(`process ${target} not found`);
		const p = paths(name);
		fs.mkdirSync(p.dir, { recursive: true });
		const spec = { name, kind: 'service', adopted: true, command: command || info.commandLine, cwd, port, healthUrl,
			restart: 'on-failure', ttlSeconds: 0, description: String(description || '').slice(0, 300), logPath,
			generation: randomUUID(), createdAt: new Date(now()).toISOString(), createdBy };
		writeJson(p.spec, spec);
		writeJson(p.state, { generation: spec.generation, status: 'running', pid: info.pid, startedAt: info.createdAt,
			adopted: { pid: info.pid, createdAt: info.createdAt, commandLine: info.commandLine, parentPid: info.parentPid } });
		return status(name);
	}

	async function forget(name) {
		const st = await status(name, { probe: false });
		if (!st) throw new Error(`unknown service ${name}`);
		if (st.alive) throw new Error(`${name} is ${st.status}; stop it first`);
		fs.rmSync(paths(name).dir, { recursive: true, force: true });
		return { name, forgotten: true };
	}

	return { root, names, status, list, start, stop, restart, wait, logs, adopt, forget, paths };
}

/** 一行人读摘要（工具结果、/services 面板共用） */
export function describe(st, t = Date.now()) {
	if (!st) return '';
	const mark = st.alive ? (st.status === 'orphaned' ? '◐' : '●') : (st.status === 'exited' ? '✓' : '○');
	const parts = [`${mark} ${st.name}`, `[${st.kind}${st.source === 'adopted' ? ', adopted' : ''}]`, st.status];
	if (st.alive && st.pid) parts.push(`pid ${st.pid}`);
	if (st.port) parts.push(`:${st.port}${st.portOpen === true ? ' open' : st.portOpen === false ? ' closed' : ''}`);
	if (st.health) parts.push(`health ${st.health.ok ? st.health.status : `✗${st.health.status ?? st.health.error ?? ''}`}`);
	if (st.alive && st.uptimeMs != null) parts.push(`up ${formatDuration(st.uptimeMs)}`);
	if (!st.alive && st.exitCode != null) parts.push(`exit ${st.exitCode}`);
	if (!st.alive && st.exitedAt) parts.push(`${formatDuration(t - Date.parse(st.exitedAt))} ago`);
	if (st.restarts) parts.push(`restarts ${st.restarts}`);
	if (st.ttlRemainingMs != null) parts.push(`ttl ${formatDuration(st.ttlRemainingMs)}`);
	let line = parts.join(' · ');
	if (st.description) line += ` — ${st.description}`;
	if (st.note?.length) line += ` (${st.note.join('; ')})`;
	return line;
}
