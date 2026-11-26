# Spustí Agent Command Desk (Windows): backend v Node.js bez okna konzole; backend sám otevře okno Chrome --app.
# Nic se nesestavuje – skripty běží přímo z repozitáře.
$ErrorActionPreference = 'Stop'

$repo   = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo 'src\server\server.mjs'

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js (node.exe) nenalezen v PATH.' -ForegroundColor Red; exit 1 }

# Název a složka stavu z local/config.json (zároveň ověří, že konfigurace je v pořádku).
$infoJson = & $node $server --info 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Konfigurace není v pořádku:`n$infoJson" -ForegroundColor Red; exit 1 }
$info    = $infoJson | ConvertFrom-Json
$logDir  = Join-Path $info.stateDir 'logs'
$pidFile = Join-Path $info.stateDir 'server.pid'
New-Item -ItemType Directory -Force $logDir | Out-Null

# Už běží? (proces node se server.mjs z tohoto repa)
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) -and -not $_.CommandLine.Contains('--info') }
if ($running) {
  Write-Host "$($info.name) už běží – okno najdete na hlavním panelu." -ForegroundColor Yellow
  exit 0
}
# Zbylý pid soubor po pádu by blokoval start.
if (Test-Path $pidFile) { Remove-Item $pidFile -Force }

# Staré logy: ponechat posledních 10 běhů (2 soubory na běh).
Get-ChildItem $logDir -Filter 'server-*.log' | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 20 | Remove-Item -Force -ErrorAction SilentlyContinue

$ts  = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $logDir "server-$ts.log"
$err = Join-Path $logDir "server-$ts.err.log"

$p = Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory (Split-Path $server) `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err

Start-Sleep -Seconds 2
if ($p.HasExited) {
  if ($p.ExitCode -eq 3) { Write-Host "$($info.name) už běží." -ForegroundColor Yellow; exit 0 }
  Write-Host "$($info.name) se nespustil (kód $($p.ExitCode)). Log: $err" -ForegroundColor Red
  Get-Content $err -Tail 20 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "$($info.name) běží – otevírám okno."
