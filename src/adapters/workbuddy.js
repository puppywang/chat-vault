// WorkBuddy adapter
// 数据源: ~/.workbuddy/projects/**/*.jsonl
// 每个 JSONL 是一个会话。消息以 type=message 存正文；reasoning、function_call
// 及 function_call_result 是独立事件。图片正文只保存 blob 引用，按需复制到
// ChatVault 自己的图片目录，绝不修改 WorkBuddy 源目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl, slimJson } from '../util.js';
import { saveImages } from '../imagestore.js';

const TOOL_ARGS_LIMIT = 4000;
const TOOL_RESULT_LIMIT = 2000;
const IMAGE_EXTS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

function projectsRoot() {
  return path.join(os.homedir(), '.workbuddy', 'projects');
}

function blobRoot() {
  return path.join(os.homedir(), '.workbuddy', 'blobs');
}

function iso(timestamp) {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  if (typeof timestamp === 'string' && timestamp) {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : timestamp;
  }
  return null;
}

function clip(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…(截断，共 ${text.length} 字符)` : text;
}

/** WorkBuddy 为每条真实用户输入前置运行环境、身份和项目文件。 */
function cleanUserText(text) {
  let out = String(text ?? '').trim();
  if (out.startsWith('<system-reminder')) {
    // 提示本身含有示例/嵌套的 </system-reminder>，须取最后一个闭合标签。
    const end = out.lastIndexOf('</system-reminder>');
    if (end !== -1) out = out.slice(end + '</system-reminder>'.length).trim();
  }
  // 常规输入被 <user_query> 包裹，标签不应污染全文检索和会话标题。
  const query = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i.exec(out);
  return query ? query[1].trim() : out;
}

function messageText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'input_text' || item?.type === 'output_text')
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** 将 WorkBuddy blob 的图片复制到 ChatVault 管理的图片目录。 */
function copyBlobImages(sessionId, keyPrefix, content) {
  if (!Array.isArray(content)) return [];
  const items = [];
  for (const item of content) {
    if (item?.type !== 'image_blob_ref') continue;
    const blobId = String(item.blob_id ?? '');
    if (!/^[a-f0-9]{64}$/i.test(blobId)) continue;
    const mime = String(item.mime ?? '').toLowerCase();
    const ext = IMAGE_EXTS[mime];
    if (!ext) continue;
    // 从受控的 blob 根目录和哈希推导路径，而不是信任 JSONL 中的 blob_path。
    const source = path.join(blobRoot(), blobId.slice(0, 2), `${blobId}.${ext}`);
    try {
      items.push({ data: fs.readFileSync(source).toString('base64'), mime });
    } catch {
      // blob 可能已被 WorkBuddy 清理；保留文本消息即可。
    }
  }
  return items.length ? saveImages(workbuddyAdapter.id, sessionId, keyPrefix, items) : [];
}

function titleFromText(text) {
  // 团队子代理的首条输入是 XML 任务分派，summary 才是可读的标题。
  const summary = /<teammate-message\b[^>]*\bsummary="([^"]+)"/i.exec(text);
  if (summary?.[1]) return summary[1].trim().slice(0, 80);
  const line = text.split('\n').map((x) => x.trim()).find((x) => x && !x.startsWith('<'));
  return line?.slice(0, 80) || null;
}

export const workbuddyAdapter = {
  id: 'workbuddy',

  watchRoots() {
    return [projectsRoot()];
  },

  discover() {
    return listFiles(projectsRoot(), '.jsonl');
  },

  // 带解析器版本：改动清洗/映射规则时可升级版本，强制重新建档。
  fingerprint: (file) => `v1|${fingerprint(file)}`,

  async parseFile(filePath) {
    const fileSessionId = path.basename(filePath).replace(/\.jsonl$/i, '');
    let sessionId = fileSessionId;
    let cwd = null;
    let title = null;
    let createdAt = null;
    let updatedAt = null;
    const messages = [];

    await readJsonl(filePath, (event) => {
      const at = iso(event.timestamp);
      if (at && !createdAt) createdAt = at;
      if (at) updatedAt = at;
      if (!cwd && typeof event.cwd === 'string' && event.cwd) cwd = event.cwd;
      // filename 是唯一且为 agent 子会话兜底；主会话可用 JSONL 自带 id。
      if (typeof event.sessionId === 'string' && event.sessionId) sessionId = event.sessionId;

      if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.trim()) {
        title = event.aiTitle.trim().slice(0, 200);
        return;
      }

      if (event.type === 'message' && (event.role === 'user' || event.role === 'assistant')) {
        const rawText = messageText(event.content);
        const text = event.role === 'user' ? cleanUserText(rawText) : rawText;
        const images = copyBlobImages(sessionId, `m${messages.length}`, event.content);
        if (!text && !images.length) return;
        messages.push({
          role: event.role,
          createdAt: at,
          text: text || '(图片消息)',
          raw: { type: event.type, id: event.id, content: slimJson(event.content, 160) },
          model: event.role === 'assistant'
            ? (event.providerData?.requestModelId || event.providerData?.model || null)
            : null,
          images,
        });
        return;
      }

      if (event.type === 'reasoning') {
        const text = Array.isArray(event.rawContent)
          ? event.rawContent.filter((item) => item?.type === 'reasoning_text' && item.text)
            .map((item) => item.text).join('\n').trim()
          : '';
        if (!text) return;
        messages.push({
          role: 'thinking',
          createdAt: at,
          text,
          raw: { type: event.type, id: event.id },
          model: event.providerData?.requestModelId || event.providerData?.model || null,
        });
        return;
      }

      if (event.type === 'function_call') {
        const name = String(event.name || 'tool');
        messages.push({
          role: 'tool',
          createdAt: at,
          text: `[tool:${name}] ${clip(event.arguments, TOOL_ARGS_LIMIT)}`,
          raw: { type: event.type, id: event.id, callId: event.callId, name },
        });
        return;
      }

      if (event.type === 'function_call_result') {
        const name = String(event.name || 'tool');
        messages.push({
          role: 'tool',
          createdAt: at,
          text: `[tool_result:${name}${event.status === 'completed' ? '' : ` ${event.status || 'unknown'}`}] ${clip(event.output, TOOL_RESULT_LIMIT)}`,
          raw: { type: event.type, id: event.id, callId: event.callId, name, status: event.status },
        });
      }
    });

    if (!messages.length) return null;
    if (!title) {
      const firstUser = messages.find((message) => message.role === 'user' && message.text !== '(图片消息)');
      title = firstUser ? titleFromText(firstUser.text) : null;
    }
    return {
      agentSessionId: sessionId || fileSessionId,
      workspacePath: cwd,
      title: title || '(无标题会话)',
      createdAt,
      updatedAt,
      messages,
    };
  },
};
