# Chat/Codex 关联诊断与上游观测：0.12.2

## 本轮范围与事实边界

目标为 Chat `6abad0ac-6cc4-83ec-a4fc-68ddea3afd92`。沿用此前成功的读取记录，不再全量扫描原来的九个线程。
此前六个规范化 Sonic 候选被当前后端以 placement version 1/3 拒绝，不能当成正确映射，也不能推断不存在其他后台线程。

本轮源代码核对发现，本机 Chappie 的 `src/server.ts` 能接收原始 `_meta`，但 `handle` 之后给 Broker/Pi 的实际参数只保留 `openai/session` 和 `otunnel/requestId`。Pi MCP adapter 在下游重建工具请求元数据；从该处拿到的局部 call/session ID 不能充当云端 ID。

目标快照中的 Chappie 工具消息保存 `metadata.request_id = wfr_...`，而 Pi 历史中的 requestId 带有 `/operation` 后缀。这提供工作流上下文的候选关联，不是已经证明同一次 MCP call。新相关器明确标记 `same-workflow-not-same-call`，不会生成可打开 URL。

## 浏览器扩展

- 新增 `codex-association.js`。仅从当前分支助手/工具的结构化 `debug_sonic_thread_id` 提取候选，不从正文、用户粘贴的 JSON 或旁支抓 ID。
- 普通查找保持已有强证据优先；只有缺少协作/子代理/工作活动证据的 Sonic 对话才进入有限关联诊断。
- 只检查最新三个不同候选；只规范化前缀与连字符，不修改 UUID 位，不猜 region/host。
- 独立区分 `route-unsupported`、`mapping-unavailable`、`read-error`、`no-match`、`paused`、`matched`。
- 规范化候选即使可读，也必须在对应 `chatgpt_cca` 根线程的有限首尾 item 页中核验当前分支 `userMessage.clientId` 或工作活动 turn ID，才成为可选关联；不自动导航。
- 现有深度查找与断点继续完全保留，只有明确点击深度入口才检查目录历史。
- `codex-lookup-journal.js` 在扩展本地存储保存最近 30 次、两天内的查询摘要，不依赖诊断日志开关。持久化失败不覆盖原查找结果。
- 新增“导出最近查找诊断”。仅保存状态、统计、版本及关联标识，无正文、工具结果、原始 `_meta` 或 token。
- 页面轻量探针附带本页最近一次摘要，已存在的本机探针文件也可查看它。
- conversation 请求 500 等记录为 `stage=conversation-fetch`，不与 Codex 入口错误混淆。

## Chappie 上游入口

`src/codex-upstream-observer.js` 为独立、失败不阻断的只读观测器。安装器只针对本地 fork 的 `@zetaloop/chappie 0.5.1-patch.N`（2026-10-08 起运行版本为 patch.2，见 `~/.pi/agent/src/chappie` 分支 `patch/pi-only`；上游 1.x 不支持），在 `requireChatId` 与取消检查之后、传入 Broker 之前记录被明确允许的关联字段。

记录目录：`~/.chat-vault/diagnostics/codex-upstream-metadata.jsonl`，最多当前文件及一份轮转文件，各约 512 KiB。旧当前文件在两天未更新后下一次写入时轮转；这是大小有界日志，不是自动按两天删除全部历史的保留策略。

保留 threadId、sessionId、callId、requestId 各自的命名空间；缺少上游 threadId 时标为 `upstream-thread-id-not-supplied`，绝不拿 Pi sessionId 替代。上游 session 与账号采用摘要关联。未知元数据只统计键数，不持久化值。所有记录均 `verified=false`。

```sh
node scripts/install-chappie-upstream-observer.mjs --chappie-dir "C:/Users/example/.pi/agent/local-packages/chappie-0.5.1-patch.2"
# 明确安装；原 server.ts 自动备份，重复安装会拒绝，不主动重启 Pi：
node scripts/install-chappie-upstream-observer.mjs --chappie-dir "C:/Users/example/.pi/agent/local-packages/chappie-0.5.1-patch.2" --apply
node scripts/inspect-codex-upstream.mjs --conversation-file "C:/Users/example/.chat-vault/imports/chatgpt/live/6abad0ac-6cc4-83ec-a4fc-68ddea3afd92.json"
```

安装源码不等于正在运行的 Chappie 已激活观测；既有进程不热重载。真实上游请求是否带有云端 threadId，要以重载后产生的观测为准。当前 Chat 的请求不能冒充目标 Syncbridge Chat 的请求。

## 核验与回退

扩展重载后刷新目标页，确认后台与页面均为 0.12.2；查找批次之间无需刷新。
本轮不主动刷新正在工作的页面、不重启运行中的 Chappie、不启动或恢复 Codex、不发送模型消息、不提交或 push 工作区。

Chappie 回退：确认不存在其他修改后，将 `src/server.ts.before-codex-observer` 原样恢复到 `src/server.ts`，删除新增的 `src/codex-upstream-observer.js` 与 `.d.ts`，然后在适当时机重载 Pi。
扩展备份及现场验收另存 `C:/Temp/cv-association-20261005/`。

测试区分模拟输入与真实回包，最终目标是否可读由现场验收记录决定；不得将单元测试通过写成目标已经定位成功。

## 最终核验记录

- 216 项 Node 回归全部通过，24 个扩展脚本语法和版本检查通过；三组独立 Chrome 场景通过。
- 真实弹窗的诊断导出已单独验证：生成当前对话的 JSON，无页面异常。
- 本轮未刷新或打断已切换到其他工作的原目标标签页。先前的精确标签页校验拒绝了请求，随后使用本任务对话作为只读传输入口。
- 目标候选来自最后成功保存的 Syncbridge 对话快照，不是本轮重新下载的最新目标快照。
- 当前真实 Codex Cloud 核验只执行三次候选 thread/read，读取历史页为零；两个候选被 placement version 3 拒绝，第三个被 placement region 6 拒绝。
- 临时探针已清理，实际核验的两个模块与发布源码 SHA-256 一致。
- 本轮没有验证出目标可读线程。Chappie 入口钩子已安装、原文件已备份且哈希核验通过，但运行中的 Pi/Chappie 未重载，目标上游观测日志尚未产生。
- 浏览器最后观测仍为 0.12.1，源码 0.12.2 需要重新加载扩展并刷新页面才生效；上游入口观测需要另行重载对应 Pi/Chappie。

汇总记录：`C:/Temp/cv-association-20261005/release-summary.json`。
