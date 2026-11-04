// 进程与端口的平台辅助：存活检查、结束进程树、查询进程身份、端口监听与健康检查。
//
// 所有外部命令（taskkill / powershell）都带超时并隐藏窗口：这里本身就是「探针」，
// 必须有界（见 ~/.pi/agent/AGENTS.md「探测脚本清理责任」）。
import { execFile } from 'node:child_process';
import net from 'node:net';

export const IS_WIN = process.platform === 'win32';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 进程是否存在（只看 PID；PID 复用由调用方结合身份信息判断） */
export function isAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === 'EPERM';
	}
}

/** 运行外部命令：有超时、隐藏窗口、限制输出，失败不抛错而是返回 code */
export function run(file, args, timeoutMs = 8000) {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
			(err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
				stdout: stdout || '', stderr: stderr || '', timedOut: !!err?.killed }));
	});
}

function powershell(script, timeoutMs = 8000) {
	return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs);
}

/** 结束进程及其全部子进程，并确认已退出。返回是否已不存在。 */
export async function killTree(pid, { timeoutMs = 15000 } = {}) {
	if (!isAlive(pid)) return true;
	if (IS_WIN) {
		await run('taskkill', ['/PID', String(pid), '/T', '/F'], timeoutMs);
	} else {
		try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
		for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
		if (isAlive(pid)) {
			try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
		}
	}
	for (let i = 0; i < 40 && isAlive(pid); i++) await sleep(150);
	return !isAlive(pid);
}

/** 进程身份：{ pid, parentPid, createdAt(ISO), commandLine }；不存在返回 null */
export async function queryProcess(pid) {
	if (!isAlive(pid)) return null;
	if (IS_WIN) {
		const r = await powershell(`$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; `
			+ 'if ($p) { [pscustomobject]@{ pid = $p.ProcessId; parentPid = $p.ParentProcessId; '
			+ "createdAt = $p.CreationDate.ToUniversalTime().ToString('o'); commandLine = $p.CommandLine } | ConvertTo-Json -Compress }");
		try { return JSON.parse(r.stdout.trim()); } catch { return null; }
	}
	const r = await run('ps', ['-o', 'ppid=,lstart=,args=', '-p', String(pid)]);
	const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(r.stdout.trim());
	return m ? { pid, parentPid: Number(m[1]), createdAt: new Date(m[2]).toISOString(), commandLine: m[3] } : null;
}

/** 在本机监听该端口的进程 PID；没有返回 null */
export async function findListeningPid(port) {
	if (!Number.isInteger(port) || port <= 0) return null;
	if (IS_WIN) {
		const r = await powershell(`$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess }`);
		const pid = Number(r.stdout.trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	}
	const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
	const pid = Number(r.stdout.trim().split('\n')[0]);
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 端口能否连上 */
export function portOpen(port, host = '127.0.0.1', timeoutMs = 800) {
	return new Promise((resolve) => {
		if (!Number.isInteger(port) || port <= 0) return resolve(false);
		const socket = net.connect({ port, host });
		const done = (ok) => { socket.destroy(); resolve(ok); };
		socket.setTimeout(timeoutMs, () => done(false));
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
	});
}

/** HTTP 健康检查：2xx/3xx 为 ok */
export async function httpCheck(url, timeoutMs = 3000) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
		try { await res.body?.cancel(); } catch { /* ignore */ }
		return { ok: res.status >= 200 && res.status < 400, status: res.status };
	} catch (err) {
		return { ok: false, status: null, error: String(err?.cause?.code || err?.name || err?.message || err).slice(0, 120) };
	}
}
