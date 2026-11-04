// Chappie 隧道（本机 otunnel）状态：只读它的本地 health 接口（不带 CORS 头，靠扩展的 127.0.0.1 主机权限读取）。
// 弹窗（classic script）与后台（module service worker，side-effect import）共用，挂在 globalThis.__cvTunnel。
//
// otunnel 遇到某些上游错误（如轮询 403，2026-10-09）会直接退出；进程不在时接口无响应，即「未运行」。
(() => {
  const DEFAULT_PORT = 8080;
  const POLL_STALE_SEC = 90;   // 长轮询 30 秒一轮，连续三轮没成功才算停滞
  // 停滞 5 分钟升为红色并发通知：ChatGPT 侧此时已在报 tunnel-client did not poll。health 仍是 ready，
  // 只看进程是否活着发现不了（2026-10-16 01:49 起 OpenAI 隧道接口持续 503/504，本地看一切正常）。
  const POLL_BAD_SEC = 300;

  const fmtAge = sec => !Number.isFinite(sec) || sec < 0 ? '—' : sec < 60 ? `${Math.round(sec)} 秒`
    : sec < 3600 ? `${Math.floor(sec / 60)} 分钟` : `${Math.floor(sec / 3600)}h${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}m`;

  /**
   * 返回 { code, kind, text, title }：
   *   code ok | off | down | foreign | not-ready | no-channel | stalled | no-poll
   *   kind ok | warn | bad（off 时为 null，调用方不显示）
   */
  async function check({ port = DEFAULT_PORT, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof fetchImpl !== 'function')
      return { code: 'off', kind: null, text: '', title: '' };
    const base = `http://127.0.0.1:${port}`;
    const get = async (path, json) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const response = await fetchImpl(base + path, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return json ? await response.json() : await response.text();
      } finally { clearTimeout(timer); }
    };
    const result = (code, kind, text, title = '', extra = {}) => ({ code, kind, text, title, ...extra });
    let health;
    try { health = await get('/health', true); }
    catch {
      return result('down', 'bad', `Chappie 隧道未运行（127.0.0.1:${port} 无响应）`,
        '计划任务「Chappie Tunnel」会在 otunnel 异常退出后自动重拉（~/.pi/agent/run-chappie-tunnel.ps1）；连续失败会停止，可运行 ~/.pi/agent/restart-chappie-tunnel.ps1。');
    }
    // 8080 很常见：确认是 otunnel 的 health 结构，别把别的服务当成隧道。
    if (health?.schema_version !== 1 || typeof health.runtime?.lifecycle !== 'string')
      return result('foreign', 'warn', `127.0.0.1:${port} 不是 otunnel 的 health 接口`, '在高级设置里改端口，或填 0 不显示');
    const [status, metrics] = await Promise.all([get('/api/status', true).catch(() => null), get('/metrics', false).catch(() => '')]);
    const lastPoll = Number(/^commands_poll_last_successful_timestamp_seconds(?:\{[^}]*\})?\s+(\S+)/m.exec(metrics)?.[1]);
    const uptime = Number(health.runtime.uptime_seconds);
    const main = Array.isArray(status?.channels) ? status.channels.find(channel => channel?.name === 'main') : null;
    const piPid = main?.details?.find?.(detail => detail?.key === 'pid')?.value;
    const name = status?.tunnel_metadata?.Name || 'Chappie';
    const title = [`otunnel ${health.runtime.version || ''}`.trim(), status?.control_plane_tunnel_id,
      piPid ? `pi --chappie PID ${piPid}` : null, `生命周期 ${health.runtime.lifecycle}`].filter(Boolean).join(' · ');
    const pollAge = lastPoll > 0 ? now / 1000 - lastPoll : null;
    // otunnel 不记录轮询失败的状态码，只按类别计数；实测 other 多为上游 503/504（服务端故障，重启隧道无效）
    const errors = {};
    for (const m of metrics.matchAll(/^commands_poll_errors_total\{[^}]*error_kind="([^"]+)"[^}]*\}\s+(\S+)/gm)) errors[m[1]] = Number(m[2]);
    const errorText = Object.entries(errors).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ');
    const failing = errorText ? `；累计失败 ${errorText}` : '';
    const stallTitle = [title, '轮询失败多为 OpenAI 隧道接口 503/504：服务端故障，重启隧道无效，等它恢复'].join('\n');
    if (!health.live || !health.ready || health.runtime.lifecycle !== 'running')
      return result('not-ready', 'warn', `${name} 隧道未就绪（${health.runtime.lifecycle}）`, title);
    if (main && main.enabled === false) return result('no-channel', 'warn', `${name} 隧道已连接，但 pi --chappie 通道未启用`, title);
    if (pollAge != null && pollAge > POLL_STALE_SEC)
      return result('stalled', pollAge > POLL_BAD_SEC ? 'bad' : 'warn',
        `${name} 隧道轮询停滞 ${fmtAge(pollAge)}（已运行 ${fmtAge(uptime)}${failing}）`, stallTitle, { stalledSec: Math.round(pollAge) });
    if (pollAge == null && uptime > POLL_STALE_SEC)
      return result('no-poll', uptime > POLL_BAD_SEC ? 'bad' : 'warn',
        `${name} 隧道运行 ${fmtAge(uptime)}，但还没有成功轮询${failing}`, stallTitle, { stalledSec: Math.round(uptime) });
    return result('ok', 'ok', `${name} 隧道已连接 · 运行 ${fmtAge(uptime)}${pollAge != null ? ` · 轮询 ${fmtAge(pollAge)}前` : ''}`, title);
  }

  globalThis.__cvTunnel = { check, fmtAge, DEFAULT_PORT, POLL_STALE_SEC, POLL_BAD_SEC };
})();
