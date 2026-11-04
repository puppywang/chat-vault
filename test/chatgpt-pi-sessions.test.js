import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPiSessionManager, connectText, defaultSessionName, findSessionProcesses, readSessionHeader } from '../src/pi-sessions.js';

const ID = '7b8a2c4e-1d9f-4a3b-9c5e-864130c30bc6';
const OTHER = '01a11aa6-3263-7209-8bb0-415fb36dfab0';

/** 临时 home：~/.pi/agent/sessions、chappie.sessions.json、~/.chat-vault/pi-sessions.json 都落在里面 */
function home({ brokerPid = process.pid, brokerSessions = null, registry = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-pi-'));
  const proj = path.join(dir, 'proj');
  const other = path.join(dir, 'other');
  fs.mkdirSync(proj); fs.mkdirSync(other);
  const sessionsRoot = path.join(dir, '.pi', 'agent', 'sessions');
  const enc = p => `--${p.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  for (const [cwd, id, when] of [[proj, OTHER, '2026-10-08T08-34-21-923Z'], [other, 'aaaa', '2026-09-01T00-00-00-000Z']]) {
    const d = path.join(sessionsRoot, enc(cwd)); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${when}_${id}.jsonl`), `${JSON.stringify({ type: 'session', version: 3, id, timestamp: when, cwd })}\n{"type":"message"}\n`);
  }
  fs.mkdirSync(path.join(dir, '.pi', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pi', 'bin', 'pi.cmd'), '@echo off\r\n');
  if (brokerSessions) fs.writeFileSync(path.join(dir, '.pi', 'agent', 'chappie.sessions.json'),
    JSON.stringify({ version: 1, updatedAt: '2026-10-11T00:00:00.000Z', broker: { pid: brokerPid, device: 'DESK' }, sessions: brokerSessions }));
  if (registry) { fs.mkdirSync(path.join(dir, '.chat-vault')); fs.writeFileSync(path.join(dir, '.chat-vault', 'pi-sessions.json'), JSON.stringify(registry)); }
  return { dir, proj, other };
}

function procs(id, { shell = 'pwsh.exe' } = {}) {
  return [
    { pid: 10, ppid: 1, name: 'WindowsTerminal.exe', commandLine: 'wt', startedAt: '2026-10-11T01:00:00.000Z' },
    { pid: 20, ppid: 10, name: shell, commandLine: `pwsh -NoExit -Command & pi.cmd --session-id ${id}`, startedAt: '2026-10-11T01:00:01.000Z' },
    { pid: 30, ppid: 20, name: 'cmd.exe', commandLine: `cmd /c pi.cmd --provider chappie --session-id ${id} --name x`, startedAt: '2026-10-11T01:00:02.000Z' },
    { pid: 40, ppid: 30, name: 'node.exe', commandLine: `"node" cli.js --provider chappie --model chatgpt --session-id ${id} --name 'proj · 7b8a'`, startedAt: '2026-10-11T01:00:03.000Z' },
    { pid: 50, ppid: 1, name: 'node.exe', commandLine: `"node" cli.js --provider chappie --model chatgpt --session-id ${id}0 --name other`, startedAt: null },
  ];
}

test('会话头只读首行；连接文案与默认名', () => {
  const h = home();
  const file = fs.readdirSync(path.join(h.dir, '.pi', 'agent', 'sessions')).map(d => path.join(h.dir, '.pi', 'agent', 'sessions', d))
    .flatMap(d => fs.readdirSync(d).map(f => path.join(d, f)))[0];
  assert.equal(readSessionHeader(file).type, 'session');
  const text = connectText(ID, 'D:\\x');
  assert.equal(text, `请用 Chappie 连接 Pi 会话 ${ID}（目录 D:\\x）。先读全局 AGENTS.md，按需读取相关历史；保持指定 Pi，不重复已确认完成的操作，不重复启动同一作业。`);
  assert.doesNotMatch(text, /用户要求停止|用户停止/);
  assert.doesNotMatch(text, /PC300|SleepStudy|nonce|marker|执行令牌|claim|分钟|既有授权|不要换会话或重复启动任务/);
  assert.equal(defaultSessionName('C:\\Projects\\example-app', ID), 'example-app · 0bc6');
});

test('pi 命令定位：优先新布局 ~/.pi/agent/bin/pi.cmd，缺失时回落旧布局 ~/.pi/bin/pi.cmd', () => {
  const h = home();
  assert.equal(createPiSessionManager({ homeDir: h.dir }).paths.piCmd, path.join(h.dir, '.pi', 'bin', 'pi.cmd'));
  fs.mkdirSync(path.join(h.dir, '.pi', 'agent', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, '.pi', 'agent', 'bin', 'pi.cmd'), '@echo off\r\n');
  assert.equal(createPiSessionManager({ homeDir: h.dir }).paths.piCmd, path.join(h.dir, '.pi', 'agent', 'bin', 'pi.cmd'));
});

test('进程树：按 --session-id 精确找到 node，shell 取最近的 pwsh 祖先；相似前缀的 ID 不误匹配', () => {
  const found = findSessionProcesses(procs(ID), ID);
  assert.deepEqual({ pid: found.pid, shellPid: found.shellPid }, { pid: 40, shellPid: 20 });
  assert.equal(findSessionProcesses(procs(ID), `${ID}0`).pid, 50);
  assert.equal(findSessionProcesses(procs(ID), 'nope'), null);
});

test('目录候选：会话目录 header 的精确 cwd + 登记表 + broker 在线数 + 置顶，按置顶/在线/最近排序', () => {
  const h = home({ registry: { settings: { pinned: ['Z:\\pinned-missing'] }, sessions: {} } });
  fs.writeFileSync(path.join(h.dir, '.pi', 'agent', 'chappie.sessions.json'), JSON.stringify({ version: 1, broker: { pid: process.pid },
    sessions: [{ id: ID, cwd: h.proj, name: 'proj · 7b8a', status: 'idle', device: 'DESK', bindingCount: 1 }] }));
  const m = createPiSessionManager({ homeDir: h.dir, listProcesses: async () => [] });
  const { workspaces, broker } = m.workspaces(null);
  assert.equal(broker.online, true);
  assert.equal(workspaces[0].path, 'Z:\\pinned-missing');
  assert.equal(workspaces[0].exists, false);
  assert.equal(workspaces[1].path, h.proj, '在线的目录排在前面');
  assert.equal(workspaces[1].onlineSessions, 1);
  assert.deepEqual(workspaces.map(w => w.path).slice(1), [h.proj, h.other]);
});

test('会话列表：broker 在线 + 登记表离线 + 仅进程；ChatVault 反查；broker 进程不在时全部离线', async () => {
  const h = home({ brokerSessions: [{ id: ID, cwd: 'D:\\proj', name: 'proj · 7b8a', status: 'running', device: 'DESK', bindingCount: 2 }],
    registry: { settings: {}, sessions: { [OTHER]: { id: OTHER, cwd: 'D:\\old', name: 'old · 01a1', createdAt: '2026-10-01T00:00:00.000Z', lastLaunchAt: '2026-10-02T00:00:00.000Z' } } } });
  const db = { prepare: () => ({ all: (...ids) => ids.includes(OTHER) ? [{ id: 123, agent_session_id: OTHER, title: '旧会话', message_count: 42, updated_at: '2026-10-02T01:00:00.000Z' }] : [] }) };
  const m = createPiSessionManager({ homeDir: h.dir, listProcesses: async () => procs(ID) });
  const { sessions, broker } = await m.sessions(db);
  assert.equal(broker.online, true);
  const live = sessions.find(s => s.id === ID);
  assert.deepEqual({ online: live.online, running: live.running, managed: live.managed, pid: live.pid, shellPid: live.shellPid, bindingCount: live.bindingCount },
    { online: true, running: true, managed: false, pid: 40, shellPid: 20, bindingCount: 2 });
  assert.equal(live.connectText, connectText(ID, 'D:\\proj'));
  const old = sessions.find(s => s.id === OTHER);
  assert.deepEqual({ online: old.online, managed: old.managed, status: old.status, cv: old.chatvault?.sessionId }, { online: false, managed: true, status: 'offline', cv: 123 });
  const orphan = sessions.find(s => s.id === `${ID}0`);
  assert.equal(orphan.status, 'process', '只有进程、没登记也没连上 broker 的会话也列出来');
  assert.equal(sessions[0].id, ID, '在线的排前面');
  const dead = createPiSessionManager({ homeDir: h.dir, listProcesses: async () => [], isAlive: () => false });
  const r = await dead.sessions(null);
  assert.equal(r.broker.online, false);
  assert.ok(r.sessions.every(s => !s.online), 'broker 不在时一律离线');
});

test('远端 broker：Linux PID 与本机观察进程分开；SSH 断开、过期及缺失状态均不误用旧本地在线表', async t => {
  const h = home({ brokerSessions: [{ id: OTHER, cwd: 'D:\\stale-local', name: 'old local session' }] });
  t.after(() => {
    const clean = dir => {
      assert.ok(dir === h.dir || dir.startsWith(h.dir + path.sep));
      assert.ok(!fs.lstatSync(dir).isSymbolicLink());
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        assert.ok(!fs.lstatSync(file).isSymbolicLink());
        if (entry.isDirectory()) clean(file); else fs.unlinkSync(file);
      }
      fs.rmdirSync(dir);
    };
    clean(h.dir);
  });
  const agent = path.join(h.dir, '.pi', 'agent');
  const connect = '127.0.0.1:24274';
  const fixed = new Date('2026-10-29T00:00:00Z');
  fs.writeFileSync(path.join(agent, 'chappie.json'), JSON.stringify({ connect }));
  const mirror = path.join(agent, 'chappie.remote-sessions.json');
  const data = { observedAt: fixed.toISOString(), brokerOnline: true, broker: { pid: 1234 },
    source: { kind: 'ssh', host: 'operator@192.0.2.10', observerPid: 5678, connect },
    sessions: [{ id: ID, cwd: h.proj, status: 'ready', device: 'WINDOWS', name: 'remote session' }] };
  const manager = createPiSessionManager({ homeDir: h.dir, now: () => fixed, listProcesses: async () => [], isAlive: pid => pid === 5678 || pid === process.pid });
  const checkOffline = async () => {
    const result = await manager.sessions(null);
    assert.equal(result.broker.online, false);
    assert.ok(result.sessions.every(s => !s.online));
  };
  await checkOffline();
  fs.writeFileSync(mirror, JSON.stringify(data));
  const live = await manager.sessions(null);
  assert.equal(live.broker.online, true);
  assert.equal(live.broker.pid, null);
  assert.equal(live.broker.remotePid, 1234);
  assert.equal(live.broker.observerPid, 5678);
  assert.deepEqual(live.sessions.filter(s => s.online).map(s => s.id), [ID]);
  assert.equal(manager.workspaces(null).workspaces.find(w => w.path === h.proj).onlineSessions, 1);
  for (const patch of [{ brokerOnline: false }, { observedAt: '2026-10-28T23:59:50Z' },
    { source: { ...data.source, observerPid: 9999 } }, { source: { ...data.source, connect: '127.0.0.1:1' } }]) {
    fs.writeFileSync(mirror, JSON.stringify({ ...data, ...patch }));
    await checkOffline();
  }
});

