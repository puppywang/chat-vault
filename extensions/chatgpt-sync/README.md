# ChatVault ChatGPT Sync（Chrome 扩展）

把你在 ChatGPT 网页版打开的对话，同步进本地 ChatVault。

ChatGPT 网页对话存在 OpenAI 服务端，本地没有副本——这是 ChatVault 接入的所有 Agent 里
唯一一个装了就看不见的。除了官方数据导出，就只有这条路。

## 装

1. Chrome 打开 `chrome://extensions/`，右上角开「开发者模式」
2. 点「加载已解压的扩展程序」，选中本目录（`extensions/chatgpt-sync/`）
3. 确认 ChatVault 在跑：`node src/cli.js serve`（默认端口 8377）

装好后打开任意一个 ChatGPT 对话，几秒内就会入库。扩展图标上出现 ✓ 表示成功，
点图标能看到最近一次的结果、切换自动同步、改端口。

### 0.14.0：CDP 统一迁移至 Chrome Tabs

移除 debugger 权限、CDP 命令透传、性能轨迹与长期流录制通道。浏览器调试统一使用 Chrome Tabs MCP 0.2.0+；普通对话同步、页面测速、Pi 绑定和轻量诊断保留。历史录制文件与离线回放继续可用。

### 0.13.26：列表即时显示当前轮

新建对话尚未收到历史快照时，悬浮列表直接显示计时器已观测到的「当前轮 · 进行中」及同一份测速数据，
结束后保留实测耗时；历史数据到达后按用户消息 ID 合并，避免重复行。历史未加载时明确标注，
不将本页观测到的轮数冒充完整历史，也不为显示列表增加会话读取或改变补读间隔。

源码更新后需重载扩展并刷新目标页面，确认扩展和页面版本均为 `0.13.26`。

### 0.12.2：后台标识关联诊断

仅有 Sonic 后台标识的对话，普通查找会先执行最多三个候选的只读核验，区分入口 placement 不支持、未建立映射和真实读取错误，不再默认全量扫描旧线程。规范化 UUID 不算身份验证；只有独立消息/活动 ID 核对成功才生成可选链接。

查找诊断（0.12.7 起弹窗不再提供导出按钮，可用 MCP `chatgpt_tab_diagnostics` 的 `last_codex_lookup` 查看）记录当前对话最近一次状态与统计；查询摘要保存在扩展本地，不依赖诊断日志开关。对话读取失败单独记录为 `conversation-fetch`。原有深度查找及断点继续保持可用。

源码更新后需重载扩展并刷新目标页，确认“扩展 0.12.2 · 页面 0.12.2 · 已就绪”。上游调用元数据观测独立于浏览器扩展；安装在 Chappie 入口但不会自动重启当前进程。详情见 [0.12.2 关联诊断](../../docs/CHATGPT-CODEX-ASSOCIATION-0.12.2.md)。

### 打开对应的 Codex thread（0.12.1）

在 ChatGPT 对话页点击扩展图标，再点「打开对应 Codex thread」。唯一、已核验且本次扫描无异常的
结果会在新标签页打开 `https://chatgpt.com/local/<thread-id>?hostId=local`。Dots 页使用地址里的 thread ID。
多个结果列出供选择；纯文本或工作目录匹配即使只有一个也只是候选，不自动打开。

**新增两条精确关联证据，均已对照真实账号回包验证：**

- 当前分支用户消息的 `message.id` 等于 Codex `thread/items/list` 中 `userMessage.clientId`。
  不要求首条消息文本相同，也能识别图片消息、同一 Chat 中途产生的新根线程。
- 助手 `metadata.work_activity.groups[].group_id` 的 UUID 前缀等于 Codex item 外层的 `turnId`。
  只接受 `group_id = <turnId>:<item_id>` 且后缀确实存在于组内 `items[].item_id` 的记录；不从普通正文猜 UUID。

2026-10-02 的样本中，9 个云端根线程与 9 条已同步 Chat 建立了 10 条关联，消息 ID 与活动 turn ID 双重吻合。
这不是强制一对一关系：同一 Chat 可含多个根线程，分支 Chat 可继承相同祖先记录。
候选显示关联依据、thread ID、时间及模型；精确证据的 message/turn ID 可在按钮悬停说明中查看。

普通按钮保留协作发送者核验、子 agent 父链追溯的快速路径；缺失时检查当前账号
归档和非归档根线程的开头，按上述精确 ID 查找，再回退到首条完整文本和精确工作目录。
若 Codex 已给出不同的显式 `clientId`，相同文本不能覆盖这个冲突。
「深度查找关联 thread」跳过快速返回，从最新 item 倒序检查历史，合并已核验的直接关系，结果总是列出供选择。
0.12.1 保存每个根线程和目录列表的分页游标、页大小及轮转位置。单批暂停后按钮变为
「继续查找（从上次断点）」，下一次不再从第一页开始；关闭再打开弹窗也可续查。

所有查找仅在点击时执行，不启动或恢复 Codex 任务、不发送模型消息。并发最多 4 路。
普通/深度 inventory 每批最多 80/240 次 RPC、每根每批最多 8/80 页，每批读取时间窗口 20 秒。
普通初始每页 20 条，深度每页 100 条；遇到消息过大才缩小同一游标的页大小。
达到单批请求、时间或页数预算属于正常暂停，不计作 RPC 读取失败；深度模式保留游标供继续。
分页异常、权限或网络错误仍保留真实原因，只重试失败页，不推进到未验证的游标。
显示「已完成 / 总数」「已开始、剩余」「本批 / 累计页数」，不再把开始检查了 9 个线程显示成全部完成。
正常未命中只代表当前账号、实际读取范围内未找到；不会据此断言该 Chat 从未使用过 Codex。

断点只保存在当前页面内存，按登录凭证摘要、对话和用户分支隔离，不持久化凭证或历史正文。
同一轮追加助手/工具消息不会被当作切换分支，说明文字里新增的工作目录也不会清空已读 ID 页。
切换对话、用户分支改变、登录凭证改变、页面刷新或重载会清除或隔离旧进度；空闲 30 分钟后缓存过期。
已完成的查询再次点击时重新检查目录，未更新的根线程不重复下载，更新或新增的线程重新核对。
修复说明见 [0.12.1 预算与断点修复](../../docs/CHATGPT-CODEX-LOOKUP-0.12.1.md)。

按钮共享同模式的在途查找和当前对话已加载快照；关闭同步或耗时显示后仍可复用快照。
切换对话或关闭注入会取消任务，快照更新到不同分支时拒绝迟到的结果。
conversation 接口的 429 继续按 `Retry-After` 等待，缺失时默认 30 秒；已有快照仍可查找。
源代码更新后需要重载扩展并刷新目标页面。0.12.1 弹窗拒绝旧版页面返回的查找结果，提示刷新，避免混用确认规则。

`debug_sonic_thread_id` 仍不能当作 Codex thread ID。当前没有发现能对任意 `/c/` 直接返回根线程的通用接口；
不保证每条 Chat 都有当前账号可读的 Codex 云端记录。技术证据与验证范围见
[Chat/Codex 关联说明](../../docs/CHATGPT-CODEX-RELATIONSHIP.md)。

### 当前稳定性验收（0.10.1）

重载扩展后还需刷新要使用的标签页；弹窗同时显示扩展后台和当前页面脚本版本，二者一致且“已就绪”才代表更新生效。
0.10.0统一页面生命周期、开关和会话归属；0.10.1补齐刷新时历史分批加载的起点校准，避免把“刚渲染出来”当成“刚发送”。
若本轮请求发生在刷新前且没有保存原始指标，显示“缺少原始起点”，不会用刷新或resume请求伪造TTFT。

