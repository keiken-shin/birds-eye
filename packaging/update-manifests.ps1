#requires -version 5
<#
  Bump every package manifest (winget, Scoop, Chocolatey) to a new released version.

  Downloads the real release asset, computes its SHA256, and rewrites the version + hash
  in all three manifest sets so they never rot after the first release. Re-reads every file
  afterwards and fails loudly if a rewrite didn't take.

  Usage:
    packaging\update-manifests.ps1 -Version 0.2.2

  Prereq: the GitHub release for that version must already be published, with the
  'birds-eye-windows-portable-x64.exe' asset attached (see docs/develop/releasing.md).
#>
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version
)
$ErrorActionPreference = 'Stop'

$identifier  = 'keiken-shin.BirdsEye'
$assetName   = 'birds-eye-windows-portable-x64.exe'
$tag         = "v$Version"
$downloadUrl = "https://github.com/keiken-shin/birds-eye/releases/download/$tag/$assetName"

$wingetRoot     = Join-Path $PSScriptRoot 'winget\manifests\k\keiken-shin\BirdsEye'
$scoopManifest  = Join-Path $PSScriptRoot 'scoop\bucket\birds-eye.json'
$nuspecFile     = Join-Path $PSScriptRoot 'chocolatey\birds-eye.nuspec'
$chocoInstall   = Join-Path $PSScriptRoot 'chocolatey\tools\chocolateyInstall.ps1'

# ---------------------------------------------------------------------------
# 1. Download the real asset and hash it. No hash is ever invented.
# ---------------------------------------------------------------------------
$tmpFile = Join-Path ([System.IO.Path]::GetTempPath()) "$assetName.$Version"
Write-Host "Downloading $downloadUrl" -ForegroundColor Cyan
try {
  Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing
} catch {
  throw "Could not download $downloadUrl - has release '$tag' been published on GitHub yet, with the '$assetName' asset attached? ($($_.Exception.Message))"
}
$hashUpper = (Get-FileHash -Path $tmpFile -Algorithm SHA256).Hash.ToUpperInvariant()
$hashLower = $hashUpper.ToLowerInvariant()
Remove-Item $tmpFile -Force
Write-Host "SHA256: $hashLower`n" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 2. winget - each version gets its own manifest folder. Copy the latest one
#    (for the description/tags that don't change release to release) unless
#    this version's folder already exists, then bump the version-specific bits.
# ---------------------------------------------------------------------------
$existingDirs = Get-ChildItem -Path $wingetRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -as [version] }
if (-not $existingDirs) {
  throw "No existing winget version folder under $wingetRoot to copy metadata from. Hand-create the first version folder, then use this script for subsequent bumps."
}
$targetDir = Join-Path $wingetRoot $Version
if (-not (Test-Path $targetDir)) {
  $latest = $existingDirs | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
  Copy-Item -Path $latest.FullName -Destination $targetDir -Recurse
  Write-Host "winget: created $Version\ (copied from $($latest.Name)\)" -ForegroundColor Cyan
} else {
  Write-Host "winget: $Version\ already exists, updating in place" -ForegroundColor Cyan
}

$versionFile   = Join-Path $targetDir "$identifier.yaml"
$installerFile = Join-Path $targetDir "$identifier.installer.yaml"
$localeFile    = Join-Path $targetDir "$identifier.locale.en-US.yaml"

foreach ($f in @($versionFile, $installerFile, $localeFile)) {
  (Get-Content -Raw -Path $f) -replace '(?m)^PackageVersion:.*$', "PackageVersion: $Version" |
    Set-Content -Path $f -NoNewline
}

$today = Get-Date -Format 'yyyy-MM-dd'
$installerContent = Get-Content -Raw -Path $installerFile
$installerContent = $installerContent -replace '(?m)^\s*# PLACEHOLDER.*\r?\n', ''
$installerContent = $installerContent -replace '(?m)^(\s*InstallerUrl:).*$', "`${1} $downloadUrl"
$installerContent = $installerContent -replace '(?m)^(\s*InstallerSha256:).*$', "`${1} $hashUpper"
$installerContent = $installerContent -replace '(?m)^(\s*ReleaseDate:).*$', "`${1} $today"
Set-Content -Path $installerFile -Value $installerContent -NoNewline

