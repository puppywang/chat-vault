// DeepSeek Harness (dsh) adapter — 桌面版（dsh-desktop）+ CLI
// 数据源: <dsh-home>/sessions/<cwd 编码目录>/<session-uuid>/session.jsonl.zstd（或未压缩 .jsonl）
//   dsh-home 解析（官方 home-paths 规则）: $DSH_HOME > ~/.dsh；桌面版固定在
//   %APPDATA%\@deepseek-ai\dsh-desktop\dsh-home（Electron userData 内嵌 CLI home）
// 格式（官方 deepseek-harness 仓库 .agents/notes：session-persistence / zstandard-jsonl-session-logs）:
//   逻辑层 = 首行 SessionHeader(type:"session", {version,id,createdAt,cwd,origin,parentSession})
//            + SessionEvent{type,seq,time,data} 逐条追加（append-only，崩溃尾帧由写入方自愈）
//   物理层 = 多帧 zstd 拼接：header 一帧 + 每个落盘批次一帧（ZSTD_c_checksumFlag 开启）。
//            ⚠️ node:zlib 的一次性解压只读第一帧 —— 必须按 RFC 8878 帧边界逐帧解压（scanFrames）。
// 事件映射: user/message→user；assistant/message（text→assistant，reasoning→thinking，
//           tool-call 块跳过——独立 tool/call 事件更全）；tool/call+tool/result 按 callId 配对→tool；
//           session/title→标题；todo/write→[tool:TodoWrite] JSON（供跨会话任务清单检索）；
//           request/header.config→当前 model/effort；流式 *-chunks 全部跳过（最终态已在 message 里）；
//           origin=subagent 的会话不入库（子代理工作已在父会话的 tool 流里可见）。
// 需要 Node ≥ 22.19（node:zlib 实验性 zstd API，dsh 官方 floor 相同）；无该 API 时本 agent 自动禁用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { fingerprint } from '../util.js';
import { log } from '../log.js';

const CLIP_ARGS = 4000;  // 工具入参保留上限
const CLIP_OUT = 2000;   // 工具输出保留上限

// dsh 注入到 user/message 的系统块（实测 412 条用户消息中的前缀分布）：
// 工作区/skill 指令、审批策略变更、goal 轮次、preset 引导语等，均非用户真实输入
const INJECTED_PREFIXES = [
  '<system-reminder>', 'This is an automatically generated',
  'The approval policy changed from "', 'Current runtime context.',
  '<goal_round>', 'inspect the workspace',
];
const isInjected = (t) => INJECTED_PREFIXES.some((p) => t.startsWith(p));

// zstd 单帧 magic（RFC 8878 Zstandard Frame Magic Number，LE）
const ZSTD_MAGIC = 0xfd2fb528;
// node:zlib 的 zstd API 从 22.19 起提供；缺失则本 agent 无法解码
const HAS_ZSTD = typeof zstdDecompressSync === 'function';

/** 帧边界扫描：读 magic + 变长帧头 + 块头链 + 可选校验尾，不解释压缩块。
 *  返回 [start0,end0, start1,end1, ...]（仅完整帧；EOF 撕裂尾丢弃——与官方修复策略一致）。 */
function scanFrames(buf) {
  const bounds = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) { off++; continue; }
    const start = off;
    let p = off + 4;
    const fhd = buf[p]; p += 1;
    const fcsFlag = (fhd >> 6) & 3;        // Frame_Content_Size 编码宽度
    const single = (fhd >> 5) & 1;         // Single_Segment_flag（无 Window_Descriptor）
    const checksum = (fhd >> 2) & 1;       // Content_Checksum_flag（dsh 固定开启）
    const dictIdFlag = fhd & 3;
    if (!single) p += 1;                   // Window_Descriptor
    if (fcsFlag) p += [0, 2, 4, 8][fcsFlag];
    if (dictIdFlag) p += [0, 1, 2, 4][dictIdFlag];
    let last = 0;
    do {
      if (p + 3 > buf.length) return bounds;
      const bh = buf.readUIntLE(p, 3); p += 3;
      last = bh & 1;                       // Last_Block
      const type = (bh >> 1) & 3;          // 0=Raw 1=RLE 2=Compressed 3=Reserved
      const size = (bh >> 3) & 0x1fffff;
      if (type === 1) p += 1;              // RLE 块：1 字节
      else if (type === 3) return bounds;  // 保留类型：视为损坏，到此为止
      else p += size;                      // Raw / Compressed_Block
    } while (!last);
    if (checksum) p += 4;
    if (p > buf.length) return bounds;     // 撕裂尾
    bounds.push(start, p);
    off = p;
  }
  return bounds;
}

/** 会话文件 → JSONL 文本（.zstd 走帧扫描逐帧解压；裸 .jsonl 原样）。 */
function decodeSessionFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (filePath.endsWith('.jsonl')) return buf.toString('utf8');
  const bounds = scanFrames(buf);
  let out = '';
  for (let i = 0; i < bounds.length; i += 2) {
    out += zstdDecompressSync(buf.subarray(bounds[i], bounds[i + 1])).toString('utf8');
  }
  return out;
}

