import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const popup = fs.readFileSync(new URL('../extensions/chatgpt-sync/popup.js', import.meta.url), 'utf8');
const tunnelStatus = fs.readFileSync(new URL('../extensions/chatgpt-sync/tunnel-status.js', import.meta.url), 'utf8');
const LEFT = '6ac74eb0-2270-83ec-a4de-e6daf6513094';
const RIGHT = '6ac75682-92dc-83ec-ab7f-9cea94338208';
const THREAD = '01a11a8b-97be-70fc-b163-a428fd770853';
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

function element() {
  return { handlers: {}, style: {}, children: [], checked: false, disabled: false, hidden: false, textContent: '', innerHTML: '', title: '', className: '',
    addEventListener(type, handler) { this.handlers[type] = handler; },
    replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
}
async function fixture({ tabs, interactions = {}, stored = {}, deadTabs = [], runtimeReply = null, fetchImpl }) {
  const ids = ['auto', 'injectionEnabled', 'syncEnabled', 'diagnostics', 'durations', 'speedMetrics', 'dotsTitle', 'stalledTurn',
    'notify', 'notifyMinSec', 'port', 'sync', 'status', 'convMode', 'codexThread', 'codexThreadStatus', 'codexThreadCandidates',
    'codexThreadDeep', 'codexThreadDiagnostics', 'pageHealth', 'splitTarget', 'codexUsage', 'refresh', 'reinject', 'codexRelookup', 'tunnel', 'tunnelPort'];
  const elements = new Map(ids.map(id => [id, element()]));
  const values = { injectionEnabled: true, syncEnabled: true, auto: true, ...stored };
  const messages = [], created = [];
  const context = { setTimeout, clearTimeout, AbortController, fetch: fetchImpl,
    document: { getElementById: id => elements.get(id), createElement: element },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.13.0' }), sendMessage: async m => { messages.push({ runtime: true, message: m }); return runtimeReply ? runtimeReply(m) : { ok: true }; } },
      storage: { onChanged: { addListener() {} }, local: {
        get: async keys => typeof keys === 'string' ? { [keys]: values[keys] }
          : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, values[k]])) : { ...keys, ...values },
        set: async v => Object.assign(values, v) } },
      tabs: { SPLIT_VIEW_ID_NONE: -1, create: async t => { created.push(t.url); return t; },
        query: async q => q.active ? [tabs.find(t => t.active)] : tabs,
        get: async id => tabs.find(t => t.id === id),
        sendMessage: async (tabId, message) => {
          messages.push({ tabId, message });
          if (deadTabs.includes(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
          if (message.type === 'diagnosticProbe') return { page_runtime: { version: '0.13.0', phase: 'ready' },
            last_interaction_at: interactions[tabId] ?? null, conversation_mode: { mode: 'work', turns: 2, codexTurns: 2, workerTurns: 0, chatTurns: 0, lastTurn: 'codex' } };
          return { ok: true, lookupVersion: '0.13.0', conversationId: message.conversationId, status: 'no-match', candidates: [], message: '未找到' };
        } } } };
  vm.createContext(context);
  vm.runInContext(tunnelStatus, context);   // popup.html 先加载 tunnel-status.js
  vm.runInContext(popup, context);
  await settle();
  return { elements, messages, created, click: async () => { await elements.get('codexThread').handlers.click(); await settle(); } };
}

test('分屏：弹窗作用于最后操作的一侧（即使 Chrome 把另一侧标为 active），并可手动切换', async () => {
  const tabs = [
    { id: 1, index: 0, active: true, splitViewId: 7, title: '左边对话', url: `https://chatgpt.com/c/${LEFT}` },
    { id: 2, index: 1, active: false, splitViewId: 7, title: '右边对话', url: `https://chatgpt.com/c/${RIGHT}` },
    { id: 3, index: 2, active: false, splitViewId: -1, title: '别的', url: 'https://example.com/' },
  ];
  const f = await fixture({ tabs, interactions: { 1: 1000, 2: 5000 } });
  const split = f.elements.get('splitTarget');
  assert.equal(split.hidden, false);
  assert.equal(split.children.length, 2, '只列同一分屏的两侧');
  assert.match(split.children[1].className, /on/, '最近操作的右侧被选中');
  await f.click();
  const lookup = f.messages.find(m => m.message.type === 'resolveCodexThread');
  assert.equal(lookup.tabId, 2);
  assert.equal(lookup.message.conversationId, RIGHT);
  split.children[0].handlers.click();
  await settle();
  await f.click();
  const second = f.messages.filter(m => m.message.type === 'resolveCodexThread').at(-1);
  assert.equal(second.tabId, 1, '手动切换后作用于左侧');
  assert.equal(second.message.conversationId, LEFT);
});

