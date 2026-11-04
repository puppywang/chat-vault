// A transport completion is not necessarily the end of an asynchronous Pro turn.
export function isFinalAssistantMessage(message) {
  return message?.author?.role === 'assistant' && message.status === 'finished_successfully'
    && message.end_turn === true && !['model_editable_context', 'reasoning_recap', 'thoughts'].includes(message.content?.content_type);
}

export function snapshotFinishedForUser(conversation, userId) {
  if (!userId || !conversation?.mapping) return false;
  let id = conversation.current_node;
  if (!isFinalAssistantMessage(conversation.mapping[id]?.message)) return false;
  const seen = new Set();
  while (id && conversation.mapping[id] && !seen.has(id)) {
    seen.add(id);
    const node = conversation.mapping[id];
    if (node.message?.author?.role === 'user') return node.message.id === userId;
    id = node.parent;
  }
  return false;
}
