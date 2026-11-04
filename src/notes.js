// Codex token-budget 的 notes 后端：给"上下文窗口轮换"提供检查点存储与回灌。
//
// 为什么在这里做：codex 开启 features.token_budget 后，压缩策略会换成
// "不做摘要、直接开新窗口"（core/src/session/turn.rs:1270）。新窗口里
// message 是空字符串，只剩初始上下文——所以必须有一份模型自己写的检查点，
// 否则窗口重置等于清空。官方的 notes/history 扩展被三重门禁挡住（要求
// AuthMode::Chatgpt + Plus/Pro 计划 + provider 指向 backend-api/codex），
// 经 CPA 代理的链路一条都不满足，但 codex 留了 MCP 旁路：token_budget 打开
// 且原生扩展关闭时，它会去调名为 notes 的 MCP server 的 thread_hint 工具，
// 把返回文本注入 developer 消息。本文件就是那个 server。
//
// 两个职责边界：
//   - 检查点正文存在本库 notes 表，与增量索引无关。索引坏掉也不会丢检查点，
//     最坏只退化成"没有 seq 锚点的散文摘要"。
//   - seq 锚点与历史回查依赖 sessions/messages 索引，所以每次 hint 与写入
//     都先对该 thread 做一次窄同步（sync-on-read），把 0~45 秒的扫描延迟消掉。
import { syncThread } from './sync.js';
import { log } from './log.js';

const MAX_NOTE_BYTES = 64 * 1024;   // 单个检查点上限：够写完整交接，又不至于反过来吃掉上下文
const MAX_HINT_BYTES = 4000;        // 对齐上游 MAX_THREAD_HINT_BYTES（codex-rs/ext/history-notes/src/extension.rs:31）
const INDEX_PATH = 'INDEX.md';      // 目录文件：hint 里唯一带正文的一份
// 名录再长也不许把正文挤到这个线以下。这个数必须兑现 guidance_message 里对模型
// 的承诺（"INDEX.md ... under ~2500 bytes"）：说 2500 就得留得出 2500，否则模型
// 照着写反而被截断。2500 + 截断提示 + 余量。实测名录 24 条时若不设这个下限，
// 正文只剩 2127 字节。
const MIN_BODY_BYTES = 2700;
const MAX_ROSTER_ENTRIES = 24;      // 名录条数上限，超出折叠成一行计数
const CODEX_AGENT = 'codex';

/** 相对路径归当前 thread；`/<threadId>/<path>` 可跨 thread 只读（与官方 guidance 的路径语义一致）。 */
export function parseNotePath(raw, currentThreadId) {
  const s = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!s) throw new Error('缺少 path');
  if (s.includes('..')) throw new Error('path 不允许包含 ..');
  if (!s.startsWith('/')) {
    if (!currentThreadId) throw new Error('相对 path 需要当前 thread；请改用 /<threadId>/<path>');
    return { threadId: currentThreadId, path: s, crossThread: false };
  }
  const parts = s.slice(1).split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('绝对 path 形如 /<threadId>/<file>');
  return { threadId: parts[0], path: parts.slice(1).join('/'), crossThread: parts[0] !== currentThreadId };
}

/** thread 在索引里的位置。未入库时返回 null——检查点照样可读写，只是没有 seq 锚点。 */
export function threadAnchor(db, threadId) {
  if (!threadId) return null;
  const row = db.prepare(
    'SELECT id, title, message_count, updated_at, workspace_id FROM sessions WHERE agent = ? AND agent_session_id = ?'
  ).get(CODEX_AGENT, threadId);
  if (!row) return null;
  const count = Number(row.message_count) || 0;
  return {
    session_id: row.id,
    latest_seq: count > 0 ? count - 1 : 0,
    message_count: count,
    updated_at: row.updated_at,
  };
}

/**
 * 拉平该 thread 的索引延迟。失败不抛：检查点本身不依赖索引，
 * 让一次同步故障连带 write_note 一起失败是错误的取舍。
 */
async function freshen(db, threadId) {
  if (!threadId) return null;
  try {
    return await syncThread(db, CODEX_AGENT, threadId);
  } catch (err) {
    log.debug('notes', `thread ${threadId} 窄同步失败（不影响检查点）: ${err?.message || err}`);
    return null;
  }
}

