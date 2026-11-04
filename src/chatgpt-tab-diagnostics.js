// 浏览器扩展上报的轻量标签页探针。MCP 查询只读这个快照，不触碰 ChatGPT 页面。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIAGNOSTICS_FILE = path.join(os.homedir(), '.chat-vault', 'chatgpt-tab-diagnostics.json');
const STALE_AFTER_MS = 90_000; // 扩展每 30 秒采样；三轮未上报才判为过期

function conversationId(url) {
  try {
    const u = new URL(url);
    if (!['chatgpt.com', 'chat.openai.com'].includes(u.hostname)) return null;
    return /^\/c\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(u.pathname)?.[1]?.toLowerCase() || null;
  } catch { return null; }
}

function isChatGPTUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(u.hostname);
  } catch { return false; }
}

function readRaw(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try { return JSON.parse(text); }
  catch {
    // 非正常关机后 NTFS 会把正在写的文件填成全 0（2026-10-11 重启后 31983 字节全是 NUL），
    // 若在此抛错，之后每次写入都在读旧文件时失败，诊断就永久停摆。坏文件挪开，按没有快照处理。
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 挪不动也不阻塞写入 */ }
    return null;
  }
}

export function writeTabDiagnostics(input, file = DIAGNOSTICS_FILE) {
  if (!input || !Array.isArray(input.tabs)) throw new Error('缺少 tabs 数组');
  const previous = readRaw(file);
  const priorTabs = new Map((previous?.tabs || []).map((tab) => [tab.tab_id, tab]));
  const receivedAt = new Date().toISOString();
  const tabs = input.tabs.map((tab) => {
    if (!Number.isInteger(tab.tab_id) || !isChatGPTUrl(tab.url)) {
      throw new Error('无效的 ChatGPT 标签页');
    }
    if (!['responsive', 'timeout', 'unavailable'].includes(tab.probe_status)) throw new Error('无效的 probe_status');
    const previousTab = priorTabs.get(tab.tab_id);
    const id = conversationId(tab.url) || /^\/dots\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(new URL(tab.url).pathname)?.[1]?.toLowerCase() || null;
    // Chrome 重启后 tab_id 可重复使用，不能把另一个对话的旧探针拼进来。
    const prior = previousTab && previousTab.conversation_id === id && (id || previousTab.url === tab.url)
      ? previousTab : null;
    return {
      tab_id: tab.tab_id,
      window_id: tab.window_id,
      title: tab.title || '',
      url: tab.url,
      conversation_id: id,
      dots_id: /^\/dots\/([0-9a-fA-F-]{36})(?:\/|$)/.exec(new URL(tab.url).pathname)?.[1]?.toLowerCase() || null,
      active: tab.active === true,
      discarded: tab.discarded === true,
      tab_status: tab.tab_status || null,
      probe_status: tab.probe_status,
      probe_duration_ms: Number.isFinite(tab.probe_duration_ms) ? tab.probe_duration_ms : null,
      probe_error: tab.probe_error || null,
      page: tab.probe_status === 'responsive' ? tab.page || null : null,
      consecutive_probe_failures: tab.probe_status === 'responsive' ? 0 : (prior?.consecutive_probe_failures || 0) + 1,
      last_responsive_at: tab.probe_status === 'responsive' ? receivedAt : prior?.last_responsive_at || null,
      last_responsive_page: tab.probe_status === 'responsive' ? tab.page || null : prior?.last_responsive_page || null,
    };
  });
  const snapshot = { version: 1, extension_version: input.extension_version || null,
    sampled_at: input.sampled_at || null, received_at: receivedAt, tabs };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(snapshot));
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
  return { received_at: receivedAt, tab_count: tabs.length };
}

export function readTabDiagnostics({ conversationId: id = null, tabId = null, file = DIAGNOSTICS_FILE } = {}) {
  const snapshot = readRaw(file);
  if (!snapshot) return {
    status: 'no_snapshot',
    hint: '尚未收到扩展探针。确认主 Chrome profile 已加载并重新载入 ChatVault 扩展，ChatVault serve 正在运行。',
    tabs: [],
  };
  const ageMs = Math.max(0, Date.now() - Date.parse(snapshot.received_at));
  const stale = !Number.isFinite(ageMs) || ageMs > STALE_AFTER_MS;
  const tabs = snapshot.tabs.filter((tab) =>
    (id == null || tab.conversation_id === String(id).toLowerCase() || tab.dots_id === String(id).toLowerCase()) &&
    (tabId == null || tab.tab_id === Number(tabId)));
  return {
    status: stale ? 'stale' : 'current',
    extension_version: snapshot.extension_version || null,
    sampled_at: snapshot.sampled_at,
    received_at: snapshot.received_at,
    age_ms: ageMs,
    stale_after_ms: STALE_AFTER_MS,
    total_chatgpt_tabs: snapshot.tabs.length,
    matched_tabs: tabs.length,
    tabs,
    ...(stale ? { hint: '探针快照已过期，不能据此判断当前标签页状态。检查扩展后台和 ChatVault 服务。' }
      : tabs.length === 0 ? { hint: '扩展所在 Chrome profile 没有匹配的 ChatGPT 标签页；检查对话是否打开，或确认 session_id/UUID。' } : {}),
  };
}
