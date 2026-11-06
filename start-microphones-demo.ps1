# Local-only preview with an isolated SQLite file and fictional stations.
param([ValidateRange(1024, 65535)][int]$Port = 3211, [string]$Python)

$ErrorActionPreference = 'Stop'
$taskDemoRoot = Join-Path $PSScriptRoot 'private/microphones-localhost'
$taskDemoUrl = "http://localhost:$Port"
$taskDemoApi = "http://127.0.0.1:$Port"
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "Port $Port is occupied. Choose a free port; existing services were not changed."
}
$taskDemoRuntime = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies'
$taskDemoNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $taskDemoNode) { $taskDemoNode = Join-Path $taskDemoRuntime 'node/bin/node.exe' }
if (-not $Python) {
  $Python = Join-Path $taskDemoRuntime 'python/python.exe'
  if (-not (Test-Path -LiteralPath $Python)) { $Python = (Get-Command python -ErrorAction Stop).Source }
}
& $Python (Join-Path $PSScriptRoot 'tools/build_microphones_demo.py')
if ($LASTEXITCODE -ne 0) { throw 'The synthetic fixtures need Python with ReportLab. See docs/MICROPHONES_CABINET.md.' }
& (Join-Path $PSScriptRoot 'build-pilot.ps1')

$taskDemoEnv = @{
  PILOT_DEPLOYMENT = 'local'; PILOT_HOST = '127.0.0.1'; PILOT_PORT = "$Port"
  PILOT_DB = (Join-Path $taskDemoRoot 'pilot.sqlite')
  PILOT_STATIONS = (Join-Path $taskDemoRoot 'stations.json')
  PILOT_MICROPHONE_DIR = (Join-Path $taskDemoRoot 'reports')
  PILOT_PROBE_MEDIA = ''; PILOT_CAMERA_INVENTORY = ''; PILOT_LIVE_CONFIG = ''
  PILOT_ANALYSIS_CONFIG = ''; PILOT_XIAOMI_SYNC_DIR = ''
}
$taskDemoPrevious = @{}
$taskDemoProcess = $null
try {
  foreach ($taskDemoName in $taskDemoEnv.Keys) {
    $taskDemoPrevious[$taskDemoName] = [Environment]::GetEnvironmentVariable($taskDemoName)
    [Environment]::SetEnvironmentVariable($taskDemoName, $taskDemoEnv[$taskDemoName])
  }
  $taskDemoServer = Join-Path $PSScriptRoot 'backend/server.mjs'
  $taskDemoProcess = Start-Process -FilePath $taskDemoNode -ArgumentList ('"' + $taskDemoServer + '"') `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $taskDemoRoot 'server.log') `
    -RedirectStandardError (Join-Path $taskDemoRoot 'server.err.log')
} finally {
  foreach ($taskDemoName in $taskDemoPrevious.Keys) {
    [Environment]::SetEnvironmentVariable($taskDemoName, $taskDemoPrevious[$taskDemoName])
  }
}

try {
  $taskDemoHealthy = $false
  for ($taskDemoTry = 0; $taskDemoTry -lt 30 -and -not $taskDemoHealthy; $taskDemoTry++) {
    if ($taskDemoProcess.HasExited) { break }
    try { $taskDemoHealthy = (Invoke-RestMethod "$taskDemoApi/api/health" -TimeoutSec 3).ok }
    catch { Start-Sleep -Milliseconds 200 }
  }
  if (-not $taskDemoHealthy) { throw 'Preview did not start. See the ignored private/microphones-localhost/server.err.log.' }
  if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $taskDemoProcess.Id -and $_.LocalAddress -eq '127.0.0.1' })) {
    throw 'The preview process does not own the requested loopback port.'
  }
  $taskDemoLogin = Invoke-RestMethod "$taskDemoApi/api/login" -Method Post -ContentType 'application/json' -TimeoutSec 10 `
    -Headers @{ Origin = $taskDemoApi } -SessionVariable taskDemoSession `
    -Body (@{ email = 'admin@ekosmotr.local'; password = 'Pilot-Admin-2026!' } | ConvertTo-Json -Compress)
  $taskDemoStations = Get-Content -LiteralPath (Join-Path $taskDemoRoot 'stations.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $taskDemoUserId = [Uri]::EscapeDataString($taskDemoLogin.user.id)
  Invoke-RestMethod "$taskDemoApi/api/users/$taskDemoUserId" -Method Patch -ContentType 'application/json' -TimeoutSec 10 `
    -Headers @{ Origin = $taskDemoApi; 'X-CSRF-Token' = $taskDemoLogin.csrfToken } -WebSession $taskDemoSession `
    -Body (@{ microphoneStationIds = @($taskDemoStations.id) } | ConvertTo-Json -Compress) | Out-Null
  $taskDemoCheck = Invoke-RestMethod "$taskDemoApi/api/microphones" -WebSession $taskDemoSession -TimeoutSec 10
  if (-not ($taskDemoCheck.configured -and $taskDemoCheck.summary.ready -gt 0)) { throw 'Preview contains no ready demo reports.' }
  [IO.File]::WriteAllText((Join-Path $taskDemoRoot 'server.pid'), [string]$taskDemoProcess.Id)
  Write-Output "Microphones preview: $taskDemoUrl/#microphones (PID $($taskDemoProcess.Id))"
} catch {
  if (-not $taskDemoProcess.HasExited) { Stop-Process -Id $taskDemoProcess.Id }
  throw
}
