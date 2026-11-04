# 部署 ChatVault

ChatVault 是运行在你自己的机器上的 Node.js 应用，Web UI、SQLite 和 MCP 在同一进程内提供服务。

## 环境与首次启动

- Node.js >= 22.19，命令行执行 `node --version` 检查。
- 支持 Windows、macOS、Linux；只扫描当前运行账号能够读取的会话目录。
- 核心应用没有需要安装的 npm 依赖，也没有前端构建步骤。

```sh
git clone https://github.com/puppywang/chat-vault.git
cd chat-vault
node bin/chat-vault.js serve --port 8377
```

打开 http://127.0.0.1:8377。`serve` 自动同步并监听来源目录，首次同步完成后即可搜索。默认数据库为 `~/.chat-vault/chat-vault.db`，可用 `--db /path/to/archive.db` 指定其他位置。

使用 Release 安装时：

```sh
npm install -g https://github.com/puppywang/chat-vault/releases/latest/download/chat-vault.tgz
chat-vault serve --port 8377
```

## 常驻运行

优先使用机器已有的服务管理方式，保留工作目录、日志和停止入口。

### Windows

源码或发行包目录提供计划任务安装脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
Get-ScheduledTask -TaskName ChatVault
```

安装器使用当前 Node 路径及安装目录注册任务，具备管理员权限时尝试开机启动，否则使用登录后隐藏启动。它会接管默认 8377 端口；安装前确认端口上运行的是准备交接的 ChatVault。停止和取消开机自启：

```powershell
Stop-ScheduledTask -TaskName ChatVault
Unregister-ScheduledTask -TaskName ChatVault -Confirm:$false
```

隐藏启动器的子进程可能仍在运行，停止后通过 `Get-NetTCPConnection -LocalPort 8377 -State Listen` 核对端口，确认归属后再结束对应 ChatVault 进程。

### Linux 示例

以下是可按实际路径调整的 systemd 用户服务示例：

```ini
[Unit]
Description=ChatVault conversation archive
After=network.target

[Service]
WorkingDirectory=%h/apps/chat-vault
ExecStart=/usr/bin/node %h/apps/chat-vault/bin/chat-vault.js serve --port 8377
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

保存到 `~/.config/systemd/user/chatvault.service`，确认 Node 路径后运行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now chatvault
systemctl --user status chatvault
journalctl --user -u chatvault -n 50
```

macOS 可将相同启动命令配置到 launchd。无需为 ChatVault 专门安装另一套服务管理器。

## 跨机器访问

远程服务扫描的是远端机器的会话。需要集中归档时，将所需导出文件复制到远端的导入目录，或在对应机器分别运行 ChatVault。不要把远端服务误当成本地磁盘读取器。

推荐用 SSH 转发访问远程的回环监听：

```sh
ssh -N -L 8377:127.0.0.1:8377 archive-host
```

然后访问本机 http://127.0.0.1:8377，并给同机 Agent 配置 `http://127.0.0.1:8377/mcp`。

局域网监听可在设置里开启，重启生效。应用默认不提供多用户账户隔离；需要共享时自行配置认证、HTTPS 和网络访问限制。运行时任务与审批接口仅供本机使用，不能通过开放 LAN 监听启用。

## 浏览器扩展

从 Release 下载 `chatgpt-sync.zip` 并解压，或使用源码中的 `extensions/chatgpt-sync/`。在 `chrome://extensions` 开启开发者模式，加载解压后的目录。扩展默认将浏览器对话发送到本机 `127.0.0.1:8377`；如需修改地址，在扩展设置中配置。

浏览器扩展无需另行安装 npm 依赖。扩展源码的 tokenizer 已包含可直接使用的构建产物；只有修改 tokenizer 时才需要安装其开发依赖并重新构建。

## 升级

1. 备份 `~/.chat-vault/`，包括导入文件、图片及配置；密钥另行保管。
2. 停止由你部署的 ChatVault 进程。
3. Release 安装重跑安装命令；源码安装更新到经过确认的发行 tag。
4. 启动服务并检查 `/healthz`、搜索及同步状态。已有配置与数据库保留，迁移由应用执行。
5. 扩展有更新时，替换解压目录后在扩展管理页重新加载。

## 验证与排障

```sh
node bin/chat-vault.js --help
node bin/chat-vault.js stats
node bin/chat-vault.js logs --lines 50
```

| 现象 | 检查项 |
|---|---|
| `node:sqlite` 不存在 | 确认实际调用的 Node 版本；CLI 可自动处理旧 Node 22 的 SQLite 开关 |
| 某个工具没有会话 | 该工具是否在当前账号写过记录、是否被禁用；部分 IDE 会清理旧日志 |
| ChatGPT 没有入库 | 需要浏览器扩展或官方导出，云端会话无法仅靠磁盘扫描获得 |
| MCP 无法连接 | 先确认 Web UI 和 `/healthz` 正常，再核对客户端 HTTP MCP 配置 |
| 页面能看但没有新记录 | 检查同步状态、日志和源目录；确认没有使用 `--no-sync` 或 `--no-watch` |
| 启动报端口占用 | 核对现有监听进程，不要并行启动同端口实例 |

备份安装与恢复见 [BACKUP-DESIGN.md](BACKUP-DESIGN.md)。
