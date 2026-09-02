// SQLite 存储层：schema、工作区、会话/消息幂等写入、FTS5 维护
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ftsPrepare } from './fts.js';
import { normalizeWorkspacePath, workspaceKey, workspaceName } from './workspace.js';
import { log } from './log.js';

export const AGENTS = {
  'claude-code': { label: 'Claude Code', color: '#d97757' },
  codex: { label: 'Codex', color: '#10a37f' },
  copilot: { label: 'Copilot', color: '#6f42c1' },
  zcode: { label: 'ZCode', color: '#3b82f6' },
  cursor: { label: 'Cursor', color: '#8ab4f8' },
  antigravity: { label: 'Antigravity', color: '#e8eaed' },
  windsurf: { label: 'Windsurf', color: '#2dd4bf' },
  'windsurf-next': { label: 'Windsurf Next', color: '#14b8a6' },
  kiro: { label: 'Kiro', color: '#f59e0b' },
  iflow: { label: 'iFlow', color: '#ec4899' },
  factory: { label: 'Factory', color: '#e879f9' },
  'copilot-chat-open': { label: 'Copilot 转写', color: '#a371f7' },
  qoder: { label: 'Qoder', color: '#9b6bff' },
  deepseek: { label: 'DeepSeek', color: '#4d6bfe' },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL,
  name        TEXT,
  first_seen  TEXT,
  last_active TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_path ON workspaces(path);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY,
  agent            TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  workspace_id     INTEGER REFERENCES workspaces(id),
  title            TEXT,
  created_at       TEXT,
  updated_at       TEXT,
  message_count    INTEGER DEFAULT 0,
  raw_path         TEXT,
  hidden           INTEGER NOT NULL DEFAULT 0,
  UNIQUE(agent, agent_session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  created_at   TEXT,
  content_text TEXT,
  content_raw  TEXT,
  fts_text     TEXT,
  model        TEXT,
  effort       TEXT,
  images       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
-- 作息图聚合（按 created_at 前缀 GROUP BY）的覆盖索引：免扫 2GB+ 消息正文表
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at, session_id);
-- 重试残骸检测（findRetryCorpses）：用户消息行数远小于全表，部分索引免扫正文；
-- 表达式索引须与查询里的 LOWER(TRIM(...)) 逐字一致才能命中
CREATE INDEX IF NOT EXISTS idx_messages_user_session ON messages(session_id) WHERE role = 'user';
CREATE INDEX IF NOT EXISTS idx_messages_user_text ON messages(LOWER(TRIM(content_text))) WHERE role = 'user';
CREATE TABLE IF NOT EXISTS message_flags (
  agent            TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  seq              INTEGER NOT NULL,
  todo             INTEGER NOT NULL DEFAULT 0, -- 待办标记（与收藏可共存）
  star             INTEGER NOT NULL DEFAULT 0, -- 收藏标记
  created_at       TEXT NOT NULL,
  PRIMARY KEY(agent, agent_session_id, seq)
);

CREATE TABLE IF NOT EXISTS sync_state (
  source_path TEXT PRIMARY KEY,
  agent       TEXT,
  fingerprint TEXT,
  synced_at   TEXT
);

-- AI 检索助手的对话归档：每次问答一行，刷新/重开后可恢复
CREATE TABLE IF NOT EXISTS ai_chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  question   TEXT NOT NULL,
  answer     TEXT,
  steps      TEXT,                       -- JSON 数组：检索步骤 brief
  status     TEXT NOT NULL DEFAULT 'done' -- done | aborted | error
);

