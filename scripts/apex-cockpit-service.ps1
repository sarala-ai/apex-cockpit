# apex-cockpit-service.ps1 — run the NATIVE cockpit as a supervised service on Windows.
#
# Counterpart of apex-cockpit-service.sh (macOS/launchd). Same topology, same
# interface: local APEX is a native install — local_trusted, no login, ambient
# credential inheritance (gcloud/gh/git sessions of the logged-in user).
# Supervision here is a per-user Scheduled Task: starts at logon, restarts on
# failure, survives closed terminals.
#
#   .\scripts\apex-cockpit-service.ps1 install
#   .\scripts\apex-cockpit-service.ps1 uninstall
#   .\scripts\apex-cockpit-service.ps1 status
#   .\scripts\apex-cockpit-service.ps1 logs
#
# STATUS: authored on macOS to the documented Scheduled Task APIs; not yet
# executed on a Windows machine. First Windows run should verify install,
# crash-restart, and logoff/logon survival, then remove this notice.
param([Parameter(Position = 0)][ValidateSet("install", "uninstall", "status", "logs")][string]$Command = "status")

$ErrorActionPreference = "Stop"
$TaskName = "ApexCockpit"
$RepoDir  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$LogDir   = Join-Path $env:USERPROFILE ".paperclip\instances\default\logs"
$Port     = 3100

function Install-Service {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

    # One instance only: stop a previous task and anything holding the port.
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1

    $pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) ?? (Get-Command pnpm -ErrorAction Stop)
    $out  = Join-Path $LogDir "cockpit.out.log"
    $err  = Join-Path $LogDir "cockpit.err.log"
    # cmd handles the redirection so the task needs no shell profile.
    $action = New-ScheduledTaskAction -Execute "cmd.exe" `
        -Argument "/c `"`"$($pnpm.Source)`" --filter @paperclipai/server dev:watch 1>> `"$out`" 2>> `"$err`"`"" `
        -WorkingDirectory $RepoDir
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description "APEX native cockpit (supervised, local_trusted)" | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    Write-Host "installed $TaskName — waiting for health on :$Port"
    for ($i = 0; $i -lt 40; $i++) {
        try {
            Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
            Write-Host "healthy: http://localhost:$Port"
            return
        } catch { Start-Sleep -Seconds 3 }
    }
    Write-Error "did not become healthy in time — check: $($MyInvocation.MyCommand.Path) logs"
}

function Uninstall-Service {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "removed $TaskName"
}

function Get-ServiceStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Write-Host "supervised: yes ($TaskName, state=$($task.State))"
    } else {
        Write-Host "supervised: no"
    }
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 2
        Write-Host "health: $($r.StatusCode)"
    } catch { Write-Host "health: 000" }
}

function Show-Logs {
    Get-Content -Tail 40 -Wait (Join-Path $LogDir "cockpit.err.log")
}

switch ($Command) {
    "install"   { Install-Service }
    "uninstall" { Uninstall-Service }
    "status"    { Get-ServiceStatus }
    "logs"      { Show-Logs }
}
