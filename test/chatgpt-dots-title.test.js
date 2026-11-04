import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { refreshDotsTitles } from '../extensions/chatgpt-sync/dots-title-background.js';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/dots-title.js', import.meta.url), 'utf8');
const threadId = '01a0f178-337c-76ad-ab15-57376055ec42';
const flush = () => new Promise(resolve => setImmediate(resolve));
async function pageFixture({ dockText = null, settings = {} } = {}) {
  const writes = [];
  let title = 'little';
  const timers = [];
  const observers = [];
  const settingsListeners = [];
  const description = { textContent: '活跃' };
  const header = { hidden: false, cssVisible: true, firstElementChild: description,
    label: 'Pause little', checkVisibility() { return this.cssVisible; }, getBoundingClientRect: () => ({ width: 192, height: 20 }),
    getAttribute(key) { return key === 'aria-label' ? this.label : key === 'aria-describedby' ? 'status-description' : null; } };
  const leaf = { hidden: false, textContent: dockText || '',
    getAttribute: () => null, checkVisibility: () => true, getBoundingClientRect: () => ({ width: 120, height: 20 }) };
  const name = { textContent: 'little' };
  const region = { role: dockText ? 'status' : null, ariaHidden: dockText ? 'false' : 'true',
    parentElement: { querySelector: () => name },
    closest: () => null, querySelector: () => leaf,
    getAttribute(key) { return key === 'role' ? this.role : key === 'aria-hidden' ? this.ariaHidden : null; },
    // 真实状态的父级是 display:contents，没有自己的 layout box。
    checkVisibility: () => false, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  const docks = [region];
  const controls = [header];
  const queries = [];
  const document = {
    head: {}, visibilityState: 'hidden', addEventListener() {},
    get title() { return title; }, set title(value) { title = value; writes.push(value); },
    getElementById: id => id === 'status-description' ? description : null,
    querySelectorAll: selector => { queries.push(selector); return selector.includes('aeon-status') ? controls : docks; },
    querySelector() { throw new Error('标题不能读取消息列表/输入动画'); },
  };
  const values = { dotsTitle: true, injectionEnabled: true, syncEnabled: false, durations: false, ...settings };
  const context = vm.createContext({ document, location: { pathname: `/dots/${threadId}` },
    chrome: { storage: { local: { get: async defaults => ({ ...defaults, ...values }) },
      onChanged: { addListener: fn => settingsListeners.push(fn) } } },
    MutationObserver: class {
      constructor(fn) { this.callback = fn; this.nodes = []; observers.push(this); }
      observe(node, options) { this.nodes.push({ node, options }); }
      disconnect() { this.nodes = []; }
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
  });
  vm.runInContext(source, context);
  await context.__cvDotsTitle.ready;
  return { context, document, header, description, leaf, region, name, docks, controls, queries, writes, timers, observers, values,
    api: context.__cvDotsTitle, async setting(key, value) {
      values[key] = value;
      settingsListeners.forEach(fn => fn({ [key]: { newValue: value } }, 'local'));
      await flush();
    } };
}

test('dots 标题只反映自己的真实状态，不添加最后一条消息，不受耗时/同步开关影响', async () => {
  const p = await pageFixture();
  assert.equal(p.document.title, '[空闲] little');
  assert.equal(p.api.snapshot().dots_id, threadId);
  assert.equal(p.api.snapshot().source, 'dots-idle-status');
  assert.equal(p.api.snapshot().state, '空闲');
  assert.equal(p.api.snapshot().raw_status, '活跃');
  assert.equal(p.api.snapshot().idle_evidence, true);
  assert.doesNotMatch(p.document.title, /任务完成|工作中/);
});

test('底部实际状态优先，display:contents 的父级无尺寸不妨碍读取文字', async () => {
  const p = await pageFixture({ dockText: '正在思考…' });
  assert.equal(p.document.title, '[正在思考…] little');
  assert.equal(p.api.snapshot().source, 'dots-live-status');
  p.leaf.textContent = '正在检查 MCP 插件连接';
  p.api.update();
  assert.equal(p.document.title, '[正在检查 MCP 插件连接] little');
  p.region.ariaHidden = 'true';
  p.region.role = null;
  p.api.update();
  p.leaf.textContent = '';
  assert.equal(p.api.update().state, '空闲');
  assert.equal(p.document.title, '[空闲] little');
});

test('真实侧栏 Active 2分钟前 仍是空闲可用状态，不吞掉真正工作文字', async () => {
  const p = await pageFixture();
  for (const label of ['Active 2分钟前', 'Active 3 hours ago', '活跃 10秒前', 'Active just now']) {
    p.description.textContent = label;
    assert.equal(p.api.update().state, '空闲', label);
  }
  for (const label of ['Active deployment', '正在检查文件']) {
    p.description.textContent = label;
    assert.equal(p.api.update().state, label);
    assert.equal(p.api.snapshot().idle_evidence, false);
  }
});

test('显式暂停优先于状态动画，并使用 aria 关联文字而非 hover 操作文字', async () => {
  const p = await pageFixture({ dockText: '正在思考…' });
  p.header.label = 'Resume little';
  p.description.textContent = '已暂停';
  p.api.update();
  assert.equal(p.api.snapshot().state, '已暂停');
  p.header.label = '恢复 little';
  p.header.firstElementChild = { textContent: 'hover 的错误文字' };
  p.api.update();
  assert.equal(p.api.snapshot().state, '已暂停');
  p.description.textContent = '活跃'; // 控件切成恢复但描述还没更新时不能误报活跃
  p.api.update();
  assert.equal(p.api.snapshot().state, '已暂停');
});

test('标题幂等且尊重 ChatGPT 的重命名；离开 dots 只恢复自己持有的标题', async () => {
  const p = await pageFixture();
  p.api.update();
  p.api.update();
  assert.equal(p.writes.length, 1);
  p.document.title = 'renamed';
  p.name.textContent = 'renamed';
  p.header.label = 'Pause renamed';
  p.observers[1].callback();
  assert.equal(p.document.title, 'renamed', '观察回调里不同步重写，交给 1 秒后的合并更新');
  p.timers.at(-1).fn();
  assert.equal(p.document.title, '[空闲] renamed');
  p.observers[1].callback();
  assert.equal(p.writes.length, 3); // 不发生观察器反馈循环
  p.context.location.pathname = '/c/6abb9197-9dfc-83ec-81ec-bb48f66b140c';
  p.api.update();
  assert.equal(p.document.title, 'renamed');
  assert.equal(p.api.snapshot().state, null);
  assert.equal(p.observers[0].nodes.length, 0);
});

test('路由提前写了新标题时，不用旧 dots 原标题覆盖它；普通对话不受影响', async () => {
  const p = await pageFixture();
  p.context.location.pathname = '/c/6abb9197-9dfc-83ec-81ec-bb48f66b140c';
  p.document.title = '另一个任务';
  p.observers[1].callback();
  p.api.update();
  assert.equal(p.document.title, '另一个任务');
});

test('独立标题开关与注入开关立即恢复题名，重新开启不重复前缀', async () => {
  const p = await pageFixture();
  await p.setting('dotsTitle', false);
  assert.equal(p.document.title, 'little');
  await p.setting('dotsTitle', true);
  assert.equal(p.document.title, '[空闲] little');
  await p.setting('injectionEnabled', false);
  assert.equal(p.document.title, 'little');
  p.api.update();
  assert.equal(p.document.title, 'little');
});

test('状态变更合并至每秒一次；长状态仅缩短标题显示，迟到回调不串路由', async () => {
  const p = await pageFixture({ dockText: '正在思考…' });
  const record = { target: { nodeType: 1, closest: () => p.region }, addedNodes: [] };
  for (let i = 0; i < 30; i++) p.api.noteMutation([record]);
  p.observers[0].callback();
  assert.equal(p.timers.length, 1);
  assert.equal(p.timers[0].ms, 1000);
  p.leaf.textContent = '新的进展😀'.repeat(30);
  p.timers[0].fn();
  assert.match(p.document.title, /^\[新的进展😀.*…\] little$/);
  assert.equal(p.leaf.textContent, '新的进展😀'.repeat(30));
  assert.equal(p.api.snapshot().status_text, '新的进展😀'.repeat(30));
  p.api.noteMutation([record]);
  p.context.location.pathname = '/';
  p.timers.at(-1).fn();
  assert.equal(p.document.title, 'little');
});

test('侧栏收起仍能读取当前 dot 状态，没有状态时保留题名而不是状态未知', async () => {
  const p = await pageFixture();
  p.header.cssVisible = false;
  p.api.update();
  assert.equal(p.document.title, '[空闲] little');
  p.controls.length = 0;
  assert.equal(p.api.update().state, '空闲'); // 卡片明确空闲时，不依赖侧栏是否存在
  p.docks.length = 0;
  p.api.update();
  assert.equal(p.document.title, 'little');
  assert.equal(p.api.snapshot().source, 'dots-status-unavailable');
  assert.equal(p.api.snapshot().state, null);
});

test('只读取同名 dot 的状态卡片，忽略别的 dot 和 message-list 里的已读通知', async () => {
  const p = await pageFixture();
  const wrong = { ...p.region, role: 'status', ariaHidden: 'false',
    parentElement: { querySelector: () => ({ textContent: 'other' }) },
    querySelector: () => ({ ...p.leaf, textContent: '另一个 dot 正在执行' }) };
  const messageStatus = { ...wrong, closest: () => ({}),
    parentElement: { querySelector: () => p.name } };
  p.docks.unshift(wrong, messageStatus);
  p.controls.unshift({ ...p.header, getAttribute: () => 'Pause other' });
  p.api.update();
  assert.equal(p.document.title, '[空闲] little');
});

test('空闲占位节点也被观察，role/aria-hidden 切换和删除能够即时更新', async () => {
  const p = await pageFixture();
  const observer = p.observers[0];
  const watched = observer.nodes.find(entry => entry.node === p.region);
  assert.ok(watched.options.attributeFilter.includes('role'));
  assert.ok(watched.options.attributeFilter.includes('aria-hidden'));
  p.region.ariaHidden = 'false';
  p.region.role = 'status';
  p.leaf.textContent = '正在检查工作区';
  observer.callback();
  p.timers.at(-1).fn();
  assert.equal(p.document.title, '[正在检查工作区] little');
  p.docks.length = 0;
  p.api.noteMutation([{ target: { nodeType: 1, closest: () => null }, addedNodes: [],
    removedNodes: [{ nodeType: 1, matches: () => true }] }]);
  p.timers.at(-1).fn();
  assert.equal(p.document.title, '[活跃] little');
});

test('空闲只是已初始化卡片的显式空状态，不把缺少状态或隐藏的工作状态当成空闲', async () => {
  const p = await pageFixture();
  p.description.textContent = '正在思考…';
  p.api.update();
  assert.equal(p.document.title, '[正在思考…] little');
  assert.equal(p.api.snapshot().idle_evidence, false);
  p.description.textContent = '活跃';
  p.region.role = 'status';
  p.region.ariaHidden = 'true';
  p.leaf.textContent = '正在部署工具';
  p.api.update();
  assert.equal(p.api.snapshot().state, '活跃');
  assert.equal(p.api.snapshot().idle_evidence, false);
  p.docks.length = 0;
  p.controls.length = 0;
  p.api.update();
  assert.equal(p.document.title, 'little');
  assert.equal(p.api.snapshot().state, null);
});

test('独立后台标题更新只唤醒 dots，不激活标签页、不依赖诊断/MCP/CDP', async () => {
  const messages = [];
  let query;
  const api = { storage: { local: { get: async defaults => defaults } }, tabs: {
    query: async options => { query = options; return [
      { id: 1, url: `https://chatgpt.com/dots/${threadId}`, active: false },
      { id: 2, url: `https://chatgpt.com/dots/${threadId}`, discarded: true },
      { id: 3, url: 'https://chatgpt.com/c/6abb9197-9dfc-83ec-81ec-bb48f66b140c' },
      { id: 4, url: `https://chatgpt.com/dots/${threadId}?mode=test` },
    ]; }, sendMessage: async (id, message) => { messages.push({ id, message }); return { state: '活跃' }; },
  } };
  const result = await refreshDotsTitles(api);
  assert.deepEqual(messages, [{ id: 1, message: { type: 'refreshDotsTitle' } }, { id: 4, message: { type: 'refreshDotsTitle' } }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].ok, true);
  assert.equal(query.url.length, 2);
  api.storage.local.get = async () => ({ dotsTitle: false, injectionEnabled: true });
  assert.deepEqual(await refreshDotsTitles(api), []);
  assert.equal(messages.length, 2);
});

test('后台某个 dots 页面未注入时，不妨碍另一个页面更新', async () => {
  const api = { storage: { local: { get: async defaults => defaults } }, tabs: {
    query: async () => [1, 2].map(id => ({ id, url: `https://chatgpt.com/dots/${threadId}` })),
    sendMessage: async id => { if (id === 1) throw new Error('Receiving end does not exist'); return { state: '等待回复' }; },
  } };
  const result = await refreshDotsTitles(api);
  assert.equal(result[0].ok, false);
  assert.equal(result[1].ok, true);
});

test('2026-10-10 头像卡布局：名字只是短名「dot」、没有状态控件，思考中与退场后保留旧文字的空闲都能认出', async () => {
  const p = await pageFixture({ dockText: '正在思考' });
  p.name.textContent = 'dot';                       // 不再与标题同名
  p.controls.length = 0;                            // 顶部 aeon-status 控件也没了
  p.region.closest = selector => selector.includes('group/orbit-profile') ? {} : null;
  p.api.update();
  assert.equal(p.document.title, '[正在思考] little');
  assert.equal(p.api.snapshot().source, 'dots-live-status');
  p.region.role = null;                             // 退场：去掉 role、aria-hidden=true，文字仍在
  p.region.ariaHidden = 'true';
  assert.equal(p.api.update().state, '空闲');
  assert.equal(p.document.title, '[空闲] little');
  p.region.closest = () => null;                    // 不在头像卡里、名字又对不上：不认
  assert.equal(p.api.update().state, null);
});

test('两份脚本同时改标题（扩展重载时）：前缀不叠加，互改也不会锁死主线程', async () => {
  const p = await pageFixture();
  p.api.update();
  assert.equal(p.document.title, '[空闲] little');
  // 另一份脚本把我们加过前缀的标题当原题名再加一层
  p.document.title = '[空闲] [空闲] little';
  p.api.update();
  assert.equal(p.document.title, '[空闲] little', '去掉已有前缀再加，不越叠越长');
  // 两边状态不同、来回互改：1 秒内超过 4 次就暂停改写
  const before = p.writes.length;
  for (let i = 0; i < 20; i++) { p.document.title = `[正在思考] little`; p.api.update(); }
  assert.ok(p.writes.length - before <= 20 + 4, '外部写入 20 次，我们最多跟写 4 次');
});
