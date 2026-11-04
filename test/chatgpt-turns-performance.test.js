import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/turns.js', import.meta.url), 'utf8');

test('测速显示先累计 out 再 TPS，使用同一分词计数而非上游总用量', () => {
  const context = { location: { pathname: '/c/test' }, globalThis: {} };
  vm.runInNewContext(source, context);
  const stats = { ttftMs: 34000, tokenCount: 1234, tps: 4.5, outputTokens: 9999 };
  assert.equal(context.fmtSpeed(stats), 'TTFT 34s · 1,234 out · ≈TPS 4.5');
  assert.match(context.speedTip(stats), /output_tokens=9,999/);
  assert.match(context.speedTip(stats), /不替代这里的 out 或 TPS 分子/);
  assert.equal(context.fmtSpeed(null), '');
  assert.equal(context.fmtSpeed({ ttftMs: null, tokenCount: null, tps: null }),
    'TTFT — · — out · ≈TPS —');
  assert.equal(context.fmtSpeed({ ttftMs: 1000, tokenCount: 0, tps: null }),
    'TTFT 1.0s · 0 out · ≈TPS —');
});

test('实时计时器显示累计输出，100ms 检查不会重复改写未变化的测速节点', () => {
  const intervals = [];
  const nodes = { v: { textContent: '' }, from: { textContent: '' } };
  let textWrites = 0, titleWrites = 0;
  nodes.speed = {
    _text: '', _title: '',
    get textContent() { return this._text; },
    set textContent(value) { this._text = value; textWrites++; },
    get title() { return this._title; },
    set title(value) { this._title = value; titleWrites++; },
  };
  let stats = { ttftMs: 34000, tokenCount: 1234, tps: 4.5 };
  const context = {
    location: { pathname: '/c/test' },
    globalThis: { __cvSpeed: { snapshot: () => stats } },
    document: {
      body: { appendChild() {} },
      createElement: () => ({
        attachShadow: () => ({ innerHTML: '', getElementById: id => nodes[id] }),
        remove() {},
      }),
    },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; },
    clearInterval() {},
  };
  vm.runInNewContext(source, context);
  context.showTimer(Date.now());
  assert.equal(intervals[0].ms, 100);
  assert.equal(nodes.speed.textContent, 'TTFT 34s · 1,234 out · ≈TPS 4.5');
  const before = [textWrites, titleWrites];
  intervals[0].fn();
  assert.deepEqual([textWrites, titleWrites], before);
  stats = { ...stats, tokenCount: 2345, tps: 6.7 };
  intervals[0].fn();
  assert.equal(nodes.speed.textContent, 'TTFT 34s · 2,345 out · ≈TPS 6.7');
  assert.equal(textWrites, before[0] + 1);
  assert.equal(titleWrites, before[1]);
  context.hideTimer();
});

test('拒绝把上一轮起点记到最新轮次的旧实测值，接受带起止证据的新值', () => {
  const context = { location: { pathname: '/c/test' }, globalThis: {} };
  vm.runInNewContext(source, context);
  const start = Date.parse('2026-09-29T06:08:54.271Z');
  const end = Date.parse('2026-09-29T06:30:32.726Z');
  const turn = { start: start / 1000, ms: end - start, count: 1 };
  assert.equal(context.measuredMsForTurn(turn, 66 * 60 * 1000 + 13000), null);
  const actual = { ms: end - start + 3000, startedAtMs: start,
    endedAtMs: end + 3000 };
  assert.equal(context.measuredMsForTurn(turn, actual), actual.ms);
  assert.equal(context.measuredMsForTurn(turn, { ...actual, startedAtMs: start - 44 * 60 * 1000 }), null);
});