test('非分屏：行为不变，不显示切换', async () => {
  const f = await fixture({ tabs: [{ id: 9, index: 0, active: true, splitViewId: -1, url: `https://chatgpt.com/c/${LEFT}` }] });
  assert.equal(f.elements.get('splitTarget').hidden, true);
  await f.click();
  assert.equal(f.messages.find(m => m.message.type === 'resolveCodexThread').tabId, 9);
});

test('Codex 页面显示已记录的线程用量；Chat 页面按已知关联显示', async () => {
  const usage = { threadId: THREAD, modelContextWindow: 400000, updatedAt: '2026-10-09T03:00:00.000Z',
    total: { inputTokens: 1400000, cachedInputTokens: 1200000, outputTokens: 100000, reasoningOutputTokens: 60000 },
    last: { totalTokens: 250000 } };
  const codex = await fixture({ tabs: [{ id: 4, index: 0, active: true, url: `https://chatgpt.com/local/${THREAD}?hostId=local` }],
    stored: { [`cvCodexUsageV1:${THREAD}`]: usage } });
  assert.match(codex.elements.get('convMode').innerHTML, /Codex 会话/);
  assert.equal(codex.elements.get('codexThread').hidden, true);
  assert.equal(codex.elements.get('sync').hidden, true);
  const text = codex.elements.get('codexUsage').textContent;
  assert.match(text, /输入 1\.40M（缓存 1\.20M）/);
  assert.match(text, /输出 100\.0K（推理 60\.0K）/);
  assert.match(text, /上下文 63%/);
  const chat = await fixture({ tabs: [{ id: 5, index: 0, active: true, url: `https://chatgpt.com/c/${LEFT}` }],
    stored: { [`cvCodexLinkV1:${LEFT}`]: { threadId: THREAD }, [`cvCodexUsageV1:${THREAD}`]: usage } });
  assert.match(chat.elements.get('codexUsage').textContent, /Codex 用量（关联线程）/);
  const none = await fixture({ tabs: [{ id: 6, index: 0, active: true, url: `https://chatgpt.com/local/${THREAD}?hostId=local` }] });
  assert.match(none.elements.get('codexUsage').textContent, /尚未收到 Codex 用量推送/);
});

