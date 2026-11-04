import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServiceManager, describe as describeService, tailFile } from '../integrations/pi-services/lib/core.js';
import { isAlive, killTree, portOpen } from '../integrations/pi-services/lib/platform.js';

const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';

function freshManager() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-services-'));
	return createServiceManager({ root });
}

async function freePort() {
	return new Promise((resolve) => {
		const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
	});
}

/** 收尾：结束测试里拉起的一切（服务、监管进程、自己 spawn 的进程） */
async function cleanup(m, extraPids = []) {
	for (const name of m.names()) {
		const st = await m.status(name, { probe: false });
		for (const pid of [st?.pid, st?.supervisorPid]) if (pid && isAlive(pid)) await killTree(pid);
	}
	for (const pid of extraPids) if (pid && isAlive(pid)) await killTree(pid);
	fs.rmSync(m.root, { recursive: true, force: true });
}

const httpServer = (port) => [NODE, '-e',
	`require('http').createServer((q,s)=>{console.log('req',q.url);s.end(q.url==='/healthz'?'ok':'hi')}).listen(${port},'127.0.0.1',()=>console.log('listening ${port}'))`];

test('作业：拉起即返回，等待拿到退出码与日志；秒退的作业在 start 里直接带回结果', async () => {
	const m = freshManager();
	try {
		const quick = await m.start({ name: 'quick', kind: 'job', command: [NODE, '-e', "console.log('hello job'); process.exit(3)"], ttlSeconds: 60 });
		assert.equal(quick.alive, false);
		assert.equal(quick.status, 'failed');
		assert.equal(quick.exitCode, 3);
		assert.match(quick.logTail, /hello job/);

		const slow = await m.start({ name: 'slow', kind: 'job', command: [NODE, '-e', "setTimeout(()=>{console.log('done');process.exit(0)},2500)"], ttlSeconds: 60 });
		assert.equal(slow.alive, true, '拉起后立即返回，不等作业结束');
		assert.equal(slow.ready, true);
		const waited = await m.wait('slow', { timeoutMs: 15000 });
		assert.equal(waited.done, true);
		assert.equal(waited.status, 'exited');
		assert.equal(waited.exitCode, 0);
		assert.match(waited.logTail, /done/);
		assert.match(m.logs('slow').text, /=== .* exit code=0 ===/);
		assert.throws(() => m.logs('nope'), /unknown service/);
		await assert.rejects(m.start({ name: 'unbounded', kind: 'job', command: [NODE, '-e', '1'], ttlSeconds: 0 }), /must be bounded/);
	} finally { await cleanup(m); }
});

test('服务：等端口与健康检查就绪；重复启动被拒；停止后端口关闭、进程树结束', async () => {
	const m = freshManager();
	const port = await freePort();
	try {
		const st = await m.start({ name: 'web', command: httpServer(port), port, healthUrl: `http://127.0.0.1:${port}/healthz`, description: 'demo' });
		assert.equal(st.ready, true, JSON.stringify(st));
		assert.equal(st.status, 'running');
		assert.equal(st.portOpen, true);
		assert.equal(st.health.ok, true);
		assert.ok(isAlive(st.pid) && isAlive(st.supervisorPid));
		assert.match(describeService(st), /● web · \[service\] · running · pid \d+ · :\d+ open · health 200/);

		await assert.rejects(m.start({ name: 'web', command: httpServer(port), port }), /already running/);
		await assert.rejects(m.start({ name: 'web2', command: httpServer(port), port }), /port \d+ is already in use/);

		const list = await m.list();
		assert.deepEqual(list.map((s) => s.name), ['web']);

		const stopped = await m.stop('web');
		assert.equal(stopped.stopped, true);
		assert.equal(stopped.status, 'stopped');
		assert.equal(await portOpen(port), false);
		assert.equal(isAlive(st.pid), false);
		assert.equal(isAlive(st.supervisorPid), false, '监管进程也退出了');
	} finally { await cleanup(m); }
});

test('TTL 到期结束整个进程树（作业有界，不会被遗忘在后台）', async () => {
	const m = freshManager();
	try {
		const st = await m.start({ name: 'probe', kind: 'job', command: [NODE, '-e', 'setInterval(()=>{},1000)'], ttlSeconds: 2 });
		assert.equal(st.alive, true);
		const end = await m.wait('probe', { timeoutMs: 15000 });
		assert.equal(end.done, true);
		assert.equal(end.status, 'ttl_expired');
		assert.equal(isAlive(st.pid), false);
		assert.match(m.logs('probe').text, /ttl 2s reached/);
	} finally { await cleanup(m); }
});

