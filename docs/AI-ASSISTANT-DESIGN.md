# AI 助手设计方案（Ask agent-exporter）

在工具内提供对话式 agent：用自然语言查询对话库——"哪个对话有未完成的任务？"
"我去年在哪个工具里讨论过 MCP？""把 X 项目的会话总结一下"。

LLM 使用本地部署的 qwen 3.8-27b（OpenAI chat-completions 兼容格式），
数据不出本机（查询工具直接读本地 SQLite）。

## 架构

```
UI 聊天抽屉（右下角浮动按钮展开）
   │  POST /api/ask  (SSE 流式)
   ▼
server.js ──► agent.js（工具循环）
                │  构造消息：system prompt（库概况+工具说明）+ 对话历史 + 用户问题
                ▼
             llm.js ──► 本地 qwen /v1/chat/completions（tools=function calling）
                │ tool_calls
                ▼
             工具层（白名单 SQL 查询，复用 src/query.js + 新增任务状态扫描）
                │ 结果回填 → 继续循环（上限 8 轮）→ 最终回答（markdown）
                ▼
             UI 渲染：折叠展示每轮"🔍 搜索 xxx → N 条结果"，最终答案含会话跳转链接
```

## 查询工具集（LLM 可调用）

| 工具 | 参数 | 说明 |
|---|---|---|
| `search_messages` | query, agent?, workspace_path?, limit? | FTS 全文搜索（现成 `searchMessages`），返回会话标题+片段 |
| `list_sessions` | agent?, workspace_path?, since?, until?, limit? | 会话列表（现成 `listSessions` 扩展时间过滤） |
| `read_session` | session_id, start?, count? | 读某会话消息正文（单次截断 ~8K 字符，防止上下文爆炸） |
| `library_stats` | — | 各 agent 会话/消息量、时间范围（现成 `stats`） |
| `find_task_states` | status?, limit? | **新增**：扫描 tool 消息中的 todo/任务清单状态 |

### 未完成任务检测（find_task_states 的实现依据）

各 agent 的任务清单都落在工具消息正文里，已在库中可检索：
- Antigravity / Windsurf：`todo_list` 工具的 `{"todos":[{"content":..., "status":"pending"|"in_progress"|"completed"}]}`
- Claude Code：TodoWrite 工具的 todos 数组
- Codex：plan 工具更新

实现：`messages` 表 `content_text LIKE '%"todos"%'`（或含 `todo_list`）的 tool 消息，
正则提取 todos JSON，按 status 过滤（默认 pending + in_progress），
连同会话标题/时间/工作区返回。SQL 全表扫描约 22 万条 <1s，可接受；
如慢则加 `messages(tool)` 索引或入库时物化一张 `task_items` 表（v2 优化）。

## 后端组件

- **`src/llm.js`**：OpenAI 兼容客户端。`chat(messages, {tools})` → fetch `POST {baseUrl}/v1/chat/completions`
  （stream 可选）。配置：`~/.agent-exporter/config.json`
  `{ "llm": { "baseUrl": "http://127.0.0.1:8000/v1", "apiKey": "optional", "model": "qwen3.8-27b" } }`，
  环境变量 `AE_LLM_BASE_URL/AE_LLM_MODEL` 覆盖。超时 120s、温度 0.2。
- **`src/agent.js`**：`runAgent(db, {question, history})`：
  system prompt 注入库概况（10 个 agent、会话数、时间范围、工作区示例）与工具使用指引
  （"先 search 再 read，多关键词换搜，回答附 session id"）；循环执行 tool_calls 直到无调用或 8 轮上限；
  每轮产出 `{type:'tool', name, args, brief}` 事件供 UI 展示过程。
- **`server.js`**：`POST /api/ask`（SSE：`data: {"type":"tool"|"delta"|"done"}`）；
  工具执行全部走白名单参数化 SQL，无任意 SQL 注入面。

## UI

- 列表页右下角浮动 💬 按钮 → 右侧聊天抽屉（可收起，宽 420px）
- 消息流：用户问题 / 工具调用卡片（折叠，`🔍 search_messages("MCP 协议") → 12 条`）/
  最终 markdown 回答；回答中的 `#/session/<id>` 渲染为可点击跳转链接
- 多轮上下文保留在抽屉内；清空按钮重置

## 实施状态（2026-08-22）

v1 已全部实现并验证，另有两处超出原方案的增强：

- **轮数上限 30 + 可中断**：SSE 连接断开（用户点 ⏹ 或关页面）即通过 AbortSignal 级联
  中止进行中的 LLM 请求与工具循环；中断后已完成的检索步骤保留展示，不写入对话历史。
  轮数耗尽时强制无工具收尾（"基于已有检索结果回答"），保证总有回答。
- **对话归档（2026-08-22 补）**：抽屉里的问答原先只存浏览器内存，刷新即丢。现服务端在
  `/api/ask` 流结束时把每次问答（question / answer / 检索步骤 / status：done|aborted|error）
  写入 `ai_chats` 表；`GET /api/ai/history?limit=N` 返回最近归档。抽屉首次打开时拉取最近
  20 条恢复显示，并用最近 4 组 done 问答重建多轮上下文。🗑 清空只清当前视图，归档保留。
- **已知问题**：qwen3.8-27b 检索欲强，模糊问题可能用满轮数（每轮 1-3 次检索均正常耗时）；
  网关 provider 偶发 auth_unavailable（重试即可），AE_LLM_MODEL 可临时切 qwen3.5-9b。

## 分期

- **v1（已实现）**：上述全链路，纯文本问答
- **v2**：多模态——聊天框贴图（qwen 3.8-27b 视觉）：截图找相似对话（图片描述 → FTS）、
  会话内图片参与回答；`task_items` 物化表 + 入库时提取
- **v3（可选）**：定时扫描未完成任务、新会话摘要打标

## 风险与对策

- 27B 本地模型 function calling 质量：工具描述写详细 + few-shot 提示；qwen 若不支持
  parallel tool calls 则串行执行（实现已按串行设计，兼容性最好）
- 上下文长度：read_session 强截断 + 工具结果限 20 条/次
- 隐私：全链路本地（模型本地、数据本地），仅返回查询结果给模型
