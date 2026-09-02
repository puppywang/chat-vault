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
    // 关心的数据文件：jsonl 会话 / sqlite 库及其 wal（zcode/cursor）/
    // antigravity 加密 .pb 与解密 sidecar；空名保守视为变化
    if (name === '' || /\.(jsonl|sqlite3?|vscdb|pb|trajectory\.json)(-wal|-shm)?$/i.test(name)) touch();
  };

  const watchDir = (dir) => {
    try {
      const w = fs.watch(dir, { recursive: true }, (event, filename) => handleEvent(filename));
      w.on('error', () => { /* 句柄失效（目录删除等），摘除即可 */ });
      watchers.add(w);
      return true;
    } catch {
      return false;
    }
  };

  // 建立监听；优先递归（Windows/macOS 原生支持），失败（如 Linux）降级为逐子目录
  const watchRoot = (root) => {
    if (!fs.existsSync(root)) return false;
    if (watchDir(root)) return true;
    try {
      let any = false;
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && watchDir(path.join(root, e.name))) any = true;
      }
      return any;
    } catch {
      return false;
    }
  };

  const okRoots = [];
  for (const r of [...new Set(roots)]) {
    if (watchRoot(r)) okRoots.push(r);
  }
  log(`[watch] 监听 ${okRoots.length} 个数据目录（去抖 ${Math.round(debounceMs / 1000)}s / 冷却 ${Math.round(cooldownMs / 1000)}s）`);
  for (const r of okRoots) log(`[watch]   ${r}`);

  return {
    stop() {
      stopped = true;
      clearTimeout(timers.debounce);
      clearTimeout(timers.cooldown);
      for (const w of watchers) w.close();
      watchers.clear();
    },
  };
}