test('on-failure 重启：退避重试到上限后记为 failed；restart 重新拉起', async () => {
	const m = freshManager();
	try {
		const st = await m.start({ name: 'flaky', command: [NODE, '-e', "console.log('boom');process.exit(7)"], restart: 'on-failure',
			maxRestarts: 2, restartBackoffMs: 100, readyTimeoutMs: 1000 }, { readyTimeoutMs: 1000 });
		assert.equal(st.ready, false);
		const end = await m.wait('flaky', { until: 'exit', timeoutMs: 15000 });
		assert.equal(end.status, 'failed');
		assert.equal(end.restarts, 2);
		assert.equal(end.exitCode, 7);
		assert.equal(m.logs('flaky').text.split('\n').filter((l) => l.trim() === 'boom').length, 3, '首次 + 两次重启');
		const forgotten = await m.forget('flaky');
		assert.equal(forgotten.forgotten, true);
		assert.equal(await m.status('flaky'), null);
	} finally { await cleanup(m); }
});

test('接管已在运行的进程（按端口），按身份停止；之后 restart 改为受管运行', { skip: !IS_WIN && 'adopt 依赖 Windows 进程查询' }, async () => {
	const m = freshManager();
	const port = await freePort();
	const raw = spawn(httpServer(port)[0], httpServer(port).slice(1), { detached: true, windowsHide: true, stdio: 'ignore' });
	raw.unref();
	try {
		for (let i = 0; i < 40 && !(await portOpen(port)); i++) await new Promise((r) => setTimeout(r, 100));
		const st = await m.adopt({ name: 'legacy', port, cwd: os.tmpdir(), description: '别人拉起的服务' });
		assert.equal(st.source, 'adopted');
		assert.equal(st.status, 'running');
		assert.equal(st.pid, raw.pid);
		assert.equal(st.portOpen, true);
		await assert.rejects(m.adopt({ name: 'legacy', port }), /already registered/);

		const restarted = await m.restart('legacy');
		assert.equal(restarted.source, 'supervised', '重启后由监管进程托管');
		assert.equal(restarted.ready, true, JSON.stringify(restarted));
		assert.equal(isAlive(raw.pid), false, '原进程已结束');
		assert.notEqual(restarted.pid, raw.pid);
		await m.stop('legacy');
		assert.equal(await portOpen(port), false);
	} finally { await cleanup(m, [raw.pid]); }
});

test('名字校验与日志尾部截断', () => {
	const m = freshManager();
	try {
		assert.throws(() => m.paths('../x'), /invalid service name/);
		assert.throws(() => m.paths(''), /invalid service name/);
		const file = path.join(m.root, 'big.log');
		fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n') + '\n');
		const t = tailFile(file, { lines: 3 });
		assert.equal(t.text, 'line 4997\nline 4998\nline 4999');
		assert.equal(tailFile(file, { lines: 400, contains: 'line 42' }).text.split('\n').length, 111);
		assert.ok(tailFile(file, { lines: 4000, maxChars: 100 }).text.startsWith('…(前面已截断)'));
	} finally { fs.rmSync(m.root, { recursive: true, force: true }); }
});

// ---- Pi 接入层：用 Pi 安装目录里真实的 typebox 注册工具，按 schema 校验参数，再直接调用 execute ----
async function loadTypebox() {
	const releases = path.join(os.homedir(), '.pi', 'agent', 'install', 'releases');
	let dirs = [];
	try { dirs = fs.readdirSync(releases).map((v) => path.join(releases, v, 'node_modules', 'typebox')).filter((d) => fs.existsSync(d)); } catch { /* 未装 Pi */ }
	if (!dirs.length) return null;
	const { pathToFileURL } = await import('node:url');
	const base = dirs.at(-1);
	const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
	const entry = (key) => pathToFileURL(path.join(base, pkg.exports[key].import)).href;
	return { Type: (await import(entry('.'))).Type, Value: (await import(entry('./value'))).Value };
}

function fakePi() {
	const tools = new Map(), commands = new Map(), handlers = {};
	return { tools, commands, handlers,
		registerTool: (t) => tools.set(t.name, t),
		registerCommand: (n, c) => commands.set(n, c),
		on: (e, fn) => { (handlers[e] ||= []).push(fn); } };
}