# ---------------------------------------------------------------------------
# 3. Scoop - one manifest, mutated in place. JSON in, JSON out (no regex).
# ---------------------------------------------------------------------------
$scoop = Get-Content -Raw -Path $scoopManifest | ConvertFrom-Json
$scoop.version = $Version
$scoop.url = $downloadUrl
$scoop.hash = $hashLower
if ($scoop.PSObject.Properties['##']) { $scoop.PSObject.Properties.Remove('##') }
$scoop | ConvertTo-Json -Depth 10 | Set-Content -Path $scoopManifest
Write-Host "scoop: updated bucket\birds-eye.json" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 4. Chocolatey - version lives in the nuspec (XML), url/checksum in the
#    install script (plain PowerShell). Strip the placeholder XML comment
#    once a real version has been written.
# ---------------------------------------------------------------------------
$nuspecRaw = (Get-Content -Raw -Path $nuspecFile) -replace '(?s)<!-- PLACEHOLDER checksum.*?-->\r?\n', ''
[xml]$nuspecXml = $nuspecRaw
$nuspecXml.package.metadata.version = $Version
$nuspecXml.Save($nuspecFile)
Write-Host "chocolatey: updated birds-eye.nuspec" -ForegroundColor Cyan

$installPs1 = Get-Content -Raw -Path $chocoInstall
$installPs1 = $installPs1 -replace "(?m)^(\s*url\s*=\s*)'[^']*'.*$", "`${1}'$downloadUrl'"
$installPs1 = $installPs1 -replace "(?m)^(\s*checksum\s*=\s*)'[^']*'.*$", "`${1}'$hashLower'"
Set-Content -Path $chocoInstall -Value $installPs1 -NoNewline
Write-Host "chocolatey: updated tools\chocolateyInstall.ps1" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 5. Verify. Re-read every file back and fail loudly if a rewrite didn't take.
# ---------------------------------------------------------------------------
Write-Host "`nVerifying..." -ForegroundColor Cyan

function Assert-Match {
  param([string]$Path, [string]$Pattern, [string]$Label)
  if ((Get-Content -Raw -Path $Path) -notmatch $Pattern) {
    throw "Verification FAILED: $Label ($Path) does not match expected pattern."
  }
  Write-Host "  OK  $Label" -ForegroundColor Green
}

Assert-Match $versionFile   "(?m)^PackageVersion: $([regex]::Escape($Version))$" 'winget version manifest'
Assert-Match $localeFile    "(?m)^PackageVersion: $([regex]::Escape($Version))$" 'winget locale manifest'
Assert-Match $installerFile "(?m)^PackageVersion: $([regex]::Escape($Version))$" 'winget installer manifest version'
Assert-Match $installerFile "(?m)^\s*InstallerUrl: $([regex]::Escape($downloadUrl))$" 'winget installer URL'
Assert-Match $installerFile "(?m)^\s*InstallerSha256: $hashUpper$" 'winget installer hash'

$scoopCheck = Get-Content -Raw -Path $scoopManifest | ConvertFrom-Json
if ($scoopCheck.version -ne $Version)    { throw "Verification FAILED: scoop version mismatch" }
if ($scoopCheck.url -ne $downloadUrl)    { throw "Verification FAILED: scoop url mismatch" }
if ($scoopCheck.hash -ne $hashLower)     { throw "Verification FAILED: scoop hash mismatch" }
Write-Host "  OK  scoop manifest" -ForegroundColor Green

[xml]$nuspecCheck = Get-Content -Raw -Path $nuspecFile
if ($nuspecCheck.package.metadata.version -ne $Version) { throw "Verification FAILED: nuspec version mismatch" }
Write-Host "  OK  chocolatey nuspec" -ForegroundColor Green

Assert-Match $chocoInstall ([regex]::Escape("url          = '$downloadUrl'")) 'chocolatey install url'
Assert-Match $chocoInstall ([regex]::Escape("checksum     = '$hashLower'")) 'chocolatey install checksum'

Write-Host "`nAll manifests now point at $Version ($hashLower)." -ForegroundColor Green
