$ErrorActionPreference = 'Stop'
$taskPilotRoot = $PSScriptRoot
$taskPilotPrivate = Join-Path $taskPilotRoot 'private'
$taskPilotServer = Join-Path $taskPilotRoot 'backend/server.mjs'
$taskPilotDist = Join-Path $taskPilotRoot 'frontend/dist/index.html'
if (-not (Test-Path -LiteralPath $taskPilotServer)) { throw 'Backend is not ready.' }
if (-not (Test-Path -LiteralPath $taskPilotDist)) { throw 'Build the frontend before starting the pilot.' }
$taskPilotPidFile = Join-Path $taskPilotPrivate 'server.pid'
if (Test-Path -LiteralPath $taskPilotPidFile) {
  try {
    $taskPilotExistingPid = [int](Get-Content -LiteralPath $taskPilotPidFile -Raw)
    $taskPilotExistingProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $taskPilotExistingPid)
    if ($taskPilotExistingProcess -and $taskPilotExistingProcess.CommandLine.Contains($taskPilotServer)) {
      Write-Output ('Camera pilot is already running: http://127.0.0.1:3210 (PID ' + $taskPilotExistingPid + ')')
      return
    }
  } catch { }
}
$taskPilotNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $taskPilotNode) {
  $taskPilotNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
}
if (-not (Test-Path -LiteralPath $taskPilotNode)) { throw 'Node 24 or newer is required.' }
New-Item -Path $taskPilotPrivate -ItemType Directory -Force | Out-Null
$env:PILOT_DB = Join-Path $taskPilotPrivate 'pilot.sqlite'
$env:PILOT_PROBE_MEDIA = Join-Path $taskPilotPrivate 'media/probe-c300.mp4'
$taskPilotCameraInventory = Join-Path $taskPilotPrivate 'camera-inventory.json'
if (Test-Path -LiteralPath $taskPilotCameraInventory) { $env:PILOT_CAMERA_INVENTORY = $taskPilotCameraInventory }
$taskPilotLiveConfig = Join-Path $taskPilotPrivate 'live-config.json'
if (Test-Path -LiteralPath $taskPilotLiveConfig) { $env:PILOT_LIVE_CONFIG = $taskPilotLiveConfig }
$env:PILOT_PORT = '3210'
$taskPilotProcess = Start-Process -FilePath $taskPilotNode -ArgumentList @(('"' + $taskPilotServer + '"')) -WorkingDirectory $taskPilotRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskPilotPrivate 'server.log') -RedirectStandardError (Join-Path $taskPilotPrivate 'server.err.log') -PassThru
[System.IO.File]::WriteAllText($taskPilotPidFile, [string]$taskPilotProcess.Id)
Write-Output ('Camera pilot: http://127.0.0.1:3210 (PID ' + $taskPilotProcess.Id + ')')
