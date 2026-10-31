# Caption AI — install (Windows)
#
# Links the extension into the per-user CEP folder and enables PlayerDebugMode so
# Premiere will load an unsigned panel. No admin rights, no code signing needed.
#
# Re-run this any time; it is idempotent.

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'extension'
if (-not (Test-Path $source)) {
    throw "Extension folder not found: $source"
}

$cepRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dest = Join-Path $cepRoot 'com.captionai.panel'

New-Item -ItemType Directory -Force -Path $cepRoot | Out-Null

if (Test-Path $dest) {
    $item = Get-Item $dest -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        # Remove the link only; never the files it points at.
        [System.IO.Directory]::Delete($dest)
    } else {
        Remove-Item $dest -Recurse -Force
    }
}

New-Item -ItemType Junction -Path $dest -Target $source | Out-Null
Write-Host "Linked: $dest" -ForegroundColor Green

# CEP versions used by Premiere 2022-2026.
foreach ($v in 9..16) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
}
Write-Host "PlayerDebugMode enabled (CSXS.9 - CSXS.13)" -ForegroundColor Green

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Run  .\setup-ffmpeg.ps1   (downloads ffmpeg.exe into extension\tools\ffmpeg)'
Write-Host '  2. Restart Premiere Pro'
Write-Host '  3. Window > Extensions > Caption AI'
