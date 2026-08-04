$ErrorActionPreference = 'Stop'
$toolsDir = "$(Split-Path -parent $MyInvocation.MyCommand.Definition)"
$exe = Join-Path $toolsDir 'birds-eye.exe'

# Get-ChocolateyWebFile left no registry entry to reverse, and Chocolatey deletes the whole
# package directory - including the exe and the shim it auto-generated - on uninstall anyway.
# This is a defensive no-op in case a partial/interrupted removal leaves the file behind.
if (Test-Path $exe) {
  Remove-Item $exe -Force
}