仓库根目录运行 `npm run verify:chatgpt`，校验语法/版本、回归测试及独立Chrome profile中的两组DOM集成场景。
本地验证不会刷新用户页面，也不能替代实际账号的端到端验收。详见 [稳定性审查](../../docs/CHATGPT-SYNC-REVIEW-0.10.0.md)。

## Codex Cloud（0.13.0）

`https://chatgpt.com/local/<thread-id>?hostId=local` 这类云端 Codex 会话过去不入库——
`conversationId()` 不认这个路由，同步直接报「当前页面不是一个对话」。

现在它作为**独立对话**导入，在 ChatVault 里的类型是 **Codex Cloud**（agent id `codex-cloud`）。
本期不建立与普通 `/c/` 对话的关联关系：同一次工作若两边都有记录，就是两条独立会话。

- **取数不走 `/backend-api/conversation`**：Codex 的数据在
  `wss://codex-cloud-backend.chatgpt.com` 的 RPC 里，用只读的 `thread/read` +
  `thread/items/list`（每页 100，按 `nextCursor` 翻到尾；游标不推进即停）。
  连接复用 `codex-thread.js` 的 `connect`，仍在它的只读方法白名单内。
- **页面侧就转换成 ChatGPT 的 mapping 树**，与 `dots.js` 同一套做法。这样 ChatVault
  服务端不需要第二套解析器——角色与正文的判定规则只有一份。
- **角色映射**（用服务端已支持的 content_type 表达，未新增规则）：

  | Codex item | 落库角色 | 形态 |
  |---|---|---|
  | `userMessage` | user | 正文 |
  | `agentMessage` | assistant | 正文 |
  | `reasoning` | thinking | `thoughts` |
  | `mcpToolCall` | tool ×2 | `[tool:<server>.<tool>]` 调用 + `[tool_result:…]` 结果 |
  | `subAgentActivity` | tool | `[tool:subagent] kind · model · path` |
  | 未知类型 | tool | 保留 JSON 摘要，不静默丢弃 |

- 归档键 `codex-<thread-id>`，与 `/c/` 对话和 `dots-` 互不混用；落盘在
  `~/.chat-vault/imports/codex-cloud/live/`，与 chatgpt 的 live 目录分开。
- `thread.name` 实测可能为空，标题回退到首条用户消息；`thread.cwd` 作为工作区
  （Codex 在远程容器里干活，形如 `/root/xxx`）。
- 与 dots 一样**不写实测耗时**：避免每轮结束都回取一次整条 thread。页面上的计时器与测速不受影响。
- **完成通知（0.13.1）**：以 codex-cloud-backend 推来的 `turn/completed` 为准（page-stream.js 转发），
  不靠停止按钮。你不在看时发「Codex 任务完成 · 用时 …」；页面打开时已在跑的一轮只测到后半段，
  不报用时、也不套最短时长。同一轮只通知一次。

## 怎么工作的

- **取数走网页自己的后端接口** `/backend-api/conversation/<id>`，不是扒 DOM。
  它返回的结构和官方导出里的会话元素同构（`mapping` + `current_node` 的树），
  所以 ChatVault 那边直接复用了导出的解析规则——网页同步和手动导入不会解析出
  两种结果。扒 DOM 则拿不到分支、时间戳和模型名，而且前端一改版就碎。
- 接口要 Bearer token，页面 cookie 换得到（`/api/auth/session`）。
- 图片字节不在对话 JSON 里，只有 `asset_pointer`，扩展另外按 id 取好一起送过来。
- 数据只发往 `http://127.0.0.1:<端口>/api/ingest/chatgpt`，不经任何第三方。

## 同步时机

- 打开/切换到一个对话时（默认开启，可在弹窗里关）
- 标签页重新可见时
- 停在同一个对话里聊，每 2 分钟回补一次（`update_time` 没变就不重传）
- 弹窗里的「立即同步当前对话」强制重传

v0.7.2 减少了页面侧的重复工作：首次打开同一对话只安排一次自动同步；正常看完
的一轮直接使用已观察到的用户消息 id 记录耗时，刷新后接续的轮次仍回查接口；
耗时徽标只在新消息节点出现时补画，长对话的锚点每次重画只扫描一遍。

v0.7.3 修正了“上一轮和下一轮之间停止按钮没有消失”时计时起点沿用上一轮的问题；
徽标与悬浮列表现在同时显示，悬浮列表和实时计时器均可拖动，位置保存在扩展本地设置。

v0.7.4 增加通用 CDP 命令透传（通过 ChatVault MCP 指定会话和 CDP 方法，结果完整落盘，
执行后断开调试器）；实测耗时改存起止时刻，渲染前校验其归属，并拒绝明显串轮的旧数值。
CDP 命令可能修改网页，请只对可信目标使用适合任务的命令。

v0.7.5 根据主 Chrome profile 的 CDP 实测 DOM，增加新版 ChatGPT 页面上的
`data-chatgpt-search-message-ids` 与 `data-chatgpt-selection-message-id` 锚点，
并从 `data-user-message-bubble` 读取当前用户消息 ID；无需依赖已经消失的旧属性。

v0.7.6 在绿色实时计时器和完成后的悬浮列表中增加 `TTFT*` 与 `≈TPS`。两者只基于
当前页面实际看到的助手文本；测速与同步分开开关，复用已有观察器以降低长对话开销。

v0.7.7 修正图片作为最后一个可见回复时缺少结束徽标：如果本轮末尾的思考/状态记录
没有页面节点，就把徽标挂到该轮最后一个实际渲染的消息（例如图片）后；耗时仍按本轮
真实结束时间计算。

v0.7.8 给按需 CDP 网络录制增加 ChatGPT 会话 SSE 原始流采集：对
`/backend-api/f/conversation` 的 `text/event-stream` 响应启用
`Network.streamResourceContent`，网络文件保存 `buffered_data_base64` 和每次
`Network.dataReceived.data_base64`。这用于核对流中是否有服务端 `usage`；
页面上的 TTFT*/≈TPS 暂时仍是 v0.7.6 的可见文本估算值，**尚未切换到网络指标**。

v0.7.9 为 SSE 验证增加 `network_only` 录制模式，最长 120 秒：不运行
Performance Tracing，只保存网络事件和 SSE 原始流，方便先进入录制状态再等待用户
发送一条测试消息。该模式完成后仅返回 `network_path`，不生成 `trace_path`。

v0.8.0 将页面测速改为网络流指标：`document_start` 的 MAIN world 脚本只对会话
SSE 的 `fetch` 克隆响应并解析事件；TTFT 取请求到首个 final 文本片段到达浏览器的
实测时间。TPS 只在服务端流提供 `output_tokens`/`completion_tokens` 时计算；没有
用量就显示 `—`，不再用 DOM 字符估算。测速开关关闭时不为后续页面注册网络 Hook。

v0.8.1 按 SSE 中可取得的全部助手文本计算 `≈TPS`：包括不同通道、推理摘要、
`reasoning_title` 和工具调用文本，
不只最终可见回复；无路径的 `v` 续片也会拼接。每条完整消息交给扩展后台用
`tiktoken` 的 `o200k_base` 分词，再以首段到末段助手文本的到达时间计算速度。
页面主线程不执行 BPE 分词；每次只传当前助手消息快照，而非反复传整轮历史。

v0.9.3 修正浮层拖拽位置在调试器、缩放、分屏或视口高度变化后落到屏幕外的问题：
窗口尺寸变化、页面重新可见时会重新夹紧计时器和历史面板，并把修正后的位置保存下来。

v0.9.4 支持仅按 Chrome tab_id 透传 CDP，排队时保存完整目标 URL，每条命令前重新
验证该 URL。这使 dots 等不使用 `/c/<conversation-id>` 的 ChatGPT 页面也能通过扩展诊断。

