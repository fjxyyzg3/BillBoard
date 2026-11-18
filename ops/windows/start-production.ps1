param(
  [switch] $StayAttached,
  [switch] $SkipBuild,
  [switch] $BuildOnly,
  [int] $PrivateSmokePort = 0
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$envFile = Join-Path $repoRoot ".env.production.local"
$composeFile = Join-Path $repoRoot "compose.yml"
$logDir = Join-Path $repoRoot "tmp\logs"
$opsContainerName = "billboard-ops"
$script:redactedValues = @()

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "production-startup.log"

function Protect-LogText {
  param([string] $Text)

  foreach ($value in $script:redactedValues) {
    if ($value) {
      $Text = $Text.Replace($value, "<redacted>")
    }
  }
  return ($Text -replace '(?i)(postgres(?:ql)?://)[^\s]+', '$1<redacted>')
}

function Write-Log {
  param([string] $Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $safeMessage = Protect-LogText -Text $Message
  "[$timestamp] $safeMessage" | Tee-Object -FilePath $logFile -Append | Out-Null
}

function Read-EnvFile {
  param([string] $Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The private .env.production.local file is required"
  }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $index = $trimmed.IndexOf("=")
    if ($index -le 0) {
      continue
    }
    $name = $trimmed.Substring(0, $index).Trim()
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "The private env file contains an invalid variable name"
    }
    $value = $trimmed.Substring($index + 1).Trim()
    if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$name] = $value
  }
  return $values
}

function Set-LogRedactions {
  param([hashtable] $EnvValues)

  $values = @($EnvValues.Values | Where-Object { $_.Length -ge 4 })
  foreach ($name in @("AUTH_SECRET", "POSTGRES_PASSWORD", "DATABASE_URL", "IMPORT_AGENT_TOKEN", "WHEELMAKER_API_KEY", "WHEELMAKER_BASE_URL", "VOLCENGINE_ASR_API_KEY", "VOICE_AUDIO_PUBLIC_ORIGIN", "APP_PUBLIC_ORIGIN", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL", "OPS_ADMIN_PASSWORD_HASH", "OPS_ADMIN_PASSWORD_HASH_BASE64")) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($value) {
      $values += @($value, [Uri]::EscapeDataString($value))
    }
  }
  if ($env:OPS_ADMIN_PASSWORD_HASH_BASE64) {
    try {
      $values += [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPS_ADMIN_PASSWORD_HASH_BASE64))
    }
    catch {
      # Never log a supplied hash, including a malformed base64 value.
    }
  }
  $script:redactedValues = @($values | Where-Object { $_ } | Select-Object -Unique | Sort-Object -Property Length -Descending)
}

function Assert-RequiredProductionSecret {
  param([string] $Name, [string] $Value, [string] $DefaultValue)

  $placeholders = @("replace-me", "change-me", "change-me-before-launch", "development-auth-secret", "password")
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "$Name is required in the private production environment"
  }
  if (($DefaultValue -and $Value -eq $DefaultValue) -or $placeholders -contains $Value) {
    throw "$Name must not use a default or placeholder value"
  }
}

function Invoke-Logged {
  param([string] $FilePath, [string[]] $Arguments, [switch] $AllowFailure, [switch] $Quiet)

  if (-not $Quiet) {
    Write-Log ("RUN {0} {1}" -f $FilePath, ($Arguments -join " "))
  }
  $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
  $exitCode = $LASTEXITCODE
  if (-not $Quiet) {
    foreach ($line in $output) {
      Write-Log $line
    }
  }
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "$FilePath exited with code $exitCode"
  }
  return @{ ExitCode = $exitCode; Output = $output }
}

function Invoke-Docker {
  param([string[]] $Arguments, [switch] $AllowFailure, [switch] $Quiet)

  return Invoke-Logged -FilePath "docker" -Arguments (@("--context", "desktop-linux") + $Arguments) -AllowFailure:$AllowFailure -Quiet:$Quiet
}

function Invoke-Compose {
  param([string[]] $Arguments)

  return Invoke-Docker -Arguments (@("compose", "--project-name", "billboard", "--env-file", $envFile, "-f", $composeFile) + $Arguments)
}

