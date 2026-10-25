# Removes the local test install created by scripts/install-local.ps1.
#
#   pwsh -File scripts/uninstall-local.ps1 [-Profile desktop] [-DshHome C:\Users\me\.dsh]

param(
    [string]$Profile = 'desktop',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh')
)

$ErrorActionPreference = 'Stop'
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$target = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-happycode'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'

$BEGIN = '# >>> dsh-happycode (local install)'
$END = '# <<< dsh-happycode (local install)'

if (Test-Path -LiteralPath $patchFile) {
    $text = Get-Content -LiteralPath $patchFile -Raw
    $pattern = "(?s)\r?\n?" + [regex]::Escape($BEGIN) + ".*?" + [regex]::Escape($END)
    if ($text -match $pattern) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Copy-Item -LiteralPath $patchFile -Destination "$patchFile.$stamp.bak" -Force
        $updated = [regex]::Replace($text, $pattern, '')
        Set-Content -LiteralPath $patchFile -Value $updated -Encoding utf8 -NoNewline
        Write-Host "removed the patch row (backup: $patchFile.$stamp.bak)"
    } else {
        Write-Host 'no dsh-happycode row in the patch layer'
    }
}

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "removed $target"
}

Write-Host 'done. refresh the DSH page (or restart once) to unload the plugin.' -ForegroundColor Green