v0.9.5 支持直接打开 `/dots/<thread-id>`：先读取 `/backend-api/tbo/by-thread/<id>`
定位 messaging room，再用 rooms/messages（含 before 翻页）取得历史。按 room 成员的
aeon 身份区分 dots 与人类，不使用双方都为 user 的 role。保留原始消息与附件字段，
使用 `dots-<thread-id>` 独立归档键，不与普通 conversation 混用。SPA 切换清理旧面板
和徽标，拒绝旧页面迟到的异步回包。dots 徽标显示消息跨度、最新消息，不宣称后台
任务已结束；新消息锚点出现时刷新数据，只对变化的 dots 输出重新分词。dots `out`
是已送达消息文本的 tiktoken 数，当前整条消息 API 不提供 token 增量，TTFT/TPS 明确
显示无 token 流/增量，不用消息时间戳伪造网络测速。普通对话 SSE/WS 指标不变。

v0.9.6 增加 dots 标签页标题状态：`[活跃/等待回复/正在回复/已暂停] 原题名 · 最新消息摘要`。
只读取当前页面的状态控件、实际可见的输入动画和最后一条消息；不把 active 解释成正在
执行任务，不从回复文字猜测任务完成。页面变更合并到约每秒一次，后台 alarm 每 30 秒
补查，不激活标签页、不连接 CDP、不下载整段历史。独立「Dots 状态和进展显示在标签标题」
开关默认开启；关闭该开关/页面注入或切回普通对话时恢复原题名。标签被 Chrome 丢弃或
页面卡死时无法更新，最近标题只是上次已观察状态，不是后台任务的心跳。

v0.9.7 修正标题状态来源：优先读取当前 dot 底部卡片的动态 `role=status` 文字（例如
「正在思考…」或当前操作），空闲时回退到当前 dot 状态控件的 `aria-describedby`。
不再将最后一条回复当进展，不通过输入动画或用户消息猜状态。收起侧栏不会把它的
有效状态丢掉；没有真实状态则保留原题名，不显示「状态未知」。底部占位节点空闲时
仍被观察，因此文字/role/aria-hidden 的切换不必等待后台 30 秒补查。用同卡片 dot 名称
关联目标，不使用层级序号 XPath，不读取其他 dot、通知或消息已读状态。

v0.9.8 修正初始化中断后计时器永久停在 0.0s：先完成耗时绘制并启动 tick，再初始化
拖动/恢复位置；同时处理 storage 的同步 throw 和 Promise rejection。测速模块异常
不再阻止耗时更新；已创建但尚未启动 tick 的宿主可重新启动。扩展上下文失效时显示
「扩展已重载 · 请刷新页面」，不继续呈现失去采集连接的旧 TPS。只读探针增加模块版本、
计时循环状态、起点及最后一次 UI 异常，便于区分后台版本与页面脚本是否真的已更新。
Dots 当前卡片明确处于隐藏且空的状态占位（侧栏也没有工作状态）时显示「空闲」，
思考/操作和暂停状态仍优先；找不到卡片不假定空闲。重载扩展后需刷新各个正在使用的
ChatGPT/dots 标签页，仅刷新 dots 不会恢复其他普通对话的旧扩展上下文。
`TTFT` 也改为本轮首个助手文本。工具返回不是模型输出，未下发到浏览器的隐藏推理、
图像和结构标记都无法从文本分词补出，因此这不是上游的总 `output_tokens`。

v0.8.2 修正长 Agent 会话的后续正文经 WebSocket `conversation-turn-stream` 下发时
TTFT/TPS 一直为 `—`：在会话 POST 发出时建立同轮观测，合并 SSE 和 WS `stream-item`
中的助手文本，并用 WS `conversation-turn-complete` 标记结束。只读观察，不改写页面
消息；诊断数据增加 `sseFrames`、`wsFrames` 和 `lastFrameAtMs` 以区分未捕获与未生成。

v0.8.3 区分完成后的 SSE 克隆流关闭与真正的读取失败：已经收到完成标记的轮次
不再误记为 `stream_read_failed`，测速数值和分词口径不变。

v0.8.4 将实测的每轮 TTFT、≈TPS、文本 token 数及其时间戳按「对话 ID＋用户消息 ID」
写入扩展的 `chrome.storage.local`。刷新后读取当前会话各轮的已存指标，再绘制悬浮列表
和消息旁徽标；只保存数值与来源，不保存助手正文。`background.js` 的内存不是持久层，
MV3 service worker 可以休眠。仅恢复原本捕获到的结果：刷新前未观测到的请求/片段
不能事后补测；正在回复时刷新也不能凭会话快照推算原始 TTFT 或真实流速。

v0.8.5 增加仅含字段结构与计数的 `eventShapes` 诊断，不记录正文或工具参数；
SSE 克隆流中断但 WS 已接手时，清除 `stream_read_failed` 误报。若收到流帧却
仍有 `textChunks=0`，查看页面探针的 `speed_metrics.active.eventShapes`，
再按实际事件格式修解析器；已错过的流无法通过刷新补算。

v0.9.0 增加完整流录制（0.12.7 起仅经 MCP `start/get/stop_chatgpt_stream_capture`），无固定时长、分批持久化、断网保留
IndexedDB 队列，收到落盘 ACK 后才清理。页面和离线回放共用 `stream-parser.js`，
结束时获取快照逐条对账。空值显示原因。使用与验收见
[迭代说明](../../docs/CHATGPT-STREAM-ITERATION.md)。这版是可重放取证基础，Pro＋Chappie
的缺失正文格式仍以完整真实样本验收。最低 Chrome 120。

v0.9.1 不再仅凭 WS `conversation-turn-complete` 退出录制；必须确认快照里
本轮最终助手消息已经结束。工具 handoff 和 `in_progress` 占位符继续采集。
也兼容 WS 顶层 `message` 快照。旧录制无最终回复证据时明确标记为未验收。

v0.9.2 在实时计时器和历史悬浮列表中增加累计输出量，格式为
`TTFT 34s · 1,234 out · ≈TPS 4.5`。`out` 与 TPS 使用同一个 tiktoken 文本 token
计数，不改用上游 `output_tokens`；上游用量若返回，单独在悬停说明中列出。
仍按已有节流在新增续片到达时约每秒分词，首段、完整消息快照、结束时立即更新；
浮层每 100 ms 检查显示，不增加分词频率、网络请求或页面正文操作。

注意：自动同步意味着**你打开的每个对话都会被归档**。不想要就在弹窗里关掉，
改成只用手动按钮。

弹窗中的开关作用不同：

- **同步到 ChatVault**：总开关。关闭后自动和手动入库都暂停，但内容脚本仍可显示耗时；
  耗时显示本身仍可能读取对话 JSON，不能用这个开关做“完全无扩展”的对照。
- **自动同步**：关闭后不再自动取对话，但仍可手动同步；内容脚本、耗时徽标和诊断探针仍在。
- **页面注入**：关闭后注销后续导航的内容脚本，同步（包括手动）随之暂停；**必须刷新
  已打开的 ChatGPT 标签页**，才能移除已在该页运行的旧脚本。重新打开也要刷新页面才注入。
  这是排查扩展是否影响页面的完整隔离开关。
- **诊断日志**：默认关闭。开启后，将同步阶段、重画耗时、5 秒页面心跳和后台探针写入本机
  `~/.chat-vault/diagnostics/chatgpt-events-YYYY-MM-DD.jsonl`；不会写入对话正文、
  Bearer token 或图片字节。页面注入关闭时只记录后台探针与设置变化。

## 每轮耗时与计时器

打开一个对话，每一轮（你的一条提问 → 下一条提问之前的全部内容）末尾会出现一个
`⏱ 25m11s` 的小徽标；正在跑的那一轮，右下角有个实时走秒的计时器。

- **耗时口径**：本轮最后一条消息的时间 − 你提问的时间。按轮算而不是算整个对话的
  跨度——实测一个 chappie 驱动的对话 3 轮活跃合计 2h37m，而首尾跨度是 14h22m，
  中间那 12 小时是你去睡觉了，算进去没有意义。
