# agent-exporter 设计方案

多 Agent 对话归档与检索工具：从 Claude Code / Codex / ZCode / Cursor / GitHub Copilot / Antigravity 六个工具中同步对话，统一存储、全文搜索，并按时间线 / 工作区 / 目录归类索引。

## 1. 目标与原则

- **本地优先**：所有数据留在本机（一个 SQLite 库 + 可选的原始数据快照目录），不依赖云服务。
- **只读采集**：对源数据只做读取，绝不写回 agent 的数据目录；SQLite 源文件以只读方式打开或先复制快照。
- **保留原文，可重建索引**：入库时同时保留原始 JSON（raw），格式解析出问题随时可以重新解析重建索引，不丢数据。
- **增量、幂等**：同步可重复执行，基于指纹（size + mtime）做增量，upsert 幂等写入。

## 2. 各 agent 数据源速查

| Agent | 位置 | 格式 | 工作区识别方式 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<编码路径>/<uuid>.jsonl` | JSONL 事件流（user/assistant/tool 消息，含 timestamp、cwd） | 目录名即编码的项目路径（如 `d--Work-sample-app-...` → `D:\Work\sample-app\...`） |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（另有 `archived_sessions/`） | JSONL rollout（session_meta 含 cwd） | 读文件内 session_meta 的 cwd 字段 |
| ZCode | `~/.zcode/cli/rollout/model-io-sess_*.jsonl`；结构化任务索引在 `~/.zcode/v2/tasks-index.sqlite`（tasks 表） | model-io 级 JSONL（request.body.messages 含累积历史，需去重）；tasks 表含 workspace 信息 | 从 rollout 内容 / tasks-index.sqlite 关联 |
| Cursor | `%APPDATA%\Cursor\User\workspaceStorage\<hash>\state.vscdb`，ItemTable 键 `composer.composerData` | SQLite 中存大 JSON blob（composer 会话） | 同目录 `workspace.json` 的 `folder` 字段（`file:///d%3A/...` URL） |
| GitHub Copilot | `%APPDATA%\Code\User\workspaceStorage\<hash>\chatSessions\<uuid>.jsonl` | VS Code chat session JSON（v3 格式，requests[] 内含双方消息与模型信息） | 同目录 `workspace.json` |
| Antigravity | `%APPDATA%\Antigravity IDE\User\workspaceStorage\<hash>\state.vscdb`（VS Code fork 结构，另有 globalStorage/state.vscdb） | SQLite ItemTable（键名待实现时探查，大概率与 Cursor/VS Code 同族） | 同目录 `workspace.json` |

三个 VS Code 系（Cursor / Copilot / Antigravity）共享 `workspaceStorage/<hash>/workspace.json` 这一路径映射机制，可以做一个公共的 workspace 解析器。

## 3. 总体架构

```
┌─────────────────────────────────────────────────────┐
│ Adapters（每 agent 一个，隔离格式差异）                 │
│  claude.ts  codex.ts  zcode.ts  cursor.ts            │
│  copilot.ts  antigravity.ts  （+ vscode-base 公共层） │
└──────────────────┬──────────────────────────────────┘
                   ↓ 输出统一模型 RawSession / RawMessage
┌─────────────────────────────────────────────────────┐
│ Sync Engine                                         │
│  扫描器（glob 各数据源）→ 指纹比对 → 解析 → upsert    │
│  调度：手动 sync / 定时轮询 / 文件监听（Phase 3）      │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ Store（单个 SQLite）                                 │
│  sessions / messages / workspaces / sync_state      │
│  FTS5 全文索引（trigram，中英文子串搜索）             │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ Query API（本地 HTTP 服务）                          │
│  /sessions /search /workspaces /timeline /stats     │
└──────────────────┬──────────────────────────────────┘
                   ↓
┌─────────────────────────────────────────────────────┐
│ Web UI（本地起服务，浏览器访问）                      │
│  时间线视图 / 工作区树视图 / 会话详情 / 搜索框        │
└─────────────────────────────────────────────────────┘
```

## 4. 统一数据模型

