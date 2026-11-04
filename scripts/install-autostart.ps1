# ChatVault resident install: register a Windows Scheduled Task
# (no visible window, auto-start at boot/logon, auto-restart on crash).
# Preferred: S4U principal (hidden, runs before logon) - needs elevation.
# Fallback (no admin): InteractiveToken task + hidden VBS launcher.
# Pure ASCII on purpose: PowerShell 5.1 reads BOM-less files as ANSI.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node.exe).Source
$taskName = 'ChatVault'

# 1) remove legacy startup-folder shortcut if present
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'ChatVault.lnk'
if (Test-Path $startupLnk) { Remove-Item $startupLnk -Force }

$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$registered = $false
try {
  # 2a) preferred: S4U + boot/logon triggers (requires elevation)
  $action = New-ScheduledTaskAction -Execute $node -Argument 'src/cli.js serve --port 8377' -WorkingDirectory $repo
  $trigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigBoot = New-ScheduledTaskTrigger -AtStartup
  $trigBoot.Delay = 'PT30S'
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigLogon, $trigBoot `
    -Principal $principal -Settings $settings -Force | Out-Null
  $registered = $true
  $mode = 'S4U (hidden, runs before logon)'
  $restartNote = 'every 1 min, up to 10 consecutive failures'
} catch {
  if ($_.Exception.Message -notmatch 'denied|refus| Zugriffs|0x80070005') { throw }
  # 2b) fallback: InteractiveToken + hidden VBS launcher (no elevation needed)
  $vbs = Join-Path $PSScriptRoot 'run-chatvault-hidden.vbs'
  # The launcher doubles as a supervisor: sh.Run waits for node and the loop
  # relaunches it ~5s after any exit, which is what actually delivers the
  # auto-restart promise. Task-side RestartOnFailure is skipped for tasks started
  # on demand and gives up after the 10th failure, and a repetition pattern on a
  # logon trigger never fires (logon triggers have no start boundary).
  $nl = [Environment]::NewLine
  $vbsBody = @(
    'Set sh = CreateObject("WScript.Shell")'
    'sh.CurrentDirectory = "' + $repo + '"'
    'Do'
    '  sh.Run Chr(34) & "' + $node + '" & Chr(34) & " src\cli.js serve --port 8377", 0, True'
    '  WScript.Sleep 5000'
    'Loop'
  ) -join $nl
  Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $repo
  $trigLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigLogon `
    -Settings $settings -Force | Out-Null
  $registered = $true
  $mode = 'hidden VBS launcher (starts at logon, supervisor loop)'
  $restartNote = 'every ~5s after exit (launcher supervisor loop)'
}
if (-not $registered) { throw 'task registration failed' }

# 3) take over port: stop any running instance (install = hand over to task)
$conns = Get-NetTCPConnection -LocalPort 8377 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  if ($c.OwningProcess) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 1

# 4) start now and report
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Output "OK: task '$taskName' registered, mode: $mode, state: $state"
Write-Output "auto-restart: $restartNote"
Write-Output 'Uninstall: Unregister-ScheduledTask -TaskName ChatVault -Confirm:$false'
if ($state -notin @('Running','Ready')) { throw "task state unexpected: $state" }
