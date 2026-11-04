// pi (@earendil-works/pi-coding-agent) adapter
// 数据源: ~/.pi/agent/sessions/<cwd 编码目录>/<ISO 时间>_<uuid>.jsonl
//
// 每行是一条 FileEntry：首行 type=session 的头（带 id/cwd），其后是带 id/parentId
// 的条目树。正文在 type=message 里，message.role 取 user / assistant / toolResult /
// bashExecution；助手消息的 content 是 text / thinking / toolCall 混排，这里拆成
// 独立消息落库。model_change 与 thinking_level_change 是会话级状态行，用于给没有
// 自带 model 的消息兜底并填 effort。
//
// 分支：pi 支持回退重来（把 leaf 指到旧条目再追加），被放弃的分支仍留在文件里。
// 归档按文件顺序全量收录（不按 leaf 路径裁剪），parentId 记进 raw，需要时可还原树。
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl, slimJson } from '../util.js';
import { saveImages } from '../imagestore.js';

const TOOL_ARGS_LIMIT = 4000;   // todo 类工具的清单 JSON 要留全，AI 助手按它检索
const TOOL_RESULT_LIMIT = 2000;
const NOTICE_LIMIT = 500;

function sessionsRoot() {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…(截断，共 ${text.length} 字符)` : text;
}

function iso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return null;
}

/** content 既可能是纯字符串，也可能是 text/image 混排数组 */
function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

function contentImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c?.type === 'image' && typeof c.data === 'string' && c.data)
    .map((c) => ({ data: c.data, mime: c.mimeType }));
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((x) => x.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

export const piAdapter = {
  id: 'pi',

  watchRoots() {
    return [sessionsRoot()];
  },

  discover() {
    return listFiles(sessionsRoot(), '.jsonl');
  },

  // 带解析器版本：改动映射规则时升级版本即可强制重建
  fingerprint: (file) => `v1|${fingerprint(file)}`,

  async parseFile(filePath) {
    // 文件名形如 2026-09-17T08-21-35-098Z_<uuid>.jsonl，头行缺失时用它兜底
    const base = path.basename(filePath).replace(/\.jsonl$/i, '');
    let sessionId = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base;
    let cwd = null;
    let title = null;
    let createdAt = null;
    let updatedAt = null;
    let curModel = null;   // 最近一次 model_change，给没带 model 的消息兜底
    let curEffort = null;  // 最近一次 thinking_level_change（off 视为未开启）
    const messages = [];

    const push = (m) => { messages.push(m); };
    const imagesOf = (content) => {
      const items = contentImages(content);
      return items.length ? saveImages(piAdapter.id, sessionId, `m${messages.length}`, items) : [];
    };

    await readJsonl(filePath, (entry) => {
      const at = iso(entry.timestamp);
      if (at && !createdAt) createdAt = at;
      if (at) updatedAt = at;

      switch (entry.type) {
        case 'session':
          if (typeof entry.id === 'string' && entry.id) sessionId = entry.id;
          if (typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
          return;

        // 用户在 TUI 里给会话起的名字，优先作标题
        case 'session_info':
          if (typeof entry.name === 'string' && entry.name.trim()) title = entry.name.trim().slice(0, 200);
          return;

        case 'model_change':
          if (typeof entry.modelId === 'string' && entry.modelId) curModel = entry.modelId;
          return;

        case 'thinking_level_change':
          curEffort = entry.thinkingLevel && entry.thinkingLevel !== 'off' ? entry.thinkingLevel : null;
          return;

        // 压缩/分支摘要是模型真实产出的正文，按系统消息留档
        case 'compaction':
        case 'branch_summary': {
          const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
          if (!summary) return;
          push({
            role: 'system',
            createdAt: at,
            text: `[${entry.type}] ${summary}`,
            raw: { type: entry.type, id: entry.id, parentId: entry.parentId, tokensBefore: entry.tokensBefore },
          });
          return;
        }

        // 扩展的状态条目（不进 LLM 上下文）：chappie 的连接/取消通知等，是读归档时
        // 判断"这一轮从哪开始、为什么断"的唯一线索，按系统消息保留。
        case 'custom': {
          const note = typeof entry.data?.message === 'string' ? entry.data.message : entry.data;
          const text = clip(note, NOTICE_LIMIT).trim();
          if (!text) return;
          push({
            role: 'system',
            createdAt: at,
            text: `[${entry.customType || 'custom'}] ${text}`,
            raw: { type: entry.type, id: entry.id, parentId: entry.parentId, customType: entry.customType },
          });
          return;
        }

        // 扩展注入的消息（在 LLM 上下文里等价于用户发言）。注意远端遥控（chappie）
        // 是以 model provider 身份接入的，ChatGPT 的指令走 assistant 消息那条路，
        // 它的 chappie.request 只是触发一轮 turn 的空信号（content 写死为空）。
        case 'custom_message': {
          const text = contentText(entry.content);
          const images = imagesOf(entry.content);
          if (!text && !images.length) return;
          push({
            role: 'system',
            createdAt: at,
            text: `[${entry.customType || 'custom_message'}] ${text || '(图片消息)'}`,
            raw: { type: entry.type, id: entry.id, parentId: entry.parentId, customType: entry.customType, display: entry.display },
            images,
          });
          return;
        }

        case 'message':
          break;

        default:
          return; // label 等书签类条目不产生消息
      }

      const msg = entry.message;
      if (!msg) return;
      const raw = { type: entry.type, id: entry.id, parentId: entry.parentId, role: msg.role };

      if (msg.role === 'user') {
        const text = contentText(msg.content);
        const images = imagesOf(msg.content);
        if (!text && !images.length) return;
        push({ role: 'user', createdAt: at, text: text || '(图片消息)', raw, images });
        return;
      }

      if (msg.role === 'assistant') {
        const model = msg.model || curModel || null;
        const effort = msg.providerThinkingLevel || curEffort || null;
        const parts = Array.isArray(msg.content) ? msg.content : [];
        const think = parts.filter((c) => c?.type === 'thinking' && c.thinking)
          .map((c) => c.thinking).join('\n').trim();
        if (think) {
          push({ role: 'thinking', createdAt: at, text: think, raw: { ...raw, part: 'thinking' }, model, effort });
        }
        const text = parts.filter((c) => c?.type === 'text' && c.text).map((c) => c.text).join('\n').trim();
        if (text) {
          push({ role: 'assistant', createdAt: at, text, raw: { ...raw, part: 'text' }, model, effort });
        }
        // 工具调用逐条成行，便于按工具名检索与还原调用/结果配对
        for (const c of parts) {
          if (c?.type !== 'toolCall') continue;
          push({
            role: 'tool',
            createdAt: at,
            text: `[tool:${c.name || 'tool'}] ${clip(c.arguments ?? {}, TOOL_ARGS_LIMIT)}`,
            raw: { ...raw, part: 'toolCall', toolCallId: c.id, name: c.name },
            model,
          });
        }
        if (typeof msg.errorMessage === 'string' && msg.errorMessage.trim()) {
          push({
            role: 'system',
            createdAt: at,
            text: `[error:${msg.stopReason || 'error'}] ${clip(msg.errorMessage, NOTICE_LIMIT)}`,
            raw: { ...raw, part: 'error' },
          });
        }
        return;
      }

      if (msg.role === 'toolResult') {
        const name = msg.toolName || 'tool';
        const text = contentText(msg.content);
        const images = imagesOf(msg.content);
        if (!text && !images.length) return;
        push({
          role: 'tool',
          createdAt: at,
          text: `[tool_result:${name}${msg.isError ? ' error' : ''}] ${clip(text || '(图片结果)', TOOL_RESULT_LIMIT)}`,
          raw: { ...raw, toolCallId: msg.toolCallId, name, isError: !!msg.isError, details: slimJson(msg.details, 120) },
          images,
        });
        return;
      }

      // TUI 里 `!` 直接执行的命令：不是模型调用，但属于会话正文
      if (msg.role === 'bashExecution') {
        const head = `[bash!${msg.exitCode != null ? ` exit=${msg.exitCode}` : ''}${msg.cancelled ? ' cancelled' : ''}] ${msg.command || ''}`;
        const out = clip(msg.output ?? '', TOOL_RESULT_LIMIT);
        push({
          role: 'tool',
          createdAt: at,
          text: out ? `${head}\n${out}` : head,
          raw: { ...raw, exitCode: msg.exitCode, cancelled: !!msg.cancelled, truncated: !!msg.truncated },
        });
      }
    });

    if (!messages.length) return null;
    if (!title) {
      // 远端遥控的会话可能整场没有用户发言，退而用助手首段正文
      const seed = messages.find((m) => m.role === 'user' && m.text !== '(图片消息)')
        || messages.find((m) => m.role === 'assistant');
      title = (seed && firstLine(seed.text)) || null;
    }
    return {
      agentSessionId: sessionId,
      workspacePath: cwd,
      title: title || '(无标题会话)',
      createdAt,
      updatedAt,
      messages,
    };
  },
};