```sql
-- 工作区：归一化后的项目目录（多个 agent、多个哈希目录可指向同一工作区）
CREATE TABLE workspaces (
  id            INTEGER PRIMARY KEY,
  path          TEXT UNIQUE NOT NULL,     -- 归一化绝对路径，如 D:\Work\sample-app
  name          TEXT,                     -- 目录名，如 sample-app
  first_seen    TEXT,
  last_active   TEXT
);

-- 会话：一个 agent 的一次对话
CREATE TABLE sessions (
  id              INTEGER PRIMARY KEY,
  agent           TEXT NOT NULL,          -- claude-code / codex / zcode / cursor / copilot / antigravity
  agent_session_id TEXT NOT NULL,         -- 各 agent 自己的会话 ID
  workspace_id    INTEGER REFERENCES workspaces(id),
  title           TEXT,                   -- 取首条用户消息截断
  created_at      TEXT,
  updated_at      TEXT,
  message_count   INTEGER,
  raw_path        TEXT,                   -- 源文件路径，便于追溯
  UNIQUE(agent, agent_session_id)
);

-- 消息：展开后的每条对话消息
CREATE TABLE messages (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER REFERENCES sessions(id),
  seq           INTEGER,                  -- 会话内序号
  role          TEXT,                     -- user / assistant / tool / system
  created_at    TEXT,
  content_text  TEXT,                     -- 提取的纯文本（供 FTS 索引与摘要展示）
  content_raw   TEXT                      -- 原始 JSON（保留，可重建索引）
);

-- 同步状态：指纹与游标
CREATE TABLE sync_state (
  source_path   TEXT PRIMARY KEY,         -- 源文件路径或 vscdb 键
  agent         TEXT,
  fingerprint   TEXT,                     -- size + mtime（vscdb 用 db mtime + 键）
  synced_at     TEXT
);

-- 全文索引（trigram 对中文子串友好，英文同样可用）
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  content='messages', content_rowid='id',
  tokenize='trigram'
);
-- 用触发器或同步后批量重建维护；查询用 snippet() 高亮
```

要点：

- **workspace 归一化**：`file:///d%3A/WorkDemo/x` → `D:\WorkDemo\x`；Claude 的 `d--WorkDemo-x` → `D:\WorkDemo\x`；统一小写盘符、正斜杠规范后再比对，多个来源映射到同一 `workspaces` 行。同一路径在 Claude/Cursor/Codex 里开的会话会自然聚合到同一个工作区下。
- **role 归一化**：各家的 tool call / tool result / thinking 统一映射到 `tool`，并保留在 `content_raw` 里；`content_text` 只放可读文本（工具调用只保留命令摘要，如 `Bash: git status`），避免海量工具输出污染搜索结果。
- **ZCode 去重**：model-io 记录每条都带累积历史，按消息内容哈希 + 序号去重后再入库。

## 5. 同步引擎

1. **发现**：每个 adapter 用 glob 列出自己的候选源文件（`~/.claude/projects/**/*.jsonl` 等）。
2. **指纹比对**：`sync_state` 里存 `(size, mtime)`；一致则跳过。vscdb 是热文件，比较 db 文件 mtime + 目标键。
3. **读取**：
   - JSONL 源：直接流式逐行读。
   - SQLite 源（Cursor/Antigravity）：**先复制到临时目录再打开**，避免和正在运行的 IDE 抢 WAL 锁，也避免读到半写状态。
4. **解析 → 统一模型 → upsert**：一个事务内完成 session/message 写入；文件指纹变化时先删旧消息再插入（jsonl 一般 append-only，但重写场景直接重解析更稳）。
5. **调度**：MVP 用手动 `sync` 命令 + `--watch`（chokidar 监听数据目录，Phase 3）。

## 6. 搜索与归类视图

