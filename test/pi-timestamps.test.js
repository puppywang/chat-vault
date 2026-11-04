import assert from 'node:assert/strict';
import test from 'node:test';

import localTimeExtension, {
	collectTimes,
	formatClock,
	messageTexts,
	normalizeText,
	withTimeLine,
} from '../integrations/pi-timestamps/extensions/local-time.js';

const AT = new Date(2026, 9, 18, 16, 3, 41, 250); // 本地时间 2026-10-18 16:03:41.250
const AT_MS = AT.getTime();
const iso = (ms) => new Date(ms).toISOString();

class FakeComponent {
	constructor(lines) {
		this.lines = lines;
		this.invalidated = 0;
	}
	render(width) {
		return this.lines.map((line) => line.slice(0, width));
	}
	invalidate() {
		this.invalidated += 1;
	}
}

const theme = { fg: (color, text) => `<${color}>${text}</>` };

function harness(entries = []) {
	const handlers = new Map();
	let toolRenderer;
	let markdownTransformer;
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerToolRenderer(resolver) {
			toolRenderer = resolver;
		},
		registerMarkdownTransformer(transformer) {
			markdownTransformer = transformer;
		},
	};
	localTimeExtension(pi);
	const ctx = { sessionManager: { getEntries: () => entries } };
	return {
		start: (reason = 'startup') => handlers.get('session_start')({ type: 'session_start', reason }, ctx),
		emit: (event, payload) => handlers.get(event)(payload),
		render: (toolCallId, base) => toolRenderer('bash', () => base).renderCall({ command: 'ls' }, theme, { toolCallId }),
		transform: (markdown) => markdownTransformer(markdown, { messageType: 'assistant', isStreaming: false, availableWidth: 80 }),
		resolver: () => toolRenderer,
		handlers,
	};
}

test('本地时间按 HH:MM:SS 渲染，无法解析时返回 null', () => {
	assert.equal(formatClock(AT_MS), '16:03:41');
	assert.equal(formatClock(new Date(2026, 0, 2, 9, 8, 7).getTime()), '09:08:07');
	assert.equal(formatClock(Number.NaN), null);
	assert.equal(formatClock(undefined), null);
	assert.equal(formatClock(null), null);
	assert.equal(formatClock(''), null);
	assert.equal(formatClock('not a time'), null);
});

test('文本键折叠空白并截断，流式前缀可匹配', () => {
	assert.equal(normalizeText('  a\n\n  b  ', 48), 'a b');
	assert.equal(normalizeText('x'.repeat(80), 48), 'x'.repeat(48));
	assert.equal(normalizeText('', 48), '');
});

test('消息文本片段只取 text / thinking 块', () => {
	assert.deepEqual(messageTexts('hi'), ['hi']);
	assert.deepEqual(messageTexts([{ type: 'text', text: 'a' }, { type: 'toolCall', id: 'c1' }, { type: 'thinking', thinking: 't' }]), ['a', 't']);
	assert.deepEqual(messageTexts([{ type: 'image' }]), []);
});

test('collectTimes 从会话条目里取出工具调用、结果与文本时间', () => {
	const { toolCalls, toolResults, texts } = collectTimes([
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'user', content: '第一次提问' } },
		{
			type: 'message',
			timestamp: iso(AT_MS + 1000),
			message: { role: 'assistant', content: [{ type: 'text', text: '答案' }, { type: 'toolCall', id: 'call-a' }] },
		},
		{ type: 'message', timestamp: iso(AT_MS + 2000), message: { role: 'toolResult', toolCallId: 'call-a' } },
		{ type: 'model_change', timestamp: iso(AT_MS + 3000) },
	]);
	assert.equal(toolCalls.get('call-a'), AT_MS + 1000);
	assert.equal(toolResults.get('call-a'), AT_MS + 2000);
	assert.equal(texts.get('第一次提问'), AT_MS);
	assert.equal(texts.get('答案'), AT_MS + 1000);
});

test('工具块显示会话里该次调用的本地时间', () => {
	const h = harness([
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-a' }] } },
	]);
	h.start('resume');
	const base = { renderCall: () => new FakeComponent(['$ ls', '(no output)']) };
	const component = h.render('call-a', base);
	assert.ok(component instanceof FakeComponent, '包装后仍是同一个组件类型');
	assert.deepEqual(component.render(80), ['<dim>[16:03:41]</>', '$ ls', '(no output)']);
	component.invalidate();
	assert.equal(component.lines.length, 2, '包装层不改变原组件状态');
});

