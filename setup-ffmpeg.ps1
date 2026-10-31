# Caption AI — fetch ffmpeg
#
# Downloads a static ffmpeg build and drops ffmpeg.exe next to the extension so the
# panel can slice audio out of your source media. Safe to re-run.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# PowerShell renders a progress bar per chunk by default, which throttles
# Invoke-WebRequest to a crawl on large files.
$ProgressPreference = 'SilentlyContinue'

$toolsDir = Join-Path $PSScriptRoot 'extension\tools\ffmpeg'
$target = Join-Path $toolsDir 'ffmpeg.exe'

if (Test-Path $target) {
    Write-Host "ffmpeg already present: $target" -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null

$zip = Join-Path $env:TEMP 'ffmpeg-release-essentials.zip'
$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

Write-Host "Downloading $url ..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$extract = Join-Path $env:TEMP ('ffmpeg-extract-' + [Guid]::NewGuid().ToString('N'))
Expand-Archive -Path $zip -DestinationPath $extract -Force

$exe = Get-ChildItem -Path $extract -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
if (-not $exe) { throw 'ffmpeg.exe was not found in the downloaded archive.' }

Copy-Item $exe.FullName -Destination $target -Force

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Installed: $target" -ForegroundColor Green
& $target -version | Select-Object -First 1
