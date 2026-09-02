// 会话链：自动提取"继续对话"引用关系（基于调研结论的强模式）
// 调研依据（2026-09-02 实测 2 万条用户消息）：
//   chat-vault 指令 160 条（数字 100% 有效）、URL 链接 62 个、动词+数字+对话词 45 条
//   裸数字 2702 条 → 误报太高，不用于自动提取
// 可靠性：所有提取的数字必须存在于 sessions 表才建链（提取+存在性校验双保险）
import { log } from './log.js';

// ---- 强模式正则（顺序即优先级，互斥归一到第一个命中）----
// 1. URL 链接：#/session/N（host 不限 127.0.0.1/localhost，忽略 ?q=/?msg=/?simple= 参数，
//    容错 markdown 残渣 `](http://...` —— 只取路径段数字）
const RE_URL = /#\/session\/(\d+)/;
// 2. chat-vault 指令：chat-vault [读取/加载/...] [#]N（N 为 3~7 位会话 id）
const RE_CV = /chat[-_ ]?vault\s*[，,：:]?\s*(?:读取|加载|读|打开|参考|继续|接着)?\s*#?\s*(\d{3,7})/i;
// 3. 动词+数字+对话词：读取/加载/参考/继续/接着/完成 + [下/一下] + #N + [这个/那个] + 对话/会话/上下文
const RE_VERB = /(?:读取|加载|读|参考|继续|接着|完成|看看?|打开|基于|根据|结合)\s*(?:下|一下)?\s*#?\s*(\d{3,7})\s*(?:这个|那个)?\s*(?:对话|会话|上下文)/;

// 交接语义判定：消息里出现这些词 → 是"继续做 N 的工作"（continuation），
// 否则只是"参考/举例/讨论"（reference）。用于链传播时区分真实交接 vs 泛引用。
const CONTINUATION_HINTS = [
  '继续', '接着', '完成', '剩余', '未完成', '推进', '同步进度', '同步状态',
  '接着做', '继续推进', '继续完成', '完成剩余', '剩余工作', '未完成的任务',
  '接着完成', '继续做', '继续这个', '接着这个', '继续推进这个',
];

// 元讨论/举例特征：消息在"讨论 chat-vault 的用法"而非真实交接。
// 命中任一 → 降级为 reference（不参与跨 workspace 传播）
const META_HINTS = [
  '类似', '比如', '例如', '譬如', '举例', '我一般会', '我会发', '通常',
  '调研', '分析下', '分析一下', '方案', '设计', '用法', '工作流', '怎么用',
  '这个对话中给的是例子', '给的是例子',
];

// 与 getSessionUserTurns 一致的注入样板过滤（避免把系统注入当用户引用）
const NOISE = [
  '<%', '[Request interrupted%', 'The TodoWrite tool hasn%',
  'This session is being continued%', 'This is a system-generated%',
  'Called the % tool with%',
];

function isNoise(text) {
  for (const p of NOISE) if (text.startsWith(p)) return true;
  return false;
}

/** 判定一段文本是否表达"交接"语义（继续做目标会话的工作）。
 *  元讨论/举例（讨论 chat-vault 用法、贴示例）→ false（降级为 reference） */
export function isContinuation(text) {
  if (!text) return false;
  // 元讨论特征优先：讨论工具用法/举例 → 不是真实交接
  if (META_HINTS.some((h) => text.includes(h))) return false;
  return CONTINUATION_HINTS.some((h) => text.includes(h));
}

/** 从一段用户文本中提取被引用的会话 id，返回 [{id, kind}]。
 *  kind: 'continuation'（继续做该会话的工作）| 'reference'（参考/举例/讨论） */
export function extractTargets(text) {
  if (!text || isNoise(text)) return [];
  const out = new Map(); // id -> kind
  const add = (id, kind) => {
    // 已有更高优先级 kind 则保留（continuation > reference）
    if (!out.has(id) || (out.get(id) === 'reference' && kind === 'continuation')) out.set(id, kind);
  };
  const cont = isContinuation(text);
  const kind = cont ? 'continuation' : 'reference';
  // 先扫 URL 形态（强模式，不会误伤）
  const reUrl = new RegExp(RE_URL.source, 'g');
  let m;
  while ((m = reUrl.exec(text))) add(Number(m[1]), kind);
  if (out.size) return [...out].map(([id, k]) => ({ id, kind: k }));
  // 再扫 chat-vault 指令（含动词跟随）
  if (RE_CV.test(text)) {
    const m = RE_CV.exec(text);
    add(Number(m[1]), kind);
    // chat-vault 之后可能还跟"读取 N 对话"（数字在 chat-vault 关键词后隔了动词）
    const rest = text.slice(RE_CV.lastIndex);
    const m2 = RE_VERB.exec(rest);
    if (m2 && !out.has(Number(m2[1]))) add(Number(m2[1]), kind);
  }
  if (out.size) return [...out].map(([id, k]) => ({ id, kind: k }));
  // 最后扫动词短语
  if (RE_VERB.test(text)) {
    const m = RE_VERB.exec(text);
    add(Number(m[1]), kind);
  }
  return [...out].map(([id, k]) => ({ id, kind: k }));
}

