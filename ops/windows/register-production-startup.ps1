$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$taskName = "BillBoard Production Startup"
$scriptPath = Join-Path $repoRoot "ops\windows\start-production.ps1"
$pwshPath = (Get-Command pwsh.exe).Source
$userId = "$env:USERDOMAIN\$env:USERNAME"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = [Security.Principal.WindowsPrincipal] $identity
$isAdmin = $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not (Test-Path $scriptPath)) {
  throw "Startup script not found: $scriptPath"
}

if (-not $isAdmin) {
  Write-Host "Registering an at-startup task requires an elevated PowerShell session."
  Write-Host "Opening an elevated registration process. Approve the Windows UAC prompt to continue."
  $process = Start-Process `
    -FilePath $pwshPath `
    -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" `
    -Verb RunAs `
    -Wait `
    -PassThru

  exit $process.ExitCode
}

$action = New-ScheduledTaskAction `
  -Execute $pwshPath `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -StayAttached" `
  -WorkingDirectory $repoRoot

$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force -ErrorAction Stop | Out-Null

Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
