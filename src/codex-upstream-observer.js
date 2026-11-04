// Optional upstream transport observer. No network calls, no logs to MCP stdout, no implicit identity mapping.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SONIC = /^thread_[a-f0-9]{32}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:@~-]{0,255}$/.test(value) ? value : null;
const threadId = value => typeof value === 'string' && (UUID.test(value) || SONIC.test(value)) ? value.toLowerCase() : null;
const KNOWN = ['openai/session', 'otunnel/requestId', 'threadId', 'sessionId', 'callId', 'turnId', 'hostId', 'accountId'];
export function summarizeIncomingMeta(meta, now = new Date()) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const session = typeof meta['openai/session'] === 'string' && meta['openai/session'].length <= 2048 ? meta['openai/session'] : null;
  if (!session) return null; // Only the authenticated Chappie boundary may invoke this observer.
  const remoteThread = threadId(meta.threadId);
  return { schemaVersion: 1, boundary: 'chappie-inbound', observedAt: now.toISOString(),
    upstreamSessionDigest: hash(session), requestId: identifier(meta['otunnel/requestId']),
    callId: identifier(meta.callId), threadId: remoteThread, sessionId: threadId(meta.sessionId),
    turnId: threadId(meta.turnId), hostId: identifier(meta.hostId),
    accountDigest: typeof meta.accountId === 'string' && meta.accountId.length <= 512 ? hash(meta.accountId) : null,
    present: Object.fromEntries(KNOWN.map(key => [key, Object.hasOwn(meta, key)])),
    unrecognizedKeyCount: Object.keys(meta).filter(key => !KNOWN.includes(key)).length,
    identityStatus: remoteThread ? 'observed-unverified' : 'upstream-thread-id-not-supplied',
    // The opaque upstream session is not a /c/ UUID. Never substitute Pi sessionId or requestId for threadId.
    chatConversationId: null, verified: false };
}
export function createUpstreamObserver({ directory = path.join(os.homedir(), '.chat-vault', 'diagnostics'),
  maxBytes = 512 * 1024, enabled = true } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('invalid_observer_limit');
  let pending = Promise.resolve(), lastError = null, count = 0;
  const file = path.join(directory, 'codex-upstream-metadata.jsonl');
  function observe(meta) {
    try {
      if (!enabled) return Promise.resolve();
      const row = summarizeIncomingMeta(meta);
      if (!row) return Promise.resolve();
      const text = JSON.stringify(row) + '\n';
      const job = pending.catch(() => {}).then(async () => {
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fs.promises.stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
        if (stat && (stat.size + Buffer.byteLength(text) > maxBytes || Date.now() - stat.mtimeMs > 2 * 86400000)) {
          await fs.promises.rm(`${file}.1`, { force: true });
          await fs.promises.rename(file, `${file}.1`);
        }
        await fs.promises.appendFile(file, text, { encoding: 'utf8', mode: 0o600 });
        ++count; lastError = null;
      }).catch(error => { lastError = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'OBSERVER_WRITE_FAILED'; });
      pending = job;
      return job;
    } catch { lastError = 'OBSERVER_SERIALIZATION_FAILED'; return Promise.resolve(); }
  }
  return { observe, flush: () => pending, status: () => ({ file, recorded: count, lastError, enabled }) };
}
const observer = createUpstreamObserver();
// Called after requireChatId from Chappie's request wrapper; fail-open and never modifies request/context/result.
export function observeUpstreamMeta(meta) { void observer.observe(meta); }
