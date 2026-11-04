// Independent of view routing: polling updates only these status containers,
// leaving settings form values, conversation scroll and the open panel intact.
(() => {
  let latest = null, failure = '', busy = false, timer;
  const labels = { ok: '正常', running: '进行中', failed: '失败', overdue: '已逾期',
    disabled: '未启用', unconfigured: '未配置', unknown: '等待确认', paused: '已暂停', unconfirmed: '计划待确认' };
  const phases = { starting: '计划任务启动中', snapshot: '创建一致性快照', compact: '裁剪检索索引',
    verify_local: '校验本地快照', hash: '计算快照校验值', upload: '上传中', verify_remote: '校验云端副本', retention: '整理备份历史' };
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const date = x => x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';
  const tone = s => ['failed', 'overdue'].includes(s) ? 'bad' : s === 'running' ? 'active' : s === 'ok' ? 'good' : 'muted';
  const badge = (name, s) => `<span class="sync-badge ${tone(s)}"><i></i>${name ? esc(name) + ' · ' : ''}${esc(labels[s] || '未知')}</span>`;
  const row = (k, v) => `<div class="sync-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
  window.renderSyncStatus = () => {
    if (failure) return `<div class="sync-error" role="status">状态暂不可用：${esc(failure)}。恢复连接后自动重试。</div>`;
    if (!latest) return '<p class="set-hint">正在读取同步状态…</p>';
    const { local: l, backup: b, checkedAt } = latest;
    const s = b.schedule || {};
    const schedule = s.status === 'ready' ? (s.enabled ? '已启用' : '已停用')
      : ({ checking: '读取中…', missing: '未安装自动备份任务', unsupported: '当前系统未接入计划状态', unavailable: '计划状态不可用' }[s.status] || '未知');
    const mode = !l.enabled ? '本服务未启用文件扫描' : [l.watching ? '监听文件变化' : '文件监听已关闭',
      l.pollIntervalSec ? `每 ${l.pollIntervalSec} 秒扫描` : '无定时兜底'].join('；');
    return `<div class="sync-cards">
      <section class="sync-card"><h3>本地入库 ${badge('', l.status)}</h3>
        ${row('自动同步', mode)}
        ${l.running ? row('开始时间', date(l.startedAt)) : ''}
        ${row('最近扫描', date(l.finishedAt))}${row('最近完整成功', date(l.lastSuccessAt))}
        ${l.summary ? row('上次结果', `新增 ${l.summary.created} / 更新 ${l.summary.updated} / 未变 ${l.summary.skipped} / 失败 ${l.summary.failed}`) : ''}
        ${l.error ? `<p class="sync-error">${esc(l.error)}</p>` : ''}
        ${l.summary?.failures?.length ? `<ul class="sync-errors">${l.summary.failures.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        <p class="set-hint">文件没有变化时不会反复扫描。此处记录文件扫描结果，浏览器直接推送的入库另行处理。</p>
      </section>
      <section class="sync-card"><h3>云端备份 ${badge('', b.status)}</h3>
        ${b.phase ? row('当前阶段', phases[b.phase] || b.phase) + row('开始时间', date(b.startedAt)) : ''}
        ${row('最近成功上传', date(b.lastSuccessAt))}${row('最近云端确认', date(b.lastVerifiedAt))}
        ${row('最近执行', date(b.lastAttemptAt))}${row('自动备份任务', schedule)}
        ${row('下次计划', s.enabled ? date(s.nextRunAt) : '暂无可用计划')}
        ${s.status === 'ready' ? row('任务最近退出码', s.running ? '运行中' : String(s.lastResult)) : ''}
        ${b.counts ? row('已备份数据', `${b.counts.sessions} 个对话 / ${Number(b.counts.messages).toLocaleString()} 条消息${b.sizeBytes ? ` / ${(b.sizeBytes / 1048576).toFixed(1)} MiB` : ''}`) : ''}
        ${b.error ? `<p class="sync-error">${esc(b.error)}</p>` : ''}
        ${b.status === 'overdue' ? `<p class="sync-error">超过 ${b.overdueAfterHours} 小时未确认云端副本，请检查备份任务。</p>` : ''}
        <p class="set-hint">云端确认来自备份时保存的校验结果；此面板每 15 秒读取本地状态，不持续连接云端。计划时间以 Windows 任务计划程序为准。</p>
      </section></div><p class="sync-checked">状态读取于 ${esc(date(checkedAt))}</p>`;
  };
  function paint() {
    const label = document.getElementById('sync-status-label');
    if (label) label.innerHTML = failure ? '<span class="sync-badge bad"><i></i>同步状态不可用</span>'
      : latest ? badge('入库', latest.local.status) + badge('备份', latest.backup.status) : '同步状态…';
    for (const id of ['sync-status-content', 'settings-sync-status']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = window.renderSyncStatus();
    }
  }
  window.refreshSyncStatus = async () => {
    if (busy) return;
    clearTimeout(timer);
    busy = true;
    try {
      const response = await fetch('/api/sync-status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.local || !data.backup) throw new Error('服务尚未提供同步状态');
      latest = data; failure = '';
    } catch (e) { failure = e.name === 'TimeoutError' ? '服务响应超时' : e.message; }
    finally { busy = false; paint(); timer = setTimeout(() => { if (!document.hidden) window.refreshSyncStatus(); }, 15000); }
  };
  document.getElementById('sync-status-refresh')?.addEventListener('click', window.refreshSyncStatus);
  document.getElementById('sync-status')?.addEventListener('toggle', e => { if (e.target.open) window.refreshSyncStatus(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) window.refreshSyncStatus(); });
  window.addEventListener('online', window.refreshSyncStatus);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('sync-status')?.removeAttribute('open'); });
  document.addEventListener('click', e => {
    const panel = document.getElementById('sync-status');
    if (panel?.open && !panel.contains(e.target)) panel.removeAttribute('open');
  });
  window.refreshSyncStatus();
})();