-- 会话链：跨 agent 流转的"继续对话"关系（A 引用 B 继续推进）
CREATE TABLE IF NOT EXISTS session_links (
  id          INTEGER PRIMARY KEY,
  from_session INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_session   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  from_seq    INTEGER,                           -- 发起引用的消息 seq（消息级引用树用）
  kind        TEXT NOT NULL DEFAULT 'reference', -- reference | continuation
  source      TEXT NOT NULL DEFAULT 'auto',      -- auto（正则提取）| manual（手动关联）
  note        TEXT,                              -- 手动关联时用户备注
  created_at  TEXT NOT NULL,
  UNIQUE(from_session, to_session)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON session_links(from_session);
CREATE INDEX IF NOT EXISTS idx_links_to ON session_links(to_session);

-- external content FTS：索引列复用 messages.fts_text（存拆字后文本），
-- 删除时直接以列值执行 'delete'，rebuild 可随时从 messages 表全量重建索引
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  fts_text,
  content='messages',
  content_rowid='id',
  tokenize='unicode61'
);
`;

export function defaultDbPath() {
  // 兼容旧路径 ~/.agent-exporter：若存在且新路径不存在，自动迁移整个目录
  const oldDir = path.join(os.homedir(), '.agent-exporter');
  const newDir = path.join(os.homedir(), '.chat-vault');
  try {
    if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
    }
  } catch { /* 迁移失败则保持旧库位置由调用方决定 */ }
  return path.join(newDir, 'chat-vault.db');
}

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // timeout: 写锁等待 5s（与 serve 进程并发读写时避免 database is locked）
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec('PRAGMA journal_mode=WAL');
  // NORMAL：WAL 模式下仅丢最近 checkpoint 而不损坏库，写性能远高于 FULL
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');
  // 2.6GB 库默认 cache 仅 2MB，热页反复换入换出；64MB 显著减少读 IO
  db.exec('PRAGMA cache_size=-65536');
  // 读路径走内存映射，省一次内核拷贝（只读查询为主）
  db.exec('PRAGMA mmap_size=536870912');
  // WAL 自动回收：超过 64MB 即触发被动 checkpoint 把页合并回主库，
  // 避免长期运行后 WAL 无限增长（实测可积到 GB 级占满磁盘）
  db.exec('PRAGMA wal_autocheckpoint=16384'); // 单位=页（4KB），16384 页 = 64MB
  db.exec(SCHEMA);

  // 轻量迁移：旧库补列（model/effort/images/flag/hidden）
  if (!new Set(db.prepare('PRAGMA table_info(sessions)').all().map((r) => r.name)).has('hidden')) {
    db.exec('ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((r) => r.name));
  if (!cols.has('model')) db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
  if (!cols.has('effort')) db.exec('ALTER TABLE messages ADD COLUMN effort TEXT');
  if (!cols.has('images')) db.exec('ALTER TABLE messages ADD COLUMN images TEXT');
  // 会话链：旧库补 from_seq 列（消息级引用树）
  const linkCols = new Set(db.prepare('PRAGMA table_info(session_links)').all().map((r) => r.name));
  if (!linkCols.has('from_seq')) db.exec('ALTER TABLE session_links ADD COLUMN from_seq INTEGER');
  // 消息标记曾存于 messages.flag 列，但整文件覆盖型 adapter 重同步会重建消息行
  // （id 变化导致标记丢失），现迁移到以 (agent, agent_session_id, seq) 稳定键的独立表
  // message_flags 早期单 flag 列版本（若存在）升级为 todo/star 双列
  try {
    const mfCols = new Set(db.prepare('PRAGMA table_info(message_flags)').all().map((r) => r.name));
    if (mfCols.has('flag') && !mfCols.has('todo')) {
      db.exec('ALTER TABLE message_flags RENAME TO message_flags_old');
      db.exec(`CREATE TABLE message_flags (
        agent TEXT NOT NULL, agent_session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        todo INTEGER NOT NULL DEFAULT 0, star INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        PRIMARY KEY(agent, agent_session_id, seq))`);
      db.exec(`INSERT INTO message_flags(agent, agent_session_id, seq, todo, star, created_at)
               SELECT agent, agent_session_id, seq,
                      CASE WHEN flag='todo' THEN 1 ELSE 0 END,
                      CASE WHEN flag='star' THEN 1 ELSE 0 END, created_at
               FROM message_flags_old`);
      db.exec('DROP TABLE message_flags_old');
    }
  } catch { /* 表不存在（新库） */ }
  if (cols.has('flag')) {
    const legacy = db.prepare(`
      SELECT s.agent, s.agent_session_id, m.seq, m.flag
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.flag IS NOT NULL`).all();
    const up = db.prepare(`
      INSERT INTO message_flags(agent, agent_session_id, seq, todo, star, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, agent_session_id, seq) DO UPDATE SET todo=excluded.todo, star=excluded.star`);
    for (const r of legacy) {
      up.run(r.agent, r.agent_session_id, r.seq, r.flag === 'todo' ? 1 : 0, r.flag === 'star' ? 1 : 0, new Date().toISOString());
    }
    if (legacy.length) {
      db.exec('UPDATE messages SET flag = NULL WHERE flag IS NOT NULL');
      log.info('db', `已迁移 ${legacy.length} 条消息标记到 message_flags 表`);
    }
  }

  // 迁移：早期版本建的 contentless FTS 表不支持 delete，重建为 external content 并全量重灌
  const ftsDdl = db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_fts'").get();
  if (ftsDdl && /content\s*=\s*''/.test(ftsDdl.sql)) {
    db.exec('DROP TABLE messages_fts');
    db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(
      fts_text, content='messages', content_rowid='id', tokenize='unicode61')`);
    // 旧库 fts_text 列存的是原文，统一为拆字文本后再重灌
    const rows = db.prepare('SELECT id, fts_text FROM messages').all();
    const upd = db.prepare('UPDATE messages SET fts_text=? WHERE id=?');
    db.exec('BEGIN');
    for (const r of rows) upd.run(ftsPrepare(r.fts_text), r.id);
    db.exec('COMMIT');
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  }
  return db;
}

