// Claude Code adapter
// 数据源: ~/.claude/projects/<编码路径>/<sessionId>.jsonl，每行一个事件对象
// 关键行类型: user / assistant（message.content 为字符串或数组）、ai-title（AI 生成标题）
import os from 'node:os';
import path from 'node:path';
import { listFiles, fingerprint, readJsonl } from '../util.js';
import { saveImages } from '../imagestore.js';

export const claudeAdapter = {
  id: 'claude-code',

  /** 文件监听根目录（sync watcher 用） */
  watchRoots() {
    return [path.join(os.homedir(), '.claude', 'projects')];
  },

  discover() {
    return listFiles(path.join(os.homedir(), '.claude', 'projects'), '.jsonl');
  },

  fingerprint,

  async parseFile(filePath) {
    let sessionId = path.basename(filePath).replace(/\.jsonl$/i, '');
    let cwd = null;
    let title = null;
    let createdAt = null;
    let updatedAt = null;
    const messages = [];

    await readJsonl(filePath, (o) => {
      const type = o.type;
      if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
      if (!createdAt && o.timestamp) createdAt = o.timestamp;
      if (o.timestamp) updatedAt = o.timestamp;
      if (!sessionId && o.sessionId) sessionId = o.sessionId;
      if (type === 'ai-title' && o.aiTitle) title = o.aiTitle;

      if (type !== 'user' && type !== 'assistant') return;
      if (o.isSidechain === true || o.isSidechain === 'true') return; // 子代理链，降噪跳过

      // 消息序号（图片文件命名用）
      const keyPrefix = String(messages.length);

      const msg = o.message;
      if (!msg) return;
      const content = msg.content;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      // 模型与思考等级（assistant 行级信息；<synthetic> 为系统合成消息，不展示模型名）
      const model = role === 'assistant' && msg.model && msg.model !== '<synthetic>' ? msg.model : null;
      const effort = typeof o.effort === 'string' && o.effort ? o.effort : null;

      if (typeof content === 'string') {
        messages.push({
          role,
          createdAt: o.timestamp,
          text: content,
          raw: { type: o.type, content: content.slice(0, 200) },
          model, effort,
        });
        return;
      }
      if (!Array.isArray(content)) return;
      const textParts = [];
      const thinkParts = [];
      const imageItems = [];
      const resultParts = []; // tool_result：Claude Code 记在 user 消息里，实为工具输出
      for (const c of content) {
        if (c.type === 'text' && c.text) textParts.push(c.text);
        else if (c.type === 'thinking' && c.thinking) thinkParts.push(c.thinking);
        else if (c.type === 'tool_use') {
          // 4000：TodoWrite 等工具的任务清单需要完整 JSON（AI 助手按 todos 状态检索）
          textParts.push(`[tool:${c.name}] ${JSON.stringify(c.input ?? {}).slice(0, 4000)}`);
        }
        else if (c.type === 'tool_result') {
          const t = typeof c.content === 'string' ? c.content
            : Array.isArray(c.content) ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join(' ')
            : '';
          resultParts.push(`[tool_result] ${String(t).slice(0, 2000)}`);
        }
        else if (c.type === 'image' && c.source?.type === 'base64' && c.source.data) {
          imageItems.push({ data: c.source.data, mime: c.source.media_type });
        }
      }
      // 工具结果独立成消息（tool 角色），不再伪装成用户发言
      if (resultParts.length) {
        messages.push({
          role: 'tool',
          createdAt: o.timestamp,
          text: resultParts.join('\n'),
          raw: { type: 'tool_result' },
        });
      }
      const images = imageItems.length
        ? saveImages(claudeAdapter.id, sessionId, keyPrefix, imageItems)
        : [];
      if (role === 'assistant' && thinkParts.length) {
        messages.push({
          role: 'thinking',
          createdAt: o.timestamp,
          text: thinkParts.join('\n'),
          raw: { type: 'thinking' },
          model, effort,
        });
      }
      if (!textParts.length && !images.length) return;
      // assistant 含 tool_use 时标记为 tool 角色；纯文本保持 assistant
      const hasTool = content.some((c) => c.type === 'tool_use');
      const finalRole = role === 'user' ? 'user' : hasTool ? 'tool' : 'assistant';
      messages.push({
        role: finalRole,
        createdAt: o.timestamp,
        text: textParts.length ? textParts.join('\n') : '[图片]',
        raw: { type: o.type, uuid: o.uuid },
        model, effort,
        images,
      });
    });

// Claude Code 内部标记（斜杠命令回显、中断等），不作为标题
const TITLE_SKIP_PREFIXES = ['<local-command', '<command-name', '<turn_aborted', '[Request interrupted'];

    if (!messages.length) return null;
    if (!title) {
      const firstUser = messages.find(
        (m) => m.role === 'user' && !TITLE_SKIP_PREFIXES.some((p) => m.text.startsWith(p))
      );
      title = firstUser ? firstUser.text.split('\n')[0].slice(0, 80) : '(无标题会话)';
    }
    return { agentSessionId: sessionId, workspacePath: cwd, title, createdAt, updatedAt, messages };
  },
};
