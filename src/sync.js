// 同步引擎：发现源文件 -> 指纹比对 -> adapter 解析 -> 幂等入库
import fs from 'node:fs';
import { openDb, upsertSession } from './db.js';
import { RETRY_LATER } from './util.js';
import { log } from './log.js';
import { readConfig } from './config.js';
import { findRetryCorpses } from './query.js';
import { claudeAdapter } from './adapters/claude.js';
import { codexAdapter } from './adapters/codex.js';
import { copilotAdapter } from './adapters/copilot.js';
import { zcodeAdapter } from './adapters/zcode.js';
import { cursorAdapter } from './adapters/cursor.js';
import { antigravityAdapter } from './adapters/antigravity.js';
import { windsurfAdapter } from './adapters/windsurf.js';
import { windsurfNextAdapter } from './adapters/windsurf-next.js';
import { kiroAdapter } from './adapters/kiro.js';
import { iflowAdapter } from './adapters/iflow.js';
import { factoryAdapter } from './adapters/factory.js';
import { copilotChatOpenAdapter } from './adapters/copilot-chat-open.js';
import { qoderAdapter } from './adapters/qoder.js';
import { deepseekAdapter } from './adapters/deepseek.js';
import { workbuddyAdapter } from './adapters/workbuddy.js';
import { piAdapter } from './adapters/pi.js';
import { chatgptAdapter } from './adapters/chatgpt.js';
import { codexCloudAdapter } from './adapters/codex-cloud.js';
import { opencodeAdapter } from './adapters/opencode.js';

export const adapters = [
  claudeAdapter, codexAdapter, copilotAdapter, zcodeAdapter, cursorAdapter, antigravityAdapter,
  windsurfAdapter, windsurfNextAdapter, kiroAdapter, iflowAdapter, factoryAdapter, copilotChatOpenAdapter,
  qoderAdapter, deepseekAdapter,
  workbuddyAdapter, piAdapter, chatgptAdapter, codexCloudAdapter, opencodeAdapter,
];

/** 设置页 disabledAgents 生效后的同步范围（显式 --agent 指定不受限） */
export function enabledAdapters(cfg = readConfig()) {
  const dis = new Set(cfg.disabledAgents || []);
  return dis.size ? adapters.filter((a) => !dis.has(a.id)) : adapters;
}

