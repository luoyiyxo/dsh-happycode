# Installs this working copy into a local DSH profile for testing.
#
#   pwsh -File scripts/install-local.ps1 [-Profile desktop] [-DshHome C:\Users\me\.dsh] [-NoPatch]
#
# It copies the package into <profile>/node_modules/dsh-happycode and appends one
# `insert:` row to the profile's cordis.patch.yml between two marker comments, so
# DSH composes the plugin on the next composition pass (usually ~1 s, no restart)
# and a page refresh picks up the client half. `-NoPatch` copies files only.

param(
    [string]$Profile = 'desktop',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$NoPatch
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$target = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-happycode'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

$BEGIN = '# >>> dsh-happycode (local install)'
$END = '# <<< dsh-happycode (local install)'

if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile directory not found: $profileDir"
}

Write-Host "installing $source"
Write-Host "        -> $target"

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($entry in @('lib', 'client', 'assets', 'docs', 'cordis.patch.yml', 'package.json', 'README.md', 'README.zh.md', 'LICENSE', 'CHANGELOG.md')) {
    $from = Join-Path $source $entry
    if (-not (Test-Path -LiteralPath $from)) { continue }
    Copy-Item -LiteralPath $from -Destination $target -Recurse -Force
}

if (-not $NoPatch) {
    if (-not (Test-Path -LiteralPath $patchFile)) {
        Set-Content -LiteralPath $patchFile -Value "# Your patch layer for this dsh profile`n[]" -Encoding utf8
    }
    $text = Get-Content -LiteralPath $patchFile -Raw
    if ($text -notmatch [regex]::Escape($BEGIN)) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -LiteralPath $patchFile -Destination "$patchFile.$stamp.bak" -Force
        $block = @"

$BEGIN
- insert:
    - id: dsh-happycode
      name: 'dsh-happycode'
$END
"@
        Add-Content -LiteralPath $patchFile -Value $block -Encoding utf8
        Write-Host "patched $patchFile (backup: $patchFile.$stamp.bak)"
    } else {
        Write-Host "patch layer already contains the dsh-happycode row"
    }
}

Write-Host ''
Write-Host 'done. next:' -ForegroundColor Green
Write-Host '  1. wait a second for the composition to reload, then refresh the DSH page'
Write-Host '  2. the avatar menu at the bottom-left should now list HappyCode between Settings and Feedback'
Write-Host '  3. if the entry does not appear, restart DSH once (the patch layer is read at boot)'
Write-Host ''
Write-Host 'uninstall: pwsh -File scripts/uninstall-local.ps1'
