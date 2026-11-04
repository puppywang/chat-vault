import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('页面诊断将关键事件交给后台确认并定期上报心跳', async () => {
  const messages = [];
  const intervals = [];
  let now = 100;
  const context = {
    chrome: {
      storage: { local: { get: async () => ({ diagnostics: true }) },
        onChanged: { addListener() {} } },
      runtime: { sendMessage: async (message) => { messages.push(message); return { ok: true }; } },
    },
    crypto: { randomUUID: () => 'nav-test' },
    document: { visibilityState: 'visible' },
    location: { pathname: '/c/6ab57c4f-5a4c-83ec-ade9-f4a84c69d90f', href: 'https://chatgpt.com/c/test' },
    performance: { now: () => now, memory: { usedJSHeapSize: 123, jsHeapSizeLimit: 456 } },
    PerformanceObserver: { supportedEntryTypes: [] },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../extensions/chatgpt-sync/diagnostics.js', import.meta.url), 'utf8'), context);
  await context.__cvDiag.ready;
  assert.equal(await context.__cvDiag.emit('sync.start', { run_id: 'run-test' }, true), true);
  context.__cvDiag.recordMutation(3);
  context.__cvDiag.recordRender(12.5);
  now += 5030;
  intervals[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  const event = messages.find((m) => m.event?.event === 'sync.start').event;
  assert.equal(event.run_id, 'run-test');
  assert.equal(event.nav_id, 'nav-test');
  const heartbeat = messages.find((m) => m.event?.event === 'heartbeat').event;
  assert.equal(heartbeat.lag_ms, 30);
  assert.equal(heartbeat.mutation_records, 3);
  assert.equal(heartbeat.render_count, 1);
  assert.equal(heartbeat.js_heap_used_bytes, 123);
});
