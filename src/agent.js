// 对话库检索 agent：LLM（OpenAI 兼容 function calling）+ 白名单查询工具循环
// runAgent(db, {question, history}) → 异步迭代器，yield 过程事件与最终回答
import { listSessions, getSessionDetail, searchMessages, stats, findTaskStates } from './query.js';
import { llmChat } from './llm.js';

const MAX_ROUNDS = 30;
const TOOL_RESULT_LIMIT = 20;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_messages',
      description: '全文检索所有 agent 的对话消息（中英文均可，支持关键词/短语）。返回命中的会话标题与消息片段。找"某话题在哪个对话讨论过"首选此工具。可多次调用换不同关键词。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（必填）' },
          agent: { type: 'string', description: '限定 agent：claude-code/codex/copilot/zcode/cursor/antigravity/windsurf/windsurf-next/kiro/iflow（可选）' },
          limit: { type: 'integer', description: '返回条数上限，默认 20' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description: '按条件列出会话（agent / 工作区路径前缀 / 时间范围过滤），按更新时间倒序。用于浏览某个项目或某段时间有过哪些对话。',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: '限定 agent id（可选）' },
          workspace_contains: { type: 'string', description: '工作区路径包含的字符串，如 "SleepStudy" 或 "D:\\HomeProject"（可选）' },
          since: { type: 'string', description: '起始时间 ISO 格式，如 2026-01-01（可选）' },
          until: { type: 'string', description: '结束时间（可选）' },
          limit: { type: 'integer', description: '默认 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session',
      description: '读取一个会话的消息正文（用于深入查看 search_messages / list_sessions 找到的会话）。每条消息带角色与时间。单次最多约 60 条；长会话可用 start 参数翻页。',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'integer', description: '会话 id（来自其他工具结果）' },
          start: { type: 'integer', description: '起始消息下标，默认 0' },
        },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'library_stats',
      description: '对话库总览：各 agent 的会话数/消息数/时间范围。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_task_states',
      description: '查找对话中 Agent 工具留下的任务清单（todo list），可按状态过滤。回答"哪些对话有未完成的任务"首选此工具。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态过滤，默认同时查 pending 和 in_progress' },
          limit: { type: 'integer', description: '返回会话数上限，默认 30' },
        },
      },
    },
  },
];

function clipText(s, n) {
  if (typeof s !== 'string') return s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n) + `…(截断，共${s.length}字符)` : s;
}

/** 工具执行器（全部参数化白名单查询） */
function runTool(db, name, args) {
  switch (name) {
    case 'search_messages': {
      const r = searchMessages(db, { q: args.query, limit: Math.min(args.limit || TOOL_RESULT_LIMIT, 30) });
      return r.map((h) => ({
        session_id: h.session.id, agent: h.session.agent, title: clipText(h.session.title, 80),
        workspace: h.session.workspace_path, updated_at: h.session.updated_at,
        total_hits: h.totalHits,
        snippets: h.hits.map((x) => `${x.role}: ${clipText(String(x.snippet || '').replace(/<[^>]+>/g, ''), 160)}`),
      }));
    }
    case 'list_sessions': {
      const all = listSessions(db, { limit: 500, agent: args.agent || null });
      let rows = all;
      if (args.workspace_contains) {
        const k = args.workspace_contains.toLowerCase();
        rows = rows.filter((s) => (s.workspace_path || '').toLowerCase().includes(k));
      }
      if (args.since) rows = rows.filter((s) => (s.updated_at || '') >= args.since);
      if (args.until) rows = rows.filter((s) => (s.updated_at || '') <= args.until + 'Z');
      return rows.slice(0, Math.min(args.limit || TOOL_RESULT_LIMIT, 40)).map((s) => ({
        session_id: s.id, agent: s.agent, title: clipText(s.title, 80),
        workspace: s.workspace_path, updated_at: s.updated_at, message_count: s.message_count,
      }));
    }
    case 'read_session': {
      const d = getSessionDetail(db, args.session_id);
      if (!d) return { error: '会话不存在' };
      const start = args.start || 0;
      const msgs = d.messages.slice(start, start + 60).map((m) => ({
        role: m.role, time: m.created_at, text: clipText(m.content_text, 1500),
      }));
      return {
        session: { id: d.session.id, agent: d.session.agent, title: d.session.title, workspace: d.session.workspace_path },
        message_count: d.messages.length, showing: `${start}..${start + msgs.length}`,
        messages: msgs,
      };
    }
    case 'library_stats': {
      const s = stats(db);
      return { totals: s.totals, byAgent: s.byAgent.map((a) => ({ agent: a.agent, sessions: a.sessions, messages: a.messages, last_at: a.last_at })) };
    }
    case 'find_task_states': {
      const status = args.status ? [args.status] : undefined;
      return findTaskStates(db, { status, limit: Math.min(args.limit || 30, 50) });
    }
    default:
      return { error: `未知工具 ${name}` };
  }
}

