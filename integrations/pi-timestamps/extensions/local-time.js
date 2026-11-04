/**
 * Pi TUI 扩展：在每条消息前显示本地时间（HH:MM:SS）。
 *
 * - 工具块：用 renderContext.toolCallId 找这次调用的时间（本次执行的开始时刻优先，
 *   其次是会话记录里发起该调用的 assistant 条目 / 结果条目）。
 * - 文本消息：registerMarkdownTransformer 按消息文本前缀匹配会话条目里的时间戳，
 *   流式输出期间用 message_start / message_update 记下的时间。
 * - 重复注册不叠加：pi 会在 reload / 重新构建 runner 时重跑 factory，而
 *   registerToolRenderer 是 push 语义、渲染器又被反复套在同一个 definition 上，
 *   所以包装函数和组件都打上标记，包过就跳过（否则工具块上方会叠出多行时间）。
 *
 * 不 import 任何 pi-tui 组件：包装时用 Object.create 保留原型链（instanceof 仍成立），
 * 只覆盖 render。这样运行时没有任何依赖，pi 升级不会把它冲掉。
 */

const TEXT_KEY_CHARS = 48; // 文本匹配键长度（长消息取前 48 字）
const LIVE_KEY_CHARS = 16; // 流式输出早期用的短键
const MAX_LIVE_TOOL_TIMES = 2000;
const RESEED_INTERVAL_MS = 1000;
const TIME_LINE_RE = /^\s*\[\d{2}:\d{2}:\d{2}\]/;
const TIME_LINE_MARK = Symbol.for('chat-vault-pi-timestamps.time-line');

const pad2 = (value) => String(value).padStart(2, '0');

/** 打标记：已包过时间行的渲染函数 / 组件（冻结对象忽略） */
function markTimeLine(target) {
	try {
		Object.defineProperty(target, TIME_LINE_MARK, { value: true });
	} catch {
		// 只读或冻结对象：退化为每次重新包装，不影响渲染
	}
}

/** 本地时间 HH:MM:SS；无法解析返回 null */
export function formatClock(ms) {
	if (ms == null || ms === '' || typeof ms === 'boolean') return null;
	const date = new Date(ms);
	if (!Number.isFinite(date.getTime())) return null;
	return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 归一化文本前缀：折叠空白并截断，便于流式内容的前缀匹配 */
export function normalizeText(text, chars) {
	const head = String(text ?? '').slice(0, chars * 4);
	const flat = head.replace(/\s+/g, ' ').trim();
	return flat.slice(0, chars);
}

function toMs(value) {
	const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
	return Number.isFinite(ms) ? ms : null;
}

function contentBlocks(content) {
	return Array.isArray(content) ? content : [];
}

/** 消息里所有 text / thinking 片段（assistant 的思考块也要能显示时间） */
export function messageTexts(content) {
	if (typeof content === 'string') return content.trim() ? [content] : [];
	const texts = [];
	for (const block of contentBlocks(content)) {
		const text =
			block?.type === 'text' ? block.text : block?.type === 'thinking' ? block.thinking : null;
		if (typeof text === 'string' && text.trim()) texts.push(text);
	}
	return texts;
}

function rememberText(map, text, ms) {
	const long = normalizeText(text, TEXT_KEY_CHARS);
	if (long) map.set(long, ms);
	const short = normalizeText(text, LIVE_KEY_CHARS);
	if (short && short !== long) map.set(short, ms);
}

/** 从会话条目收集 toolCallId / 消息文本 → 时间（ms）。纯函数，方便测试。 */
export function collectTimes(entries) {
	const toolCalls = new Map();
	const toolResults = new Map();
	const texts = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		const message = entry?.message;
		const ms = toMs(entry?.timestamp);
		if (ms == null || !message) continue;
		if (message.role === 'assistant' || message.role === 'user') {
			for (const text of messageTexts(message.content)) rememberText(texts, text, ms);
		}
		if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
			toolResults.set(message.toolCallId, ms);
		}
		for (const block of contentBlocks(message.content)) {
			if (block?.type === 'toolCall' && typeof block.id === 'string') toolCalls.set(block.id, ms);
		}
	}
	return { toolCalls, toolResults, texts };
}

/** 在组件上方插一行时间；保留原型链，其余方法转发给原组件 */
export function withTimeLine(component, label, theme) {
	if (!component || typeof component.render !== 'function' || !label) return component;
	if (component[TIME_LINE_MARK]) return component;
	const line = typeof theme?.fg === 'function' ? theme.fg('dim', label) : label;
	const wrapper = Object.create(component);
	wrapper.render = (width) => [line, ...(component.render(width) ?? [])];
	wrapper.invalidate = () => component.invalidate?.();
	if (typeof component.handleInput === 'function') {
		wrapper.handleInput = (data) => component.handleInput(data);
	}
	if (typeof component.handleMouse === 'function') {
		wrapper.handleMouse = (event) => component.handleMouse(event);
	}
	markTimeLine(component);
	markTimeLine(wrapper);
	return wrapper;
}

