import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../extensions/chatgpt-sync/turns.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ getThrows = false, setThrows = false, speedThrows = false, dragThrows = false } = {}) {
  let now = Date.parse('2026-09-30T15:20:00Z');
  const intervals = new Map();
  const handlers = new Map();
  let nextInterval = 1;
  const nodes = { v: { textContent: '0.0s' }, from: { textContent: '' }, speed: { textContent: '', title: '' } };
  const handle = { isConnected: true,
    addEventListener(name, fn) { if (dragThrows) throw new Error('decorative drag failed'); handlers.set(name, fn); },
    setPointerCapture() {}, releasePointerCapture() {} };
  const host = { style: {}, isConnected: true, getBoundingClientRect: () => ({ left: 400, top: 500, width: 120, height: 40 }),
    attachShadow() { return this.shadowRoot = { innerHTML: '', querySelector: () => handle, getElementById: id => nodes[id] }; },
    remove() { this.isConnected = false; } };
  const context = vm.createContext({ document: { body: { appendChild() {} }, createElement: () => host,
    addEventListener() {}, removeEventListener() {} }, location: { pathname: '/c/test' },
    globalThis: { __cvSpeed: { snapshot() { if (speedThrows) throw new Error('speed snapshot failed'); return null; } } },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
    chrome: { storage: { local: {
      get() { if (getThrows) throw new Error('Extension context invalidated.'); return Promise.resolve({}); },
      set() { if (setThrows) throw new Error('Extension context invalidated.'); return Promise.resolve(); },
    } } },
    Date: class extends Date { static now() { return now; } },
    setInterval: (fn, ms) => { const id = nextInterval++; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => intervals.delete(id), console: { debug() {} },
  });
  vm.runInContext(source, context);
  return { context, nodes, host, handlers, intervals, now: () => now, api: context.globalThis.__cvTurns,
    tick(ms) { now += ms; for (const timer of [...intervals.values()]) timer.fn(); } };
}

test('扩展重载导致位置读取同步抛错时，计时器仍完成首次绘制并持续计时', async () => {
  const p = fixture({getThrows:true});
  assert.doesNotThrow(() => p.context.showTimer(p.now()-2000));
  await flush();
  assert.equal(p.nodes.v.textContent, '2.0s');
  assert.match(p.nodes.from.textContent, /始于/);
  p.tick(1500);
  assert.equal(p.nodes.v.textContent, '3.5s');
  assert.equal(p.api.status().loop_active, true);
  assert.equal(p.api.status().reload_required, true);
  assert.equal(p.api.status().last_error.stage, 'position.read');
});

test('保存拖动位置的同步异常不会中断计时器和鼠标事件', async () => {
  const p = fixture({setThrows:true});
  p.context.showTimer(p.now()-1000);
  await flush();
  p.handlers.get('pointerdown')({button:0,pointerId:1,clientX:410,clientY:510,preventDefault(){}});
  // 只按下松开（未移动）不写位置；真正拖动过才保存。
  p.handlers.get('pointermove')({pointerId:1,clientX:300,clientY:400});
  assert.doesNotThrow(() => p.handlers.get('pointerup')({pointerId:1}));
  p.tick(2000);
  assert.equal(p.nodes.v.textContent, '3.0s');
  assert.equal(p.api.status().last_error.stage, 'position.write');
});

test('测速模块报错不影响耗时，错误保存在只读探针中而不是每100ms重复打日志', () => {
  const p = fixture({speedThrows:true});
  assert.doesNotThrow(() => p.context.showTimer(p.now()-2000));
  const firstError = p.api.status().last_error.at;
  p.tick(3000);
  assert.equal(p.nodes.v.textContent, '5.0s');
  assert.equal(p.api.status().last_error.stage, 'speed.paint');
  assert.equal(p.api.status().last_error.at, firstError);
});

test('拖动装饰初始化失败不阻止计时循环，已有半初始化计时器也能重新启动', () => {
  const p = fixture({dragThrows:true});
  assert.doesNotThrow(() => p.context.showTimer(p.now()-2000));
  assert.equal(p.api.status().last_error.stage, 'drag.init');
  p.tick(2000);
  assert.equal(p.nodes.v.textContent, '4.0s');
  vm.runInContext('clearInterval(timerTick); timerTick = null;',p.context);
  p.context.showTimer(p.now()-4000);
  p.tick(1000);
  assert.equal(p.nodes.v.textContent, '5.0s');
  assert.equal(p.api.status().loop_active, true);
  p.context.hideTimer();
  assert.equal(p.api.status().loop_active, false);
});
