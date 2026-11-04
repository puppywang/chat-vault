// 对话库检索 agent：LLM（OpenAI 兼容 function calling）+ 与 MCP 同一套只读检索工具
// runAgent(db, {question, history}) → 异步迭代器，yield 过程事件与最终回答
//
// 工具层不再自己定义：MCP 的 inputSchema 与 OpenAI function calling 的 parameters
// 同为 JSON Schema，只差外层包装，因此这里只做形状转换，"工具是什么、怎么执行"
// 全部复用 mcp-tools.js。这样网页助手与其它 agent 走 MCP 看到的是同一份能力，
// 加一个 MCP 工具就等于给助手也加上了（历史上两边各自维护，工具名/参数名/
// 状态枚举都漂移过：助手侧只有 5 个弱化版工具，且缺 around_seq / roles /
// list_flagged / get_session_chain）。
import { stats } from './query.js';
import { TOOLS as MCP_TOOLS, toolExec, isMcpContentEnvelope } from './mcp-tools.js';
import { llmChat } from './llm.js';

const MAX_ROUNDS = 30;
const MAX_TOOL_JSON = 30_000;   // 单次工具结果注入模型的上限（字符）
const MAX_STRING = 1000;        // 结果里单个字符串（正文/片段）的上限

// notes 工具（写入侧，需要 thread 上下文）不给助手：助手保持纯只读检索。
const TOOLS = MCP_TOOLS.filter((t) => t.annotations?.readOnlyHint !== false).map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));
const TOOL_NAMES = new Set(TOOLS.map((t) => t.function.name));

/** 助手的上下文远小于 agent CLI：收紧分页上限，避免一次工具调用吃掉整个窗口 */
const ARG_CAPS = {
  search_conversations: { limit: 20 },
  list_sessions: { limit: 30 },
  get_session: { limit: 30, window: 12 },
  list_task_states: { limit: 30 },
  list_flagged: { limit: 40 },
};
function capArgs(name, args) {
  const caps = ARG_CAPS[name];
  if (!caps) return args;
  const out = { ...args };
  for (const [k, max] of Object.entries(caps)) {
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.min(v, max) : max;
  }
  return out;
}

/** 逐字符串裁剪（而不是截整个 JSON 串）：保证注入模型的仍是合法 JSON */
function deepClip(v, n = MAX_STRING) {
  if (typeof v === 'string') return v.length > n ? v.slice(0, n) + `…(截断，共${v.length}字符)` : v;
  if (Array.isArray(v)) return v.map((x) => deepClip(x, n));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = deepClip(x, n);
    return o;
  }
  return v;
}

/** 装进预算：超了就从数组尾部丢条目并说明丢了多少，始终交给模型合法 JSON */
function fitPayload(result) {
  const data = deepClip(result);
  const json = JSON.stringify(data) ?? 'null';
  if (json.length <= MAX_TOOL_JSON) return json;
  if (Array.isArray(data)) {
    const kept = [...data];
    while (kept.length > 1 && JSON.stringify(kept).length > MAX_TOOL_JSON) kept.pop();
    return JSON.stringify({ items: kept, note: `结果过多，只保留前 ${kept.length}/${data.length} 条` });
  }
  if (data && typeof data === 'object') {
    // 对象里最长的那个数组字段（如 get_session 的 messages）同理收缩
    const key = Object.entries(data)
      .filter(([, v]) => Array.isArray(v))
      .sort((a, b) => b[1].length - a[1].length)[0]?.[0];
    if (key) {
      const arr = [...data[key]];
      while (arr.length > 1 && JSON.stringify({ ...data, [key]: arr }).length > MAX_TOOL_JSON) arr.pop();
      return JSON.stringify({ ...data, [key]: arr, note: `${key} 过长，只保留前 ${arr.length}/${data[key].length} 条` });
    }
  }
  return json.slice(0, MAX_TOOL_JSON) + '…(截断)';
}

