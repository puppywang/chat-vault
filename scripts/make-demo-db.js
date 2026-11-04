// 生成合成的演示数据库 —— 全部内容虚构，用于 README 截图与无隐私体验。
// 用法: node scripts/make-demo-db.js --out /tmp/chatvault-demo/demo.db
// 之后: node src/cli.js serve --port 8378 --no-watch --db <同一路径>
// 说明: 填充会话先把自增 id 顶到 3 位数（引用链的 chat-vault 指令要求 3~7 位），
//       主角会话分两批写入：先写被引用方，解析出真实 id 后再写引用方。
import fs from 'node:fs';
import path from 'node:path';
import { openDb, upsertSession } from '../src/db.js';
import { extractSessionLinks } from '../src/links.js';

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const out = argOf('--out') || path.join('/tmp', 'chatvault-demo', 'demo.db');
fs.mkdirSync(path.dirname(out), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(out + suffix); } catch { /* 不存在即可 */ } }
const db = openDb(out);

// ---------- 时间工具：最近 3 周内按天铺开 ----------
const DAY = 86400000;
const base = Date.now() - 20 * DAY;
const at = (dayOffset, h, m) => new Date(base + dayOffset * DAY + h * 3600000 + m * 60000).toISOString();

let seq = 0;
const msg = (role, text, dayOffset, h, m, extra = {}) =>
  ({ role, text, createdAt: at(dayOffset, h, m), ...extra });

/** 一个合成会话：messages 用生成器拼装 */
function session({ id, agent, ws, title, dayOffset, msgs }) {
  const createdAt = at(dayOffset, 9, 30);
  const updatedAt = at(dayOffset + (msgs.length > 12 ? 1 : 0), 18, 10);
  return {
    agentSessionId: id,
    agent,
    workspacePath: ws,
    title,
    createdAt,
    updatedAt,
    messages: msgs,
  };
}

const u = (t, d, h, m) => msg('user', t, d, h, m);
const a = (t, d, h, m, model) => msg('assistant', t, d, h, m, { model });
const tool = (t, d, h, m) => msg('tool', t, d, h, m);
const think = (t, d, h, m) => msg('thinking', t, d, h, m);

// ---------- 工作区（全部虚构） ----------
const WS = {
  blog: 'D:\\Dev\\blogforge',      // 静态博客引擎
  photo: 'D:\\Dev\\picshelf',      // 本地照片整理
  note: 'D:\\Dev\\markline',       // Markdown 笔记 CLI
  cart: 'D:\\Dev\\cartdemo',       // 网店演示站
  ledger: 'D:\\Dev\\ledgerlite',   // 记账小工具
};

// ---------- 填充会话：1~3 条消息，把 id 顶到 3 位数 ----------
const FILLERS = [
  ['claude-code', 'blog', '修复 RSS 里日期格式不合法的问题'],
  ['codex', 'blog', '给代码块加复制按钮'],
  ['copilot', 'blog', '首页分页改成游标翻页'],
  ['cursor', 'photo', 'EXIF 旋转后缩略图方向不对'],
  ['claude-code', 'photo', '按相册导出的 zip 里中文文件名乱码'],
  ['codex', 'note', '升级依赖后 Go 编译警告清理'],
  ['copilot', 'note', '导出 PDF 时表格被截断'],
  ['cursor', 'cart', '购物车角标数量不实时刷新'],
  ['kiro', 'cart', '结算按钮在弱网下可重复点击'],
  ['zcode', 'ledger', '分类统计饼图颜色太少'],
  ['claude-code', 'ledger', '导出 CSV 用 Excel 打开乱码'],
  ['codex', 'blog', 'sitemap 里漏掉了标签页'],
  ['qoder', 'photo', '人脸聚类跑一次要十分钟，能否增量'],
  ['iflow', 'note', '命令行 --help 文案整理'],
  ['factory', 'cart', '商品图片懒加载偶尔闪一下'],
];

const fillerSessions = [];
let d = 0;
for (const [agent, ws, title] of FILLERS) {
  for (let k = 0; k < 10; k++) {
    d += 0.35;
    const day = Math.floor(d) % 19;
    fillerSessions.push(session({
      id: `demo-f-${fillerSessions.length}`,
      agent, ws: WS[ws], title: `${title}${k ? `（第 ${k + 1} 次）` : ''}`,
      dayOffset: day,
      msgs: [
        u(`帮我看下：${title}。`, day, 10, 15),
        a('我先定位相关代码，稍等。', day, 10, 16, 'gpt-5.2-codex'),
        a('已修复并自测通过，改动如下：`1 file changed, +6 -2`。', day, 10, 24, 'gpt-5.2-codex'),
      ],
    }));
  }
}

