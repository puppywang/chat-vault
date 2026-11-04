# Pi 会话管理：从扩展里选目录、起会话、生成连接文案（设计稿）

状态：设计，未实现。2026-10-11。

## 现状与痛点

当前工作流（手工）：

1. Windows Terminal 开 tab → `cd` 到项目目录 → `& 'C:\Users\example\.pi\bin\pi.cmd' --provider chappie --model chatgpt`。
2. 在 pi 里 `/session` 看会话 ID。
3. 到 chatgpt.com 新开对话，手打「请用 Chappie 连接 xxxx 的对话」。
4. 重启电脑后以上全部重来；ChatGPT 对话里记的会话 ID 对应的 pi 进程已经没了。

痛点集中在两处：**会话 ID 是 pi 随机生成的**（每次重启都变，ChatGPT 侧的绑定随之失效），以及**目录 → 会话 → ChatGPT 对话这条关系没有人维护**。

## 已有能力（实现时直接复用，不另造）

| 能力 | 在哪 | 对本方案的意义 |
|---|---|---|
| `pi --session-id <uuid>` 「exact project session ID, creating it if missing」；`--name`；`--session-dir` | pi CLI | **会话 ID 可以由我们预先生成并固定**。重启后用同一个 ID 再起一次 = 同一个会话、同一段历史、同一句连接文案。|
| Chappie MCP `init(sessionId)` / `sessions`（按 cwd/name 找） | `~/.pi/agent/src/chappie/src/server.ts` | ChatGPT 侧用 UUID 精确连接；也能按目录名/会话名找。|
| Chappie broker 绑定持久化 `chappie.state.json`（chatId → sessionId） | `~/.pi/agent/` | 会话以同一 ID 重新上线后，原 ChatGPT 对话 `init` 不带参数即可复用绑定。|
| broker 在线会话表 `listSessions()`（id/cwd/name/status/device/bindingCount） | `broker.ts` | 在线状态的唯一可靠来源，目前只对 ChatGPT 暴露（MCP）。|
| ChatVault 服务（127.0.0.1:8377，计划任务 `ChatVault`）+ pi 适配器 + 全文检索 + UI（hash 路由、分页） | `agent-exporter` | **历史查看已经有了**（pi 会话按 jsonl 增量归档，UI 分页不卡）；扩展已与它通信。|
| `list_workspaces`（按归档会话统计的项目目录） | ChatVault MCP/API | 「选择一个现有目录」的候选列表。|
| 扩展弹窗已显示隧道状态（0.12.15） | chatgpt-sync | 起会话前的前置检查。|
| pi jsonl 里的 `chappie.notice joined` 带 `requestId: wfr_…`；ChatGPT 消息 metadata 也有 `request_id: wfr_…` | 数据侧 | 可把 **pi 会话 ↔ ChatGPT 对话** 关联起来（第二阶段）。|

## 总体结构

```
chatgpt-sync 扩展（弹窗 / 管理页）
   │ 127.0.0.1:8377  （已有通道）
   ▼
ChatVault 服务  新增模块 src/pi-sessions.js
   ├─ 目录候选：list_workspaces + ~/.pi/agent/sessions/ 目录名解码 + 用户手填
   ├─ 启动：wt.exe 新 tab → pwsh → pi.cmd --provider chappie --model chatgpt --session-id <uuid> --name <名>
   ├─ 登记：~/.chat-vault/pi-sessions.json  {id, cwd, name, pid, startedAt, …}
   ├─ 在线状态：读 broker 落盘的 ~/.pi/agent/chappie.sessions.json（见下）
   ├─ 停止：按会话 ID 找到 pi 进程树，整树结束（tab 随之关闭）
   └─ 历史：按 pi 会话 UUID 反查 ChatVault session_id → UI 链接
Chappie broker（本地 fork，patch/pi-only）
   └─ 新增：会话表变动时落盘 chappie.sessions.json（~20 行）
```

