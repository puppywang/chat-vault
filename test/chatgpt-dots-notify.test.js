import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/dots-notify.js', import.meta.url), 'utf8');
const DOT = '01a0fef9-d36f-7446-a85a-61cfde1be1ba';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

function setup({ quietSec = 180, notify = true } = {}) {
  const rows = [];
  const sent = [];
  const timers = new Map();
  let nextTimer = 1;
  let visible = false, focused = false;
  const row = (id, self) => ({ classList: { contains: c => c === 'self' && self }, getAttribute: k => k === 'data-message-id' ? id : null });
  const document = { title: '你的 Dot', body: {}, get visibilityState() { return visible ? 'visible' : 'hidden'; },
    hasFocus: () => focused, querySelectorAll: () => rows, addEventListener() {} };
  const context = { document, window: { addEventListener() {} }, console,
    MutationObserver: class { observe() {} },
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0,
    chrome: { runtime: { sendMessage: async m => { sent.push(m); } },
      storage: { onChanged: { addListener() {} }, local: { get: async d => ({ ...d, notify, dotsQuietSec: quietSec }) } } } };
  context.globalThis = context;
  context.__cvDots = { dotsId: () => DOT };
  vm.runInNewContext(source, context);
  const api = context.__cvDotsNotify;
  const quietTimers = () => [...timers.entries()].filter(([, t]) => t.ms >= 30000);
  return { api, sent, rows, row, timers,
    add(id, self = false) { rows.push(row(id, self)); },
    look(v) { visible = v; focused = v; },
    fireQuiet() { for (const [id, t] of quietTimers()) { timers.delete(id); t.fn(); } },
    quietTimers };
}

test('不在看时 Dot 连发的消息静默后合并成一条通知；你发消息后 15 秒内的确认不计', async () => {
  const p = setup();
  await flush();
  p.add('m1', true); p.add('m2');
  p.api.scan(1000);                                  // 建基线：已有消息不算
  p.add('u2', true); p.api.scan(10_000);             // 你发了一条
  p.add('ack'); p.api.scan(16_000);                  // 6 秒后的确认
  assert.equal(p.api.status().pending, null, '秒回确认不计入');
  p.add('d1'); p.api.scan(200_000);
  p.add('d2'); p.api.scan(320_000);
  assert.equal(p.api.status().pending.count, 2);
  assert.equal(p.quietTimers().length, 1, '每来一条就重新计时，只留一个定时器');
  assert.equal(p.quietTimers()[0][1].ms, 180_000);
  p.fireQuiet();
  await flush();
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].type, 'dotsMessages');
  assert.equal(p.sent[0].count, 2);
  assert.equal(p.sent[0].lastAt, 320_000);
});

test('正在看时不提醒；回到页面取消待发提醒；往上翻加载的历史不算新消息', async () => {
  const p = setup();
  await flush();
  p.add('m1'); p.add('m2'); p.api.scan(1000);
  p.look(true);
  p.add('d1'); p.api.scan(100_000);
  assert.equal(p.api.status().pending, null, '在看就不攒');
  p.look(false);
  p.add('d2'); p.api.scan(200_000);
  assert.equal(p.api.status().pending.count, 1);
  p.look(true);
  p.fireQuiet();
  await flush();
  assert.equal(p.sent.length, 0, '静默期结束时已经回来看了，不发');
  p.look(false);
  p.rows.unshift(p.row('old1'), p.row('old2'));     // 历史回补插在最前面
  p.api.scan(300_000);
  assert.equal(p.api.status().pending, null);
});

test('通知开关关闭时不提醒；静默时长按设置并限制在 30–3600 秒', async () => {
  const off = setup({ notify: false });
  await flush();
  off.add('m1'); off.api.scan(1000); off.add('d1'); off.api.scan(100_000);
  assert.equal(off.api.status().pending, null);
  const short = setup({ quietSec: 5 });
  await flush();
  assert.equal(short.api.status().quietSec, 180, '低于 30 秒的值回到默认');
  const custom = setup({ quietSec: 600 });
  await flush();
  assert.equal(custom.api.status().quietSec, 600);
});
