# Removes dsh-conversation-trash from the current DSH desktop profile.
#
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# Conversations already moved to the recycle bin stay there:
#   %USERPROFILE%\.dsh\session-trash

$ErrorActionPreference = "Stop"

$pluginName = "dsh-conversation-trash"
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$pkgFile = Join-Path $profileDir "package.json"
$targetDir = Join-Path $profileDir "node_modules\$pluginName"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

if (Test-Path -LiteralPath $targetDir) {
  Remove-Item -LiteralPath $targetDir -Recurse -Force
  Write-Host "removed: $targetDir"
}

if (Test-Path -LiteralPath $patchFile) {
  $patch = Get-Content -LiteralPath $patchFile -Raw
  $legacy = "(?ms)^\r?\n?# >>> dsh-conversation-trash.*?# <<< dsh-conversation-trash\r?\n?"
  if ($patch -match $legacy) {
    Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$stamp"
    $patch = [regex]::Replace($patch, $legacy, "`r`n")
    Set-Content -LiteralPath $patchFile -Value $patch -NoNewline -Encoding utf8
    Write-Host "legacy loader row removed"
  }
}

if (Test-Path -LiteralPath $pkgFile) {
  $pkg = Get-Content -LiteralPath $pkgFile -Raw
  $before = $pkg
  # bundle entry: a bare quoted name, either with a trailing comma or last in the array
  $pkg = [regex]::Replace($pkg, "\r?\n\s*`"$pluginName`",(?=\s*\r?\n)", "")
  $pkg = [regex]::Replace($pkg, "\r?\n\s*`"$pluginName`"(?=\s*\r?\n\s*\])", "")
  # dependency line
  $pkg = [regex]::Replace($pkg, "\r?\n\s*`"$pluginName`"\s*:\s*`"[^`"]*`",?", "")
  if ($pkg -ne $before) {
    Copy-Item -LiteralPath $pkgFile -Destination "$pkgFile.bak-$stamp"
    Set-Content -LiteralPath $pkgFile -Value $pkg -NoNewline -Encoding utf8
    Write-Host "profile package.json cleaned (backup: $pkgFile.bak-$stamp)"
  } else {
    Write-Host "no profile entries to clean"
  }
}

Write-Host ""
Write-Host "Restart DSH. Trashed conversations remain at $env:USERPROFILE\.dsh\session-trash"