- **实测优先**：你在线看着跑完的轮次用计时器实测值；没看全程的历史轮次才回退到接口
  时间戳推算。因为 `create_time` 记的是回答记录**创建**的时刻而不是流式输出**结束**的
  时刻，普通一问一答会系统性偏小——实测某轮真实 3.66s，接口推算只有 1.70s。鼠标悬停
  徽标会写明这条是实测还是推算。
- **锚点**：优先用后端 message id 匹配页面的 `data-message-id`、
  `data-chatgpt-selection-message-id` 或 `data-chatgpt-search-message-ids`；
  这些属性都不存在时才尝试把可见用户消息正文与接口提问唯一匹配。
  无法唯一匹配时不猜位置、不挂错徽标。
- **悬浮总览**：始终与消息旁徽标同时显示；缺少锚点时仍能查看每轮耗时。默认收成右下角一枚
  `⏱ 4 轮 · 7h41m` 小胶囊，点一下展开逐轮明细（v0.12.13 起）。为避免长对话渲染几千个额外节点，
  明细只列最近 20 轮，历史仍保留在会话及消息徽标中。
- **样式隔离**：徽标、面板、计时器全部包在 Shadow DOM 里，ChatGPT 的 CSS 进不来，
  我们的也污染不到它。
- **计时器起点**分三种情形（都实测踩过）：亲眼看见流式开始 → 起点是新消息出现时刻；
  如页面没有消息 id，则异步回查接口，但拒绝上一轮的旧时间戳；页面加载时它已经在跑 →
  问接口拿真实起点，**拿不到消息 id 也要问**——
  刷新时停止按钮往往比消息列表先渲染出来，那一刻一条用户消息都还查不到，而这恰恰
  证明是页面刚加载；接口回填带重试（最多约 16 秒），够等消息列表渲染完（刷新或重进
  对话导致「19:43 发出的一轮只显示 2m10s」，就是这种情形）；停止按钮持续存在但
  新用户消息出现 → 结束旧轮并重置新轮起点。
- **计时器怎么判断"进行中"**：看停止按钮在不在（`[data-testid="stop-button"]` 或
  aria-label 含 Stop/停止）。这一处是 DOM 依赖，ChatGPT 改版可能失效——失效的表现是
  计时器不出现，不影响已完成轮次的耗时徽标。
- 不想要就在弹窗里关掉「在页面上显示每轮耗时」。

### Pro 用量从上次受限恢复时刻起计（v0.13.25）

「账号额度」卡片原先一律按滚动 7 天数 Pro 消息。2026-10-15 用满 50 次、受限到 10-17，恢复后只发了 4 条，却显示
「近 7 天 Pro 约 11/50」——把恢复前的 7 条也算进去了；受限恢复后额度是清零的。`resets_after` 只在受限期间由
conversation/init 返回，恢复后就看不到，所以 ChatVault 把受限期间看到的值记在 `~/.chat-vault/chatgpt-pro-reset.json`，
恢复时刻已过且在 7 天内时从那一刻起计，卡片显示「自 M-DD 恢复后 Pro 约 N/50 次」；超过 7 天改回滚动 7 天。
这次的恢复时刻当时没有记录，补了一条推定值（`source: inferred`，10-17 00:00；恢复前最后一条与恢复后第一条之间取任意时刻计数都相同）。

### 恢复轮询的限频间隔可在弹窗设置（v0.13.24）

弹窗新增「恢复轮询同一对话至少隔几分钟读一次」（`recoveryReadMinMin`，默认 5，范围 0–60，0 = 不限频，缓存照常使用）。
由 `page-state.js` 随页面控制消息下发给 MAIN 世界的 `page-conversation.js`，改了即时生效，无需刷新页面。

### 后台标签页的恢复循环不再占满读取额度（v0.13.23）

2026-10-20 实测：Work 长轮次的对话（75 MB）放在后台标签页，页面的传输恢复循环每轮并发读 `stream_status` 和整段对话，
撞 429 后按 `Retry-After` 约 30 秒一次（服务端给这类轮次下发 `poll_interval_ms=10000`、`poll_freshness_max_mins=240`，
最长 4 小时），把账号的对话读取额度占满，另一个标签页打开对话直接「无法加载此 ChatGPT 对话」。
0.13.17 的「IS_STREAMING 时还给上一份对话」本可挡住这些读取，但缓存上限 32M 字符，对话超过后从不入缓存，悄悄失效。

- 单份缓存上限放宽到 128M 字符，总量按 160M 字符淘汰最旧的。
- 本轮 `stream_status` 为 `IS_STREAMING`、手上又没有可还的缓存时，**同一对话 5 分钟内只放行一次网络读取**，其余直接回
  429（带剩余秒数的 `Retry-After`），页面的恢复循环照它退避。这些读取页面本来就会丢弃，不影响显示；
  本轮结束（`COMPLETE`/`FAILURE`）后读最终结果不受限。诊断里的 `page_capture.recoveryThrottled` 记被挡下的次数。
- 伪造的 429 只作用于那个标签页自己的页面状态（ChatGPT 按标签页记限流门槛），刷新即清。

### 接住服务端渲染预取的对话；本页跑完一轮后补读一次（v0.13.22）

扩展只复用页面自己的读取，但有两种情形页面根本不发 `GET conversations/<id>`，于是弹窗一直「尚未取得对话数据」
（2026-10-19 `6ad629ad` 实测：首页新建、靠推送跑完的一轮，`page_capture` 全 0）：

- **整页打开、服务端渲染预取成功**：对话随 HTML 流下来，放在 React Router 的
  `loaderData['conversation-layout.route'].conversation`（Promise，值为 `{ status:'loaded', conversation }`），
  页面直接用作 `initialResponse`。`page-conversation.js` 现在等这份数据就绪后按分支形态交给 content.js，不发请求。
  预取被限流时值是 `{ status:'rate_limited', retryAfterMs }`，页面会自己再读一次，照常复用。
- **本页新建、全程靠推送跑完的一轮**：结束后页面不会再读这个对话。content.js 在 `turn_end` 同步等不到页面数据时
  补读一次（同一对话 60 秒内至多一次，仍走 429 记账与全局暂停）；撞上正在进行的同步会等它结束再试。

「尚未取得对话数据」的提示也改了：刷新后若预取成功，旧版本反而拿不到数据，现在改为建议在侧边栏切走再切回。

### 超过 64 MiB 的对话分块同步；推送中断提示不再建议点停止（v0.13.21）

- **分块同步**：`chrome.runtime.sendMessage` 单条消息上限 64 MiB。Work 模式的长轮次会让整段对话超过这个数
  （2026-10-19 `6ad3e536` 归档到 65.3 MB 后，每次同步都报 `Message exceeded maximum allowed size of 64MiB`，
  ChatVault 从此停更）。现在内容脚本先序列化，超过 8M 码元就切块（不切开代理对）逐块发给后台，
  后台按 uploadId 拼回后直接上传（`sync-chunks.js`，过期 2 分钟的半截上传自动清理）。
  ChatVault 的 `/api/ingest/chatgpt` 请求体上限也由 64 MB 放宽到 256 MB。
- **推送中断提示**：见下文「推送中断时核对 Codex 轮次」的 0.13.21 更正。

### Pi 会话：从弹窗选目录、起会话、生成连接文案（v0.13.0）

设计见 `docs/PI-SESSION-MANAGER-DESIGN.md`。弹窗新增「Pi 会话」卡片，数据与进程操作都在本机 ChatVault（`/api/pi/*`，只接受回环地址），
扩展只做界面（`pi-panel.js`，经 background 的 `piApi` 转发，页面脚本不能调用）。

