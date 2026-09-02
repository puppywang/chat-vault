// Qoder adapter（阿里 Qoder IDE 内置 agent）
// 数据源: ~/.qoderworkcn/projects/**（CN 版）与 ~/.qoderwork/projects/**（全球版）下的
//   <sessionId>.jsonl —— Claude Code 同款行格式：user/assistant 行 + message.content
//   内容块（text/thinking/tool_use/tool_result），cwd 行级给出工作区。
//   两版目录并列扫描（本机数据集中在 CN 版）；记忆钩子/系统提醒类注入消息过滤。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl } from '../util.js';
import { saveImages } from '../imagestore.js';

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/;

function projectRoots() {
  const home = os.homedir();
  return [path.join(home, '.qoderworkcn', 'projects'), path.join(home, '.qoderwork', 'projects')];
}

/** 注入类用户消息（记忆钩子 / 系统提醒 / 断流自动续跑），不进正文与标题 */
function isInjected(text) {
  const h = text.trim();
  return h.startsWith('<system-reminder>')
    || h.startsWith('<command-name>')
    || h.startsWith('<local-command')
    || h.startsWith('[SYSTEM NOTIFICATION')
    || h.startsWith('Target file this round:')
    || h.startsWith('Output token limit hit.');
}

export const qoderAdapter = {
  id: 'qoder',

  watchRoots() {
    return projectRoots().filter((p) => fs.existsSync(p));
  },

  discover() {
    const out = [];
    for (const root of projectRoots()) {
      for (const f of listFiles(root, '.jsonl')) {
        if (SESSION_FILE_RE.test(path.basename(f.path))) out.push(f);
      }
    }
    return out;
  },

  fingerprint,

  async parseFile(filePath) {
    const sessionId = path.basename(filePath, '.jsonl');
    let cwd = null;
    const messages = [];

    await readJsonl(filePath, (o) => {
      if (o.type !== 'user' && o.type !== 'assistant') return;
      if (o.isSidechain === true || o.isSidechain === 'true') return;
      if (o.isApiErrorMessage) return; // API 报错回显行（如 FORBIDDEN），不是对话内容
      if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;

      const msg = o.message;
      if (!msg) return;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const model = role === 'assistant' && msg.model && msg.model !== '<synthetic>' ? msg.model : null;

      if (typeof msg.content === 'string') {
        if (role === 'user' && isInjected(msg.content)) return;
        if (msg.content.trim()) {
          messages.push({ role, createdAt: o.timestamp, text: msg.content, raw: null, model });
        }
        return;
      }
      if (!Array.isArray(msg.content)) return;

      const textParts = [];
      const thinkParts = [];
      const imageItems = [];
      const resultParts = [];
      for (const c of msg.content) {
        if (c.type === 'text' && c.text) textParts.push(c.text);
        else if (c.type === 'thinking' && c.thinking) thinkParts.push(c.thinking);
        else if (c.type === 'tool_use') textParts.push(`[tool:${c.name}] ${JSON.stringify(c.input ?? {}).slice(0, 4000)}`);
        else if (c.type === 'tool_result') {
          const t = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
          resultParts.push(`[tool_result] ${String(t).slice(0, 2000)}`);
        } else if (c.type === 'image' && c.source?.type === 'base64' && c.source.data) {
          imageItems.push({ data: c.source.data, mime: c.source.media_type });
        }
      }
      if (resultParts.length) {
        messages.push({ role: 'tool', createdAt: o.timestamp, text: resultParts.join('\n'), raw: null });
      }
      if (role === 'assistant' && thinkParts.length) {
        messages.push({ role: 'thinking', createdAt: o.timestamp, text: thinkParts.join('\n'), raw: null, model });
      }
      if (!textParts.length && !imageItems.length) return;
      const text = textParts.join('\n');
      if (role === 'user' && isInjected(text)) return;
      const hasTool = msg.content.some((c) => c.type === 'tool_use');
      const images = imageItems.length ? saveImages(qoderAdapter.id, sessionId, String(messages.length), imageItems) : [];
      messages.push({
        role: role === 'user' ? 'user' : hasTool ? 'tool' : 'assistant',
        createdAt: o.timestamp,
        text: text || '[图片]',
        raw: null,
        model,
        images,
      });
    });

    if (!messages.length) return null;
    // 标题兜底链：真实用户消息 → 首条助手正文（纯记忆钩子会话没有可用的用户消息）
    const titleSrc = messages.find((m) => m.role === 'user' && !m.text.startsWith('[Image:') && !m.text.startsWith('[Request interrupted'))
      || messages.find((m) => m.role === 'assistant' && m.text.trim());
    const firstUser = titleSrc;
    const times = messages.map((m) => m.createdAt).filter(Boolean).sort();
    return {
      agentSessionId: sessionId,
      workspacePath: cwd,
      title: (firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
      createdAt: times[0] || null,
      updatedAt: times.at(-1) || null,
      messages,
    };
  },
};
