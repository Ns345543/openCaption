<#
  openCaption - installer (Windows)

  Copies the panel into the per-user CEP extensions folder, unlocks the panel
  for the Premiere versions that use CEP 9-14, and tells you what to do next.
  No administrator rights are required: everything stays inside your user
  profile.

  Usage:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Purge
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$BundleId = 'com.captionai.panel'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source   = Join-Path $Here 'extension'
$CepRoot  = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$Dest     = Join-Path $CepRoot $BundleId
$DataDir  = Join-Path $env:APPDATA 'CaptionAI'

function Write-Step($text) { Write-Host "  $text" }
function Write-Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  $text" -ForegroundColor Yellow }

function Test-PremiereRunning {
    $names = @('Adobe Premiere Pro', 'Adobe Premiere Pro Beta')
    foreach ($n in $names) {
        if (Get-Process -Name $n -ErrorAction SilentlyContinue) { return $true }
    }
    return $false
}

function Remove-Panel {
    if (-not (Test-Path -LiteralPath $Dest)) { return $false }
    $item = Get-Item -LiteralPath $Dest -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        # A developer junction: remove the link, never the files behind it.
        [System.IO.Directory]::Delete($Dest)
    } else {
        Remove-Item -LiteralPath $Dest -Recurse -Force
    }
    return $true
}

Write-Host ''
Write-Host '  openCaption installer' -ForegroundColor Cyan
Write-Host '  -------------------' -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- uninstall ---
if ($Uninstall) {
    if ((Test-PremiereRunning) -and (-not $Force)) {
        Write-Warn2 'Premiere Pro is running. Close it and run this again.'
        exit 1
    }

    if (Remove-Panel) { Write-Ok "Removed $Dest" }
    else { Write-Step 'openCaption was not installed; nothing to remove.' }

    if ($Purge) {
        if (Test-Path -LiteralPath $DataDir) {
            Remove-Item -LiteralPath $DataDir -Recurse -Force
            Write-Ok "Removed your saved settings and API key ($DataDir)"
        }
    } else {
        Write-Step "Your API key and settings were kept in $DataDir"
        Write-Step 'Run with -Purge to delete them too.'
    }

    Write-Host ''
    Write-Ok 'Uninstalled. Restart Premiere Pro to finish.'
    Write-Host ''
    exit 0
}

# ------------------------------------------------------------------ install ---
if (-not (Test-Path -LiteralPath (Join-Path $Source 'CSXS\manifest.xml'))) {
    Write-Warn2 "This folder is incomplete: $Source\CSXS\manifest.xml is missing."
    Write-Warn2 'Extract the whole downloaded zip first, then run install.bat.'
    exit 1
}

if ((Test-PremiereRunning) -and (-not $Force)) {
    Write-Warn2 'Premiere Pro is running.'
    Write-Step 'Close Premiere Pro completely, then run install.bat again.'
    Write-Step '(Windows will not let the panel be replaced while it is open.)'
    exit 1
}

Write-Step "Installing to $Dest"
New-Item -ItemType Directory -Force -Path $CepRoot | Out-Null

if (Remove-Panel) { Write-Step 'Replaced the previous copy.' }

Copy-Item -LiteralPath $Source -Destination $Dest -Recurse -Force

# Files extracted from a zip carry a "downloaded from the internet" mark that
# can stop scripts and Node helpers from loading. Clear it on the installed copy.
Get-ChildItem -LiteralPath $Dest -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

# CEP only loads an unsigned panel when PlayerDebugMode is on. We set it for
# every CEP version Premiere 2022-2026 may use.
foreach ($v in 9..16) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
}
Write-Ok 'Enabled the panel for Premiere 2022-2026.'

$ffmpeg = Join-Path $Dest 'tools\ffmpeg\ffmpeg.exe'
if (Test-Path -LiteralPath $ffmpeg) {
    Write-Ok 'Audio helper (ffmpeg) is included.'
} else {
    # Some builds of the package are made without the 100 MB helper. Fetch it
    # rather than leaving the user with a panel that cannot read audio.
    Write-Warn2 'ffmpeg.exe is missing from this package. Downloading it now…'
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        $zip = Join-Path $env:TEMP ('captionai-ffmpeg-' + [Guid]::NewGuid().ToString('N') + '.zip')
        $extract = Join-Path $env:TEMP ('captionai-ffmpeg-' + [Guid]::NewGuid().ToString('N'))
        try {
            Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip -UseBasicParsing -TimeoutSec 300
            Expand-Archive -Path $zip -DestinationPath $extract -Force
            $exe = Get-ChildItem -Path $extract -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
            if (-not $exe) { throw 'ffmpeg.exe was not found in the downloaded archive.' }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ffmpeg) | Out-Null
            Copy-Item -LiteralPath $exe.FullName -Destination $ffmpeg -Force
        } finally {
            $ProgressPreference = $previousProgress
            Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Ok 'Downloaded ffmpeg.'
    } catch {
        Write-Warn2 "Could not download ffmpeg: $($_.Exception.Message)"
        Write-Step 'Install ffmpeg yourself, then pick it under Advanced in the panel.'
        Write-Step 'Without it the panel cannot slice audio from your media.'
    }
}

# A friendly sanity check: Premiere 2022+ registers its versions here.
$premiereVersions = @()
foreach ($hive in @('HKLM:\SOFTWARE\Adobe\Premiere Pro', 'HKCU:\SOFTWARE\Adobe\Premiere Pro')) {
    if (Test-Path -LiteralPath $hive) {
        foreach ($k in Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue) {
            $premiereVersions += $k.PSChildName
        }
    }
}
$premiereVersions = @($premiereVersions | Where-Object { $_ -match '^\d+\.' } | Sort-Object -Unique)
if ($premiereVersions.Count -gt 0) {
    Write-Ok ('Premiere Pro found (' + ($premiereVersions -join ', ') + ').')
    $newEnough = $false
    foreach ($v in $premiereVersions) {
        try { if ([double]$v -ge 22.0) { $newEnough = $true } } catch { }
    }
    if (-not $newEnough) {
        Write-Warn2 'This panel needs Premiere Pro 2022 (22.0) or newer.'
    }
} else {
    Write-Warn2 'No Premiere Pro installation was detected on this account.'
    Write-Step 'Install Premiere Pro 2022+ first, then run install.bat again.'
}

Write-Host ''
Write-Ok 'openCaption is installed.'
Write-Host ''
Write-Step 'Next:'
Write-Step '  1. Start Premiere Pro.'
Write-Step '  2. Window > Extensions > openCaption.'
Write-Step '  3. Paste a free Google Gemini API key and press Save.'
Write-Step '  4. Open a sequence and press "Generate captions".'
Write-Host ''
Write-Step 'Caption files are saved in:'
Write-Step "  $DataDir\captions"
Write-Step 'and imported into the "99 openCaption" bin of your project.'
Write-Host ''
exit 0
