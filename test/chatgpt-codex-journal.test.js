import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberCodexLookup } from '../extensions/chatgpt-sync/codex-lookup-journal.js';
const C = '11111111-1111-4111-8111-111111111111';
const I = '22222222-2222-4222-8222-222222222222';
const sender = { tab: { url: `https://chatgpt.com/c/${C}`, id: 1 }, frameId: 0 };
const make = () => ({ lookupId: I, conversationId: C, mode: 'normal', status: 'route-unsupported', code: 'CODEX_ROUTE_UNSUPPORTED',
  scope: 'association', statistics: { sonicCount: 28, requests: 3 }, probes: [] });
function storage() { const state = {}; return { state, async get() { return state; }, async set(value) { Object.assign(state, value); } }; }

test('诊断持久化独立于弹窗及诊断日志开关；接受后台标识状态', async () => {
  const s = storage(); assert.equal((await rememberCodexLookup(make(), sender, s)).ok, true);
  const saved = s.state.codexLookupHistory[0]; assert.equal(saved.status, 'route-unsupported');
  assert.equal(saved.statistics.sonicCount, 28); assert.equal(saved.conversationId, C);
});
test('拒绝跨域、错误会话、子frame以及非标签页发送者', async () => {
  const s = storage();
  for (const bad of [{}, { ...sender, frameId: 2 }, { tab: { url: 'https://example.com/c/' + C } }, { tab: { url: 'https://chatgpt.com/c/' + I } }])
    assert.equal((await rememberCodexLookup(make(), bad, s)).ok, false);
  assert.equal(s.state.codexLookupHistory, undefined);
});
test('串行写入不丢记录，去重并有容量限制', async () => {
  const s = storage();
  await Promise.all(Array.from({ length: 40 }, (_, i) => rememberCodexLookup({ ...make(), lookupId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }, sender, s)));
  assert.equal(s.state.codexLookupHistory.length, 30);
  const latest = s.state.codexLookupHistory[0]; await rememberCodexLookup(latest, sender, s);
  assert.equal(s.state.codexLookupHistory.length, 30);
});
test('二次白名单过滤；存储错误不冒充成功且不抛出破坏查找', async () => {
  const s = storage(); await rememberCodexLookup({ ...make(), token: 'secret', message: 'private' }, sender, s);
  assert.doesNotMatch(JSON.stringify(s.state), /secret|private/);
  const r = await rememberCodexLookup(make(), sender, { get() { throw new Error('disk'); } });
  assert.equal(r.ok, false); assert.equal(r.error, 'journal_storage_failed');
});