- **固定会话 ID**：新建时由 ChatVault 生成 UUID，用 `pi --session-id <uuid> --name "<目录名> · <短id>"` 启动（pi 只要求字母数字和 `-_.`，
  存在就续上、不存在就新建）。连接文案里的会话 UUID 和目录保持不变；「恢复」= 同 ID 再起一次，
  Chappie 的绑定（`chappie.state.json`）仍然有效，原 ChatGPT 对话无需重说连接。
- **连接文案（2026-11-04 精简）**：由后端 `src/pi-sessions.js` 的 `connectText` 统一生成，供插入、复制及新建会话后的复制使用。仅保留一段：
  `请用 Chappie 连接 Pi 会话 <UUID>（目录 <目录>）。先读全局 AGENTS.md，按需读取相关历史；保持指定 Pi，不重复已确认完成的操作，不重复启动同一作业。`
  实际任务的目标、标准和方式由用户填写；范围、持续推进、临时错误重试、离线等待及阶段/收尾回执规则统一在 `~/.pi/agent/AGENTS.md` 维护，不再逐次注入。
  只发送连接文案时确认连接即可。文案不包含具体业务、测试标记、Events 或断线时间表，普通页面断流恢复与五分钟限频保持原样。
  修改文案后需重启 ChatVault 后端，再重新打开弹窗获取；扩展无需为此重载。插入文案本身不会建立订阅，也不证明云端自动唤醒成功。
- **起会话**：在最近使用的 Windows Terminal 窗口里加 tab（`-w 0`，可在设置里改成命名窗口）：`wt -w 0 nt -d <cwd> --title … --suppressApplicationTitle pwsh -NoExit -Command "& pi.cmd …"`；
  `wt.exe` 是应用执行别名，`existsSync` 认不出（stat 报 EACCES），用 `lstat` 判断；没有 wt 时 pwsh 自开独立控制台。前置要求 Chappie broker 在线。
- **停会话**：按 `--session-id` 找到 node 进程，整树结束它所在 tab 的 pwsh（Windows 没有可靠的跨控制台 Ctrl+C；pi 的 jsonl 逐条追加，不丢历史）。
- **在线状态**：读 Chappie broker 落盘的 `~/.pi/agent/chappie.sessions.json`（本地 fork 0.5.1-patch.3 起，带 broker pid，broker 不在一律离线）；
  没有该文件时只按进程判断。登记表在 `~/.chat-vault/pi-sessions.json`（id、cwd、名字、启停时间；窗口名与置顶目录在 `settings`）。
- **目录候选**：各会话目录最新 jsonl 首行 header 的精确 cwd（目录名编码不可逆）+ ChatVault 工作区 + 登记表 + 置顶；可手填路径。
- **历史**：有归档时直接打开 ChatVault UI `#/session/<id>`。
- **插入文案**：content.js 用 `execCommand('insertText')` 写进可见的输入框：ChatGPT 对话页是 `#prompt-textarea`，Codex 页（`/local/`）是裸的
  `div.ProseMirror[role=textbox]`（没有 form、没有 data-placeholder，2026-10-12 实测）；失败退回复制。
- **已连接的 pi 会话**：探针从对话快照里收集出现过的 UUID（连接文案、Chappie 工具参数），弹窗 `POST /api/pi/match` 交给 ChatVault 与
  在线表 / 登记表 / 归档比对，命中的显示在「当前对话」卡片（在线状态、历史、离线可恢复），并选中其目录、在列表里标绿。

部署前提：`ChatVault` 计划任务要从 S4U 改为交互式登录，否则从它里面起的终端窗口不在桌面上。

### 修复 Dot 标题互改锁死渲染进程（v0.12.20）

2026-10-10 Dot 标签页的标题变成「[空闲] [空闲] [空闲] …」，同站的其他 ChatGPT 标签页（共用渲染进程）一起「页面无响应」。
原因：页面里同时有两份标题脚本（扩展重载/重复注入）。各自把对方加过前缀的标题当成原题名再加一层；
标题观察器在回调（微任务）里同步重写，两边互相触发，主线程永远不让出。0.12.18 修好状态识别后，标题才开始真正被写，问题随之暴露。
- 记原题名时先去掉开头所有 `[…] ` 前缀，前缀不再叠加。
- 标题被外部改动时不在观察回调里同步重写，交给 1 秒合并更新。
- 改写限流：1 秒内超过 4 次就暂停 10 秒并记录错误。
- `dots.js`、`dots-title.js`、`speed.js` 补上重复注入保护（同一环境里已有实例就不再起第二份）。

### 打开对话立即显示统计（v0.12.19）

以前要等对话数据到手（先等页面自己的读取最多 6 秒，没等到再下载整段对话，大对话要几 MB）才画浮层和徽标，打开页面会空白一阵。
现在每次用真实数据画完都存一份轮次摘要（`cvTurnsCacheV1:<对话>`：每轮的起止消息 id、时间、条数和最后 4 条消息 id，不含正文；
最多 200 轮、最多 40 个对话，按最近使用淘汰）。下次打开同一对话时先用它画出胶囊和消息徽标，胶囊标「更新中…」；
没有缓存的对话先放「⏱ 加载中…」。真实数据到了照常覆盖重画。缓存画法不会盖回已经画好的真实数据。

### Dot：首条回复用时；思考状态重新显示在标题（v0.12.18）

- **测速**：Dot 的消息整条送达、没有 token 增量，TTFT/TPS 无从计算，原先只显示「无 token 流 · 无 token 增量」。
  现在改为「首条回复 6s · 1,234 out（4 条）」：首条回复 = 你发出消息到 Dot 第一条消息（接口时间戳）；out 与条数是本轮已送达的 Dot 消息。
  等待期间计时器显示「等待首条回复」。
- **标题状态**：2026-10-10 起 Dot 页把状态放进顶部头像卡（`group/orbit-profile`）。名字节点只是 `.truncate`，文字是 Dot 的短名（如「dot」），
  与标题「你的 Dot」对不上，原来的 `group/aeon-status` 控件也没了，所以「正在思考」不再进标题。现在头像卡里的状态区直接认作当前 Dot 的；
  退场后的占位节点会保留上一次的文字（`aria-hidden=true`、无 `role`），按空闲处理。

### 扩展重载后旧标签页停止测速；Codex 页面测速（v0.12.17）

- **重载后旧标签页不再采集**：扩展重载时新旧两份隔离脚本会同时存在一小会儿。旧的在 2 秒心跳里发现失效后会给 MAIN 世界发「关闭」，
  可能晚于新实例的「开启」。之后这个标签页的发送、推流和页面对话响应都不再被采集，表现为 TTFT 一直「等待请求」（2026-10-09，6ac89c1f）。
  现在开关消息带上隔离实例的启动时刻，MAIN 世界只听最新实例的；新实例启动后 3 秒、6 秒各补发一次当前状态，兼容页面里仍在运行的旧版 MAIN 脚本。
- **Codex 页面（`/local/<thread>`）**：解析 codex-cloud-backend 的 JSON-RPC。本页发出的 `turn/start` 是原始起点；
  `item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta` 是文本，首段即 TTFT；按条目分词求和得 ≈TPS；
  `turn/completed` 结束。`thread/tokenUsage/updated` 的累计 `outputTokens` 差值记作本轮 `outputTokens`。只算本页线程，子 agent 线程不计。
  打开页面时这一轮已在跑（没看到 `turn/start`）时只给 ≈TPS，TTFT 标「缺少原始起点」。方法名与参数结构核对自 VS Code Codex 扩展 26.917。
  需要刷新一次已打开的 Codex 页面：旧的 MAIN 脚本已占用标记，补注入不会替换它。

### Dot 新消息提醒（v0.12.16）

