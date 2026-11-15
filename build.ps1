<#
  build.ps1 - packages openCaption for other people to install.

  Output (in .\dist):
    openCaption.zxp        signed CEP extension (any ZXP installer)
    openCaption.zip        install.bat + extension + the .zxp
    SHA256SUMS.txt         checksums for both

  The package names never change: release tags and titles carry the version,
  so the download URLs under releases/latest/download stay permanent.

  Typical use:
    .\build.ps1

  Requirements: Windows PowerShell 5.1+, internet access the first time (the
  signer, ZXPSignCmd.exe, is downloaded from Adobe's CEP repository). The
  self-signed certificate used to sign the panel is generated once and cached
  in .build\cert.

  Useful switches:
    -Version 1.0.1      stamp a different version into the manifest and panel
    -SkipSign           skip the .zxp and only build the Windows zip
    -NoTimestamp        do not contact a timestamp server
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$SkipSign,
    [switch]$NoTimestamp,
    [string]$Publisher = 'openCaption',
    [string]$CertPassword = 'captionai-selfsigned'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root      = $PSScriptRoot
$ExtDir    = Join-Path $Root 'extension'
$InstDir   = Join-Path $Root 'installer'
$BuildDir  = Join-Path $Root '.build'
$Stage     = Join-Path $BuildDir 'stage\com.captionai.panel'
$Dist      = Join-Path $Root 'dist'
$ToolsDir  = Join-Path $BuildDir 'tools'
$Signer    = Join-Path $ToolsDir 'ZXPSignCmd.exe'
$CertDir   = Join-Path $BuildDir 'cert'
$CertFile  = Join-Path $CertDir 'captionai.p12'

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "   $text" -ForegroundColor Green }
function Note($text) { Write-Host "   $text" -ForegroundColor DarkGray }
function Warn($text) { Write-Host "   $text" -ForegroundColor Yellow }