export default function localTimeExtension(pi) {
	let context;
	let lastSeedAt = 0;
	const liveToolStart = new Map();
	const toolCallTimes = new Map();
	const toolResultTimes = new Map();
	const textTimes = new Map();

	/** 从当前会话条目刷新时间表（默认 1 秒一次，避免渲染热路径反复扫描） */
	function seed(force = false) {
		const now = Date.now();
		if (!force && now - lastSeedAt < RESEED_INTERVAL_MS) return;
		lastSeedAt = now;
		const entries = context?.sessionManager?.getEntries?.();
		if (!Array.isArray(entries) || entries.length === 0) return;
		const collected = collectTimes(entries);
		for (const [id, ms] of collected.toolCalls) {
			if (!toolCallTimes.has(id)) toolCallTimes.set(id, ms);
		}
		for (const [id, ms] of collected.toolResults) {
			if (!toolResultTimes.has(id)) toolResultTimes.set(id, ms);
		}
		for (const [key, ms] of collected.texts) textTimes.set(key, ms);
	}

	function toolTime(toolCallId) {
		if (typeof toolCallId !== 'string') return null;
		if (liveToolStart.has(toolCallId)) return liveToolStart.get(toolCallId);
		if (toolCallTimes.has(toolCallId)) return toolCallTimes.get(toolCallId);
		if (toolResultTimes.has(toolCallId)) return toolResultTimes.get(toolCallId);
		seed();
		return toolCallTimes.get(toolCallId) ?? toolResultTimes.get(toolCallId) ?? null;
	}

	function textTime(markdown) {
		const long = normalizeText(markdown, TEXT_KEY_CHARS);
		const short = normalizeText(markdown, LIVE_KEY_CHARS);
		const lookup = () => textTimes.get(long) ?? (short ? textTimes.get(short) : undefined) ?? null;
		const known = lookup();
		if (known != null) return known;
		seed();
		return lookup();
	}

	function recordMessage(message) {
		const role = message?.role;
		if (role !== 'assistant' && role !== 'user') return;
		const ms = toMs(message.timestamp) ?? Date.now();
		for (const text of messageTexts(message.content)) rememberText(textTimes, text, ms);
	}

	/** 包装首个可用的渲染器：优先 renderCall，其次 renderResult */
	function timed(renderer, themeIndex, getTime) {
		if (typeof renderer !== 'function') return null;
		if (renderer[TIME_LINE_MARK]) return null;
		const wrapped = (...args) => {
			const theme = args[themeIndex];
			const renderContext = args[args.length - 1];
			const component = renderer.apply(null, args);
			const label = formatClock(getTime(renderContext));
			return label ? withTimeLine(component, `[${label}]`, theme) : component;
		};
		markTimeLine(wrapped);
		return wrapped;
	}

	pi.on('session_start', (event, ctx) => {
		context = ctx;
		if (event?.reason !== 'reload') {
			liveToolStart.clear();
			toolCallTimes.clear();
			toolResultTimes.clear();
			textTimes.clear();
		}
		lastSeedAt = 0;
		seed(true);
	});
	pi.on('message_start', (event) => recordMessage(event?.message));
	pi.on('message_update', (event) => recordMessage(event?.message));
	pi.on('message_end', (event) => {
		recordMessage(event?.message);
		seed();
	});
	pi.on('tool_execution_start', (event) => {
		const id = event?.toolCallId;
		if (typeof id !== 'string') return;
		liveToolStart.set(id, Date.now());
		while (liveToolStart.size > MAX_LIVE_TOOL_TIMES) {
			liveToolStart.delete(liveToolStart.keys().next().value);
		}
	});

	pi.registerToolRenderer((_toolName, next) => {
		const base = next();
		if (!base) return base;
		if (base.renderCall?.[TIME_LINE_MARK]) return base;
		const byCall = timed(base.renderCall, 1, (ctx) => toolTime(ctx?.toolCallId));
		if (byCall) return { ...base, renderCall: byCall };
		const byResult = timed(base.renderResult, 2, (ctx) => toolTime(ctx?.toolCallId));
		if (byResult) return { ...base, renderResult: byResult };
		return base;
	});

	pi.registerMarkdownTransformer((markdown) => {
		if (typeof markdown !== 'string' || !markdown || TIME_LINE_RE.test(markdown)) return markdown;
		const label = formatClock(textTime(markdown));
		return label ? `[${label}]\n\n${markdown}` : markdown;
	});
}
