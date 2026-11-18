param(
  [string] $TaskUser = "$env:USERDOMAIN\$env:USERNAME"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$taskName = "BillBoard Production Startup"
$scriptPath = Join-Path $repoRoot "ops\windows\start-production.ps1"
$pwshPath = (Get-Command pwsh.exe).Source

if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
  throw "Startup script not found"
}

$action = New-ScheduledTaskAction `
  -Execute $pwshPath `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -SkipBuild -StayAttached" `
  -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
$principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
try {
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force -ErrorAction Stop | Out-Null
}
catch {
  $accessDenied = $_.CategoryInfo.Category -eq "PermissionDenied" -or $_.FullyQualifiedErrorId -match "0x80070005" -or $_.Exception -is [UnauthorizedAccessException]
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principalCheck = [Security.Principal.WindowsPrincipal] $identity
  if (-not $accessDenied -or $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw
  }

  Write-Host "Windows denied access to the BillBoard task; retrying registration with elevation."
  $process = Start-Process `
    -FilePath $pwshPath `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -TaskUser `"$TaskUser`"" `
    -Verb RunAs `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  exit $process.ExitCode
}
Write-Host "BillBoard will start after this user signs in, using the verified commit images."
Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
