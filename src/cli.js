// CLI 入口：sync / search / serve / stats / workspaces / logs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

// node:sqlite 在 Node 22.x 需要 --experimental-sqlite；未启用时带 flag 重启自身
async function loadDb() {
  try {
    return await import('./db.js');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('node:sqlite')) {
      const entry = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
      const r = spawnSync(process.execPath, ['--experimental-sqlite', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    throw err;
  }
}

const HELP = `ChatVault · 薪传 — 多 Agent 对话归档与检索

用法:
  chat-vault sync    [--agent claude-code|codex|copilot] [--full] [--db PATH]
  chat-vault search  <关键词> [--agent ID] [--limit N] [--db PATH]
  chat-vault serve   [--port 8377] [--no-watch] [--no-sync] [--watch-debounce 5] [--watch-cooldown 60] [--sync-interval N] [--db PATH]
  chat-vault stats   [--db PATH]
  chat-vault workspaces [--db PATH]
  chat-vault logs    [--lines 50]

  说明:
  sync      扫描本机各 agent 会话数据并入库（增量，指纹去重）
  search    全文搜索（中英文子串匹配，支持空格分词）
  serve     启动本地 Web UI，并监听数据目录变化自动同步（去抖+冷却）
  stats     各 agent 会话量统计
  logs      查看最新落地日志（~/.chat-vault/logs/，按天分文件保留 14 天）
  默认数据库: ~/.chat-vault/chat-vault.db
  日志级别: 环境变量 AE_LOG_LEVEL=debug|info|warn|error（默认 info）`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--full') opts.full = true;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || 20;
    else if (a === '--port') opts.port = parseInt(argv[++i], 10) || 8377;
    else if (a === '--sync-interval') opts.syncInterval = parseInt(argv[++i], 10);
    else if (a === '--no-watch') opts.noWatch = true;
    else if (a === '--no-sync') opts.noSync = true; // 只读模式：不并入真实数据源（演示库/体检副本用）
    else if (a === '--watch-debounce') opts.watchDebounce = parseInt(argv[++i], 10);
    else if (a === '--watch-cooldown') opts.watchCooldown = parseInt(argv[++i], 10);
    else if (a === '--db') opts.db = argv[++i];
    else if (a === '--lines') opts.lines = parseInt(argv[++i], 10) || 50;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  if (!cmd || opts.help) { console.log(HELP); process.exit(0); }

  const { openDb, defaultDbPath, AGENTS } = await loadDb();
  const dbPath = opts.db || defaultDbPath();
  const db = openDb(dbPath);

  if (cmd === 'sync') {
    const { runSync } = await import('./sync.js');
    const agents = opts.agent ? [opts.agent] : null;
    console.log(`同步中 (db: ${dbPath})${opts.full ? ' [全量]' : ''} ...`);
    const t0 = Date.now();
    const summary = await runSync(db, { agents, full: opts.full });
    const s = summary;
    console.log(
      `完成 (${((Date.now() - t0) / 1000).toFixed(1)}s): ` +
      `新建 ${s.created}, 更新 ${s.updated}, 未变 ${s.skipped}, 空会话 ${s.empty}, 失败 ${s.failed}`
    );
    for (const f of s.failures.slice(0, 10)) console.error('  ' + f);
    if (s.failures.length > 10) console.error(`  ...共 ${s.failures.length} 个失败`);
  }

  else if (cmd === 'search') {
    const { searchMessages } = await import('./query.js');
    const q = opts._.join(' ');
    if (!q) { console.error('用法: agent-exporter search <关键词>'); process.exit(1); }
    const results = searchMessages(db, { q, agent: opts.agent, limit: opts.limit });
    if (!results.length) { console.log('无结果'); process.exit(0); }
    for (const r of results) {
      const agent = AGENTS[r.session.agent]?.label || r.session.agent;
      console.log(`\n[${agent}] ${r.session.title || '(无标题)'}`);
      console.log(`  ${r.session.workspace_path || '未知工作区'} · ${r.session.updated_at || ''} · 命中 ${r.totalHits} 条 (session #${r.session.id})`);
      for (const h of r.hits) {
        const plain = h.snippet.replace(/<[^>]+>/g, '');
        console.log(`    > ${plain.replace(/\n/g, ' ')}`);
      }
    }
    console.log(`\n共 ${results.length} 个会话命中`);
  }

  else if (cmd === 'stats') {
    const { stats } = await import('./query.js');
    const st = stats(db);
    console.log(`总计: ${st.totals.sessions} 会话 / ${st.totals.messages} 消息 / ${st.totals.workspaces} 工作区\n`);
    for (const a of st.byAgent) {
      const label = AGENTS[a.agent]?.label || a.agent;
      console.log(`  ${label.padEnd(14)} ${String(a.sessions).padStart(5)} 会话  ${String(a.messages || 0).padStart(7)} 消息  ${a.last_at || ''}`);
    }
  }

  else if (cmd === 'workspaces') {
    const { listWorkspaces } = await import('./query.js');
    for (const w of listWorkspaces(db)) {
      console.log(`${String(w.session_count).padStart(4)} 会话  ${w.path}  [${(w.agents || '').split(',').join(' ')}]`);
    }
  }

  else if (cmd === 'serve') {
    const { startServer, invalidateTimelineCache } = await import('./server.js');
    const { adapters } = await import('./sync.js');
    const { Worker } = await import('node:worker_threads');
    const { log } = await import('./log.js');
    log.setMirror(true); // 常驻模式：info 也镜像到控制台（最小化窗口可见）

    // 崩溃黑匣子：静默退出最难排查（stderr 随控制台窗口一起消失），
    // 先把原因写进落地日志再退出
    for (const evt of ['uncaughtException', 'unhandledRejection']) {
      process.on(evt, (e) => {
        log.error('serve', `未捕获${evt === 'unhandledRejection' ? 'Promise 拒绝' : '异常'}，进程即将退出`, e);
        setTimeout(() => process.exit(1), 500); // 给日志落盘留时间
      });
    }

    log.info('serve', `启动: db=${dbPath} port=${opts.port ?? 8377} watch=${!opts.noWatch} poll=${opts.syncInterval || 0}s`);

    // 同步放独立 worker 线程：巨型源文件解析不再卡住 HTTP 事件循环（WAL 下读写互不阻塞）
    const runSyncInWorker = () => new Promise((resolve) => {
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      const w = new Worker(new URL('./sync-worker.js', import.meta.url), { workerData: { dbPath } });
      w.once('message', done);
      w.once('error', (err) => done({ ok: false, error: String(err?.stack || err) }));
      w.once('exit', (code) => { if (code !== 0) done({ ok: false, error: `sync worker 异常退出 (code ${code})` }); });
    });

    let syncing = false;
    const doSync = async (reason = '') => {
      if (syncing) return; // 并发保护：watcher 触发与兜底轮询互斥
      syncing = true;
      const t0 = Date.now();
      try {
        const r = await runSyncInWorker();
        if (!r.ok) throw new Error(r.error);
        const s = r.summary;
        if (s.created + s.updated > 0) invalidateTimelineCache(); // 作息图缓存失效
        if (s.created + s.updated > 0 || s.failed > 0) {
          log.info('serve', `同步${reason}: +${s.created} 新建 / ${s.updated} 更新 / 失败 ${s.failed}，${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } else {
          log.debug('serve', `同步${reason}: 无变化，${((Date.now() - t0) / 1000).toFixed(1)}s`);
        }
      } catch (e) {
        log.error('serve', `同步${reason} 失败`, e);
      } finally {
        syncing = false;
      }
    };

    // 启动先同步一次（--no-sync 跳过：演示库/只读副本不能并入真实数据源）
    if (!opts.noSync) doSync(' 启动');

    // 事件驱动：监听数据目录变化（默认开启；--no-watch 关闭）
    if (!opts.noWatch && !opts.noSync) {
      const { startWatcher } = await import('./watcher.js');
      startWatcher({
        roots: adapters.flatMap((a) => (a.watchRoots ? a.watchRoots() : [])),
        debounceMs: (opts.watchDebounce ?? 5) * 1000,
        cooldownMs: (opts.watchCooldown ?? 60) * 1000,
        onSync: () => doSync(''),
        log: (msg) => log.info('watch', String(msg).replace(/^\[watch\]\s?/, '')),
      });
    }

    // 可选兜底轮询（默认关闭，--sync-interval N 开启）
    if (opts.syncInterval && opts.syncInterval > 0 && !opts.noSync) {
      setInterval(() => doSync(''), opts.syncInterval * 1000);
      log.info('serve', `定时兜底同步已开启（每 ${opts.syncInterval}s）`);
    }

    startServer(db, { port: opts.port, dbPath });
  }

  else if (cmd === 'mcp') {
    console.error('agent-exporter mcp (stdio) 已移除：请改用 HTTP 传输');
    console.error('  http://localhost:8377/mcp  (需先运行 agent-exporter serve)');
    console.error('  各 agent 配置示例见 README「MCP 接口」');
    process.exit(1);
  } else if (cmd === 'logs') {
    // 查看落地日志：默认最新文件末 50 行；--lines N 调整
    const { latestLogFile, logDir } = await import('./log.js');
    const f = latestLogFile();
    if (!f) { console.log(`暂无日志（${logDir}）`); process.exit(0); }
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    console.log(`== ${f}（共 ${lines.length} 行）==`);
    for (const ln of lines.slice(-(opts.lines || 50))) console.log(ln);
  }

  else {
    console.log(HELP);
    process.exit(1);
  }
}

// 直接运行（bin 转发或 npm script）
if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