function buildSystemPrompt(db) {
  const s = stats(db);
  const agents = s.byAgent.map((a) => `${a.agent}(${a.sessions})`).join('、');
  return `你是本地对话库 ChatVault 的检索助手。库里聚合了用户在多个 AI 编码工具中的历史对话：
共 ${s.totals.sessions} 个会话、${s.totals.messages} 条消息、${s.totals.workspaces} 个工作区，覆盖 agent：${agents}。

你的任务是用工具检索并回答用户关于这些对话的问题。工作方式：
1. 先用 search_conversations（换不同关键词多搜几轮）或 list_task_states / list_sessions 定位相关会话；
2. 要看细节用 get_session：search 命中的消息带 seq，直接用 around_seq 读命中处的上下文窗口（大会话免翻页）；
   只关心主线时传 roles:["user","assistant"] 跳过工具调用，省 token；很长的会话用 offset 翻页；
3. 用户手动标记过的重要消息用 list_flagged（🚩 todo / ⭐ 收藏）——那是人工挑出来的交接点；
4. 问"这事在哪个 agent 手上、上一个 agent 做到哪"用 get_session_chain（direction: downstream 我引用了谁 / upstream 谁引用了我 / both）；
5. **适时收敛**：通常 3-6 次工具调用足够；当结果已能回答问题（或连续两轮无新结果）就停止调用工具、直接给出最终回答，不再继续检索；
6. 回答用中文、简洁；引用对话时给出 session_id、agent、标题和时间，格式如 "#/session/123"（用户界面会渲染成跳转链接）；
7. 搜索没有结果时如实说明并建议换关键词，不要编造；
8. 涉及"未完成的任务/待办"，用 list_task_states 查 pending 与 in_progress（完成态是 completed），再读会话确认上下文；
9. 用户问"哪些对话在等我处理/有被打断的任务"时：长对话常被新话题打断——上一段任务的
   最后一条助手消息往往以提问/等待确认结尾（如"需要你来定""是否继续"），之后隔较久出现
   新话题的用户消息。可用 list_task_states 定位候选会话，再用 get_session 读会话尾部
   （offset 取靠后位置）确认这种断点，汇报"会话 X 的某任务在等待确认后被新话题打断"。`;
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
        if (!TOOL_NAMES.has(name)) throw new Error(`助手不允许调用工具 ${name}`);
        result = await toolExec(db, name, capArgs(name, args));
        if (result === undefined) result = { error: `未知工具 ${name}` };
        // 少数工具返回 MCP content 信封（正文要直接落在 content[].text）；助手只取文本
        if (isMcpContentEnvelope(result)) {
          result = { text: result.content.map((c) => c?.text).filter(Boolean).join('\n') };
        }
      } catch (err) {
        result = { error: `工具执行失败：${err.message}` };
      }
      yield { type: 'tool_result', name, count: Array.isArray(result) ? result.length : undefined };
      messages.push({ role: 'tool', tool_call_id: call.id, content: fitPayload(result) });
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

/** 检索过程在网页上的一行摘要（工具名与 MCP 一致） */
function briefOf(name, args) {
  switch (name) {
    case 'search_conversations': return `检索 "${args.q ?? ''}"${args.agent ? ` @${args.agent}` : ''}`;
    case 'list_sessions': return `列会话 ${args.workspace_contains ? `@${args.workspace_contains}` : ''}`.trim();
    case 'get_session': return `读会话 #${args.session_id}${args.around_seq != null ? ` @${args.around_seq}` : args.offset ? ` +${args.offset}` : ''}`;
    case 'list_task_states': return `查任务状态${args.status ? `(${args.status})` : '(未完成)'}`;
    case 'list_flagged': return `读${args.flag === 'star' ? '收藏' : 'TODO'}标记`;
    case 'list_workspaces': return '列工作区';
    case 'get_session_chain': return `会话链 #${args.session_id}`;
    case 'get_stats': return '库统计';
    default: return name;
  }
}
