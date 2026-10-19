# Publishes dsh-conversation-trash to npm.
#
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1
#
# You need an npm access token: https://www.npmjs.com/settings/<you>/tokens
#   -> "Generate New Token" -> Classic -> "Automation" (or Publish) -> copy.
#
# The token is used for this one command only: the script writes a temporary
# .npmrc next to package.json and deletes it again, success or failure.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$npmrc = Join-Path $here ".npmrc"
$pkgFile = Join-Path $here "package.json"

$node = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $node)) { $node = "node" }
$pnpm = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"

$pkg = Get-Content -LiteralPath $pkgFile -Raw | ConvertFrom-Json
Write-Host "package : $($pkg.name)"
Write-Host "version : $($pkg.version)"
Write-Host ""

try { Start-Process "https://www.npmjs.com/settings/~/tokens" } catch { }

$token = Read-Host "Paste your npm token (npm_...)"
if (-not $token) { throw "no token given" }

$code = 1
try {
  @(
    "registry=https://registry.npmjs.org/"
    "//registry.npmjs.org/:_authToken=$token"
  ) | Set-Content -LiteralPath $npmrc -Encoding ascii

  Push-Location $here
  try {
    & $node $pnpm publish --access public --no-git-checks
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  if (Test-Path -LiteralPath $npmrc) { Remove-Item -LiteralPath $npmrc -Force }
}

if ($code -ne 0) {
  Write-Host ""
  Write-Host "publish failed (exit $code). If npm says the name is taken, bump the version"
  Write-Host "or rename the package, then run again."
  exit $code
}

Write-Host ""
Write-Host "published. Check: https://www.npmjs.com/package/$($pkg.name)"
