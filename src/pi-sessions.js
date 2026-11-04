// Pi 会话管理（本机）：给 chatgpt-sync 扩展提供「选目录 → 起 pi 会话 → 生成 Chappie 连接文案 → 停止/恢复」。
//
// 关键事实（2026-10-11 核对 pi 1.1.0 源码）：
// - `pi --session-id <id>`：id 只要求字母数字和 -_.；该 cwd 下已有同 id 的会话就续上，没有就新建。
//   所以会话 ID 由这里预先生成并固定：重启后用同一 ID 再起一次 = 同一会话、同一连接目标；
//   Chappie broker 的绑定（chappie.state.json）也仍然有效。
// - 在线状态来自 Chappie broker 落盘的 ~/.pi/agent/chappie.sessions.json（本地 fork 0.5.1-patch.3 起）；
//   文件里带 broker pid，broker 不在时一律按离线处理。没有该文件时只认进程存活。
// - 起会话 = Windows Terminal 新 tab（`wt -w <窗口> nt -d <cwd> …`）里跑 pwsh → pi.cmd；停止 = 结束该 tab 的 pwsh 进程树
//   （Windows 没有可靠的跨控制台 Ctrl+C；pi 的 jsonl 逐条追加，强杀不丢历史）。
// - 目录名编码（`--D--a-b--`）把 \ : - 都变成 -，不可逆；目录候选从各会话目录最新 jsonl 的首行 header 取精确 cwd。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { listWorkspaces } from './query.js';
import { createActivityIndex } from './pi-activity.js';

const ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;   // 与 pi 的 assertValidSessionId 一致
const NAME_RE = /[^\p{L}\p{N} ._#()\-·]/gu;
const HEADER_BYTES = 4096;
const PROCESS_SETTLE_MS = 2500;

// 连接文案只保留会话定位；任务执行、重试、等待和收尾细则统一由 Pi 全局 AGENTS.md 维护。
export function connectText(id, cwd) {
  return `请用 Chappie 连接 Pi 会话 ${id}（目录 ${cwd}）。先读全局 AGENTS.md，按需读取相关历史；保持指定 Pi，不重复已确认完成的操作，不重复启动同一作业。`;
}

// 取 ID 末 4 位：pi 自己生成的是 uuidv7，同一天的前几位全一样，前缀区分不开（实测两条都显示 01a1）。
export function defaultSessionName(cwd, id) {
  return `${path.basename(cwd) || cwd} · ${String(id).slice(-4)}`;
}

/** 大小写与分隔符无关的目录比较键（只在 Windows 上忽略大小写） */
export function pathKey(p, platform = process.platform) {
  const normalized = path.normalize(String(p || '')).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** 读 jsonl 首行（type=session 的 header），只读前 4KB */
export function readSessionHeader(file, fsImpl = fs) {
  let fd = null;
  try {
    fd = fsImpl.openSync(file, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const read = fsImpl.readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const line = buffer.toString('utf8', 0, read).split('\n', 1)[0];
    const header = JSON.parse(line);
    return header?.type === 'session' && typeof header.cwd === 'string' ? header : null;
  } catch { return null; } finally { if (fd !== null) try { fsImpl.closeSync(fd); } catch { /* 忽略 */ } }
}

/** 解析 PowerShell 的 `/Date(1700000000000)/` 或 ISO 字符串 */
function dateOf(value) {
  if (typeof value !== 'string') return null;
  const ms = /\/Date\((\d+)\)\//.exec(value)?.[1];
  const parsed = ms ? Number(ms) : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** 列出可能相关的进程（node / pwsh / powershell / cmd / WindowsTerminal），PowerShell 5.1 可用 */
async function defaultListProcesses() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe' OR Name='cmd.exe'\""
    + " | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Started';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress";
  const stdout = await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, out) => err ? reject(err) : resolve(out));
  });
  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name,
    commandLine: p.CommandLine || '', startedAt: dateOf(p.Started) }));
}

function defaultKillTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, out, stderr) =>
      resolve({ ok: !err, output: String(out || stderr || '').trim() }));
  });
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** 从进程表里找某个会话的 pi 进程及其所在 shell（wt tab 里的 pwsh） */
export function findSessionProcesses(processes, id) {
  const token = `--session-id ${id}`;
  const node = processes.find(p => /node(?:\.exe)?$/i.test(p.name || '') && (p.commandLine || '').includes(token)
    && !/\s--session-id\s+\S+\S/.test((p.commandLine || '').slice((p.commandLine || '').indexOf(token) + token.length).slice(0, 1)));
  if (!node) return null;
  const byPid = new Map(processes.map(p => [p.pid, p]));
  let shell = null;
  for (let cur = byPid.get(node.ppid), i = 0; cur && i < 6; cur = byPid.get(cur.ppid), i++) {
    if (/^(pwsh|powershell)\.exe$/i.test(cur.name || '')) { shell = cur; break; }
  }
  return { pid: node.pid, shellPid: shell?.pid ?? null, startedAt: node.startedAt || null };
}

export function createPiSessionManager({
  homeDir = os.homedir(),
  fsImpl = fs,
  spawnImpl = spawn,
  listProcesses = defaultListProcesses,
  killTree = defaultKillTree,
  isAlive = pidAlive,
  now = () => new Date(),
  settleMs = PROCESS_SETTLE_MS,
  platform = process.platform,
  env = process.env,
  requestMap = null,   // chatgpt-request-map：请求 ID → ChatGPT 对话（标题/ID）
} = {}) {
  const piAgentDir = path.join(homeDir, '.pi', 'agent');
  // pi 官方安装器 1.x 起把命令放在 ~/.pi/agent/bin/pi.cmd，旧布局在 ~/.pi/bin/pi.cmd
  const piCmd = [path.join(piAgentDir, 'bin', 'pi.cmd'), path.join(homeDir, '.pi', 'bin', 'pi.cmd')]
    .find(candidate => fsImpl.existsSync(candidate)) ?? path.join(piAgentDir, 'bin', 'pi.cmd');
  const sessionsRoot = path.join(piAgentDir, 'sessions');
  const brokerFile = path.join(piAgentDir, 'chappie.sessions.json');
  const remoteBrokerFile = path.join(piAgentDir, 'chappie.remote-sessions.json');
  const registryFile = path.join(homeDir, '.chat-vault', 'pi-sessions.json');
  const headerCache = new Map();   // dir -> { mtimeMs, cwd, lastActive }
  const activityIndex = createActivityIndex({ homeDir, fsImpl, sessionsRoot });

  // ---------- 登记表 ----------
  function readRegistry() {
    try {
      const data = JSON.parse(fsImpl.readFileSync(registryFile, 'utf8'));
      return { version: 1, settings: { window: '0', pinned: [], ...(data.settings || {}) }, sessions: data.sessions || {} };
    } catch { return { version: 1, settings: { window: '0', pinned: [] }, sessions: {} }; }
  }
  function writeRegistry(registry) {
    fsImpl.mkdirSync(path.dirname(registryFile), { recursive: true });
    const tmp = `${registryFile}.tmp`;
    fsImpl.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
    fsImpl.renameSync(tmp, registryFile);
  }

  // ---------- broker 在线表 ----------
  function readBroker() {
    let connect = null;
    try { connect = JSON.parse(fsImpl.readFileSync(path.join(piAgentDir, 'chappie.json'), 'utf8')).connect || null; } catch { /* Original local configuration. */ }
    if (connect) {
      // The remote broker has a Linux PID. Its SSH observer has a real local PID;
      // a recent snapshot from that observer provides the local online status.
      try {
        const data = JSON.parse(fsImpl.readFileSync(remoteBrokerFile, 'utf8'));
        const age = now().getTime() - Date.parse(data.observedAt);
        const observerPid = data.source?.observerPid;
        const online = data.source?.kind === 'ssh' && data.source.connect === connect
          && isAlive(observerPid) && Number.isFinite(age) && age >= -1000 && age <= 8000 && data.brokerOnline === true;
        return { present: true, online, pid: null, remotePid: data.broker?.pid ?? null, observerPid,
          source: 'ssh', host: data.source?.host || null, updatedAt: data.updatedAt || null,
          sessions: online && Array.isArray(data.sessions) ? data.sessions : [] };
      } catch { return { present: false, online: false, pid: null, updatedAt: null, sessions: [] }; }
    }
    try {
      const data = JSON.parse(fsImpl.readFileSync(brokerFile, 'utf8'));
      const pid = data?.broker?.pid;
      const online = isAlive(pid);
      return { present: true, online, pid: pid ?? null, updatedAt: data.updatedAt || null,
        sessions: online && Array.isArray(data.sessions) ? data.sessions : [] };
    } catch { return { present: false, online: false, pid: null, updatedAt: null, sessions: [] }; }
  }

  // ---------- 目录候选 ----------
  function scanSessionDirs() {
    const out = [];
    let dirs = [];
    try { dirs = fsImpl.readdirSync(sessionsRoot); } catch { return out; }
    for (const dir of dirs) {
      const full = path.join(sessionsRoot, dir);
      let files = [];
      try { files = fsImpl.readdirSync(full).filter(f => f.endsWith('.jsonl')).sort().reverse(); } catch { continue; }
      if (!files.length) continue;
      const newest = path.join(full, files[0]);
      let mtimeMs = 0;
      try { mtimeMs = fsImpl.statSync(newest).mtimeMs; } catch { continue; }
      const cached = headerCache.get(full);
      if (cached?.mtimeMs === mtimeMs && cached.file === newest) { out.push(cached); continue; }
      const header = readSessionHeader(newest, fsImpl);
      if (!header) continue;
      const entry = { mtimeMs, file: newest, cwd: header.cwd, lastActive: new Date(mtimeMs).toISOString(), sessionCount: files.length };
      headerCache.set(full, entry);
      out.push(entry);
    }
    return out;
  }

  function workspaces(db) {
    const registry = readRegistry();
    const broker = readBroker();
    const merged = new Map();
    const add = (cwd, patch) => {
      if (!cwd || typeof cwd !== 'string') return;
      const key = pathKey(cwd, platform);
      const prev = merged.get(key) || { path: cwd, lastActive: null, sessionCount: 0, sources: new Set(), onlineSessions: 0 };
      if (patch.lastActive && (!prev.lastActive || patch.lastActive > prev.lastActive)) prev.lastActive = patch.lastActive;
      if (patch.sessionCount) prev.sessionCount = Math.max(prev.sessionCount, patch.sessionCount);
      if (patch.onlineSessions) prev.onlineSessions += patch.onlineSessions;
      prev.sources.add(patch.source);
      merged.set(key, prev);
    };
    for (const s of scanSessionDirs()) add(s.cwd, { lastActive: s.lastActive, sessionCount: s.sessionCount, source: 'pi-sessions' });
    if (db) {
      try {
        for (const w of listWorkspaces(db, { agent: 'pi' })) add(w.path, { lastActive: w.last_active || null, sessionCount: w.session_count, source: 'chatvault' });
      } catch { /* 数据库不可用时其他来源照常 */ }
    }
    for (const s of Object.values(registry.sessions)) add(s.cwd, { lastActive: s.lastLaunchAt || s.createdAt || null, source: 'registry' });
    for (const s of broker.sessions) add(s.cwd, { onlineSessions: 1, source: 'broker' });
    for (const p of registry.settings.pinned || []) add(p, { source: 'pinned' });
    const pinned = new Set((registry.settings.pinned || []).map(p => pathKey(p, platform)));
    const rows = [...merged.entries()].map(([key, w]) => ({ path: w.path, exists: safeIsDir(w.path), pinned: pinned.has(key),
      lastActive: w.lastActive, sessionCount: w.sessionCount, onlineSessions: w.onlineSessions, sources: [...w.sources] }));
    rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.onlineSessions - a.onlineSessions
      || String(b.lastActive || '').localeCompare(String(a.lastActive || '')));
    return { workspaces: rows, settings: registry.settings, broker: { present: broker.present, online: broker.online } };
  }

  function safeIsDir(p) {
    try { return fsImpl.statSync(p).isDirectory(); } catch { return false; }
  }

  // ---------- 会话列表 ----------
  function chatvaultRows(db, ids) {
    if (!db || !ids.length) return new Map();
    try {
      const marks = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, agent_session_id, title, message_count, updated_at FROM sessions WHERE agent = 'pi' AND agent_session_id IN (${marks})`).all(...ids);
      return new Map(rows.map(r => [r.agent_session_id, { sessionId: r.id, title: r.title, messageCount: r.message_count, updatedAt: r.updated_at }]));
    } catch { return new Map(); }
  }

  async function sessions(db, { withRecent = false } = {}) {
    const registry = readRegistry();
    const broker = readBroker();
    let processes = [];
    try { processes = await listProcesses(); } catch { processes = []; }
    const ids = new Set([...Object.keys(registry.sessions), ...broker.sessions.map(s => s.id)]);
    // 终端里手起、broker 又不在线时，只能从进程命令行里认 --session-id（手工起的通常没带，那就看不到）。
    for (const p of processes) {
      const m = /--session-id\s+("?)([A-Za-z0-9._-]+)\1/.exec(p.commandLine || '');
      if (m && /node(?:\.exe)?$/i.test(p.name || '')) ids.add(m[2]);
    }
    const cv = chatvaultRows(db, [...ids]);
    const brokerById = new Map(broker.sessions.map(s => [s.id, s]));
    const list = [...ids].map(id => {
      const reg = registry.sessions[id] || null;
      const live = brokerById.get(id) || null;
      const proc = findSessionProcesses(processes, id);
      const cwd = live?.cwd || reg?.cwd || null;
      const name = live?.name || reg?.name || (cwd ? defaultSessionName(cwd, id) : id);
      return { id, cwd, name, managed: !!reg, online: !!live, running: live?.status === 'running' || live?.status === 'busy',
        status: live?.status || (proc ? 'process' : 'offline'), bindingCount: live?.bindingCount ?? 0, device: live?.device || null,
        pid: proc?.pid ?? null, shellPid: proc?.shellPid ?? null, startedAt: proc?.startedAt || null,
        createdAt: reg?.createdAt || null, lastLaunchAt: reg?.lastLaunchAt || null, lastStopAt: reg?.lastStopAt || null,
        chatvault: cv.get(id) || null, connectText: cwd ? connectText(id, cwd) : null };
    });
    list.sort((a, b) => Number(b.online) - Number(a.online) || String(b.lastLaunchAt || b.startedAt || '').localeCompare(String(a.lastLaunchAt || a.startedAt || '')));
    if (withRecent) {
      // 每个会话最近被哪些 ChatGPT 对话驱动、最后活动时间（一个会话可同时被多个对话驱动）
      try {
        void requestMap?.ensureBackfill?.();
        const { bySession, indexing } = await activityIndex.recent({ sessionIds: list.map(s => s.id) });
        for (const s of list) {
          const r = bySession.get(s.id);
          if (!r) continue;
          s.lastActivityAt = r.last;
          s.drivers = r.recent.map(x => ({ ...x, conversation: requestMap?.lookup?.(x.requestId) || null }));
          s.driverCount = r.total;
        }
        if (indexing) list.indexing = true;
      } catch { /* 统计失败不影响列表 */ }
    }
    return { sessions: list, indexing: !!list.indexing, broker: { present: broker.present, online: broker.online, pid: broker.pid, updatedAt: broker.updatedAt,
      ...(broker.source ? { source: broker.source, host: broker.host, remotePid: broker.remotePid, observerPid: broker.observerPid } : {}) },
      settings: registry.settings };
  }

  // ---------- 起会话 ----------
  function wtPath() {
    const alias = path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'wt.exe');
    // wt.exe 是「应用执行别名」（IO_REPARSE_TAG_APPEXECLINK）：stat 报 EACCES，existsSync 因此返回 false（2026-10-12 实测），
    // 曾被误判为没装 Windows Terminal。用 lstat 判断存在。
    try { fsImpl.lstatSync(alias); return alias; } catch { return null; }
  }
  function piCommand(id, name) {
    const quote = s => `'${String(s).replace(/'/g, "''")}'`;
    return `& ${quote(piCmd)} --provider chappie --model chatgpt --session-id ${id} --name ${quote(name)}`;
  }
  function spawnTab({ cwd, name, id, window }) {
    const command = piCommand(id, name);
    const wt = wtPath();
    let child;
    if (wt) {
      // -w 0 = 最近使用的终端窗口（加 tab 到你正在用的那个）；也可设成命名窗口
      child = spawnImpl(wt, ['-w', window || '0', 'nt', '-d', cwd, '--title', name, '--suppressApplicationTitle',
        'pwsh', '-NoLogo', '-NoExit', '-Command', command], { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    } else {
      // 没有 Windows Terminal：Node 的 detached 子进程在 Windows 上自带独立控制台窗口；不经过 cmd start（引号会被拆坏）
      child = spawnImpl('pwsh.exe', ['-NoLogo', '-NoExit', '-Command', command],
        { cwd, detached: true, stdio: 'ignore', windowsHide: false });
    }
    child.unref?.();
    return { launcher: wt ? 'windows-terminal' : 'console', command };
  }

  async function launch({ cwd, name, id, window } = {}) {
    if (typeof cwd !== 'string' || !cwd.trim()) throw httpError(400, '缺少目录');
    cwd = path.normalize(cwd.trim());
    if (!safeIsDir(cwd)) throw httpError(400, `目录不存在：${cwd}`);
    if (!fsImpl.existsSync(piCmd)) throw httpError(500, `找不到 pi：${piCmd}`);
    if (id != null && !ID_RE.test(String(id))) throw httpError(400, '会话 ID 只能含字母数字和 -_.');
    const registry = readRegistry();
    const sessionId = id ? String(id) : randomUUID();
    const existing = registry.sessions[sessionId];
    if (existing && pathKey(existing.cwd, platform) !== pathKey(cwd, platform)) throw httpError(409, `会话 ${sessionId} 登记在另一个目录：${existing.cwd}`);
    const title = String(name || existing?.name || defaultSessionName(cwd, sessionId)).replace(NAME_RE, '').trim().slice(0, 60) || defaultSessionName(cwd, sessionId);
    // 已在线的不重复起
    const before = await sessions(null);
    const current = before.sessions.find(s => s.id === sessionId);
    if (current?.online || current?.pid) throw httpError(409, `会话 ${sessionId} 已在运行（pid ${current.pid ?? '?'}）`);
    const started = spawnTab({ cwd, name: title, id: sessionId, window: window || registry.settings.window });
    const at = now().toISOString();
    registry.sessions[sessionId] = { id: sessionId, cwd, name: title, createdAt: existing?.createdAt || at, lastLaunchAt: at, lastStopAt: existing?.lastStopAt || null };
    writeRegistry(registry);
    await new Promise(resolve => setTimeout(resolve, settleMs));
    let proc = null;
    try { proc = findSessionProcesses(await listProcesses(), sessionId); } catch { /* 进程表读不到不算失败 */ }
    return { ok: true, id: sessionId, cwd, name: title, resumed: !!existing, launcher: started.launcher,
      pid: proc?.pid ?? null, shellPid: proc?.shellPid ?? null, connectText: connectText(sessionId, cwd) };
  }

  // ---------- 停会话 ----------
  async function stop(id) {
    if (!ID_RE.test(String(id || ''))) throw httpError(400, '会话 ID 无效');
    const proc = findSessionProcesses(await listProcesses(), id);
    if (!proc) throw httpError(404, `会话 ${id} 没有在运行的进程`);
    const target = proc.shellPid ?? proc.pid;
    const result = await killTree(target);
    if (!result.ok && target !== proc.pid) await killTree(proc.pid);
    const registry = readRegistry();
    if (registry.sessions[id]) { registry.sessions[id].lastStopAt = now().toISOString(); writeRegistry(registry); }
    return { ok: true, id, killed: target, viaShell: target === proc.shellPid, output: result.output };
  }

  /** 对话里出现的 UUID 里哪些是已知的 pi 会话（在线表 / 登记表 / ChatVault 归档） */
  async function match(db, ids) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(id => ID_RE.test(id)))].slice(0, 200);
    if (!wanted.length) return { matches: [] };
    const live = await sessions(db);
    const byId = new Map(live.sessions.map(s => [s.id, s]));
    const matches = wanted.filter(id => byId.has(id)).map(id => byId.get(id));
    const missing = wanted.filter(id => !byId.has(id));
    if (db && missing.length) {
      try {
        const marks = missing.map(() => '?').join(',');
        const rows = db.prepare(`SELECT s.id, s.agent_session_id, s.title, s.message_count, s.updated_at, w.path AS cwd
          FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.agent = 'pi' AND s.agent_session_id IN (${marks})`).all(...missing);
        for (const r of rows) matches.push({ id: r.agent_session_id, cwd: r.cwd || null, name: r.cwd ? defaultSessionName(r.cwd, r.agent_session_id) : r.agent_session_id,
          managed: false, online: false, running: false, status: 'offline', bindingCount: 0, pid: null, shellPid: null,
          chatvault: { sessionId: r.id, title: r.title, messageCount: r.message_count, updatedAt: r.updated_at },
          connectText: r.cwd ? connectText(r.agent_session_id, r.cwd) : null });
      } catch { /* 数据库不可用时只回在线/登记的 */ }
    }
    return { matches, broker: live.broker };
  }

  /**
   * 当前 ChatGPT 对话在 Pi 侧做了什么：按对话消息的 request_id（wfr_…）在「对话里提到的会话 + 在线会话」的 jsonl 里汇总。
   * 也用来认出没写会话 ID、按名字连上的会话。
   */
  async function activity(db, { requestIds = [], sessionIds = [] } = {}) {
    const wantedIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map(String).filter(id => ID_RE.test(id)))].slice(0, 20);
    const broker = readBroker();
    const scope = [...new Set([...wantedIds, ...broker.sessions.map(s => s.id)])];
    const reqs = (Array.isArray(requestIds) ? requestIds : []).map(String).filter(r => /^wfr_[0-9a-f]{16,64}/i.test(r)).slice(0, 20);
    const result = await activityIndex.query({ sessionIds: scope, requestIds: reqs });
    if (!result.activity.length) return { ...result, sessions: [] };
    const live = await sessions(db);
    const byId = new Map(live.sessions.map(s => [s.id, s]));
    return { ...result, sessions: [...new Set(result.activity.map(a => a.sessionId))].map(id => byId.get(id) || { id, name: id, online: false }) };
  }

  function forget(id) {
    const registry = readRegistry();
    if (!registry.sessions[id]) throw httpError(404, '没有这个会话的登记');
    delete registry.sessions[id];
    writeRegistry(registry);
    return { ok: true, id };
  }

  function settings(patch) {
    const registry = readRegistry();
    if (patch && typeof patch === 'object') {
      if (typeof patch.window === 'string' && /^(?:-?\d+|[A-Za-z0-9_-]{1,32})$/.test(patch.window)) registry.settings.window = patch.window;
      if (Array.isArray(patch.pinned)) registry.settings.pinned = patch.pinned.filter(p => typeof p === 'string' && p.trim()).slice(0, 50);
      writeRegistry(registry);
    }
    return registry.settings;
  }

  return { workspaces, sessions, launch, stop, forget, settings, match, activity, connectText, paths: { piAgentDir, piCmd, sessionsRoot, brokerFile, registryFile } };
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}
