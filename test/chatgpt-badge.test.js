import assert from 'node:assert/strict';
import test from 'node:test';
import { badgeView, createBadge } from '../extensions/chatgpt-sync/badge.js';

const down = { code: 'down', kind: 'bad', text: 'Chappie 隧道未运行（127.0.0.1:8080 无响应）' };
const stalled = { code: 'stalled', kind: 'warn', text: 'Chappie 隧道轮询停滞 3 分钟' };

test('角标优先级：同步成功闪 ✓ > 隧道未运行「断」> 隧道异常「!」> 同步失败「!」', () => {
  assert.equal(badgeView({ tunnel: down, flashUntil: 2000 }, 1000).text, '✓');
  assert.deepEqual(badgeView({ tunnel: down, syncBad: true }, 1000).text, '断');
  const warn = badgeView({ tunnel: stalled, syncBad: true }, 1000);
  assert.equal(warn.text, '!');
  assert.equal(warn.color, '#d97706', '隧道异常用橙色，与红色的同步失败区分');
  assert.equal(badgeView({ syncBad: true, syncError: 'ECONNREFUSED' }).color, '#ef4444');
  assert.match(badgeView({ syncBad: true, syncError: 'ECONNREFUSED' }).title, /同步失败：ECONNREFUSED/);
  assert.equal(badgeView({ tunnel: { code: 'ok', kind: 'ok', text: '已连接' } }).text, '');
  assert.equal(badgeView({ tunnel: { code: 'foreign', kind: 'warn', text: '不是 otunnel' } }).text, '', '端口被别的服务占用不报警');
  assert.match(badgeView({ tunnel: down }).title, /未运行/);
});

test('同步与隧道更新串行合并：✓ 闪完回到隧道状态，session 中保留合成状态', async () => {
  let clock = 1000;
  const painted = [], stored = {}, timers = [];
  const action = { setBadgeText: async ({ text }) => painted.push(text), setBadgeBackgroundColor: async () => {}, setTitle: async () => {} };
  const session = { get: async keys => ({ ...keys, ...stored }), set: async value => Object.assign(stored, value) };
  const badge = createBadge({ action, session, now: () => clock, schedule: (fn, ms) => timers.push({ fn, ms }) });
  await badge.tunnel(down);
  assert.equal(painted.at(-1), '断');
  await badge.syncResult(true);
  assert.equal(painted.at(-1), '✓');
  clock += timers[0].ms;
  timers[0].fn();
  await badge.repaint();
  assert.equal(painted.at(-1), '断', '闪完不清空隧道告警');
  await badge.tunnel({ code: 'ok', kind: 'ok', text: '已连接' });
  assert.equal(painted.at(-1), '');
  await badge.syncResult(false, 'HTTP 500');
  assert.equal(painted.at(-1), '!');
  assert.equal(stored.cvBadgeV1.syncBad, true);
  await badge.tunnel({ code: 'off' });
  assert.equal(stored.cvBadgeV1.tunnel, null, '端口填 0 时不再参与合成');
});

test('隧道警告排在 429 暂停「停」前面，不被盖住', () => {
  assert.equal(badgeView({ tunnel: stalled, paused: true }).text, '!');
  assert.equal(badgeView({ tunnel: down, paused: true }).text, '断');
  assert.equal(badgeView({ paused: true }).text, '停');
});
