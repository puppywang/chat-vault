// Correlate only incoming transport observations. No URL generation or identity promotion.
const workflow = value => typeof value === 'string' ? /^(wfr_[a-zA-Z0-9_-]+)(?:\/[^\s]+)?$/.exec(value)?.[1] || null : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function correlateUpstream(conversation, observations) {
  const contexts = new Map(), seen = new Set();
  let node = conversation?.current_node;
  if (!node) throw new Error('incomplete_conversation');
  while (node) {
    if (seen.has(node)) throw new Error('cyclic_conversation');
    seen.add(node);
    const row = conversation.mapping?.[node];
    if (!row) throw new Error('incomplete_conversation');
    const m = row.message, meta = m?.metadata, resource = meta?.invoked_resource;
    const key = workflow(meta?.request_id);
    // The sampled Chat stores wfr workflow IDs, not the incoming operation suffix or MCP callId.
    if (m?.author?.role === 'tool' && resource?.app_name === 'Chappie'
      && /^\/asdk_app_6aaba23c46648191a120d4595cb8bd7c\//.test(resource?.resource_uri || '') && key) {
      const list = contexts.get(key) || []; list.push(m.id); contexts.set(key, list);
    }
    node = row.parent;
  }
  const linked = [], missing = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (observation?.schemaVersion !== 1 || observation.boundary !== 'chappie-inbound'
      || typeof observation.upstreamSessionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(observation.upstreamSessionDigest)) continue;
    const key = workflow(observation.requestId);
    if (!key || !contexts.has(key)) continue;
    const entry = { observedAt: observation.observedAt, workflowId: key,
      conversationId: conversation.conversation_id, messageIds: contexts.get(key),
      upstreamSessionDigest: observation.upstreamSessionDigest,
      callId: observation.callId || null, threadId: observation.threadId || null,
      hostId: observation.hostId || null, accountDigest: observation.accountDigest || null,
      relation: 'same-workflow-not-same-call', verified: false,
      readCandidate: typeof observation.threadId === 'string' && UUID.test(observation.threadId) ? observation.threadId : null };
    (entry.threadId ? linked : missing).push(entry);
  }
  return { schemaVersion: 1, conversationId: conversation.conversation_id,
    status: linked.length ? 'upstream-observed-needs-validation' : missing.length ? 'upstream-thread-id-not-supplied' : 'no-matching-upstream-observation',
    workflowCount: contexts.size, linked, missing, verified: false,
    limitation: 'Workflow equality links request context, not exact MCP call identity or a readable Codex thread. A matching sessionId is never used as threadId.' };
}
