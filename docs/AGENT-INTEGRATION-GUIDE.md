# Agent 接入指南

本文沉淀本工具已完成的多 agent 接入经验，供未来接入新 agent 参考。
每个 agent 的数据位置、格式逆向结论、坑与解法都记录在文末《已接入 agent 备忘》。

## 接入流程（五步）

### 1. 侦查数据位置

```bash
# 家目录点开头目录（CLI 系 agent 的惯用位置）
ls -d ~/.xxx*
# APPDATA（IDE 系 agent 的 VS Code fork 惯用位置）
ls ~/AppData/Roaming/ | grep -i <name>
```

判断两个家族：
- **CLI 系**：`~/.<name>/` 下通常直接有 sessions/history/projects 目录，格式多为 JSONL
- **IDE 系**（VS Code fork）：`%APPDATA%/<Name>/User/{globalStorage,workspaceStorage}`，核心是
  `state.vscdb`（SQLite，表 `ItemTable` 键值对 + 可能有 `cursorDiskKV` 大 blob 表）

侦查重点：找**会话正文**存哪（不是 UI 状态）。workspaceStorage 的 vscdb 常常只有面板状态，
正文在 globalStorage 或应用私有目录。

### 2. 逆向格式

按格式族选择策略：

| 格式族 | 识别方法 | 解析策略 |
|---|---|---|
| JSONL（Claude 系） | 首行 JSON 有 uuid/type/message | 逐行 parse，role 映射 |
| SQLite 键值 | .vscdb/.db + ItemTable | 快照拷贝后只读打开，按 key 前缀分组 |
| protobuf | 高熵二进制但有明文 uuid/文本穿插 | 最小 wire 解析器（见 `src/adapters/antigravity-pb.js`），递归 dump 结构 |
| base64(protobuf) | 值以字母开头、解码后 F1 uuid 模式 | 同上 |
| 私有压缩/加密 | 全高熵、无规律 | 见下"加密数据抢救" |

protobuf 逆向技巧：先 dump 顶层字段号+长度，找可读文本（uuid 是 36B 定长、file:/// URI、
中文正文都易于辨认）；**内容字段号常与类型枚举有线性关系**（如 windsurf 的 content = type+5）。

### 3. 实现 adapter

契约（`src/adapters/<name>.js` 导出）：

```js
export const xxxAdapter = {
  id: 'xxx',                       // 与 db.js AGENTS 注册名一致
  watchRoots() { return [...]; },  // fs.watch 递归监控的根目录（数据所在目录的父层）
  discover() { return [...]; },    // [{path, size, mtimeMs}]，sync 按文件指纹增量
  fingerprint,                     // util.js 的（size+mtime；有 -wal 的要并入，参考 cursor.js）
  async parseFile(path) {          // 单文件 → 会话对象 或 会话数组（一个库文件多会话）
    return { agentSessionId, workspacePath, title, createdAt, updatedAt,
             messages: [{role, createdAt, text, model?, effort?, raw}] };
  },
};
```

要点：
- role 取 `user | assistant | thinking | tool | system`（UI 已支持渲染）
- 无逐条时间戳时用会话级时间填充（参考 cursor 的 store.db 源）
- 一个文件多个会话返回数组（sync.js 已支持）；单会话也返回对象即可
- daemon 离线等暂时性无数据：返回 `RETRY_LATER`（util.js），sync 不记指纹、下轮重试
- 注册：`src/sync.js` 的 adapters 数组 + `src/db.js` 的 AGENTS（label/color）

### 4. 验证

```bash
node src/cli.js sync --agent <id>       # 单 agent 同步
node src/cli.js stats                    # 看会话数
node src/cli.js search <关键词>          # 抽查内容
curl localhost:8377/api/sessions?agent=<id>   # API 抽查
```

### 5. 长期运行

serve 启动即 doSync + watcher。watcher 的事件过滤器（`src/watcher.js`）需要覆盖新数据源的
扩展名（现有 `.jsonl/.sqlite/.vscdb/.pb/.trajectory.json`）。windsurf 的 globalStorage 单键
模式（整库一个 fingerprint）天然增量。

## 加密数据抢救（Antigravity/Windsurf 家族经验）

Codeium（Exafunction）系 agent（Antigravity/Windsurf）的原始对话是加密 `.pb`，但有两条路：

