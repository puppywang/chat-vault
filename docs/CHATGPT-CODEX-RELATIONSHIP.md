# ChatGPT Chat 与 Codex 云端 thread 的关联

> **0.12.6 更新（2026-10-09）**：ChatGPT 网页分 Work 模式（`async_source`，Codex 根线程执行）与 Chat 模式（Pro 走 Sonic，
> 无 Codex 线程）。下文 2091 中查不到的 `6abad0ac` / `6abb9197` 属于 Chat 模式，并非证据藏在历史深处。查找现按模式分流：
> Chat 模式直接说明无 Codex 线程；Work 模式先查创建时间在 Work 轮次附近的根线程，精确 ID 命中即停；深度查找降为兜底。
> 详见 [扩展说明](../extensions/chatgpt-sync/README.md)。
>
> 当前扩展版本为 0.12.1。预算暂停、断点续查及当前地址的复查见 [0.12.1 修复记录](CHATGPT-CODEX-LOOKUP-0.12.1.md)。下文保留 0.12.0 的关联研究与历史验收记录。

## 0.12.0 交付记录（历史）

- 延续 ChatVault 2091 的研究，不重做已有 0.11.3 功能。
- 扩展版本：0.12.0。实现目录：`extensions/chatgpt-sync/`。
- 本轮新增：用户消息 ID / 工作活动 turn ID 精确关联、多关联候选、有限额的只读深度查找、显式不完整状态、弱候选确认、旧页面模块版本检查。
- 没有修改 ChatVault 数据库、没有启动/恢复/发送 Codex 任务，没有重载用户正在进行的对话。

## 一、已验证的关系

### 1. 用户消息 ID 是跨视图的精确关联证据

```text
ChatGPT 当前分支：mapping[node].message.id（可见 user 消息）
                              =
Codex thread/items/list：data[row].item.clientId（userMessage）
```

这里只把 `clientId` 与 ChatGPT 消息 ID 比较。Codex item 自己的 `id` 是另一个 ID，
ChatGPT conversation UUID、Codex thread UUID、Codex turn UUID 也不能互换。

真实样本：

```text
Chat conversation: 6ab12a88-b654-83ec-b94f-02e4022102b9
Chat user message: 587b15f2-7b11-4c24-a493-c58465c50584
Codex root thread: 01a0c40e-6e82-7033-8301-b436bf06d0ad
Codex userMessage.clientId: 587b15f2-7b11-4c24-a493-c58465c50584
```

这条证据不依赖文字相同，所以可支持图片用户消息，也不会把相同提示词的独立消息直接视为同一对话。
如果已返回的 Codex `clientId` 不同，不能用相同文本抵消这个身份冲突。

### 2. 工作活动提供 Codex turn ID

```text
Chat assistant metadata.work_activity.groups[].group_id
    = <Codex turnId> + ':' + <activity item_id>
Codex thread/items/list.data[row].turnId
    = 上述 UUID 前缀
```

必须同时满足：来源是 assistant 的结构化 `work_activity`、前缀为 UUID、分隔符为冒号、
后缀等于同一组 `items[].item_id`。普通正文、用户粘贴的 JSON、无关同名字段不算关联证据。

第一份样本的 turn ID 为 `01a0c40e-8ebf-7533-8cd0-8a9a38741a15`；
其 group 后缀与 `exec-e8b02ea0-917a-454c-9ea8-8e54af2174b7` 活动 item 对应。

### 3. 关系不是固定一对一

2026-10-02 的只读采样列出当前账号 9 个 `originator=chatgpt_cca` 根线程。
与本机已同步 Chat 的当前分支核对，得到 9 条不同 Chat 与这些根线程之间的 10 条关联。
全部 10 条关系同时满足用户消息 ID 与工作活动 turn ID 的对应。

其中一条 Chat 关联两个根线程；该 Chat 与另一条分支 Chat 又共享其中一个祖先根线程。
因此“已关联”不自动表示这个根线程只属于这一条 Chat，也不必然表示它仍是当前执行线程。
不读取 `mapping` 中未在 `current_node → parent` 链上的旁支。

## 二、扩展行为

### 普通按钮：打开对应 Codex thread

1. 核验当前分支结构化协作发送者，去重返回全部读到的主 thread。
2. 缺失时追溯最新可读的子 agent 父链。URL 使用 `thread.id`，不盲用共享 `sessionId`。
3. 无直接关系时，对当前账号的归档与非归档根线程检查开头，优先匹配用户消息 ID 或活动 turn ID。
4. 缺少精确证据时才保留首条完整文本和精确 cwd 的候选。

唯一、已验证且扫描没有异常的结果才自动打开。多个结果、弱候选、扫描未完成均要求选择。
元数据快速结果只说明当前分支里已核验的关系，不表示穷尽了账号全部历史；需要进一步检查时用深度入口。

### 深度按钮：深度查找关联 thread

