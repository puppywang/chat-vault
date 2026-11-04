// 扩展图标角标：同步结果与 Chappie 隧道状态共用一个角标，按优先级合成，互不覆盖。
//   正在读对话「↓」（蓝）> 同步成功的 ✓（闪 3 秒）> 隧道不可用「断」（红：未运行或轮询停滞 5 分钟）
//   > 隧道异常「!」（橙）> 读对话因 429 暂停「停」（橙）> 同步失败「!」（红）> 空
// 隧道排在「停」前面：2026-10-16 隧道轮询停滞时角标一直显示「停」，把隧道警告盖住了。
// 状态存在 chrome.storage.session：service worker 休眠重启后仍按原状态合成。

const KEY = 'cvBadgeV1';
const FLASH_MS = 3000;
const TITLE = 'ChatVault 同步';

/** 纯函数：状态 → 角标文字、颜色、悬停标题。 */
export function badgeView(state = {}, now = Date.now()) {
  const tunnel = state.tunnel;
  const tunnelTitle = tunnel && tunnel.kind !== 'ok' && tunnel.code !== 'foreign' ? tunnel.text : '';
  const title = [TITLE, state.fetching ? '正在读取对话' : '', tunnelTitle,
    state.paused ? '读取对话已因限流（429）暂停：打开弹窗点「恢复读取」' : '',
    state.syncBad ? `同步失败：${state.syncError || '见弹窗'}` : ''].filter(Boolean).join('\n');
  if (state.fetching) return { text: '↓', color: '#2563eb', title };
  if (state.flashUntil > now) return { text: '✓', color: '#22c55e', title };
  if (tunnel?.kind === 'bad') return { text: '断', color: '#dc2626', title };
  if (tunnel?.kind === 'warn' && tunnel.code !== 'foreign') return { text: '!', color: '#d97706', title };
  if (state.paused) return { text: '停', color: '#ea580c', title };
  if (state.syncBad) return { text: '!', color: '#ef4444', title };
  return { text: '', color: '#22c55e', title };
}

export function createBadge({ action = chrome.action, session = chrome.storage.session, now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let cache = null;
  let queue = Promise.resolve();
  const read = async () => {
    if (cache) return cache;
    try { cache = (await session.get({ [KEY]: {} }))?.[KEY] || {}; } catch { cache = {}; }
    return cache;
  };
  const paint = async () => {
    const view = badgeView(await read(), now());
    try {
      await action.setBadgeText({ text: view.text });
      if (view.text) await action.setBadgeBackgroundColor({ color: view.color });
      await action.setTitle({ title: view.title });
    } catch (err) { console.debug('[ChatVault badge]', err?.message || err); }
    return view;
  };
  // 串行合并：同步回调和定时检查同时到达时不会互相丢更新。
  const update = patch => (queue = queue.catch(() => {}).then(async () => {
    cache = { ...(await read()), ...patch };
    try { await session.set({ [KEY]: cache }); } catch { /* session 不可用时只保留内存 */ }
    return paint();
  }));
  return {
    syncResult(ok, error = '') {
      const done = update(ok ? { syncBad: false, syncError: '', flashUntil: now() + FLASH_MS }
        : { syncBad: true, syncError: String(error).slice(0, 120), flashUntil: 0 });
      if (ok) schedule(() => { void (queue = queue.catch(() => {}).then(paint)); }, FLASH_MS + 100);
      return done;
    },
    tunnel(state) {
      const valid = state && typeof state.code === 'string' && state.code !== 'off';
      return update({ tunnel: valid ? { code: state.code, kind: state.kind, text: String(state.text || '').slice(0, 160) } : null });
    },
    fetching: active => update({ fetching: !!active }),
    paused: paused => update({ paused: !!paused }),
    repaint: () => (queue = queue.catch(() => {}).then(paint)),
  };
}