1. **daemon RPC**（完整恢复）：应用运行时本地起 `language_server_windows_x64.exe`，
   监听随机 HTTP 端口（日志里有 `listening on random port at X for HTTP`），提供
   `POST /exa.language_server_pb.LanguageServerService/{LoadTrajectory,GetCascadeTrajectory}`
   纯 JSON RPC。IDE daemon 需 `x-codeium-csrf-token` 头（从进程命令行的 `--csrf_token` 提取最可靠，
   新版日志不再记录）。实现见 `src/adapters/antigravity.js` 的 `discoverDaemon`/`fetchTrajectory`：
   三级发现（env > 日志 > 进程扫描+端口探测），403 换候选重试，网络层失败 60s 降级。
   **注意：daemon 只按自己数据目录的 `conversations/<cascadeId>.pb` 找文件，无全局索引**——
   跨数据目录（用 Antigravity 的 daemon 解 Windsurf 的会话）不可行。
2. **摘要缓存**（标题/最近步骤/globalStorage 的 `cachedActiveTrajectory` 明文完整流）：
   summaries pb 结构 `root.F1[]{F1 uuid, F2 payload}`，payload 字段 F1 标题/F3·F7 时间戳/
   F9 工作区/F13 步骤文本/F26 模型枚举。Windsurf 与 Antigravity 差异：payload 内联而非 base64 wrapper。

解密结果按 agy-reader 契约写 `<uuid>.trajectory.json` sidecar（.pb 旁边），daemon 离线后仍可读，
且与开源工具互通。参考 https://github.com/mjacobs/agy-reader（RPC 逆向）、
https://github.com/T-Gojo/ContextBridgeAi（多 IDE 数据位置索引）、
https://github.com/ag-donald/Antigravity-Database-Manager（summary pb schema）。

## 已接入 agent 备忘

