// iFlow CLI adapter
// 数据源: ~/.iflow/projects/<路径编码>/session-<uuid>.jsonl
//   Claude Code 同款 jsonl：{uuid, parentUuid, sessionId, timestamp, type:"user"|"assistant",
//   message:{role, content: string | [{type:"text",text}]}}
//   路径编码规则：盘符与分隔符编码为 '-'（-D-HomeProject-xxx → D:\HomeProject\xxx，
//   原名中的连字符无法区分，仅作 workspace 兜底显示）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';
function projectsDir() {
  return path.join(os.homedir(), '.iflow', 'projects');
}

/** -D-HomeProject-abc-def → D:\HomeProject\abc-def（首段为盘符；后续无法还原连字符，取首段拼 \\） */
function decodeWorkspace(dirname) {
  const m = dirname.match(/^[-.]([A-Za-z])-(.+)$/);
  if (!m) return null;
  // 只还原到第二段（如 D:\HomeProject），避免把带连字符的项目名拆错
  const rest = m[2].split('-');
  if (rest.length < 2) return `${m[1]}:\\${rest[0]}`;
  return `${m[1]}:\\${rest[0]}\\${rest.slice(1).join('-')}`;
}

/** content（字符串或数组）→ 文本 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (typeof c === 'string') return c;
    if (c?.type === 'text' && c.text) return c.text;
    return '';
  }).filter(Boolean).join('\n');
}

export const iflowAdapter = {
  id: 'iflow',

  watchRoots() {
    return [projectsDir()];
  },

  discover() {
    return projectsDir() && fs.existsSync(projectsDir())
      ? listFiles(projectsDir(), '.jsonl').filter((f) => path.basename(f.path).startsWith('session-'))
      : [];
  },

  fingerprint,

  async parseFile(filePath) {
    const sessionId = path.basename(filePath, '.jsonl').replace(/^session-/, '');
    const rows = [];
    await readJsonl(filePath, (obj) => { rows.push(obj); return true; });
    const messages = [];
    for (const r of rows) {
      if (r.type !== 'user' && r.type !== 'assistant') continue;
      const text = contentText(r.message?.content);
      if (!text || !text.trim()) continue;
      if (r.type === 'user' && /^<(system|local-command|command-name)/.test(text.trim())) continue;
      if (r.type === 'user' && text.includes('<system-reminder>')) continue;
      // Claude 同款格式：助手消息的 message.model 带模型名（如 KIMI-K2）；
      // 'slash-command' 是斜杠命令的合成标记，不是模型
      const model = r.type === 'assistant' && r.message?.model
        && r.message.model !== '<synthetic>' && r.message.model !== 'slash-command'
        ? r.message.model : null;
      messages.push({ role: r.type, createdAt: r.timestamp || null, text, raw: null, model });
    }
    if (!messages.length) return null;
    const firstUser = messages.find((m) => m.role === 'user');
    const times = messages.map((m) => m.createdAt).filter(Boolean).sort();
    return {
      agentSessionId: sessionId,
      workspacePath: normalizeWorkspacePath(decodeWorkspace(path.basename(path.dirname(filePath)))) || null,
      title: (firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
      createdAt: times[0] || null,
      updatedAt: times.at(-1) || null,
      messages,
    };
  },
};