test('底部同步状态只显示当前标签页所在对话；无记录时如实说明；非对话页才显示全局最近一次', async () => {
  const at = '2026-10-09T05:32:22.000Z';
  const stored = { last: { ok: true, summary: '完成GOAL2实现（1308 条）', conversationId: RIGHT, at },
    [`cvLastSyncV1:${LEFT}`]: { ok: true, summary: '左边对话（510 条）', conversationId: LEFT, at } };
  const left = await fixture({ tabs: [{ id: 1, index: 0, active: true, url: `https://chatgpt.com/c/${LEFT}` }], stored });
  assert.match(left.elements.get('status').textContent, /左边对话（510 条）/);
  const other = await fixture({ tabs: [{ id: 2, index: 0, active: true, url: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111' }], stored });
  assert.equal(other.elements.get('status').textContent, '此对话尚未同步到 ChatVault。', '不借用其他对话的同步结果');
  const codex = await fixture({ tabs: [{ id: 3, index: 0, active: true, url: `https://chatgpt.com/local/${THREAD}?hostId=local` }], stored });
  assert.match(codex.elements.get('status').textContent, /^最近一次（其他对话）：.*完成GOAL2实现/);
});

test('刷新按钮重新识别标签页与页面状态', async () => {
  const f = await fixture({ tabs: [{ id: 1, index: 0, active: true, url: `https://chatgpt.com/c/${LEFT}` }] });
  const before = f.messages.filter(m => m.message.type === 'diagnosticProbe').length;
  await f.elements.get('refresh').handlers.click();
  await settle();
  assert.ok(f.messages.filter(m => m.message.type === 'diagnosticProbe').length > before);
  assert.equal(f.elements.get('refresh').disabled, false);
});

test('页面脚本未运行：说明原因并提供「重新注入此标签页」，点击后由后台补注入', async () => {
  let dead = [7];
  const f = await fixture({ tabs: [{ id: 7, index: 0, active: true, url: `https://chatgpt.com/c/${LEFT}` }], deadTabs: dead,
    runtimeReply: m => { if (m.type === 'reinjectTab') { dead.length = 0; return { ok: true, tabId: m.tabId, status: 'injected' }; } return { ok: true }; } });
  assert.match(f.elements.get('convMode').textContent, /页面脚本未运行/);
  assert.equal(f.elements.get('reinject').hidden, false);
  await f.elements.get('reinject').handlers.click();
  await settle();
  const sent = f.messages.find(m => m.runtime && m.message.type === 'reinjectTab');
  assert.equal(sent.message.tabId, 7);
});

test('已关联的对话直接打开 Codex，不再查找；「重新查找关联」仍走只读查找', async () => {
  const tabs = [{ id: 5, index: 0, active: true, url: `https://chatgpt.com/c/${LEFT}` }];
  const f = await fixture({ tabs, stored: { [`cvCodexLinkV1:${LEFT}`]: { threadId: THREAD.toUpperCase() } } });
  const button = f.elements.get('codexThread');
  assert.match(button.textContent, /已关联/);
  assert.equal(f.elements.get('codexRelookup').hidden, false);
  await f.click();
  assert.deepEqual(f.created, [`https://chatgpt.com/local/${THREAD}?hostId=local`]);
  assert.equal(f.messages.filter(m => m.message.type === 'resolveCodexThread').length, 0, '不发查找');
  await f.elements.get('codexRelookup').handlers.click();
  await settle();
  assert.equal(f.messages.filter(m => m.message.type === 'resolveCodexThread').length, 1);
  const plain = await fixture({ tabs });
  assert.doesNotMatch(plain.elements.get('codexThread').textContent, /已关联/);
  assert.equal(plain.elements.get('codexRelookup').hidden, true);
});

function otunnel({ uptime = 3725, pollAgo = 12, lifecycle = 'running', main = true } = {}) {
  const now = Date.now() / 1000;
  const bodies = {
    '/health': { live: true, ready: true, schema_version: 1, runtime: { flavor: 'runtime', lifecycle, uptime_seconds: uptime, version: '0.1.4' } },
    '/api/status': { tunnel_metadata: { Name: 'Chappie' }, control_plane_tunnel_id: 'tunnel_example',
      channels: [{ name: 'main', enabled: main, details: [{ key: 'pid', value: '44876' }] }] },
    '/metrics': `# TYPE x gauge\ncommands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} ${pollAgo == null ? 0 : Math.round(now - pollAgo)}\n`,
  };
  return async url => {
    const body = bodies[new URL(url).pathname];
    if (body === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
  };
}

test('Chappie 隧道：读本机 otunnel health 显示连接、运行时长与最近轮询', async () => {
  const tabs = [{ id: 1, index: 0, active: true, url: 'https://example.com/' }];
  const ok = await fixture({ tabs, fetchImpl: otunnel() });
  const line = ok.elements.get('tunnel');
  assert.equal(line.hidden, false);
  assert.match(line.className, /ok/);
  assert.match(line.textContent, /^Chappie 隧道已连接 · 运行 1h02m · 轮询 1\d 秒前$/);
  assert.match(line.title, /pi --chappie PID 44876/);
  const stale = await fixture({ tabs, fetchImpl: otunnel({ pollAgo: 630 }) });
  assert.match(stale.elements.get('tunnel').textContent, /轮询停滞 10 分钟/);
  assert.match(stale.elements.get('tunnel').className, /bad/, '停滞超过 5 分钟升为红色');
  const down = await fixture({ tabs, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  assert.match(down.elements.get('tunnel').textContent, /未运行（127\.0\.0\.1:8080 无响应）/);
  assert.match(down.elements.get('tunnel').className, /bad/);
  const other = await fixture({ tabs, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }) });
  assert.match(other.elements.get('tunnel').textContent, /不是 otunnel 的 health 接口/);
  const sent = ok.messages.find(m => m.runtime && m.message.type === 'tunnelStatus');
  assert.equal(sent.message.state.code, 'ok', '弹窗读到的结果顺带交给后台刷新角标');
  const off = await fixture({ tabs, stored: { tunnelPort: 0 }, fetchImpl: otunnel() });
  assert.equal(off.elements.get('tunnel').hidden, true, '端口填 0 不显示');
});
