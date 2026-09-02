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
| codex | `~/.codex/sessions/**/rollout-*.jsonl`（另有 archived_sessions/） | JSONL rollout | injected-prefix 过滤、turn_context 取模型；function_call / custom_tool_call / mcp_tool_call_end / patch_apply_end 均采集为 tool 消息；官方 reasoning 为加密串无法采集；0.151 起兼容 paginated item_completed 格式；thread_history sqlite 是 rollout 的投影非数据源 |
| copilot | `%APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.jsonl` | 行0全量 + kind:0/1/2 补丁 | kind:2 是数组 APPEND；variableData 图片 |
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

## 数据清理风险与归档建议

- 多个 agent 会主动清理本地会话（VS Code 系 Copilot 定期删 chatSessions/*.jsonl、
  Claude Code 默认 30 天转录、Cursor 老气泡迁移即清）——**常开 serve 让 watcher 实时归档，
  入库才是安全的**
- 加密格式（Antigravity/Windsurf 家族）依赖应用运行时的 daemon 解密：应用在跑时重跑 sync
  可回填；解密结果写 sidecar 缓存，之后离线可读
