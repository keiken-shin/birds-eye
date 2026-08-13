<#
.SYNOPSIS
  Measures first-scan vs rescan time, so the rescan number can be published.

.DESCRIPTION
  Bird's Eye cannot win first-scan wall-clock. WizTree reads the NTFS Master File Table and
  finishes a full drive in about fourteen seconds; we walk directories, because we read more
  than sizes. That trade is defensible, but only if the second half of the sentence is true:

      "The first scan takes a few minutes, because it's reading more than sizes.
       After that it only looks at what changed — so the second scan is seconds."

  That is a claim about THIS machine's behaviour, and it belongs on the homepage as a
  reproducible number rather than an adjective. This script produces the number.

  It is also a guard: if the rescan is not dramatically faster, the published sentence is
  false and must be changed before it ships. The script says so rather than quietly passing.

  SCOPE — read this before quoting the number anywhere.
  This measures the `birds-eye-scan` CLI, which runs the filesystem scan and index write only.
  It does NOT run the analysis phase: that lives in the async job path in src/native/jobs.rs,
  which only the desktop app uses. So the number here is a FLOOR for the first scan, not the
  time a real user waits — the app also classifies folders afterwards.

  That makes this number safe to publish for the rescan claim (the rescan is dominated by the
  walk either way) but NOT safe to publish as "how long Bird's Eye takes". If you want that
  figure, measure the desktop app end to end.

.PARAMETER Root
  Folder or drive to scan. Use something real and large — a benchmark on a small folder
  proves nothing about the claim.

.PARAMETER IndexPath
  Where to write the SQLite index. Defaults to a temp file that is deleted afterwards.

.PARAMETER KeepIndex
  Keep the index file instead of deleting it.

.EXAMPLE
  .\scripts\bench-rescan.ps1 -Root C:\
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$IndexPath,
  [switch]$KeepIndex
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'target\release\birds-eye-scan.exe'

if (-not (Test-Path $exe)) {
  Write-Host "Building the release scanner (a debug build would measure the wrong thing)..." -ForegroundColor Cyan
  Push-Location $repo
  try { cargo build --release --bin birds-eye-scan } finally { Pop-Location }
}
if (-not (Test-Path $exe)) { throw "Scanner not found at $exe" }

$temporary = -not $IndexPath
if ($temporary) { $IndexPath = Join-Path ([System.IO.Path]::GetTempPath()) "birds-eye-bench-$(Get-Random).sqlite" }
if (Test-Path $IndexPath) { Remove-Item $IndexPath -Force }

function Invoke-Scan {
  param([string]$Label)
  Write-Host "`n$Label" -ForegroundColor Cyan
  $output = & $exe $Root --index $IndexPath 2>&1
  $finished = $output | Select-String -Pattern '^finished ' | Select-Object -Last 1
  if (-not $finished) {
    $output | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
    throw "$Label did not report a 'finished' line."
  }
  $line = $finished.ToString()
  $parse = { param($key) if ($line -match "$key=(\d+)") { [int64]$Matches[1] } else { 0 } }
  $result = [pscustomobject]@{
    Files   = & $parse 'files'
    Folders = & $parse 'folders'
    Bytes   = & $parse 'bytes'
    Ms      = & $parse 'elapsed_ms'
  }
  '{0}: {1:N0} files, {2:N0} folders, {3:N2} s' -f $Label, $result.Files, $result.Folders, ($result.Ms / 1000) | Write-Host
  return $result
}

try {
  $first = Invoke-Scan -Label 'First scan (cold index)'
  $second = Invoke-Scan -Label 'Rescan (nothing changed)'
} finally {
  if ($temporary -and -not $KeepIndex -and (Test-Path $IndexPath)) { Remove-Item $IndexPath -Force }
}

$speedup = if ($second.Ms -gt 0) { $first.Ms / $second.Ms } else { [double]::PositiveInfinity }

Write-Host "`n--- The publishable number ---" -ForegroundColor Green
'  Second scan of a {0:N0}-file drive: {1:N1} seconds.' -f $second.Files, ($second.Ms / 1000) | Write-Host
'  (First scan: {0:N1} s — {1:N1}x slower.)' -f ($first.Ms / 1000), $speedup | Write-Host
Write-Host "`n  Machine: $env:COMPUTERNAME · $((Get-CimInstance Win32_Processor).Name.Trim())"
Write-Host "  Root:    $Root"
Write-Host "  Date:    $(Get-Date -Format 'yyyy-MM-dd')"

# The homepage sentence promises "seconds", not "less time". Hold the copy to it.
if ($second.Ms -ge $first.Ms * 0.5) {
  Write-Warning @"
The rescan was not meaningfully faster than the first scan ($([math]::Round($speedup,1))x).
The published line "the second scan is seconds" is NOT currently true on this machine.
Fix the incremental path or change the copy — do not ship the sentence as it stands.
"@
  exit 1
}

Write-Host ("`nRescan is {0:N1}x faster — the published sentence holds." -f $speedup) -ForegroundColor Green
