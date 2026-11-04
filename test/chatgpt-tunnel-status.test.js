import assert from 'node:assert/strict';
import test from 'node:test';
import '../extensions/chatgpt-sync/tunnel-status.js';

const { check } = globalThis.__cvTunnel;
const NOW = Date.parse('2026-10-15T18:00:00Z');
function fake({ lastPoll, uptime = 12000, errors = { other: 10, timeout: 1 } }) {
  const metrics = [`commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} ${lastPoll}`,
    ...Object.entries(errors).map(([k, n]) => `commands_poll_errors_total{error_kind="${k}",otel_scope_name="controlplane"} ${n}`)].join('\n');
  const bodies = { '/health': { live: true, ready: true, schema_version: 1, runtime: { lifecycle: 'running', uptime_seconds: uptime, version: '0.1.4' } },
    '/api/status': { channels: [{ name: 'main', enabled: true, details: [] }] }, '/metrics': metrics };
  return async url => { const body = bodies[new URL(url).pathname];
    return { ok: true, json: async () => body, text: async () => body }; };
}

test('健康接口 ready 但轮询停滞：90 秒起警告，5 分钟升为红色，并带上失败计数', async () => {
  const warn = await check({ fetchImpl: fake({ lastPoll: NOW / 1000 - 120 }), now: NOW });
  assert.equal(warn.code, 'stalled'); assert.equal(warn.kind, 'warn');
  const bad = await check({ fetchImpl: fake({ lastPoll: NOW / 1000 - 660 }), now: NOW });
  assert.equal(bad.kind, 'bad');
  assert.equal(bad.stalledSec, 660);
  assert.match(bad.text, /停滞 11 分钟.*累计失败 other 10 · timeout 1/);
  assert.match(bad.title, /503\/504/);
});

test('重启后一直没成功轮询：运行满 5 分钟也升为红色', async () => {
  assert.equal((await check({ fetchImpl: fake({ lastPoll: 0, uptime: 120 }), now: NOW })).kind, 'warn');
  const bad = await check({ fetchImpl: fake({ lastPoll: 0, uptime: 400 }), now: NOW });
  assert.equal(bad.code, 'no-poll'); assert.equal(bad.kind, 'bad');
});

test('正常轮询：ok', async () => {
  assert.equal((await check({ fetchImpl: fake({ lastPoll: NOW / 1000 - 20 }), now: NOW })).kind, 'ok');
});
