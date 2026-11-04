import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('弹窗可独立关闭页面注入并开启诊断日志', async () => {
  const elements = new Map();
  for (const id of ['auto', 'injectionEnabled', 'syncEnabled', 'diagnostics', 'durations', 'speedMetrics', 'dotsTitle', 'stalledTurn', 'notify',
    'notifyMinSec', 'port', 'sync', 'status', 'capture', 'captureStatus', 'codexThread', 'codexThreadStatus', 'codexThreadCandidates',
    'codexThreadDeep', 'codexThreadDiagnostics']) {
    elements.set(id, { id, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; },
      checked: false, disabled: false, textContent: '', className: '' });
  }
  const messages = [];
  const values = { auto: true, injectionEnabled: true, syncEnabled: true, diagnostics: false,
    durations: true, speedMetrics: true, dotsTitle: true, stalledTurn: true, notify: true, notifyMinSec: 30, port: 8377, last: null };
  const context = {
    document: { getElementById: (id) => elements.get(id) },
    chrome: {
      storage: { onChanged: { addListener() {} }, local: { get: async () => values,
        set: async (update) => { Object.assign(values, update); } } },
      runtime: { sendMessage: async (message) => {
        messages.push(message);
        return message.type === 'diagnosticPing' ? { ok: true, file: 'events.jsonl' } : { ok: true };
      } },
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../extensions/chatgpt-sync/popup.js', import.meta.url), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  const injection = elements.get('injectionEnabled');
  assert.equal(injection.checked, true);
  injection.checked = false;
  await injection.handlers.change();
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { type: 'setInjection', enabled: false });
  assert.equal(elements.get('auto').disabled, true);
  assert.equal(elements.get('sync').disabled, true);
  injection.checked = true;
  await injection.handlers.change();
  const sync = elements.get('syncEnabled');
  sync.checked = false;
  await sync.handlers.change();
  assert.equal(values.syncEnabled, false);
  assert.equal(elements.get('auto').disabled, true);
  assert.equal(elements.get('sync').disabled, true);
  const diagnostics = elements.get('diagnostics');
  diagnostics.checked = true;
  await diagnostics.handlers.change();
  assert.equal(values.diagnostics, true);
  assert.equal(messages[2].type, 'diagnosticPing');
  assert.match(elements.get('status').textContent, /events\.jsonl/);
  const speed = elements.get('speedMetrics');
  speed.checked = false;
  await speed.handlers.change();
  assert.equal(values.speedMetrics, false);
  const title = elements.get('dotsTitle');
  assert.equal(title.checked, true);
  title.checked = false;
  await title.handlers.change();
  assert.equal(values.dotsTitle, false);
});