function Assert-PublishedCheckout {
  $branch = Invoke-Logged -FilePath "git" -Arguments @("-C", $repoRoot, "branch", "--show-current") -Quiet
  if (($branch.Output -join "").Trim() -ne "master") {
    throw "Production must be started from master"
  }
  $status = Invoke-Logged -FilePath "git" -Arguments @("-C", $repoRoot, "status", "--porcelain", "--untracked-files=normal") -Quiet
  if ($status.Output.Count -ne 0) {
    throw "Production requires a clean checkout; commit or isolate local changes first"
  }
  $head = Invoke-Logged -FilePath "git" -Arguments @("-C", $repoRoot, "rev-parse", "HEAD") -Quiet
  $remote = Invoke-Logged -FilePath "git" -Arguments @("-C", $repoRoot, "rev-parse", "refs/remotes/origin/master") -Quiet
  $revision = ($head.Output -join "").Trim()
  if ($revision -notmatch '^[0-9a-f]{40,64}$' -or $revision -ne ($remote.Output -join "").Trim()) {
    throw "Production HEAD must match origin/master; synchronize and verify the pushed commit first"
  }
  return $revision
}

function Wait-DockerDesktop {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker Desktop CLI was not found"
  }
  $desktopStarted = $false
  for ($attempt = 1; $attempt -le 90; $attempt++) {
    $engine = Invoke-Docker -Arguments @("info", "--format", "{{.OSType}}") -AllowFailure -Quiet
    if ($engine.ExitCode -eq 0) {
      if (($engine.Output -join "").Trim() -ne "linux") {
        throw "Docker Desktop must use Linux containers"
      }
      $null = Invoke-Docker -Arguments @("compose", "version")
      Write-Log "Docker Desktop Linux engine is ready"
      return
    }
    if (-not $desktopStarted) {
      $desktopPath = @(
        (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe")
      ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
      if (-not $desktopPath) {
        throw "Docker Desktop is unavailable; install it and enable Linux containers"
      }
      if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
        $null = Start-Process -FilePath $desktopPath -WindowStyle Hidden -PassThru
      }
      $desktopStarted = $true
      Write-Log "Waiting for Docker Desktop in the signed-in Windows session"
    }
    Start-Sleep -Seconds 2
  }
  throw "Docker Desktop Linux engine did not become ready"
}

function Assert-ImageRevision {
  param([string] $Image, [string] $Revision)

  $result = Invoke-Docker -Arguments @("image", "inspect", $Image, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}') -AllowFailure -Quiet
  if ($result.ExitCode -ne 0 -or ($result.Output -join "").Trim() -ne $Revision) {
    throw "A verified image for the current commit is missing; rerun start-production.ps1 without -SkipBuild"
  }
}

function Get-BillAnalysisRuntimeCandidates {
  $composePrefix = @("compose", "--project-name", "billboard", "--env-file", $envFile, "-f", $composeFile)
  $containers = Invoke-Docker -Arguments ($composePrefix + @("ps", "--all", "--quiet", "web")) -Quiet
  foreach ($containerId in @($containers.Output | Where-Object { $_.Trim() })) {
    $containerId = $containerId.Trim()
    if ($containerId -notmatch '^[0-9a-f]{64}$') {
      throw "The previous web container could not be identified safely"
    }
    $identityFormat = '{{.Id}} {{.Config.Hostname}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.oneoff"}}'
    $identity = Invoke-Docker -Arguments @("container", "inspect", $containerId, "--format", $identityFormat) -Quiet
    $parts = (($identity.Output -join "").Trim() -split '\s+')
    if ($parts.Count -ne 5 -or $parts[0] -ne $containerId -or $parts[1] -ne $containerId.Substring(0, 12) -or
        $parts[2] -ne "billboard" -or $parts[3] -ne "web" -or $parts[4] -ne "False") {
      throw "The previous web runtime must have a unique Docker hostname and the expected Compose identity"
    }
    [PSCustomObject]@{ Id = $containerId; Runtime = $parts[1] }
  }
}

