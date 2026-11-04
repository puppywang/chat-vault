import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/turns.js', import.meta.url), 'utf8');
const id = '11111111-1111-1111-1111-111111111111';
function fixture() {
  let now = 111000, streaming = false;
  const users = ['old'], intervals = [], starts = [], corrections = [];
  const context = vm.createContext({ console,
    Date: class extends Date { static now() { return now; } },
    performance: { timeOrigin: 100000 }, location: { pathname: `/c/${id}` },
    __cvSpeed: { snapshot: () => null, beginRound: v => starts.push(v), correctRound: v => corrections.push(v) },
    document: { body: { appendChild() {} }, querySelector: () => streaming ? {} : null,
      querySelectorAll: () => users.map(id => ({ getAttribute: name => name === 'data-message-id' ? id : null })),
      createElement() { const nodes = {}; return { remove() {}, attachShadow() {
        return this.shadowRoot = { getElementById: key => nodes[key] ||= { textContent: '' } };
      } }; } },
    MutationObserver: class { observe() {} },
    setInterval: (fn, ms) => { const item = { fn, ms }; intervals.push(item); return item; }, clearInterval() {},
    setTimeout() {}, clearTimeout() {},
  });
  vm.runInContext(source, context);
  context.__cvTurns.watchStreaming(() => {}, () => null);
  const api = (messageId = 'running', convId = id, start = 95000) => context.__cvTurns.observeConversation({
    conversation_id: convId, mapping: { node: { message: { id: messageId,
      author: { role: 'user' }, create_time: start / 1000 } } },
  }, { clockSkewMs: 0 });
  return { context, starts, corrections, api, appear() {
    users.push('running'); streaming = true; now = 116000;
    intervals.find(item => item.ms === 1000).fn();
  } };
}
for (const order of ['api-before-dom', 'dom-before-api']) test(`刷新时旧历史先出现、当前用户消息后出现：${order}`, () => {
  const f = fixture();
  if (order === 'api-before-dom') f.api();
  f.appear();
  if (order === 'dom-before-api') f.api();
  assert.equal(f.context.__cvTurns.status().started_at_ms, 95000, '使用实际发送时刻，不用 DOM 出现时刻');
  assert.equal(f.corrections.at(-1).resumed, true, '刷新前发送的消息属于续接');
});
test('不同用户消息或不同会话的 API 快照不能修正当前轮次', () => {
  const f = fixture(); f.appear();
  f.api('old');
  f.api('running', '22222222-2222-2222-2222-222222222222');
  assert.equal(f.context.__cvTurns.status().started_at_ms, 116000);
  assert.equal(f.corrections.length, 0);
});
test('本页新发的消息校准起点，但不标为刷新续接', () => {
  const f = fixture(); f.appear(); f.api('running', id, 115900);
  assert.equal(f.context.__cvTurns.status().started_at_ms, 115900);
  assert.equal(f.corrections.at(-1).resumed, false);
});