| agent | 数据源 | 格式 | 备注 |
|---|---|---|---|
| claude-code | `~/.claude/projects/**/*.jsonl` | JSONL 事件流 | ai-title 行、line 级 effort；thinking 已清空 |
| codex | `~/.codex/sessions/**/rollout-*.jsonl`（另有 archived_sessions/；冷文件可能是 `.jsonl.zst`，同名 `.jsonl` 优先） | JSONL rollout（zstd 流式解压，读前校验帧完整，需 Node ≥ 22.15） | injected-prefix 过滤、turn_context 取模型；function_call / custom_tool_call / mcp_tool_call_end / patch_apply_end 均采集为 tool 消息；官方 reasoning 为加密串无法采集；0.151 起兼容 paginated item_completed 格式；thread_history sqlite 是 rollout 的投影非数据源 |
| copilot | `%APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.jsonl` | 行0全量 + kind:0/1/2 补丁 | kind:2 是数组 APPEND；variableData 图片 |
| copilot（CLI 引擎） | `~/.copilot/session-state/<uuid>/events.jsonl` | 事件流 {type,data,timestamp} | VS Code 1.14x 起取代 chatSessions；标题在 `%APPDATA%/Code/agentSessionData/<id>/session.db` 的 customTitle（经 defaultChatProviderData.sdkSessionId 关联）；图片在 session.binary_asset |
| zcode | `~/.zcode/cli/db/db.sqlite` | SQLite 三表 | db+wal 快照拷贝；一文件多会话 |
| cursor | `globalStorage/state.vscdb` + `~/.cursor/chats/` | cursorDiskKV | composerData 会话 + bubbleId 消息；应用会清理老气泡 |
| antigravity | `~/.gemini/antigravity{,-ide}/conversations/*.pb` + 扩展版 `*.db` | 加密 pb + RPC；.db 为明文 protobuf-in-SQLite | 目录序 backup→antigravity→ide（新覆盖旧）；.db 走本地 wire 解码，无需 daemon |
| windsurf | globalStorage `codeium.windsurf` 键 | base64 pb 摘要 + 明文 activeTrajectory | 多数会话仅存摘要（.pb 已被应用清理），完整对话来自 cachedActiveTrajectory |
| windsurf-next | `~/.codeium/windsurf-next/cascade/*.pb` | 加密 pb + RPC | 开着应用跑 sync 自动解密 |
| kiro | `kiro.kiroagent/workspace-sessions/<b64>/<uuid>.json` + `~/.kiro/sessions/cli/` | JSON | 目录名 base64 解码即 workspace；execution 记录按轮累积 |
| iflow | `~/.iflow/projects/<路径编码>/session-*.jsonl` | JSONL（Claude 同款） | 路径编码的连字符无法完美还原 |
| factory | `~/.factory/...` | JSONL | 同 Claude 族约定 |
| qoder | `~/.qoder-cli/...` | JSONL | 同 Claude 族约定 |
| copilot-chat-open | VS Code globalStorage | JSON | VS Code Copilot Chat 转写 |
| deepseek | `~/.dsh/sessions` + `%APPDATA%/@deepseek-ai/dsh-desktop/dsh-home/sessions` | 多帧 zstd JSONL | 帧边界扫描（RFC 8878）+ node:zlib 逐帧解压；dsh 预览期格式无兼容承诺，指纹版本化应对 |
| workbuddy | `~/.workbuddy/projects/**/*.jsonl` | JSONL 事件流 | `message` 正文、`reasoning`、函数调用和结果分别成行；用户环境注入已剥离，图片从哈希 blob 引用复制归档 |
| pi | `~/.pi/agent/sessions/<cwd 编码>/<时间>_<uuid>.jsonl` | JSONL 条目树 | 首行 `session` 头给 id/cwd；条目带 `id/parentId`（支持回退分支，归档按文件序全量收，不按 leaf 裁剪）；助手消息内 text/thinking/toolCall 混排需拆行；`model_change`/`thinking_level_change` 是状态行，用于兜底 model 与填 effort；远端遥控（chappie）以 model provider 身份接入，ChatGPT 的指令即 assistant 消息（`provider=chappie/model=chatgpt`），其 `chappie.request` 只是触发 turn 的空信号；人在 chatgpt.com 那侧的原始提问不落本地 |
| chatgpt | 官方导出 `~/.chat-vault/imports/chatgpt/**/conversations.json`（`CHATVAULT_CHATGPT_EXPORT` 可加目录） + Chrome 扩展逐个同步落到 `imports/chatgpt/live/<id>.json`（`extensions/chatgpt-sync/` → `POST /api/ingest/chatgpt`） | JSON 会话树（数组或单个） | **唯一的手动快照源**——网页对话不在本地，只能靠「设置 → 数据管控 → 导出数据」补；`mapping` 是 uuid 树，只收 `current_node` 回溯到根的活跃分支（被重新生成顶掉的旧分支是同一句话的另一版本，收进来只会让检索重复）；无工作区；`recipient != all` 与 `code`/`tether_*` 等 content_type 都是工具产物需改判角色；`thoughts`/`reasoning_recap` 是推理摘要；图片按 `asset_pointer` 的 `file-<id>` 前缀在导出目录里查附件（扩展模式下由扩展取好字节、服务端写进 `live/assets/`）；网页 `backend-api/conversation/<id>` 与导出的会话元素同构，因此两条路共用一份解析，ingest 端点只负责落盘后调 `parseFile` |
| codex-cloud | `~/.chat-vault/imports/codex-cloud/live/<thread-id>.json`（Chrome 扩展从 `chatgpt.com/local/<thread-id>` 推送） | JSON 会话树（扩展侧已转换） | 原始数据在 `wss://codex-cloud-backend.chatgpt.com` 的 RPC（`thread/read` + 分页 `thread/items/list`），不是 `/backend-api/conversation`；扩展在页面侧转成同构 mapping 树后，解析**复用** chatgpt 的 `parseConversation`，角色规则只有一份；`userMessage/agentMessage/reasoning/mcpToolCall/subAgentActivity` 分别映射为 user/assistant/thinking/tool×2/tool，未知类型保底成 tool；归档键 `codex-<id>`，独立目录与 chatgpt 的 live 互不扫到；本期不与 `/c/` 对话建立关联 |
| opencode | `$XDG_DATA_HOME/opencode/opencode.db`（缺省 `~/.local/share/opencode`，Windows 同；非稳定渠道 `opencode-<channel>.db`，`OPENCODE_DB` 可改） | SQLite v2：`session_v2` + `session_message`（`data` JSON，11 种 type）+ `session_part` + `blob` | 只读 v2（OpenCode 2 首启会把 1.x 的 session/message/part 迁过来；ZCode 用的是 1.x 布局）；助手 `content` 有 `session_part` 行时以 part 为准（2026-10 起外置，消息里只剩 `[]`）；附件与工具结果文件是 `media:<sha256>` 引用 `blob`，图片按哈希命名、已存在不重写；时间在每一步内钳为不减（text 无自带时间、并行工具调用早于前一个结果）；live 库只读打开 + 单个读事务，失败退回快照；整库一个指纹，`filterSessions` 跳过 updated_at/消息数/标题都没变的会话，免得 OpenCode 每写一条就重建全部会话，`PARSER_VERSION` 升级时不跳过 |

