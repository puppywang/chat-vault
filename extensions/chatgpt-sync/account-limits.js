// 弹窗「账号额度」：显示页面打开对话时 conversation/init 返回的额度信息（content.js 存在 cvAccountLimitsV1）。
// 不额外请求；数据随打开或刷新 ChatGPT 对话页更新。
(() => {
  const $card = document.getElementById('limitsCard');
  if (!$card) return;
  const $body = document.getElementById('limitsBody'), $at = document.getElementById('limitsAt');
  const FEATURE_NAMES = { deep_research: '深度研究', image_gen: '生成图片' };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pad = n => String(n).padStart(2, '0');
  const when = iso => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const hours = (d.getTime() - Date.now()) / 3600e3;
    const rel = hours <= 0 ? '已到' : hours < 1 ? `${Math.max(1, Math.round(hours * 60))} 分钟后` : hours < 48 ? `${Math.round(hours)} 小时后` : `${Math.round(hours / 24)} 天后`;
    return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${rel}）`;
  };
  const line = (...children) => { const d = el('div', 'pi-head codex-env'); d.append(...children); return d; };

  function paint(v) {
    $body.replaceChildren();
    if (!v) { $body.append(el('div', 'hint', '打开或刷新任意 ChatGPT 对话页后显示')); $at.textContent = ''; return; }
    const at = new Date(v.at);
    $at.textContent = Number.isFinite(at.getTime()) ? `更新于 ${at.getMonth() + 1}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}` : '';
    const blocked = Array.isArray(v.blocked_features) ? v.blocked_features : [];
    const models = Array.isArray(v.model_limits) ? v.model_limits : [];
    if (blocked.length || models.length) {
      for (const b of blocked) {
        const badge = el('span', 'pi-badge wait', '受限');
        badge.title = b.call_to_action?.length ? `页面引导：${b.call_to_action.join('、')}` : '';
        $body.append(line(badge, el('span', null, b.description || '部分功能受限')));
        $body.append(el('div', 'hint pi-sub', [b.limit != null ? `上限 ${b.limit} 次` : '', b.resets_after ? `恢复 ${when(b.resets_after)}` : ''].filter(Boolean).join(' · ')));
      }
      if (models.length) {
        const sub = el('div', 'hint pi-sub', `受限模型：${models.map(m => m.model_slug).join('、')}`);
        sub.title = models.map(m => `${m.model_slug} 恢复 ${when(m.resets_after)}`).join('\n');
        $body.append(sub);
      }
    } else {
      $body.append(line(el('span', 'pi-badge on', '无限制'), el('span', 'hint', '当前没有受限的模型或功能')));
    }
    if (v.default_model_slug) {
      const d = el('div', 'hint pi-sub', `当前默认模型：${v.default_model_slug}`);
      if (v.intended_default_model_slug && v.intended_default_model_slug !== v.default_model_slug) d.textContent += `（原本是 ${v.intended_default_model_slug}）`;
      $body.append(d);
    }
    for (const p of Array.isArray(v.limits_progress) ? v.limits_progress : []) {
      $body.append(el('div', 'hint pi-sub', `${FEATURE_NAMES[p.feature_name] || p.feature_name}：剩 ${p.remaining} 次${p.reset_after ? `，${when(p.reset_after)}恢复` : ''}`));
    }
  }

  // 本周 Pro 用量的本地估算（ChatVault /api/chatgpt/pro-usage）：服务端不返回已用次数，只能按归档的对话数。
  // 上限只有受限时接口才给（Pro Lite 为 50），记住最近一次看到的值。
  const $usage = document.getElementById('limitsUsage');
  async function paintUsage(v) {
    if (!$usage) return;
    const blocked = (Array.isArray(v?.blocked_features) ? v.blocked_features : []).find(b => b?.resets_after);
    if (Number.isFinite(blocked?.limit)) { try { await chrome.storage.local.set({ cvProLimitV1: blocked.limit }); } catch { /* ignore */ } }
    const { cvProLimitV1: limit } = await chrome.storage.local.get({ cvProLimitV1: null }).catch(() => ({}));
    const reply = await chrome.runtime.sendMessage({ type: 'piApi', method: 'POST', path: '/api/chatgpt/pro-usage',
      body: { resetsAfter: blocked?.resets_after || null } }).catch(err => ({ ok: false, error: err.message }));
    $usage.replaceChildren();
    if (!reply?.ok) { $usage.append(el('div', 'hint pi-sub', `本周 Pro 用量估算不可用：${reply?.error || 'ChatVault 未运行'}`)); return; }
    const near = Number.isFinite(limit) && reply.count >= limit * 0.8;
    const since = reply.sinceReset;
    const sinceDate = since ? new Date(since.at) : null;
    const scope = sinceDate && Number.isFinite(sinceDate.getTime())
      ? `自 ${sinceDate.getMonth() + 1}-${pad(sinceDate.getDate())} 恢复后` : '近 7 天';
    const badge = el('span', `pi-badge ${Number.isFinite(limit) && reply.count >= limit ? 'wait' : near ? 'wait' : 'on'}`,
      `${scope} Pro 约 ${reply.count}${Number.isFinite(limit) ? `/${limit}` : ''} 次`);
    badge.title = ['本地估算：按扩展归档的对话，数你发出、由 Pro 模型回答的消息（一条消息算一次，模型中途调用工具不另算）。',
      '没在这个浏览器打开过的对话、手机端发的消息不在里面；受限后仍标为 Pro 的消息也会被算进去。',
      since ? `上次受限的恢复时刻是 ${when(since.at)}${since.source === 'inferred' ? '（推定）' : ''}，额度从那时清零重计；恢复超过 7 天后改回滚动 7 天。` : '',
      reply.nextFreeAt ? `按滚动 7 天，最早一条在 ${when(reply.nextFreeAt)}移出窗口。` : '',
      reply.byDay ? `按天：${Object.entries(reply.byDay).map(([d, n]) => `${d} ${n}`).join('，')}` : ''].filter(Boolean).join('\n');
    $usage.append(line(badge, el('span', 'hint', `估算 · ${reply.conversations} 个对话`)));
    if (reply.resetWindowCount != null)
      $usage.append(el('div', 'hint pi-sub', `按恢复时刻往前 7 天算：${reply.resetWindowCount} 次`));
  }

  const load = v => { paint(v); void paintUsage(v).catch(() => {}); };
  chrome.storage.local.get({ cvAccountLimitsV1: null }).then(o => load(o?.cvAccountLimitsV1)).catch(() => load(null));
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.cvAccountLimitsV1) load(changes.cvAccountLimitsV1.newValue);
  });
})();