function Clear-StoppedBillAnalysisExecutions {
  param([object[]] $Candidates)

  if (-not $Candidates -or $Candidates.Count -eq 0) { return 0 }
  $composePrefix = @("compose", "--project-name", "billboard", "--env-file", $envFile, "-f", $composeFile)
  $current = Invoke-Docker -Arguments ($composePrefix + @("ps", "--quiet", "web")) -Quiet
  $currentIds = @($current.Output | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
  if ($currentIds.Count -eq 0 -or @($currentIds | Where-Object { $_ -notmatch '^[0-9a-f]{64}$' }).Count -ne 0) {
    throw "A healthy replacement web container must be identified before analysis cleanup"
  }
  $stoppedRuntimes = @()
  foreach ($candidate in $Candidates) {
    $containerId = [string] $candidate.Id
    $runtime = [string] $candidate.Runtime
    if ($containerId -notmatch '^[0-9a-f]{64}$' -or $runtime -ne $containerId.Substring(0, 12)) {
      throw "The captured web runtime identity is invalid"
    }
    if ($currentIds -contains $containerId) { continue }
    $present = Invoke-Docker -Arguments @("container", "ls", "--all", "--no-trunc", "--filter", "id=$containerId", "--format", "{{.ID}}") -Quiet
    $presentIds = @($present.Output | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
    if ($presentIds.Count -gt 1 -or ($presentIds.Count -eq 1 -and $presentIds[0] -ne $containerId)) {
      throw "The retired web container could not be verified"
    }
    if ($presentIds.Count -eq 1) {
      $identityFormat = '{{.Id}} {{.Config.Hostname}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.oneoff"}}'
      $identity = Invoke-Docker -Arguments @("container", "inspect", $containerId, "--format", $identityFormat) -Quiet
      $parts = (($identity.Output -join "").Trim() -split '\s+')
      if ($parts.Count -ne 5 -or $parts[0] -ne $containerId -or $parts[1] -ne $runtime -or
          $parts[2] -ne "billboard" -or $parts[3] -ne "web" -or $parts[4] -ne "False") {
        throw "The retired web container no longer matches its captured identity"
      }
      # An explicit stop also suppresses an automatic restart of this retired container.
      $null = Invoke-Docker -Arguments @("container", "stop", "--time", "30", $containerId) -Quiet
      $state = Invoke-Docker -Arguments @("container", "inspect", $containerId, "--format", '{{.Id}} {{.Config.Hostname}} {{.State.Running}} {{.State.Restarting}}') -Quiet
      $stateParts = (($state.Output -join "").Trim() -split '\s+')
      if ($stateParts.Count -ne 4 -or $stateParts[0] -ne $containerId -or $stateParts[1] -ne $runtime -or
          $stateParts[2] -ne "false" -or $stateParts[3] -ne "false") {
        throw "The retired web runtime has not been confirmed stopped"
      }
    }
    $stoppedRuntimes += $runtime
  }
  if ($stoppedRuntimes.Count -eq 0) { return 0 }
  $arguments = $composePrefix + @("run", "--rm", "--no-deps", "bootstrap", "node", "--import", "tsx", "ops/reports/reap-bill-analysis.mjs")
  foreach ($runtime in @($stoppedRuntimes | Select-Object -Unique)) { $arguments += @("--stopped-runtime", $runtime) }
  $cleanup = Invoke-Docker -Arguments $arguments -Quiet
  $receipts = @($cleanup.Output | Where-Object { $_ -match '^\{"reaped":\d+\}$' })
  if ($receipts.Count -ne 1) { throw "The stopped analysis cleanup did not return a valid receipt" }
  $receipt = $receipts[0] | ConvertFrom-Json
  Write-Log "Verified retired analysis runtime cleanup completed"
  return $receipt.reaped
}

function Test-PageAndChunk {
  param([int] $Port, [string] $PagePath, [switch] $RequirePassword)

  $origin = "http://127.0.0.1:$Port"
  $page = Invoke-WebRequest -Uri "$origin$PagePath" -UseBasicParsing -TimeoutSec 20
  if ($page.StatusCode -ne 200) {
    throw "The local application page did not return HTTP 200"
  }
  if ($RequirePassword -and $page.Content -notmatch 'name="password"') {
    throw "OPS is not showing an enabled password login form"
  }
  $match = [regex]::Match($page.Content, 'src="([^"\s]+\.js[^"\s]*)"')
  if (-not $match.Success) {
    throw "The local application page did not contain a JavaScript chunk"
  }
  $chunkPath = [Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
  $chunkUri = [Uri]::new([Uri]::new($origin), $chunkPath)
  if ($chunkUri.Host -ne "127.0.0.1" -or $chunkUri.Port -ne $Port -or $chunkUri.Scheme -ne "http") {
    throw "The JavaScript chunk must use the local application origin"
  }
  $chunk = Invoke-WebRequest -Uri $chunkUri -UseBasicParsing -TimeoutSec 20
  if ($chunk.StatusCode -ne 200 -or $chunk.Headers["Content-Type"] -notmatch 'javascript') {
    throw "The local JavaScript chunk was not served successfully"
  }
  Write-Log "Verified local $PagePath and its JavaScript chunk on port $Port"
}

function Start-OpsAdmin {
  param([string] $Image)

  if ($env:OPS_ADMIN_ENABLED -eq "true" -and -not $env:OPS_ADMIN_PASSWORD_HASH -and -not $env:OPS_ADMIN_PASSWORD_HASH_BASE64) {
    throw "OPS admin is enabled but its private password hash is missing"
  }
  $existing = Invoke-Docker -Arguments @("container", "inspect", $opsContainerName, "--format", "{{.Id}}") -AllowFailure -Quiet
  if ($existing.ExitCode -eq 0) {
    $null = Invoke-Docker -Arguments @("rm", "-f", $opsContainerName)
  }
  if ($env:OPS_ADMIN_ENABLED -ne "true") {
    Write-Log "OPS admin is disabled; no Docker OPS container remains"
    return $false
  }
  $runArgs = @(
    "run", "-d", "--name", $opsContainerName,
    "--network", "billboard_default", "--restart", "unless-stopped",
    "-p", "127.0.0.1:32768:3000",
    "-e", "NODE_ENV=production", "-e", "NEXT_TELEMETRY_DISABLED=1",
    "-e", "DATABASE_URL", "-e", "AUTH_SECRET", "-e", "POSTGRES_PASSWORD",
    "-e", "APP_BASE_PATH",
    "-e", "OPS_ADMIN_ENABLED", "-e", "OPS_ADMIN_INSTANCE=true",
    "-e", "PORT=3000", "-e", "HOSTNAME=0.0.0.0"
  )
  foreach ($name in @("OPS_ADMIN_PASSWORD_HASH", "OPS_ADMIN_PASSWORD_HASH_BASE64", "APP_PUBLIC_ORIGIN", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL")) {
    if ([Environment]::GetEnvironmentVariable($name, "Process")) {
      $runArgs += @("-e", $name)
    }
  }
  $null = Invoke-Docker -Arguments ($runArgs + @($Image))
  for ($attempt = 1; $attempt -le 60; $attempt++) {
    try {
      Test-PageAndChunk -Port 32768 -PagePath "/ops" -RequirePassword
      return $true
    }
    catch {
      if ($attempt -eq 60) {
        throw "OPS admin did not become ready"
      }
      Start-Sleep -Seconds 2
    }
  }
}

try {
  $envValues = Read-EnvFile -Path $envFile
  foreach ($key in $envValues.Keys) {
    [Environment]::SetEnvironmentVariable($key, $envValues[$key], "Process")
  }
  Set-LogRedactions -EnvValues $envValues
  Write-Log "Starting BillBoard production with Docker Desktop"
  Assert-RequiredProductionSecret -Name "AUTH_SECRET" -Value $env:AUTH_SECRET
  Assert-RequiredProductionSecret -Name "POSTGRES_PASSWORD" -Value $env:POSTGRES_PASSWORD -DefaultValue "billboard"
  Assert-RequiredProductionSecret -Name "IMPORT_AGENT_TOKEN" -Value $env:IMPORT_AGENT_TOKEN
  Assert-RequiredProductionSecret -Name "WHEELMAKER_API_KEY" -Value $env:WHEELMAKER_API_KEY
  $wheelMakerUri = $null
  if (-not [Uri]::TryCreate($env:WHEELMAKER_BASE_URL, [UriKind]::Absolute, [ref] $wheelMakerUri) -or
      $wheelMakerUri.Scheme -ne "https" -or $wheelMakerUri.UserInfo -or $wheelMakerUri.Query -or $wheelMakerUri.Fragment) {
    throw "WHEELMAKER_BASE_URL must be a private HTTPS base URL without credentials, query or fragment"
  }

  $env:APP_BASE_PATH = "/"
  $env:POSTGRES_USER = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "billboard" }
  $env:POSTGRES_DB = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "billboard" }
  $databaseUser = [Uri]::EscapeDataString($env:POSTGRES_USER)
  $databasePassword = [Uri]::EscapeDataString($env:POSTGRES_PASSWORD)
  $databaseName = [Uri]::EscapeDataString($env:POSTGRES_DB)
  $env:DATABASE_URL = "postgresql://{0}:{1}@db:5432/{2}?schema=public" -f $databaseUser, $databasePassword, $databaseName
  Set-LogRedactions -EnvValues $envValues

  $appPort = if ($env:APP_PORT) { $env:APP_PORT } else { "3000" }
  $originalAppPort = $appPort
  if ($PrivateSmokePort -ne 0) {
    if ($PrivateSmokePort -lt 1024 -or $PrivateSmokePort -gt 65535 -or $PrivateSmokePort -eq [int] $appPort -or $PrivateSmokePort -eq 32768) {
      throw "PrivateSmokePort must be a separate unprivileged loopback port"
    }
    $appPort = "$PrivateSmokePort"
    $env:APP_PORT = $appPort
  }
  if ($appPort -notmatch '^\d{1,5}$' -or [int] $appPort -lt 1 -or [int] $appPort -gt 65535) {
    throw "APP_PORT must be a valid local TCP port"
  }
  $revision = Assert-PublishedCheckout
  $env:APP_IMAGE_TAG = $revision
  $webImage = "billboard-web:$revision"
  $toolsImage = "billboard-tools:$revision"
  $agentImage = "billboard-import-agent:$revision"
  Wait-DockerDesktop

  if (-not $SkipBuild) {
    $null = Invoke-Compose -Arguments @("build", "--builder", "default", "web", "bootstrap", "import-agent")
  }
  Assert-ImageRevision -Image $webImage -Revision $revision
  Assert-ImageRevision -Image $toolsImage -Revision $revision
  Assert-ImageRevision -Image $agentImage -Revision $revision
  if ($BuildOnly) {
    Write-Log "Verified production images; application and database remain unchanged"
    return
  }
  $previousWebRuntimes = @(Get-BillAnalysisRuntimeCandidates)
  $null = Invoke-Compose -Arguments @("up", "-d", "--wait", "--wait-timeout", "120", "db")
  $databaseProbe = 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"'
  $existingSchema = Invoke-Compose -Arguments @("exec", "-T", "db", "sh", "-c", $databaseProbe, "sh", 'SELECT to_regclass(''public."Household"'') IS NOT NULL')
  if (($existingSchema.Output -join "").Trim() -eq "t") {
    $migrationReady = Invoke-Compose -Arguments @("exec", "-T", "db", "sh", "-c", $databaseProbe, "sh", 'SELECT count(*) FROM "_prisma_migrations" WHERE migration_name = ''20261021000000_household_ledger_foundation'' AND finished_at IS NOT NULL AND rolled_back_at IS NULL')
    $existingHouseholds = Invoke-Compose -Arguments @("exec", "-T", "db", "sh", "-c", $databaseProbe, "sh", 'SELECT count(*) FROM "Household"')
    if (($migrationReady.Output -join "").Trim() -ne "1" -and ($existingHouseholds.Output -join "").Trim() -ne "0") {
      throw "Existing household data requires ops/windows/migrate-household-ledgers.ps1 before ordinary startup"
    }
  }
  $null = Invoke-Compose -Arguments @("run", "--rm", "--no-deps", "bootstrap", "npx", "prisma", "migrate", "deploy")
  $null = Invoke-Compose -Arguments @("up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web", "import-agent")
  $null = Clear-StoppedBillAnalysisExecutions -Candidates $previousWebRuntimes
  Test-PageAndChunk -Port ([int] $appPort) -PagePath "/login"
  $opsEnabled = Start-OpsAdmin -Image $webImage

  if ($StayAttached) {
    $appResult = Invoke-Compose -Arguments @("ps", "-q", "web", "import-agent")
    $watchedContainers = @($appResult.Output | Where-Object { $_.Trim() })
    if ($watchedContainers.Count -ne 2) {
      throw "The Compose application containers were not found"
    }
    if ($opsEnabled) {
      $watchedContainers += $opsContainerName
    }
    Write-Log "StayAttached enabled; monitoring Docker containers"
    while ($true) {
      foreach ($container in $watchedContainers) {
        $state = Invoke-Docker -Arguments @("inspect", $container, "--format", "{{.State.Running}}") -Quiet
        if (($state.Output -join "").Trim() -ne "true") {
          throw "A monitored application container stopped"
        }
      }
      Start-Sleep -Seconds 30
    }
  }
  Write-Log "Startup completed at the verified commit"
}
catch {
  Write-Log "ERROR $($_.Exception.Message)"
  throw "BillBoard production startup failed; see tmp/logs/production-startup.log for sanitized details"
}
finally {
  if ($PrivateSmokePort -ne 0 -and $originalAppPort) { $env:APP_PORT = $originalAppPort }
}
