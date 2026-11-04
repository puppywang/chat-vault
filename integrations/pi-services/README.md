# pi-services：Pi 的后台服务与作业管理

给「调用返回后还要继续运行」的进程一个有登记、可查、可停的家：Web 服务、审核工作台、队列、批处理作业、探针。
Pi 模型直接用；经 Chappie 接入的 ChatGPT 用 `call` 调用；用户在 Pi 里用 `/services` 查看和管理。

本扩展管理 Pi 本机直接启动的进程。已有受管服务沿用原管理方式；远端服务先检查目标机器已有组件和现有部署方式，由 agent 根据任务需要选择合适的方案，不需要再用本地 `service_*` 包装 SSH。工具缺失时先核对实际工具目录，在用户授权内选择目标机可用的受管方案或有界前台执行，不能自行分离无人监管的进程。部署记录需保留主机、服务名、配置位置、状态/日志/停止命令及实际健康检查结果。

## 为什么要有它

2026-10-19 的 GOAL 续作里，ChatGPT（Work 模式）经 Chappie 在 Pi 上用自写的 `run_hidden.py` 把工作台（:28743）、
评测服务（:28745）和几十个批处理作业以「隐藏 + 分离」方式拉起。Pi 只看到一条 `bash … (no output)`；父进程退出后
这些进程成了孤儿——谁在跑、端口归谁、日志在哪、该不该停，用户和下一个 agent 都无从知道。Pi 自带的 `bash` 是
前台执行、带超时，也没有进程登记表。

## 工具

| 工具 | 用途 |
|---|---|
| `service_start` | 按名字启动常驻服务（`kind:"service"`，等端口/健康检查就绪才返回，失败按 on-failure 退避重启）或一次性作业（`kind:"job"`，立即返回，**必须有 TTL**，默认 6 小时，到期连同子进程一起结束） |
| `service_list` | 列出服务与作业：状态、PID、端口、健康检查、运行时长、退出码、TTL 剩余、日志路径 |
| `service_wait` | 等作业结束或服务就绪（每次最多 55 秒，超时返回当前状态，可反复调用），附日志尾部 |
| `service_logs` | 读日志尾部（默认 60 行，最多 400 行，可按 `contains` 过滤，结果限长） |
| `service_stop` / `service_restart` | 结束整个进程树并确认已退出；按登记的命令、目录、端口重启 |
| `service_adopt` | 按 PID 或端口接管已在运行的进程；记录进程创建时刻，之后防 PID 复用误杀；带 `cwd` 时可 `service_restart` 转为受管 |
| `service_forget` | 移除已结束的登记（含日志） |

经 Chappie 的 ChatGPT 调用示例：

```json
{ "calls": [ { "name": "service_start", "arguments": {
  "name": "gt-workbench",
  "command": ["C:/…/python.exe", "-X", "utf8", "workbench/server.py", "--catalog", "workbench/catalog.json", "--port", "28743"],
  "cwd": "D:/Projects/review-workbench",
  "port": 28743, "healthUrl": "http://127.0.0.1:28743/healthz",
  "description": "GT 批量审核工作台" } } ] }
```

一次性作业（替代 `run_hidden.py --launch job.json` + 轮询 `status.json`）：

```json
{ "calls": [ { "name": "service_start", "arguments": {
  "name": "publish-v5", "kind": "job", "ttlSeconds": 2100,
  "command": ["python.exe", "D:/…/publish-live-v5.py"], "cwd": "D:/…/gt-w96-delivery-20261011" } } ] }
```

随后 `service_wait({"name":"publish-v5"})` 直到 `done`，拿到退出码和日志尾部。

## 给用户的

- `/services`：在编辑器上方显示服务面板（每 20 秒刷新），`/services hide` 关闭
- `/services stop|restart|logs|forget <名字>`：不带名字时弹出选择；停止和重启前会确认
- 状态栏常驻 `⚙ 服务 N`；有服务失去监管进程时标黄

## 实现

```
<登记目录>/<名字>/      默认 ~/.pi/agent/services，可用环境变量 PI_SERVICES_HOME 改
  spec.json            启动规格（命令、目录、端口、健康检查、TTL、重启策略、由哪个会话启动）
  state.json           运行状态与心跳（由监管进程写）
  out.log              子进程 stdout+stderr（超过 20 MB 轮转一次）
  stop                 停止标记：监管进程看到后不再重启
```

- `lib/supervisor.js`：每个受管服务一个隐藏、分离的 node 监管进程，独立于 Pi 会话存活；拉起子进程（隐藏窗口），
  写状态与心跳，执行 TTL 和重启策略，记录退出码。
- `lib/core.js`：登记表与操作。监管进程失联时，按 PID + 命令行判断子进程是「孤儿仍在跑」还是「已死」。
- `lib/platform.js`：`taskkill /T /F` 结束进程树、PowerShell 查询进程身份与端口归属——全部带超时、隐藏窗口。
- `lib/register.js`：工具、命令、状态栏；TypeBox 由入口 `extensions/services.js` 从 Pi 宿主包传入，`lib/` 不依赖 Pi，可单测。

在 `~/.pi/agent/settings.json` 的 `packages` 里登记本目录即可加载；修改后重启 Pi 会话生效。
测试：`node --test test/pi-services.test.js`（真实进程，Windows 上覆盖接管；本机装了 Pi 时用其 typebox 校验工具参数）。
