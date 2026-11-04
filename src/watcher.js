// 文件事件驱动的同步触发器（类 inotify 方案）
//
// fs.watch 递归监听各 agent 数据根目录，仅关心 .jsonl 变化；
// 事件去抖（debounce，事件安静 N 秒才算一轮）+ 冷却（cooldown，两次同步最小间隔），
// 同步执行期间的新事件合并到下一轮。事件只是触发器，同步本身仍是全量指纹比对，不漏数据。
import fs from 'node:fs';
import path from 'node:path';

export function startWatcher({
  roots,
  debounceMs = 5000,
  cooldownMs = 60000,
  retryMs = 60000,
  onSync,
  log = console.log,
}) {
  const watchers = new Set();
  const timers = { debounce: null, cooldown: null };
  let syncing = false;
  let dirty = false; // 有未消费的变更事件
  let lastSyncAt = 0;
  let stopped = false;

  const fire = async () => {
    if (stopped) return;
    if (syncing) { dirty = true; return; } // 正在同步：事件留给下一轮
    dirty = false;
    syncing = true;
    try {
      await onSync();
    } finally {
      syncing = false;
      lastSyncAt = Date.now();
    }
    if (!stopped && dirty) scheduleCooldownCheck();
  };

  // 冷却检查：距上次同步不足 cooldown 则延后到期再跑
  const scheduleCooldownCheck = () => {
    if (stopped) return;
    const wait = Math.max(lastSyncAt + cooldownMs - Date.now() + 100, 0);
    clearTimeout(timers.cooldown);
    timers.cooldown = setTimeout(fire, wait);
  };

  const touch = () => {
    if (stopped) return;
    dirty = true;
    clearTimeout(timers.debounce);
    // 去抖：事件安静 debounceMs 后，再经冷却检查触发同步
    timers.debounce = setTimeout(scheduleCooldownCheck, debounceMs);
  };

  const handleEvent = (filename) => {
    const name = String(filename ?? '');
    // 关心的数据文件：jsonl 会话 / sqlite 库及其 wal（zcode/cursor/antigravity）/
    // antigravity 加密 .pb 与解密 sidecar / ChatGPT 导出的 conversations.json；
    // 空名保守视为变化
    if (name === '' || /(\.(jsonl|db|sqlite3?|vscdb|pb|pbtxt|trajectory\.json)(-wal|-shm)?|\.jsonl\.zst|conversations\.json)$/i.test(name)) touch();
  };

  const rootWatchers = new Map(); // root → Set<FSWatcher>，未在监听的根不在表中

  // 摘除某个根的全部监听，交给 retry 定时器等它重新出现
  const dropRoot = (root, why) => {
    const set = rootWatchers.get(root);
    if (!set) return;
    rootWatchers.delete(root);
    for (const w of set) { try { w.close(); } catch { /* */ } watchers.delete(w); }
    log(`[watch] 停止监听（${why}）: ${root}`);
  };

  const watchDir = (root, dir, set) => {
    try {
      const w = fs.watch(dir, { recursive: true }, (event, filename) => {
        // Windows 上被监听目录本身删除后，libuv 会吞掉 ReadDirectoryChangesW 的
        // ACCESS_DENIED 并立即重投递，形成内核态忙循环（单核 100%、每秒数十万次
        // 以目录自身路径为名的 rename 事件，且不会触发 'error'）。rename 时确认
        // 目录还在，不在就立刻 close 掉句柄止住空转。
        if (event === 'rename' && !fs.existsSync(dir)) return dropRoot(root, '目录已删除');
        handleEvent(filename);
      });
      w.on('error', () => dropRoot(root, '句柄失效'));
      set.add(w);
      watchers.add(w);
      return true;
    } catch {
      return false;
    }
  };

  // 建立监听；优先递归（Windows/macOS 原生支持），失败（如 Linux）降级为逐子目录
  const watchRoot = (root) => {
    if (!fs.existsSync(root)) return false;
    const set = new Set();
    let ok = watchDir(root, root, set);
    if (!ok) {
      try {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (e.isDirectory() && watchDir(root, path.join(root, e.name), set)) ok = true;
        }
      } catch { /* */ }
    }
    if (ok) rootWatchers.set(root, set);
    return ok;
  };

  const allRoots = [...new Set(roots)];
  const okRoots = allRoots.filter(watchRoot);
  log(`[watch] 监听 ${okRoots.length} 个数据目录（去抖 ${Math.round(debounceMs / 1000)}s / 冷却 ${Math.round(cooldownMs / 1000)}s）`);
  for (const r of okRoots) log(`[watch]   ${r}`);

  // 低频重试：启动时不存在或中途被删的根，出现后自动接上监听并补一轮同步
  const retry = setInterval(() => {
    if (stopped) return;
    for (const r of allRoots) {
      if (rootWatchers.has(r) || !watchRoot(r)) continue;
      log(`[watch] 恢复监听: ${r}`);
      touch();
    }
  }, retryMs);
  retry.unref?.();

  return {
    stop() {
      stopped = true;
      clearTimeout(timers.debounce);
      clearTimeout(timers.cooldown);
      clearInterval(retry);
      for (const w of watchers) w.close();
      watchers.clear();
      rootWatchers.clear();
    },
  };
}
