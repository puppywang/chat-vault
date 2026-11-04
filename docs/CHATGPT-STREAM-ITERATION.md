# ChatGPT 流测速的迭代与验收

## 当前录制入口：Chrome Tabs MCP 0.2.0+

ChatVault 0.14.0 扩展已移除全部 CDP 功能，原有网页同步、页面 hook、测速和轻量诊断继续使用。
所有 CDP 调试与完整 SSE/WS 录制统一由 Chrome Tabs 完成：

1. 在 Chrome Tabs 弹窗按标题和 URL 过滤，勾选目标页。
2. list_profiles / list_tabs 后 attach_tab；传入其 session_id 调用 start_capture。
3. 默认不刷新、不限录制时长。options.url_contains 可筛选请求；options.trace=true 同时采集性能事件。
4. 对 ChatGPT 可设置 options.chatgpt_completion=true，在观察到本轮用户请求后核验最终助手快照再自动停止；工具 handoff 不结束录制。也可手动 stop_capture。
5. get_capture 检查磁盘终态、gaps 和 extension.pending_events；正常停止且无缺口才是完整传输。round_complete 另需最终助手快照证据。

取消 MCP 调试会话不影响已启动录制。桥接断开期间事件先写入扩展 IndexedDB，重连后分块补传；磁盘 fsync+原子提交后才 ACK。取消共享、跨站导航、关闭标签页会结束录制并记录原因。worker 重启恢复会标记可能缺失的区间；不会悄悄重启被用户撤销的 debugger。

新数据目录：C:\Projects\chrome-tab-mcp\data\captures\<capture_id>。
每个目录包含 manifest.json 和有序 batch-<first>-<last>.jsonl；read_capture_events 分页查看，过大的单个事件通过 read_capture_file 分段无损读取。
老数据仍在 %USERPROFILE%\.chat-vault\diagnostics\stream-captures，历史文件无需迁移或删除。

'transport_complete' 只表示已正常停止、无已知缺口；云端是否结束另看 'round_complete'。原始数据仅落在本机。Chrome Tabs 图标 OFF / ON / DBG / REC / ! 区分未共享、已共享、调试、录制和桥接离线。

## 离线回放

```powershell
node scripts/replay-chatgpt-stream.mjs 'C:\Users\example\.chat-vault\diagnostics\stream-captures\<capture_id>'
```

旧的 `chatgpt-network-*.json` 也可回放，但短时窗口通常不能作为完整样本。标准输出只显示摘要，完整输出和全部差异写入报告文件。

页面 hook 与回放共同使用 `extensions/chatgpt-sync/stream-parser.js`，不复制另一份解析逻辑。按每条完整助手消息使用后台相同的 `o200k_base` 分词器再求和，包含已下发的分析/工具调用文本，不包含工具返回或未下发的隐藏内容。TPS 为首段到末段助手文本之间的平均输出速度，包含工具等待。

CDP 初次启用流读取时已存在于 `bufferedData` 的文本缺少精确原始到达时刻；报告会标记 `first_text_buffered`，不伪造精确 TTFT/TPS。其完整文本仍可用于解析和 token 对账。页面原始 hook 的时刻可在下一步交叉核对。

## 验收标准

每个兼容性修复应添加一份可重复的真实失败流作为回归输入，并满足：

1. 原始请求、SSE/WS 顺序和结束事件有证据；序号连续且无缺口。
2. 每条助手消息与结束快照对账；所有文本/token 差异要么消失，要么有明确的协议转换规则。未经解释的 24-token 差异不能算通过。
3. TTFT 时间来源明确，重放结果稳定；缓冲和缺失起点不能显示为实测。
4. 普通 SSE、长 WS、Chappie、图片结尾、F5 与断线重连各有真实验收记录。
5. 页面徽标/浮层与回放口径一致，完成后 F5 恢复已存数值；空值有原因。

工程测试：`node --test`。持久队列测试额外需要 `npm --prefix extensions/chatgpt-sync install` 中的开发依赖 `fake-indexeddb`；不进入扩展运行时。

## 2026-09-30 真实失败样本

录制 `dde2f62a-ca96-477b-aebd-69f7a3482063`，会话 `6abad0ac-6cc4-83ec-a4fc-68ddea3afd92`：完整原始数据保存在上述本机目录，705 条事件，约 62 MB，无已知序号缺口。

POST 于 04:13:15.840 到达；04:13:24.391 收到 WS 完成通知；0.9.0 在 04:13:30.564 停止。结束快照的当前节点却是工具 `e5331bb9-8e69-40e4-a146-43ade34132a8`，`status=in_progress`，无本轮最终助手消息。停止条件确实错误；0.9.1 回放将该样本判为 `transport_completed_unverified`，不把它当作 TTFT/TPS 验收通过。

```powershell
node scripts/inspect-chatgpt-stream.mjs 'C:\Users\example\.chat-vault\diagnostics\stream-captures\dde2f62a-ca96-477b-aebd-69f7a3482063'
```

检查脚本只输出结构和时序摘要；原始帧、快照保持完整。页面探针还观察到后续 WS 的顶层 `message` 形状，0.9.1 解析器同时支持顶层 `message` 与旧 `v.message`；实际文本/token 仍需新的完整录制对账。
