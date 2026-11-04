// ZCode adapter
// 数据源: ~/.zcode/cli/db/db.sqlite（WAL）——结构化会话存储：
//   session(id, path=workspace, title, time_created/updated ms)
//   message(id, session_id, data{role,time,modelID}, sequence)
//   part(id, message_id, data{type:text|reasoning|tool,...}, sequence)
// 一个 db 文件包含全部会话 → parseFile 返回会话数组（sync 逐个 upsert）。
// 读取前复制快照（含 -wal），避免与运行中的 ZCode 抢锁。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from '../util.js';

function dbFile() {
  return path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

/** 复制 sqlite + wal/shm 到临时目录，返回快照路径（用完删除） */
function snapshot(src) {
  const tmp = path.join(os.tmpdir(), `ae-zcode-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
  fs.copyFileSync(src, tmp);
  for (const ext of ['-wal', '-shm']) {
    try { fs.copyFileSync(src + ext, tmp + ext); } catch { /* 无 wal 或被占用 */ }
  }
  return tmp;
}

const iso = (ms) => (typeof ms === 'number' && ms ? new Date(ms).toISOString() : null);

function extractParts(parts) {
  const textParts = [];
  const thinkParts = [];
  const toolParts = [];
  for (const p of parts) {
    let o;
    try { o = JSON.parse(p.data); } catch { continue; }
    if (o.type === 'text' && o.text) textParts.push(o.text);
    else if (o.type === 'reasoning' && o.text) thinkParts.push(o.text);
    else if (o.type === 'tool') {
      const name = o.tool || o.name || o.state?.tool || 'tool';
      const input = o.input ?? o.state?.input;
      const detail = input ? JSON.stringify(input).slice(0, 200) : '';
      toolParts.push(`[tool:${name}] ${detail}`);
    }
  }
  return { textParts, thinkParts, toolParts };
}

export const zcodeAdapter = {
  id: 'zcode',

  watchRoots() {
    return [path.join(os.homedir(), '.zcode', 'cli', 'db')];
  },

  discover() {
    const src = dbFile();
    if (!fs.existsSync(src)) return [];
    const st = fs.statSync(src);
    let mtimeMs = Math.round(st.mtimeMs), size = st.size;
    // WAL 里可能有未 checkpoint 的数据，指纹取两者最新
    try {
      const w = fs.statSync(src + '-wal');
      mtimeMs = Math.max(mtimeMs, Math.round(w.mtimeMs));
      size += w.size;
    } catch { /* 无 wal */ }
    return [{ path: src, size, mtimeMs }];
  },

  fingerprint,

  async parseFile(filePath) {
    const snap = snapshot(filePath);
    const sessions = [];
    try {
      const db = new DatabaseSync(snap, { readOnly: true });

      const sessRows = db.prepare(
        'SELECT id, path, title, time_created, time_updated FROM session ORDER BY time_created'
      ).all();

      // parts 一次取全，按 message 分组
      const partsByMsg = new Map();
      for (const p of db.prepare('SELECT message_id, data FROM part').all()) {
        if (!partsByMsg.has(p.message_id)) partsByMsg.set(p.message_id, []);
        partsByMsg.get(p.message_id).push(p);
      }

      const msgStmt = db.prepare(
        'SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY sequence'
      );
      for (const s of sessRows) {
        const messages = [];
        let firstTs = null, lastTs = null, model = null;
        for (const m of msgStmt.all(s.id)) {
          let md;
          try { md = JSON.parse(m.data); } catch { continue; }
          const role = md.role;
          if (role !== 'user' && role !== 'assistant') continue;
          const createdAt = iso(md.time?.created ?? m.time_created) ?? iso(m.time_created);
          if (!firstTs && createdAt) firstTs = createdAt;
          if (createdAt) lastTs = createdAt;
          if (role === 'assistant' && md.modelID) model = md.modelID;

          const { textParts, thinkParts, toolParts } = extractParts(partsByMsg.get(m.id) || []);
          if (role === 'assistant' && thinkParts.length) {
            messages.push({ role: 'thinking', createdAt, text: thinkParts.join('\n'), model });
          }
          const text = [...textParts, ...toolParts].join('\n');
          if (!text) continue;
          // 注入过滤（与 Codex 同类：环境上下文等）
          if (role === 'user' && /^(<user_info>|<timestamp>|<system)/.test(text)) continue;
          // 相邻完全相同的消息去重（ZCode 偶发双写）
          const prev = messages[messages.length - 1];
          if (prev && prev.role === role && prev.text === text) continue;
          const hasTool = toolParts.length > 0;
          messages.push({
            role: role === 'user' ? 'user' : hasTool && !textParts.length ? 'tool' : role,
            createdAt,
            text,
            model: role === 'assistant' ? model : null,
            effort: null,
          });
        }
        if (!messages.length) continue;
        // 标题：session.title 优先
        const firstUser = messages.find((x) => x.role === 'user');
        sessions.push({
          agentSessionId: s.id,
          workspacePath: s.path || s.directory || null,
          title: s.title || (firstUser ? firstUser.text.split('\n')[0].slice(0, 80) : '(无标题会话)'),
          createdAt: iso(s.time_created) ?? firstTs,
          updatedAt: iso(s.time_updated) ?? lastTs,
          messages,
        });
      }
      db.close();
    } finally {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(snap + ext); } catch { /* 已删 */ }
      }
    }
    return sessions; // 多会话数组
  },
};