// ---------- 主角会话（第一批：被引用方） ----------
const mains = [];

mains.push(session({
  id: 'demo-m-blog-dark', agent: 'claude-code', ws: WS.blog,
  title: '博客代码高亮在暗色主题下看不清，调一下配色',
  dayOffset: 18,
  msgs: [
    u('博客的代码高亮用的 github-light，切到暗色主题后注释几乎看不见，帮我按主题变量调一套暗色高亮配色。', 18, 9, 41),
    think('暗色高亮要跟随主题变量而不是写死色值。先看现有高亮样式与主题 token 的组织方式，再决定是加一份暗色 token 还是整体换成双主题样式表。', 18, 9, 42),
    a('我先看看现在高亮样式和主题变量的组织方式。', 18, 9, 42, 'claude-sonnet-4-5'),
    tool('[tool:Read] styles/highlight.css（86 行）', 18, 9, 42),
    tool('[tool:Read] styles/theme.css（142 行）', 18, 9, 43),
    a('高亮色值全部写死在 highlight.css，没有跟随主题。方案：把 token 抽到 CSS 变量，暗色主题下覆盖变量即可，不改高亮逻辑。', 18, 9, 45, 'claude-sonnet-4-5'),
    tool('[tool:Edit] styles/highlight.css：色值 → var(--hl-*)', 18, 9, 47),
    tool('[tool:Edit] styles/theme-dark.css：新增 9 个 --hl-* 覆盖', 18, 9, 49),
    tool('[tool:Bash] npm run build  → done in 3.2s', 18, 9, 51),
    a('暗色下注释改用 #7c8695（对比度 4.6:1），字符串换暖绿，关键字用主题蓝。构建通过，本地预览正常。对比度都按 WCAG AA 校过。', 18, 9, 53, 'claude-sonnet-4-5'),
    u('很好，关键字那组再亮一点，现在和正文有点近。', 18, 9, 58),
    a('关键字从 #5aa2ff 提到 #79b4ff，其余不动。', 18, 9, 59, 'claude-sonnet-4-5'),
    tool('[tool:Edit] styles/theme-dark.css：--hl-keyword 提亮', 18, 9, 59),
    a('完成。这次改动共 2 个文件，高亮 token 化以后换主题只改变量。', 18, 10, 2, 'claude-sonnet-4-5'),
  ],
}));

mains.push(session({
  id: 'demo-m-blog-draft', agent: 'codex', ws: WS.blog,
  title: '给博客加草稿自动保存，别再丢稿子了',
  dayOffset: 12,
  msgs: [
    u('昨天写了一小时的稿子浏览器一崩全没了。给编辑器加草稿自动保存，本地优先，别依赖服务端。', 12, 14, 2),
    a('思路：编辑器输入防抖 800ms 写 localStorage（按文章 id 作 key），进入正文 30s 再同步一份到服务端草稿接口；恢复时本地优先。', 12, 14, 4, 'gpt-5.2-codex'),
    tool('[tool:exec completed] rg "oninput|debounce" editor/ --stats', 12, 14, 5),
    a('编辑器已有防抖管线（300ms），直接挂 autosave 插件即可。', 12, 14, 6, 'gpt-5.2-codex'),
    tool('[tool:exec completed] node -e "console.log(require(\'./editor/package.json\').version)"\n0.9.4', 12, 14, 6),
    tool('[tool:apply_patch] editor/src/plugins/autosave.js 新增（58 行）', 12, 14, 9),
    tool('[tool:apply_patch] editor/src/index.js：注册插件', 12, 14, 10),
    u('恢复的时候要提示用户，别静默覆盖他们正在写的内容。', 12, 14, 15),
    a('有道理。恢复策略改为：检测到本地草稿比服务端新且内容有差异时，弹出对比条，用户点「恢复本地」才覆盖。', 12, 14, 16, 'gpt-5.2-codex'),
    tool('[tool:apply_patch] editor/src/plugins/autosave.js：恢复对比条（+34 行）', 12, 14, 18),
    tool('[tool:exec completed] npm test -- autosave\n17 passed', 12, 14, 21),
    a('完成：本地草稿 + 服务端双写 + 恢复对比条，17 个测试全过。剩余：并发编辑（两个标签页同时写同一篇）还没处理，以及服务端草稿接口的清理策略。', 12, 14, 24, 'gpt-5.2-codex'),
  ],
}));

