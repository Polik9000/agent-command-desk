# Vytvoří spouštěč %USERPROFILE%\bin\<app.id>.cmd (Windows). Nic jiného nemění.
$ErrorActionPreference = 'Stop'
$repo   = Split-Path -Parent $PSScriptRoot
$server = Join-Path $repo 'src\server\server.mjs'
$ps1    = Join-Path $repo 'scripts\launch.ps1'

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js (node.exe) nenalezen v PATH.' -ForegroundColor Red; exit 1 }
$infoJson = & $node $server --info 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Konfigurace není v pořádku:`n$infoJson" -ForegroundColor Red; exit 1 }
$info = $infoJson | ConvertFrom-Json

$bin = Join-Path $env:USERPROFILE 'bin'
$cmd = Join-Path $bin "$($info.id).cmd"
New-Item -ItemType Directory -Force $bin | Out-Null
$content = @"
@echo off
rem $($info.id) - lokalni okno nad Claude Code. Odinstalace: $repo\scripts\uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "$ps1" %*
"@
# cmd.exe čte .cmd v kódové stránce konzole → soubor jen v ASCII.
[System.IO.File]::WriteAllText($cmd, $content, [System.Text.Encoding]::ASCII)
Write-Host "Vytvořeno: $cmd"

$onPath = ($env:PATH -split ';') -contains $bin
if (-not $onPath) { Write-Host "Pozor: $bin není v PATH – přidejte ho, nebo spouštějte $cmd celou cestou." -ForegroundColor Yellow }
Write-Host "Spuštění: $($info.id)"