test('长对话徽标一次收集消息锚点，重复重画不再改写相同内容', () => {
  let anchorScans = 0;
  let writes = 0;
  const holders = [];
  const anchors = new Map();
  let panel = null;
  function makeAnchor(id) {
    const holder = {
      hosts: [],
      querySelectorAll(selector) {
        assert.equal(selector, '.cv-turn-host');
        return this.hosts;
      },
      insertBefore(host) { this.hosts.unshift(host); },
      appendChild(host) { this.hosts.push(host); },
    };
    holders.push(holder);
    anchors.set(id, { parentElement: holder, getAttribute: () => id });
  }
  for (const id of ['u1', 'a1', 'u2', 'a2']) makeAnchor(id);

  const document = {
    body: { appendChild(host) { if (host.id === 'cv-turn-panel') panel = host; } },
    querySelectorAll(selector) {
      if (selector === '[data-message-id]') {
        anchorScans++;
        return [...anchors.values()];
      }
      if (selector === '.cv-turn-host') return holders.flatMap((holder) => holder.hosts);
      if (selector === '[data-message-author-role="user"], [data-testid="user-message"]') return [];
      if (selector === '[data-chatgpt-selection-message-id]' || selector === '[data-chatgpt-search-message-ids]') return [];
      throw new Error(`unexpected selector: ${selector}`);
    },
    querySelector() { throw new Error('不应逐条消息扫描整个页面'); },
    getElementById(id) { return id === 'cv-turn-panel' ? panel : null; },
    createElement() {
      const span = {
        _text: '', _html: '', _title: '',
        get textContent() { return this._text; },
        set textContent(value) { writes++; this._text = value; this._html = value; },
        get innerHTML() { return this._html; },
        set innerHTML(value) { writes++; this._html = value; this._text = value.replace(/<[^>]+>/g, ''); },
        get title() { return this._title; },
        set title(value) { writes++; this._title = value; },
      };
      return {
        dataset: {},
        setAttribute() {},
        attachShadow() {
          if (this.id === 'cv-turn-panel') {
            const rows = { _html: '', get innerHTML() { return this._html; },
              set innerHTML(value) { writes++; this._html = value; } };
            const root = { getElementById: (id) => id === 'rows' ? rows : {} };
            this.shadowRoot = root;
            return root;
          }
          const root = {
            querySelector: () => span,
            set innerHTML(value) {
              const match = /<span class="b [^"]*" title="([^"]*)">([\s\S]*)<\/span>/.exec(value);
              span._title = match?.[1] || '';
              span._html = match?.[2] || '';
              span._text = span._html.replace(/<[^>]+>/g, '');
            },
          };
          this.shadowRoot = root;
          return root;
        },
      };
    },
  };
  const context = { document, location: { pathname: '/c/test' }, globalThis: {} };
  vm.runInNewContext(source, context);
  const conv = {
    conversation_id: 'c1', current_node: 'a2',
    mapping: {
      u1: { parent: null, message: { id: 'u1', create_time: 1, author: { role: 'user' } } },
      a1: { parent: 'u1', message: { id: 'a1', create_time: 3, author: { role: 'assistant' } } },
      u2: { parent: 'a1', message: { id: 'u2', create_time: 4, author: { role: 'user' } } },
      a2: { parent: 'u2', message: { id: 'a2', create_time: 6, author: { role: 'assistant' } } },
    },
  };
  assert.equal(context.globalThis.__cvTurns.renderTurns(conv).anchored, 4);
  const firstWrites = writes;
  assert.equal(context.globalThis.__cvTurns.renderTurns(conv).anchored, 4);
  assert.equal(anchorScans, 2);
  assert.equal(writes, firstWrites);
  assert.equal(holders.flatMap((holder) => holder.hosts).length, 4);
  assert.ok(panel, '总览面板应与消息徽标同时显示');
  context.globalThis.__cvSpeed = { lookup: () => ({ ttftMs: 34000, tokenCount: 1234, tps: 4.5 }) };
  context.globalThis.__cvTurns.renderTurns(conv);
  assert.ok(panel.shadowRoot.getElementById('rows').innerHTML
    .includes('TTFT 34s · 1,234 out · ≈TPS 4.5'), '历史悬浮列表与实时计时器使用相同格式');
});

test('没有 data-message-id 时，唯一正文匹配仍能挂起止徽标', () => {
  const badges = [];
  let panel = null;
  const makeHolder = () => ({
    children: [], firstChild: null,
    querySelectorAll: () => badges,
    insertBefore(host) { badges.push(host); }, appendChild(host) { badges.push(host); },
  });
  const user = { textContent: '新的用户问题', parentElement: makeHolder(), getAttribute: (key) =>
    key === 'data-message-author-role' ? 'user' : null };
  const assistant = { textContent: '助手回答', parentElement: makeHolder(), getAttribute: (key) =>
    key === 'data-message-author-role' ? 'assistant' : null };
  const document = {
    body: { appendChild(host) { panel = host; } },
    getElementById: () => panel,
    querySelectorAll(selector) {
      if (selector === '[data-message-id]') return [];
      if (selector === '[data-chatgpt-selection-message-id]' || selector === '[data-chatgpt-search-message-ids]') return [];
      if (selector === '[data-message-author-role="user"], [data-testid="user-message"]') return [user];
      if (selector.includes('assistant-message')) return [user, assistant];
      if (selector === '.cv-turn-host') return badges;
      throw new Error(selector);
    },
    createElement() {
      return {
        dataset: {}, setAttribute() {},
        attachShadow() {
          if (this.id === 'cv-turn-panel') {
            const rows = { innerHTML: '' };
            return this.shadowRoot = { getElementById: (id) => id === 'rows' ? rows : {} };
          }
          const span = { innerHTML: '', title: '', textContent: '' };
          return this.shadowRoot = { querySelector: () => span, set innerHTML(_) {} };
        },
      };
    },
  };
  const context = { document, location: { pathname: '/c/test' }, globalThis: {} };
  vm.runInNewContext(source, context);
  const conv = { conversation_id: 'test', current_node: 'a1', mapping: {
    u1: { parent: null, message: { id: 'u1', create_time: 1, author: { role: 'user' },
      content: { parts: ['新的用户问题'] } } },
    a1: { parent: 'u1', message: { id: 'a1', create_time: 3, author: { role: 'assistant' } } },
  } };
  assert.equal(context.globalThis.__cvTurns.renderTurns(conv).anchored, 2);
  assert.ok(panel);
});

test('新版 ChatGPT search/selection 消息 ID 能直接挂徽标并识别用户气泡', () => {
  let panel = null;
  const makeNode = (attrs) => ({
    attrs, badges: [], dataset: {},
    getAttribute(name) { return this.attrs[name] || null; },
    matches(selector) { return Object.keys(this.attrs).some((name) => selector.includes(`[${name}]`)); },
    querySelectorAll() { return this.badges; },
    insertBefore(host) { this.badges.unshift(host); },
    appendChild(host) { this.badges.push(host); },
  });
  const user = makeNode({ 'data-chatgpt-search-message-ids': 'u-uuid-placeholder' });
  const assistant = makeNode({ 'data-chatgpt-selection-message-id': 'a-uuid-placeholder' });
  const userId = '11111111-1111-1111-1111-111111111111';
  const assistantId = '22222222-2222-2222-2222-222222222222';
  user.attrs['data-chatgpt-search-message-ids'] = userId;
  assistant.attrs['data-chatgpt-selection-message-id'] = assistantId;
  const bubble = { getAttribute: () => null, textContent: '新的用户问题',
    closest: (selector) => selector.includes('search-message-ids') ? user : null };
  const document = {
    body: { appendChild(host) { panel = host; } },
    getElementById: () => panel,
    querySelectorAll(selector) {
      if (selector === '[data-message-id]') return [];
      if (selector === '[data-chatgpt-selection-message-id]') return [assistant];
      if (selector === '[data-chatgpt-search-message-ids]') return [user];
      if (selector === '[data-message-author-role="user"], [data-testid="user-message"]') return [];
      if (selector === '[data-message-author-role="user"], [data-testid="user-message"], [data-user-message-bubble], .message-row.self[data-message-id]') return [bubble];
      if (selector === '.cv-turn-host') return [...user.badges, ...assistant.badges];
      throw new Error(selector);
    },
    createElement() {
      return {
        dataset: {}, setAttribute() {},
        attachShadow() {
          if (this.id === 'cv-turn-panel') {
            const rows = { innerHTML: '' };
            return this.shadowRoot = { getElementById: (id) => id === 'rows' ? rows : {} };
          }
          const span = { innerHTML: '', title: '', textContent: '' };
          return this.shadowRoot = { querySelector: () => span, set innerHTML(_) {} };
        },
      };
    },
  };
  const context = { document, location: { pathname: '/c/test' }, globalThis: {} };
  vm.runInNewContext(source, context);
  const conv = { conversation_id: 'test', current_node: assistantId, mapping: {
    [userId]: { parent: null, message: { id: userId, create_time: 1, author: { role: 'user' },
      content: { parts: ['新的用户问题'] } } },
    [assistantId]: { parent: userId, message: { id: assistantId, create_time: 3, author: { role: 'assistant' } } },
  } };
  assert.equal(context.globalThis.__cvTurns.renderTurns(conv).anchored, 2);
  assert.equal(user.badges.length, 1);
  assert.equal(assistant.badges.length, 1);
  assert.equal(context.trackUserMessages().id, userId);
});

test('图片回复后只有无 DOM 锚点的思考记录时，结束徽标仍挂到图片消息后', () => {
  const ids = {
    user: '11111111-1111-1111-1111-111111111111',
    image: '22222222-2222-2222-2222-222222222222',
    thought: '33333333-3333-3333-3333-333333333333',
    recap: '44444444-4444-4444-4444-444444444444',
    nextUser: '55555555-5555-5555-5555-555555555555',
  };
  const makeNode = (id) => ({ badges: [],
    getAttribute: () => id,
    matches: (selector) => selector.includes('data-chatgpt-search-message-ids'),
    querySelectorAll() { return this.badges; },
    insertBefore(host) { this.badges.unshift(host); },
    appendChild(host) { this.badges.push(host); },
  });
  const user = makeNode(ids.user);
  const image = makeNode(ids.image);
  const nextUser = makeNode(ids.nextUser);
  let panel = null;
  const document = {
    body: { appendChild(host) { panel = host; } },
    getElementById: () => panel,
    querySelectorAll(selector) {
      if (selector === '[data-message-id]' || selector === '[data-chatgpt-selection-message-id]') return [];
      if (selector === '[data-chatgpt-search-message-ids]') return [user, image, nextUser];
      if (selector === '[data-message-author-role="user"], [data-testid="user-message"]') return [];
      if (selector === '.cv-turn-host') return [...user.badges, ...image.badges, ...nextUser.badges];
      throw new Error(selector);
    },
    createElement() {
      return { dataset: {}, setAttribute() {},
        attachShadow() {
          if (this.id === 'cv-turn-panel') {
            const rows = { innerHTML: '' };
            return this.shadowRoot = { getElementById: () => rows };
          }
          const span = { innerHTML: '', title: '', textContent: '' };
          return this.shadowRoot = { querySelector: () => span, set innerHTML(_) {} };
        } };
    },
  };
  const context = { document, location: { pathname: '/c/test' }, globalThis: {} };
  vm.runInNewContext(source, context);
  const message = (id, parent, role, create_time, metadata = {}) => ({
    parent, message: { id, create_time, author: { role }, metadata },
  });
  const conv = { conversation_id: 'test', current_node: ids.nextUser, mapping: {
    [ids.user]: message(ids.user, null, 'user', 1),
    [ids.image]: message(ids.image, ids.user, 'tool', 2),
    [ids.thought]: message(ids.thought, ids.image, 'assistant', 3),
    [ids.recap]: message(ids.recap, ids.thought, 'assistant', 4),
    [ids.nextUser]: message(ids.nextUser, ids.recap, 'user', 5),
  } };
  const firstTurn = context.globalThis.__cvTurns.turnsOf(conv)[0];
  assert.equal(firstTurn.endId, ids.recap, '本轮结束时间仍来自最后的 JSON 记录');
  assert.equal(context.globalThis.__cvTurns.renderTurns(conv).anchored, 3);
  assert.equal(image.badges.length, 1);
  assert.equal(image.badges[0].dataset.cvFor, `${ids.recap}:end`);
  assert.equal(user.badges.length, 1);
  assert.equal(nextUser.badges.length, 1);
});

test('新发出的用户消息在轮次结束时直接提供 id，刷新接续仍保留回查路径', () => {
  function run(initiallyStreaming) {
    let streaming = initiallyStreaming;
    const users = ['old'];
    const intervals = [];
    const timeouts = [];
    const ended = [];
    const document = {
      body: { appendChild() {} },
      querySelector: () => streaming ? {} : null,
      querySelectorAll: () => users.map((id) => ({ getAttribute: () => id })),
      createElement() {
        return {
          attachShadow() { return { getElementById: () => ({ textContent: '' }) }; },
          remove() {},
        };
      },
    };
    const context = {
      document, location: { pathname: '/c/test' }, globalThis: {},
      MutationObserver: class { observe() {} },
      setInterval: (fn) => { intervals.push(fn); },
      clearInterval() {}, setTimeout: (fn) => { timeouts.push(fn); },
    };
    vm.runInNewContext(source, context);
    context.globalThis.__cvTurns.watchStreaming((event) => ended.push(event), () => null);
    if (!initiallyStreaming) {
      users.push('new');
      streaming = true;
      intervals[0]();
    }
    streaming = false;
    intervals[0]();
    timeouts.shift()?.();
    return ended[0];
  }
  assert.equal(run(false).userMessageId, 'new');
  assert.equal(run(true).userMessageId, null);
});

test('停止按钮连续存在时，新用户正文会切换轮次而非沿用旧计时器', () => {
  let streaming = true;
  const users = ['上一轮'];
  const intervals = [];
  const timeouts = [];
  const ended = [];
  const started = [];
  const document = {
    body: { appendChild() {} },
    querySelector: () => streaming ? {} : null,
    querySelectorAll: () => users.map((body) => ({
      getAttribute: () => null, textContent: body,
    })),
    createElement() {
      return { attachShadow() { return { getElementById: () => ({ textContent: '' }) }; }, remove() {} };
    },
  };
  const context = {
    document, location: { pathname: '/c/test' }, globalThis: {},
    MutationObserver: class { observe() {} },
    setInterval: (fn) => { intervals.push(fn); }, clearInterval() {},
    setTimeout: (fn) => { const entry = { fn, cancelled: false }; timeouts.push(entry); return entry; },
    clearTimeout: (entry) => { if (entry) entry.cancelled = true; },
  };
  vm.runInNewContext(source, context);
  context.globalThis.__cvTurns.watchStreaming((event) => ended.push(event), () => null, () => started.push(true));
  streaming = false;
  intervals[0]();
  streaming = true;
  intervals[0]();
  assert.equal(ended.length, 0, '停止按钮短暂消失不能结束轮次');
  assert.equal(timeouts[0].cancelled, true);
  users.push('新的一轮');
  intervals[0]();
  assert.equal(ended.length, 1);
  assert.equal(ended[0].superseded, true);
  assert.equal(started.length, 1);
  assert.equal(context.document.body !== null, true);
});

test('悬浮层拖动后保存位置，重画不会重建拖动状态', async () => {
  const handlers = new Map();
  const stored = [];
  const host = {
    style: {},
    getBoundingClientRect() {
      return { left: Number.parseFloat(this.style.left) || 800,
        top: Number.parseFloat(this.style.top) || 600, width: 120, height: 40 };
    },
  };
  const handle = {
    addEventListener(name, fn) { handlers.set(name, fn); },
    setPointerCapture() {}, releasePointerCapture() {},
  };
  const context = { globalThis: {}, location: { pathname: '/c/test' },
    window: { innerWidth: 1000, innerHeight: 700,
      addEventListener() {}, removeEventListener() {} },
    chrome: { storage: { local: {
      get: async () => ({ testPosition: null }),
      set: async (value) => { stored.push(value); },
    } } } };
  vm.runInNewContext(source, context);
  context.makeDraggable(host, handle, 'testPosition');
  handlers.get('pointerdown')({ button: 0, pointerId: 1, clientX: 810, clientY: 610,
    preventDefault() {} });
  handlers.get('pointermove')({ pointerId: 1, clientX: 300, clientY: 200 });
  assert.equal(host.style.left, '290px');
  assert.equal(host.style.top, '190px');
  handlers.get('pointerup')({ pointerId: 1 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].testPosition.left, 290);
});

test('视口变化会把屏幕外的浮层夹回并保存新位置', async () => {
  let resize;
  const stored = [];
  const host = {
    isConnected: true,
    style: {},
    getBoundingClientRect() {
      return { left: Number.parseFloat(this.style.left) || 800,
        top: Number.parseFloat(this.style.top) || 600, width: 120, height: 40 };
    },
  };
  const handle = {
    isConnected: true,
    addEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
  };
  const context = { globalThis: {}, location: { pathname: '/c/test' },
    window: {
      innerWidth: 1000, innerHeight: 700,
      addEventListener(name, fn) { if (name === 'resize') resize = fn; },
      removeEventListener() {},
    },
    chrome: { storage: { local: {
      get: async () => ({ testPosition: { left: 120, top: 1200 } }),
      set: async (value) => { stored.push(value); },
    } } } };
  vm.runInNewContext(source, context);
  context.makeDraggable(host, handle, 'testPosition');
  await Promise.resolve();
  assert.equal(host.style.top, '660px');
  context.window.innerHeight = 500;
  resize();
  assert.equal(host.style.top, '460px');
  assert.equal(stored.at(-1).testPosition.top, 460);
});