test('起会话：固定 ID、wt 新 tab 参数、登记表落盘、文案；恢复复用 ID；已在线的不重复起；目录不存在报 400', async () => {
  const h = home({ registry: { settings: { window: 'mywin' }, sessions: {} } });
  const spawned = [];
  let running = [];
  const m = createPiSessionManager({ homeDir: h.dir, settleMs: 0, platform: 'win32',
    env: { LOCALAPPDATA: path.join(h.dir, 'AppData', 'Local') },
    spawnImpl: (file, args, opts) => { spawned.push({ file, args, opts }); return { unref() {} }; },
    listProcesses: async () => running, now: () => new Date('2026-10-11T02:00:00.000Z') });
  fs.mkdirSync(path.join(h.dir, 'AppData', 'Local', 'Microsoft', 'WindowsApps'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe'), '');
  const r = await m.launch({ cwd: h.proj });
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.equal(r.name, `proj · ${r.id.slice(-4)}`);
  assert.equal(r.connectText, connectText(r.id, h.proj));
  assert.equal(r.launcher, 'windows-terminal');
  const { args, opts } = spawned[0];
  assert.deepEqual(args.slice(0, 5), ['-w', 'mywin', 'nt', '-d', h.proj]);
  assert.ok(args.includes('--suppressApplicationTitle'));
  const command = args[args.indexOf('-Command') + 1];
  assert.match(command, new RegExp(`^& '.*pi\\.cmd' --provider chappie --model chatgpt --session-id ${r.id} --name 'proj · ${r.id.slice(-4)}'$`));
  assert.equal(opts.detached, true);
  const registry = JSON.parse(fs.readFileSync(path.join(h.dir, '.chat-vault', 'pi-sessions.json'), 'utf8'));
  assert.equal(registry.sessions[r.id].cwd, h.proj);
  assert.equal(registry.sessions[r.id].lastLaunchAt, '2026-10-11T02:00:00.000Z');
  // 恢复：同 ID、同目录
  const again = await m.launch({ cwd: h.proj, id: r.id });
  assert.equal(again.resumed, true);
  assert.equal(again.id, r.id);
  // 已在线：拒绝
  running = procs(r.id);
  await assert.rejects(m.launch({ cwd: h.proj, id: r.id }), /已在运行/);
  await assert.rejects(m.launch({ cwd: path.join(h.dir, 'nope') }), /目录不存在/);
  await assert.rejects(m.launch({ cwd: h.other, id: r.id }), /登记在另一个目录/);
  await assert.rejects(m.launch({ cwd: h.proj, id: 'bad id!' }), /会话 ID/);
});

test('停会话：整树结束 tab 的 pwsh；没有进程时 404；登记表记录停止时间', async () => {
  const h = home({ registry: { settings: {}, sessions: { [ID]: { id: ID, cwd: 'D:\\proj', name: 'n', createdAt: 'x', lastLaunchAt: 'y' } } } });
  const killed = [];
  const m = createPiSessionManager({ homeDir: h.dir, listProcesses: async () => procs(ID),
    killTree: async pid => { killed.push(pid); return { ok: true, output: 'ok' }; }, now: () => new Date('2026-10-11T03:00:00.000Z') });
  const r = await m.stop(ID);
  assert.deepEqual({ killed, viaShell: r.viaShell }, { killed: [20], viaShell: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, '.chat-vault', 'pi-sessions.json'), 'utf8')).sessions[ID].lastStopAt, '2026-10-11T03:00:00.000Z');
  await assert.rejects(m.stop('zzzz'), /没有在运行的进程/);
  assert.deepEqual(m.settings({ window: 'other', pinned: ['D:\\a', ''] }), { window: 'other', pinned: ['D:\\a'] });
  assert.deepEqual(m.forget(ID), { ok: true, id: ID });
});

