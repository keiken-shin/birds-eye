#requires -version 5
<#
  Build a Microsoft Store-ready MSIX for Birds Eye.

  The Microsoft Store code-signs the MSIX on submission, so the file this produces is
  intentionally UNSIGNED and needs no certificate. That's what you upload to Partner Center.

  Usage:
    scripts\build-msix.ps1              # build unsigned .msix for Store submission
    scripts\build-msix.ps1 -DevInstall  # also self-sign + install locally to test the package
    scripts\build-msix.ps1 -SkipBuild   # reuse the existing release exe, just repackage

  Prereqs: Node + Rust toolchain, and winapp CLI (winget install microsoft.winappcli).
#>
param(
  [switch]$DevInstall,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'

$root     = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'src-tauri\Package.appxmanifest'
$icons    = Join-Path $root 'src-tauri\icons'
$exe      = Join-Path $root 'src-tauri\target\release\birds-eye-desktop.exe'
$stage    = Join-Path $root 'src-tauri\target\msix-stage'

if (-not (Get-Command winapp -ErrorAction SilentlyContinue)) {
  throw "winapp CLI not found. Install it: winget install microsoft.winappcli --source winget"
}

# 1. Build the release exe (tauri's beforeBuildCommand builds the frontend first).
if (-not $SkipBuild) {
  Push-Location (Join-Path $root 'workspace')
  try { npm run tauri:build:app } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "Release exe not found at $exe. Run without -SkipBuild first." }

# 2. Stage the package layout: exe + Assets + manifest.
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $stage 'Assets') | Out-Null
Copy-Item $exe (Join-Path $stage 'birds-eye-desktop.exe')
Copy-Item (Join-Path $icons 'Square*.png') (Join-Path $stage 'Assets')
Copy-Item (Join-Path $icons 'StoreLogo.png') (Join-Path $stage 'Assets')

# 3. Package as MSIX. No --cert => unsigned, which is what the Store wants.
Push-Location $stage
try {
  if ($DevInstall) {
    # Self-sign with a dev cert and install so you can launch it locally to verify.
    winapp package $stage --manifest $manifest --generate-cert --install-cert
  } else {
    winapp package $stage --manifest $manifest
  }
} finally { Pop-Location }

$msix = Get-ChildItem $stage -Filter *.msix | Select-Object -First 1
if (-not $msix) { throw "Packaging failed: no .msix produced in $stage" }
Write-Host "`nMSIX ready: $($msix.FullName)" -ForegroundColor Green
if (-not $DevInstall) {
  Write-Host "Upload this file in Partner Center. Replace Identity Name/Publisher in" -ForegroundColor Yellow
  Write-Host "src-tauri\Package.appxmanifest with your Product Identity values first." -ForegroundColor Yellow
}
