// Codex CLI adapter
// 数据源: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl（另有 archived_sessions/）
// 旧版（~0.130）: response_item/message（对话正文）、response_item/function_call|custom_tool_call（+output）、
//         event_msg/mcp_tool_call_end、event_msg/patch_apply_end、turn_context/stream 等
// 新版（~0.151，paginated）: 大量内容迁移到 event_msg/item_completed.item.type，且携带 thread_id：
//         UserMessage / AgentMessage(Text, phase=final_answer 等) / CommandExecution / McpToolCall / FileChange / Reasoning
//         加上 session_meta.world_state.agents_md 与 compacted.replacement_history
//         reasoning 为加密内容（summary 恒空），无明文可采，跳过
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { listFiles, fingerprint, readJsonl, slimJson } from '../util.js';
import { saveImages } from '../imagestore.js';

const CLIP_ARGS = 4000;  // 工具入参保留上限（含 exec JS 源码里的 shell 命令）
const CLIP_OUT = 2000;   // 工具输出保留上限
const ATTACH_CLIP = 4000; // 粘贴附件(pasted-text.txt)正文保留上限：只取头部，避免 27KB 日志淹没用户自己的 My request 文本

function clip(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…(截断，共 ${s.length} 字符)` : s; }

/** 工具输出规范化：字符串原样；内容对象数组取 .text；其他对象 JSON 化（避免 [object Object]） */
function outputText(out) {
  if (Array.isArray(out)) return out.map((c) => (typeof c === 'string' ? c : (c?.text ?? JSON.stringify(c)))).join('\n');
  if (out && typeof out === 'object') { try { return JSON.stringify(out); } catch { return String(out); } }
  return String(out ?? '');
}

// Codex 注入的环境/权限/指令块以这些前缀开头，不属于用户真实输入
const INJECTED_PREFIXES = [
  '<permissions', '<environment_context', '<user_instructions', '<app_context',
  '<turn_context', '<user_shell_context', '<system_warning', '<AGENTS',
  '# AGENTS.md', '# Context from my IDE setup',
  // 内部流程消息（审批评估、中断标记等）：不作为正文，也不作为标题
  'The following is the Codex agent history', '<turn_aborted>',
  '<recommended_plugins>', '# Files mentioned by the user', '# Files pasted by the user',
];

function isInjected(text) {
  return INJECTED_PREFIXES.some((p) => text.startsWith(p));
}

/** VS Code 插件把真实请求包在 IDE 上下文块里（"## My request for Codex:" 之后才是正文）。
 *  整条按注入丢弃会丢掉用户输入（实测 298 个会话因此无 user 消息/无标题）——
 *  剥壳提取正文；纯上下文块（无请求）返回 null，由调用方按注入丢弃。 */
function unwrapIdeContext(text) {
  if (!text.startsWith('# Context from my IDE setup')) return text;
  const marker = '## My request for Codex:';
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  return text.slice(idx + marker.length).replace(/^[ \t]*\n/, '').trim() || null;
}

/** 标题专用：跳过注入内容和明显的系统占位消息 */
function isTitleCandidate(text) {
  return isInjected(text) ? false : text.trim().length > 1;
}

function extractSessionId(filePath) {
  const base = path.basename(filePath).replace(/\.jsonl$/i, '');
  // 兼容新旧两种 rollout 命名：
  // 旧: rollout-2026-05-15T02-49-48-019e27d2-d300-7233-af9a-379e20c49196.jsonl (019... 前缀)
  // 新: rollout-2026-08-31T15-37-41-01a056c0-a5a5-7d91-8349-0e1fe8818f63.jsonl (01a... 前缀)
  // session_meta.payload.session_id 与文件名 uuid 一致，取末段 uuid 保证与库内已有会话一致
  const m = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  return m ? m[0] : base;
}

/** 从一条消息 content 数组中提取纯文本（兼容旧 input_text / 新 Text 大小写差异） */
function collectText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    // 新版 VS Code 粘贴：type=pasted_text/content, type=paste, 以及旧 input_text
    const t = c?.text ?? c?.Text ?? c?.content ?? c?.data;
    if (typeof t === 'string' && t) parts.push(t);
    // 兜底：未知结构但有 image_url/data 的不用作正文，已在上层按 image 处理
  }
  return parts.join('\n').trim();
}

/** 工具/MCP 详情拍扁为简短可读描述 */
function flattenMcpArgs(args) {
  try { return JSON.stringify(args ?? {}); } catch { return String(args); }
}

export const codexAdapter = {
  id: 'codex',

  watchRoots() {
    const home = os.homedir();
    return [
      path.join(home, '.codex', 'sessions'),
      path.join(home, '.codex', 'archived_sessions'),
    ];
  },

  discover() {
    const root = os.homedir();
    return [
      ...listFiles(path.join(root, '.codex', 'sessions'), '.jsonl'),
      ...listFiles(path.join(root, '.codex', 'archived_sessions'), '.jsonl'),
    ];
  },

  // 指纹带解析器版本：parseFile 逻辑升级（如 IDE 上下文剥壳）时 bump vN，强制全量重解析
  fingerprint: (f) => 'v2|' + fingerprint(f),

  async parseFile(filePath) {
    let cwd = null;
    let createdAt = null;
    let updatedAt = null;
    let curModel = null;   // turn_context 维护的"当前"模型与思考等级
    let curEffort = null;
    let sessionIdFromMeta = null; // 新版优先用 session_meta 的 session_id
    let messages = [];
    let firstUserTitle = null; // 首条真实 user 的 My request 标题（轻量同步不丢失）
    // user_message 事件携带的图片（data URI），按时间戳就近挂到 user 消息
    const pendingImages = [];
    // 去重：旧新双轨可能出现同一消息的两种形态（response_item + item_completed），按 id 去重
    const seenId = new Set();
    const dedupKey = (o) => {
      const id = o?.id || o?.payload?.id || o?.payload?.item?.id;
      return id ? String(id) : null;
    };
    const dedupHit = (o) => {
      const k = dedupKey(o);
      if (!k) return false;
      if (seenId.has(k)) return true;
      seenId.add(k);
      return false;
    };

    await readJsonl(filePath, (o) => {
      const type = o.type;
      if (o.timestamp) updatedAt = o.timestamp;
      if (!createdAt && o.timestamp) createdAt = o.timestamp;

      if (type === 'session_meta') {
        if (!cwd && o.payload?.cwd) cwd = o.payload.cwd;
        if (!sessionIdFromMeta && (o.payload?.session_id || o.payload?.id)) {
          sessionIdFromMeta = o.payload.session_id || o.payload.id;
        }
      } else if (type === 'turn_context') {
        if (!cwd && o.payload?.cwd) cwd = o.payload.cwd;
        if (o.payload?.model) curModel = o.payload.model;
        if (o.payload?.effort) curEffort = o.payload.effort;
      } else if (type === 'world_state') {
        // 新版：环境快照，可能补充 cwd；world_state.payload.state.environments.filesystem.workspace_roots
        if (!cwd && o.payload?.state?.environments?.filesystem) {
          const fsBlock = o.payload.state.environments.filesystem;
          const m2 = /<root>([^<]+)<\/root>/.exec(String(fsBlock));
          if (m2) cwd = m2[1].trim();
        }
      } else if (type === 'compacted') {
        // 新版上下文压缩：replacement_history 里是被压缩前的消息（首条多为 user），保留一条作标题/正文用
        const hist = o.payload?.replacement_history;
        if (Array.isArray(hist)) {
          for (const h of hist) {
            if (dedupHit(h)) continue;
            if (h.type !== 'message') continue;
            const role = h.role;
            if (role !== 'user' && role !== 'assistant') continue;
            const text = collectText(h.content) || String(h.content || '').trim();
            if (!text) continue;
            let userText = text;
            if (role === 'user' && isInjected(text)) {
              const unwrapped = unwrapIdeContext(text);
              if (!unwrapped) continue;
              userText = unwrapped;
            }
            messages.push({
              role,
              createdAt: o.timestamp,
              text: userText,
              raw: { payloadType: 'compacted', role, content: slimJson(h.content, 150) },
              model: role === 'assistant' ? curModel : null,
              effort: role === 'assistant' ? curEffort : null,
            });
          }
        }
      } else if (type === 'event_msg' && o.payload?.type === 'user_message') {
        const imgs = Array.isArray(o.payload.images) ? o.payload.images : [];
        if (imgs.length) pendingImages.push({ ts: o.timestamp, data: imgs });
      } else if (type === 'event_msg' && o.payload?.type === 'item_completed') {
        // 新版 paginated 核心：所有对话/工具在 item_completed.item 中
        const it = o.payload.item;
        if (!it) return;
        const itemType = it.type;
        if (itemType === 'UserMessage') {
          if (dedupHit(o)) return;
          // 图片：content 中 type=image 的 image_url 为 data URI
          let text = collectText(it.content);
          const imgUrls = (it.content || []).filter((c) => c?.type === 'image' && typeof c?.image_url === 'string').map((c) => c.image_url);
          // VS Code 粘贴大段警告时，content 只有 "# Files pasted by the user: … <home>/.codex/attachments/<id>/pasted-text.txt"
          // 需把 attachments 下的 pasted-text.txt 真实正文展开，否则 chat-vault 只显示省略路径且搜不到 batch 内容
          let pastedAttachment = null;
          if (!text || /Files pasted by the user/i.test(text)) {
            const m2 = text.match(/attachments\/([0-9a-f-]+)\/pasted-text\.txt/i);
            const attId = m2 ? m2[1] : null;
            if (attId) {
              try {
                const p = path.join(os.homedir(), '.codex', 'attachments', attId, 'pasted-text.txt');
                const raw = fs.readFileSync(p, 'utf8');
                if (raw.trim()) {
                  // 附件只取前 ATTACH_CLIP 字符（含截断提示），用户自己的 My request 等文本不受影响
                  text = `${text}\n\n--- pasted attachment (${attId}) ---\n${clip(raw.trimEnd(), ATTACH_CLIP)}`;
                  pastedAttachment = attId;
                }
              } catch {}
            }
          }
          if (!text && !imgUrls.length) return;
          if (text && isInjected(text) && !pastedAttachment) {
            const unwrapped = unwrapIdeContext(text);
            if (!unwrapped) return;
            text = unwrapped; // 剥壳后的真实请求按正常 user 消息处理（下方标题逻辑天然生效）
          }
          if (!firstUserTitle) {
            const afterMyRequest = text.includes('## My request') ? text.split('## My request')[1] : text;
            const filtered = afterMyRequest.split('\n').filter((l) => {
              const t = l.trim();
              return t && t !== ':' && !t.startsWith('# Files pasted') && !t.startsWith('## "[') && !/pasted-text\.txt/i.test(t) && !t.startsWith('--- pasted attachment');
            });
            const cand = (filtered[0] || afterMyRequest.split('\n').filter((l) => l.trim() && l.trim() !== ':')[0] || '').trim().slice(0, 80);
            if (cand && !isInjected(cand)) firstUserTitle = cand;
          }
          const msg = {
            role: 'user',
            createdAt: o.timestamp || (typeof it.completed_at_ms === 'number' ? new Date(it.completed_at_ms).toISOString() : o.timestamp),
            text: text || '(图片消息)',
            raw: { payloadType: 'UserMessage', id: it.id, content: slimJson(it.content, 150), pastedAttachment },
          };
          // 图片直接挂载（用户消息带图概率最高，旧版靠时间戳匹配，新版直接就近）
          if (imgUrls.length) {
            // 延迟到最后统一落盘也行，这里先暂存 pendingImages 兼容旧路径
            pendingImages.push({ ts: msg.createdAt, data: imgUrls, seqHint: messages.length });
          }
          messages.push(msg);
        } else if (itemType === 'AgentMessage') {
          if (dedupHit(o)) return;
          const text = collectText(it.content);
          if (!text) return;
          const role = 'assistant';
          // 过滤明显注入的 developer 文本（新版 AgentMessage 也有 role=developer? 实测新版仅 assistant）
          if (it.type === 'AgentMessage' && text.startsWith('<skills_instructions')) return;
          messages.push({
            role,
            createdAt: o.timestamp || (typeof it.completed_at_ms === 'number' ? new Date(it.completed_at_ms).toISOString() : o.timestamp),
            text,
            raw: { payloadType: 'AgentMessage', id: it.id, phase: it.phase, content: slimJson(it.content, 150) },
            model: curModel,
            effort: curEffort,
          });
        } else if (itemType === 'CommandExecution') {
          // 工具调用：旧版走 custom_tool_call，这里是 CommandExecution
          const cmd = Array.isArray(it.command) ? it.command.join(' ') : String(it.parsed_cmd?.[0]?.cmd || it.command || '');
          // 截图/粘贴文本通过 CONTENT_BEGIN..CONTENT_END 回显，截断过短会丢关键日志
          const out = it.aggregated_output ?? it.stdout ?? it.stderr ?? '';
          const status = it.status === 'failed' ? 'failed' : 'completed';
          // 8000 足够保留一次带附件的完整样本分析（实测 pasted-text 27KB 在 aggregated_output 中约 6-8KB 回显）
          const CLIP_OUT_BIG = 8000;
          messages.push({
            role: 'tool',
            createdAt: o.timestamp || (typeof it.completed_at_ms === 'number' ? new Date(it.completed_at_ms).toISOString() : o.timestamp),
            text: `[tool:exec ${status}] ${clip(cmd, CLIP_ARGS)}\n${clip(out, CLIP_OUT_BIG)}${it.exit_code != null ? `\nexit:${it.exit_code}` : ''}`,
            raw: { payloadType: 'CommandExecution', id: it.id, status, command: slimJson(it.command, 200) },
          });
        } else if (itemType === 'McpToolCall') {
          const args = flattenMcpArgs(it.arguments);
          const contents = it.result?.content;
          const resultText = Array.isArray(contents)
            ? contents.map((c) => c?.text ?? JSON.stringify(c)).join('\n')
            : (typeof it.result?.Err === 'string' ? 'Err: ' + it.result.Err : JSON.stringify(it.result ?? ''));
          messages.push({
            role: 'tool',
            createdAt: o.timestamp,
            text: `[tool:mcp:${it.server}.${it.tool}] ${clip(args, CLIP_ARGS)}\n${clip(resultText, CLIP_OUT)}`,
            raw: { payloadType: 'McpToolCall', server: it.server, tool: it.tool },
          });
        } else if (itemType === 'FileChange') {
          const changes = it.changes || {};
          const keys = Object.keys(changes);
          const summary = keys.slice(0, 20).map((k) => `${changes[k].type || ''} ${k}`).join('\n');
          messages.push({
            role: 'tool',
            createdAt: o.timestamp,
            text: `[tool:file-change] ${clip(summary || JSON.stringify(changes).slice(0, 2000), CLIP_OUT)}`,
            raw: { payloadType: 'FileChange', id: it.id },
          });
        } else if (itemType === 'Reasoning' || itemType === 'ContextCompaction') {
          // 加密 reasoning / 压缩标记：无明文，跳过
          return;
        }
      } else if (type === 'event_msg' && o.payload?.type === 'mcp_tool_call_end') {
        // MCP 调用的权威记录：server/tool/参数/结果俱全（exec 内的子调用在此留痕）
        const inv = o.payload.invocation || {};
        const args = JSON.stringify(inv.arguments ?? {});
        const contents = o.payload.result?.Ok?.content;
        const resultText = Array.isArray(contents)
          ? contents.map((c) => c?.text || '').join('\n')
          : (typeof o.payload.result?.Err === 'string' ? 'Err: ' + o.payload.result.Err : '');
        messages.push({
          role: 'tool',
          createdAt: o.timestamp,
          text: `[tool:mcp:${inv.server}.${inv.tool}] ${clip(args, CLIP_ARGS)}\n${clip(resultText, CLIP_OUT)}`,
          raw: { payloadType: 'mcp_tool_call_end', server: inv.server, tool: inv.tool },
        });
      } else if (type === 'event_msg' && o.payload?.type === 'patch_apply_end') {
        // 代码补丁：stdout 含变更文件清单
        if (o.payload.success !== false) {
          messages.push({ role: 'tool', createdAt: o.timestamp, text: `[tool:patch] ${clip(o.payload.stdout, CLIP_OUT)}`, raw: { payloadType: 'patch_apply_end' } });
        }
      } else if (type === 'response_item') {
        const p = o.payload;
        if (!p) return;
        if (dedupHit(o)) return;
        // 工具调用与结果：独立成 tool 消息（[tool:名] 前缀供 UI 简要模式识别）
        if (p.type === 'function_call') {
          const args = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {});
          messages.push({ role: 'tool', createdAt: o.timestamp, text: `[tool:${p.name}] ${clip(args, CLIP_ARGS)}`, raw: { payloadType: p.type, name: p.name } });
          return;
        }
        if (p.type === 'function_call_output') {
          messages.push({ role: 'tool', createdAt: o.timestamp, text: `[tool_result] ${clip(outputText(p.output), CLIP_OUT)}`, raw: { payloadType: p.type } });
          return;
        }
        if (p.type === 'custom_tool_call') {
          // exec 自由工具：input 是 JS 源码，内嵌真实 shell 命令与 MCP 子调用
          messages.push({ role: 'tool', createdAt: o.timestamp, text: `[tool:${p.name}] ${clip(p.input, CLIP_ARGS)}`, raw: { payloadType: p.type, name: p.name } });
          return;
        }
        if (p.type === 'custom_tool_call_output') {
          messages.push({ role: 'tool', createdAt: o.timestamp, text: `[tool_result] ${clip(outputText(p.output), CLIP_OUT)}`, raw: { payloadType: p.type } });
          return;
        }
        if (p.type !== 'message') return; // reasoning（加密）等其余类型跳过
        const role = p.role;
        if (role !== 'user' && role !== 'assistant') return; // developer 等注入角色跳过

        const parts = [];
        for (const c of p.content || []) {
          const t = c?.text;
          if (typeof t === 'string' && t) parts.push(t);
        }
        let text = parts.join('\n').trim();
        if (!text) return;
        if (role === 'user' && isInjected(text)) {
          const unwrapped = unwrapIdeContext(text);
          if (!unwrapped) return;
          text = unwrapped;
        }

        messages.push({
          role,
          createdAt: o.timestamp,
          text,
          raw: { payloadType: p.type, role, content: slimJson(p.content, 150) },
          model: role === 'assistant' ? curModel : null,
          effort: role === 'assistant' ? curEffort : null,
        });
      }
    });

    // 双轨指纹去重：旧格式 response_item/message 无 id（dedupKey 取不到），
    // 与新版 item_completed UserMessage/AgentMessage 会各入一条（内容相同、时间戳毫秒级相近）。
    // 对 user/assistant 文本消息：10 秒内 role+文本完全一致视为同一消息，保留先出现的。
    {
      const seenFp = new Map(); // key: role|text前300 → createdAt
      const deduped = [];
      for (const m of messages) {
        if (m.role === 'user' || m.role === 'assistant') {
          const fp = `${m.role}|${(m.text || '').slice(0, 300)}`;
          const prev = seenFp.get(fp);
          if (prev !== undefined) {
            const t1 = Date.parse(prev), t2 = Date.parse(m.createdAt || '');
            if (Number.isFinite(t1) && Number.isFinite(t2) && Math.abs(t2 - t1) < 10000) continue; // 双轨重复
          }
          seenFp.set(fp, m.createdAt || '');
        }
        deduped.push(m);
      }
      messages = deduped;
    }

    if (!messages.length) return null;

    // 把 user_message 事件的图片挂到时间戳最接近的 user 消息（≤5s）
    const agentSessionId = sessionIdFromMeta || extractSessionId(filePath);
    for (const p of pendingImages) {
      let best = null, bestDt = Infinity;
      // 新版 UserMessage 已在创建时 seqHint 精准指向；旧版靠时间戳
      if (p.seqHint != null) {
        const m = messages[p.seqHint];
        if (m && m.role === 'user') best = m;
      }
      if (!best) {
        for (const m of messages) {
          if (m.role !== 'user' || !m.createdAt || !p.ts) continue;
          const dt = Math.abs(new Date(m.createdAt) - new Date(p.ts));
          if (dt < bestDt) { bestDt = dt; best = m; }
        }
      }
      if (best && (p.seqHint != null || bestDt <= 5000)) {
        const seqHint = typeof p.seqHint === 'number' ? p.seqHint : messages.indexOf(best);
        const saved = saveImages(codexAdapter.id, agentSessionId, `u${seqHint}`, p.data.map((d) => ({ data: d })));
        best.images = [...(best.images || []), ...saved];
      }
    }

    const firstUser = messages.find((m) => m.role === 'user' && isTitleCandidate(m.text));
    // 标题：优先镜像 session_index 的 thread_name（与 Codex 侧标题保持一致）
    // 1620 的 thread_name = 排查 TelemetryReporter 上报失败，而 My request 首行是 查下这些报错...，需优先前者
    let title = null;
    try {
      // 注意：本文件是 ESM，不能用 require()；用顶部已导入的 fs/path/os
      const idxPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
      const idxLine = fs.readFileSync(idxPath, 'utf8')
        .split('\n').filter(Boolean).reverse().find((l) => l.includes(agentSessionId));
      if (idxLine) {
        const idx = JSON.parse(idxLine);
        if (idx.thread_name && String(idx.thread_name).trim()) title = String(idx.thread_name).trim().slice(0, 80);
      }
    } catch {}
    if (!title) title = firstUserTitle;
    if (!title) {
      const userCandidates = messages.filter((m) => m.role === 'user' && isTitleCandidate(m.text));
      if (userCandidates.length) {
        const firstText = userCandidates[0].text;
        const afterMyRequest = firstText.includes('## My request') ? firstText.split('## My request')[1] : firstText;
        const filtered = afterMyRequest.split('\n').filter((l) => {
          const t = l.trim();
          return t && !t.startsWith('# Files pasted') && !t.startsWith('## "[') && !/pasted-text\.txt/i.test(t) && !t.startsWith('--- pasted attachment');
        });
        title = (filtered[0] || afterMyRequest.split('\n').filter((l) => l.trim())[0] || '').trim().slice(0, 80);
        if (title && isInjected(title)) title = null;
      }
      if (!title) {
        const fallback = messages.find((m) => m.role === 'user' && isTitleCandidate(m.text));
        if (fallback) { const t = fallback.text.split('\n').filter((l) => l.trim() && !l.startsWith('# Files pasted'))[0]?.slice(0, 80); if (t && !isInjected(t)) title = t; }
        else if (firstUser) title = firstUser.text.split('\n')[0].slice(0, 80);
      }
    }
    title = title || '(无标题会话)';
    return {
      agentSessionId,
      workspacePath: cwd,
      title,
      createdAt,
      updatedAt,
      messages,
    };
  },
};
