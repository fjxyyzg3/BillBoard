param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $BackupDir
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$localBackupDir = Join-Path $repoRoot "tmp\backups"
$backupId = [Guid]::NewGuid().ToString("N")
$fileName = "billboard-{0}-{1}.dump" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $backupId.Substring(0, 8)
$containerPath = "/tmp/billboard-backup-$backupId.dump"
$localPartialPath = Join-Path $localBackupDir "$fileName.partial"
$localFinalPath = Join-Path $localBackupDir $fileName
$destinationPartialPath = $null
$containerId = $null
$localVerified = $false
$localPartialOwned = $false

function Invoke-BackupDocker {
  param([string[]] $Arguments, [switch] $AllowFailure)

  # Native output can contain database details or private destination paths.
  $output = @(& docker --context desktop-linux @Arguments 2>&1 | ForEach-Object { "$_" })
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "A Docker backup operation failed with exit code $exitCode"
  }
  return @{ ExitCode = $exitCode; Output = $output }
}

try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker Desktop CLI was not found"
  }
  New-Item -ItemType Directory -Force -Path $localBackupDir | Out-Null
  if ((Test-Path -LiteralPath $localPartialPath) -or (Test-Path -LiteralPath $localFinalPath)) {
    throw "The generated backup filename already exists locally"
  }
  $containers = Invoke-BackupDocker -Arguments @(
    "ps", "-q",
    "--filter", "label=com.docker.compose.project=billboard",
    "--filter", "label=com.docker.compose.service=db",
    "--filter", "status=running"
  )
  $containerIds = @($containers.Output | Where-Object { $_ -match '^[0-9a-f]{12,64}$' })
  if ($containerIds.Count -ne 1) {
    throw "Exactly one running BillBoard production database is required"
  }
  $containerId = $containerIds[0]

  $dumpCommand = 'umask 077; pg_dump --format=custom --no-owner --no-acl --file "$1" --username "$POSTGRES_USER" "$POSTGRES_DB"'
  $null = Invoke-BackupDocker -Arguments @("exec", $containerId, "sh", "-c", $dumpCommand, "sh", $containerPath)
  $null = Invoke-BackupDocker -Arguments @("exec", $containerId, "pg_restore", "--list", $containerPath)
  $checksumResult = Invoke-BackupDocker -Arguments @("exec", $containerId, "sha256sum", $containerPath)
  $checksumMatch = [regex]::Match(($checksumResult.Output -join ""), '^[0-9a-f]{64}')
  if (-not $checksumMatch.Success) {
    throw "The database archive checksum could not be verified"
  }

  $copySource = "{0}:{1}" -f $containerId, $containerPath
  $localPartialOwned = $true
  $null = Invoke-BackupDocker -Arguments @("cp", $copySource, $localPartialPath)
  if ((Get-Item -LiteralPath $localPartialPath).Length -eq 0 -or (Get-FileHash -LiteralPath $localPartialPath -Algorithm SHA256).Hash -ne $checksumMatch.Value) {
    throw "The local archive checksum does not match the database archive"
  }
  Move-Item -LiteralPath $localPartialPath -Destination $localFinalPath
  $localVerified = $true

  # Keep the verified local archive even if a NAS destination is unavailable.
  if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) {
    throw "The configured backup destination is unavailable"
  }
  $destinationDir = (Resolve-Path -LiteralPath $BackupDir).ProviderPath
  $localResolvedDir = (Resolve-Path -LiteralPath $localBackupDir).ProviderPath
  if ($destinationDir.TrimEnd('\') -ine $localResolvedDir.TrimEnd('\')) {
    $destinationPartialPath = Join-Path $destinationDir "$fileName.partial"
    $destinationFinalPath = Join-Path $destinationDir $fileName
    if ((Test-Path -LiteralPath $destinationPartialPath) -or (Test-Path -LiteralPath $destinationFinalPath)) {
      $destinationPartialPath = $null
      throw "The generated backup filename already exists at the destination"
    }
    Copy-Item -LiteralPath $localFinalPath -Destination $destinationPartialPath
    if ((Get-FileHash -LiteralPath $destinationPartialPath -Algorithm SHA256).Hash -ne $checksumMatch.Value) {
      throw "The destination archive checksum does not match the verified local archive"
    }
    Move-Item -LiteralPath $destinationPartialPath -Destination $destinationFinalPath
    $destinationPartialPath = $null
  }
  Write-Output "Backup verified locally and at the configured destination: $fileName"
}
catch {
  if ($localVerified) {
    Write-Error "Backup delivery failed. The verified local archive is retained at tmp/backups/$fileName." -ErrorAction Continue
  }
  else {
    Write-Error "Production backup failed before a local archive could be verified." -ErrorAction Continue
  }
  exit 1
}
finally {
  if ($containerId) {
    $null = Invoke-BackupDocker -Arguments @("exec", $containerId, "rm", "-f", "--", $containerPath) -AllowFailure
  }
  if ($localPartialOwned -and (Test-Path -LiteralPath $localPartialPath)) {
    Remove-Item -LiteralPath $localPartialPath -ErrorAction SilentlyContinue
  }
  if ($destinationPartialPath) {
    Remove-Item -LiteralPath $destinationPartialPath -ErrorAction SilentlyContinue
  }
}
