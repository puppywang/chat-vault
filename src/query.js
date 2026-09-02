// 查询层：会话列表 / 详情 / 搜索 / 工作区 / 统计，CLI 与 API 共用
import { ftsQuery } from './fts.js';
import { AGENTS } from './db.js';

const SESSION_COLS = `
  s.id, s.agent, s.title, s.created_at, s.updated_at, s.message_count, s.hidden,
  s.workspace_id, w.path AS workspace_path, w.name AS workspace_name`;

export function listSessions(db, { agent = null, workspaceIds = [], limit = 100, offset = 0, hiddenOnly = false } = {}) {
  const where = [hiddenOnly ? 's.hidden = 1' : 's.hidden = 0'];
  const params = [];
  if (agent) { where.push('s.agent = ?'); params.push(agent); }
  if (workspaceIds.length) {
    where.push(`s.workspace_id IN (${workspaceIds.map(() => '?').join(',')})`);
    params.push(...workspaceIds);
  }
  const sql = `
    SELECT ${SESSION_COLS} FROM sessions s
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(s.updated_at, s.created_at) DESC
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset);
}

/** 时间线作息图数据：
 *  - days：按天（会话数 / 消息数 / agent 分布 / 活跃小时集合 / 首末小时）
 *  - hours：按天×小时的消息分布（本地时区；UTC 存储，服务端与用户同时区故用 Date 转换）
 *  尊重 agent / workspace 过滤 */
export function timelineStats(db, { agent = null, workspaceIds = [] } = {}) {
  const where = ['s.hidden = 0'];
  const params = [];
  if (agent) { where.push('s.agent = ?'); params.push(agent); }
  if (workspaceIds.length) {
    where.push(`s.workspace_id IN (${workspaceIds.map(() => '?').join(',')})`);
    params.push(...workspaceIds);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 1) 天级：会话数 / 消息数 / agent 分布（天取会话更新时间）
  const byDay = new Map();
  for (const r of db.prepare(`
    SELECT substr(COALESCE(NULLIF(s.updated_at, ''), s.created_at), 1, 10) AS day,
           s.agent AS agent, COUNT(*) AS sessions, SUM(s.message_count) AS messages
    FROM sessions s ${whereSql} GROUP BY day, agent ORDER BY day`).all(...params)) {
    if (!r.day) continue;
    let d = byDay.get(r.day);
    if (!d) { d = { date: r.day, sessions: 0, messages: 0, byAgent: {} }; byDay.set(r.day, d); }
    d.sessions += r.sessions;
    d.messages += r.messages || 0;
    const a = d.byAgent[r.agent] || (d.byAgent[r.agent] = { sessions: 0, messages: 0 });
    a.sessions += r.sessions;
    a.messages += r.messages || 0;
  }

  // 2) 小时级：消息时间戳按本地时区归入 天×小时（作息图主数据）
  const hours = new Map(); // date -> Map(hour -> { total, byAgent: {a: n} })
  let maxHour = 0; // 全局单小时最大消息数（强度归一化）
  for (const r of db.prepare(`
    SELECT substr(m.created_at, 1, 10) AS day, substr(m.created_at, 12, 2) AS hr,
           s.agent AS agent, COUNT(*) AS c
    FROM messages m JOIN sessions s ON s.id = m.session_id ${whereSql}
    GROUP BY day, hr, agent`).all(...params)) {
    if (!r.day || !r.hr) continue;
    const t = new Date(`${r.day}T${r.hr}:00:00Z`); // UTC → 本地
    if (Number.isNaN(t)) continue;
    const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    const h = t.getHours();
    let hd = hours.get(date);
    if (!hd) { hd = new Map(); hours.set(date, hd); }
    let cell = hd.get(h);
    if (!cell) { cell = { total: 0, byAgent: {} }; hd.set(h, cell); }
    cell.total += r.c;
    cell.byAgent[r.agent] = (cell.byAgent[r.agent] || 0) + r.c;
    if (cell.total > maxHour) maxHour = cell.total;
  }

  // 3) 天级补充：首末小时 / 活跃小时数；小时数据缺的天（无消息时间戳）也能出现在 days 里
  for (const [date, hd] of hours) {
    if (!byDay.has(date)) byDay.set(date, { date, sessions: 0, messages: 0, byAgent: {} });
  }
  const days = [...byDay.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  const hoursObj = {};
  for (const d of days) {
    const hd = hours.get(d.date);
    if (hd) {
      const hs = [...hd.keys()];
      d.firstHour = Math.min(...hs);
      d.lastHour = Math.max(...hs);
      d.activeHours = hs.length;
      hoursObj[d.date] = Object.fromEntries([...hd].map(([h, v]) => [h, v]));
    }
  }
  return { days, hours: hoursObj, maxHour: maxHour || 1 };
}

export function getSessionDetail(db, id, { offset = 0, limit = 0 } = {}) {
  const session = db.prepare(
    `SELECT ${SESSION_COLS}, s.agent_session_id FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`
  ).get(id);
  if (!session) return null;
  // flag 来自独立表（稳定键 agent+agentSessionId+seq，重同步后标记不丢）
  const baseSql = `
    SELECT m.id, m.seq, m.role, m.created_at, m.content_text, m.model, m.effort, m.images,
           f.todo AS is_todo, f.star AS is_star
    FROM messages m
    LEFT JOIN message_flags f
      ON f.agent = ? AND f.agent_session_id = ? AND f.seq = m.seq
    WHERE m.session_id = ?`;
  const args = [session.agent, session.agent_session_id, id];
  // limit=0（默认）= 全量（AI 助手 read_session / 旧调用方兼容）；
  // 分页时按 seq 升序窗口取段
  const sql = limit > 0 ? `${baseSql} ORDER BY m.seq LIMIT ? OFFSET ?` : `${baseSql} ORDER BY m.seq`;
  const messages = (limit > 0 ? db.prepare(sql).all(...args, limit, offset) : db.prepare(sql).all(...args));
  for (const m of messages) {
    if (m.images) {
      try { m.images = JSON.parse(m.images); } catch { m.images = []; }
    } else m.images = [];
  }
  return { session, messages };
}

/** 会话消息骨架（无正文）：scrubber 刻度 / 会话内搜索定位 / 断点计算用。
 *  75 万行表上仅取索引列，最大会话也只传几 KB */
export function getSessionOutline(db, id) {
  return db.prepare(
    'SELECT seq, role, created_at FROM messages WHERE session_id = ? ORDER BY seq'
  ).all(id);
}

/** 用户发言清单（导航栏用）：仅真实用户输入 + 单行摘要，量小（大会话通常几十~几百条）。
 *  排除各类注入样板：尖括号内部标记（命令回显/系统提醒/IDE 事件/task-notification），
 *  以及无尖括号的续接摘要、TodoWrite 提醒、工具调用回显等 */
export function getSessionUserTurns(db, id) {
  return db.prepare(`
    SELECT seq, created_at, substr(replace(content_text, char(10), ' '), 1, 120) AS brief
    FROM messages
    WHERE session_id = ? AND role = 'user'
      AND content_text NOT LIKE '<%'
      AND content_text NOT LIKE '[Request interrupted%'
      AND content_text NOT LIKE 'The TodoWrite tool hasn%'
      AND content_text NOT LIKE 'This session is being continued%'
      AND content_text NOT LIKE 'This is a system-generated%'
      AND content_text NOT LIKE 'Called the % tool with%'
    ORDER BY seq`).all(id);
}

export function listWorkspaces(db) {
  return db.prepare(`
    SELECT w.id, w.path, w.name, w.last_active,
           COUNT(s.id) AS session_count,
           GROUP_CONCAT(DISTINCT s.agent) AS agents
    FROM workspaces w
    LEFT JOIN sessions s ON s.workspace_id = w.id AND s.hidden = 0
    GROUP BY w.id
    ORDER BY COALESCE(w.last_active, '') DESC`).all();
}

// ==================== 会话链查询 ====================
// 链 = session_links 上的弱连通分量。表很小（引用关系远少于消息），
// 全量加载到内存做 BFS / 并查集，比 SQL 递归快且简单。

const LINK_SESSION_COLS = `
  s.id, s.agent, s.title, s.created_at, s.updated_at, s.message_count, s.hidden,
  w.path AS workspace_path, w.name AS workspace_name`;

function allLinks(db) {
  return db.prepare(`
    SELECT l.from_session, l.to_session, l.from_seq, l.kind, l.source, l.note, l.created_at AS linked_at,
           f.workspace_id AS from_ws, t.workspace_id AS to_ws
    FROM session_links l
    JOIN sessions f ON f.id = l.from_session
    JOIN sessions t ON t.id = l.to_session
  `).all();
}

/** 某会话的直接引用关系（双向）：引用它的 + 它引用的 */
export function getSessionLinks(db, id) {
  const links = db.prepare(`
    SELECT l.from_session, l.to_session, l.kind, l.source, l.note, l.created_at AS linked_at
    FROM session_links l WHERE l.from_session = ? OR l.to_session = ?
  `).all(id, id);
  const ids = new Set();
  for (const l of links) { ids.add(l.from_session); ids.add(l.to_session); }
  const sessions = ids.size
    ? db.prepare(`
        SELECT ${LINK_SESSION_COLS} FROM sessions s
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id IN (${[...ids].map(() => '?').join(',')})`).all(...ids)
    : [];
  return { links, sessions };
}

/**
 * 链传播规则（2026-09-02 用户反馈修正）：
 *  - continuation 边（"继续完成 N 的工作"）：跨 workspace 也传播（真实交接，如 1629 promotion → 1627 rtsp）
 *  - reference 边（"参考/举例/讨论"）：仅同 workspace 传播（跨 workspace 的 reference 多为举例，如 其他讨论里贴 URL）
 *  - 手动关联（source='manual'）：不受限，始终传播（用户显式指定）
 * 传播方向：from → to（A 引用 B = A 延续/参考 B 的工作），不反向传播
 */
function linkPassable(l, fromWs, toWs) {
  if (l.source === 'manual') return true;
  if (l.kind === 'continuation') return true;
  // reference：仅同 workspace
  return fromWs === toWs;
}

/** 整条链（有向可达 + workspace 约束）：返回链上所有会话 + 链接 + 相邻关系 */
export function getChain(db, id) {
  const links = allLinks(db);
  const wsOf = new Map(); // session id -> workspace_id
  for (const l of links) {
    wsOf.set(l.from_session, l.from_ws);
    wsOf.set(l.to_session, l.to_ws);
  }
  const rootWs = wsOf.get(id);
  // 有向邻接表：from -> [{to, kind, source}]
  const out = new Map();
  for (const l of links) {
    if (!out.has(l.from_session)) out.set(l.from_session, []);
    out.get(l.from_session).push(l);
  }
  // BFS 沿 from→to 传播（只走可传播边）
  const members = new Set();
  const queue = [id];
  members.add(id);
  while (queue.length) {
    const cur = queue.pop();
    for (const l of out.get(cur) || []) {
      if (members.has(l.to_session)) continue;
      if (!linkPassable(l, wsOf.get(cur), wsOf.get(l.to_session))) continue;
      members.add(l.to_session);
      queue.push(l.to_session);
    }
  }
  const sessions = members.size
    ? db.prepare(`
        SELECT ${LINK_SESSION_COLS} FROM sessions s
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id IN (${[...members].map(() => '?').join(',')})
        ORDER BY COALESCE(s.updated_at, s.created_at) DESC`).all(...members)
    : [];
  const chainLinks = links.filter((l) => members.has(l.from_session) && members.has(l.to_session));
  // 与 id 直接相邻的（仅可传播边）
  const neighbors = [...(out.get(id) || [])].filter((l) => linkPassable(l, wsOf.get(id), wsOf.get(l.to_session))).map((l) => l.to_session);
  return {
    root: id,
    members: sessions,
    links: chainLinks,
    neighbor_ids: neighbors,
  };
}

/**
 * 消息级引用树：从当前会话出发，展示"哪条消息引用了哪个会话"的树状结构。
 *  - 节点 = 会话（含 agent/标题/时间）
 *  - 边 = 引用（含发起消息 seq、kind、source）
 *  - direction = downstream：只沿 from→to 方向展开（A 引用 B = A 的消息指向 B）
 *  - direction = upstream：  只沿 to←from 反向展开（哪些会话引用了我）
 *  - 深度限制防爆炸（默认 3 层）
 */
export function getSessionRefTree(db, id, { maxDepth = 3, direction = 'downstream' } = {}) {
  const links = allLinks(db);
  const wsOf = new Map();
  for (const l of links) {
    wsOf.set(l.from_session, l.from_ws);
    wsOf.set(l.to_session, l.to_ws);
  }
  const out = new Map(); // from -> [links]
  const inMap = new Map(); // to -> [links]
  for (const l of links) {
    if (!out.has(l.from_session)) out.set(l.from_session, []);
    out.get(l.from_session).push(l);
    if (!inMap.has(l.to_session)) inMap.set(l.to_session, []);
    inMap.get(l.to_session).push(l);
  }
  // 会话信息缓存
  const sessCache = new Map();
  const getSess = (sid) => {
    if (!sessCache.has(sid)) {
      sessCache.set(sid, db.prepare(`
        SELECT ${LINK_SESSION_COLS} FROM sessions s
        LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id = ?`).get(sid));
    }
    return sessCache.get(sid);
  };
  const isDown = direction !== 'upstream';
  // 递归构建树（防环：visited 集合）
  const build = (sid, depth, visited) => {
    const node = { session: getSess(sid), children: [] };
    if (depth >= maxDepth) return node;
    const next = new Set(visited);
    next.add(sid);
    if (isDown) {
      for (const l of out.get(sid) || []) {
        if (next.has(l.to_session)) continue; // 防环
        if (!linkPassable(l, wsOf.get(sid), wsOf.get(l.to_session))) continue;
        node.children.push({
          link: { to: l.to_session, seq: l.from_seq, kind: l.kind, source: l.source, note: l.note, from: l.from_session },
          node: build(l.to_session, depth + 1, next),
        });
      }
    } else {
      for (const l of inMap.get(sid) || []) {
        if (next.has(l.from_session)) continue; // 防环
        if (!linkPassable(l, wsOf.get(l.from_session), wsOf.get(sid))) continue;
        node.children.push({
          link: { to: l.from_session, seq: l.from_seq, kind: l.kind, source: l.source, note: l.note, from: l.from_session },
          node: build(l.from_session, depth + 1, next),
        });
      }
    }
    return node;
  };
  const root = build(id, 0, new Set());
  // 将核心结构平铺为易渲染的 outbound / inbound（便于 UI 与 MCP 复用）
  root.direction = direction;
  return root;
}

/** 所有链列表：有向传播聚合（每链取"最上游"根），按分量最近更新时间倒序 */
export function listChains(db, { limit = 100, agent = null } = {}) {
  const links = allLinks(db);
  const wsOf = new Map();
  for (const l of links) {
    wsOf.set(l.from_session, l.from_ws);
    wsOf.set(l.to_session, l.to_ws);
  }
  const out = new Map();
  for (const l of links) {
    if (!out.has(l.from_session)) out.set(l.from_session, []);
    out.get(l.from_session).push(l);
  }
  // 每个会话做一次有向 BFS 收集可达集；用"可达集相同"合并链（避免 O(n²) 全对比较）
  const reach = new Map(); // id -> Set(ids)
  const computeReach = (start) => {
    const seen = new Set();
    const q = [start];
    seen.add(start);
    while (q.length) {
      const cur = q.pop();
      for (const l of out.get(cur) || []) {
        if (seen.has(l.to_session)) continue;
        if (!linkPassable(l, wsOf.get(cur), wsOf.get(l.to_session))) continue;
        seen.add(l.to_session);
        q.push(l.to_session);
      }
    }
    return seen;
  };
  // 只对"入度为 0 的根"（不被任何可传播边指向）计算链，避免重复
  const inDeg = new Map();
  for (const l of links) {
    if (linkPassable(l, wsOf.get(l.from_session), wsOf.get(l.to_session))) {
      inDeg.set(l.to_session, (inDeg.get(l.to_session) || 0) + 1);
    }
  }
  const roots = new Set();
  for (const l of links) {
    if (linkPassable(l, wsOf.get(l.from_session), wsOf.get(l.to_session))) {
      if (!inDeg.has(l.from_session)) roots.add(l.from_session);
    }
  }
  const chains = [];
  for (const root of roots) {
    const members = computeReach(root);
    if (members.size < 2) continue;
    const placeholders = [...members].map(() => '?').join(',');
    let sess = db.prepare(`
      SELECT ${LINK_SESSION_COLS} FROM sessions s
      LEFT JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id IN (${placeholders})`).all(...members);
    if (agent) sess = sess.filter((s) => s.agent === agent);
    if (!sess.length) continue;
    const latest = sess.reduce((a, b) => (a.updated_at > b.updated_at ? a : b));
    chains.push({
      size: sess.length,
      latest_at: latest.updated_at,
      agents: [...new Set(sess.map((s) => s.agent))],
      sessions: sess.sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1)),
    });
  }
  return chains.sort((a, b) => (a.latest_at > b.latest_at ? -1 : 1)).slice(0, limit);
}

export function stats(db) {
  const byAgent = db.prepare(`
    SELECT agent, COUNT(*) AS sessions, SUM(message_count) AS messages,
           MIN(created_at) AS first_at, MAX(COALESCE(updated_at, created_at)) AS last_at
    FROM sessions WHERE hidden = 0 GROUP BY agent ORDER BY sessions DESC`).all();
  const totals = db.prepare(`
    SELECT COUNT(*) AS sessions, COALESCE(SUM(message_count),0) AS messages
    FROM sessions WHERE hidden = 0`).get();
  const workspaceCount = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
  return { totals: { ...totals, workspaces: workspaceCount }, byAgent };
}

/** "重试残骸"词表：会话的全部用户消息都命中（精确匹配）即视为重试脚本残留，
 *  如 429 自动重试脚本反复"新建会话→发请继续→又撞限流"产生的雷同空壳。 */
export const RETRY_SPAM = ['请继续', '好的，请继续', '好的,请继续', '继续', 'continue', 'go on'];

/** 找"重试残骸"会话（可见会话内）：有用户消息、且全部用户消息都∈词表。保守判定，
 *  只要有一条真实提问就保留——数据宁可留 noise 也不误伤。
 *  两个子查询都走部分索引（idx_messages_user_session / idx_messages_user_text，
 *  表达式须逐字一致），全表扫描 580ms → 4ms。 */
export function findRetryCorpses(db, { spam = RETRY_SPAM } = {}) {
  const lower = spam.map((x) => x.toLowerCase());
  return db.prepare(`
    SELECT s.id, s.agent, s.title, s.created_at, s.updated_at, s.message_count, u.total AS user_msgs
    FROM sessions s
    JOIN (SELECT session_id, COUNT(*) AS total FROM messages WHERE role = 'user' GROUP BY session_id)
      u ON u.session_id = s.id
    LEFT JOIN (
      SELECT session_id, COUNT(*) AS spam
      FROM messages
      WHERE role = 'user' AND LOWER(TRIM(content_text)) IN (${lower.map(() => '?').join(',')})
      GROUP BY session_id
    ) sp ON sp.session_id = s.id
    WHERE s.hidden = 0 AND u.total > 0 AND sp.spam = u.total
    ORDER BY s.agent, s.updated_at DESC`).all(...lower);
}

/**
 * 全文搜索：返回按会话聚合的命中结果，每条命中带高亮摘要。
 * 返回 [{session, hits: [{messageId, role, createdAt, snippet(含<mark>) }]}]
 */
/** 全文搜索：按会话聚合返回命中。
 *  sort: 'hit'=首次命中时间倒序（默认） | 'start'=会话开始时间 | 'end'=会话结束时间（最后活动）
 *  每会话返回精确 totalHits 与 firstHitAt/lastHitAt；摘要取该会话最早的 perSession 条命中。 */
export function searchMessages(db, { q, agent = null, workspaceIds = [], limit = 20, perSession = 3, sort = 'hit', since = null } = {}) {
  const match = ftsQuery(q);
  if (!match) return [];
  const where = ['s.hidden = 0'];
  const params = [];
  if (agent) { where.push('s.agent = ?'); params.push(agent); }
  if (workspaceIds.length) {
    where.push(`s.workspace_id IN (${workspaceIds.map(() => '?').join(',')})`);
    params.push(...workspaceIds);
  }
  // 只看某时间点之后仍活跃的会话（ISO 8601 字符串比较；MCP agent 圈定近期讨论用）
  if (since) { where.push(`COALESCE(s.updated_at, s.created_at) >= ?`); params.push(String(since)); }
  // FTS 命中先物化、由命中行驱动其余 JOIN。直接四表 JOIN 时计划器会走
  // sessions(agent 索引)->messages->逐条 FTS 探测（无 ANALYZE 全靠瞎猜），
  // 消息多的 agent 会把全部消息各探测一遍 FTS（实测 8k 消息 55s 撞超时）。
  const hitCte = 'WITH hit(rowid) AS MATERIALIZED (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)';

  // 1) 精确聚合（不取正文）：每会话命中数 + 首/末命中消息时间
  const agg = db.prepare(`
    ${hitCte}
    SELECT m.session_id, COUNT(*) AS total, MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at
    FROM hit h
    JOIN messages m ON m.id = h.rowid
    JOIN sessions s ON s.id = m.session_id
    WHERE ${where.join(' AND ')}
    GROUP BY m.session_id`).all(match, ...params);
  if (!agg.length) return [];

  // 2) 会话行 + 按所选键倒序
  const sessionStmt = db.prepare(
    `SELECT ${SESSION_COLS} FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?`);
  const sortKey = (it) => sort === 'start' ? (it.session.created_at || '')
    : sort === 'end' ? (it.session.updated_at || it.session.created_at || '')
    : (it.firstHitAt || '');
  const items = agg
    .map((a) => {
      const session = sessionStmt.get(a.session_id);
      return session && { session, totalHits: a.total, firstHitAt: a.first_at, lastHitAt: a.last_at };
    })
    .filter(Boolean)
    .sort((x, y) => sortKey(y).localeCompare(sortKey(x)))
    .slice(0, limit);

  // 3) 摘要行：窗口函数一次取每会话最早的 perSession 条命中。
  // 旧实现"全局 LIMIT 2000 + 命中不足的会话逐个补查"在热词上是 N+1：
  // 每个补查都重跑一次全量 FTS 扫描（实测单次 ~35s，838 会话即小时级超时）。
  // 窗口排序只带轻量列（id/session/created_at）——若把 content_text 大正文拖进
  // 排序器，热词（1.4 万命中）会溢出排序缓存跌到 3.3s；rn 定稿后再回表取正文。
  const rawRows = db.prepare(`
    ${hitCte}
    SELECT t.message_id, m.seq, t.session_id, m.role, m.created_at, m.content_text FROM (
      SELECT m.id AS message_id, m.session_id, m.created_at,
             ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY COALESCE(m.created_at, '')) AS rn
      FROM hit h
      JOIN messages m ON m.id = h.rowid
      JOIN sessions s ON s.id = m.session_id
      WHERE ${where.join(' AND ')}
    ) t
    JOIN messages m ON m.id = t.message_id
    WHERE t.rn <= ?
  `).all(match, ...params, perSession);
  const bySession = new Map();
  for (const r of rawRows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id).push(r);
  }

  const terms = q.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const it of items) {
    const rows = bySession.get(it.session.id) || [];
    out.push({
      session: it.session,
      hits: (rows || []).slice(0, perSession).map((r) => ({
        messageId: r.message_id,
        seq: r.seq,
        role: r.role,
        createdAt: r.created_at,
        snippet: makeSnippet(r.content_text, terms, 240),
      })),
      totalHits: it.totalHits,
      firstHitAt: it.firstHitAt,
      lastHitAt: it.lastHitAt,
    });
  }
  return out;
}

/** 生成含 <mark> 高亮的上下文摘要（其余文本已 HTML 转义，可安全 innerHTML） */
export function makeSnippet(text, terms, maxLen = 240) {
  if (!text) return '';
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  let start = pos > 60 ? pos - 60 : 0;
  let snippet = escHtml(text.slice(start, start + maxLen));
  if (start > 0) snippet = '…' + snippet;
  if (start + maxLen < text.length) snippet += '…';
  // 高亮所有出现的检索词（最长优先，避免重复嵌套 mark；terms 已转义后原文仍在）
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => escHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  return snippet.replace(re, '<mark>$1</mark>');
}

/** 从文本提取 {"todos":[...]} 对象（括号平衡扫描，正确跳过字符串内的括号） */
function extractTodos(text) {
  const out = [];
  for (let i = text.indexOf('{"todos"'); i >= 0; i = text.indexOf('{"todos"', i + 1)) {
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) break; }
    }
    if (depth !== 0) continue;
    try {
      const o = JSON.parse(text.slice(i, j + 1));
      if (Array.isArray(o.todos)) out.push(...o.todos.filter((t) => t?.content));
    } catch { /* 半截 JSON 跳过 */ }
  }
  return out;
}

/** 扫描工具消息中的 todo/任务清单状态（各 agent 的 todo_list/TodoWrite 工具落盘于此）。
 *  返回 [{session_id, agent, title, workspace_path, updated_at, tasks:[{content,status}]}] */
export function findTaskStates(db, { status = null, agent = null, limit = 30 } = {}) {
  // 走 FTS 倒排索引而非 LIKE 全表扫（61 万条 tool 消息上 3.2s → 27ms）。
  // unicode61 分词：下划线是分隔符（todo_list → "todo list" 短语）、大小写折叠（TodoWrite → todowrite）。
  // FTS 为超集匹配，多出的行由 extractTodos 的 JSON 解析自然过滤，结果与旧实现一致。
  const extra = agent ? ' AND s.agent = ?' : '';
  const rows = db.prepare(`
    SELECT m.session_id, s.agent, s.title, w.path AS workspace_path, s.updated_at, m.content_text
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    JOIN sessions s ON s.id = m.session_id
    LEFT JOIN workspaces w ON s.workspace_id = w.id
    WHERE messages_fts MATCH '"todos" OR "todo list" OR todowrite'
      AND m.role = 'tool' AND s.hidden = 0${extra}
    ORDER BY s.updated_at DESC
    LIMIT 2000`).all(...(agent ? [agent] : []));
  // 每会话取最新一条任务清单快照
  const bySession = new Map();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, r); // rows 按 updated_at 降序
  }
  const want = status ? (Array.isArray(status) ? status : [status]) : ['pending', 'in_progress'];
  const out = [];
  for (const r of bySession.values()) {
    const tasks = extractTodos(r.content_text);
    const filtered = tasks.filter((t) => want.includes(String(t.status || '').toLowerCase().replace(/-/g, '_')));
    if (filtered.length) {
      out.push({
        session_id: r.session_id, agent: r.agent, title: r.title,
        workspace_path: r.workspace_path, updated_at: r.updated_at,
        tasks: filtered.slice(0, 30).map((t) => ({ content: String(t.content).slice(0, 200), status: t.status })),
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** 用户标记的消息（🚩 todo / ⭐ star）：跨 agent 流转的显式交接点。
 *  标记存于 message_flags（稳定键 agent+agent_session_id+seq），此处 JOIN 回会话与正文预览。 */
export function listFlagged(db, { flag = 'todo', limit = 500 } = {}) {
  if (!['todo', 'star'].includes(flag)) throw new Error('flag 参数无效');
  return db.prepare(`
    SELECT s.id AS session_id, m.seq, m.role, m.created_at, f.todo, f.star,
           f.created_at AS flagged_at, s.agent, s.title,
           w.path AS workspace_path, s.updated_at,
           substr(m.content_text, 1, 300) AS preview
    FROM message_flags f
    JOIN messages m ON m.session_id = (
      SELECT id FROM sessions WHERE agent = f.agent AND agent_session_id = f.agent_session_id
    ) AND m.seq = f.seq
    JOIN sessions s ON s.agent = f.agent AND s.agent_session_id = f.agent_session_id
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    WHERE ${flag === 'todo' ? 'f.todo' : 'f.star'} = 1 AND s.hidden = 0
    ORDER BY s.updated_at DESC
    LIMIT ?`).all(limit);
}

export { AGENTS };
