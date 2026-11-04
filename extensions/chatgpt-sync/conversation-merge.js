// 把页面自己读到的对话数据合并成一棵 mapping 树。扩展（content.js）与 ChatVault 服务端共用这一份规则。
//
// 扩展平时不自己下载对话（读历史按账号限流，约每分钟放行一次，主动读很容易 429），只用页面自己的读取：
//   GET /backend-api/conversation/<id>                 整棵树（旧前端；现在很少出现）
//   GET /backend-api/conversations/<id>?num_turns=N…   当前分支的最近 N 轮（新前端；往上翻时按游标取更早一页）
//   整页打开时服务端渲染预取到的同一份分支（React Router loaderData，见 page-conversation.js）
// 唯一的自行下载是本页新建、跑完一轮后页面不会再读的对话（content.js 的 turn_end 补读）。
// 分页只是树的一段，直接覆盖会截掉更早的历史，所以合并进已有的树：消息自带 metadata.parent_id，按真实父子关系拼接。
// 拼不上（这一段最早一条的父节点还没见过）时补一个空壳节点挂到旧的 current_node 下，先保住两头；
// 以后页面读到中间那段，真实节点会顶替空壳。空壳没有 message，解析时自动跳过。
(() => {
  const time = m => (typeof m?.update_time === 'number' ? m.update_time : null)
    ?? (typeof m?.create_time === 'number' ? m.create_time : 0);

  function linkChildren(mapping) {
    for (const node of Object.values(mapping)) node.children = [];
    for (const [id, node] of Object.entries(mapping)) {
      if (node.parent != null && mapping[node.parent]) mapping[node.parent].children.push(id);
    }
    return mapping;
  }

  /** /backend-api/conversations/<id> 的一页 → 线性 mapping，带 cv_branch 标记。 */
  function branchToConversation(id, page) {
    const messages = (Array.isArray(page?.messages) ? page.messages : []).filter(m => m && typeof m.id === 'string');
    if (!messages.length) return null;
    const ids = new Set(messages.map(m => m.id));
    const mapping = {};
    messages.forEach((message, i) => {
      const declared = typeof message.metadata?.parent_id === 'string' ? message.metadata.parent_id : null;
      const parent = i === 0 ? declared : declared && ids.has(declared) ? declared : messages[i - 1].id;
      mapping[message.id] = { id: message.id, message, parent };
    });
    const { messages: _messages, page_info: info, ...meta } = page;
    return { ...meta, conversation_id: id, mapping: linkChildren(mapping),
      // 往上翻取到的更早一页，顶层 current_node 仍是整段对话的当前叶子（可能不在这一页里），原样保留
      current_node: typeof page.current_node === 'string' ? page.current_node : messages[messages.length - 1].id,
      cv_branch: { complete: info?.has_previous_page === false, first: messages[0].id, last: messages[messages.length - 1].id } };
  }

  function ancestors(mapping, id) {
    const seen = new Set();
    while (id != null && mapping[id] && !seen.has(id)) { seen.add(id); id = mapping[id].parent; }
    return seen;
  }

  /** 从 current_node 往上能走到空壳根节点（parent 为空、没有 message）才算完整。 */
  function reachesRoot(mapping, id) {
    const seen = new Set();
    while (id != null && mapping[id] && !seen.has(id)) {
      seen.add(id);
      const node = mapping[id];
      if (node.parent == null) return !node.message && !node.cv_gap;
      id = node.parent;
    }
    return false;
  }

  /**
   * base：已有的树（可为空）；incoming：整棵树或 branchToConversation 的结果。
   * 同一条消息取较新的版本；节点的父节点一经确定不再改（ChatGPT 的树只增不改），空壳除外。
   */
  function merge(base, incoming) {
    if (!incoming?.mapping || typeof incoming.mapping !== 'object') return base;
    const { cv_branch: branch, ...inc } = incoming;
    const hasBase = base?.mapping && typeof base.mapping === 'object';
    const mapping = {};
    if (hasBase) for (const [id, node] of Object.entries(base.mapping)) mapping[id] = { ...node };
    for (const [id, node] of Object.entries(inc.mapping)) {
      const prev = mapping[id];
      const message = !prev?.message || (node.message && time(node.message) >= time(prev.message))
        ? (node.message ?? prev?.message ?? null) : prev.message;
      // 已确定的父节点不改；先前挂在空壳上的，以真实父节点为准
      const fixed = prev && !prev.cv_gap && prev.parent != null && !mapping[prev.parent]?.cv_gap;
      const parent = fixed ? prev.parent : (node.parent ?? prev?.parent ?? null);
      mapping[id] = !message && prev?.cv_gap ? { ...prev, parent } : { id, message, parent };
    }
    const incomingNewer = !hasBase || (inc.update_time ?? 0) >= (base.update_time ?? 0);
    const currentNode = incomingNewer && mapping[inc.current_node] ? inc.current_node
      : hasBase && mapping[base.current_node] ? base.current_node : inc.current_node;

    // 这一段最早一条挂不上：补空壳，挂到旧的 current_node 下（旧叶子在这一段之后时不挂，免得成环）
    if (branch && hasBase) {
      let id = branch.first ?? null;
      const top = id && mapping[id];
      const anchor = mapping[base.current_node] ? base.current_node : null;
      const missing = top && (top.parent == null ? (top.message ? `cv-gap-${id}` : null)
        : mapping[top.parent] ? null : top.parent);
      if (missing && anchor && !ancestors(mapping, anchor).has(id)) {
        top.parent = missing;
        mapping[missing] = { id: missing, message: null, parent: anchor, cv_gap: true };
      }
    }

    const meta = incomingNewer ? { ...(hasBase ? base : {}), ...inc } : { ...inc, ...base };
    delete meta.cv_branch;
    const merged = { ...meta, mapping: linkChildren(mapping), current_node: currentNode };
    merged.cv_partial = !reachesRoot(merged.mapping, currentNode);
    if (!merged.cv_partial) delete merged.cv_partial;
    return merged;
  }

  /** 是否和上次上传的是同一份：update_time、节点数、当前叶子都没变。 */
  const signature = conv => conv ? `${conv.update_time ?? ''}|${Object.keys(conv.mapping || {}).length}|${conv.current_node ?? ''}` : '';

  globalThis.ChatVaultConversationMerge = { branchToConversation, merge, signature };
})();