test('匹配对话里出现的 UUID：在线/登记的直接给，只在 ChatVault 归档里的补成离线条目，其余忽略', async () => {
  const h = home({ brokerSessions: [{ id: ID, cwd: 'D:\proj', name: 'proj · 1b3c', status: 'idle', device: 'DESK', bindingCount: 1 }] });
  const db = { prepare: sql => ({ all: (...args) => /agent_session_id IN/.test(sql) && args.includes(OTHER)
    ? [{ id: 77, agent_session_id: OTHER, title: '老会话', message_count: 9, updated_at: '2026-10-01T00:00:00.000Z', cwd: 'D:\old' }] : [] }) };
  const m = createPiSessionManager({ homeDir: h.dir, listProcesses: async () => [] });
  const { matches } = await m.match(db, [ID, OTHER, '11111111-1111-4111-8111-111111111111', 'not-a-uuid!', ID]);
  assert.deepEqual(matches.map(x => [x.id, x.online, x.chatvault?.sessionId ?? null]), [[ID, true, null], [OTHER, false, 77]]);
  assert.equal(matches[1].connectText, connectText(OTHER, 'D:\old'));
  assert.deepEqual(await m.match(db, []), { matches: [] });
});

test('wt.exe 是应用执行别名：existsSync/stat 认不出也要走 Windows Terminal，默认加到最近使用的窗口', async () => {
  const h = home();
  const alias = path.join(h.dir, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe');
  fs.mkdirSync(path.dirname(alias), { recursive: true }); fs.writeFileSync(alias, '');
  const fakeFs = { ...fs, existsSync: p => p === alias ? false : fs.existsSync(p),
    statSync: (p, ...rest) => { if (p === alias) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return fs.statSync(p, ...rest); } };
  const spawned = [];
  const m = createPiSessionManager({ homeDir: h.dir, fsImpl: fakeFs, settleMs: 0, env: { LOCALAPPDATA: path.join(h.dir, 'AppData', 'Local') },
    spawnImpl: (file, args) => { spawned.push({ file, args }); return { unref() {} }; }, listProcesses: async () => [] });
  const r = await m.launch({ cwd: h.proj });
  assert.equal(r.launcher, 'windows-terminal');
  assert.equal(spawned[0].file, alias);
  assert.deepEqual(spawned[0].args.slice(0, 3), ['-w', '0', 'nt'], '默认 -w 0：最近使用的终端窗口');
});
