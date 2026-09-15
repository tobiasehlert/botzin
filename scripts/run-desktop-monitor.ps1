$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$env:BOTZIN_MONITOR_PATH = Join-Path $projectRoot 'storage/desktop-monitor.json'
$env:BOTZIN_DECISION_MODE = 'observe'
if (-not (Get-Process obs64 -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath 'C:\Program Files\obs-studio\bin\64bit\obs64.exe' -WorkingDirectory 'C:\Program Files\obs-studio\bin\64bit'
    Start-Sleep -Seconds 3
}
$obsWindow = Get-Process obs64 -ErrorAction SilentlyContinue
if ($obsWindow.MainWindowTitle -notmatch 'Tibia Preview') {
    & node.exe --import tsx scripts/obs-desktop-projector.ts
}
$agentScript = Join-Path $projectRoot 'src/index.ts'
$existingAgent = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'src[/\\]index\.ts' }
if ($existingAgent) {
    Write-Host 'Agente já está rodando; mantendo o processo existente.'
} else {
    Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('--env-file-if-exists=.env', '--import', 'tsx', $agentScript) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectRoot 'storage/desktop-agent.log') -RedirectStandardError (Join-Path $projectRoot 'storage/desktop-agent.err')
}
$existingMonitor = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^pythonw?\.exe$' -and $_.CommandLine -match 'desktop-monitor\.py' }
if (-not $existingMonitor) {
    Start-Process -FilePath (Join-Path $projectRoot '.venv/Scripts/pythonw.exe') -ArgumentList (Join-Path $projectRoot 'scripts/desktop-monitor.py') -WorkingDirectory $projectRoot -RedirectStandardError (Join-Path $projectRoot 'storage/desktop-monitor.err')
}
