// OpenCode v2 (anomalyco/opencode ≥ 2.0) adapter
// 数据源: $XDG_DATA_HOME/opencode/opencode.db（缺省 ~/.local/share/opencode，Windows 也是这个位置）；
// 非稳定渠道写 opencode-<channel>.db，OPENCODE_DB 可改路径（相对路径按数据目录解析）。
// 一个库装全部会话 → parseFile 返回会话数组。
//
// v2 表结构（ZCode 与 OpenCode 1.x 用的是 session/message/part，与此不同）：
//   session_v2(id, parent_id, directory, title, time_created/updated)   parent_id = 子 agent 会话
//   session_message(id, session_id, type, seq, data JSON)   type 共 11 种，见 parseSession 的 switch
//   session_part(message_id, ordinal, data)   助手 content 的外置存储（2026-10 起）：消息有 part 行时
//     以 part 为准，message.data.content 只剩 []；没有 part 行的老消息仍内联
//   blob(hash, mime, data)   用户附件/工具结果文件的字节，消息里以 "media:<sha256>" 引用
// OpenCode 2 首次启动会把 1.x 的数据迁进 v2 表，所以只读 v2。
//
// 整库一个指纹：OpenCode 每写一条消息都会让全部会话重解析。filterSessions 跳过
// 库里已是最新的会话，否则每轮都要把所有会话的消息和 FTS 行删掉重建。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from '../util.js';
import { saveImages } from '../imagestore.js';

// 改动映射规则时升级：filterSessions 见到旧版本指纹就不跳过，全部重建
const PARSER_VERSION = 'v1';
const TOOL_ARGS_LIMIT = 4000;   // 与 pi 一致：todo 类工具的清单 JSON 要留全
const TOOL_RESULT_LIMIT = 2000;
const NOTICE_LIMIT = 500;

function dataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share'), 'opencode');
}

function dbFiles() {
  const dir = dataDir();
  const out = new Set();
  const env = process.env.OPENCODE_DB;
  if (env && env !== ':memory:') out.add(path.resolve(dir, env));
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^opencode(-[A-Za-z0-9._-]+)?\.db$/.test(name)) out.add(path.join(dir, name));
    }
  } catch { /* 未安装 */ }
  return [...out].filter((f) => fs.existsSync(f));
}

const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

