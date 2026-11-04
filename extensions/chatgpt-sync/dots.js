// Dots uses Calpico room messages, not the ordinary conversation tree or token stream.
(() => {
  // 同一环境被重复注入（补注入与注册注入撞在一起）时不起第二份：两份标题脚本互改曾锁死整个渲染进程。
  if (globalThis.__cvDots) return;
  const PAGE_SIZE = 32;
  const cache = new Map();
  const pending = new Map();
  const dotsId = (path = location.pathname) => /^\/dots\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(path)?.[1] || null;
  const conversationId = (path = location.pathname) => {
    const dot = dotsId(path);
    return dot ? `dots-${dot}` : /\/c\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(path)?.[1] || null;
  };

  function normalize(threadId, dot, room, items) {
    const assistants = new Set((room.members || []).filter(member => member.aeon_id === dot.id)
      .map(member => member.account_user_id));
    if (!assistants.size) throw new Error('Dots room 缺少 dots 成员身份，不能可靠区分消息角色');
    const messages = [...items].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
      || String(a.id).localeCompare(String(b.id)));
    const mapping = {};
    let previous = null;
    for (const raw of messages) {
      if (!raw.id) continue;
      const role = assistants.has(raw.account_user_id) ? 'assistant' : 'user';
      const message = { id: raw.id, author: { role }, create_time: Date.parse(raw.created_at) / 1000,
        update_time: Date.parse(raw.updated_at || raw.created_at) / 1000,
        content: { content_type: 'text', parts: [raw.content?.text || ''] },
        metadata: { dots_message: raw, dots_room_id: room.id } };
      mapping[raw.id] = { id: raw.id, message, parent: previous, children: [] };
      if (previous) mapping[previous].children.push(raw.id);
      previous = raw.id;
    }
    return { conversation_id: `dots-${threadId}`, title: `Dots · ${dot.display_name || room.name || threadId}`,
      cv_source: 'dots', dots_thread_id: threadId, dots_room_id: room.id,
      source_url: `https://chatgpt.com/dots/${threadId}`,
      create_time: Date.parse(room.created_at) / 1000,
      update_time: Math.max(Date.parse(room.updated_at) / 1000 || 0,
        ...messages.map(m => Date.parse(m.updated_at || m.created_at) / 1000 || 0)),
      current_node: previous, mapping };
  }

  async function fetchConversation(threadId, getJson) {
    if (pending.has(threadId)) return pending.get(threadId);
    const task = (async () => {
      const prior = cache.get(threadId);
      const dot = prior?.dot || await getJson(`/backend-api/tbo/by-thread/${threadId}`);
      if (!dot.messaging_room_id) throw new Error('Dots 没有 messaging_room_id');
      const base = `/backend-api/messaging/rooms/${encodeURIComponent(dot.messaging_room_id)}`;
      const [room, latest] = await Promise.all([getJson(base), getJson(`${base}/messages?limit=${PAGE_SIZE}`)]);
      if (!Array.isArray(latest.items)) throw new Error('Dots messages 结构未知');
      const items = new Map(prior?.items || []);
      let page = latest.items;
      // prev_cursor 实测为 null，但仍有旧消息；用已验证的 before=<完整消息 ID> 回补。
      // 刷新时只回补到与缓存相交处，不反复下载完整历史，也不能漏掉离线期间 >32 条的新消息。
      while (page.length) {
        const overlap = page.some(m => items.has(m.id));
        let added = 0;
        for (const item of page) {
          if (!items.has(item.id)) added++;
          items.set(item.id, item);
        }
        if (overlap || page.length < PAGE_SIZE || !added) break;
        const oldest = page.reduce((a, b) => Date.parse(a.created_at) <= Date.parse(b.created_at) ? a : b);
        const older = await getJson(`${base}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldest.id)}`);
        if (!Array.isArray(older.items)) throw new Error('Dots 历史 messages 结构未知');
        page = older.items;
      }
      cache.set(threadId, { dot, items });
      return normalize(threadId, dot, room, items.values());
    })();
    pending.set(threadId, task);
    try { return await task; } finally { pending.delete(threadId); }
  }

  function lastRow() {
    const rows = document.querySelectorAll('.message-row[data-message-id]');
    return rows[rows.length - 1] || null;
  }
  function isWaiting() {
    return !!dotsId() && !!lastRow()?.classList.contains('self');
  }
  globalThis.__cvDots = { dotsId, conversationId, normalize, fetchConversation, isWaiting };
})();
