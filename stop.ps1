$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'logs\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'バックグラウンド起動のPID記録がありません。'; exit 0 }
$appProcessId = [int](Get-Content -LiteralPath $pidFile)
$appProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $appProcessId"
$entryScript = Join-Path $PSScriptRoot 'run.py'
if (-not $appProcess) { Write-Output '停止済みです。'; exit 0 }
if ($appProcess.CommandLine -and $appProcess.CommandLine.Contains($entryScript)) {
    $terminationResult = Invoke-CimMethod -InputObject $appProcess -MethodName Terminate
    if ($terminationResult.ReturnValue -ne 0) { throw ('停止に失敗しました。戻り値: ' + $terminationResult.ReturnValue) }
    Write-Output '設計支援アプリを停止しました。'
} else { throw 'PIDの参照先がこのアプリと一致しないため停止しませんでした。' }
