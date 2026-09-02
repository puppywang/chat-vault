// Windsurf adapter
// Windsurf 与 Antigravity 同属 Codeium（Exafunction）系，但 summaries pb 结构略有差异：
//   Antigravity: F1 → {F1 uuid, F2 → Wrapper{F1: base64(Payload)}}
//   Windsurf:    F1 → {F1 uuid, F2: Payload 内联}
// Payload 字段：F1 标题 / F3·F7 时间戳 / F9 工作区 URI / F13 最近步骤文本 / F26 模型名。
// 数据源: %APPDATA%\Windsurf\User\globalStorage\state.vscdb ItemTable `codeium.windsurf` 键
//   —— 3.5MB JSON，含每个 workspace 的 windsurf.state.cachedTrajectorySummaries:<wsId>（base64 pb）。
//   ~/.codeium/windsurf/cascade/ 在本机为空（老版完整历史已不在本地，仅存摘要）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from '../util.js';
import { normalizeWorkspacePath } from '../workspace.js';
import { pruneAgentSessions } from '../db.js';
import { parsePb, f1, iso } from './antigravity-pb.js';

function globalDb() {
  const appData = process.env.APPDATA;
  return appData ? path.join(appData, 'Windsurf', 'User', 'globalStorage', 'state.vscdb') : null;
}

/** 模型枚举美化：MODEL_GPT_5_1_CODEX_LOW → {model: "GPT 5.1 Codex", effort: "low"} */
function prettyModel(raw) {
  if (!raw) return null;
  const m = String(raw).match(/^MODEL_(.+?)_(LOW|MEDIUM|HIGH|XHIGH|THINKING)?$/);
  if (!m) return { model: String(raw).replace(/^MODEL_/, '').replace(/_/g, ' ').toLowerCase(), effort: null };
  const ACRONYMS = new Set(['gpt']);
  const name = m[1].replace(/_/g, ' ').toLowerCase()
    .replace(/\b(\d) (\d)\b/g, '$1.$2') // 5 1 → 5.1
    .split(' ')
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return { model: name, effort: m[2] ? m[2].toLowerCase() : null };
}

const isoSec = (sec) => (typeof sec === 'number' && sec > 1e8 ? new Date(sec * 1000).toISOString() : null);
const clip = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `…（截断，共 ${s.length} 字符）` : s || '');

/** 块 F5 元数据 → {ts, toolName, toolArgs} */
function blockMeta(fields) {
  const meta = f1(fields, 5);
  if (!meta?.buf) return {};
  const inner = parsePb(meta.buf);
  const tsRaw = f1(inner, 1)?.buf;
  const ts = tsRaw ? isoSec(parsePb(tsRaw).find((x) => x.field === 1)?.v) : null;
  // F4: "…chatcmpl-tool-<id>·<工具名>·<参数JSON>"
  const toolB = f1(inner, 4)?.buf;
  let toolName = null, toolArgs = null;
  if (toolB) {
    const parts = toolB.toString('utf8').split('\x00').filter(Boolean);
    const namePart = parts.find((p, i) => i > 0 && /^(edit|grep_search|run_command|read_file|todo_list|view_file|list_dir|find_file|write_file|semantic_search|code_search|terminal|browser|web_search)$/.test(p));
    if (namePart) {
      toolName = namePart;
      const after = toolB.toString('utf8').split(namePart).pop();
      const jm = after.match(/\{[\s\S]*\}/);
      if (jm) { try { toolArgs = JSON.stringify(JSON.parse(jm[0]), null, 2); } catch { toolArgs = jm[0]; } }
    }
  }
  return { ts, toolName, toolArgs };
}

/** cachedActiveTrajectory 的明文 protobuf → 消息数组（老版 Windsurf schema：
 *  块 type 14=用户/memo、15=助手回复、5/7/8/21/73=工具执行；内容字段号 = type+5） */
