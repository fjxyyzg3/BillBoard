param(
  [Parameter(Mandatory = $true)] [string] $PrivateDirectory,
  [string] $IngressStopScript,
  [string] $IngressStartScript,
  [ValidateRange(1024, 65535)] [int] $PrivateSmokePort = 33001
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$composeFile = Join-Path $repoRoot "compose.yml"
$envFile = Join-Path $repoRoot ".env.production.local"
$runId = "household-ledgers-{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), [Guid]::NewGuid().ToString("N").Substring(0, 8)
$entryBlocked = $false
$writersStopped = $false
$migrated = $false
$mayHaveAcceptedWrites = $false

function Invoke-PrivateIngressHook {
  param([string] $ScriptPath)
  $global:LASTEXITCODE = 0
  $hookOutput = @(& $ScriptPath 2>&1)
  $succeeded = $?
  $nativeExit = $LASTEXITCODE
  if (-not $succeeded -or $nativeExit -ne 0) { throw "Private ingress control failed; details were suppressed" }
}

function Invoke-PrivateDocker {
  param([string[]] $Arguments, [switch] $AllowFailure)
  $captured = @(& docker --context desktop-linux @Arguments 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFailure) { throw "A private migration operation failed (exit $code); service remains stopped" }
  return @{ Code = $code; Output = $captured }
}

function Invoke-MigrationTool {
  param([string[]] $ToolArguments, [switch] $AllowFailure)
  return Invoke-PrivateDocker -Arguments (@(
    "run", "--rm", "--network", "billboard_default", "-e", "DATABASE_URL",
    "--mount", "type=bind,source=$runDirectory,target=/evidence", $toolsImage,
    "node", "--import", "tsx", "ops/migrations/household-ledgers.ts"
  ) + $ToolArguments) -AllowFailure:$AllowFailure
}

function Test-PrivateRestore {
  param([string] $ArchivePath, [string] $BaselineName)
  $restoreName = "$runId-restore"
  $savedPassword = $env:POSTGRES_PASSWORD
  $savedUrl = $env:DATABASE_URL
  try {
    $restorePassword = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
    $env:POSTGRES_PASSWORD = $restorePassword
    $null = Invoke-PrivateDocker -Arguments @(
      "run", "-d", "--name", $restoreName, "--network", "none", "-e", "POSTGRES_PASSWORD",
      "-e", "POSTGRES_USER=billboard", "-e", "POSTGRES_DB=billboard_restore", "postgres:17"
    )
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      $ready = Invoke-PrivateDocker -Arguments @("exec", $restoreName, "pg_isready", "-U", "billboard", "-d", "billboard_restore") -AllowFailure
      if ($ready.Code -eq 0) { break }
      if ($attempt -eq 59) { throw "Private restore database did not become ready" }
      Start-Sleep -Seconds 1
    }
    $empty = Invoke-PrivateDocker -Arguments @("exec", $restoreName, "psql", "-U", "billboard", "-d", "billboard_restore", "-Atc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    if (($empty.Output -join "").Trim() -ne "0") { throw "Private restore target is not empty" }
    $null = Invoke-PrivateDocker -Arguments @("cp", $ArchivePath, "${restoreName}:/tmp/restore.dump")
    $null = Invoke-PrivateDocker -Arguments @("exec", $restoreName, "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "-U", "billboard", "-d", "billboard_restore", "/tmp/restore.dump")
    $env:DATABASE_URL = "postgresql://billboard:$restorePassword@127.0.0.1:5432/billboard_restore"
    $null = Invoke-PrivateDocker -Arguments @(
      "run", "--rm", "--network", "container:$restoreName", "-e", "DATABASE_URL",
      "--mount", "type=bind,source=$runDirectory,target=/evidence", $toolsImage,
      "node", "--import", "tsx", "ops/migrations/household-ledgers.ts", "verify", "--baseline", "/evidence/$BaselineName"
    )
    Write-Output "Final archive was restored into an isolated empty database and original fields matched"
  }
  finally {
    $env:POSTGRES_PASSWORD = $savedPassword
    $env:DATABASE_URL = $savedUrl
    # Preserve the private restored copy for recovery evidence; never remove a production volume.
    $null = Invoke-PrivateDocker -Arguments @("stop", $restoreName) -AllowFailure
  }
}

try {
  if ([bool]$IngressStopScript -ne [bool]$IngressStartScript) { throw "Supply both private ingress hooks or neither" }
  foreach ($scriptPath in @($IngressStopScript, $IngressStartScript) | Where-Object { $_ }) {
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "Both supplied private ingress control scripts must exist" }
  }
  if (-not (Test-Path -LiteralPath $PrivateDirectory -PathType Container)) { throw "The private evidence directory must already exist" }
  $privateRoot = (Resolve-Path -LiteralPath $PrivateDirectory).ProviderPath
  if ($privateRoot.TrimEnd('\') -ieq $repoRoot.TrimEnd('\') -or
      ($privateRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
      $privateRoot.TrimEnd('\') -ine (Join-Path $repoRoot "tmp").TrimEnd('\') -and
      -not $privateRoot.StartsWith((Join-Path $repoRoot "tmp") + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase))) {
    throw "Repository-local private evidence must stay inside ignored tmp"
  }
  $runDirectory = Join-Path $privateRoot $runId
  New-Item -Path $runDirectory -ItemType Directory | Out-Null
  # Build and validate the published checkout before beginning downtime.
  & (Join-Path $PSScriptRoot "start-production.ps1") -BuildOnly
  $canonicalPort = if ($env:APP_PORT) { [int]$env:APP_PORT } else { 3000 }
  if ($PrivateSmokePort -eq $canonicalPort -or $PrivateSmokePort -eq 32768 -or
      (Get-NetTCPConnection -LocalPort $PrivateSmokePort -State Listen -ErrorAction SilentlyContinue)) {
    throw "Private smoke requires a separate available loopback port"
  }
  $revision = (& git -C $repoRoot rev-parse HEAD).Trim()
  $toolsImage = "billboard-tools:$revision"
  $null = Invoke-MigrationTool -ToolArguments @("preflight")
  $running = Invoke-PrivateDocker -Arguments @("ps", "-q", "--filter", "label=com.docker.compose.project=billboard", "--filter", "label=com.docker.compose.service=db")
  $databaseId = ($running.Output -join "").Trim()
  if ($databaseId -notmatch '^[0-9a-f]{12,64}$') { throw "Exactly one production database is required" }
  $images = Invoke-PrivateDocker -Arguments @("inspect", "billboard-web-1", "billboard-import-agent-1", "--format", "{{.Name}} {{.Image}}")
  $images.Output | Set-Content -LiteralPath (Join-Path $runDirectory "previous-images.txt")

  if ($IngressStopScript) { Invoke-PrivateIngressHook -ScriptPath $IngressStopScript; $entryBlocked = $true }
  $ops = Invoke-PrivateDocker -Arguments @("container", "inspect", "billboard-ops", "--format", "{{.State.Running}}") -AllowFailure
  if ($ops.Code -eq 0) {
    $null = Invoke-PrivateDocker -Arguments @("stop", "--time", "180", "billboard-ops")
    $opsStopped = Invoke-PrivateDocker -Arguments @("container", "inspect", "billboard-ops", "--format", "{{.State.Running}}") -AllowFailure
    if ($opsStopped.Code -ne 0 -or ($opsStopped.Output -join "").Trim() -ne "false") { throw "OPS stop could not be verified" }
  } else {
    $opsInventory = Invoke-PrivateDocker -Arguments @("ps", "-aq", "--filter", "name=^/billboard-ops$") -AllowFailure
    if ($opsInventory.Code -ne 0 -or ($opsInventory.Output -join "").Trim() -ne "") { throw "OPS state is unknown; refusing to stop application writers" }
  }
  # SIGTERM stops acceptance and allows current Next.js requests to finish while the Agent remains available.
  $null = Invoke-PrivateDocker -Arguments @("compose", "--project-name", "billboard", "--env-file", $envFile, "-f", $composeFile, "stop", "--timeout", "180", "web")
  $entryBlocked = $true
  $null = Invoke-PrivateDocker -Arguments @("compose", "--project-name", "billboard", "--env-file", $envFile, "-f", $composeFile, "stop", "--timeout", "15", "import-agent")
  $writersStopped = $true
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $quiesced = Invoke-MigrationTool -ToolArguments @("quiesce") -AllowFailure
    if ($quiesced.Code -eq 0) { break }
    if ($attempt -eq 19) { throw "Database writers or active task leases did not quiesce" }
    Start-Sleep -Seconds 5
  }
  $null = Invoke-MigrationTool -ToolArguments @("snapshot", "--output", "/evidence/before.json")
  $archive = Join-Path $runDirectory "before.dump"
  $dump = 'umask 077; pg_dump --format=custom --no-owner --no-acl --file "$1" --username "$POSTGRES_USER" "$POSTGRES_DB"'
  $null = Invoke-PrivateDocker -Arguments @("exec", $databaseId, "sh", "-c", $dump, "sh", "/tmp/$runId.dump")
  $null = Invoke-PrivateDocker -Arguments @("exec", $databaseId, "pg_restore", "--list", "/tmp/$runId.dump")
  $checksum = Invoke-PrivateDocker -Arguments @("exec", $databaseId, "sha256sum", "/tmp/$runId.dump")
  $null = Invoke-PrivateDocker -Arguments @("cp", "${databaseId}:/tmp/$runId.dump", $archive)
  $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not ($checksum.Output -join "").StartsWith($actualHash)) { throw "Final archive checksum mismatch" }
  $actualHash | Set-Content -LiteralPath (Join-Path $runDirectory "before.dump.sha256")
  Test-PrivateRestore -ArchivePath $archive -BaselineName "before.json"
  $null = Invoke-PrivateDocker -Arguments @("compose", "--project-name", "billboard", "--env-file", $envFile, "-f", $composeFile, "run", "--rm", "--no-deps", "bootstrap", "npx", "prisma", "migrate", "deploy")
  $migrated = $true
  $verified = Invoke-MigrationTool -ToolArguments @("verify", "--foundation", "--baseline", "/evidence/before.json", "--output", "/evidence/after.json")
  $verified.Output | Set-Content -LiteralPath (Join-Path $runDirectory "verification.txt")
  $mayHaveAcceptedWrites = $true
  $writersStopped = $false
  # Keep the canonical frpc upstream closed until this exact image passes local smoke.
  & (Join-Path $PSScriptRoot "start-production.ps1") -SkipBuild -PrivateSmokePort $PrivateSmokePort
  $canonicalPort = if ($env:APP_PORT) { [int]$env:APP_PORT } else { 3000 }
  if (Get-NetTCPConnection -LocalPort $canonicalPort -State Listen -ErrorAction SilentlyContinue) {
    throw "The canonical application upstream reopened before private smoke completed"
  }
  & (Join-Path $PSScriptRoot "start-production.ps1") -SkipBuild
  if ($IngressStartScript) { Invoke-PrivateIngressHook -ScriptPath $IngressStartScript }
  $entryBlocked = $false
  $writersStopped = $false
  Write-Output "Household ledger migration, original-field verification and local application smoke passed"
}
catch {
  # Never automatically restore an old snapshot once the new version could have accepted writes.
  if ($mayHaveAcceptedWrites) {
    $null = Invoke-PrivateDocker -Arguments @("stop", "--time", "180", "billboard-web-1", "billboard-import-agent-1") -AllowFailure
    $null = Invoke-PrivateDocker -Arguments @("stop", "--time", "180", "billboard-ops") -AllowFailure
    $writerStates = Invoke-PrivateDocker -Arguments @("inspect", "billboard-web-1", "billboard-import-agent-1", "--format", "{{.State.Running}}") -AllowFailure
    $opsState = Invoke-PrivateDocker -Arguments @("container", "inspect", "billboard-ops", "--format", "{{.State.Running}}") -AllowFailure
    $opsStopped = $opsState.Code -eq 0 -and ($opsState.Output -join "").Trim() -eq "false"
    if ($opsState.Code -ne 0) {
      $opsInventory = Invoke-PrivateDocker -Arguments @("ps", "-aq", "--filter", "name=^/billboard-ops$") -AllowFailure
      $opsStopped = $opsInventory.Code -eq 0 -and ($opsInventory.Output -join "").Trim() -eq ""
    }
    $writersStopped = $writerStates.Code -eq 0 -and @($writerStates.Output | Where-Object { $_.Trim() -ne "false" }).Count -eq 0 -and
      $opsStopped
    if ($IngressStopScript) {
      try { Invoke-PrivateIngressHook -ScriptPath $IngressStopScript; $entryBlocked = $true } catch { $entryBlocked = $false }
    } else { $entryBlocked = $writersStopped }
  }
  Write-Error "Migration incomplete. EntryBlocked=$entryBlocked WritersStopped=$writersStopped SchemaMigrated=$migrated MayHaveAcceptedWrites=$mayHaveAcceptedWrites. Keep private evidence and diagnose before resuming." -ErrorAction Continue
  throw "Household ledger migration did not complete; private connection and ingress details were suppressed"
}
