// Copilot Chat 转写兜底 adapter
// 数据源: ~/.copilot-chat-open/runtime/transcripts/<sessionId>_<HookKind>_<epochms>.json
//   VS Code 会主动清理 Copilot 的 chatSessions 文件（本机已删过半），此目录是 hook
//   事件流的捕获存档，是被删会话的唯一本地副本。每个文件是一份 JSONL 快照
//   （session.start / user.message / assistant.message 事件），同会话取最新一份。
// 去重：与 copilot 主源（chatSessions）按 sessionId 比对，已有的跳过（filterSessions）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint } from '../util.js';

function transcriptsDir() {
  return path.join(os.homedir(), '.copilot-chat-open', 'runtime', 'transcripts');
}

const FILE_RE = /^([0-9a-f]{8}-[0-9a-f-]{27})_([A-Za-z]+)_(\d+)\.json$/;

export const copilotChatOpenAdapter = {
  id: 'copilot-chat-open',

  watchRoots() {
    return [transcriptsDir()];
  },

  /** 以目录为源：目录 mtime 在新增快照文件时变化（快照文件名带时间戳，不会原地覆盖） */
  discover() {
    const dir = transcriptsDir();
    if (!fs.existsSync(dir)) return [];
    const st = fs.statSync(dir);
    return [{ path: dir, size: st.size, mtimeMs: Math.round(st.mtimeMs) }];
  },

  fingerprint,

  async parseFile(dirPath) {
    const latest = new Map(); // sessionId -> { file, ts }（每会话只取最新快照）
    for (const f of fs.readdirSync(dirPath)) {
      const m = FILE_RE.exec(f);
      if (!m) continue;
      const ts = Number(m[3]);
      const cur = latest.get(m[1]);
      if (!cur || ts > cur.ts) latest.set(m[1], { file: path.join(dirPath, f), ts });
    }

    const sessions = [];
    for (const [sessionId, { file }] of latest) {
      const messages = [];
      let startTime = null;
      let lines;
      try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
      for (const line of lines) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'session.start') {
          startTime = o.data?.startTime || o.timestamp || null;
        } else if (o.type === 'user.message') {
          const t = o.data?.content;
          if (typeof t === 'string' && t.trim()) {
            messages.push({ role: 'user', createdAt: o.timestamp || null, text: t, raw: null });
          }
        } else if (o.type === 'assistant.message') {
          const d = o.data || {};
          const t = typeof d.content === 'string' ? d.content.trim() : '';
          if (t) messages.push({ role: 'assistant', createdAt: o.timestamp || null, text: t, raw: null });
          for (const tr of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
            if (tr?.name) {
              messages.push({
                role: 'tool',
                createdAt: o.timestamp || null,
                text: `[tool:${tr.name}] ${String(tr.arguments ?? '').slice(0, 4000)}`,
                raw: null,
              });
            }
          }
        }
        // assistant.turn_start/end、tool.execution_* 只有游标与成功标志，无正文，跳过
      }
      if (!messages.length) continue;
      const times = messages.map((m) => m.createdAt).filter(Boolean).sort();
      const firstUser = messages.find((m) => m.role === 'user');
      sessions.push({
        agentSessionId: sessionId,
        workspacePath: null, // 事件流不含 cwd 信息
        title: (firstUser?.text || '(无标题会话)').split('\n')[0].slice(0, 120),
        createdAt: times[0] || startTime,
        updatedAt: times.at(-1) || startTime,
        messages,
      });
    }
    return sessions;
  },

  /** copilot 主源（chatSessions）已有的会话不导入；它后来补上的同 id 会话也自然跳过 */
  filterSessions(db, sessions) {
    const known = new Set(
      db.prepare("SELECT agent_session_id FROM sessions WHERE agent = 'copilot'").all()
        .map((r) => r.agent_session_id)
    );
    return sessions.filter((s) => !known.has(s.agentSessionId));
  },
};
