// MCP 工具层（stdio 与 HTTP 传输共用）：工具清单 + 执行逻辑
// 传输层职责分离：本文件只做"工具是什么、怎么执行"，不关心 stdin/stdout 或 HTTP。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, getSessionDetail, searchMessages, listWorkspaces, stats, listFlagged, findTaskStates, getChain, getSessionRefTree, AGENTS } from './query.js';

export const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
export const FALLBACK_VERSION = '2024-11-05';
export const SERVER_NAME = 'chatvault';
export const SERVER_TITLE = 'ChatVault 对话归档检索';
export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version; } catch { return '0'; }
})();

const MAX_MSG_CHARS = 16000;   // 单条消息正文上限（1.9MB 思考块会撑爆 agent 上下文）
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `…(截断，共${s.length}字符)` : s; };
export const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

/** workspace 子串 -> id 列表（path 或 name 包含即命中） */
function resolveWorkspaceIds(db, sub) {
  const k = String(sub || '').trim();
  if (!k) return [];
  return db.prepare('SELECT id FROM workspaces WHERE path LIKE ? OR name LIKE ?').all(`%${k}%`, `%${k}%`).map((r) => r.id);
}

const sessionBrief = (s) => ({
  session_id: s.id,
  agent: s.agent,
  title: clip(s.title, 120),
  workspace: s.workspace_path,
  created_at: s.created_at,
  updated_at: s.updated_at,
  message_count: s.message_count,
});