export async function runSync(db, { agents = null, full = false, onProgress = null } = {}) {
  const selected = agents ? adapters.filter((a) => agents.includes(a.id)) : enabledAdapters();
  const summary = { created: 0, updated: 0, skipped: 0, empty: 0, failed: 0, failures: [] };

  for (const adapter of selected) {
    const t0 = Date.now();
    const before = { ...summary };
    let files = [];
    try {
      files = adapter.discover();
    } catch (err) {
      summary.failed++;
      summary.failures.push(`${adapter.id}: discover 失败 ${err.message}`);
      log.error('sync', `${adapter.id} discover 失败`, err);
      continue;
    }

    const getFp = db.prepare('SELECT fingerprint FROM sync_state WHERE source_path = ?');
    const touched = new Set(); // 本轮有变动的会话 id（afterSync 钩子用）
    for (const file of files) {
      const fp = adapter.fingerprint(file);
      if (!full) {
        const prev = getFp.get(file.path);
        if (prev && prev.fingerprint === fp) {
          summary.skipped++;
          continue;
        }
      }
      try {
        const parsed = await adapter.parseFile(file.path);
        if (parsed === RETRY_LATER) {
          // 本轮取不到数据（如 antigravity daemon 离线）：不记录指纹，下轮重试
          summary.skipped++;
          continue;
        }
        // 单会话对象或多会话数组（如 zcode 的整库文件）
        let list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        // adapter 自定义过滤（如 copilot-chat-open 按 sessionId 与主源去重）
        if (adapter.filterSessions && list.length) {
          list = adapter.filterSessions(db, list);
        }
        if (!list.length) {
          summary.empty++;
        } else {
          for (const p of list) {
            const r = upsertSession(db, adapter.id, file.path, fp, p);
            summary[r === 'created' ? 'created' : 'updated']++;
            touched.add(p.agentSessionId);
          }
          // 数据源自述产出集后清理孤儿行（如 windsurf 去重后老格式的重复行）
          if (adapter.afterFile) {
            const removed = adapter.afterFile(db, list.map((p) => p.agentSessionId));
            if (removed > 0) log.info('sync', `${adapter.id}: 清理 ${removed} 条源中已不存在的会话`);
          }
        }
        onProgress?.(adapter.id, file.path, list.length);
        // 空结果也记录指纹，避免反复重读
        db.prepare(
          `INSERT INTO sync_state(source_path, agent, fingerprint, synced_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(source_path) DO UPDATE SET fingerprint=excluded.fingerprint, synced_at=excluded.synced_at, agent=excluded.agent`
        ).run(file.path, adapter.id, fp, new Date().toISOString());
      } catch (err) {
        summary.failed++;
        summary.failures.push(`${adapter.id}: ${file.path} -> ${err.message}`);
        log.error('sync', `${adapter.id} ${file.path} 解析失败`, err);
      }
    }
    // afterSync 钩子：数据源自带的后处理（如 kiro Chat API 日志回填）
    if (adapter.afterSync) {
      try {
        const extra = await adapter.afterSync(db, { touched });
        if (extra) {
          summary.created += extra.created || 0;
          summary.updated += extra.updated || 0;
        }
      } catch (err) {
        summary.failed++;
        summary.failures.push(`${adapter.id}: afterSync 失败 ${err.message}`);
        log.error('sync', `${adapter.id} afterSync 失败`, err);
      }
    }
    const d = summary.created - before.created, u = summary.updated - before.updated;
    if (d || u || summary.failed > before.failed) {
      log.info('sync', `${adapter.id}: +${d} 新建 / ${u} 更新 / ${files.length} 文件，${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      log.debug('sync', `${adapter.id}: 无变化（${files.length} 文件，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    }
  }

  // 自动清理"重试残骸"会话（全部用户消息都是"请继续"类重试词，如 429 自动重试脚本
  // 反复新建会话的空壳）。仅在本轮有新数据时跑（残骸只会随新会话出现）；默认关闭，设置页可开启。
  if (summary.created + summary.updated > 0 && readConfig().autoHideRetryCorpses) {
    try {
      const corpses = findRetryCorpses(db);
      const upd = db.prepare('UPDATE sessions SET hidden = 1 WHERE id = ?');
      for (const c of corpses) upd.run(c.id);
      if (corpses.length) log.info('sync', `autoHideRetryCorpses: 已隐藏 ${corpses.length} 个重试残骸会话`);
      summary.autoHidden = corpses.length;
    } catch (err) {
      log.error('sync', 'autoHideRetryCorpses 失败', err);
    }
  }

  // 会话链自动提取：本轮有数据变化时增量扫描用户消息中的引用（chat-vault 指令 / URL / 动词短语）
  if (summary.created + summary.updated > 0) {
    try {
      const { extractSessionLinks } = await import('./links.js');
      const linkSummary = extractSessionLinks(db, { full });
      summary.links = linkSummary;
    } catch (err) {
      log.error('sync', '会话链提取失败', err);
    }
  }
  return summary;
}

/**
 * 只同步一个会话的源文件（sync-on-read）。
 *
 * runSync 会遍历某个 agent 的全部文件；notes 的 thread_hint 与写入只需要把
 * 当前 thread 拉到最新。实测 watcher 的扫描延迟在 0~45 秒之间波动，而 codex
 * 每条 AddItems 就 flush 到 rollout（recorder.rs 的 flush_if_materialized），
 * 所以数据早已落盘、延迟全在索引侧——读时补一次窄同步即可消掉，代价只是从
 * 上次 offset 读一段文件尾。
 *
 * 未入库的 thread 返回 null（拿不到 raw_path 就无从下手），调用方据此退化成
 * 不带 seq 锚点的模式。
 */
export async function syncThread(db, agentId, agentSessionId) {
  if (!agentSessionId) return null;
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) throw new Error(`未知 agent: ${agentId}`);

  const row = db.prepare(
    'SELECT raw_path, message_count FROM sessions WHERE agent = ? AND agent_session_id = ?'
  ).get(agentId, agentSessionId);
  if (!row?.raw_path) return null;

  let rawPath = row.raw_path;
  let st;
  try {
    st = fs.statSync(rawPath);
  } catch {
    // 同一源文件换了物理形态（如 Codex 把冷 rollout 压成 .jsonl.zst，恢复会话时又还原）
    const alt = adapter.siblingPath?.(rawPath);
    try {
      if (!alt) throw new Error('no sibling');
      st = fs.statSync(alt);
      rawPath = alt;
    } catch {
      return null; // 源文件已归档/移走，留给全量同步处理
    }
  }
  const fp = adapter.fingerprint({ path: rawPath, size: st.size, mtimeMs: st.mtimeMs });
  const before = Number(row.message_count) || 0;
  const prev = db.prepare('SELECT fingerprint FROM sync_state WHERE source_path = ?').get(rawPath);
  if (prev && prev.fingerprint === fp) return { changed: false, message_count: before };

  const parsed = await adapter.parseFile(rawPath);
  if (parsed === RETRY_LATER || !parsed) return { changed: false, message_count: before };
  // 该文件可能承载多个会话（如 zcode 的整库文件）：全部 upsert，否则指纹一写
  // 就把同文件里其他会话的更新永久跳过了。
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const p of list) {
    if (p?.agentSessionId) upsertSession(db, agentId, rawPath, fp, p);
  }
  db.prepare(
    `INSERT INTO sync_state(source_path, agent, fingerprint, synced_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET fingerprint=excluded.fingerprint, synced_at=excluded.synced_at, agent=excluded.agent`
  ).run(rawPath, agentId, fp, new Date().toISOString());

  const after = db.prepare(
    'SELECT message_count FROM sessions WHERE agent = ? AND agent_session_id = ?'
  ).get(agentId, agentSessionId);
  const count = Number(after?.message_count) || before;
  log.debug('sync', `syncThread ${agentId}/${agentSessionId}: ${before} -> ${count} 条`);
  return { changed: count !== before, message_count: count, added: count - before };
}
