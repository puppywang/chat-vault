// 大对话分块上传的后台暂存（发送方见 content.js sendSync）。
//
// runtime.sendMessage 单条消息上限 64 MiB，Work 模式的长轮次能让整段对话超过这个数，所以内容脚本把序列化后的
// JSON 切块发来，这里按 uploadId 暂存，收到 type:'sync' 时拼回。只收 ChatGPT 标签页发来的块；
// service worker 被回收或标签页中途放弃时，过期的半截上传在下次收块时清掉。
const CHATGPT_TAB = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

export function createSyncChunks({ ttlMs = 2 * 60_000, now = () => Date.now() } = {}) {
  const uploads = new Map();   // uploadId → { tabId, total, parts, at }

  function accept(msg, sender) {
    if (!CHATGPT_TAB.test(sender?.tab?.url || '')) return { ok: false, error: 'invalid_sender' };
    const { uploadId, index, total, data } = msg || {};
    if (typeof uploadId !== 'string' || !Number.isInteger(index) || !Number.isInteger(total)
      || total < 1 || index < 0 || index >= total || typeof data !== 'string') return { ok: false, error: 'invalid_chunk' };
    const t = now();
    for (const [id, up] of uploads) if (t - up.at > ttlMs) uploads.delete(id);
    let up = uploads.get(uploadId);
    if (!up) uploads.set(uploadId, up = { tabId: sender.tab.id, total, parts: new Array(total), at: t });
    if (up.tabId !== sender.tab.id || up.total !== total) return { ok: false, error: 'invalid_chunk' };
    up.parts[index] = data;
    up.at = t;
    return { ok: true };
  }

  /** 拼回完整 JSON 文本；失效或缺块时返回 { error }。无论成败都释放暂存。 */
  function take(uploadId, sender) {
    const up = uploads.get(uploadId);
    uploads.delete(uploadId);
    if (!up || up.tabId !== sender?.tab?.id) return { error: '分块上传已失效（扩展后台可能被重启），下次同步会重试' };
    // parts 是稀疏数组，some() 会跳过空洞，逐个下标检查
    for (let i = 0; i < up.total; i++) {
      if (typeof up.parts[i] !== 'string') return { error: '分块上传不完整，下次同步会重试' };
    }
    return up.parts.join('');
  }

  return { accept, take, size: () => uploads.size };
}