export const TOOLS = [
  {
    name: 'search_conversations',
    description: '全文检索所有已归档的 AI 编程对话（Claude Code/Codex/Copilot/Cursor/Antigravity/Windsurf/Kiro/iFlow/Qoder/DeepSeek 等）。中英文子串均可；"引号短语"表示连续匹配。返回按会话聚合的命中摘要，命中消息带 seq——用 get_session 的 around_seq 读命中处的上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '搜索关键词（多词 AND；"引号"=连续短语）' },
        agent: { type: 'string', description: '限定 agent id（claude-code/codex/copilot/zcode/cursor/antigravity/windsurf/kiro/iflow/qoder/factory/copilot-chat-open/deepseek）' },
        workspace: { type: 'string', description: '工作区路径/名称子串过滤' },
        since: { type: 'string', description: '只返回该时间（ISO 8601）之后仍活跃的会话' },
        sort: { type: 'string', enum: ['hit', 'start', 'end'], description: '排序：hit=按命中时间（默认），start=按会话创建，end=按会话更新' },
        limit: { type: 'number', description: '返回会话数上限，默认 20，上限 50' },
      },
      required: ['q'],
    },
  },
  {
    name: 'list_sessions',
    description: '列出最近的对话会话（按更新时间倒序），用于浏览库内有什么内容。',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: '限定 agent id' },
        workspace_contains: { type: 'string', description: '工作区路径子串过滤' },
        since: { type: 'string', description: '只返回 updated_at >= 此时间（ISO 8601）' },
        limit: { type: 'number', description: '返回条数上限，默认 30，上限 100' },
      },
    },
  },
  {
    name: 'get_session',
    description: '读取一个会话的内容（分页）。先拿元信息和第一页；offset 翻页读全文；search 命中的消息用 around_seq 直接读命中处的上下文窗口（大会话免翻页）。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'number', description: '会话 id（search/list 返回的 session_id）' },
        offset: { type: 'number', description: '起始消息序号（0 基，默认 0）；与 around_seq 二选一' },
        limit: { type: 'number', description: '本次返回消息条数，默认 100，上限 500' },
        around_seq: { type: 'number', description: '以该 seq 为中心取上下文窗口（配合 search 返回的 seq 使用）' },
        window: { type: 'number', description: 'around_seq 模式的单侧窗口大小，默认 20，上限 250' },
        roles: { type: 'array', items: { type: 'string', enum: ['user', 'assistant', 'tool', 'thinking', 'system'] }, description: '只保留指定角色（省 token 用，如 ["user","assistant"]）' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_task_states',
    description: '读取各会话最近的任务清单快照（todo list / TodoWrite 等工具的落盘状态），跨 agent 查看哪些对话里有未完成的任务。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: '按任务状态过滤；不传 = pending + in_progress' },
        agent: { type: 'string', description: '限定 agent id' },
        limit: { type: 'number', description: '返回会话数上限，默认 30' },
      },
    },
  },
  {
    name: 'list_flagged',
    description: '读取用户手动标记的消息（🚩 todo / ⭐ 收藏）——人工挑出的重要上下文，跨 agent 交接时优先读。',
    inputSchema: {
      type: 'object',
      properties: {
        flag: { type: 'string', enum: ['todo', 'star'], description: '标记类型，默认 todo' },
        limit: { type: 'number', description: '返回条数上限，默认 100，上限 500' },
      },
    },
  },
  {
    name: 'list_workspaces',
    description: '列出所有工作区（项目目录）及各自会话数。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_session_chain',
    description: '读取一个会话所在的"继续对话链"（跨 agent 流转：A 让 B 用 chat-vault 读取 A 的上下文继续推进，或用户粘贴 chatvault URL 引用）。返回链上所有会话（含 agent/标题/时间），用于交接时定位"上一个 agent 做到哪、我该接着哪个"。支持方向：downstream（默认，我引用了谁）/ upstream（谁引用了我）/ both。',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'number', description: '会话 id（search/list 返回的 session_id）' },
        direction: { type: 'string', enum: ['downstream', 'upstream', 'both'], description: '方向：downstream=我引用了谁（默认），upstream=谁引用了我（如 1602 被 1633 引用），both=双向。' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'get_stats',
    description: '库整体统计：总会话/消息数与各 agent 分布。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** 执行一个 MCP 工具。成功返回数据（传输层包装 content），未知工具返回 undefined。 */
export function toolExec(db, name, args = {}) {
  switch (name) {
    case 'search_conversations': {
      const q = String(args.q || '').trim();
      if (!q) throw new Error('缺少 q');
      const sort = ['hit', 'start', 'end'].includes(args.sort) ? args.sort : 'hit';
      const items = searchMessages(db, {
        q,
        agent: args.agent || null,
        workspaceIds: resolveWorkspaceIds(db, args.workspace),
        since: args.since || null,
        sort,
        limit: Math.min(Number(args.limit) || 20, 50),
      });
      return items.map((r) => ({
        ...sessionBrief(r.session),
        total_hits: r.totalHits,
        first_hit_at: r.firstHitAt,
        hits: r.hits.map((h) => ({ seq: h.seq, role: h.role, snippet: clip(stripTags(h.snippet), 240) })),
      }));
    }
    case 'list_sessions': {
      // workspace/since 过滤在 SQL 层没有对应条件：先取全量再过滤、最后截断，
      // 否则先 LIMIT 再过滤会漏掉新近 30 条之外的匹配会话
      const limit = Math.min(Number(args.limit) || 30, 100);
      const filtered = args.workspace_contains || args.since;
      let rows = listSessions(db, { agent: args.agent || null, limit: filtered ? 100000 : limit });
      if (args.workspace_contains) rows = rows.filter((s) => (s.workspace_path || '').toLowerCase().includes(String(args.workspace_contains).toLowerCase()));
      if (args.since) rows = rows.filter((s) => (s.updated_at || '') >= String(args.since));
      return rows.slice(0, limit).map(sessionBrief);
    }
    case 'get_session': {
      const sid = Number(args.session_id);
      if (!Number.isInteger(sid)) throw new Error('session_id 必须是数字');
      // 两种取段模式：offset 翻页（默认）/ around_seq 上下文窗口（配合 search 命中的 seq）
      let offset, limit, mode = 'offset';
      if (args.around_seq != null) {
        mode = 'around_seq';
        const win = Math.min(Math.max(Number(args.window) || 20, 1), 250);
        const seq = Math.max(Number(args.around_seq) || 0, 0);
        offset = Math.max(seq - win, 0);
        limit = Math.min(win * 2 + 1, 500);
      } else {
        offset = Math.max(Number(args.offset) || 0, 0);
        limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500);
      }
      const roles = Array.isArray(args.roles) && args.roles.length ? new Set(args.roles) : null;
      const d = getSessionDetail(db, sid, { offset, limit });
      if (!d.session) throw new Error(`会话不存在: ${sid}`);
      let msgs = d.messages;
      const beforeRoles = msgs.length;
      if (roles) msgs = msgs.filter((m) => roles.has(m.role));
      const messages = msgs.map((m) => {
        const o = { seq: m.seq, role: m.role, created_at: m.created_at };
        if (m.model) o.model = m.model;
        o.content = clip(m.content_text, MAX_MSG_CHARS);
        return o;
      });
      const pagination = mode === 'around_seq'
        ? {
          mode, around_seq: Number(args.around_seq), seq_from: offset, seq_to: offset + beforeRoles - 1,
          returned_before_role_filter: beforeRoles, returned: messages.length,
          message_count_total: d.session.message_count,
          hint: '调大 window 或换 around_seq 读更多上下文；offset 模式翻全文',
        }
        : {
          mode, offset, requested_limit: limit,
          returned_before_role_filter: beforeRoles, returned: messages.length,
          message_count_total: d.session.message_count,
          next_offset: offset + limit < (d.session.message_count || 0) ? offset + limit : null,
          hint: '翻页传 offset=next_offset',
        };
      return {
        ...d.session,
        agent_label: AGENTS[d.session.agent]?.label || d.session.agent,
        pagination,
        messages,
      };
    }
    case 'list_task_states': {
      const st = args.status || null;
      const rows = findTaskStates(db, {
        status: st,
        agent: args.agent || null,
        limit: Math.min(Number(args.limit) || 30, 100),
      });
      return rows.map((r) => ({
        session_id: r.session_id,
        agent: r.agent,
        agent_label: AGENTS[r.agent]?.label || r.agent,
        title: clip(r.title, 120),
        workspace: r.workspace_path,
        updated_at: r.updated_at,
        tasks: r.tasks,
      }));
    }
    case 'list_flagged': {
      const flag = ['todo', 'star'].includes(args.flag) ? args.flag : 'todo';
      const rows = listFlagged(db, { flag, limit: Math.min(Number(args.limit) || 100, 500) });
      return rows.map((r) => ({
        session_id: r.session_id,
        agent: r.agent,
        title: clip(r.title, 120),
        workspace: r.workspace_path,
        seq: r.seq,
        role: r.role,
        created_at: r.created_at,
        flagged_at: r.flagged_at,
        preview: clip(stripTags(r.preview), 300),
      }));
    }
    case 'list_workspaces':
      return listWorkspaces(db).map((w) => ({ id: w.id, path: w.path, sessions: w.session_count, agents: w.agents, last_active: w.last_active }));
    case 'get_stats': {
      const st = stats(db);
      return {
        totals: st.totals,
        by_agent: st.byAgent.map((a) => ({ agent: a.agent, label: AGENTS[a.agent]?.label || a.agent, sessions: a.sessions, messages: a.messages, last_at: a.last_at })),
      };
    }
    case 'get_session_chain': {
      const sid = Number(args.session_id);
      if (!Number.isInteger(sid)) throw new Error('session_id 必须是数字');
      const direction = ['downstream', 'upstream', 'both'].includes(args.direction) ? args.direction : 'downstream';
      const buildRef = (dir) => getSessionRefTree(db, sid, { direction: dir });
      if (direction !== 'both') {
        const t = buildRef(direction);
        const flat = (n) => {
          const ids = [n.session?.id].filter(Boolean);
          for (const c of n.children || []) ids.push(...flat(c.node));
          return ids;
        };
        const allIds = new Set(flat(t));
        const members = [...allIds].map((id) => t.session?.id === id ? t.session : t.children.find((c) => c.node.session?.id === id)?.node.session).filter(Boolean);
        // 保留 getChain 语义但扩展 upstream
        if (direction === 'upstream') {
          return { direction, root_session_id: sid, chain_size: allIds.size, tree: t };
        }
        const chain = getChain(db, sid);
        // 将 getSessionRefTree 的树与 getChain 的扁平链一并返回，兼容旧客户端
        return { direction, root_session_id: sid, chain_size: chain.members.length, tree: t, chain };
      }
      const downTree = buildRef('downstream');
      const upTree = buildRef('upstream');
      const chain = getChain(db, sid);
      return { direction: 'both', root_session_id: sid, chain, downstream: downTree, upstream: upTree };
    }
    default:
      return undefined;
  }
}