Dot 的对话原先不发「回复完成」通知：它的一轮没有结束信号。2026-10-09 实测：消息元数据为空，Dot 状态一直是 `active`，
页面状态区显示「上次活跃：6天前」；每轮是你发消息 → 6–9 秒后一句简短确认 → 几分钟内陆续发进度和结果；Dot 还会主动发消息。
按普通对话的逻辑，通知会在那句确认时就弹出来。

现在改为 `dots-notify.js`：
- 你不在看这个标签页（隐藏或窗口没焦点）时，收集 Dot 新发的消息；**连续静默 3 分钟**（高级设置「Dot 消息静默几秒后提醒」，
  30–3600 秒）才合并成一条通知「Dot 发来 N 条新消息 · 最后一条 HH:MM」，点击跳回该标签页。
- 你发消息后 15 秒内的确认不计；正在看时来的消息不计；静默期内回到页面就取消；往上翻加载的历史（插在已见消息之前）不计。
- 只看消息行的出现和归属（`.message-row[data-message-id]`、`self`），不读正文；受「完成后桌面通知」总开关控制。
- 代价：比实际结束晚约一个静默期；Dot 中途停很久再继续时，一轮可能提醒两次。诊断探针里的 `dots_notify` 可看待发状态。

### 隧道异常时图标角标提示（v0.12.15）

后台每分钟（`chrome.alarms`）读一次同样的 health 接口，结果合成到扩展图标角标上，不用打开弹窗、
也不用等 ChatGPT 报 `Chappie disconnected` 才发现：
- 「断」（红）：隧道未运行；「!」（橙）：未就绪、通道未启用或轮询停滞。悬停图标可看具体原因。
- 角标与同步结果共用，按优先级合成：同步成功闪 ✓ 3 秒 > 隧道「断」> 隧道「!」> 同步失败「!」（红），
  闪完回到隧道状态，不再像以前那样把角标清空。状态存在 `chrome.storage.session`（`cvBadgeV1`），
  service worker 休眠重启后照旧。
- 打开弹窗时读到的结果会立即交给后台刷新角标。端口填 0 时不检查、不显示。
- 判断逻辑在 `tunnel-status.js`（弹窗与后台共用），角标合成在 `badge.js`。

### Chappie 隧道状态（v0.12.14）

弹窗顶部显示本机 otunnel（Chappie 隧道）的状态，只读它的本地 health 接口（默认 `127.0.0.1:8080`，
高级设置可改端口，填 0 不显示）：
- `/health`：存活/就绪、生命周期、运行时长；先核对 `schema_version` 与 `runtime` 结构，避免把占用 8080 的
  其他服务当成隧道。
- `/api/status`：隧道名、`main` 通道（`pi --chappie` 的 PID）。
- `/metrics`：`commands_poll_last_successful_timestamp_seconds`。长轮询 30 秒一轮，超过 90 秒没成功就标「轮询停滞」。
接口无响应即「未运行」。背景：otunnel 遇到上游轮询 403 会直接退出（2026-10-09），计划任务原本不会重拉；
现在 `~/.pi/agent/run-chappie-tunnel.ps1` 带退避自动重启（15s 起翻倍、封顶 5 分钟，连续 8 次短命失败才放弃，
记录在 `logs/chappie-tunnel-supervisor.log`）。

### 交互整体优化（v0.12.13）

- **页面浮层同列**：推送中断提示、每轮总览、实时计时器放进右下角同一列（从上到下），不再互相叠盖，
  也不再有单独压在右上角工具栏下的提示条；三者同一套深色卡片样式。按住胶囊或计时器拖动整列，
  位置按右下角距离记住（`cvFloatDockPositionV1`），展开时向上长、不会掉出屏幕；3px 内的抖动和拖完
  松手都不算点击。旧的独立位置键 `cvTurnPanelPosition` / `cvTurnTimerPosition` 不再使用。
- **总览默认收起**：胶囊显示轮数与合计耗时（进行中的一轮不计入，标「进行中」）；展开状态记在
  `cvTurnPanelOpenV1`。对话里有 Work 轮次时，每行标 `W`（Work / 持久 worker）或 `C`（Chat）；
  已记录 Codex 关联时 Work 行带「Codex ↗」直接打开根线程。全是 Chat 时不画标签。
- **已关联直接打开**：弹窗读到 `cvCodexLinkV1` / `cvWorkRoundV1` 记录的根线程时，按钮显示
  「打开 Codex 会话 · 已关联」，点击直接打开，不再查找；关联可能过期时用下方「重新查找关联」。
  查找核验成功打开后，本次弹窗内即视为已关联。
- **弹窗一张卡片**：对话类型、Codex 用量、本对话同步状态合在「当前对话」卡片里，「打开 Codex」和
  「立即同步」并排在卡片底部；设置类开关的提示也显示在卡片的状态行。

### 扩展更新后自动补注入已打开的标签页（v0.12.12）

扩展安装、更新或在 `chrome://extensions/` 重新加载后，已打开页面里的旧内容脚本与扩展断开（弹窗显示
「页面脚本未运行」，耗时/测速/对话类型都不显示）；动态注册只对之后的导航生效。现在后台在 `onInstalled`
时更新注册后，给所有已打开的 ChatGPT 标签页补注入：
- 先探测隔离环境里是否还留着旧实例；若 Chrome 复用了同一环境，重复执行会撞上顶层声明冲突，此时只提示刷新。
- 否则先注入 MAIN world 脚本（自带标记，已有则不重复包装 fetch/WebSocket），再注入隔离环境脚本。
- 休眠标签页跳过（激活时会重新加载并按注册注入）；结果写入 `lastReinjection`。
弹窗遇到页面无响应时说明原因，并提供「重新注入此标签页（无需刷新）」。

### 同步状态按对话显示；刷新按钮（v0.12.11）

弹窗底部此前读全局唯一的 `last`，显示的是任意标签页最后一次同步。后台现在另按对话写
`cvLastSyncV1:<conversation>`，弹窗只显示当前标签页所在对话的结果；该对话没有记录时说明「尚未同步」，
不借用其他对话；非对话页（如 Codex 页面）才显示全局最近一次并注明。标题旁新增「↻ 刷新」：重新识别
当前标签页（含分屏）、对话类型、Codex 用量与同步状态。

### Codex 线程 token 用量；Chrome 分屏（v0.12.10）

**用量**：Codex 读取接口（`thread/read`、`thread/turns/list`、`thread/items/list`）都不含 token 用量；
用量只在执行与打开线程时由服务端推送 `thread/tokenUsage/updated`（`total` 线程累计、`last` 最近一次请求，
各含输入/缓存输入/缓存写入/输出/推理输出，另附上下文窗口）。`page-conversation.js` 在 Codex 页面
（`chatgpt.com/local/<thread>`）只从 codex-cloud-backend 的 WebSocket 取这条通知的数字，其余消息一概不看；
content.js 按线程合并、按轮次留最后一次累计值，节流写入 `cvCodexUsageV1:<thread>`。子 agent 线程单独记录。
弹窗在 Codex 页面显示该线程累计用量；在 Chat 页面按已知关联（成功打开过的唯一精确结果，或推送中断核对
时确认的线程）显示。只在页面开着、收到推送时记录，不发请求、不 resume 线程；已结束且未在页面打开过的轮次补不回来。

**分屏**：Chrome 分屏（`splitViewId`）下 `active` 不一定是正在操作的一侧。弹窗询问两侧页面最后一次
点击/按键/聚焦的时刻取最近者，顶部列出左右两侧可手动切换；非分屏时行为不变。

### 适配新前端的分支接口；对话类型三档；Codex 连接放宽（v0.12.9）

