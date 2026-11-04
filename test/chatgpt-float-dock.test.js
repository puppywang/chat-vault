import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/turns.js', import.meta.url), 'utf8');
const THREAD = '01a11a8b-97be-70fc-b163-a428fd770853';
const CODEX_URL = `https://chatgpt.com/local/${THREAD}?hostId=local`;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

/** 只够浮层用的假 DOM：按 id 建影子节点，light DOM 支持插入次序与查找。 */
function makeDom() {
  const body = node('body');
  body.isConnected = true;
  function node(tag) {
    return { tagName: tag, id: '', className: '', textContent: '', innerHTML: '', title: '', style: {}, attrs: {}, children: [],
      parent: null, handlers: {}, isConnected: false,
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return this.attrs[key] ?? null; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      fire(type, event = {}) { for (const fn of this.handlers[type] || []) fn({ button: 0, pointerId: 1, preventDefault() {}, ...event }); },
      appendChild(child) { return this.insertBefore(child, null); },
      insertBefore(child, ref) {
        child.parent?.children.splice(child.parent.children.indexOf(child), 1);
        const index = ref ? this.children.indexOf(ref) : -1;
        if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
        child.parent = this;
        child.isConnected = this.isConnected;
        return child;
      },
      remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; this.isConnected = false; },
      contains(other) { return other === this || this.children.some(child => child.contains(other)); },
      getBoundingClientRect() { return { left: 900, top: 600, width: 120, height: 30 }; },
      setPointerCapture() {}, releasePointerCapture() {},
      attachShadow() {
        const nodes = new Map();
        const get = key => { if (!nodes.has(key)) nodes.set(key, node('shadow')); return nodes.get(key); };
        const root = { host: this, getElementById: get, querySelector: selector => get(selector),
          set innerHTML(html) { for (const [, id] of html.matchAll(/id="([^"]+)"/g)) get(id); this._html = html; },
          get innerHTML() { return this._html; } };
        this.shadowRoot = root;
        return root;
      } };
  }
  const find = (root, id) => root.id === id ? root : root.children.map(child => find(child, id)).find(Boolean) || null;
  const document = { body, createElement: node, getElementById: id => find(body, id),
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  return { document, body };
}

function setup({ watch = false } = {}) {
  const { document, body } = makeDom();
  const stored = {};
  const intervals = new Map(), timeouts = new Map();
  let nextTimer = 1, now = 1000000, streaming = false;
  const users = [];
  const checks = { anchorScans: 0, requests: 0 };
  if (watch) {
    document.querySelector = () => streaming ? {} : null;
    document.querySelectorAll = selector => {
      if (selector.includes('.message-row.self')) return users;
      checks.anchorScans++;
      return [];
    };
  }
  const context = { document, location: { pathname: '/c/test' }, console: { debug() {} },
    window: { innerWidth: 1500, innerHeight: 900, addEventListener() {}, removeEventListener() {} },
    chrome: { storage: { local: { get: async keys => ({ ...keys, ...stored }), set: async v => Object.assign(stored, v) } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: (fn, ms) => { const id = nextTimer++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { const id = nextTimer++; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: id => timeouts.delete(id),
    Date: class extends Date { static now() { return now; } },
    fetch() { checks.requests++; throw new Error('列表不应触发网络请求'); } };
  if (watch) context.location.pathname = '/c/6ada4c7d-45d8-83ec-bc09-0c96190ec25e';
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return { context, body, api: context.__cvTurns, stored, checks, dock: () => document.getElementById('cv-float-dock'),
    panel: () => document.getElementById('cv-turn-panel')?.shadowRoot,
    tick(ms = 1000) {
      now += ms;
      for (const { fn, ms: every } of [...intervals.values()]) if (every === 1000) fn();
    },
    stop() {
      streaming = false;
      this.tick();
      for (const [id, { fn, ms }] of [...timeouts]) if (ms === 1000) { timeouts.delete(id); fn(); }
    },
    start(id = 'u-live') {
      users.push({ getAttribute: key => key === 'data-message-id' ? id : null, textContent: 'question' });
      streaming = true;
      this.tick();
    } };
}

const conv = {
  conversation_id: 'c1', current_node: 'a2',
  mapping: {
    u1: { parent: null, message: { id: 'u1', create_time: 1, author: { role: 'user' } } },
    a1: { parent: 'u1', message: { id: 'a1', create_time: 3, author: { role: 'assistant' } } },
    u2: { parent: 'a1', message: { id: 'u2', create_time: 4, author: { role: 'user' } } },
    a2: { parent: 'u2', message: { id: 'a2', create_time: 6, author: { role: 'assistant' } } },
  },
};

// 连接器/agent 线程（如 Chappie）：只有 assistant 与 tool 记录，一条 user 提问都没有
const userlessConv = {
  conversation_id: 'c2', current_node: 'm3',
  mapping: {
    m1: { parent: null, message: { id: 'm1', create_time: 1, author: { role: 'assistant' } } },
    m2: { parent: 'm1', message: { id: 'm2', create_time: 3, author: { role: 'tool' } } },
    m3: { parent: 'm2', message: { id: 'm3', create_time: 5, author: { role: 'assistant' } } },
  },
};

test('浮层同列：中断提示 → 总览胶囊 → 计时器，互不遮挡', async () => {
  const p = setup();
  p.api.renderTurns(conv, { kinds: { u1: 'codex', u2: 'chat' }, codexUrl: CODEX_URL });
  p.context.showTimer(Date.now());
  const banner = p.context.document.createElement('div');
  banner.id = 'cv-stalled-turn-banner';
  p.api.mountFloat(banner, 'stalled');
  const dock = p.dock();
  assert.ok(dock, '右下角列已创建');
  assert.deepEqual(dock.children.map(child => child.id), ['cv-stalled-turn-banner', 'cv-turn-panel', 'cv-turn-timer']);
  assert.ok(dock.children.every(child => child.getAttribute('data-cv-docked')), '列内浮层改为静态定位');
  assert.equal(p.body.children.filter(child => child.id !== 'cv-float-dock').length, 0, '不再各自挂在 body 上');
});

test('总览默认收起成胶囊；展开后逐轮显示 W/C 标签，Work 行带 Codex 链接', async () => {
  const p = setup();
  p.api.renderTurns(conv, { kinds: { u1: 'codex', u2: 'chat' }, codexUrl: CODEX_URL });
  const root = p.context.document.getElementById('cv-turn-panel').shadowRoot;
  assert.match(root.getElementById('sum').textContent, /^⏱ 2 轮 · \S+/);
  assert.equal(root.getElementById('card').className, 'cv-card p', '默认收起');
  const rows = root.getElementById('rows').innerHTML;
  assert.match(rows, /#1<i class="k w"[^>]*>W<\/i><a href="https:\/\/chatgpt\.com\/local\/01a11a8b/);
  assert.match(rows, /#2<i class="k c"[^>]*>C<\/i><\/span>/);
  assert.equal(rows.match(/Codex ↗/g).length, 1, '只有 Work 行带链接');
  root.getElementById('drag').fire('click');
  assert.equal(root.getElementById('card').className, 'cv-card p open');
  await settle();
  assert.equal(p.stored.cvTurnPanelOpenV1, true, '展开偏好记在本地');
});

test('全是 Chat 时不画标签；未关联时 Work 行不画链接', () => {
  const p = setup();
  p.api.renderTurns(conv, { kinds: { u1: 'chat', u2: 'chat' }, codexUrl: CODEX_URL });
  const rows = p.context.document.getElementById('cv-turn-panel').shadowRoot.getElementById('rows').innerHTML;
  assert.doesNotMatch(rows, /class="k /);
  const q = setup();
  q.api.renderTurns(conv, { kinds: { u1: 'codex', u2: 'chat' } });
  const rows2 = q.context.document.getElementById('cv-turn-panel').shadowRoot.getElementById('rows').innerHTML;
  assert.match(rows2, /class="k w"/);
  assert.doesNotMatch(rows2, /Codex ↗/);
});

test('拖动胶囊移动整列并按右下角保存；拖完松手不算点击', async () => {
  const p = setup();
  p.api.renderTurns(conv, {});
  const root = p.context.document.getElementById('cv-turn-panel').shadowRoot;
  const handle = root.getElementById('drag');
  handle.fire('pointerdown', { clientX: 910, clientY: 610 });
  handle.fire('pointermove', { clientX: 911, clientY: 611 });
  assert.equal(p.dock().style.right, undefined, '3px 内的抖动不移动');
  handle.fire('pointermove', { clientX: 510, clientY: 310 });
  handle.fire('pointerup');
  handle.fire('click');
  assert.equal(root.getElementById('card').className, 'cv-card p', '拖动后的 click 被忽略');
  assert.equal(p.dock().style.left, 'auto');
  assert.equal(p.dock().style.right, '880px');    // 视口 1500 - 左边 500 - 宽 120
  assert.equal(p.dock().style.bottom, '570px');   // 视口 900 - 顶 300 - 高 30
  await settle();
  assert.deepEqual(Object.keys(p.stored.cvFloatDockPositionV1).sort(), ['bottom', 'right']);
});

test('打开对话先用缓存画出胶囊（标「更新中」），真实数据到了覆盖；没缓存时先放「加载中」', () => {
  const p = setup();
  const live = p.api.renderTurns(conv, {});
  const cache = { convId: 'c1', dots: false, turns: p.api.compactTurns(live.list) };
  assert.equal(JSON.stringify(cache).includes('prompt'), false, '缓存不含正文');
  const q = setup();
  q.api.showTurnsLoading('c1');
  const sum = () => q.context.document.getElementById('cv-turn-panel').shadowRoot.getElementById('sum').textContent;
  assert.equal(sum(), '⏱ 加载中…');
  q.api.renderCached(cache, {});
  assert.match(sum(), /^⏱ 2 轮 · .* · 更新中…$/);
  q.api.renderTurns(conv, {});
  assert.doesNotMatch(sum(), /更新中/, '真实数据画完就去掉标记');
});

test('没有用户提问的对话（连接器/agent 线程）给出明确状态，不一直停在「加载中」', () => {
  const p = setup();
  p.api.showTurnsLoading('c2');
  const root = () => p.context.document.getElementById('cv-turn-panel').shadowRoot;
  assert.equal(root().getElementById('sum').textContent, '⏱ 加载中…');
  const result = p.api.renderTurns(userlessConv, {});
  assert.equal(result.turns, 0);
  assert.equal(result.empty, 'no-user');
  assert.equal(root().getElementById('sum').textContent, '⏱ 无用户提问，不分轮');
  assert.match(root().getElementById('drag').title, /没有用户提问/);
  // 缓存也记着这个状态：SPA 内切回该对话时画出的仍是明确状态
  const q = setup();
  q.api.renderCached({ convId: 'c2', dots: false, turns: [], empty: 'no-user' }, {});
  const sum = q.context.document.getElementById('cv-turn-panel').shadowRoot.getElementById('sum').textContent;
  assert.equal(sum, '⏱ 无用户提问，不分轮');
});

test('一条消息都没有的对话仍按原样撤掉面板', () => {
  const p = setup();
  const result = p.api.renderTurns({ conversation_id: 'c3', current_node: null, mapping: {} }, {});
  assert.equal(result.turns, 0);
  assert.equal(result.empty, undefined);
  assert.equal(p.context.document.getElementById('cv-turn-panel'), null);
});

test('新对话没有快照时，列表直接显示当前轮并更新测速；结束后保留实测耗时', () => {
  const p = setup({ watch: true });
  const convId = p.context.location.pathname.split('/').at(-1);
  let stats = { userMessageId: 'u-live', ttftMs: 18000, tokenCount: 8492, tps: 23.2 };
  p.context.__cvSpeed = { snapshot: () => stats, finishRound: () => stats };
  p.api.showTurnsLoading(convId);
  p.api.watchStreaming(() => {}, () => null);
  p.start();
  assert.match(p.panel().getElementById('sum').textContent, /当前轮 · 进行中 · 历史待加载/);
  assert.match(p.panel().getElementById('rows').innerHTML, /当前轮.*进行中/);
  assert.match(p.panel().getElementById('rows').innerHTML, /8,492 out/);
  assert.doesNotMatch(p.panel().getElementById('rows').innerHTML, /暂无|#1/);
  const scans = p.checks.anchorScans;
  stats = { ...stats, tokenCount: 9000 };
  p.tick(6000);
  assert.match(p.panel().getElementById('rows').innerHTML, /9,000 out/);
  assert.equal(p.checks.anchorScans, scans, '更新当前行不重扫历史消息锚点');
  p.stop();
  assert.match(p.panel().getElementById('rows').innerHTML, /7\.0s/);
  assert.doesNotMatch(p.panel().getElementById('rows').innerHTML, /进行中|待回复/);
  assert.equal(p.checks.requests, 0);
  p.context.__cvPage = { can: feature => feature !== 'speedMetrics' };
  p.api.renderTurns({ conversation_id: convId, mapping: {} });
  assert.doesNotMatch(p.panel().getElementById('rows').innerHTML, /out|TPS/, '关闭测速后完成行也隐藏旧指标');
});

test('缓存或旧快照缺少当前轮时补行；完整快照到达后按用户消息 ID 合并', () => {
  const p = setup({ watch: true });
  const convId = p.context.location.pathname.split('/').at(-1);
  const history = { ...conv, conversation_id: convId };
  p.api.renderCached({ convId, turns: p.api.compactTurns(p.api.turnsOf(history)) });
  p.api.watchStreaming(() => {}, () => null);
  p.start('u3');
  assert.match(p.panel().getElementById('rows').innerHTML, /#3.*进行中/);
  p.api.renderTurns(history, { streaming: true });
  assert.match(p.panel().getElementById('rows').innerHTML, /#3.*进行中/);
  const complete = { ...history, current_node: 'u3', mapping: { ...history.mapping,
    u3: { parent: 'a2', message: { id: 'u3', create_time: 1001, author: { role: 'user' } } } } };
  p.api.renderTurns(complete, { streaming: true });
  assert.match(p.panel().getElementById('sum').textContent, /3 轮/);
  assert.equal((p.panel().getElementById('rows').innerHTML.match(/class="r"/g) || []).length, 3);
  assert.equal((p.panel().getElementById('rows').innerHTML.match(/进行中/g) || []).length, 1);
  assert.doesNotMatch(p.panel().getElementById('sum').textContent, /历史待加载/);
  p.stop();
  assert.doesNotMatch(p.panel().getElementById('rows').innerHTML, /进行中|待回复/);
  p.api.renderTurns(complete, { streaming: false });
  assert.doesNotMatch(p.panel().getElementById('rows').innerHTML, /进行中|待回复/,
    '只含当前用户消息的迟到快照，不能抹掉已观测到的完成状态');
});

test('历史仍未到达时可连续记录多轮；切换对话不会带入旧轮次', () => {
  const p = setup({ watch: true });
  p.api.watchStreaming(() => {}, () => null);
  p.start('u1'); p.stop(); p.start('u2');
  assert.match(p.panel().getElementById('sum').textContent, /本页 2 轮/);
  assert.equal((p.panel().getElementById('rows').innerHTML.match(/class="r"/g) || []).length, 2);
  p.context.location.pathname = '/c/11111111-1111-1111-1111-111111111111';
  p.api.clear(); p.tick();
  assert.match(p.panel().getElementById('sum').textContent, /当前轮/);
  assert.equal((p.panel().getElementById('rows').innerHTML.match(/class="r"/g) || []).length, 1);
});

test('同一消息恢复推流不重复加行；未知 DOM id 后来由测速补齐仍与快照合并', () => {
  const p = setup({ watch: true });
  const convId = p.context.location.pathname.split('/').at(-1);
  let stats = null;
  p.context.__cvSpeed = { snapshot: () => stats };
  p.api.watchStreaming(() => {}, () => null);
  p.start(null);
  assert.match(p.panel().getElementById('rows').innerHTML, /当前轮/);
  stats = { userMessageId: 'u-live', tokenCount: 50 };
  p.tick();
  const snapshot = { conversation_id: convId, current_node: 'u', mapping: {
    u: { message: { id: 'u-live', create_time: 1001, author: { role: 'user' } } },
  } };
  p.api.renderTurns(snapshot, { streaming: true });
  assert.equal((p.panel().getElementById('rows').innerHTML.match(/class="r"/g) || []).length, 1);
  p.stop(); p.start(null);
  assert.equal((p.panel().getElementById('rows').innerHTML.match(/class="r"/g) || []).length, 1);
});