function clampBytes(text, max, label) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  // 按字节截断可能切断多字节字符，用 Buffer 再解码交给替换字符处理
  const cut = Buffer.from(s, 'utf8').subarray(0, max).toString('utf8');
  log.info('notes', `${label} 超过 ${max} 字节，已截断`);
  return cut.replace(/�+$/, '') + `\n…（已截断，原文 ${Buffer.byteLength(s, 'utf8')} 字节）`;
}

export function readNote(db, threadId, notePath) {
  return db.prepare(
    'SELECT thread_id, path, content, created_at, updated_at FROM notes WHERE thread_id = ? AND path = ?'
  ).get(threadId, notePath) || null;
}

/**
 * 取正文的一段行。语义照官方 notes read_file：1 起、闭区间、负数从末尾倒数
 * （-1 是最后一行）。有了它，hint 里被截断的那份就不必整份重读——这是
 * open-notes-mcp 没做、官方做了的一处。
 */
export function sliceNoteLines(content, firstLine, lastLine) {
  const lines = String(content ?? '').split('\n');
  const n = lines.length;
  const norm = (v, dflt) => {
    if (v === undefined || v === null || v === '') return dflt;
    const i = Number(v);
    if (!Number.isFinite(i) || i === 0) throw new Error('行号必须是非零整数（1 起，负数从末尾倒数）');
    return i < 0 ? n + i + 1 : i;
  };
  const from = Math.max(norm(firstLine, 1), 1);
  const to = Math.min(norm(lastLine, n), n);
  if (from > to) return { text: '', first_line: from, last_line: to, total_lines: n };
  return { text: lines.slice(from - 1, to).join('\n'), first_line: from, last_line: to, total_lines: n };
}

export function listNotes(db, threadId) {
  return db.prepare(
    // CAST 到 BLOB 才是字节：SQLite 的 length() 对 TEXT 数的是字符。这个字段
    // 叫 bytes、而且会进 hint 名录喂给模型，中文多的 note 会少报 16% 左右
    // （实测 11919 vs 13783），和 write_note 返回的 Buffer.byteLength 对不上。
    'SELECT path, length(CAST(content AS BLOB)) AS bytes, updated_at FROM notes WHERE thread_id = ? ORDER BY updated_at DESC, id DESC'
  ).all(threadId);
}