**新前端改读当前分支**：2026-10-09 实测页面不再请求 `GET /backend-api/conversation/<id>`，而是
`GET /backend-api/conversations/<id>?num_turns=10&include_has_versions=true`，返回当前分支的消息列表
（`messages` + `page_info`，无旁支、可分页）。轮次卡住时页面每 ~15 秒查一次 `stream_status` 并重拉这份
列表（实测单次约 10 MB），这是带宽与 429 的主要来源。0.12.5 的复用只认旧路径，因此从未命中。现在：
- `page-conversation.js` 同时克隆新接口；content.js 把它转成线性分支，用于当前轮 Codex 证据与计时校准，
  分支完整（`has_previous_page=false`）时也用于画耗时和弹窗类型。
- 同步：页面数据显示 `update_time` 与上次上传一致时，不再下载整段对话；变了才下载（保留旁支），
  生成中不随页面轮询下载，且至少间隔 2 分钟。分支形态从不当整段对话上传。

**对话类型三档**：Work（工作活动/子 agent/协作记录，或模型名以 `-wm` 结尾）、持久 worker（只有
`conversation-turn`：普通 Chat 也用过这条通道，未必有 Codex 线程）、Chat。弹窗按此显示，Chat 才隐藏 Codex 入口。

**发送请求字段观测**：记录发送请求里的 `product_experience`、`requested_model_experience`、
`temporal_conversation_turn`、`model` 等字段与顶层字段名（不含正文），按「对话:用户消息」存入扩展本地，
诊断快照 `last_send` 可见；暂不参与判定，积累样本后再决定。

**Codex 连接**：WebSocket 建立与单次读取分开计时，建立等待放宽到 30 秒（实测多数 <3 秒，页面反复下载
大对话时出现过 12 秒），超时提示网络可能拥塞。

### 修正 Work 判定（v0.12.8）

`async_source` 有三种格式，只有 `…:conversation-turn-<id>:…` 是 Work（Codex 执行，出现在用户/助手/工具消息上）；
`…:bon-user-…` 是 Chat 模式 Pro 后台任务（Sonic），`…:ghostrider-…` 是另一类后台任务，都只出现在助手/工具
消息上，背后没有 Codex 线程。0.12.6–0.12.7 把任意 `async_source` 当 Work，导致 `6ac28258` 这类 Sonic Pro
对话被显示为 Work 并走进 Sonic 探测。现只认 `conversation-turn`；`lookup` 对 Work 对话一律走精确 ID 查找，
不再做 Sonic 标识探测。已用本机 36 个对话核对：Sonic Pro 对话全部判为 Chat。

### 弹窗精简与对话类型（v0.12.7）

弹窗按用途分为三块：**当前对话**（对话类型、打开对应 Codex 会话、立即同步）、**页面显示**（每轮耗时、
TTFT/TPS、Dots 标题）、**高级设置**（默认折叠：注入、同步、自动同步、推送中断核对、通知、端口、诊断日志）；
说明文字改为悬停提示。

对话类型在打开弹窗时随页面健康检查一并取得：content.js 用已取到的对话快照逐轮判断（该轮任一消息带
`conversation-turn` 格式的 `async_source`、工作活动、子 agent 或协作记录即为 Work），不额外请求。显示为 Work 模式 / Chat 模式 /
混合（各几轮、最新一轮是哪种）/ Dots；Chat 模式不显示 Codex 入口。尚未取得快照时显示「尚未取得对话数据」。

移除两个低频入口，底层能力保留：「导出最近查找诊断」（查找记录仍存扩展本地，MCP 诊断可读最近一次）、
「完整流录制」（改用 MCP `start/get/stop_chatgpt_stream_capture`）。

### Codex 查找按模式分流（v0.12.6）

ChatGPT 网页有两种执行模式：**Work 模式**（前端代号 tpp，消息带 `async_source`）由 Codex 根线程执行，
能打开对应的 `chatgpt.com/local/<thread>`；**Chat 模式**的 Pro 轮次由 Pro 后台（Sonic，只有
`debug_sonic_thread_id`）执行，背后没有 Codex 线程。此前的深度查找是在不了解这一点时为「找不到」而加的，
对 Chat 模式注定无果，只会消耗最多 240 次请求。

- 分支上没有任何 Work 标记（任一消息带 `conversation-turn` 格式的 `async_source`、工作活动 turnId、子 agent 或协作记录）时直接显示
  「Chat 模式，没有对应的 Codex 线程」，不连接 Codex、不读登录态、不探测 Sonic ID。
- Work 对话的普通查找先只检查创建时间落在 Work 轮次前后 10 分钟内的根线程（根线程在该轮发出后数秒内
  创建，通常 1–3 个），精确 ID 命中即停；窗口内未命中再退回检查全部根线程开头。时间只用来缩小范围，
  是否关联仍只由用户消息 clientId / 工作活动 turnId 精确判定。
- 深度查找改为兜底：弹窗默认隐藏，仅在 Work 对话普通查找未命中或暂停时出现。

### 复用页面自己的对话请求（v0.12.5）

页面打开或刷新对话时，自己会请求一次 `GET /backend-api/conversation/<id>`。此前扩展会在 2 秒后再下载
同一份整段对话（大对话 2–23 MB），实测 6 分钟内 7 次整段下载里 5 次来自扩展。现在 MAIN world 的
`page-conversation.js` 克隆页面那次响应（不改请求、不改交给页面的 Response、不读请求头凭证），交给
content.js 复用：进入对话时先等页面自己的请求（最多 6 秒），60 秒内的页面快照直接用于上传、画耗时和
Codex 证据；页面之后再自己读取时也顺带上传。content.js 在 document_idle 才加载，页面脚本只留最新一份，
报到后交付并释放。页面脚本未应答（旧注册或未刷新）时照旧自行下载。定时回补与其他触发暂未改动。

### 推送中断时核对 Codex 轮次（v0.12.4）

Work 模式（用户消息带 `async_source`）的一轮由 Codex 根线程持久执行，页面只订阅推送。推送断开后，
`/f/conversation/resume` 可能返回 410「Stream cache expired」，`stream_status` 却持续 `IS_STREAMING`，
而 Codex 那边这一轮早已完成——答复只在 Codex 页面里。

停止按钮仍在、且 5 分钟没有新流帧时，扩展只读查询 `stream_status`；仍为 `IS_STREAMING` 且本轮是 Work 模式，
才连接 Codex 读取对应根线程的 turn 状态（`thread/turns/list`）。本轮必须由工作活动 turnId 或用户消息
`clientId` 精确对上才下结论：已完成/失败时在页面右上角提示并给出「打开 Codex」，仍在执行时提示推送已中断；
同时暂停该对话的自动同步，避免反复读取大对话触发 429。流帧恢复、本轮结束或换对话后自动撤销。
Chat 模式（只有 `debug_sonic_thread_id`）背后没有 Codex 轮次，不扫描账号线程。每轮至多主动读一次对话；
本轮证据（只含 ID 与结构字段，不含正文）按对话存在扩展本地存储，刷新后可直接复用。弹窗可关闭此功能。

2026-10-18 补充：**拿不到 Codex 结论时不再默不作声**。核对失败（`LOOKUP_NO_MATCH` 等）、找不到本轮证据、
Chat 模式或被限流时原本一条提示都不给，于是页面推送与 Codex 一起卡死可以静默几个小时（当天 13:30 起的一轮
直到手动刷新才暴露）。现在只要停止按钮仍在、页面静默满 15 分钟，就给一条通用提示
「页面推送已中断 · 已 Nm 无新内容」，并附「刷新」按钮——刷新让 ChatGPT 按服务端状态重绘。该提示可手动关闭，
流帧恢复或本轮结束时自动撤销；它不接管自动同步（不读 Codex，没有 429 压力），长时间工具调用本来就可能没有流帧，
此时直接关掉即可。

0.13.21 更正：提示里删掉了「刷新后仍停在这一轮就用停止按钮结束本轮」。2026-10-19 实测 `6ad3e536` 这一轮
页面静默数小时，而 Work 模式的执行一直在推进（Pi 执行端持续收到工具调用），服务端对话记录甚至比实际执行
滞后一个多小时——此时点停止会取消仍在工作的任务。提示改为以执行端会话的进展为准，并明确不要点停止。

