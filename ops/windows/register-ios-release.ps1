$ErrorActionPreference = "Stop"
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$scriptPath = Join-Path $PSScriptRoot "pull-ios-release.ps1"
$age = Join-Path $env:LOCALAPPDATA "BillBoard\ios-tools\age.exe"
$identity = Join-Path $checkout "tmp\releases\ios\private\identity.txt"
if (!(Test-Path -LiteralPath $age -PathType Leaf) -or !(Test-Path -LiteralPath $identity -PathType Leaf)) {
  throw "Configure the iOS release tools and private identity first."
}

$taskUser = "$env:USERDOMAIN\$env:USERNAME"
$pwshPath = (Get-Command pwsh.exe).Source
$action = New-ScheduledTaskAction -Execute $pwshPath -WorkingDirectory $checkout -Argument (
  '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"'
)
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $taskUser),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 9)
$task = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName "BillBoard iOS Release" -InputObject $task -Force | Out-Null
Write-Host "BillBoard will check for iOS releases in this user's Windows session."