mains.push(session({
  id: 'demo-m-photo-dedup', agent: 'copilot', ws: WS.photo,
  title: '照片按拍摄时间重命名，重复照片怎么去重？',
  dayOffset: 15,
  msgs: [
    u('相机和手机互拷之后照片全乱了。想按「拍摄时间_序号」重命名，另外重复的照片（连拍的）想清掉，帮我理个方案。', 15, 20, 5),
    a('重命名直接读 EXIF DateTimeOriginal，冲突序号递增。去重分两档：文件哈希完全相同的直接删；连拍这种「内容近似」的用感知哈希（pHash）聚类，人工确认后删。', 15, 20, 7, 'deepseek-v4-flash'),
    u('近似去重误删风险大不大？', 15, 20, 9),
    a('pHash 汉明距离 ≤ 6 视为近似，实测连拍误报很少；再加一道保护：同秒内才参与聚类，跨场景几乎不会误伤。', 15, 20, 10, 'deepseek-v4-flash'),
    tool('[tool:mcp:filesystem.read_file] picshelf/dedup.py', 15, 20, 12),
    tool('[tool:patch] dedup.py：新增 pHash 聚类（+41 行）', 15, 20, 16),
    tool('[tool:exec] python -m picshelf.dedup --dry-run ~/Photos\n相似组 132 组 / 完全重复 214 张（未删除，仅报告）', 15, 20, 19),
    a('dry-run 结果：完全重复 214 张、近似组 132 组。建议先跑 --dry-run 人工过一遍再 --apply。', 15, 20, 21, 'deepseek-v4-flash'),
    u('好，先不动手，把报告导出成 csv 我自己筛。', 15, 20, 23),
    a('已加 --report csv 参数，输出组号/路径/哈希距离三列。', 15, 20, 24, 'deepseek-v4-flash'),
  ],
}));

mains.push(session({
  id: 'demo-m-cart-float', agent: 'claude-code', ws: WS.cart,
  title: '购物车合计出现 0.30000000000000004',
  dayOffset: 9,
  msgs: [
    u('购物车三件商品 0.1 + 0.2 合计显示 0.30000000000000004，价格统一改成「分」为单位的整数运算，展示层再格式化。', 9, 11, 2),
    a('同意，浮点算钱是经典坑。改造点：Cart 类内部全用整数分，输入层元→分转换集中到一个 toCents()，输出层 formatYuan()。', 9, 11, 3, 'claude-sonnet-4-5'),
    tool('[tool:Read] src/cart/Cart.ts（120 行）', 9, 11, 4),
    tool('[tool:Edit] src/cart/money.ts：新增 toCents/formatYuan', 9, 11, 6),
    tool('[tool:Edit] src/cart/Cart.ts：total/ coupons 全改整数分', 9, 11, 8),
    think('优惠券折扣可能出现 33.4% 这类小数，分摊到整数分会有余数——按「余数记到首件商品」的惯例处理，避免合计对不上。', 9, 11, 9),
    a('注意点：整单折扣按行分摊会有余数，余数记到首件，保证 Σ行 = 总额。单测覆盖 0.1+0.2、三件 8.5 折、满减叠加三个场景。', 9, 11, 10, 'claude-sonnet-4-5'),
    tool('[tool:Bash] npm test -- cart\n12 passed', 9, 11, 12),
    a('完成。合计永远整数分，展示层 formatYuan 输出两位小数；以后接支付网关也不会再有精度差。', 9, 11, 14, 'claude-sonnet-4-5'),
  ],
}));