扩展版 Antigravity 的工作区来自 `trajectory_metadata_blob.data`：protobuf `f1.f1` 为 workspace URI，
`f7` 为当前目录 URI 兜底；不能仅依赖工具参数 `Cwd`（新版 `run_command` 不一定提供，无工具会话也需归档）。
该元数据优先于会话里提到的文件或命令目录。`.db` 的指纹含解析版本和 WAL 状态，历史记录会自动回填，
尚未 checkpoint 的更新也可触发同步；监听过滤器同时接受 `.db` / `.db-wal`。

正式标题优先读取 `annotations/<cascade-id>.pbtxt` 的 `title`（含 protobuf text 的 UTF-8 字节转义），
其次读取同级 `conversation_summaries.db` 的 `conversation_summaries.title`，缺失时才回退首条提问。
标题内容参与每个会话的指纹，摘要库缓存随主库/WAL 变化失效；仅更新时间或其他会话的标题不导致
本会话重解析。监听覆盖 `conversations` 的父目录与 `.pbtxt` 文件，因此只重命名也会自动同步。

## 一次工作分在两条会话里（merge 关系）

远程遥控类的接法（ChatGPT 网页 → Chappie → pi）会把一次工作拆成两条会话：提问、
思考、结论在 ChatGPT 那侧，实际执行在 pi 那侧。两边都不完整——pi 侧一条用户消息
都没有（chappie 以 model provider 身份接入，指令走 assistant 通道），ChatGPT 侧则
只有 `[tool:Chappie/bash] <动作标题>` 这样的调用标记，看不到真正跑了什么。

`session_links.kind='merge'` 表示"这两条是同一个对话的两半"，与 reference/
continuation 的"我提到了你"是**不同性质**的关系，所以：

- **读取默认合并**：`getSessionDetail` 对合并组返回按时间交错的一条流，请求组里
  任何一个 id 都拿到完整内容。不做成开关——调用方（尤其是 agent）没有依据判断
  何时该开，给了参数等于把错误推给它。`only=true` 是 UI 的逃生口。
- **不进会话链**：`getSessionLinks` / `getChain` / `getSessionRefTree` 都排除 merge
  边，"引用了哪些对话"保持原意。
- **合并后 seq 不唯一**（两条会话各自从 0 编号），所以消息带 `src_session_id` /
  `src_agent`；`message_flags` 本来就按 `(agent, agent_session_id, seq)` 存，天然正确；
  MCP 的 `around_seq` 会先用 `mergedSeqIndex` 把 (session_id, seq) 翻译成合并流下标，
  否则 search 命中后读上下文会读到完全无关的一段。
- 合并只发生在**读取时**：两条会话在库里各自独立、各自继续增量同步。物理合并会被
  下一次 sync 的幂等重建覆盖（会话是从源文件派生的，合并结果没有源文件对应）。

关联目前手动建立（会话详情页「关联会话」→ 选"合并"）。自动化是可行的：ChatGPT 侧
每条消息的 `metadata.request_id`（`wfr_*`）已入库，`~/.pi/agent/chappie.state.json`
的 `joins` + `bindings` 能把它映射到 pi 的 session uuid。注意那份 state 是**当前状态
不是历史台账**——改绑时 joins 会被清空重建，所以自动建链要么趁映射还在时做，要么
自己落一份快照。

## 数据清理风险与归档建议

- 多个 agent 会主动清理本地会话（VS Code 系 Copilot 定期删 chatSessions/*.jsonl、
  Claude Code 默认 30 天转录、Cursor 老气泡迁移即清）——**常开 serve 让 watcher 实时归档，
  入库才是安全的**
- 加密格式（Antigravity/Windsurf 家族）依赖应用运行时的 daemon 解密：应用在跑时重跑 sync
  可回填；解密结果写 sidecar 缓存，之后离线可读
