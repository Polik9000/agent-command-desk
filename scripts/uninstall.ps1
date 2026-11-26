# Odinstaluje Agent Command Desk (Windows): spouštěč ~\bin\<app.id>.cmd a složku stavu (logy, profil Chrome).
# Složky účtů Claude Code, přihlášení ani repozitář nemění.
$ErrorActionPreference = 'Stop'

$repo   = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo 'src\server\server.mjs'
$node   = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js (node.exe) nenalezen v PATH.' -ForegroundColor Red; exit 1 }
$infoJson = & $node $server --info 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Konfigurace není v pořádku:`n$infoJson" -ForegroundColor Red; exit 1 }
$info = $infoJson | ConvertFrom-Json

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) -and -not $_.CommandLine.Contains('--info') } |
  ForEach-Object {
    Write-Host "Ukončuji běžící $($info.name) (PID $($_.ProcessId))…"
    # Celý strom: server i případně běžící claude.exe.
    & "$env:SystemRoot\System32\taskkill.exe" /PID $_.ProcessId /T /F | Out-Null
  }
Start-Sleep -Milliseconds 500

$cmd = Join-Path $env:USERPROFILE "bin\$($info.id).cmd"
if (Test-Path $cmd) { Remove-Item $cmd -Force; Write-Host "Smazáno: $cmd" }

if (Test-Path $info.stateDir) {
  # Profil Chrome může chvíli držet zámky, pokud je okno ještě otevřené.
  try { Remove-Item $info.stateDir -Recurse -Force; Write-Host "Smazáno: $($info.stateDir)" }
  catch { Write-Host "Nepodařilo se smazat $($info.stateDir) (zavřete okno a spusťte znovu): $($_.Exception.Message)" -ForegroundColor Yellow }
}

Write-Host 'Hotovo. Složku repozitáře (včetně local/) smažte ručně, pokud ji nechcete.'
