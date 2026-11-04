# 备份与恢复

ChatVault 可生成可校验的一致性数据库快照，并按需推送到自己的备份服务器。默认不启用远端备份。

## 选择方式

| 方式 | 适用场景 | 备份内容 |
|---|---|---|
| `--dry-run` | 先验证本地快照 | 数据库与清单，不上传 |
| `transport: "restic"` | 加密、去重的增量备份 | 数据库、导入记录、图片和辅助索引 |
| `transport: "ssh"` / `"rsync"` | 简单的远端数据库快照 | 数据库与清单；导入文件及图片需另行备份 |

## 一致性与数据范围

默认快照不含可重建的 FTS 搜索索引。`backup-snapshot.js` 在一个只读事务中复制业务表，再创建索引、视图和触发器，保留 rowid、AUTOINCREMENT 高水位和数据库版本。遇到未知虚表或依赖被排除 FTS 的对象会失败，不静默丢弃。

每份快照都执行完整性检查、计数核对和 SHA-256 校验。只有上传及远端确认成功后才更新成功记录；失败保留快照和上次成功信息。

restic 备份集包括：

- 数据库快照与 `manifest.json`。
- `imports/`、`images/`。
- `pi-sessions.json`、`pi-activity-index.json`、`chatgpt-request-map.json`（存在时）。

不上传整个用户目录、`config.json`、密码文件、日志或浏览器诊断。SQLite 快照与资产目录不是跨文件系统的统一事务；资产按 restic 扫描时的状态捕获。

## 配置 restic

本机需要 restic 与 OpenSSH。可以将 restic 放到 `~/.chat-vault/bin/restic`（Windows 为 `restic.exe`），或用 `resticBinary` 配置可执行文件。

在 `~/.chat-vault/config.json` 中合并以下 `backup` 字段，不覆盖其他配置：

```json
{
  "backup": {
    "enabled": true,
    "host": "chatvault-backup",
    "dir": "/srv/backup/chatvault",
    "transport": "restic",
    "resticBinary": "restic",
    "resticPasswordFile": "",
    "resticRepository": "",
    "excludeFts": true,
    "keepLocal": 3,
    "keepWeekly": 8,
    "keepMonthly": 3,
    "timeoutSec": 7200
  }
}
```

空密码路径使用 `~/.chat-vault/restic/password.txt`，空仓库使用 `rclone:chatvault`。先创建只允许当前用户读取的随机密码文件，另存一份安全的恢复副本。密码不应写进 Git、配置示例或终端输出；丢失密码将无法恢复加密仓库。

`chatvault-backup` 是自行配置的 SSH 别名，例如：

```sshconfig
Host chatvault-backup
    HostName backup.example.org
    User backup
    IdentityFile ~/.ssh/id_ed25519_chatvault
    BatchMode yes
    ServerAliveInterval 15
    ServerAliveCountMax 3
```

如需跳板机，在自己的 SSH 配置中添加 `ProxyJump`；应用不绑定任何特定主机。

## 远端接收端

远端需 Linux、支持 `serve restic --stdio` 的 rclone，以及专用 SSH 账号。使用 `rclone serve restic --help` 确认版本支持该参数。

1. 创建专用账号可写的 `/srv/backup/chatvault` 目录。
2. 将仓库的 `scripts/remote/chatvault-recvd` 安装为该账号的 `~/.local/bin/chatvault-recvd` 并赋予执行权限。
3. 将 rclone 安装到该账号的 `~/.local/bin/rclone`；该路径由接收脚本使用。
4. 为专用密钥配置 forced command，避免提供任意远程 shell。示例 `authorized_keys` 前缀：

   ```text
   command="/home/backup/.local/bin/chatvault-recvd",restrict ssh-ed25519 <your-public-key>
   ```

5. 如修改备份根目录，在接收脚本部署环境中设置 `CHATVAULT_BACKUP_ROOT`，保持本机配置一致。

应用经 SSH 发送 `chatvault-recvd restic-stdio chatvault`。接收脚本只放行固定协议，再由 rclone 通过标准输入输出服务 `/srv/backup/chatvault/restic`，无需新增 HTTP 监听端口。

## 运行与验收

源码安装时使用 `node bin/chat-vault.js` 替换 `chat-vault`。

```sh
chat-vault backup --dry-run
chat-vault backup --init
chat-vault backup --push
chat-vault backup --status
chat-vault backup --check
chat-vault backup --check --read-data
```

`--init` 仅用于首次初始化仓库。每次上传需 restic 退出 0、返回 snapshot ID、结构检查通过并从远端查到该 ID，才算成功。退出 3 作为不完整备份处理。

普通 `--check` 检查结构；`--check --read-data` 读取全部数据块，适合定期完整验收。中断后再次执行可复用已确认的数据块，不承诺在大文件的精确字节位置续传。已有快照可用 `backup --retry-snapshot <目录>` 重新验证并推送。

Windows 可安装每六小时的自动任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1
Get-ScheduledTaskInfo -TaskName ChatVaultBackup
```

该脚本要求专用密钥 `~/.ssh/id_ed25519_chatvault` 已配置，支持 `-SkipRun` 仅注册和 `-Uninstall` 移除。其他平台用已有调度器定时运行 `chat-vault backup --push`。

## 恢复

先恢复到**空目录**，不要直接覆盖正在使用的数据：

```sh
chat-vault backup --restore latest --target /path/to/empty-restore
```

恢复会验证文件、数据库哈希、完整性和清单，并生成 `restore-verification.json`。默认快照没有 FTS。先对恢复副本重建索引。将下面的代码保存为 `rebuild-fts.mjs`，运行 `node rebuild-fts.mjs /path/to/empty-restore/backup-current/chat-vault.db`：

```js
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
const file = process.argv[2];
if (!file || !existsSync(file)) throw new Error('Specify the restored database');
const db = new DatabaseSync(file);
db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(fts_text, content='messages', content_rowid='id', tokenize='unicode61')");
db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
db.close();
```

然后用单独端口验证恢复库：

```sh
chat-vault serve --port 8378 --no-sync --no-watch --db /path/to/empty-restore/backup-current/chat-vault.db
```

在覆盖现用数据前停止原服务，保留现用目录副本，找到恢复目录中的 `backup-current/chat-vault.db` 和资产路径，再按目标数据目录布局迁入。恢复后的路径以实际 restic 输出为准；不要将恢复工具的整个父目录误当成数据目录。

## 旧 SSH / rsync 方式

接收脚本同时支持受限 `recv`、`finalize`、`status` 和 rsync 写入。远端还需要 `sqlite3`、`gzip`；使用周/月压缩归档时需要 `zstd`，rsync 方式需双方具备 rsync 和远端 rrsync。

该方式先上传至 `incoming/`，核对 SHA-256、SQLite 完整性和记录数后提升到 `verified/latest.db`，再生成 `archive/` 周/月档。`transport: "auto"` 在本机有 rsync 时选用它，否则使用 SSH gzip 流。它不会加密远端静态文件，也不覆盖 `imports/` 和 `images/`。

切换传输方式不会主动删除另一种方式的备份。确认已完成恢复验收后，再按自己的保留策略处理旧副本。