function buildSystemPrompt(db) {
  const s = stats(db);
  const agents = s.byAgent.map((a) => `${a.agent}(${a.sessions})`).join('、');
  return `你是本地对话库 agent-exporter 的检索助手。库里聚合了用户在多个 AI 编码工具中的历史对话：
共 ${s.totals.sessions} 个会话、${s.totals.messages} 条消息、${s.totals.workspaces} 个工作区，覆盖 agent：${agents}。

你的任务是用工具检索并回答用户关于这些对话的问题。工作方式：
1. 先用 search_messages（换不同关键词多搜几轮）或 find_task_states / list_sessions 定位相关会话；
2. 需要细节时用 read_session 读取（长会话用 start 翻页）；
3. **适时收敛**：通常 3-6 次工具调用足够；当结果已能回答问题（或连续两轮无新结果）就停止调用工具、直接给出最终回答，不再继续检索；
4. 回答用中文、简洁；引用对话时给出 session_id、agent、标题和时间，格式如 "#/session/123"（用户界面会渲染成跳转链接）；
5. 搜索没有结果时如实说明并建议换关键词，不要编造；
6. 涉及"未完成的任务/待办"，用 find_task_states 查 pending 与 in_progress，再可读会话确认上下文；
7. 用户问"哪些对话在等我处理/有被打断的任务"时：长对话常被新话题打断——上一段任务的
   最后一条助手消息往往以提问/等待确认结尾（如"需要你来定""是否继续"），之后隔较久出现
   新话题的用户消息。可用 find_task_states 定位候选会话，再 read_session 翻阅大会话尾部
   （用 start 从靠后位置读）确认这种断点，汇报"会话 X 的某任务在等待确认后被新话题打断"。`;
}

/** agent 主循环：yield {type:'tool'|'answer'|'error'|'aborted', ...}
 *  signal：AbortSignal，用户中断时 generator 尽快结束（LLM 请求层的 fetch 同样带 signal） */
export async function* runAgent(db, { question, history = [], signal = null }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt(db) },
    ...history.slice(-8),
    { role: 'user', content: String(question).slice(0, 4000) },
  ];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) { yield { type: 'aborted' }; return; }
    let msg;
    try {
      msg = await llmChat(messages, { tools: TOOLS, signal });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') { yield { type: 'aborted' }; return; }
      yield { type: 'error', message: `模型调用失败：${err.message}` };
      return;
    }
    if (!msg) { yield { type: 'error', message: '模型无响应' }; return; }
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      yield { type: 'answer', content: msg.content || '(空回答)' };
      return;
    }
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      if (signal?.aborted) { yield { type: 'aborted' }; return; }
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* 参数不完整 */ }
      yield { type: 'tool', name, args, brief: briefOf(name, args) };
      let result;
      try {
        result = runTool(db, name, args);
      } catch (err) {
        result = { error: `工具执行失败：${err.message}` };
      }
      yield { type: 'tool_result', name, count: Array.isArray(result) ? result.length : undefined };
      messages.push({ role: 'tool', tool_call_id: call.id, content: clipText(JSON.stringify(result), 24_000) });
    }
  }
  // 轮数用尽：强制无工具收尾，保证基于已有检索给出回答
  messages.push({ role: 'user', content: '请立即基于以上检索结果给出最终回答（不要再调用任何工具；若结果不足，说明已检索到什么并给出建议）。' });
  try {
    const fin = await llmChat(messages, {});
    yield { type: 'answer', content: fin?.content || '（检索轮次耗尽且无回答）' };
  } catch (err) {
    yield { type: 'error', message: `模型调用失败：${err.message}` };
  }
}

function briefOf(name, args) {
  switch (name) {
    case 'search_messages': return `检索 "${args.query}"${args.agent ? ` @${args.agent}` : ''}`;
    case 'list_sessions': return `列会话 ${args.workspace_contains ? `@${args.workspace_contains}` : ''}`.trim();
    case 'read_session': return `读会话 #${args.session_id}`;
    case 'library_stats': return '库统计';
    case 'find_task_states': return `查任务状态${args.status ? `(${args.status})` : '(未完成)'}`;
    default: return name;
  }
}
