// ChatGPT 网页 Pro 用量的本地估算：给 chatgpt-sync 弹窗「账号额度」卡片用。
//
// 服务端不返回已用次数：conversation/init 平时 Pro 字段全空，只有用完后才给 limit（Pro Lite 为 50）和 resets_after。
// 计次口径（2026-10-15 核对）：按用户发出的消息计，一条消息让模型连续调用上千次工具也只算一次。
// 周期规则没法从数据里定下来（恢复时刻往前 7 天没有对应的已归档消息），这里按最保守的滚动 7 天统计；
// 受限时客户端会传来 resetsAfter，另外给出「恢复时刻往前 7 天」窗口里的计数，方便对照。
// 2026-10-20 更正：受限恢复后额度是清零的——10-15 用满 50 次、受限到 10-17，恢复后只发了 4 条，滚动 7 天却把
// 恢复前的 7 条也算进去报 11 次。resetsAfter 只在受限期间出现，恢复后就看不到了，所以记在
// ~/.chat-vault/chatgpt-pro-reset.json；恢复时刻已过且在 7 天内时，从恢复时刻起计。
// 数据源是扩展归档的对话（~/.chat-vault/imports/chatgpt/live），没在这个浏览器打开过的对话、手机端发的消息都不在里面。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WEEK_SEC = 7 * 86400;
const PRO_MODEL = /(^|-)pro$/i;          // gpt-6-pro、gpt-5-6-pro；不匹配 prolite 之类的套餐名

/** 一段对话里每条可见用户消息的时刻和回答它的模型（这条消息之后第一个带 model_slug 的非用户消息）。 */
export function userTurns(conv) {
  const mapping = conv?.mapping || {};
  const out = [];
  for (const node of Object.values(mapping)) {
    const m = node?.message;
    if (!m || m.author?.role !== 'user' || !Number.isFinite(m.create_time) || m.metadata?.is_visually_hidden_from_conversation) continue;
    let model = null;
    const queue = [...(node.children || [])];
    for (let guard = 0; queue.length && !model && guard < 400; guard++) {
      const child = mapping[queue.shift()];
      if (!child || child.message?.author?.role === 'user') continue;
      model = child.message?.metadata?.model_slug || null;
      queue.push(...(child.children || []));
    }
    out.push({ at: m.create_time, model });
  }
  return out;
}

export function createProUsage({ homeDir = os.homedir(), fsImpl = fs,
  liveDir = path.join(homeDir, '.chat-vault', 'imports', 'chatgpt', 'live'),
  resetFile = path.join(homeDir, '.chat-vault', 'chatgpt-pro-reset.json') } = {}) {
  const cache = new Map();   // file -> { key, entry }

  /** 最近一次看到的受限恢复时刻：{ resetsAfter, seenAt, source }（source: observed 实测 / inferred 推定） */
  function readReset() {
    try { const v = JSON.parse(fsImpl.readFileSync(resetFile, 'utf8')); return typeof v?.resetsAfter === 'string' ? v : null; }
    catch { return null; }
  }
  function rememberReset(resetsAfter, nowMs) {
    if (!Number.isFinite(Date.parse(resetsAfter)) || readReset()?.resetsAfter === resetsAfter) return;
    try {
      fsImpl.mkdirSync(path.dirname(resetFile), { recursive: true });
      fsImpl.writeFileSync(resetFile, JSON.stringify({ resetsAfter, seenAt: new Date(nowMs).toISOString(), source: 'observed' }, null, 2));
    } catch { /* 记不下来就按滚动 7 天 */ }
  }

  function scan() {
    let names = [];
    try { names = fsImpl.readdirSync(liveDir).filter(n => n.endsWith('.json')); } catch { return []; }
    const alive = new Set(), entries = [];
    for (const name of names) {
      const file = path.join(liveDir, name);
      alive.add(file);
      let stat; try { stat = fsImpl.statSync(file); } catch { continue; }
      const key = `${stat.mtimeMs}:${stat.size}`;
      let hit = cache.get(file);
      if (!hit || hit.key !== key) {
        let entry = null;
        try {
          const conv = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
          entry = { conversationId: conv?.conversation_id || conv?.id || name.replace(/\.json$/, ''), turns: userTurns(conv) };
        } catch { /* 写到一半：下次再读 */ }
        hit = { key, entry };
        cache.set(file, hit);
      }
      if (hit.entry) entries.push(hit.entry);
    }
    for (const file of cache.keys()) if (!alive.has(file)) cache.delete(file);
    return entries;
  }

  /** nowMs 可注入；resetsAfter 为服务端受限时给的恢复时刻（ISO），有则另算「恢复前 7 天」窗口。 */
  function estimate({ nowMs = Date.now(), resetsAfter = null } = {}) {
    const now = nowMs / 1000;
    if (resetsAfter) rememberReset(resetsAfter, nowMs);
    // 恢复时刻已过且在 7 天内：额度从那一刻清零重计；否则（没记录、太久以前、或仍在受限中）按滚动 7 天
    const reset = readReset();
    const resetSecStored = reset ? Date.parse(reset.resetsAfter) / 1000 : NaN;
    const sinceReset = Number.isFinite(resetSecStored) && resetSecStored <= now && resetSecStored > now - WEEK_SEC;
    const windowStart = sinceReset ? resetSecStored : now - WEEK_SEC;
    const pro = [];
    for (const e of scan()) for (const t of e.turns) if (t.model && PRO_MODEL.test(t.model)) pro.push({ at: t.at, conversationId: e.conversationId });
    pro.sort((a, b) => a.at - b.at);
    const inWindow = pro.filter(t => t.at > windowStart && t.at <= now);
    const byDay = {};
    for (const t of inWindow) {
      const day = new Date((t.at + 8 * 3600) * 1000).toISOString().slice(5, 10);   // 北京日期
      byDay[day] = (byDay[day] || 0) + 1;
    }
    const resetSec = resetsAfter ? Date.parse(resetsAfter) / 1000 : NaN;
    return {
      windowDays: 7,
      windowStart: new Date(windowStart * 1000).toISOString(),
      // 从上次受限恢复时刻起计时给出来源：observed 是受限期间接口给的，inferred 是事后推定的
      sinceReset: sinceReset ? { at: reset.resetsAfter, source: reset.source || 'observed' } : null,
      count: inWindow.length,
      oldestAt: inWindow[0] ? new Date(inWindow[0].at * 1000).toISOString() : null,
      // 从恢复时刻起计时不存在「滚出窗口」
      nextFreeAt: !sinceReset && inWindow[0] ? new Date((inWindow[0].at + WEEK_SEC) * 1000).toISOString() : null,
      conversations: new Set(inWindow.map(t => t.conversationId)).size,
      byDay,
      resetWindowCount: Number.isFinite(resetSec) ? pro.filter(t => t.at > resetSec - WEEK_SEC && t.at <= now).length : null,
      archivedSince: pro[0] ? new Date(pro[0].at * 1000).toISOString() : null,
    };
  }

  return { estimate, _scan: scan };
}
