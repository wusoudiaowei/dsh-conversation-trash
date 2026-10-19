# Installs dsh-conversation-trash into the current DSH desktop profile as a
# first-class profile bundle, so it shows up in Settings -> Plugins with an
# enable/disable switch and can be removed from there.
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 files as
# ANSI, and non-ASCII text in this file breaks the parser on some locales.
# Restart DSH afterwards.

$ErrorActionPreference = "Stop"

$pluginName = "dsh-conversation-trash"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"
$patchFile = Join-Path $profileDir "cordis.patch.yml"
$pkgFile = Join-Path $profileDir "package.json"
$targetDir = Join-Path $profileDir "node_modules\$pluginName"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

function Write-NoBom($path, $text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not (Test-Path -LiteralPath $profileDir)) { throw "DSH desktop profile not found: $profileDir" }
if (-not (Test-Path -LiteralPath $patchFile)) { throw "Profile patch not found: $patchFile" }
if (-not (Test-Path -LiteralPath $pkgFile)) { throw "Profile package.json not found: $pkgFile" }

# 1. Copy the package.
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Copy-Item -LiteralPath (Join-Path $here "package.json") -Destination $targetDir -Force
Copy-Item -LiteralPath (Join-Path $here "cordis.patch.yml") -Destination $targetDir -Force
foreach ($dir in @("lib", "test")) {
  $source = Join-Path $here $dir
  if (Test-Path -LiteralPath $source) {
    $dest = Join-Path $targetDir $dir
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Copy-Item -LiteralPath $source -Destination $dest -Recurse -Force
  }
}
Write-Host "installed: $targetDir"

# 2. Drop the legacy hand-written insert row. The bundle's own
#    cordis.patch.yml declares the same row id, and two owners for one id make
#    the loader reject the entry.
$patch = [System.IO.File]::ReadAllText($patchFile)
$legacy = "(?ms)^\r?\n?# >>> dsh-conversation-trash.*?# <<< dsh-conversation-trash\r?\n?"
if ($patch -match $legacy) {
  Copy-Item -LiteralPath $patchFile -Destination "$patchFile.bak-$stamp"
  Write-NoBom $patchFile ([regex]::Replace($patch, $legacy, "`r`n"))
  Write-Host "legacy loader row removed (the bundle now owns the entry)"
} else {
  Write-Host "no legacy loader row"
}

# 3. Register the package: dependency (stops pnpm pruning it) + bundle
#    (makes it appear in Settings -> Plugins).
$pkg = [System.IO.File]::ReadAllText($pkgFile)
$spec = "file:" + ($here -replace "\\", "/")
$changed = $false

if ($pkg -notmatch ('"' + [regex]::Escape($pluginName) + '"\s*:\s*"')) {
  $pkg = ([regex]'("dependencies"\s*:\s*\{)').Replace($pkg, '$1' + "`n    `"$pluginName`": `"$spec`",", 1)
  $changed = $true
  Write-Host "dependency added: $spec"
} else {
  Write-Host "dependency already present"
}

$m = [regex]::Match($pkg, '("bundles"\s*:\s*\[)([\s\S]*?)\]')
if (-not $m.Success) {
  Write-Host "WARNING: no bundles array found; add `"$pluginName`" to dsh.profile.bundles by hand"
} elseif ($m.Groups[2].Value -match [regex]::Escape($pluginName)) {
  Write-Host "profile bundle already present"
} else {
  $entry = $m.Groups[2].Value.TrimEnd()
  if (-not $entry.EndsWith(",")) { $entry = $entry + "," }
  $pkg = $pkg.Replace($m.Value, $m.Groups[1].Value + $entry + "`n        `"$pluginName`"`n      ]")
  $changed = $true
  Write-Host "profile bundle added"
}

if ($changed) {
  Copy-Item -LiteralPath $pkgFile -Destination "$pkgFile.bak-$stamp"
  Write-NoBom $pkgFile $pkg
  Write-Host "profile package.json updated (backup: $pkgFile.bak-$stamp)"
}

Write-Host ""
Write-Host "Done. Fully quit DSH (tray icon -> Quit), then start it again."
Write-Host "Then open Settings -> Plugins -> Installed, find $pluginName, enable it."