mains.push(session({
  id: 'demo-m-note-search', agent: 'cursor', ws: WS.note,
  title: 'markline 全文搜索在 2 万条笔记上要 4 秒，优化',
  dayOffset: 6,
  msgs: [
    u('笔记涨到两万条后，命令行搜索要 4 秒才出结果，受不了。目标 200ms 内。', 6, 15, 30),
    a('现在每次搜索全量扫正文。方案：建倒排索引（首次全量构建约 8s，之后增量更新），搜索走索引 + 原文验证双保险。', 6, 15, 32, 'gpt-5.2-codex'),
    tool('[tool:Read] internal/search/scan.go', 6, 15, 33),
    tool('[tool:Edit] internal/search/index.go：新增倒排索引', 6, 15, 38),
    tool('[tool:exec completed] go test ./... \nok 31 tests', 6, 15, 44),
    tool('[tool:exec completed] markline search "备份策略" --bench\n冷 180ms / 热 40ms（原 4.1s）', 6, 15, 47),
    a('冷启动 180ms、热查询 40ms，达标。索引文件放 .markline/index.db，笔记变更时增量写。', 6, 15, 48, 'gpt-5.2-codex'),
  ],
}));

mains.push(session({
  id: 'demo-m-ledger-tz', agent: 'codex', ws: WS.ledger,
  title: '月度报表的账目日期整体偏了一天',
  dayOffset: 3,
  msgs: [
    u('九月一日的账跑到八月三十一日去了，报表整体偏一天，像是时区处理问题，排查一下。', 3, 10, 5),
    a('典型 UTC/本地时区问题：存储用了 UTC 零点的日期字符串，报表按本地时区解析就跨了天。方案：日期一律存「本地日」字符串 YYYY-MM-DD，与展示一致。', 3, 10, 7, 'gpt-5.2-codex'),
    tool('[tool:exec completed] rg "toISOString" src/ | head', 3, 10, 8),
    a('找到了 3 处 toISOString 直接落库。逐一改为本地日格式化函数 localDay()。', 3, 10, 9, 'gpt-5.2-codex'),
    tool('[tool:apply_patch] src/report/*.js：3 处改 localDay()', 3, 10, 11),
    tool('[tool:exec completed] node scripts/backfill-days.js\n迁移 1,842 条记录', 3, 10, 14),
    a('修复 + 历史数据迁移完成。剩余：给报表加一条「日期边界」回归测试，防止再犯。', 3, 10, 15, 'gpt-5.2-codex'),
  ],
}));

// ---------- 主角会话（第二批：引用前面会话，构成链） ----------
function resolveId(demoId) {
  return db.prepare('SELECT id FROM sessions WHERE agent_session_id = ?').get(demoId)?.id;
}

for (const s of [...fillerSessions, ...mains]) {
  upsertSession(db, s.agent, `demo://${s.agentSessionId}`, `demo-fp-${s.agentSessionId}`, s);
}

const idBlogDraft = resolveId('demo-m-blog-draft');
const idPhotoDedup = resolveId('demo-m-photo-dedup');
const idLedgerTz = resolveId('demo-m-ledger-tz');

const chainsA = [
  session({
    id: 'demo-c-blog-lock', agent: 'claude-code', ws: WS.blog,
    title: `chat-vault 读取 ${idBlogDraft} 的上下文，继续完成草稿保存的剩余工作`,
    dayOffset: 11,
    msgs: [
      u(`chat-vault 读取 ${idBlogDraft} 的上下文，继续完成剩余工作：上次说好的「两个标签页同时写同一篇」的并发问题还没处理。`, 11, 9, 20),
      a(`已读取 ${idBlogDraft}。现状：autosave 插件 + 恢复对比条已完成。并发方案：写入前对比 storage 事件里的版本号，冲突时同样走对比条而不是静默覆盖。`, 11, 9, 22, 'claude-sonnet-4-5'),
      tool('[tool:Edit] editor/src/plugins/autosave.js：storage 事件监听 + 版本号比对', 11, 9, 25),
      tool('[tool:Bash] npm test -- autosave\n21 passed', 11, 9, 28),
      a('并发保护完成，21 个测试全过。草稿保存这条线收尾了，服务端清理策略要不要另开一个对话？', 11, 9, 30, 'claude-sonnet-4-5'),
    ],
  }),
  session({
    id: 'demo-c-photo-hash', agent: 'codex', ws: WS.photo,
    title: '把去重的感知哈希换成差值哈希再对比准确率',
    dayOffset: 13,
    msgs: [
      u(`chat-vault 读取 ${idPhotoDedup}，把 pHash 换成 dHash 跑一遍对比，如果准确率不降就换过去，dHash 更快。`, 13, 21, 10),
      a(`对比完成：5000 张样本，pHash 准确率 98.2% / dHash 97.6%，速度 dHash 快 2.3 倍。近似去重建议保留 pHash，完全重复场景用 dHash 就够。`, 13, 21, 15, 'gpt-5.2-codex'),
    ],
  }),
  session({
    id: 'demo-c-ledger-test', agent: 'claude-code', ws: WS.ledger,
    title: '报表时区问题的回归测试',
    dayOffset: 2,
    msgs: [
      u(`chat-vault 读取 ${idLedgerTz} 的上下文，把上次说的日期边界回归测试补上。`, 2, 10, 30),
      a(`已读取 ${idLedgerTz}。补了三组测试：月首日、月末日、夏令时切换日，全部走 localDay() 断言。`, 2, 10, 33, 'claude-sonnet-4-5'),
      tool('[tool:Bash] npm test -- report\n36 passed', 2, 10, 36),
      a('时区这条线彻底关闭。', 2, 10, 37, 'claude-sonnet-4-5'),
    ],
  }),
];

