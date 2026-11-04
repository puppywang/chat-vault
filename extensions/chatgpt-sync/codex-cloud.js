// Codex Cloud（chatgpt.com/local/<thread-id>）独立归档。
//
// 这类页面不是普通 ChatGPT 对话：没有 /backend-api/conversation 的 mapping 树，
// 数据在 wss://codex-cloud-backend.chatgpt.com 的 RPC 里（thread/read + thread/items/list）。
// 本期按用户要求「只作为独立对话导入」，不建立与 /c/ 对话的关联关系。
//
// 做法与 dots.js 同构：取到原生数据后就地转换成 ChatGPT 的 mapping 形态，
// 这样 ChatVault 服务端不需要第二套解析器——角色/正文的判定规则只有一份。
(() => {
  // 同一环境被重复注入（补注入与注册注入撞在一起）时不起第二份。
  if (globalThis.__cvCodexCloud) return;

  const KEY_PREFIX = 'codex-';
  const PAGE_SIZE = 100;
  // 实测每页 100 条约 1.3–1.7 秒、原始 ~6KB/条；单次最多翻这么多页，避免异常分页把页面拖死。
  // 触顶不是丢数据：续取点会留在原处，下一次同步接着往后取。
  const MAX_PAGES = 100;
  const TOOL_TEXT_LIMIT = 4000; // 工具参数/结果落库前的上限，和服务端的截断口径一致

  const threadId = (path = location.pathname) =>
    /^\/local\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/
      .exec(path)?.[1]?.toLowerCase() || null;

  const conversationId = (path = location.pathname) => {
    const id = threadId(path);
    return id ? KEY_PREFIX + id : null;
  };

  const isKey = (id) => typeof id === 'string' && id.startsWith(KEY_PREFIX);

  function clip(value, limit = TOOL_TEXT_LIMIT) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    if (typeof text !== 'string') return '';
    return text.length > limit ? `${text.slice(0, limit)}\n…(截断，共 ${text.length} 字符)` : text;
  }

  /** userMessage.content 是 [{type:'text', text}]；也兜住纯字符串与未知分片 */
  function partsText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }

  /** reasoning.summary / .content 都是数组，元素可能是字符串或 {text} */
  function reasoningText(item) {
    const chunks = [...(Array.isArray(item.summary) ? item.summary : []),
      ...(Array.isArray(item.content) ? item.content : [])];
    return chunks.map((chunk) => typeof chunk === 'string' ? chunk
      : chunk && typeof chunk === 'object' ? (chunk.text || chunk.summary || '') : '')
      .filter(Boolean).join('\n\n').trim();
  }

  /** mcpToolCall.result 实测是 {content, structuredContent, _meta}；content 多为 [{type:'text',text}] */
  function toolResultText(item) {
    if (item.error != null) return `ERROR: ${clip(item.error, 1000)}`;
    const result = item.result;
    if (result == null) return '';
    const inner = partsText(result.content);
    if (inner) return inner;
    return clip(result.structuredContent ?? result);
  }

  /**
   * 把 Codex 的 item 列表摊成 ChatGPT 的 mapping 链。
   *
   * 角色用服务端解析器已支持的 content_type 表达，不新增规则：
   *   userMessage       → role user  + text
   *   agentMessage      → role assistant + text
   *   reasoning         → role assistant + thoughts（服务端判成 thinking）
   *   mcpToolCall       → 拆成「调用」(assistant+recipient+code) 与「结果」(role tool) 两条
   *   subAgentActivity  → role assistant + recipient=subagent（服务端判成 tool）
   *   其它未知类型      → role tool，保留 JSON 摘要，不丢数据
   */
  function normalize(id, thread, rows, { truncated = false } = {}) {
    const mapping = {};
    let previous = null;
    let index = 0;

    const push = (nodeId, message) => {
      mapping[nodeId] = { id: nodeId, message, parent: previous, children: [] };
      if (previous) mapping[previous].children.push(nodeId);
      previous = nodeId;
    };

    for (const row of rows) {
      const item = row?.item;
      if (!item) continue;
      // row 的时间是毫秒；ChatGPT 的 create_time 是秒
      const at = Number.isFinite(row.startedAtMs) ? row.startedAtMs / 1000 : null;
      const done = Number.isFinite(row.completedAtMs) ? row.completedAtMs / 1000 : at;
      const base = (role, content, extra = {}) => ({
        id: String(item.id || `cc-${index}`),
        author: { role, name: extra.name, metadata: {} },
        create_time: at, update_time: done,
        content,
        metadata: { codex_turn_id: row.turnId || null, codex_item_type: item.type || null,
          ...(extra.metadata || {}) },
        recipient: extra.recipient || 'all',
      });
      const nodeId = `${item.id || 'item'}-${index++}`;

      switch (item.type) {
        case 'userMessage':
          push(nodeId, base('user', { content_type: 'text', parts: [partsText(item.content)] },
            { metadata: { codex_client_id: item.clientId || null } }));
          break;

        case 'agentMessage':
          push(nodeId, base('assistant', { content_type: 'text', parts: [String(item.text ?? '')] },
            { metadata: { codex_phase: item.phase || null } }));
          break;

        case 'reasoning': {
          const text = reasoningText(item);
          if (!text) break; // 空的推理块不落库
          push(nodeId, base('assistant', { content_type: 'thoughts', thoughts: [{ content: text }] }));
          break;
        }

        case 'mcpToolCall': {
          const name = [item.server, item.tool].filter(Boolean).join('.') || 'tool';
          push(nodeId, base('assistant',
            { content_type: 'code', language: 'json', text: clip(item.arguments ?? {}) },
            { recipient: name, metadata: { codex_tool_status: item.status || null,
              codex_tool_duration_ms: item.durationMs ?? null } }));
          const text = toolResultText(item);
          if (text) {
            push(`${nodeId}-result`, {
              id: `${item.id || nodeId}-result`,
              author: { role: 'tool', name, metadata: {} },
              create_time: done, update_time: done,
              content: { content_type: 'text', parts: [clip(text)] },
              metadata: { codex_turn_id: row.turnId || null, codex_item_type: 'mcpToolCallResult',
                codex_tool_status: item.status || null },
              recipient: 'all',
            });
          }
          break;
        }

        case 'subAgentActivity': {
          const detail = [item.kind, item.model, item.agentPath].filter(Boolean).join(' · ');
          push(nodeId, base('assistant',
            { content_type: 'text', parts: [detail || '(子 agent 活动)'] },
            { recipient: 'subagent', metadata: { codex_sub_agent_thread_id: item.agentThreadId || null,
              codex_sub_agent_kind: item.kind || null } }));
          break;
        }

        default:
          // 未知类型保底：角色 tool，留可读摘要。Codex 会加新 item 类型，不能静默丢。
          push(nodeId, {
            id: String(item.id || nodeId),
            author: { role: 'tool', name: String(item.type || 'codex-item'), metadata: {} },
            create_time: at, update_time: done,
            content: { content_type: 'text', parts: [clip(item)] },
            metadata: { codex_turn_id: row.turnId || null, codex_item_type: item.type || null },
            recipient: 'all',
          });
      }
    }

    // 触顶时明确写进归档：宁可留一条说明，也不要让人以为这就是全部
    if (truncated) {
      push(`cc-truncated-${index}`, {
        id: `cc-truncated-${index}`,
        author: { role: 'system', name: 'codex-cloud', metadata: {} },
        create_time: null, update_time: null,
        content: { content_type: 'system_error', name: 'codex-cloud',
          text: `本次只读取了前 ${rows.length} 条 item（单次翻页上限 ${MAX_PAGES} 页）；下次同步会从断点继续。` },
        metadata: { codex_truncated: true },
        recipient: 'all',
      });
    }

    // thread.name 实测可能为空，回退到首条用户消息
    const firstUser = Object.values(mapping)
      .find((node) => node.message?.author?.role === 'user');
    const fallback = partsText(firstUser?.message?.content?.parts).trim().split('\n')[0];
    const title = String(thread?.name || '').trim()
      || (fallback ? fallback.slice(0, 80) : `Codex ${id.slice(0, 8)}`);

    const times = Object.values(mapping).map((n) => n.message?.update_time)
      .filter((t) => Number.isFinite(t));
    return {
      conversation_id: KEY_PREFIX + id,
      title: `Codex Cloud · ${title}`,
      cv_source: 'codex-cloud',
      codex_thread_id: id,
      codex_cwd: thread?.cwd || null,
      codex_model: thread?.model || null,
      source_url: `https://chatgpt.com/local/${id}?hostId=local`,
      create_time: Number.isFinite(thread?.createdAt) ? thread.createdAt : (times[0] ?? null),
      update_time: Number.isFinite(thread?.updatedAt) ? thread.updatedAt
        : (times.length ? Math.max(...times) : null),
      current_node: previous,
      mapping,
    };
  }

  // 已取到的 items 按 thread 缓存。实测全量翻页对活跃 thread 很慢（CDP 15 秒超时都不够），
  // 而同步每 2 分钟回补一次，不能每次都从头重下。
  // asc 排序下新 item 追加在尾部，所以记住「最后一个非空游标」作为续取点，
  // 下次从那里重取最后一页并继续——重叠部分按 item 身份去重，不会重复。
  const cache = new Map();
  const pending = new Map();

  /** 一行 item 的稳定身份：优先 item.id，没有就退回「轮次+类型+起始时刻」 */
  function rowKey(row, fallbackIndex) {
    const item = row?.item || {};
    if (item.id) return String(item.id);
    return `${row?.turnId || '?'}|${item.type || '?'}|${row?.startedAtMs ?? fallbackIndex}`;
  }

  async function readPages(session, id, startCursor) {
    const rows = [];
    let cursor = startCursor;
    let resume = startCursor;
    let truncated = false;
    const seen = new Set();
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) { truncated = true; break; }
      const result = await session.request('thread/items/list',
        { threadId: id, cursor, limit: PAGE_SIZE, sortDirection: 'asc' });
      if (!Array.isArray(result?.data)) throw new Error('Codex items 列表格式无效');
      rows.push(...result.data);
      const next = result.nextCursor ?? null;
      if (!next) break;
      if (seen.has(next)) throw new Error('Codex items 分页未向前推进');
      seen.add(next);
      resume = next; // 只在确实还有下一页时推进续取点，保证它永远指向「最后一页的起点」
      cursor = next;
    }
    return { rows, resume, truncated };
  }

  /**
   * 取一个 thread 的内容。connect 由 codex-thread.js 提供（只读方法白名单内）。
   * 同一 thread 的并发请求合并成一个，避免定时回补和手动同步撞在一起各下一份。
   */
  async function fetchConversation(id, token, { connect = globalThis.__cvCodexThread?.connect } = {}) {
    if (!connect) throw new Error('Codex 读取模块未就绪，请刷新页面');
    if (pending.has(id)) return pending.get(id);
    const task = (async () => {
      const session = await connect(token);
      try {
        const read = await session.request('thread/read', { threadId: id });
        const thread = read?.thread || read || {};
        const prior = cache.get(id);
        const items = new Map(prior?.items || []);
        let page;
        try {
          page = await readPages(session, id, prior?.resume ?? null);
        } catch (error) {
          // 续取点可能因服务端数据变化失效：退回全量重取一次，不要让同步卡死
          if (!prior?.resume) throw error;
          cache.delete(id);
          page = await readPages(session, id, null);
          items.clear();
        }
        page.rows.forEach((row, i) => items.set(rowKey(row, items.size + i), row));
        cache.set(id, { items, resume: page.resume });
        return normalize(id, thread, [...items.values()], { truncated: page.truncated });
      } finally {
        session.close();
      }
    })();
    pending.set(id, task);
    try { return await task; } finally { pending.delete(id); }
  }

  globalThis.__cvCodexCloud = { version: globalThis.__cvPage?.version || 'unknown', threadId, conversationId, isKey, normalize, fetchConversation };
})();