const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n…(截断，共 ${s.length} 字符)` : s; };
const blocksText = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .map((b) => (typeof b?.text === 'string' ? b.text : '')).filter(Boolean).join('\n').trim();
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

export const deepseekAdapter = {
  id: 'deepseek',

  watchRoots() {
    if (!HAS_ZSTD) return []; // 无 zstd API 时本 agent 整体禁用（watch 不监听、discover 返回空）
    const roots = [];
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    roots.push(path.join(appData, '@deepseek-ai', 'dsh-desktop', 'dsh-home', 'sessions'));
    const cliHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    roots.push(path.join(cliHome, 'sessions'));
    return roots;
  },

  /** 递归收集 session.jsonl.zstd / session.jsonl（官方 compression:'none' 模式） */
  discover() {
    if (!HAS_ZSTD) return [];
    const out = [];
    for (const root of deepseekAdapter.watchRoots()) {
      if (!fs.existsSync(root)) continue;
      const queue = [root];
      while (queue.length) {
        const dir = queue.shift();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) queue.push(p);
          else if (e.name === 'session.jsonl.zstd' || e.name === 'session.jsonl') {
            try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs }); } catch { /* 已删除 */ }
          }
        }
      }
    }
    return out;
  },

  // 指纹带解析器版本：dsh 处于开发者预览（SESSION_FORMAT_VERSION=0 无兼容承诺），
  // 解析逻辑随其事件 schema 调整时 bump vN，强制全量重解析
  fingerprint: (f) => 'v2|' + fingerprint(f),

  async parseFile(filePath) {
    let text;
    try { text = decodeSessionFile(filePath); } catch (err) {
      log.warn('deepseek', `解压失败 ${path.basename(filePath)}: ${err.message?.slice(0, 80)}`);
      return null;
    }
    const lines = text.split('\n').filter((l) => l.trim());

    let header = null;
    let curModel = null;   // request/header.config 维护的"当前"模型与思考等级
    let curEffort = null;
    let lastTitle = null;
    let lastTime = null;
    const callNames = new Map(); // callId → tool 名（tool/result 只有 callId）
    const messages = [];

    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; } // 撕裂行跳过（官方：写入方自愈，读取容忍）
      if (Number.isFinite(o.time)) lastTime = o.time;

      if (o.type === 'session') { header = o; continue; }
      if (!header) continue;
      const d = o.data || {};
      const ts = iso(o.time);

      switch (o.type) {
        case 'request/header': {
          const cfg = d.header?.config;
          if (cfg?.model) curModel = cfg.model;
          if (cfg?.reasoningEffort) curEffort = cfg.reasoningEffort;
          break;
        }
        case 'session/title':
          if (typeof d.title === 'string' && d.title.trim()) lastTitle = d.title.trim();
          break;
        case 'user/message': {
          const t = blocksText(d.content);
          if (!t || isInjected(t)) break;
          messages.push({ role: 'user', createdAt: ts, text: t });
          break;
        }
        case 'assistant/message': {
          const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
          const reasoning = blocks.filter((b) => b.type === 'reasoning')
            .map((b) => b.text || '').join('\n').trim();
          if (reasoning) messages.push({ role: 'thinking', createdAt: ts, text: reasoning });
          const text = blocks.filter((b) => b.type === 'text')
            .map((b) => b.text || '').join('\n').trim();
          if (text) messages.push({ role: 'assistant', createdAt: ts, text, model: curModel, effort: curEffort });
          // tool-call 块不在这里展开：独立 tool/call 事件带 callId，配对更可靠
          break;
        }
        case 'tool/call': {
          if (d.callId) callNames.set(d.callId, d.name || 'tool');
          messages.push({
            role: 'tool', createdAt: ts,
            text: `[tool:${d.name || 'tool'}] ${clip(d.arguments, CLIP_ARGS)}`,
            raw: { payloadType: 'tool/call', name: d.name },
          });
          break;
        }
        case 'tool/result': {
          const block = (Array.isArray(d.message?.content) ? d.message.content : [])
            .find((b) => b.type === 'tool-result');
          if (!block) break;
          const name = block.toolCallId ? callNames.get(block.toolCallId) : null;
          const out = (Array.isArray(block.content) ? block.content : [])
            .map((c) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
          const status = block.isError ? '!error' : '';
          messages.push({
            role: 'tool', createdAt: ts,
            text: `[tool_result${name ? ':' + name : ''}${status}] ${clip(out, CLIP_OUT)}`,
            raw: { payloadType: 'tool/result' },
          });
          break;
        }
        case 'todo/write': {
          if (Array.isArray(d.todos) && d.todos.length) {
            // 文本内嵌 {"todos":...} 原始 JSON：跨会话任务清单（extractTodos）直接可解析
            messages.push({
              role: 'tool', createdAt: ts,
              text: clip(`[tool:TodoWrite] ${JSON.stringify({ todos: d.todos })}`, CLIP_ARGS),
              raw: { payloadType: 'todo/write' },
            });
          }
          break;
        }
        default:
          break; // turn/step/chunks/compaction/approval/spliced/retry/... 跳过
      }
    }

    if (!header?.id) return null;
    if (header.origin === 'subagent') return null; // 子代理会话：工作过程已在父会话 tool 流中可见
    if (!messages.length) return null;

    const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 1);
    const title = (lastTitle || (firstUser ? firstUser.text.split('\n')[0] : '') || '(无标题会话)').slice(0, 80);

    return {
      agentSessionId: header.id,
      workspacePath: header.cwd || null,
      title,
      createdAt: iso(header.createdAt) || messages[0]?.createdAt || null,
      updatedAt: iso(lastTime) || null,
      messages,
    };
  },
};
