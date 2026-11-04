$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$task = Get-ScheduledTask -TaskName 'ChatVault'
$action = $task.Actions | Select-Object -First 1
if ([IO.Path]::GetFullPath($action.WorkingDirectory) -ne $repoRoot) { throw 'ChatVault task points to a different checkout' }
# Two supported launch shapes:
#  - node directly (S4U/admin install): the task process *is* the server
#  - hidden VBS launcher (InteractiveToken install): wscript supervises node
$directLaunch = $action.Arguments -match '^(bin/chat-vault\.js|src/cli\.js) serve --port 8377$'
$vbsPath = Join-Path $PSScriptRoot 'run-chatvault-hidden.vbs'
$vbsLaunch = ($action.Execute -match '(?i)wscript(\.exe)?$') -and
    ([IO.Path]::GetFullPath($action.Arguments.Trim('"')) -eq $vbsPath) -and
    ((Get-Content -Raw $vbsPath) -like "*$repoRoot*")
if (-not ($directLaunch -or $vbsLaunch)) { throw 'Unexpected ChatVault launch command' }
$before = Invoke-RestMethod -Uri 'http://127.0.0.1:8377/healthz' -TimeoutSec 5
if (-not $before.ok) { throw 'Existing ChatVault health check failed' }
Stop-ScheduledTask -TaskName 'ChatVault'
$deadline = (Get-Date).AddSeconds(10)
do {
    $listeners = Get-NetTCPConnection -LocalPort 8377 -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) { break }
    # VBS launch: the task is already gone, so the port holder must be killed.
    if ($vbsLaunch) { foreach ($l in $listeners) { Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue } }
    Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (Get-NetTCPConnection -LocalPort 8377 -State Listen -ErrorAction SilentlyContinue) { throw 'Old listener did not stop' }
Start-ScheduledTask -TaskName 'ChatVault'
$after = $null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try { $after = Invoke-RestMethod -Uri 'http://127.0.0.1:8377/healthz' -TimeoutSec 2; if ($after.ok) { break } } catch { }
    Start-Sleep -Milliseconds 500
}
if (-not $after.ok -or $after.pid -eq $before.pid) { throw 'New ChatVault process is not ready' }
$homeResponse = Invoke-WebRequest -Uri 'http://127.0.0.1:8377/' -TimeoutSec 5
if ($homeResponse.Content -notmatch '<script' -or $homeResponse.Content -match 'SyntaxError') { throw 'Home page validation failed' }
$capture = Invoke-RestMethod -Uri 'http://127.0.0.1:8377/api/diagnostics/chatgpt-stream/status' -TimeoutSec 5
[pscustomobject]@{ old_pid = $before.pid; new_pid = $after.pid; health = $after.ok; capture_status = $capture.status } | ConvertTo-Json -Compress