function Read-Utf8($path) {
    # Windows PowerShell 5.1's Get-Content treats BOM-less files as ANSI, which
    # turned em dashes and "·" into mojibake when Set-Version wrote them back.
    return [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
}

function Get-FileVersionFromSource {
    $manifest = [xml](Read-Utf8 (Join-Path $ExtDir 'CSXS\manifest.xml'))
    $manifest.ExtensionManifest.ExtensionBundleVersion
}

function Get-AppVersion {
    $text = Read-Utf8 (Join-Path $ExtDir 'js\app.js')
    if ($text -match "var VERSION = '([^']+)'") { return $Matches[1] }
    return ''
}

function Set-Version($newVersion) {
    $manifestPath = Join-Path $ExtDir 'CSXS\manifest.xml'
    $text = Read-Utf8 $manifestPath
    $text = [regex]::Replace($text, 'ExtensionBundleVersion="[^"]+"', 'ExtensionBundleVersion="' + $newVersion + '"')
    $text = [regex]::Replace($text, '<Extension Id="com\.captionai\.panel\.main" Version="[^"]+"',
        '<Extension Id="com.captionai.panel.main" Version="' + $newVersion + '"')
    [System.IO.File]::WriteAllText($manifestPath, $text, (New-Object System.Text.UTF8Encoding($false)))

    $appPath = Join-Path $ExtDir 'js\app.js'
    $app = Read-Utf8 $appPath
    $app = [regex]::Replace($app, "var VERSION = '[^']+'", "var VERSION = '$newVersion'")
    [System.IO.File]::WriteAllText($appPath, $app, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-ZxpSigner {
    if (Test-Path -LiteralPath $Signer) { return }

    New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
    $urls = @(
        'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe',
        'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/x64/ZXPSignCmd.exe'
    )

    foreach ($url in $urls) {
        try {
            Note "Downloading ZXPSignCmd from $url"
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $url -OutFile $Signer -UseBasicParsing -TimeoutSec 90
            if (Test-Path -LiteralPath $Signer) { Ok 'Adobe CEP signer downloaded.'; return }
        } catch {
            Warn "Download failed: $($_.Exception.Message)"
        }
    }

    throw "ZXPSignCmd.exe could not be downloaded. Copy it to $Signer, or run with -SkipSign."
}

function Invoke-Signer {
    param([string[]]$Arguments)

    # ZXPSignCmd writes progress and errors to stderr; with ErrorActionPreference
    # set to Stop that would abort the build, so run it with Continue and judge
    # the result by the exit code.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Signer @Arguments 2>&1 | Out-String
    } finally {
        $ErrorActionPreference = $previous
    }
    return @{ code = $LASTEXITCODE; output = $output }
}

function Get-SigningCert {
    if (Test-Path -LiteralPath $CertFile) { return }
    New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

    $result = Invoke-Signer -Arguments @('-selfSignedCert', 'IN', 'India', $Publisher, "$Publisher panel", $CertPassword, $CertFile)
    if ($result.code -ne 0 -or -not (Test-Path -LiteralPath $CertFile)) {
        throw 'Could not create the self-signed signing certificate.'
    }
    Ok 'Created a self-signed signing certificate (cached in .build\cert).'
}

function Invoke-Sign($source, $out) {
    $timestampServers = @(
        'https://timestamp.digicert.com',
        'http://timestamp.sectigo.com',
        'http://timestamp.comodoca.com'
    )
    if ($NoTimestamp) { $timestampServers = @() }

    foreach ($tsa in @($null) + $timestampServers) {
        if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
        if ($tsa) {
            $result = Invoke-Signer -Arguments @('-sign', $source, $out, $CertFile, $CertPassword, '-tsa', $tsa)
        } else {
            $result = Invoke-Signer -Arguments @('-sign', $source, $out, $CertFile, $CertPassword)
        }

        if ($result.code -eq 0 -and (Test-Path -LiteralPath $out)) {
            if (-not $tsa) { Warn 'Signed without a timestamp (timestamp servers unreachable).' }
            return
        }
        if ($tsa) { Warn "Timestamp server $tsa unavailable." }
    }

    throw "ZXPSignCmd failed to sign $source`n$($result.output)"
}

# ------------------------------------------------------------------ version ---
Step 'Version'
if ($Version) {
    Set-Version $Version
    Ok "Stamped version $Version into the manifest and the panel."
}

$manifestVersion = Get-FileVersionFromSource
$appVersion = Get-AppVersion
if ($appVersion -ne $manifestVersion) {
    throw "Version mismatch: manifest says $manifestVersion, app.js says $appVersion. Pass -Version to fix both."
}
$version = $manifestVersion
Ok "openCaption $version"

# --------------------------------------------------------------- ffmpeg ---
Step 'Audio helper'
$sourceFfmpeg = Join-Path $ExtDir 'tools\ffmpeg\ffmpeg.exe'
if (-not (Test-Path -LiteralPath $sourceFfmpeg)) {
    $setup = Join-Path $Root 'setup-ffmpeg.ps1'
    if (-not (Test-Path -LiteralPath $setup)) {
        throw "ffmpeg.exe is missing from extension\tools\ffmpeg and setup-ffmpeg.ps1 was not found."
    }
    Warn 'ffmpeg.exe is missing; downloading it before staging (setup-ffmpeg.ps1).'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $setup
    if ($LASTEXITCODE -ne 0) {
        throw 'setup-ffmpeg.ps1 could not download ffmpeg. Run it yourself, then build again.'
    }
}
if (-not (Test-Path -LiteralPath $sourceFfmpeg)) {
    throw "ffmpeg.exe is still missing from $sourceFfmpeg. The package would not work without it."
}
Ok ("ffmpeg bundled ({0:N0} MB)" -f ((Get-Item -LiteralPath $sourceFfmpeg).Length / 1MB))

# -------------------------------------------------------------------- stage ---
Step 'Staging files'
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

$items = @('index.html', 'css', 'js', 'jsx', 'CSXS', 'tools')
foreach ($item in $items) {
    $from = Join-Path $ExtDir $item
    if (-not (Test-Path -LiteralPath $from)) { throw "Missing from extension: $item" }
    Copy-Item -LiteralPath $from -Destination $Stage -Recurse -Force
}

Copy-Item -LiteralPath (Join-Path $Root 'LICENSE') -Destination $Stage -Force
Copy-Item -LiteralPath (Join-Path $Root 'THIRD-PARTY-NOTICES.txt') -Destination $Stage -Force

# Dev-only files that must not ship: CEP debug port, editor temp files.
Get-ChildItem -LiteralPath $Stage -Recurse -Force -File |
    Where-Object { $_.Name -in @('.debug', '.DS_Store') -or $_.Extension -in @('.log', '.tmp') } |
    Remove-Item -Force -ErrorAction SilentlyContinue

$ffmpeg = Join-Path $Stage 'tools\ffmpeg\ffmpeg.exe'
if (-not (Test-Path -LiteralPath $ffmpeg)) {
    Warn 'tools\ffmpeg\ffmpeg.exe is missing: the panel will need an ffmpeg on PATH.'
} else {
    Ok ("ffmpeg bundled ({0:N0} MB)" -f ((Get-Item -LiteralPath $ffmpeg).Length / 1MB))
}

$fileCount = (Get-ChildItem -LiteralPath $Stage -Recurse -File).Count
Ok "$fileCount files staged"

# --------------------------------------------------------------------- sign ---
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$zxpPath = Join-Path $Dist 'openCaption.zxp'

if ($SkipSign) {
    Warn 'Skipping the .zxp (-SkipSign).'
    $zxpPath = $null
} else {
    Step 'Signing the extension'
    Get-ZxpSigner
    Get-SigningCert
    Invoke-Sign $Stage $zxpPath

    & $Signer -verify $zxpPath | Out-Null
    $verified = ($LASTEXITCODE -eq 0)
    if (-not $verified) { throw 'The signed .zxp did not verify.' }
    Ok ("Signed and verified ({0:N1} MB)" -f ((Get-Item -LiteralPath $zxpPath).Length / 1MB))
}

# ------------------------------------------------------------ windows bundle ---
Step 'Building the Windows installer package'
$bundleName = 'openCaption'
$bundleDir = Join-Path $Dist $bundleName
if (Test-Path -LiteralPath $bundleDir) { Remove-Item -LiteralPath $bundleDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $bundleDir | Out-Null

Copy-Item -LiteralPath (Join-Path $InstDir 'install.bat') -Destination $bundleDir
Copy-Item -LiteralPath (Join-Path $InstDir 'uninstall.bat') -Destination $bundleDir
Copy-Item -LiteralPath (Join-Path $InstDir 'install.ps1') -Destination $bundleDir
Copy-Item -LiteralPath (Join-Path $InstDir 'README-FIRST.txt') -Destination $bundleDir
Copy-Item -LiteralPath (Join-Path $Root 'LICENSE') -Destination $bundleDir
Copy-Item -LiteralPath (Join-Path $Root 'THIRD-PARTY-NOTICES.txt') -Destination $bundleDir
Copy-Item -LiteralPath $Stage -Destination (Join-Path $bundleDir 'extension') -Recurse
if ($zxpPath) { Copy-Item -LiteralPath $zxpPath -Destination $bundleDir }

# Batch files must use CRLF or cmd.exe can misread labels.
foreach ($bat in Get-ChildItem -LiteralPath $bundleDir -Filter '*.bat') {
    $text = [System.IO.File]::ReadAllText($bat.FullName)
    $text = $text -replace "`r`n", "`n" -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($bat.FullName, $text, (New-Object System.Text.ASCIIEncoding))
}

$zipPath = Join-Path $Dist "$bundleName.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $bundleDir, $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true)
Remove-Item -LiteralPath $bundleDir -Recurse -Force
Ok ("Created {0} ({1:N1} MB)" -f (Split-Path -Leaf $zipPath), ((Get-Item -LiteralPath $zipPath).Length / 1MB))

# ---------------------------------------------------------------- checksums ---
Step 'Checksums'
$lines = @()
foreach ($file in @($zxpPath, $zipPath)) {
    if (-not $file) { continue }
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines += ('{0}  {1}' -f $hash, (Split-Path -Leaf $file))
}
$sumPath = Join-Path $Dist 'SHA256SUMS.txt'
# LF line endings so `sha256sum -c` works, not just Windows tools.
[System.IO.File]::WriteAllText($sumPath, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
$lines | ForEach-Object { Note $_ }

Write-Host ''
Write-Host "Ready. Everything is in $Dist" -ForegroundColor Green
Write-Host ''