function clip(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…(截断，共 ${text.length} 字符)` : text;
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((x) => x.trim()).find(Boolean);
  return line ? line.slice(0, 80) : null;
}

const errText = (e) => (e ? `${e.type ? `${e.type}: ` : ''}${e.message || ''}`.trim() : '');

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * 附件/工具结果文件 → 图片落盘 + 非图片的文字占位。
 * 字节来源三选一：内联 base64（data）、blob 引用（uri = media:<sha256>）、data: URI。
 */
function collectFiles(files, sessionId, blobOf) {
  const images = [];
  const notes = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f !== 'object') continue;
    const uri = typeof f.uri === 'string' ? f.uri : '';
    let mime = f.mime || '';
    let data = typeof f.data === 'string' ? f.data : null;
    let key = null;
    if (!data && uri.startsWith('media:')) {
      const blob = blobOf(uri.slice(6));
      if (blob) { data = blob.data; mime = mime || blob.mime; key = uri.slice(6, 22); }
    } else if (!data && uri.startsWith('data:')) {
      data = uri;
    }
    if (data && (/^image\//.test(mime) || /^data:image\//.test(data))) {
      key ||= crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
      const saved = saveImages(opencodeAdapter.id, sessionId, key, [{ data, mime }], { skipExisting: true });
      if (saved.length) { images.push(...saved); continue; }
    }
    const label = f.name || f.source?.uri || (uri.startsWith('media:') ? '' : uri) || mime || 'file';
    notes.push(`[file: ${label}${mime && label !== mime ? ` (${mime})` : ''}]`);
  }
  return { images, notes };
}

function toolOutput(content, sessionId, blobOf) {
  const items = Array.isArray(content) ? content : [];
  const text = items.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
  const { images, notes } = collectFiles(items.filter((c) => c?.type === 'file'), sessionId, blobOf);
  return { text: [text, ...notes].filter(Boolean).join('\n'), images };
}

function parseSession(s, rows, partsOf, blobOf) {
  const sid = s.id;
  const messages = [];
  let maxUpdated = s.time_updated || 0;
  let lastError = null;   // 助手/压缩已报过的错误，idle 再报同一条时不重复
  const push = (m) => { messages.push(m); };

  for (const r of rows) {
    if (r.time_updated > maxUpdated) maxUpdated = r.time_updated;
    const d = parseJson(r.data);
    if (!d) continue;
    const at = iso(d.time?.created) ?? iso(r.time_created);
    const raw = { id: r.id, seq: r.seq, type: r.type };

    switch (r.type) {
      case 'user': {
        const text = typeof d.text === 'string' ? d.text.trim() : '';
        const { images, notes } = collectFiles(d.files, sid, blobOf);
        const body = [text, ...notes].filter(Boolean).join('\n');
        if (!body && !images.length) break;
        push({ role: 'user', createdAt: at, text: body || '(图片消息)', raw, images });
        break;
      }

      case 'assistant': {
        const model = d.model?.id || null;
        const effort = d.model?.variant || null;
        const parts = partsOf(r.id);
        if (parts.updated > maxUpdated) maxUpdated = parts.updated;
        const content = parts.list.length ? parts.list : Array.isArray(d.content) ? d.content : [];
        // 按 content 顺序落行，时间只增不减：text 片段没有自己的时间（回落到步骤开始），
        // 并行工具的第二个调用又早于第一个的结果
        let cursor = d.time?.created || r.time_created || 0;
        const stamp = (ms) => { if (typeof ms === 'number' && ms > cursor) cursor = ms; return iso(cursor) ?? at; };
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          if (c.type === 'text' || c.type === 'reasoning') {
            const text = typeof c.text === 'string' ? c.text.trim() : '';
            if (!text) continue;
            const role = c.type === 'text' ? 'assistant' : 'thinking';
            // 同一步里相邻的同类片段合成一行（流式分片、多段推理）
            const prev = messages[messages.length - 1];
            if (prev && prev.role === role && prev.raw?.id === r.id) { prev.text += `\n${text}`; continue; }
            push({ role, createdAt: stamp(c.time?.created), text, raw: { ...raw, part: c.type }, model, effort });
            continue;
          }
          if (c.type !== 'tool') continue;
          const st = c.state || {};
          const name = c.name || 'tool';
          // 调用与结果分两行，便于按工具名检索、还原配对（与 pi 一致）
          push({
            role: 'tool',
            createdAt: stamp(c.time?.created),
            text: `[tool:${name}] ${clip(st.input ?? {}, TOOL_ARGS_LIMIT)}`,
            raw: { ...raw, part: 'tool', callId: c.id, name, status: st.status },
            model,
          });
          if (st.status !== 'completed' && st.status !== 'error') continue;
          const out = toolOutput(st.content, sid, blobOf);
          const isErr = st.status === 'error';
          const body = [isErr ? errText(st.error) : '', out.text].filter(Boolean).join('\n');
          push({
            role: 'tool',
            createdAt: stamp(c.time?.completed ?? c.time?.ran),
            text: `[tool_result:${name}${isErr ? ' error' : ''}] ${clip(body || '(图片结果)', TOOL_RESULT_LIMIT)}`,
            raw: { ...raw, part: 'tool_result', callId: c.id, name, isError: isErr },
            images: out.images,
          });
        }
        if (d.error) {
          lastError = errText(d.error);
          push({
            role: 'system',
            createdAt: stamp(d.time?.completed),
            text: `[error] ${clip(lastError, NOTICE_LIMIT)}`,
            raw: { ...raw, part: 'error' },
          });
        }
        break;
      }

      // 压缩摘要是模型真实产出的正文（之后的上下文就是它），全文留档
      case 'compaction':
        if (d.status === 'completed' && typeof d.summary === 'string' && d.summary.trim()) {
          push({ role: 'system', createdAt: at, text: `[compaction:${d.reason || 'auto'}] ${d.summary.trim()}`, raw });
        } else if (d.status === 'failed') {
          lastError = errText(d.error);
          push({ role: 'system', createdAt: at, text: `[compaction failed] ${clip(lastError, NOTICE_LIMIT)}`, raw });
        }
        break;

      // 指令更新（工具目录、AGENTS.md 等），正文动辄上万字，只留开头
      case 'system':
        if (typeof d.text === 'string' && d.text.trim()) {
          push({ role: 'system', createdAt: at, text: `[system${d.description ? `: ${d.description}` : ''}] ${clip(d.text.trim(), NOTICE_LIMIT)}`, raw });
        }
        break;

      // 程序注入、以用户身份进上下文的消息（子 agent 结果回填、自动续跑等）
      case 'synthetic':
        if (typeof d.text === 'string' && d.text.trim()) {
          push({ role: 'system', createdAt: at, text: `[synthetic${d.description ? `: ${d.description}` : ''}] ${clip(d.text.trim(), TOOL_RESULT_LIMIT)}`, raw });
        }
        break;

      case 'skill':
        push({ role: 'system', createdAt: at, text: `[skill:${d.name || d.skill || 'skill'}] ${clip(String(d.text ?? '').trim(), NOTICE_LIMIT)}`, raw });
        break;

      // TUI 里 `!` 直接执行的命令：不是模型调用，但属于会话正文
      case 'shell': {
        const head = `[shell!${d.exit != null ? ` exit=${d.exit}` : ''}${d.status && d.status !== 'exited' ? ` ${d.status}` : ''}] ${d.command || ''}`;
        const out = typeof d.output?.output === 'string' ? clip(d.output.output.trimEnd(), TOOL_RESULT_LIMIT) : '';
        push({ role: 'tool', createdAt: at, text: out ? `${head}\n${out}` : head, raw: { ...raw, truncated: !!d.output?.truncated } });
        break;
      }

      // 一轮结束的标记：只有中断、或助手没报过的失败值得留
      case 'idle': {
        const e = errText(d.error);
        if (d.outcome === 'interrupted') {
          push({ role: 'system', createdAt: at, text: '[idle:interrupted]', raw });
        } else if (d.outcome === 'failed' && e && e !== lastError) {
          push({ role: 'system', createdAt: at, text: `[idle:failed] ${clip(e, NOTICE_LIMIT)}`, raw });
        }
        lastError = null;
        break;
      }

      // agent-switched / model-switched / location-switched：状态行；助手消息自带 model
      default:
        break;
    }
  }

  if (!messages.length) return null;
  const seed = messages.find((m) => m.role === 'user' && m.text !== '(图片消息)')
    || messages.find((m) => m.role === 'assistant');
  return {
    agentSessionId: sid,
    workspacePath: s.directory || null,
    title: (typeof s.title === 'string' && s.title.trim().slice(0, 200)) || (seed && firstLine(seed.text)) || '(无标题会话)',
    createdAt: iso(s.time_created) ?? messages[0].createdAt,
    updatedAt: iso(maxUpdated) ?? messages[messages.length - 1].createdAt,
    messages,
  };
}

/** 在一个读事务里解析全部会话：各表取自同一时刻，不会读到写了一半的消息与 part */
function readAll(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  if (!tables.has('session_v2') || !tables.has('session_message')) return null;   // 1.x 布局或尚未迁移

  db.exec('BEGIN');
  try {
    const msgStmt = db.prepare(
      'SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq'
    );
    const partStmt = tables.has('session_part')
      ? db.prepare('SELECT message_id, time_updated, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal')
      : null;
    const blobStmt = tables.has('blob') ? db.prepare('SELECT mime, data FROM blob WHERE hash = ?') : null;
    const blobOf = (hash) => {
      const row = blobStmt?.get(hash);
      return row ? { mime: row.mime, data: Buffer.from(row.data).toString('base64') } : null;
    };

    const sessions = [];
    const sessRows = db.prepare(
      'SELECT id, parent_id, directory, title, time_created, time_updated FROM session_v2 ORDER BY time_created'
    ).all();
    for (const s of sessRows) {
      const parts = new Map();
      for (const p of partStmt ? partStmt.all(s.id) : []) {
        const data = parseJson(p.data);
        if (!data) continue;
        let e = parts.get(p.message_id);
        if (!e) parts.set(p.message_id, (e = { list: [], updated: 0 }));
        e.list.push(data);
        if (p.time_updated > e.updated) e.updated = p.time_updated;
      }
      const none = { list: [], updated: 0 };
      const parsed = parseSession(s, msgStmt.all(s.id), (id) => parts.get(id) || none, blobOf);
      if (parsed) sessions.push(parsed);
    }
    return sessions;
  } finally {
    try { db.exec('COMMIT'); } catch { /* 只读事务 */ }
  }
}

export const opencodeAdapter = {
  id: 'opencode',

  watchRoots() {
    return [dataDir()];
  },

  discover() {
    return dbFiles().map((src) => {
      const st = fs.statSync(src);
      let mtimeMs = Math.round(st.mtimeMs), size = st.size;
      // WAL 里可能有未 checkpoint 的数据，指纹取两者最新
      try {
        const w = fs.statSync(src + '-wal');
        mtimeMs = Math.max(mtimeMs, Math.round(w.mtimeMs));
        size += w.size;
      } catch { /* 无 wal */ }
      return { path: src, size, mtimeMs };
    });
  },

  fingerprint: (file) => `${PARSER_VERSION}|${fingerprint(file)}`,

  async parseFile(filePath) {
    // WAL 库直接只读打开即可与运行中的 OpenCode 共存；打不开（被独占等）再退回快照
    let db = null;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      return readAll(db);
    } catch (err) {
      try { db?.close(); } catch { /* 已关 */ }
      db = null;
      const tmp = path.join(os.tmpdir(), `ae-opencode-${process.pid}-${Date.now()}.db`);
      try {
        fs.copyFileSync(filePath, tmp);
        for (const ext of ['-wal', '-shm']) {
          try { fs.copyFileSync(filePath + ext, tmp + ext); } catch { /* 无 */ }
        }
        db = new DatabaseSync(tmp, { readOnly: true });
        return readAll(db);
      } catch {
        throw err;
      } finally {
        try { db?.close(); } catch { /* 已关 */ }
        db = null;
        for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(tmp + ext, { force: true }); } catch { /* 忽略 */ } }
      }
    } finally {
      try { db?.close(); } catch { /* 已关 */ }
    }
  },

  // 库里已是最新（更新时间、消息数、标题都没变）的会话不重写
  filterSessions(db, sessions) {
    const stale = db.prepare("SELECT 1 FROM sync_state WHERE agent = 'opencode' AND fingerprint NOT LIKE ?")
      .get(`${PARSER_VERSION}|%`);
    if (stale) return sessions;
    const known = new Map(
      db.prepare("SELECT agent_session_id, updated_at, message_count, title FROM sessions WHERE agent = 'opencode'").all()
        .map((r) => [r.agent_session_id, r])
    );
    return sessions.filter((s) => {
      const k = known.get(s.agentSessionId);
      return !k || k.updated_at !== s.updatedAt || k.message_count !== s.messages.length || k.title !== s.title;
    });
  },
};