export function writeNote(db, threadId, notePath, content, { append = false } = {}) {
  const now = new Date().toISOString();
  const existing = append ? readNote(db, threadId, notePath) : null;
  const body = clampBytes(
    existing ? `${existing.content}\n${content}` : content,
    MAX_NOTE_BYTES,
    `${threadId}/${notePath}`
  );
  db.prepare(
    `INSERT INTO notes(thread_id, path, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(thread_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
  ).run(threadId, notePath, body, now, now);
  return { path: notePath, bytes: Buffer.byteLength(body, 'utf8'), updated_at: now };
}

export function deleteNote(db, threadId, notePath) {
  return Number(db.prepare('DELETE FROM notes WHERE thread_id = ? AND path = ?').run(threadId, notePath).changes) > 0;
}

export function searchNotes(db, { threadId = null, q, limit = 20 }) {
  const needle = `%${String(q || '').trim()}%`;
  const sql = threadId
    ? 'SELECT thread_id, path, content, updated_at FROM notes WHERE thread_id = ? AND content LIKE ? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT thread_id, path, content, updated_at FROM notes WHERE content LIKE ? ORDER BY updated_at DESC LIMIT ?';
  const rows = threadId
    ? db.prepare(sql).all(threadId, needle, limit)
    : db.prepare(sql).all(needle, limit);
  return rows;
}

/** 字节长度，全文件统一用这个而不是 String.length。 */
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/**
 * 把正文压进预算：掐头去尾各留一段，而不是只留开头。
 *
 * 检查点的目标写在顶部、最新进展和「下一步」写在底部，只保留开头会把后者整段
 * 丢掉——这正是 open-notes-mcp 已知的弱点（它从尾部切，INDEX 一胀就先丢最新的
 * 行，README 自报 30 个 agent 里 7 个撞了上限）。按行切，顺带保证不会截断多字节
 * 字符。
 */
function clampHintBody(text, budget) {
  if (bytes(text) <= budget) return { text, truncated: false };
  const marker = '\n…[中段已省略，用 notes__read_note 读全文]…\n';
  const room = budget - bytes(marker);
  if (room <= 0) return { text: '', truncated: true };

  const lines = String(text).split('\n');
  const head = [];
  const tail = [];
  const headRoom = Math.floor(room * 0.6);
  let used = 0;
  let i = 0;
  let j = lines.length - 1;
  while (i <= j) {
    const cost = bytes(lines[i]) + 1;
    if (used + cost > headRoom) break;
    head.push(lines[i]);
    used += cost;
    i++;
  }
  while (j >= i) {
    const cost = bytes(lines[j]) + 1;
    if (used + cost > room) break;
    tail.unshift(lines[j]);
    used += cost;
    j--;
  }
  return { text: head.join('\n') + marker + tail.join('\n'), truncated: true };
}

/**
 * 新窗口开头注入的文本。codex 只取 content[].text 并 join，所以这里返回的每一行
 * 都会原样进入 developer 消息。
 *
 * 分层：**只有 INDEX.md 带正文，其余一律只报名字**。这样就不存在「在多份检查点
 * 之间挑谁进去」这个决定。旧实现按更新时间贪心打包、整份放不下就跳过接着试下一
 * 份，结果 2026-09-08 的 1707 会话里 23 次轮换中有 3 次把当时活着的检查点整份
 * 丢掉、换上一份早已废弃的：18:10 那次模型刚写完 13.8 KB，三秒后的轮换就把它
 * 扔了，灌进去的是 4.5 小时前就不再更新的另一份。没有选择，就没有误选。
 *
 * 还没有 INDEX.md 的 thread 退化成「带最新那一份的正文」并提示建目录。最新那份
 * **永远不会被整份丢弃**，超预算只截断。
 *
 * 预算 4000 字节对齐上游 MAX_THREAD_HINT_BYTES
 * （codex-rs/ext/history-notes/src/extension.rs:31）。原生路径超限会把整份 hint
 * 丢掉（那里是 `return Vec::new()`）；我们走的 MCP bridge 路径不做检查
 * （codex-rs/core/src/session/mod.rs:4084 只把 content[].text join 起来），但没有
 * 理由比上游认为合理的尺寸更大——这段文本是贴在一个刚因为太满而被切掉的窗口
 * 前面的。旧的 8 KB 上限下，实测 23 次注入有 22 次超过 4000。
 *
 * 工具名与 config.toml 的 features.token_budget.guidance_message 保持一致，
 * 前提是 features.non_prefixed_mcp_tool_names 的白名单里有 "notes"（否则实际
 * 名字是 mcp__notes__write_note）。两处必须一起改。
 */
export function buildThreadHint(db, threadId) {
  const notes = listNotes(db, threadId);
  const anchor = threadAnchor(db, threadId);
  const head = [];

  if (anchor) {
    head.push(
      `Conversation archive: session ${anchor.session_id}, ${anchor.message_count} messages indexed (latest seq ${anchor.latest_seq}).`,
      `Recover detail: mcp__chat_vault__search_conversations(q=...) returns a seq per hit, then`,
      `mcp__chat_vault__get_session(session_id=${anchor.session_id}, around_seq=<seq>, window=20).`
    );
  }

  if (!notes.length) {
    head.push(`No notes saved for this thread yet. Start ${INDEX_PATH} with notes__write_note before this window fills.`);
    return head.join('\n');
  }

  // 带正文的那一份：优先 INDEX.md，否则退化成最新的一份（listNotes 按更新时间倒序，
  // 同毫秒写入按插入顺序兜底）。
  const hasIndex = notes.some((n) => n.path === INDEX_PATH);
  const bodyPath = hasIndex ? INDEX_PATH : notes[0].path;
  const roster = notes.filter((n) => n.path !== bodyPath);

  const headText = head.join('\n');
  const bodyHeader = `--- ${bodyPath} ---`;
  const migrationNote = hasIndex
    ? null
    : `[没有 ${INDEX_PATH}：上面是最新的一份。建一个 ${INDEX_PATH} 当目录，下个窗口才看得到全部检查点的入口。]`;
  const truncNote = hasIndex
    ? `[${INDEX_PATH} 太大已截断。它是目录不是笔记本：一个主题一行，细节各自成文件。]`
    : `[已截断。把细节拆进独立文件，在 ${INDEX_PATH} 里只留一行指针。]`;

  // 名录：短且有界，但不能反过来把正文挤没。先给正文留 MIN_BODY_BYTES，
  // 不够就从最旧的一条开始砍，折叠成一行计数。
  const rosterLines = [];
  if (roster.length) {
    rosterLines.push('--- other notes (names only; read with notes__read_note) ---');
    const shown = roster.slice(0, MAX_ROSTER_ENTRIES);
    for (const n of shown) rosterLines.push(`${n.path} (${n.bytes} bytes, updated ${n.updated_at})`);
    if (roster.length > shown.length) rosterLines.push(`… and ${roster.length - shown.length} more (notes__list_notes)`);
  }

  // 正文之外的字节开销，逐段加上 join 的换行。截断提示不算在内：只有确定会
  // 截断时才为它留位置，否则不截断的情况会白白少给正文一截。
  const segment = (text) => (text ? bytes(text) + 1 : 0);
  const overheadOf = (rosterText) =>
    segment(headText) + segment(bodyHeader) + segment(migrationNote) + segment(rosterText);

  let rosterText = rosterLines.join('\n');
  while (rosterLines.length > 2 && MAX_HINT_BYTES - overheadOf(rosterText) < MIN_BODY_BYTES) {
    rosterLines.splice(rosterLines.length - 1, 1);
    rosterLines[rosterLines.length - 1] = `… and ${roster.length - (rosterLines.length - 2)} more (notes__list_notes)`;
    rosterText = rosterLines.join('\n');
  }

  const full = readNote(db, threadId, bodyPath);
  const raw = full ? full.content : '';
  const avail = Math.max(MAX_HINT_BYTES - overheadOf(rosterText), 0);

  let body = raw;
  let truncated = false;
  if (bytes(raw) > avail) {
    body = clampHintBody(raw, Math.max(avail - segment(truncNote), 0)).text;
    truncated = true;
  }

  // 过滤空段：thread 还没进索引时拿不到锚点，headText 为空，直接 join 会让整段
  // 以一个空行开头。
  const out = [headText, bodyHeader, body];
  if (truncated) out.push(truncNote);
  if (migrationNote) out.push(migrationNote);
  if (rosterText) out.push(rosterText);
  return out.filter((part) => part !== '' && part !== null && part !== undefined).join('\n');
}

export const NOTES_TOOLS = [
  {
    name: 'thread_hint',
    description: 'Return the saved checkpoints for a conversation thread plus the archive anchor used to look up earlier context. Codex calls this itself at the start of every context window; a model does not need to.',
    inputSchema: {
      type: 'object',
      properties: { threadId: { type: 'string', description: 'Codex thread id. Normally supplied by the host in _meta.' } },
    },
    // 对模型隐藏但仍可被宿主调用。codex 的 tool_is_model_visible 读
    // _meta.ui.visibility：缺失=可见，存在则必须含 "model" 才可见；而
    // capture_binding_with_metadata 无论可见性都会把工具登记进 calls 表，
    // 所以 latest_call_tool("notes","thread_hint") 照样能调到。
    // 隐藏的意义：模型拿不到 threadId，看得见只会白占工具位并调用出错。
    _meta: { ui: { visibility: ['app'] } },
  },
  {
    name: 'write_note',
    description: 'Save (replacing) a note for the current thread. INDEX.md is the only note the next context window receives in full, so it must be enough to resume from on its own: current goal, decisions taken, where the work stands, next steps, whether project Memory is loaded, the archive seq range covered, anything the user is still waiting on so a later window can deliver it, and one line per topic pointing at the note holding the detail. Content is stored verbatim: pass real newlines, not an escaped \n, or the note arrives as one unreadable line. About 2500 bytes of it are carried intact — use that room rather than leaving a bare pointer, because every other note costs a read_note round trip in the next window. Returns the current archive position to cite.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note name, e.g. "INDEX.md". Relative paths belong to the current thread.' },
        content: { type: 'string', description: 'Full note body. Replaces any existing note at this path.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'append_note',
    description: 'Append to a checkpoint for the current thread, keeping what is already there. Prefer this for incremental progress notes. Returns the current archive position to cite.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note name. Relative paths belong to the current thread.' },
        content: { type: 'string', description: 'Text to append.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_note',
    description: 'Read one note. A relative path reads the current thread; an absolute path "/<threadId>/<file>" reads another thread. Pass first_line/last_line to read only part of a long note — that is how you recover a note the window hint had to truncate.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note name, or /<threadId>/<file> for another thread.' },
        first_line: { type: 'number', description: 'First line to return, inclusive, 1-based. Negative counts back from the final line. Omit to start at the top.' },
        last_line: { type: 'number', description: 'Last line to return, inclusive, 1-based. Negative counts back from the final line. Omit to read to the end.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_notes',
    description: 'List the checkpoints saved for the current thread, with sizes and update times.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_notes',
    description: 'Search checkpoint text. Defaults to the current thread; pass all_threads to search every thread. This searches notes only — to search the conversation archive use the chat-vault search_conversations tool.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Substring to look for.' },
        all_threads: { type: 'boolean', description: 'Search all threads instead of just this one.' },
        limit: { type: 'number', description: 'Maximum notes to return, default 20.' },
      },
      required: ['q'],
    },
  },
];

export const NOTES_TOOL_NAMES = new Set(NOTES_TOOLS.map((t) => t.name));

/**
 * 执行一个 notes 工具。threadId 由传输层从 params._meta.threadId 取出
 * （codex 用 meta 而不是 arguments 传它：connection_manager 把 meta 写进
 * params["_meta"]，arguments 传的是 null）。
 */
export async function notesToolExec(db, name, args = {}, meta = {}) {
  const threadId = String(args.threadId || meta.threadId || meta.thread_id || '').trim() || null;

  switch (name) {
    case 'thread_hint': {
      if (!threadId) throw new Error('缺少 threadId');
      await freshen(db, threadId);
      return { content: [{ type: 'text', text: buildThreadHint(db, threadId) }] };
    }
    case 'write_note':
    case 'append_note': {
      const target = parseNotePath(args.path, threadId);
      if (target.crossThread) throw new Error('写入只能落在当前 thread；跨 thread 仅可读');
      const written = writeNote(db, target.threadId, target.path, args.content, { append: name === 'append_note' });
      // 锚点在模型正要记录状态的这一刻返回，这是它唯一需要位置信息的时机。
      const synced = await freshen(db, target.threadId);
      const anchor = threadAnchor(db, target.threadId);
      return {
        saved: written,
        archive: anchor
          ? { session_id: anchor.session_id, latest_seq: anchor.latest_seq, indexed_messages: anchor.message_count }
          : { note: 'thread not indexed yet; cite times instead of seq' },
        synced: synced || undefined,
      };
    }
    case 'read_note': {
      const target = parseNotePath(args.path, threadId);
      const row = readNote(db, target.threadId, target.path);
      if (!row) throw new Error(`检查点不存在: ${args.path}`);
      if (args.first_line === undefined && args.last_line === undefined) return row;
      const part = sliceNoteLines(row.content, args.first_line, args.last_line);
      return { ...row, content: part.text, range: { first_line: part.first_line, last_line: part.last_line, total_lines: part.total_lines } };
    }
    case 'list_notes': {
      if (!threadId) throw new Error('缺少 threadId');
      return { thread_id: threadId, notes: listNotes(db, threadId), archive: threadAnchor(db, threadId) };
    }
    case 'search_notes': {
      const q = String(args.q || '').trim();
      if (!q) throw new Error('缺少 q');
      const rows = searchNotes(db, {
        threadId: args.all_threads ? null : threadId,
        q,
        limit: Math.min(Math.max(Number(args.limit) || 20, 1), 100),
      });
      return rows.map((r) => ({ thread_id: r.thread_id, path: r.path, updated_at: r.updated_at, content: r.content }));
    }
    default:
      return undefined;
  }
}