### 网络流测速（v0.9.2）

- `TTFT` 是本次会话 POST 请求发出，到首个助手文本 SSE/WS 片段到达浏览器的时间。
  它不同于网络首包 TTFB，也不等于模型内部首 token 时间；刷新后才接入的轮次显示 `—`。
  v0.12.3 起，“是否续接”以网络证据为准：Hook 只拦截原始发送 POST（刷新后的
  `/f/conversation/resume` 不匹配），所以本页观测到同一用户消息 ID 的请求即为原始起点。
  新对话从 `/` 跳到 `/c/<id>`、回复期间切走再切回，不再被页面结构判成续接而显示
  “缺少原始起点”；只有本页确实没见过该消息的原始 POST 时才这样显示。
- `≈TPS` 对 SSE/WS 中所有助手文本分别用 `o200k_base` 分词后求和，再除以首段至末段
  助手文本的到达耗时；它会统计发往 Chappie 的助手文本，但不统计 Chappie 返回的内容。
  部分 Chappie 调用在网页会话流里只留下标题/端点、没有完整载荷，无法统计缺失的参数。
  如果浏览器没有收到某类隐藏输出，或模型使用不同词表，结果仍低于或偏离真实模型用量。
  单片输出或没有助手文本时显示 `—`。扩展只把当前消息文本交给自身后台分词，
  不把分词快照上传到 ChatVault。
- `out` 是上述 TPS 分子对应的累计文本 token 数，显示完整整数并加千位分隔符；
  未完成分词或未捕获到结果时显示 `— out`，不把未知值冒充 0。
  实时计时器和完成轮次的悬浮列表使用相同格式，刷新后恢复已有的分词计数。
  分词随新文本约每秒更新，不是固定每秒猜一个新数值；暂停输出期间保持最近结果。
- 测速开关默认开启，可在弹窗中关闭。MAIN world Hook 观察 ChatGPT 会话 POST 的
  克隆 SSE 和 WS 消息，不常驻附加 CDP 调试器；开关更改后需刷新标签页才能完全应用注入状态。
- 本页实时测到的每轮数值会写入浏览器扩展本地存储，完成后 F5 可恢复显示。
  这与只保存轮次总耗时的 `turnDurations` 独立；换浏览器/清除扩展数据不会自动迁移。
- 2026-09-29 实测的 148 个 SSE 帧和 25 个 WS 接收帧均未含输出 token 用量；
  流末尾虽有私有 `server_ttfvt_ms` 字段，但不将它冒充官方用量或客户端首字时间。

修改分词器依赖或词表后，在本目录执行 `npm ci`、`npm run build:tokenizer`，
再从 `chrome://extensions/` 重载扩展并刷新 ChatGPT 标签页。

长对话是懒加载的，往上滚出现新消息时会自动补画徽标；流式输出期间不重画（那会儿
DOM 每秒变动几十次，而且这一轮还没结束也没有耗时可标），等这一轮结束再统一补。

## 浏览器调试与长期录制（已迁至 Chrome Tabs）

从 0.14.0 起，本扩展只负责对话同步、页面指标和轻量诊断，不再申请 debugger 权限或执行 CDP。
CDP 透传、性能轨迹和完整 SSE/WS 长期录制统一使用独立的 Chrome Tabs MCP 0.2.0+。
在 Chrome Tabs 弹窗按标题/URL 筛选并勾选目标标签页，再通过 list_tabs、attach_tab、send_cdp / evaluate_script 调试。
长期录制使用 start_capture；get_capture、stop_capture、read_capture_events / read_capture_file 查看和导出。
录制的 IndexedDB 队列和磁盘批次由 Chrome Tabs 管理；本扩展原有历史诊断文件仍保留，可继续离线回放。
具体用法见 [流录制说明](../../docs/CHATGPT-STREAM-ITERATION.md)。

## 为什么只有扩展能写入

`/api/ingest/chatgpt` 刻意不发 CORS 头。扩展的 background 有 `host_permissions`，
不受 CORS 约束；而普通网页要跨源发 `application/json` 必须先过预检，拿不到 CORS 头
就发不出来——等于随手打开的网页没法往你库里塞东西。

## 出问题时

### 卡顿定位日志（v0.7.0）

先在弹窗打开“诊断日志”，确认弹窗显示了 JSONL 文件路径；若显示尚未落盘，重启
ChatVault 服务后重试。每次同步都有 `run_id`：`sync.start`、`conversation.fetch/json`、
`render.paint_*`、`background.send`、`serialize`、`upload`、`ingest` 等阶段能沿同一 ID
核对。`heartbeat` 每 5 秒记录事件循环延迟、JS heap、DOM 变动和长任务汇总；后台
`tab_probe` 在页面无响应时仍会继续落盘。只看最后一条 `start` 不能直接断定因果，
要结合后续缺失的 `end`、页面探针和预先启动的 CDP 轨迹判断。

做无扩展对照时先关闭“页面注入”，等弹窗提示注册已更新，**再刷新同一对话页**。
只关闭“自动同步”或“同步到 ChatVault”不足以排除内容脚本。诊断日志关闭不影响正常同步。

### 只读页面诊断

扩展 v0.5.0 起，后台约每 30 秒检查扩展所在 Chrome profile 里打开的 ChatGPT 标签页，
用最多 2 秒向页面内容脚本取一次轻量状态；不会调用对话 API、不会同步正文。
ChatVault MCP 工具 `chatgpt_tab_diagnostics` 可按 ChatVault `session_id`、ChatGPT
`conversation_id` 或 Chrome `tab_id` 筛选。返回标签页标题/URL、探针响应或超时、
已渲染消息数、页面 JS heap（浏览器支持时）、最后成功响应时刻和快照新鲜度。

这能区分“页面 renderer 未响应”与“扩展后台也停止上报”，但不能从扩展里读到
Chrome renderer 的总进程内存、CPU，也不能仅凭一次超时证明 ChatGPT 前端的具体原因。
若整个浏览器挂起，快照会变成 `stale`；若刚重载扩展但旧页面尚未刷新，探针可能是
`unavailable`，刷新该标签页后内容脚本才会重新注入。

更新后需要在 `chrome://extensions/` 重载此扩展，重启 ChatVault `serve`，并在 MCP
客户端刷新 ChatVault 的工具列表。扩展的“自动同步”开关不会关闭此诊断探针。

可用本地 MCP 请求测试：`chatgpt_tab_diagnostics({"session_id":2055})`。

### CDP 轨迹与网络取证

在 Chrome Tabs 中先共享并 attach 目标标签页。start_capture 的 options.trace=true 同时记录性能事件；默认只录制网络。
如需刷新，通过 send_cdp 显式执行 Page.reload；不会自动刷新。结束后调用 stop_capture，等待 get_capture 的终态和待传事件归零。
已撤销的旧工具 start/get_chatgpt_cdp_command、start/get_chatgpt_cdp_trace 和 start/get/stop_chatgpt_stream_capture 不再出现在 ChatVault MCP 中。

弹窗里会直接显示原因。最常见的两个：

- **连不上 ChatVault** —— serve 没开，或端口不是 8377（弹窗里改）
- **当前未登录 ChatGPT** —— 网页那边掉登录了，刷新重登

其它异常在 ChatGPT 页面的控制台里以 `[ChatVault]` 开头。ChatVault 那侧每次写入都
记在日志里（`~/.chat-vault/logs/`，`[ingest]` 开头）。

## 已知限制

- 只收当前分支：重新生成顶掉的旧回答不入库（和官方导出的处理一致）
- `backend-api` 是 OpenAI 的私有接口，没有兼容承诺，改版可能失效