function trajectoryMessages(pbBuf) {
  const root = parsePb(pbBuf);
  const body = f1(root, 2)?.buf;
  if (!body) return null;
  const blocks = parsePb(body).filter((x) => x.field === 2 && x.buf);
  const messages = [];
  for (const b of blocks) {
    const fields = parsePb(b.buf);
    const type = f1(fields, 1)?.v;
    const { ts, toolName, toolArgs } = blockMeta(fields);
    const content = fields.find((x) => x.field === type + 5)?.buf;
    if (type === 14) {
      // 用户输入（F19 内层 F2）；'Continue' 是会话恢复占位，跳过
      const userText = content ? f1(parsePb(content), 2)?.buf?.toString() : null;
      if (userText && userText.trim() && !/^Continue[\s"]*$/.test(userText.trim())) {
        messages.push({ role: 'user', createdAt: ts, text: userText, raw: null });
      }
    } else if (type === 15) {
      const inner = content ? parsePb(content) : [];
      // 正文位置随版本在 F1/F3/F8 间漂移，取最长的可读文本
      let text = null;
      for (const n of [1, 3, 8]) {
        const t = f1(inner, n)?.buf?.toString();
        if (t && t.trim().length > 1 && (!text || t.length > text.length)) text = t;
      }
      if (text?.trim()) messages.push({ role: 'assistant', createdAt: ts, text, raw: null });
      const toolB = f1(inner, 7)?.buf;
      if (toolB) {
        const s = toolB.toString('utf8');
        const nm = s.match(/(edit|grep_search|run_command|read_file|todo_list|view_file|find_file|write_file|semantic_search|code_search)/);
        const jm = s.match(/\{[\s\S]*\}/);
        messages.push({ role: 'tool', createdAt: ts, text: `🔧 ${nm ? nm[1] : 'tool'}\n${clip(jm ? jm[0] : s, 3000)}`, raw: null });
      }
    } else if (content || toolName) {
      // 工具执行块：F5 元数据的工具名+参数 为主，内容结果截断摘要
      const resText = content ? clip(content.toString('utf8').replace(/[\x00-\x08\x0b-\x1f]/g, ' ').trim(), 1500) : '';
      const head = `🔧 ${toolName || `step(type ${type})`}${toolArgs ? '\n' + clip(toolArgs, 2000) : ''}`;
      messages.push({ role: 'tool', createdAt: ts, text: resText ? head + '\n' + resText : head, raw: null });
    }
  }
  return messages;
}

/** windsurf summaries pb → 会话数组 */
export function parseWindsurfSummaries(b64Value) {
  const sessions = [];
  let root;
  try { root = parsePb(Buffer.from(b64Value, 'base64')); } catch { return sessions; }
  for (const s of root.filter((f) => f.field === 1 && f.buf)) {
    try {
      const fields = parsePb(s.buf);
      const uuid = f1(fields, 1)?.buf?.toString();
      const payloadB = f1(fields, 2)?.buf;
      if (!uuid || !payloadB) continue;
      const payload = parsePb(payloadB);
      const title = f1(payload, 1)?.buf?.toString() || '(无标题会话)';
      const ts = (n) => f1(parsePb(f1(payload, n)?.buf || Buffer.alloc(0)), 1)?.v;
      const created = ts(3);
      const updated = ts(7) ?? ts(10) ?? created;
      // F9: 重复的工作区 URI 列表（嵌套），从原始字节提取首个 file:// URI
      const wsB = f1(payload, 9)?.buf;
      const wsUri = wsB ? (wsB.toString('latin1').match(/file:[^\x00-\x1f"]{5,200}/) || [])[0] : null;
      // F13: 最近步骤文本
      const stepB = f1(payload, 13)?.buf;
      const texts = stepB
        ? [...stepB.toString('utf8').replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, '\n').split(/\n+/)].map((t) => t.trim()).filter((t) => t.length > 15).slice(0, 5)
        : [];
      const pm = prettyModel(f1(payload, 26)?.buf?.toString());
      const messages = texts.map((text) => ({
        role: 'assistant', createdAt: iso(updated ?? created), text, model: pm?.model || null, effort: pm?.effort || null, raw: null,
      }));
      sessions.push({
        agentSessionId: uuid,
        workspacePath: normalizeWorkspacePath(wsUri),
        title: title.slice(0, 120),
        createdAt: iso(created),
        updatedAt: iso(updated ?? created),
        messages: messages.length ? messages : [{ role: 'assistant', createdAt: iso(created), text: title, model: pm?.model || null, effort: pm?.effort || null, raw: null }],
      });
    } catch { /* 单条异常跳过 */ }
  }
  return sessions;
}

export const windsurfAdapter = {
  id: 'windsurf',

  watchRoots() {
    const g = globalDb();
    return g && fs.existsSync(path.dirname(g)) ? [path.dirname(g)] : [];
  },

  discover() {
    const g = globalDb();
    if (!g || !fs.existsSync(g)) return [];
    const st = fs.statSync(g);
    return [{ path: g, size: st.size, mtimeMs: Math.round(st.mtimeMs) }];
  },

  fingerprint,

  async parseFile(filePath) {
    const tmp = path.join(os.tmpdir(), `ae-windsurf-${Date.now()}.vscdb`);
    fs.copyFileSync(filePath, tmp);
    try {
      const db = new DatabaseSync(tmp, { readOnly: true });
      const row = db.prepare("SELECT value FROM ItemTable WHERE key='codeium.windsurf'").get();
      db.close();
      if (!row) return [];
      const value = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
      const state = JSON.parse(value);
      // 1) 每个 workspace 的摘要索引 → 会话骨架。同一份摘要列表会按 workspace 存储 ID
      //    各存一份（同项目多次打开/升级产生不同 wsId），同一 composer UUID 即同一对话：
      //    按 UUID 去重，保留消息最多的一份，其余拷贝只补充缺失的 workspace/最早时间
      const byUuid = new Map(); // composer uuid → session
      for (const [k, v] of Object.entries(state)) {
        if (!k.startsWith('windsurf.state.cachedTrajectorySummaries:') || typeof v !== 'string') continue;
        for (const s of parseWindsurfSummaries(v)) {
          const cur = byUuid.get(s.agentSessionId);
          if (!cur) { byUuid.set(s.agentSessionId, s); continue; }
          if (!cur.workspacePath && s.workspacePath) cur.workspacePath = s.workspacePath;
          if (s.createdAt && (!cur.createdAt || s.createdAt < cur.createdAt)) cur.createdAt = s.createdAt;
          if (s.messages.length > cur.messages.length) byUuid.set(s.agentSessionId, s);
        }
      }
      // 2) cachedActiveTrajectory（明文 pb 完整对话流）→ 覆盖对应 uuid 的骨架（消息更完整）
      for (const [k, v] of Object.entries(state)) {
        if (!k.startsWith('windsurf.state.cachedActiveTrajectory:') || typeof v !== 'string') continue;
        let pb;
        try { pb = Buffer.from(v, 'base64'); } catch { continue; }
        const messages = trajectoryMessages(pb);
        if (!messages?.length) continue;
        const cascadeId = f1(parsePb(pb), 1)?.buf?.toString();
        const times = messages.map((m) => m.createdAt).filter(Boolean).sort();
        const firstUser = messages.find((m) => m.role === 'user');
        const existing = byUuid.get(cascadeId);
        byUuid.set(cascadeId, {
          agentSessionId: cascadeId,
          workspacePath: existing?.workspacePath || null,
          title: existing?.title || String(firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
          createdAt: existing?.createdAt || times[0] || null,
          updatedAt: times.at(-1) || existing?.updatedAt || null,
          messages,
        });
      }
      return [...byUuid.values()];
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
    }
  },

  /** 源文件成功解析后：清掉库里已不被产出的旧会话（如老版 `wsId:uuid` 前缀格式的重复行） */
  afterFile(db, keptIds) {
    return pruneAgentSessions(db, this.id, keptIds);
  },
};