test('本次执行的开始时刻优先于会话记录', () => {
	const h = harness([
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-b' }] } },
	]);
	h.start('resume');
	const realNow = Date.now;
	Date.now = () => AT_MS + 65_000;
	h.emit('tool_execution_start', { type: 'tool_execution_start', toolCallId: 'call-b', toolName: 'bash', args: {} });
	Date.now = realNow;
	const component = h.render('call-b', { renderCall: () => new FakeComponent(['$ ls']) });
	assert.deepEqual(component.render(80), [`<dim>[${formatClock(AT_MS + 65_000)}]</>`, '$ ls']);
});

test('没有时间信息时不加前缀', () => {
	const h = harness([]);
	h.start('new');
	const baseComponent = new FakeComponent(['$ ls']);
	const component = h.render('missing', { renderCall: () => baseComponent });
	assert.equal(component, baseComponent);
	assert.deepEqual(component.render(80), ['$ ls']);
});

test('没有 renderCall 的工具把时间显示在结果行上', () => {
	const h = harness([
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'toolResult', toolCallId: 'call-c' } },
	]);
	h.start('resume');
	const resolved = h.resolver()('mcp__x', () => ({ renderResult: () => new FakeComponent(['done']) }));
	assert.equal(resolved.renderCall, undefined);
	const component = resolved.renderResult({}, { expanded: false, isPartial: false }, theme, { toolCallId: 'call-c' });
	assert.deepEqual(component.render(80), ['<dim>[16:03:41]</>', 'done']);
});

test('文本消息前面补上本地时间，流式输出早期也能补', () => {
	const h = harness([
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'user', content: '这是用户的第一条消息' } },
	]);
	h.start('resume');
	assert.equal(h.transform('这是用户的第一条消息'), '[16:03:41]\n\n这是用户的第一条消息');
	assert.equal(h.transform('没见过的内容'), '没见过的内容');
	assert.equal(h.transform('[09:00:00]\n\n已有时间行'), '[09:00:00]\n\n已有时间行');

	h.emit('message_start', { type: 'message_start', message: { role: 'assistant', timestamp: AT_MS + 1000, content: [{ type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }] } });
	assert.equal(h.transform('abcdefghijklmnopqrs'), `[${formatClock(AT_MS + 1000)}]\n\nabcdefghijklmnopqrs`);
});

test('切换新会话时清掉旧的工具时间', () => {
	const entries = [
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-d' }] } },
	];
	const h = harness(entries);
	h.start('resume');
	assert.equal(h.render('call-d', { renderCall: () => new FakeComponent(['$ ls']) }).render(80).length, 2);
	entries.length = 0;
	h.start('new');
	const after = h.render('call-d', { renderCall: () => new FakeComponent(['$ ls']) });
	assert.deepEqual(after.render(80), ['$ ls']);
});

test('withTimeLine 保留原型链并转发其余方法', () => {
	const inner = new FakeComponent(['body']);
	const wrapped = withTimeLine(inner, '[01:02:03]', theme);
	assert.ok(wrapped instanceof FakeComponent);
	assert.equal(typeof wrapped.invalidate, 'function');
	assert.deepEqual(wrapped.render(40), ['<dim>[01:02:03]</>', 'body']);
	assert.equal(withTimeLine(undefined, '[01:02:03]', theme), undefined);
});

test('同一组件重复包时间行只留一行', () => {
	const inner = new FakeComponent(['body']);
	const first = withTimeLine(inner, '[01:02:03]', theme);
	const second = withTimeLine(inner, '[01:02:03]', theme);
	assert.equal(second, inner, '已包过的组件原样返回');
	assert.deepEqual(first.render(40), ['<dim>[01:02:03]</>', 'body']);
});

test('重复解析已包装的 definition 不会叠出多行时间', () => {
	const h = harness([
		{ type: 'message', timestamp: iso(AT_MS), message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-a' }] } },
	]);
	h.start('resume');
	const resolver = h.resolver();
	const once = resolver('bash', () => ({ renderCall: () => new FakeComponent(['$ ls']) }));
	const twice = resolver('bash', () => once);
	assert.equal(twice, once, '第二次解析直接沿用已包装的 definition');
	const component = twice.renderCall({ command: 'ls' }, theme, { toolCallId: 'call-a' });
	assert.deepEqual(component.render(80), ['<dim>[16:03:41]</>', '$ ls']);
});
