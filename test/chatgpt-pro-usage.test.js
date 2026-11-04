import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProUsage, userTurns } from '../src/chatgpt-pro-usage.js';

const T0 = Date.parse('2026-10-15T12:00:00Z') / 1000;
// 用户消息 → 助手回答（model_slug 在第一个非用户子孙上）；隐藏的用户消息不算
function conv(id, turns) {
  const mapping = { root: { message: null, children: [] } };
  turns.forEach(([ago, model, hidden], i) => {
    mapping[`u${i}`] = { message: { author: { role: 'user' }, create_time: T0 - ago, metadata: hidden ? { is_visually_hidden_from_conversation: true } : {} }, children: [`t${i}`] };
    mapping[`t${i}`] = { message: { author: { role: 'tool' }, metadata: {} }, children: [`a${i}`] };
    mapping[`a${i}`] = { message: { author: { role: 'assistant' }, metadata: { model_slug: model } }, children: [] };
  });
  return { conversation_id: id, mapping };
}

test('Pro 用量估算：只数可见用户消息、回答模型以 -pro 结尾；滚动 7 天；受限时另算恢复前 7 天', () => {
  assert.deepEqual(userTurns(conv('x', [[60, 'gpt-6-pro']])).map(t => t.model), ['gpt-6-pro']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-pro-'));
  const live = path.join(home, '.chat-vault', 'imports', 'chatgpt', 'live');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(live, 'a.json'), JSON.stringify(conv('a', [[3600, 'gpt-6-pro'], [7200, 'gpt-5-6-pro'], [1800, 'gpt-6-thinking'], [900, 'gpt-6-pro', true]])));
  fs.writeFileSync(path.join(live, 'b.json'), JSON.stringify(conv('b', [[8 * 86400, 'gpt-6-pro'], [6.5 * 86400, 'gpt-6-pro']])));
  fs.writeFileSync(path.join(live, 'bad.json'), '{');
  const u = createProUsage({ homeDir: home });
  const r = u.estimate({ nowMs: T0 * 1000, resetsAfter: new Date((T0 + 86400) * 1000).toISOString() });
  assert.equal(r.count, 3, '8 天前的不算，thinking 不算，隐藏消息不算');
  assert.equal(r.conversations, 2);
  assert.equal(r.oldestAt, new Date((T0 - 6.5 * 86400) * 1000).toISOString());
  assert.equal(r.nextFreeAt, new Date((T0 + 0.5 * 86400) * 1000).toISOString());
  assert.equal(r.resetWindowCount, 2, '恢复时刻往前 7 天 = 6 天前起');
  assert.equal(u.estimate({ nowMs: T0 * 1000 }).resetWindowCount, null);
});

test('受限恢复后额度清零：记住受限期间看到的恢复时刻，恢复后从那一刻起计，超过 7 天改回滚动', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-pro-reset-'));
  const live = path.join(home, '.chat-vault', 'imports', 'chatgpt', 'live');
  fs.mkdirSync(live, { recursive: true });
  // 3 天前用满受限，1 天前恢复；恢复前 2 条、恢复后 1 条
  fs.writeFileSync(path.join(live, 'a.json'), JSON.stringify(conv('a', [[3 * 86400, 'gpt-6-pro'], [2.5 * 86400, 'gpt-6-pro'], [3600, 'gpt-6-pro']])));
  const u = createProUsage({ homeDir: home });
  const resetAt = new Date((T0 - 86400) * 1000).toISOString();
  // 受限期间：接口给出未来的恢复时刻 → 记下，仍按滚动 7 天
  const during = u.estimate({ nowMs: (T0 - 2 * 86400) * 1000, resetsAfter: resetAt });
  assert.equal(during.sinceReset, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.chat-vault', 'chatgpt-pro-reset.json'), 'utf8')).resetsAfter, resetAt);
  // 恢复后：接口不再给 resetsAfter，也从记下的恢复时刻起计
  const after = u.estimate({ nowMs: T0 * 1000 });
  assert.equal(after.count, 1, '恢复前的 2 条不算');
  assert.deepEqual(after.sinceReset, { at: resetAt, source: 'observed' });
  assert.equal(after.windowStart, resetAt);
  assert.equal(after.nextFreeAt, null);
  // 恢复超过 7 天：改回滚动 7 天
  const later = u.estimate({ nowMs: (T0 + 7 * 86400) * 1000 });
  assert.equal(later.sinceReset, null);
});