/** 兼容旧调用：只返回 id 列表 */
export function extractTargetIds(text) {
  return extractTargets(text).map((t) => t.id);
}

/**
 * 扫描用户消息提取引用关系写入 session_links（幂等）。
 * 增量模式：只扫 updated_at > lastLinkScanAt 的会话（sync_state 里 __link_scan__ 记录游标），
 *           会话级时间戳覆盖"整文件重建消息行 id 变化"的场景（重建会刷新 updated_at）。
 * 全量模式：扫全部（首次建链/用户手动触发）。
 */
export function extractSessionLinks(db, { full = false } = {}) {
  const t0 = Date.now();
  const cursor = db.prepare("SELECT synced_at FROM sync_state WHERE source_path = '__link_scan__'").get();
  const lastScan = full ? null : cursor?.synced_at || null;

  // 先按 updated_at 索引取"本轮有变动的会话 id"子集（走 idx_sessions_updated），
  // 再查这些会话的用户消息——避免全表扫 messages JOIN sessions 再过滤
  const sessionIds = lastScan
    ? db.prepare('SELECT id FROM sessions WHERE updated_at > ? AND hidden = 0').all(lastScan).map((r) => r.id)
    : db.prepare('SELECT id FROM sessions WHERE hidden = 0').all().map((r) => r.id);

  let rows = [];
  if (sessionIds.length) {
    // 分批 IN 查询（SQLite 变量上限 999）
    const BATCH = 500;
    for (let i = 0; i < sessionIds.length; i += BATCH) {
      const chunk = sessionIds.slice(i, i + BATCH);
      const ph = chunk.map(() => '?').join(',');
      rows.push(...db.prepare(`
        SELECT session_id, seq, content_text FROM messages
        WHERE role = 'user' AND session_id IN (${ph})`).all(...chunk));
    }
  }

  if (!rows.length) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO sync_state(source_path, synced_at) VALUES ('__link_scan__', ?)
                ON CONFLICT(source_path) DO UPDATE SET synced_at=excluded.synced_at`).run(now);
    return { scanned: 0, linked: 0, skipped: 0 };
  }

  // 目标 id 存在性校验（双保险：只信有效会话）
  const idSet = new Set(db.prepare('SELECT id FROM sessions').all().map((r) => r.id));
  // ON CONFLICT 更新 kind：重提取时旧链接的 kind 可能已过时（如 reference→continuation）；
  // 但保留 manual 覆盖（用户手动指定的 kind 优先）
  const ins = db.prepare(`
    INSERT INTO session_links(from_session, to_session, from_seq, kind, source, created_at)
    VALUES (?, ?, ?, ?, 'auto', ?)
    ON CONFLICT(from_session, to_session) DO UPDATE SET
      from_seq = excluded.from_seq,
      kind = CASE WHEN session_links.source = 'manual' THEN session_links.kind ELSE excluded.kind END,
      source = CASE WHEN session_links.source = 'manual' THEN 'manual' ELSE 'auto' END`);

  const pending = []; // [{from, to, seq, kind}]
  let scanned = 0;
  for (const r of rows) {
    scanned++;
    const targets = extractTargets(r.content_text);
    for (const t of targets) {
      if (t.id === r.session_id) continue;        // 自引用跳过
      if (!idSet.has(t.id)) continue;             // 目标不存在 → 丢弃（防误链）
      pending.push({ from: r.session_id, to: t.id, seq: r.seq, kind: t.kind });
    }
  }

  if (pending.length) {
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const p of pending) ins.run(p.from, p.to, p.seq, p.kind, now);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.prepare(`INSERT INTO sync_state(source_path, synced_at) VALUES ('__link_scan__', ?)
              ON CONFLICT(source_path) DO UPDATE SET synced_at=excluded.synced_at`).run(new Date().toISOString());

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  log.info('links', `扫描 ${scanned} 条用户消息 → 建链 ${pending.length} 条（${dt}s）`);
  return { scanned, linked: pending.length, skipped: pending.length ? 0 : 0 };
}

/** 手动建链（UI 手动关联 / 纠错），返回 {ok} 或 {error} */
export function addManualLink(db, fromId, toId, note = null) {
  const from = db.prepare('SELECT id FROM sessions WHERE id = ?').get(fromId);
  const to = db.prepare('SELECT id FROM sessions WHERE id = ?').get(toId);
  if (!from) return { error: '来源会话不存在' };
  if (!to) return { error: '目标会话不存在' };
  if (fromId === toId) return { error: '不能关联自身' };
  db.prepare(`
    INSERT INTO session_links(from_session, to_session, kind, source, note, created_at)
    VALUES (?, ?, 'reference', 'manual', ?, ?)
    ON CONFLICT(from_session, to_session) DO UPDATE SET note=excluded.note, source='manual'`)
    .run(fromId, toId, note || null, new Date().toISOString());
  return { ok: true };
}

/** 手动删链 */
export function removeLink(db, fromId, toId) {
  const r = db.prepare(
    'DELETE FROM session_links WHERE from_session = ? AND to_session = ?'
  ).run(fromId, toId);
  if (!r.changes) return { error: '链接不存在' };
  return { ok: true };
}
