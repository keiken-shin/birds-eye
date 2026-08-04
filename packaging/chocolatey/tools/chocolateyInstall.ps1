$ErrorActionPreference = 'Stop'
$toolsDir = "$(Split-Path -parent $MyInvocation.MyCommand.Definition)"

# Bird's Eye ships as a single portable .exe on GitHub Releases - no installer, no MSI.
# Chocolatey auto-shims any bare .exe it finds under tools\, so downloading it there
# under a clean name is the entire install step.
$packageArgs = @{
  packageName  = $env:ChocolateyPackageName
  fileFullPath = Join-Path $toolsDir 'birds-eye.exe'
  url          = 'https://github.com/keiken-shin/birds-eye/releases/download/v0.2.1/birds-eye-windows-portable-x64.exe'
  # PLACEHOLDER - not a real hash. Run packaging/update-manifests.ps1 -Version <version> to fill this in.
  checksum     = '0000000000000000000000000000000000000000000000000000000000000000'
  checksumType = 'sha256'
}

Get-ChocolateyWebFile @packageArgs
