$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$age = Join-Path $env:LOCALAPPDATA "BillBoard\ios-tools\age.exe"
$identity = Join-Path $checkout "tmp\releases\ios\private\identity.txt"
$logDirectory = Join-Path $checkout "tmp\logs"

if (!(Test-Path -LiteralPath $age -PathType Leaf) -or !(Test-Path -LiteralPath $identity -PathType Leaf)) {
  throw "Configure the iOS release tools and private identity first."
}

$mutex = [System.Threading.Mutex]::new($false, "Local\BillBoardIosRelease")
$held = $false
try {
  try { $held = $mutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $held = $true }
  if (!$held) { return }
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  Push-Location -LiteralPath $checkout
  try {
    $lines = & node "ops/ios/pull-release.mjs" $age $identity 2>&1
    $code = $LASTEXITCODE
    Set-Content -LiteralPath (Join-Path $logDirectory "ios-publication.log") -Value (@(Get-Date -AsUTC -Format o) + @($lines))
    if ($code -ne 0) { exit $code }
  } finally {
    Pop-Location
  }
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