for (const s of chainsA) {
  upsertSession(db, s.agent, `demo://${s.agentSessionId}`, `demo-fp-${s.agentSessionId}`, s);
}

// 依赖前面链会话 id 的第二批（压测引用"并发锁"会话）
const idBlogLock = resolveId('demo-c-blog-lock');
const chainsB = [
  session({
    id: 'demo-c-blog-stress', agent: 'zcode', ws: WS.blog,
    title: '草稿保存的并发锁压测',
    dayOffset: 9,
    msgs: [
      u(`接着 #${idBlogLock} 这个对话做压测：开 8 个标签页同时编辑同一篇，看丢不丢字。`, 9, 16, 40),
      a('压测脚本：8 个 Playwright 页签各输入 500 字，全部保存后逐字比对。结果：0 冲突丢失，对比条正确弹出 3 次。', 9, 16, 44, 'glm-5'),
      a('结论：并发保护可用。建议把压测脚本固化到 scripts/ 里作为回归。', 9, 16, 46, 'glm-5'),
    ],
  }),
];

for (const s of chainsB) {
  upsertSession(db, s.agent, `demo://${s.agentSessionId}`, `demo-fp-${s.agentSessionId}`, s);
}

// ---------- 重建引用链 ----------
extractSessionLinks(db, { full: true });

// ---------- 问库助手的演示问答（离线注入，不调用 LLM） ----------
const insChat = db.prepare('INSERT INTO ai_chats (created_at, question, answer, steps, status) VALUES (?, ?, ?, ?, ?)');
insChat.run(
  at(1, 16, 5),
  '还有哪些没做完的任务？',
  `扫描全部会话的最近任务快照，未完成的有 3 处：

- **blogforge · 草稿保存**：服务端草稿的清理策略还没定（自动保存本体与并发保护已完成）
- **picshelf · 照片去重**：近似去重的 dry-run 报告已导出，等人工确认后才会真正删除
- **markline**：WikiLinks 双链支持做到一半，解析器完成、渲染器未接

都带原始出处，点进对应会话可以接着做。`,
  JSON.stringify([
    '检索各会话最近的 todo 清单快照',
    '过滤 status=pending / in_progress',
    '按会话聚合并附出处',
  ]),
  'done'
);
insChat.run(
  at(1, 16, 12),
  '购物车金额精度问题最后是怎么解决的？',
  `cartdemo 的合计精度问题已解决：Cart 内部全部改为「分」为单位的整数运算，元→分的转换集中在 toCents()，展示层 formatYuan() 输出两位小数。

整单折扣按行分摊时的余数记到首件商品，保证 Σ行小计 = 订单总额。回归测试 12 个全过。`,
  JSON.stringify([
    '全文检索「0.30000000000000004 精度」',
    '定位到 cartdemo 的修复会话',
    '提取结论与测试结果',
  ]),
  'done'
);

// ---------- 汇总 ----------
const st = db.prepare("SELECT COUNT(*) c FROM sessions WHERE hidden = 0").get().c;
const msgs = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
const links = db.prepare('SELECT COUNT(*) c FROM session_links').get().c;
console.log(`demo db ready: ${out}`);
console.log(`sessions=${st} messages=${msgs} links=${links} ai_chats=2`);
db.close();
