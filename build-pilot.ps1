$ErrorActionPreference = 'Stop'
$taskPilotNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $taskPilotNode) { $taskPilotNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' }
if (-not (Test-Path -LiteralPath $taskPilotNode)) { throw 'Node 24 or newer is required.' }
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'frontend')
try {
  & $taskPilotNode 'node_modules/vite/bin/vite.js' build
  if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
} finally { Pop-Location }