- **搜索**：FTS5 trigram，支持中英文子串匹配、`agent:claude` `workspace:sample-app` 过滤词、时间范围过滤；结果按消息命中、按会话聚合展示，`snippet()` 生成高亮摘要。
- **时间线**：按天分组的会话流（默认视图），显示 agent 徽标、工作区、首条用户消息摘要、消息数。
- **工作区视图**：工作区列表（按最近活跃排序），展开看该目录下所有 agent 的会话——这是"同一个项目里跨工具找某次对话"的主场景。
- **目录树视图**：由 workspace path 构建的树（`D:\` → `Work` → `sample-app`），覆盖项目分散在多个盘符/层级的情况。
- **会话详情**：完整渲染消息流（markdown 渲染、工具调用折叠展示）。

## 7. 技术选型

**推荐 TypeScript / Node.js 单仓库**：

- 运行时：Node 20+，`commander`（CLI）+ `better-sqlite3`（同步 API，FTS5 内建）+ `chokidar`（监听）+ `fastify`（API）+ Vite + React（UI）。
- 理由：六个数据源全是 JSON/SQLite，Node 处理顺手；better-sqlite3 事务简单；UI 与 server 同语言同仓库；最终可打包成 `npx agent-exporter` 一键启动。
- 备选：Python（FastAPI + sqlite3 + watchdog）同样可行，UI 开发链路稍重。

## 8. 实施路线

**Phase 1 — MVP（先跑通三个纯 JSONL 源）**
1. 项目骨架 + SQLite schema + better-sqlite3 封装
2. claude-code / codex / copilot 三个 adapter + workspace 归一化
3. `agent-exporter sync` 命令（全量 + 增量指纹）
4. FTS5 索引 + `agent-exporter search "关键词"` CLI 搜索
5. 最小 Web UI：时间线列表 + 搜索框 + 会话详情

**Phase 2 — 补齐 SQLite 系**
6. vscode-base 公共层（workspace.json 解析、vscdb 快照读取）
7. cursor（composerData 解析）+ antigravity（键名探查）+ zcode（rollout 去重，辅以 tasks-index.sqlite）

**Phase 3 — 体验完善**
8. `--watch` 文件监听实时同步；UI 自动刷新
9. 工作区视图 + 目录树视图 + 统计面板（各 agent 使用量、活跃趋势）
10. 会话导出 Markdown / JSON

**Phase 4 — 可选增强**
11. sqlite-vec 语义搜索（向量化，跨会话"语义回忆"）
12. 标签 / 收藏 / 备注；多机数据合并导入

## 实施进展（2026-08-22 更新）

- **Phase 1-2 完成**，且实际接入 10 个 agent（claude-code/codex/copilot/zcode/cursor/
  antigravity/windsurf/windsurf-next/kiro/iflow），详见 `docs/AGENT-INTEGRATION-GUIDE.md`
- **AI 检索助手**（增量能力）：本地 qwen（OpenAI 兼容网关）+ function calling 工具循环，
  5 个白名单查询工具（含 `find_task_states` 任务状态扫描），UI 右下角 💬 抽屉、检索过程
  可见、回答带会话跳转链接、可随时中断（SSE 断开即中止 LLM 请求）、30 轮上限 + 强制收尾。
  详见 `docs/AI-ASSISTANT-DESIGN.md`
- **消息级标记**（Phase 4 第 12 条部分落地）：独立 message_flags 表，以
  (agent, agent_session_id, seq) 稳定键存 todo/star 双标记（互不冲突；消息 id 会随
  整文件重同步变化，seq 才稳定，标记因此不丢）；会话内每条消息可复制定位链接
  （`#/session/<id>?msg=<seq>`，seq 为会话内序号）、标 TODO/收藏；侧栏「🚩 标记」
  视图按类型统一过滤，点击跳转到消息并定位

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| agent 版本更新改格式 | adapter 隔离 + 保留 content_raw，解析失败只跳过该文件并记录告警，修好 adapter 后重同步即可 |
| vscdb 被运行中的 IDE 锁定 | 复制快照再读；同步时机天然错峰（对话归档不需要实时） |
| 工具输出淹没搜索结果 | content_text 只放摘要，全文留在 content_raw；FTS 只索引 content_text |
| 中文搜索分词 | trigram tokenizer 免分词词典，子串匹配对中英文都有效；索引体积换正确性，量级（个人会话数万条）完全可承受 |
| 大会话（几十 MB jsonl） | 流式逐行解析；单文件重解析在个人数据量下秒级完成 |
| 隐私 | 全本地单库；库文件即备份单位，可选整库加密 |