export function getOrCreateWorkspace(db, rawPath) {
  const normalized = normalizeWorkspacePath(rawPath) || rawPath;
  if (!normalized) return null;
  let row = db.prepare('SELECT id FROM workspaces WHERE lower(path)=lower(?)').get(normalized);
  if (row) return row.id;
  const now = new Date().toISOString();
  const r = db.prepare('INSERT INTO workspaces(path, name, first_seen) VALUES (?, ?, ?)').run(
    normalized, workspaceName(normalized), now
  );
  return Number(r.lastInsertRowid);
}

export function touchWorkspace(db, workspaceId, isoTime) {
  if (!workspaceId || !isoTime) return;
  db.prepare(
    `UPDATE workspaces SET last_active = MAX(COALESCE(last_active,''), ?) WHERE id = ?`
  ).run(isoTime, workspaceId);
}

/**
 * 清理某 agent 下已不被数据源产出的会话行（含消息与 FTS 行），返回删除数。
 * 旧 id 上的消息标记迁到同 uuid 的保留行（seq 能对上才迁），迁不过的直接删除。
 */
export function pruneAgentSessions(db, agent, keptIds) {
  const kept = new Set(keptIds);
  const rows = db.prepare('SELECT id, agent_session_id FROM sessions WHERE agent = ?').all(agent);
  const keptByKey = new Map(rows.filter((r) => kept.has(r.agent_session_id)).map((r) => [r.agent_session_id, r]));
  const stale = rows.filter((r) => !kept.has(r.agent_session_id));
  if (!stale.length) return 0;
  db.exec('BEGIN');
  try {
    const remapFlag = db.prepare(`
      INSERT INTO message_flags(agent, agent_session_id, seq, todo, star, created_at)
      SELECT f.agent, ?, f.seq, f.todo, f.star, f.created_at FROM message_flags f
      JOIN messages m ON m.session_id = ? AND m.seq = f.seq
      WHERE f.agent = ? AND f.agent_session_id = ?
      ON CONFLICT(agent, agent_session_id, seq) DO NOTHING`);
    const delFlag = db.prepare('DELETE FROM message_flags WHERE agent = ? AND agent_session_id = ?');
    const selMsgs = db.prepare('SELECT id, fts_text FROM messages WHERE session_id = ?');
    const delFts = db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, fts_text) VALUES('delete', ?, ?)`);
    const delMsgs = db.prepare('DELETE FROM messages WHERE session_id = ?');
    const delSess = db.prepare('DELETE FROM sessions WHERE id = ?');
    for (const s of stale) {
      const target = keptByKey.get(s.agent_session_id.split(':').pop()); // 老 `wsId:uuid` → uuid
      if (target) remapFlag.run(target.agent_session_id, target.id, agent, s.agent_session_id);
      delFlag.run(agent, s.agent_session_id);
      for (const m of selMsgs.all(s.id)) {
        if (m.fts_text != null && m.fts_text !== '') delFts.run(m.id, m.fts_text);
      }
      delMsgs.run(s.id);
      delSess.run(s.id);
    }
    db.exec('COMMIT');
    return stale.length;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * 幂等写入一个已解析的会话：指纹变化时整体重建该会话的消息与 FTS 行。
 * parsed: { agentSessionId, workspacePath, title, createdAt, updatedAt, messages: [{role, createdAt, text, raw}] }
 *
 * 增量快路径：agent 会话文件多为 append-only JSONL，活跃会话每加一条消息就
 * 全量 DELETE+重插数千行（含 FTS delete/insert）代价过高。当满足
 *   1) 新消息数 > 已存消息数
 *   2) 首条新消息的 (seq 起点) 前缀校验通过 —— 取旧末条与新列表对应位置比对 role+createdAt
 * 时走"只插尾部增量"，否则回退全量重建（内容被编辑/乱序等场景仍正确）。
 */
export function upsertSession(db, agent, sourcePath, fp, parsed) {
  if (!parsed?.agentSessionId || !parsed.messages?.length) return 'empty';
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    const workspaceId = getOrCreateWorkspace(db, parsed.workspacePath);
    const existing = db.prepare(
      'SELECT id FROM sessions WHERE agent=? AND agent_session_id=?'
    ).get(agent, parsed.agentSessionId);

    let sessionId;
    if (!existing) {
      sessionId = Number(
        db.prepare(
          `INSERT INTO sessions(agent, agent_session_id, workspace_id, created_at) VALUES (?, ?, ?, ?)`
        ).run(agent, parsed.agentSessionId, workspaceId, parsed.createdAt ?? now).lastInsertRowid
      );
      insertMessages(db, sessionId, parsed.messages, 0);
    } else {
      sessionId = existing.id;
      const oldCount = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id=?').get(sessionId).c;
      const msgs = parsed.messages;
      // 追加校验：旧消息数 < 新消息数，且旧末条与新列表在重叠区的对应条目一致
      // （比对重叠区首尾两条的 role+createdAt+text 指纹，足够识别"前缀未变"）
      const overlapOk = oldCount > 0 && msgs.length > oldCount && checkPrefixUnchanged(db, sessionId, msgs, oldCount);
      if (overlapOk) {
        insertMessages(db, sessionId, msgs.slice(oldCount), oldCount);
      } else {
        // 全量重建路径：external content FTS 删除需带原索引值
        const oldMsgs = db.prepare('SELECT id, fts_text FROM messages WHERE session_id=?').all(sessionId);
        const delFts = db.prepare(
          `INSERT INTO messages_fts(messages_fts, rowid, fts_text) VALUES('delete', ?, ?)`
        );
        for (const m of oldMsgs) {
          if (m.fts_text != null && m.fts_text !== '') delFts.run(m.id, m.fts_text);
        }
        db.prepare('DELETE FROM messages WHERE session_id=?').run(sessionId);
        insertMessages(db, sessionId, msgs, 0);
      }
    }

    db.prepare(
      `UPDATE sessions SET workspace_id=?, title=?, updated_at=?, message_count=?, raw_path=? WHERE id=?`
    ).run(workspaceId, parsed.title, parsed.updatedAt ?? now, parsed.messages.length, sourcePath, sessionId);

    touchWorkspace(db, workspaceId, parsed.updatedAt ?? parsed.createdAt);
    db.prepare(
      `INSERT INTO sync_state(source_path, agent, fingerprint, synced_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(source_path) DO UPDATE SET fingerprint=excluded.fingerprint, synced_at=excluded.synced_at, agent=excluded.agent`
    ).run(sourcePath, agent, fp, now);

    db.exec('COMMIT');
    return existing ? 'updated' : 'created';
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** 从 fromSeq 起插入消息并维护 FTS（增量与全量共用） */
function insertMessages(db, sessionId, msgs, startSeq) {
  const insMsg = db.prepare(
    `INSERT INTO messages(session_id, seq, role, created_at, content_text, content_raw, fts_text, model, effort, images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insFts = db.prepare(`INSERT INTO messages_fts(rowid, fts_text) VALUES (?, ?)`);
  let seq = startSeq;
  for (const m of msgs) {
    const ftsText = m.text ? ftsPrepare(m.text) : '';
    const r = insMsg.run(
      sessionId, seq++, m.role, m.createdAt ?? null, m.text ?? '',
      m.raw != null ? JSON.stringify(m.raw) : null,
      ftsText,
      m.model ?? null,
      m.effort ?? null,
      Array.isArray(m.images) && m.images.length ? JSON.stringify(m.images) : null
    );
    if (ftsText) insFts.run(Number(r.lastInsertRowid), ftsText);
  }
}

/** 校验已存前缀未被改写：取旧库首、尾、中三处锚点与新列表同位置比对 */
function checkPrefixUnchanged(db, sessionId, newMsgs, oldCount) {
  const anchors = [0, Math.floor(oldCount / 2), oldCount - 1];
  const sel = db.prepare('SELECT seq, role, created_at, content_text FROM messages WHERE session_id=? AND seq=?');
  for (const seq of anchors) {
    const old = sel.get(sessionId, seq);
    const nw = newMsgs[seq];
    if (!old || !nw) return false;
    // createdAt 允许空值差异；role 必须一致；正文比前 200 字符（避免整段大文本比较）
    if (old.role !== nw.role) return false;
    if ((old.created_at || '') !== (nw.createdAt || '')) return false;
    const oldT = old.content_text || '', newT = nw.text || '';
    // 长度不一致 = 正文被编辑/裁剪（如附件截断、消息改写），不能走增量，需全量重建
    if (oldT.length !== newT.length) return false;
    if (oldT.slice(0, 200) !== newT.slice(0, 200)) return false;
    // 尾部 100 字符比对：捕获首部相同但尾部被裁剪的编辑（如附件从全文改为截断版）
    if (oldT.slice(-100) !== newT.slice(-100)) return false;
  }
  return true;
}