不在找到直接元数据关系时提前结束；扫描各根线程后续 item 页，并合并已验证的直接关系。
扫描某根线程后找到一条精确关联即可停止该根的继续读取，因为目标是定位关联线程，而不是下载整段历史。
深度模式始终展示结果供用户选择，不自动导航。

现行限额是资源保护，不是“无匹配”的判据：

| 项目 | 普通 inventory | 深度 inventory |
| --- | --- | --- |
| 总 RPC 预算 | 80 | 240 |
| 每个根线程最大 item 页数 | 8 | 80 |
| 并发请求 | 最多 4 | 最多 4 |
| 初始 item 页大小 | 20 | 20 |

`decoded message length too large` 才在同一游标缩小页大小。列表去重、归档扫描、分页游标推进均校验。
达到请求/页数预算、错误回包、无权限、网络失败等会标记 `LOOKUP_INCOMPLETE`，保留失败阶段及原因。
正常无匹配标记 `LOOKUP_NO_MATCH`，并注明实际读取的是根线程开头还是有限额历史。
没有持久化账号/消息索引或凭证缓存，避免在不同登录账号之间混用查询结果。

## 三、明确不做的事

- 不把 `debug_sonic_thread_id` 改写成 Codex URL。
- 不按模型名、标题、创建时间接近来猜线程归属。
- 不把首条文本相同或 cwd 相同升级成身份验证。
- 不调用 `thread/resume`、`thread/start`、`turn/start` 等写入/执行方法。
- 不把当前账号未返回、当前读取范围未命中等同于“历史上不存在 Codex thread”。

2091 中两条旧失败对话 `6abad0ac-6cc4-83ec-a4fc-68ddea3afd92` 和
`6abb9197-9dfc-83ec-81ec-bb48f66b140c`，本轮根线程开头采样仍未命中。
它们的已同步当前分支分别有 32/13 个可见用户消息 ID、均无可用工作活动 turn ID。
这不是全历史不存在性证明，也未将这两条记录伪称为已解决。

这些网页私有字段来自实际回包观察，而不是稳定的公开兼容性承诺。接口变化时要回到回包证据，
不能用扩大正则或放松身份检查来掩盖错误。

## 四、验证记录

### 本地测试

执行 `npm run verify:chatgpt`：

- 22 个扩展脚本语法与版本校验通过，版本一致为 0.12.0。
- 全仓 167 项 Node 测试全部通过，包括 65 项 Codex 相关测试。
- 两组原有独立 Chrome DOM 场景通过：普通历史加载、分批历史加载。
- 新增独立 Chrome popup 场景通过：精确结果打开、弱单候选确认、多候选深度查找及覆盖率、长 ID 换行、旧模块拒绝、失败原因保留；无页面异常。

完整日志：`C:/Temp/cv-codex-20261002/full-verification.log`。
全仓回归还更新了旧 popup 测试夹具，以及与现行服务端契约不一致的 Dots 诊断断言。
没有为此改变 Dots 服务端实现；新断言同时校验顶层路由 ID、页面普通 conversation_id=null、独立 dots 归档键与筛选。

### 真实账号、新模块验证

将本次实际 `codex-thread.js` 放入独立函数作用域，通过用户已登录页面建立只读 WebSocket；
没有替换页面中的扩展对象，没有刷新或导航用户标签页。
使用真实同步快照的当前分支构建 ID-only / work-turn-only 输入，移除文本、cwd 和协作回退，
分别验证两条新增关系。20 个用例全部符合预期：18 个正向输入，2 个旧失败对话的范围明确的未匹配输入。
探针内部只在本次连接内复用 RPC，实际发出 11 次读取 RPC；探针结束关闭连接。
这证明新解析器对真实接口和真实关联字段可用，但不等同于用户主 profile 已重载新版 popup。

本机证据：

```text
C:/Temp/cv-codex-20261002/live-binding-evidence.json
C:/Temp/cv-codex-20261002/live-module-verification.json
C:/Temp/cv-codex-20261002/verify-live.mjs
C:/Users/example/.chat-vault/diagnostics/chatgpt-cdp-command-9692e5e7-684b-480e-91d3-94bdfc8bf183.json
C:/Users/example/.chat-vault/diagnostics/chatgpt-cdp-command-648da4ee-e186-49f0-ad10-b6a22381921b.json
```

证据仅在本机，不含登录 token。切勿把浏览器 auth 回包、HAR 或对话正文复制进公共版本库。

## 五、生效与回退

源代码已更新，不代表已打开页面里的旧脚本自动变更。重载扩展后刷新要使用的目标页，
确认 popup 底部「扩展 0.12.0 · 页面 0.12.0 · 已就绪」。正在生成的页面应等生成完成后再刷新。

本轮修改前的扩展核心文件备份：`C:/Temp/cv-codex-20261002/before/extensions/chatgpt-sync/`。
工作区原有大量未提交改动，本轮没有 reset、清理、提交或 push。