扩展本身不能起进程，所以「起会话 / 停会话」必须经 ChatVault 服务。这是现成的本机守护进程，不再新加一个。

## 关键设计点

### 1. 固定会话 ID（解决重启问题的核心）

- 新建时由 ChatVault 生成 UUID，用 `--session-id` 启动。文件落在 `~/.pi/agent/sessions/<cwd 编码>/<时间>_<uuid>.jsonl`。
- 连接文案：`请用 Chappie 连接 Pi 会话 <uuid>（目录 D:\...\promotion-server-go）`。
- 「恢复」= 用同一个 `--session-id` 再起一次：历史续上，ChatGPT 侧绑定仍然有效，连接目标不用改。
- 连接文案由后端 `connectText` 统一生成，引导读取全局 AGENTS.md 和原会话历史；超时先核实结果再做有界重试，保留原会话目标和收尾回执。2026-10-29 已撤回 Events 订阅与自动唤醒要求。
- 会话名 `--name "<目录名> · <uuid 前 4 位>"`，ChatGPT 的 `sessions` 工具按名字也能找到，所以口头说「连接 promotion-server-go 那个」也行。

需在实现前验证：`--session-id` 是否接受 v4 UUID（pi 自己生成的是 v7 形态 `01a1…`）。不接受就生成 v7。

### 2. 在线状态来源：broker 落盘（fork 小补丁）

broker 的 `#sessions` 是唯一知道「谁在线、cwd、名字、是否在执行、绑定了几个 chat」的地方。在 fork 里加一处：`sync` / `unregister` / 状态变化时去抖 500ms 写 `~/.pi/agent/chappie.sessions.json`：

```json
{ "updatedAt": "...", "sessions": [ { "id": "...", "cwd": "D:\\...", "name": "...", "status": "idle|running|…", "device": "DESKTOP-…", "bindingCount": 2 } ] }
```

这样手工在终端起的会话也能被看到（不只扩展起的）。补丁方式沿用 `install-chappie-upstream-observer.mjs` 的做法：锚点校验、备份、可重复执行。文件不存在时 ChatVault 退回「只认自己起的、按 pid 判存活」。

### 3. 起会话：Windows Terminal + 进程树

```
%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe -w chatvault nt -d "<cwd>" --title "<名>" --suppressApplicationTitle ^
  pwsh -NoLogo -NoExit -Command "& 'C:\Users\example\.pi\bin\pi.cmd' --provider chappie --model chatgpt --session-id <uuid> --name '<名>'"
```

- `-w chatvault`：所有 pi tab 归到一个命名窗口；可配置为 `-w 0`（当前窗口）。
- 用 `spawn` 传参数数组，不拼 shell 字符串；cwd 必须是存在的目录；只允许 127.0.0.1 调用（服务已如此）。
- 启动后 3 秒内按命令行里的 `--session-id <uuid>` 找到 node 进程 pid 及其父 pwsh pid，写入登记表。
- 前置检查：隧道/broker 在线（复用 0.12.15 的 health 读取），不在线直接提示，不起会话。

**必须改一处计划任务**：`ChatVault` 任务现在是 `LogonType=S4U`（非交互会话），从它里面起 wt 不会出现在桌面上。改成 Interactive（和隧道任务 `Chappie Tunnel` 一样）。代价：未登录时 ChatVault 不运行；对桌面工具可接受。

### 4. 停会话

Windows 下没有可靠的「发 Ctrl+C 给别的控制台」。做法：按 uuid 找到 node pid → 其父 pwsh pid → `taskkill /T /F`。

- pi 的 jsonl 是逐条追加的（ChatVault 就靠这个增量归档），强杀不丢历史。
- broker 收到 socket 关闭即注销；ChatGPT 侧绑定保留，下次「恢复」自动续上。
- tab 随 pwsh 退出而关闭。

