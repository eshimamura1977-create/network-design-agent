param([string]$PythonPath = "")
$ErrorActionPreference = 'Stop'
$guiPort = 8080
$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^GUI_PORT\s*=\s*(\d+)\s*$') { $guiPort = [int]$Matches[1] }
    }
}
if ($env:GUI_PORT) { $guiPort = [int]$env:GUI_PORT }
$appUrl = "http://127.0.0.1:$guiPort"
try {
    $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2
    if ($health.app -eq 'network-design-workbench') { Write-Output "起動済み: $appUrl"; exit 0 }
} catch {}
if (-not $PythonPath) {
    $localPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    $bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $localPython) { $PythonPath = $localPython }
    elseif (Test-Path -LiteralPath $bundledPython) { $PythonPath = $bundledPython }
    else { $PythonPath = (Get-Command python -ErrorAction Stop).Source }
}
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$entryScript = Join-Path $PSScriptRoot 'run.py'
$startedProcess = Start-Process -FilePath $PythonPath -ArgumentList @('-u', ('"' + $entryScript + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'startup.log') -RedirectStandardError (Join-Path $logDir 'startup-error.log') -PassThru
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($startedProcess.HasExited) { throw '起動に失敗しました。logs/startup-error.logを確認してください。' }
    try {
        $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1
        if ($health.app -eq 'network-design-workbench') {
            $startedProcess.Id | Set-Content -LiteralPath (Join-Path $logDir 'server.pid')
            Write-Output "起動しました: $appUrl"
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 250
}
throw '起動を確認できませんでした。logs/startup-error.logを確認してください。'
