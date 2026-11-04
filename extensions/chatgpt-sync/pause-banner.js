// 弹窗顶部「读取对话已暂停」提示：任一标签页碰到 429 后，扩展停止自己读对话，等用户在这里手动恢复。
(() => {
  const KEY = 'cvConversationPauseV1';
  const $box = document.getElementById('pauseBanner');
  if (!$box) return;
  const $text = document.getElementById('pauseText'), $resume = document.getElementById('pauseResume');
  const pad = n => String(n).padStart(2, '0');
  function paint(p) {
    $box.hidden = !p;
    if (!p) return;
    const at = new Date(p.at || Date.now());
    const mins = Math.max(0, Math.round((Date.now() - at.getTime()) / 60000));
    $text.textContent = `读取对话已暂停：${at.getMonth() + 1}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}（${mins} 分钟前）碰到限流（429）`
      + (Number.isFinite(p.retryAfterSec) ? `，服务端当时要求等 ${p.retryAfterSec} 秒` : '')
      + '。暂停期间扩展不再自己读对话（页面自己读到的照常同步）。';
  }
  $resume.addEventListener('click', async () => {
    try { await chrome.storage.local.remove(KEY); } catch { /* ignore */ }
    paint(null);
  });
  chrome.storage.local.get({ [KEY]: null }).then(o => paint(o?.[KEY])).catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && changes[KEY]) paint(changes[KEY].newValue); });
})();
