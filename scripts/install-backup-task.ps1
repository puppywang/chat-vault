# ChatVault backup install: register a Windows Scheduled Task that pushes a
# snapshot to the remote host every 6 hours (and shortly after logon, so a
# machine that was off during a slot catches up).
# Design: docs/BACKUP-DESIGN.md   Uninstall: -Uninstall
# Pure ASCII on purpose: PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [switch]$Uninstall,
  [switch]$SkipRun
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$taskName = 'ChatVaultBackup'
$vbs = Join-Path $PSScriptRoot 'run-backup-hidden.vbs'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "OK: task '$taskName' removed"
  } else {
    Write-Output "task '$taskName' not found"
  }
  if (Test-Path $vbs) { Remove-Item $vbs -Force }
  exit 0
}

# 1) preflight ---------------------------------------------------------------
$node = (Get-Command node.exe).Source
if (-not (Test-Path (Join-Path $repo 'src\cli.js'))) { throw "no src/cli.js under $repo" }

$configPath = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.chat-vault\config.json'
if (-not (Test-Path $configPath)) { throw "missing $configPath - set backup.enabled/host first" }
$backupCfg = (Get-Content $configPath -Raw | ConvertFrom-Json).backup
if (-not $backupCfg) { throw 'config.json has no backup section' }
if (-not $backupCfg.enabled) { throw 'backup.enabled is false in config.json' }
if (-not $backupCfg.host) { throw 'backup.host is empty in config.json' }

$keyFile = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\id_ed25519_chatvault'
if (-not (Test-Path $keyFile)) { throw "missing dedicated ssh key: $keyFile" }

# 2) hidden launcher (window style 0, exit code propagated for LastTaskResult) -
$launcher = @(
  'Set sh = CreateObject("WScript.Shell")'
  'sh.CurrentDirectory = "' + $repo + '"'
  'WScript.Quit sh.Run(Chr(34) & "' + $node + '" & Chr(34) & " src\cli.js backup --push", 0, True)'
) -join [Environment]::NewLine
Set-Content -Path $vbs -Value $launcher -Encoding ASCII

# 3) remote reachability -----------------------------------------------------
Write-Output "checking $($backupCfg.host) ..."
if ($backupCfg.transport -eq 'restic') {
  $probe = & $node (Join-Path $repo 'src\cli.js') backup --status | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'restic status failed' }
  $status = $probe | ConvertFrom-Json
  if ($status.error -or !$status.remote.ok) { throw "restic remote check failed: $($status.error)" }
} else {
  $probe = ssh -o BatchMode=yes -o ConnectTimeout=15 $backupCfg.host 'chatvault-recvd status' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $probe -notmatch '"ok":true') {
    throw "remote check failed for $($backupCfg.host): $($probe.Trim())"
  }
}
Write-Output 'remote OK'

# 4) register ---------------------------------------------------------------
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $repo
# Every 6h anchored at 03:30 local time; StartWhenAvailable replays a missed slot.
$trigEvery = New-ScheduledTaskTrigger -Once -At (Get-Date -Hour 3 -Minute 30 -Second 0) `
  -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
$trigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigLogon.Delay = 'PT10M'
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -StartWhenAvailable -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigEvery, $trigLogon `
  -Settings $settings -Force | Out-Null
Write-Output "OK: task '$taskName' registered (every 6h at :30, plus 10 min after logon)"

# 5) run once now and report -------------------------------------------------
if (-not $SkipRun) {
  Write-Output 'running one backup now to verify ...'
  Start-ScheduledTask -TaskName $taskName
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { break }
  }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  Write-Output "last run: $($info.LastRunTime), result: $($info.LastTaskResult) (0 = ok)"
  if ($info.LastTaskResult -ne 0) { Write-Output "check $env:USERPROFILE\.chat-vault\logs\ and run: node src/cli.js backup --status" }
}
Write-Output "status: node src/cli.js backup --status"
Write-Output "uninstall: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-backup-task.ps1 -Uninstall"
