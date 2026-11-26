# Jednorázové stažení vendor knihoven a fontů do wwwroot (pevné verze, za běhu žádné CDN).
# Používá `npm pack` (stáhne jen tarball, nespouští instalační skripty). Výsledek se commituje.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$www = Join-Path $repo 'src\server\wwwroot'
$tmp = Join-Path $repo '.vendor-tmp'

$packages = [ordered]@{
  'marked'                          = '18.1.3'
  'dompurify'                       = '3.4.17'
  '@highlightjs/cdn-assets'         = '11.12.0'
  '@fontsource/bricolage-grotesque' = '5.3.0'
  '@fontsource/merriweather'        = '5.3.0'
}

if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force $tmp | Out-Null
$vendor = Join-Path $www 'vendor'; $fonts = Join-Path $www 'fonts'
New-Item -ItemType Directory -Force $vendor, $fonts | Out-Null

foreach ($name in $packages.Keys) {
  $ver = $packages[$name]
  $dir = Join-Path $tmp ($name -replace '[@/]', '_')
  New-Item -ItemType Directory -Force $dir | Out-Null
  Push-Location $dir
  try {
    $tgz = (& npm pack "$name@$ver" --silent --ignore-scripts) | Select-Object -Last 1
    & tar -xzf $tgz
    if ($LASTEXITCODE -ne 0) { throw "tar selhal pro $name" }
  } finally { Pop-Location }
}

function Copy-From($pkg, $rel, $dest) {
  $src = Join-Path (Join-Path $tmp ($pkg -replace '[@/]', '_')) "package\$rel"
  if (-not (Test-Path $src)) { throw "Chybí $pkg/$rel" }
  Copy-Item $src $dest -Force
}

Copy-From 'marked' 'lib\marked.umd.js' (Join-Path $vendor 'marked.umd.js')
Copy-From 'marked' 'LICENSE' (Join-Path $vendor 'marked.LICENSE.txt')
Copy-From 'dompurify' 'dist\purify.min.js' (Join-Path $vendor 'purify.min.js')
Copy-From 'dompurify' 'LICENSE' (Join-Path $vendor 'purify.LICENSE.txt')
Copy-From '@highlightjs/cdn-assets' 'highlight.min.js' (Join-Path $vendor 'highlight.min.js')
Copy-From '@highlightjs/cdn-assets' 'LICENSE' (Join-Path $vendor 'highlight.LICENSE.txt')

foreach ($sub in 'latin', 'latin-ext') {
  Copy-From '@fontsource/bricolage-grotesque' "files\bricolage-grotesque-$sub-700-normal.woff2" $fonts
  Copy-From '@fontsource/merriweather' "files\merriweather-$sub-300-normal.woff2" $fonts
  Copy-From '@fontsource/merriweather' "files\merriweather-$sub-300-italic.woff2" $fonts
  Copy-From '@fontsource/merriweather' "files\merriweather-$sub-700-normal.woff2" $fonts
}
Copy-From '@fontsource/bricolage-grotesque' 'LICENSE' (Join-Path $fonts 'bricolage-grotesque.OFL.txt')
Copy-From '@fontsource/merriweather' 'LICENSE' (Join-Path $fonts 'merriweather.OFL.txt')

$lines = @('# Vendor verze (stáhl scripts/fetch-vendor.ps1)', '')
foreach ($name in $packages.Keys) { $lines += "- $name $($packages[$name])" }
$lines | Set-Content -Encoding utf8 (Join-Path $vendor 'VERSIONS.md')

Remove-Item -Recurse -Force $tmp
Write-Host 'Hotovo.'
