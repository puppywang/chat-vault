import './codex-association.js';
const KEY = 'codexLookupHistory';
const MAX = 30, TTL = 2 * 24 * 60 * 60 * 1000;
let writes = Promise.resolve();
export function rememberCodexLookup(record, sender, storage = chrome.storage.local, now = Date.now()) {
  let url;
  try { url = new URL(sender?.tab?.url); } catch { return Promise.resolve({ ok: false, error: 'invalid_sender' }); }
  const cid = /^\/c\/([0-9a-f-]{36})(?:\/|$)/i.exec(url.pathname)?.[1]?.toLowerCase();
  if (url.protocol !== 'https:' || !['chatgpt.com', 'chat.openai.com'].includes(url.hostname)
    || (sender.frameId != null && sender.frameId !== 0) || !cid || cid !== record?.conversationId)
    return Promise.resolve({ ok: false, error: 'invalid_sender' });
  // Re-sanitize at the receiving boundary even if the page claims it is already sanitized.
  const safe = globalThis.__cvCodexAssociation.record({ ...record, diagnostics: { ...record.statistics,
    scope: record.scope, partial: record.partial, probes: record.probes } }, {
    conversationId: cid, lookupId: record.lookupId, deepScan: record.mode === 'history' });
  const job = writes.catch(() => {}).then(async () => {
    const saved = await storage.get({ [KEY]: [] });
    const history = (Array.isArray(saved[KEY]) ? saved[KEY] : []).filter(row =>
      Number.isFinite(Date.parse(row?.recordedAt)) && now - Date.parse(row.recordedAt) <= TTL
      && (!safe.lookupId || row.lookupId !== safe.lookupId));
    await storage.set({ [KEY]: [safe, ...history].slice(0, MAX) });
    return { ok: true, recordedAt: safe.recordedAt };
  });
  writes = job;
  return job.catch(() => ({ ok: false, error: 'journal_storage_failed' }));
}