### 5. 目录候选

- `list_workspaces` 里 agent 含 pi 的目录（按最近活跃排序）。
- `~/.pi/agent/sessions/` 下的目录名解码（`--D--Projects-example-app--` → `D:\Projects\example-app`）。
- 手填路径（服务端校验存在）。扩展页面拿不到本机绝对路径（File System Access API 只给句柄），所以不用系统目录选择器。
- 收藏/置顶若干目录，存 `chrome.storage.local`。

### 6. 扩展界面

**弹窗「当前对话」卡片下新增「Pi 会话」块**（保持弹窗克制）：
- 当前目录选择（下拉：收藏 + 最近）；该目录在线会话列表（名字、运行状态、绑定数）。
- 每行：「复制连接文案」「插入到输入框」「历史」「停止」。
- 「新建会话」按钮：用选中目录起一个，起好后文案自动进剪贴板/输入框。
- 「插入到输入框」：对 `#prompt-textarea`（ProseMirror）用 `execCommand('insertText')`；失败就退回复制。

**管理页 `pi.html`**（扩展内独立标签页；需要常驻再考虑 Chrome 侧边栏）：
- 全部会话表：目录 / 名字 / 状态 / 启动时间 / 绑定的 ChatGPT 对话 / 操作（历史、停止、恢复）。
- 「恢复上次在线的全部会话」：重启后一键把登记表里上次在线的会话按原 ID 全部拉起。
- 未纳管会话（终端手起的）也列出（来自 broker 落盘），可「停止」，不可「恢复」（没有登记 cwd 时例外）。

### 7. 历史查看

直接用 ChatVault UI：扩展拿到 pi 会话 UUID → `GET /api/sessions?agent=pi&agent_session_id=<uuid>` 反查 session_id → 打开 `http://127.0.0.1:8377/#/session/<id>`（具体 hash 路由以 ui/app.js 为准）。UI 已分页，不会出现 pi web 消息多就卡的问题。

### 8. ChatGPT 对话 ↔ pi 会话 关联（第二阶段）

- 直接途径：`chappie.state.json` 的 bindings 是 ChatGPT 内部 chatId（`v1/…`），不是 `/c/` UUID，不能直接对上。
- 可行途径：pi jsonl 里 `ChatGPT xxxx joined` 通知带 `requestId: wfr_…`；扩展同步的 ChatGPT 对话消息里 metadata 也有同一个 `wfr_…`。ChatVault 入库时按 wfr 建索引，就能在管理页显示「这个会话连着哪几个 ChatGPT 对话」，在 ChatGPT 对话页的胶囊里显示「已连接 pi：promotion-server-go · a3f2」。

## 分阶段

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | fork：broker 落盘会话表；ChatVault：`/api/pi/{workspaces,sessions,launch,stop,history-link}` + 登记表；`ChatVault` 任务改 Interactive；弹窗「Pi 会话」块（选目录、新建、复制/插入文案、停止、历史） | 半天到一天 |
| P1 | 管理页 `pi.html`；重启后「恢复全部」；未纳管会话展示 | 半天 |
| P2 | wfr 关联（对话 ↔ 会话双向展示）；侧边栏；新建对话时顺带处理 Work/Chat 模式提醒 | 按需 |

## 风险与待验证

1. `--session-id` 对 v4 UUID 的接受度（P0 第一步验证）。
2. 强杀 pi 进程：确认 jsonl 最后一条不会半截（实现时做一次「正在执行工具时停止」的测试，ChatVault 适配器本来就容忍坏行）。
3. `ChatVault` 任务改 Interactive 后，未登录期间不再归档；MCP 调用方都是本机登录后使用，影响可忽略。
4. wt 的 `-w chatvault` 在该窗口被用户关掉后会新建窗口，行为正常。
5. 不做的事：不改 pi 本体；不碰 Chappie 协议；不在扩展里重做历史查看器。
