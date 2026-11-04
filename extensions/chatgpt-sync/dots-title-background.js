// 后台 alarm 唤醒页面的轻量标题读取，独立于同步/耗时开关，不 attach CDP、不激活标签页。
export async function refreshDotsTitles(api = chrome) {
  const { dotsTitle, injectionEnabled } = await api.storage.local.get({ dotsTitle: true, injectionEnabled: true });
  if (!dotsTitle || !injectionEnabled) return [];
  const tabs = await api.tabs.query({ url: ['https://chatgpt.com/dots/*', 'https://chat.openai.com/dots/*'] });
  return Promise.all(tabs.filter(tab => !tab.discarded && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/dots\/[0-9a-f-]{36}(?:\/|[?#]|$)/i.test(tab.url || '')).map(async tab => {
    let timeout;
    try {
      const result = await Promise.race([
        api.tabs.sendMessage(tab.id, { type: 'refreshDotsTitle' }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('页面标题读取超时')), 2000); }),
      ]);
      return { tab_id: tab.id, ok: true, ...result };
    } catch (err) { return { tab_id: tab.id, ok: false, error: err.message }; }
    finally { clearTimeout(timeout); }
  }));
}
