import assert from 'node:assert/strict';
import test from 'node:test';
import { SCRIPT_ID, NETWORK_SCRIPT_ID, PAGE_CONVERSATION_SCRIPT_ID, syncPageInjection } from '../extensions/chatgpt-sync/injection.js';

test('页面注入开关控制持久化动态内容脚本，重复应用不重复注册', async () => {
  let registered = [];
  const calls = [];
  const scripting = {
    async getRegisteredContentScripts() { return registered; },
    async registerContentScripts(scripts) { calls.push('register'); registered.push(...scripts); },
    async updateContentScripts(scripts) {
      calls.push('update');
      registered = registered.map((script) => scripts.find((item) => item.id === script.id) || script);
    },
    async unregisterContentScripts({ ids }) {
      calls.push('unregister');
      registered = registered.filter((script) => !ids.includes(script.id));
    },
  };
  await syncPageInjection(true, scripting);
  assert.deepEqual(registered[0].js, ['page-state.js', 'dots.js', 'dots-title.js', 'dots-notify.js', 'diagnostics.js', 'speed.js', 'turns.js', 'codex-thread.js', 'codex-cloud.js', 'codex-association.js', 'stalled-turn.js', 'conversation-merge.js', 'content.js']);
  assert.equal(registered[0].persistAcrossSessions, true);
  assert.equal(registered.find((script) => script.id === NETWORK_SCRIPT_ID)?.world, 'MAIN');
  assert.equal(registered.find((script) => script.id === NETWORK_SCRIPT_ID)?.runAt, 'document_start');
  const pageConversation = registered.find((script) => script.id === PAGE_CONVERSATION_SCRIPT_ID);
  assert.equal(pageConversation?.world, 'MAIN');
  assert.equal(pageConversation?.runAt, 'document_start');
  assert.equal(JSON.stringify(pageConversation?.js), JSON.stringify(['page-conversation.js']));
  await syncPageInjection(true, scripting);
  assert.deepEqual(calls, ['register']);
  await syncPageInjection(false, scripting);
  assert.equal(registered.length, 0);
  await syncPageInjection(false, scripting);
  await syncPageInjection(true, scripting);
  assert.deepEqual(calls, ['register', 'unregister', 'register']);
  await syncPageInjection(true, scripting, false);
  assert.equal(registered.some((script) => script.id === NETWORK_SCRIPT_ID), false);
  assert.equal(registered.some((script) => script.id === SCRIPT_ID), true);
  assert.equal(registered.some((script) => script.id === PAGE_CONVERSATION_SCRIPT_ID), true, '复用页面请求不依赖测速开关');
});

test('已注册的旧脚本列表会更新为含诊断脚本的新版本', async () => {
  let updated = null;
  await syncPageInjection(true, {
    async getRegisteredContentScripts() { return [{ id: SCRIPT_ID, js: ['turns.js', 'content.js'] }]; },
    async updateContentScripts(scripts) { updated = scripts[0]; },
    async registerContentScripts() {},
  });
  assert.deepEqual(updated.js, ['page-state.js', 'dots.js', 'dots-title.js', 'dots-notify.js', 'diagnostics.js', 'speed.js', 'turns.js', 'codex-thread.js', 'codex-cloud.js', 'codex-association.js', 'stalled-turn.js', 'conversation-merge.js', 'content.js']);
});

import { injectTab, injectOpenTabs } from '../extensions/chatgpt-sync/injection.js';

function fakeScripting({ oldInstance = false, failTab = null } = {}) {
  const calls = [];
  return { calls, async executeScript({ target, world, files, func }) {
    if (target.tabId === failTab) throw new Error('Cannot access contents of the page');
    calls.push({ tabId: target.tabId, world, files: files || null, probe: !!func });
    return func ? [{ result: oldInstance }] : [{}];
  } };
}

test('补注入：隔离环境没有旧实例时，先 MAIN 后 ISOLATED 注入完整脚本', async () => {
  const scripting = fakeScripting();
  const result = await injectTab(5, { scripting, speedMetrics: true });
  assert.equal(result.status, 'injected');
  const [probe, main, isolated] = scripting.calls;
  assert.equal(probe.probe, true);
  assert.equal(main.world, 'MAIN');
  assert.deepEqual([...main.files], ['page-conversation.js', 'stream-parser.js', 'page-stream.js']);
  assert.equal(isolated.world, 'ISOLATED');
  assert.equal(isolated.files.at(-1), 'content.js');
  const noSpeed = fakeScripting();
  await injectTab(6, { scripting: noSpeed, speedMetrics: false });
  assert.deepEqual([...noSpeed.calls[1].files], ['page-conversation.js'], '测速关闭时不注入网络测速脚本');
});

test('补注入：同一隔离环境里仍有旧实例时不重复执行（避免顶层声明冲突），提示刷新', async () => {
  const scripting = fakeScripting({ oldInstance: true });
  const result = await injectTab(5, { scripting });
  assert.equal(result.status, 'needs-refresh');
  assert.equal(scripting.calls.length, 1, '只做了探测');
});

test('补注入所有已打开标签页：跳过休眠页，单页失败不影响其他页', async () => {
  const scripting = fakeScripting({ failTab: 3 });
  const tabs = { query: async () => [{ id: 1 }, { id: 2, discarded: true }, { id: 3 }, { id: 4, status: 'complete' }] };
  const summary = await injectOpenTabs({ scripting, tabs });
  assert.equal(summary.injected, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results.find(r => r.tabId === 2).status, 'skipped-discarded');
  const off = await injectOpenTabs({ enabled: false, scripting, tabs });
  assert.equal(off.injected, 0);
});
