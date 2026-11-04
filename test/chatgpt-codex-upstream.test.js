import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { summarizeIncomingMeta, createUpstreamObserver } from '../src/codex-upstream-observer.js';
const UUID = '11111111-1111-4111-8111-111111111111';
const meta = () => ({ 'openai/session': 'opaque-upstream-session', 'otunnel/requestId': 'wfr_abc/op', callId: 'call_abcd', threadId: UUID });

test('可信入口保留调用级ID，但不把观测等同于验证或/c/会话', () => {
  const r = summarizeIncomingMeta(meta());
  assert.equal(r.threadId, UUID); assert.equal(r.callId, 'call_abcd'); assert.equal(r.chatConversationId, null);
  assert.equal(r.verified, false); assert.equal(r.boundary, 'chappie-inbound');
  assert.equal(r.upstreamSessionDigest, createHash('sha256').update('opaque-upstream-session').digest('hex'));
});
test('sessionId / 请求ID绝不替代缺失的threadId', () => {
  const r = summarizeIncomingMeta({ 'openai/session': 'opaque', sessionId: UUID, 'otunnel/requestId': UUID });
  assert.equal(r.threadId, null); assert.equal(r.sessionId, UUID); assert.equal(r.identityStatus, 'upstream-thread-id-not-supplied');
});
test('上游未提供threadId时也留下明确的缺失观测', () => {
  const r = summarizeIncomingMeta({ 'openai/session': 'opaque', authorization: 'secret', unknown: 'private' });
  assert.equal(r.present.threadId, false); assert.equal(r.unrecognizedKeyCount, 2);
  assert.doesNotMatch(JSON.stringify(r), /secret|private|authorization/);
});
test('任意正文伪造、非法ID和缺失上游session不会进入身份字段', () => {
  assert.equal(summarizeIncomingMeta({ threadId: UUID }), null);
  const r = summarizeIncomingMeta({ ...meta(), threadId: '../settings', arguments: { threadId: UUID }, callId: 'Bearer secret' });
  assert.equal(r.threadId, null); assert.equal(r.callId, null); assert.equal(r.verified, false);
});
test('记录不改变输入对象；内嵌token、正文、账号明文不落盘', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-upstream-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = Object.freeze({ ...meta(), accountId: 'account-secret', accessToken: 'bearer-secret', arguments: { text: 'private-body' } });
  const observer = createUpstreamObserver({ directory }); await observer.observe(input); await observer.flush();
  const text = fs.readFileSync(observer.status().file, 'utf8');
  assert.doesNotMatch(text, /bearer-secret|private-body|account-secret|opaque-upstream-session/);
  assert.equal(observer.status().recorded, 1); assert.equal(observer.status().lastError, null);
});
test('日志串行轮换和写入失败不影响工具调用', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-upstream-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const observer = createUpstreamObserver({ directory, maxBytes: 1024 });
  await Promise.all(Array.from({ length: 7 }, () => observer.observe(meta())));
  assert.equal(observer.status().recorded, 7); assert.ok(fs.existsSync(observer.status().file + '.1'));
  const bad = createUpstreamObserver({ directory: observer.status().file });
  await bad.observe(meta()); assert.notEqual(bad.status().lastError, null);
});

const { correlateUpstream } = await import('../src/codex-upstream-correlation.js');
function chat() { return { conversation_id: UUID, current_node: 'tool', mapping: { tool: { parent: null, message: {
  id: UUID, author: { role: 'tool' }, metadata: { request_id: 'wfr_abc', invoked_resource: {
    app_name: 'Chappie', resource_uri: '/asdk_app_6aaba23c46648191a120d4595cb8bd7c/link/history' } } } } } }; }
test('workflow精确前缀关联只标为上下文候选，不误称同次call或已验证thread', () => {
  const result = correlateUpstream(chat(), [summarizeIncomingMeta(meta())]);
  assert.equal(result.linked.length, 1); assert.equal(result.linked[0].readCandidate, UUID);
  assert.equal(result.linked[0].relation, 'same-workflow-not-same-call'); assert.equal(result.verified, false);
});
test('本机MCP记录、另一个workflow和正文伪造均不能匹配目标Chat', () => {
  const observed = summarizeIncomingMeta(meta());
  assert.equal(correlateUpstream(chat(), [{ ...observed, boundary: 'pi-mcp' }]).linked.length, 0);
  assert.equal(correlateUpstream(chat(), [{ ...observed, requestId: 'wfr_abcx/op' }]).linked.length, 0);
  const c = chat(); c.mapping.tool.message.author.role = 'user';
  assert.equal(correlateUpstream(c, [observed]).linked.length, 0);
});
test('同workflow缺失threadId保留显式状态，绝不使用sessionId替代', () => {
  const m = meta(); delete m.threadId; m.sessionId = UUID;
  const result = correlateUpstream(chat(), [summarizeIncomingMeta(m)]);
  assert.equal(result.status, 'upstream-thread-id-not-supplied'); assert.equal(result.missing[0].readCandidate, null);
});
