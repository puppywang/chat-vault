// Pi 接入层：service_* 工具（Pi 模型与经 Chappie 的 ChatGPT 共用）、/services 命令、状态栏与面板。
// TypeBox 由入口文件传入（Pi 提供宿主包 typebox），本文件不 import 任何 Pi 包，便于单测。
import { createServiceManager, describe, formatDuration } from './core.js';

const MAX_TEXT = 9000;               // Chappie 会截断超过 10k token 的结果；工具结果保持精简
const STATUS_KEY = 'pi-services';
const WIDGET_KEY = 'pi-services';
const LOG_WIDGET_KEY = 'pi-services-logs';
const REFRESH_MS = 20_000;

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…(truncated; use service_logs with contains/lines or read the logPath)` : text);
const result = (text, details) => ({ content: [{ type: 'text', text: clip(text) }], details });

function summary(st, extra = []) {
	const lines = [describe(st)];
	if (st.logPath) lines.push(`log: ${st.logPath}`);
	if (st.healthUrl) lines.push(`health url: ${st.healthUrl}`);
	lines.push(...extra);
	return lines.join('\n');
}

export function registerServices(pi, Type, { manager = createServiceManager() } = {}) {
	const S = (opts) => Type.String(opts);
	const Int = (opts) => Type.Integer(opts);
	const name = S({ description: 'Service name: 1-64 of [A-Za-z0-9._-], e.g. "gt-workbench", "publish-v5-job"' });
	const createdBy = (ctx) => {
		try { return { sessionId: ctx?.sessionManager?.getSessionId?.() ?? null, cwd: ctx?.cwd ?? null, via: 'pi-services' }; }
		catch { return null; }
	};

	const tools = [
		{
			name: 'service_start',
			label: 'Start service',
			description: 'Start a long-running service or a bounded background job on this machine: hidden (no window), detached from the Pi session, '
				+ 'registered by name, output captured to a log. Use this instead of `bash` with start/nohup/pythonw/run_hidden-style launchers for anything '
				+ 'that must keep running after the call returns (web servers, review workbenches, queues, batch jobs, probes). '
				+ 'kind="service" waits until the process is running and, if given, `port` accepts connections and `healthUrl` answers 2xx/3xx. '
				+ 'kind="job" returns right after launch (quick exits are reported directly); poll with service_wait, read output with service_logs. '
				+ 'Jobs must be bounded: ttlSeconds defaults to 21600 (6 h) and the whole process tree is killed when it expires. '
				+ 'Services restart on failure (exponential backoff, maxRestarts). Fails if the name is already running (pass replace=true to restart it) '
				+ 'or the port is taken (see service_list / service_adopt).',
			parameters: Type.Object({
				name,
				command: Type.Union([S({ description: 'Command line run through the shell' }),
					Type.Array(Type.String(), { minItems: 1, description: '[executable, ...args] (preferred: no shell quoting issues)' })]),
				kind: Type.Optional(S({ enum: ['service', 'job'], description: 'service (default): long-running; job: runs to completion' })),
				cwd: Type.Optional(S({ description: 'Working directory (default: the Pi session cwd)' })),
				env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Extra environment variables' })),
				port: Type.Optional(Int({ minimum: 1, maximum: 65535, description: 'TCP port the service listens on (127.0.0.1)' })),
				healthUrl: Type.Optional(S({ description: 'HTTP URL that answers 2xx/3xx when the service is healthy' })),
				ttlSeconds: Type.Optional(Int({ minimum: 0, description: 'Kill the process tree after this many seconds (0 = never; jobs require > 0, default 21600)' })),
				restart: Type.Optional(S({ enum: ['no', 'on-failure', 'always'], description: 'Restart policy (service default on-failure, job default no)' })),
				maxRestarts: Type.Optional(Int({ minimum: 0, maximum: 50 })),
				readyTimeoutSeconds: Type.Optional(Int({ minimum: 1, maximum: 120, description: 'How long to wait for readiness (default 20)' })),
				replace: Type.Optional(Type.Boolean({ description: 'Stop a running service with the same name first' })),
				description: Type.Optional(S({ description: 'What this is for, shown to the user in /services' })),
			}),
			executionMode: 'sequential',
			async execute(_id, p, _signal, _onUpdate, ctx) {
				const st = await manager.start({ ...p, cwd: p.cwd ?? ctx?.cwd ?? undefined, createdBy: createdBy(ctx) },
					{ replace: !!p.replace, readyTimeoutMs: (p.readyTimeoutSeconds ?? 20) * 1000 });
				const head = st.kind === 'job' && !st.alive
					? `finished already (${st.status}${st.exitCode != null ? `, exit ${st.exitCode}` : ''})`
					: st.ready ? (st.kind === 'job' ? 'started' : 'ready')
						: st.alive ? `not ready after ${formatDuration(st.waitedMs)} (still ${st.status})` : `exited during startup (${st.status})`;
				const extra = st.logTail ? ['--- log tail ---', st.logTail] : [];
				if (st.kind === 'job' && st.alive) extra.push('Poll with service_wait; read output with service_logs.');
				return result(`${head}\n${summary(st, extra)}`, st);
			},
		},
		{
			name: 'service_list',
			label: 'List services',
			description: 'List registered services and jobs with status, PID, port/health checks, uptime, exit code, TTL and log path. '
				+ 'Check this before starting a server on a port, and to find what earlier agents left running.',
			parameters: Type.Object({
				name: Type.Optional(S({ description: 'Only this service' })),
				running: Type.Optional(Type.Boolean({ description: 'Only running ones' })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				if (p.name) {
					const st = await manager.status(p.name);
					if (!st) throw new Error(`unknown service ${p.name}`);
					return result(summary(st), st);
				}
				const all = await manager.list({ includeFinished: !p.running });
				const shown = all.slice(0, 40);
				const text = shown.length ? shown.map((s) => describe(s)).join('\n') : 'No services registered.';
				return result(all.length > shown.length ? `${text}\n…and ${all.length - shown.length} more (finished jobs)` : text, { services: shown });
			},
		},
		{
			name: 'service_wait',
			label: 'Wait for service',
			description: 'Wait (at most timeoutSeconds, max 55) until a job exits or a service becomes ready, then report status, exit code and the last log lines. '
				+ 'Returns early with done=false on timeout; call again to keep waiting. Use this to poll background jobs instead of reading status files.',
			parameters: Type.Object({
				name,
				timeoutSeconds: Type.Optional(Int({ minimum: 1, maximum: 55, description: 'Default 30' })),
				until: Type.Optional(S({ enum: ['exit', 'ready'], description: 'Default: exit for jobs, ready for services' })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const st = await manager.wait(p.name, { timeoutMs: (p.timeoutSeconds ?? 30) * 1000, until: p.until });
				const head = st.done ? 'done' : `still ${st.status} after ${formatDuration(st.waitedMs)}`;
				return result(`${head}\n${summary(st, st.logTail ? ['--- log tail ---', st.logTail] : [])}`, st);
			},
		},
		{
			name: 'service_logs',
			label: 'Service logs',
			description: 'Read the end of a service/job log (stdout+stderr). Output is capped; use `contains` to filter lines, or read logPath directly in slices for more.',
			parameters: Type.Object({
				name,
				lines: Type.Optional(Int({ minimum: 1, maximum: 400, description: 'Default 60' })),
				contains: Type.Optional(S({ description: 'Only lines containing this text' })),
			}),
			annotations: { readOnlyHint: true },
			async execute(_id, p) {
				const r = manager.logs(p.name, { lines: p.lines ?? 60, contains: p.contains ?? null });
				const header = `log: ${r.logPath ?? '(not captured)'}${r.totalBytes != null ? ` · ${r.totalBytes} bytes` : ''}${r.truncated ? ' · showing tail' : ''}`;
				return result([header, r.note, r.text || '(empty)'].filter(Boolean).join('\n'), { name: p.name, logPath: r.logPath, totalBytes: r.totalBytes });
			},
		},
		{
			name: 'service_stop',
			label: 'Stop service',
			description: 'Stop a service or job: kills its whole process tree, confirms it exited, and disables restarts. Adopted processes are verified by PID and start time before killing.',
			parameters: Type.Object({ name }),
			executionMode: 'sequential',
			annotations: { destructiveHint: true },
			async execute(_id, p) {
				const st = await manager.stop(p.name);
				return result(`${st.stopped ? 'stopped' : st.message || 'not stopped'}\n${summary(st)}`, st);
			},
		},
		{
			name: 'service_restart',
			label: 'Restart service',
			description: 'Stop and start a service again with its registered command, cwd, port and health check. An adopted process becomes supervised (needs cwd recorded at adoption).',
			parameters: Type.Object({ name, readyTimeoutSeconds: Type.Optional(Int({ minimum: 1, maximum: 120 })) }),
			executionMode: 'sequential',
			async execute(_id, p) {
				const st = await manager.restart(p.name, { readyTimeoutMs: (p.readyTimeoutSeconds ?? 20) * 1000 });
				return result(`${st.ready ? 'restarted' : `restart not ready (${st.status})`}\n${summary(st, st.logTail ? ['--- log tail ---', st.logTail] : [])}`, st);
			},
		},
		{
			name: 'service_adopt',
			label: 'Adopt process',
			description: 'Register an already-running process (found by pid or by the port it listens on) so it can be listed, health-checked, stopped and restarted. '
				+ 'Pass cwd (and optionally command, healthUrl, logPath) so service_restart can relaunch it under supervision.',
			parameters: Type.Object({
				name,
				pid: Type.Optional(Int({ minimum: 1 })),
				port: Type.Optional(Int({ minimum: 1, maximum: 65535 })),
				command: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], { description: 'Command for restarts (default: the process command line)' })),
				cwd: Type.Optional(S()),
				healthUrl: Type.Optional(S()),
				logPath: Type.Optional(S({ description: 'Where this process writes its own log, if anywhere' })),
				description: Type.Optional(S()),
			}),
			executionMode: 'sequential',
			async execute(_id, p, _signal, _onUpdate, ctx) {
				const st = await manager.adopt({ ...p, createdBy: createdBy(ctx) });
				return result(`adopted\n${summary(st)}`, st);
			},
		},
		{
			name: 'service_forget',
			label: 'Forget service',
			description: 'Remove a stopped or finished service/job from the registry, including its captured log. Refuses while it is running.',
			parameters: Type.Object({ name }),
			executionMode: 'sequential',
			async execute(_id, p) {
				return result(`forgot ${p.name}`, await manager.forget(p.name));
			},
		},
	];

	for (const tool of tools) {
		pi.registerTool({
			...tool,
			promptGuidelines: tool.name === 'service_start' ? [
				'Launch servers and background jobs with service_start (not bash with start/nohup/pythonw); give jobs a ttlSeconds bound.',
				'Check service_list before starting a server on a port; stop what you started when it is no longer needed.',
			] : undefined,
		});
	}

	// ---- 给人看的：/services 命令、状态栏、常驻面板 ----
	let uiCtx = null;
	let timer = null;
	let panelVisible = false;

	async function refresh(ctx = uiCtx) {
		if (!ctx?.hasUI) return;
		const all = await manager.list({ probe: panelVisible });
		const running = all.filter((s) => s.alive);
		const theme = ctx.ui.theme;
		const label = running.length ? `⚙ 服务 ${running.length}` : (all.length ? '⚙ 服务 0' : undefined);
		const orphaned = running.filter((s) => s.status === 'orphaned').length;
		ctx.ui.setStatus(STATUS_KEY, label && theme ? theme.fg(orphaned ? 'warning' : 'dim', label + (orphaned ? `（${orphaned} 失去监管）` : '')) : label);
		if (panelVisible) {
			const lines = all.slice(0, 15).map((s) => describe(s));
			ctx.ui.setWidget(WIDGET_KEY, ['服务（/services hide 关闭 · stop|restart|logs|forget <名字>）', ...(lines.length ? lines : ['（还没有登记的服务）'])]);
		}
	}

	pi.on('session_start', async (_event, ctx) => {
		if (!ctx.hasUI) return;
		uiCtx = ctx;
		clearInterval(timer);
		timer = setInterval(() => { void refresh().catch(() => {}); }, REFRESH_MS);
		await refresh(ctx).catch(() => {});
	});
	pi.on('session_shutdown', async () => {
		clearInterval(timer);
		timer = null;
		uiCtx = null;
		panelVisible = false;
	});
	// 模型或 ChatGPT 动了服务：立刻刷新状态栏/面板
	pi.on('tool_result', async (event) => {
		if (String(event?.toolName || '').startsWith('service_')) void refresh().catch(() => {});
	});

	async function pick(ctx, filter, title) {
		const candidates = (await manager.list({ probe: false })).filter(filter).map((s) => s.name);
		if (!candidates.length) { ctx.ui.notify('没有可选的服务', 'info'); return null; }
		return ctx.hasUI ? ctx.ui.select(title, candidates) : null;
	}

	pi.registerCommand('services', {
		description: '查看和管理后台服务：/services [show|hide|stop|restart|logs|forget] [名字]',
		getArgumentCompletions: (prefix) => {
			const [sub = '', arg] = String(prefix).split(/\s+/);
			const subs = ['show', 'hide', 'stop', 'restart', 'logs', 'forget'];
			if (arg === undefined) return subs.filter((s) => s.startsWith(sub)).map((s) => ({ value: s, label: s }));
			return manager.names().filter((n) => n.startsWith(arg)).map((n) => ({ value: `${sub} ${n}`, label: n }));
		},
		handler: async (args, ctx) => {
			const [sub = 'show', target, extra] = String(args || '').trim().split(/\s+/).filter(Boolean);
			uiCtx = ctx.hasUI ? ctx : uiCtx;
			try {
				switch (sub) {
					case 'show':
					case 'list': {
						panelVisible = true;
						await refresh(ctx);
						const running = (await manager.list({ probe: false })).filter((s) => s.alive).length;
						ctx.ui.notify(`${running} 个服务在运行；面板每 ${REFRESH_MS / 1000} 秒刷新`, 'info');
						return;
					}
					case 'hide':
						panelVisible = false;
						ctx.ui.setWidget(WIDGET_KEY, undefined);
						ctx.ui.setWidget(LOG_WIDGET_KEY, undefined);
						return;
					case 'stop':
					case 'restart': {
						const name = target || await pick(ctx, (s) => s.alive || sub === 'restart', sub === 'stop' ? '停止哪个服务？' : '重启哪个服务？');
						if (!name) return;
						const st = await manager.status(name);
						if (!st) { ctx.ui.notify(`没有名为 ${name} 的服务`, 'error'); return; }
						if (ctx.hasUI && !(await ctx.ui.confirm(sub === 'stop' ? '停止服务' : '重启服务', describe(st)))) return;
						const r = sub === 'stop' ? await manager.stop(name) : await manager.restart(name);
						ctx.ui.notify(describe(r), r.alive === (sub === 'restart') ? 'info' : 'warning');
						break;
					}
					case 'logs': {
						const name = target || await pick(ctx, () => true, '查看哪个服务的日志？');
						if (!name) return;
						const n = Math.min(80, Number(extra) || 20);
						const r = manager.logs(name, { lines: n, maxChars: 6000 });
						ctx.ui.setWidget(LOG_WIDGET_KEY, [`${name} · ${r.logPath ?? ''}（/services hide 关闭）`, ...String(r.note || r.text || '(空)').split('\n')]);
						return;
					}
					case 'forget': {
						const name = target || await pick(ctx, (s) => !s.alive, '移除哪个已结束的登记？');
						if (!name) return;
						await manager.forget(name);
						ctx.ui.notify(`已移除 ${name}`, 'info');
						break;
					}
					default:
						ctx.ui.notify('用法：/services [show|hide|stop|restart|logs|forget] [名字]', 'warning');
						return;
				}
				await refresh(ctx);
			} catch (err) {
				ctx.ui.notify(String(err?.message || err), 'error');
			}
		},
	});

	return { manager, tools: tools.map((t) => t.name), refresh };
}
