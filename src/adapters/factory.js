// Factory (Droid CLI) adapter
// 数据源: ~/.factory/sessions/<uuid>.jsonl（一会话一文件，旁配 <uuid>.settings.json）
// 行类型: session_start{title} / message{timestamp, message:{role, content}} / todo_state / compaction_state
// 内容块与 Claude Code 同款: text / thinking / tool_use / tool_result
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';

function sessionsDir() {
  return path.join(os.homedir(), '.factory', 'sessions');
}

export const factoryAdapter = {
  id: 'factory',

  watchRoots() {
    return [sessionsDir()];
  },

  discover() {
    return listFiles(sessionsDir(), '.jsonl');
  },

  fingerprint,

  async parseFile(filePath) {
    const sessionId = path.basename(filePath, '.jsonl');
    let title = null;
    let cwd = null;
    const messages = [];

    await readJsonl(filePath, (o) => {
      if (o.type === 'session_start') {
        if (o.title) title = o.title;
        return;
      }
      if (o.type !== 'message' || !o.message) return;
      const role = o.message.role === 'assistant' ? 'assistant' : 'user';
      const blocks = typeof o.message.content === 'string'
        ? [{ type: 'text', text: o.message.content }]
        : Array.isArray(o.message.content) ? o.message.content : [];

      const textParts = [];
      const thinkParts = [];
      const resultParts = [];
      for (const c of blocks) {
        if (c.type === 'text' && c.text) textParts.push(c.text);
        else if (c.type === 'thinking' && c.thinking) thinkParts.push(c.thinking);
        // 4000：todo 类工具的任务清单需要完整 JSON（AI 助手按 todos 状态检索）
        else if (c.type === 'tool_use') textParts.push(`[tool:${c.name}] ${JSON.stringify(c.input ?? {}).slice(0, 4000)}`);
        else if (c.type === 'tool_result') {
          const t = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join(' ') : '';
          resultParts.push(`[tool_result] ${String(t).slice(0, 2000)}`);
        }
      }
      if (resultParts.length) {
        messages.push({ role: 'tool', createdAt: o.timestamp, text: resultParts.join('\n'), raw: null });
      }
      if (role === 'assistant' && thinkParts.length) {
        messages.push({ role: 'thinking', createdAt: o.timestamp, text: thinkParts.join('\n'), raw: null });
      }
      if (!textParts.length) return;
      const text = textParts.join('\n');
      if (role === 'user') {
        // 注入块的 "Current folder:" 是唯一的工作区线索，先提取再降噪
        if (!cwd) {
          const m = text.match(/Current folder: (.+?)[\r\n]/);
          if (m) cwd = m[1].trim();
        }
        if (/^<(system|local-command|command-name)/.test(text.trim())) return;
        if (text.includes('<system-reminder>')) return;
      }
      const hasTool = Array.isArray(o.message.content) && o.message.content.some((c) => c.type === 'tool_use');
      messages.push({
        role: role === 'user' ? 'user' : hasTool ? 'tool' : 'assistant',
        createdAt: o.timestamp,
        text,
        raw: null,
      });
    });

    if (!messages.length) return null;
    if (!title) {
      const firstUser = messages.find((m) => m.role === 'user');
      title = (firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120);
    }
    const times = messages.map((m) => m.createdAt).filter(Boolean).sort();
    return {
      agentSessionId: sessionId,
      workspacePath: normalizeWorkspacePath(cwd) || null,
      title,
      createdAt: times[0] || null,
      updatedAt: times.at(-1) || null,
      messages,
    };
  },
};