function fakeCtx(cwd) {
	const ui = { notes: [], widgets: {}, statuses: {},
		notify: (m, t) => ui.notes.push([t, m]), setWidget: (k, v) => { ui.widgets[k] = v; }, setStatus: (k, v) => { ui.statuses[k] = v; },
		select: async (_title, options) => options[0], confirm: async () => true, theme: null };
	return { cwd, hasUI: true, ui, sessionManager: { getSessionId: () => 'session-test' } };
}

test('Pi 接入层：8 个工具的参数 schema 可用（真实 typebox 校验），工具结果精简，/services 面板与日志', async (t) => {
	const tb = await loadTypebox();
	if (!tb) return t.skip('本机未安装 Pi，跳过 typebox 校验');
	const { registerServices } = await import('../integrations/pi-services/lib/register.js');
	const m = freshManager();
	const pi = fakePi();
	try {
		registerServices(pi, tb.Type, { manager: m });
		assert.deepEqual([...pi.tools.keys()], ['service_start', 'service_list', 'service_wait', 'service_logs', 'service_stop',
			'service_restart', 'service_adopt', 'service_forget']);
		const start = pi.tools.get('service_start');
		const ok = { name: 'job1', kind: 'job', command: [NODE, '-e', "console.log('from tool')"], ttlSeconds: 60 };
		assert.equal(tb.Value.Check(start.parameters, ok), true, '数组命令通过校验');
		assert.equal(tb.Value.Check(start.parameters, { name: 'x', command: 'python -m http.server 9' }), true, '字符串命令通过校验');
		assert.equal(tb.Value.Check(start.parameters, { name: 'x' }), false, '缺 command 被拒');
		assert.equal(tb.Value.Check(start.parameters, { name: 'x', command: [] }), false, '空数组被拒');
		assert.equal(tb.Value.Check(pi.tools.get('service_wait').parameters, { name: 'x', timeoutSeconds: 600 }), false, '等待上限 55 秒');
		assert.ok(start.promptGuidelines?.length, 'service_start 带系统提示准则');
		assert.equal(pi.tools.get('service_list').annotations.readOnlyHint, true);

		const ctx = fakeCtx(m.root);
		const r1 = await start.execute('call-1', ok, undefined, undefined, ctx);
		assert.match(r1.content[0].text, /^(started|finished already \(exited, exit 0\))/);
		assert.equal(r1.details.createdBy?.sessionId, 'session-test', '记录是哪个会话启动的');
		const waited = await pi.tools.get('service_wait').execute('call-2', { name: 'job1', timeoutSeconds: 10 }, undefined, undefined, ctx);
		assert.match(waited.content[0].text, /^done\n✓ job1 · \[job\] · exited · exit 0/);
		assert.match(waited.content[0].text, /from tool/);
		const listed = await pi.tools.get('service_list').execute('call-3', {}, undefined, undefined, ctx);
		assert.match(listed.content[0].text, /job1/);
		const logs = await pi.tools.get('service_logs').execute('call-4', { name: 'job1', contains: 'from tool' }, undefined, undefined, ctx);
		assert.equal(logs.content[0].text.split('\n').at(-1), 'from tool');
		await assert.rejects(pi.tools.get('service_list').execute('call-5', { name: 'missing' }, undefined, undefined, ctx), /unknown service/);

		// /services：面板、日志面板、状态栏
		for (const fn of pi.handlers.session_start) await fn({}, ctx);
		const cmd = pi.commands.get('services');
		await cmd.handler('', ctx);
		assert.ok(ctx.ui.widgets['pi-services'].some((l) => l.includes('job1')), '面板列出服务');
		assert.equal(ctx.ui.statuses['pi-services'], '⚙ 服务 0', '状态栏：有登记但没有运行中的');
		await cmd.handler('logs job1 5', ctx);
		assert.ok(ctx.ui.widgets['pi-services-logs'].includes('from tool'));
		await cmd.handler('forget job1', ctx);
		assert.equal(await m.status('job1'), null);
		await cmd.handler('hide', ctx);
		assert.equal(ctx.ui.widgets['pi-services'], undefined);
		assert.deepEqual(cmd.getArgumentCompletions('re').map((c) => c.value), ['restart']);
		for (const fn of pi.handlers.session_shutdown) await fn({}, ctx);
	} finally {
		for (const fn of pi.handlers.session_shutdown || []) await fn({});
		await cleanup(m);
	}
});
