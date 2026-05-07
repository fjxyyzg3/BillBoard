param(
  [switch] $StayAttached
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$logDir = Join-Path $repoRoot "tmp\logs"
$envFile = Join-Path $repoRoot ".env.production.local"
$taskName = "BillBoard Production Startup"
$webContainerName = "billboard_web_1"
$proxyContainerName = "billboard_proxy_1"
$dbContainerName = "billboard_db_1"
$composeFile = Join-Path $repoRoot "podman-compose.yml"
$webImage = "localhost/billboard-tools:latest"
$caddyImage = "docker.io/library/caddy:2.10"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "production-startup.log"

function Write-Log {
  param([string] $Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$timestamp] $Message" | Tee-Object -FilePath $logFile -Append
}

function Read-EnvFile {
  param([string] $Path)

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

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
    $value = $trimmed.Substring($index + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $values[$name] = $value
  }

  return $values
}

function Invoke-Logged {
  param(
    [string] $FilePath,
    [string[]] $Arguments,
    [switch] $AllowFailure
  )

  $displayArguments = $Arguments | ForEach-Object {
    $_ `
      -replace "AUTH_SECRET=.*", "AUTH_SECRET=<redacted>" `
      -replace "DATABASE_URL=postgresql://([^:]+):([^@]+)@", 'DATABASE_URL=postgresql://$1:<redacted>@'
  }

  Write-Log ("RUN {0} {1}" -f $FilePath, ($displayArguments -join " "))
  $output = & $FilePath @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($output) {
    $output | ForEach-Object { Write-Log $_ }
  }

  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "$FilePath exited with code $exitCode"
  }

  return $output
}

function Wait-Database {
  param(
    [string] $User,
    [string] $Database
  )

  for ($attempt = 1; $attempt -le 60; $attempt++) {
    & podman exec $dbContainerName pg_isready -U $User -d $Database *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Log "Database is ready"
      return
    }

    Start-Sleep -Seconds 2
  }

  throw "Database did not become ready"
}

function Stop-ExistingTunnel {
  param(
    [string] $BindAddress,
    [int] $LocalPort
  )

  $identityPath = Join-Path $env:USERPROFILE ".local\share\containers\podman\machine\machine"
  $escapedIdentity = [regex]::Escape($identityPath)
  $escapedForward = [regex]::Escape("${BindAddress}:${LocalPort}:")
  $processes = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "ssh.exe" -and
    $_.CommandLine -match $escapedIdentity -and
    $_.CommandLine -match $escapedForward
  }

  foreach ($process in $processes) {
    Write-Log "Stopping existing ${BindAddress}:${LocalPort} tunnel process $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force
  }
}

function Start-Tunnel {
  param([string] $WebIp)

  Stop-ExistingTunnel -BindAddress "0.0.0.0" -LocalPort 3000

  $machine = (podman machine inspect podman-machine-default | ConvertFrom-Json)[0]
  $target = "$($machine.SSHConfig.RemoteUsername)@127.0.0.1"
  $arguments = @(
    "-i", $machine.SSHConfig.IdentityPath,
    "-p", [string] $machine.SSHConfig.Port,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-N",
    "-L", "0.0.0.0:3000:${WebIp}:3000",
    $target
  )

  Write-Log "Starting SSH tunnel to ${WebIp}:3000"
  $process = Start-Process -FilePath "ssh.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2

  if ($process.HasExited) {
    throw "SSH tunnel exited with code $($process.ExitCode)"
  }

  Write-Log "SSH tunnel is running as process $($process.Id)"
  return $process
}

function Start-Proxy {
  param([string] $WebIp)

  if (-not $env:APP_DOMAIN) {
    Write-Log "APP_DOMAIN is not set; skipping HTTPS proxy"
    return $null
  }

  & podman image exists $caddyImage *> $null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Logged -FilePath "podman" -Arguments @("pull", $caddyImage)
  }

  Invoke-Logged -FilePath "podman" -Arguments @("rm", "-f", $proxyContainerName) -AllowFailure

  $runArgs = @(
    "run", "-d",
    "--name", $proxyContainerName,
    "--network", "billboard_default",
    "--add-host", "web:${WebIp}",
    "-e", "APP_DOMAIN=$($env:APP_DOMAIN)",
    "-v", "$repoRoot\ops\caddy\Caddyfile:/etc/caddy/Caddyfile:ro",
    "-v", "billboard_caddy-data:/data",
    "-v", "billboard_caddy-config:/config",
    $caddyImage
  )

  Invoke-Logged -FilePath "podman" -Arguments $runArgs

  for ($attempt = 1; $attempt -le 30; $attempt++) {
    $status = (& podman inspect $proxyContainerName --format "{{.State.Status}}" 2>$null)
    if ($status -eq "running") {
      Write-Log "Proxy container is running"
      break
    }

    if ($attempt -eq 30) {
      throw "Proxy container did not become ready"
    }

    Start-Sleep -Seconds 2
  }

  $proxyIp = (& podman inspect $proxyContainerName --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}").Trim()
  if (-not $proxyIp) {
    throw "Could not resolve proxy container IP"
  }

  return $proxyIp
}

function Start-CaddyTunnel {
  param([string] $ProxyIp)

  Stop-ExistingTunnel -BindAddress "127.0.0.1" -LocalPort 8080
  Stop-ExistingTunnel -BindAddress "127.0.0.1" -LocalPort 8443

  $machine = (podman machine inspect podman-machine-default | ConvertFrom-Json)[0]
  $target = "$($machine.SSHConfig.RemoteUsername)@127.0.0.1"
  $arguments = @(
    "-i", $machine.SSHConfig.IdentityPath,
    "-p", [string] $machine.SSHConfig.Port,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-N",
    "-L", "127.0.0.1:8080:${ProxyIp}:80",
    "-L", "127.0.0.1:8443:${ProxyIp}:443",
    $target
  )

  Write-Log "Starting Caddy SSH tunnel to ${ProxyIp}:80/443"
  $process = Start-Process -FilePath "ssh.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2

  if ($process.HasExited) {
    throw "Caddy SSH tunnel exited with code $($process.ExitCode)"
  }

  Write-Log "Caddy SSH tunnel is running as process $($process.Id)"
  return $process
}

function Test-Endpoint {
  $login = Invoke-WebRequest -Uri "http://127.0.0.1:3000/login" -UseBasicParsing -TimeoutSec 20
  if ($login.StatusCode -ne 200) {
    throw "Login endpoint returned $($login.StatusCode)"
  }

  $script = ($login.Content |
    Select-String -Pattern 'src="([^"]+\.js[^"]*)"' -AllMatches |
    ForEach-Object { $_.Matches } |
    ForEach-Object { $_.Groups[1].Value } |
    Select-Object -First 1)

  if (-not $script) {
    throw "Login page did not contain a JavaScript chunk"
  }

  $chunk = Invoke-WebRequest -Uri "http://127.0.0.1:3000$script" -UseBasicParsing -TimeoutSec 20
  if ($chunk.StatusCode -ne 200) {
    throw "JavaScript chunk returned $($chunk.StatusCode)"
  }

  Write-Log "Verified /login and $script"
}

try {
  Write-Log "Starting $taskName"

  $envValues = Read-EnvFile -Path $envFile
  foreach ($key in $envValues.Keys) {
    [Environment]::SetEnvironmentVariable($key, $envValues[$key], "Process")
  }

  if (-not $env:AUTH_SECRET) {
    throw "AUTH_SECRET is required in $envFile"
  }

  $postgresDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "billboard" }
  $postgresUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "billboard" }
  $postgresPassword = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } else { "billboard" }
  $databaseUser = [Uri]::EscapeDataString($postgresUser)
  $databasePassword = [Uri]::EscapeDataString($postgresPassword)
  $databaseName = [Uri]::EscapeDataString($postgresDb)
  $databaseUrl = "postgresql://${databaseUser}:${databasePassword}@db:5432/${databaseName}?schema=public"
  $env:PODMAN_COMPOSE_PROVIDER = if ($env:PODMAN_COMPOSE_PROVIDER) { $env:PODMAN_COMPOSE_PROVIDER } else { "podman-compose" }

  if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    throw "podman command not found"
  }

  $machine = (podman machine inspect podman-machine-default | ConvertFrom-Json)[0]
  if ($machine.State -ne "running") {
    Invoke-Logged -FilePath "podman" -Arguments @("machine", "start", "podman-machine-default")
  }

  Push-Location $repoRoot
  try {
    Invoke-Logged -FilePath "podman" -Arguments @("compose", "-f", $composeFile, "up", "--detach", "db")
    Wait-Database -User $postgresUser -Database $postgresDb

    Invoke-Logged -FilePath "podman" -Arguments @("rm", "-f", $webContainerName) -AllowFailure

    $webCommand = "npm run build && mkdir -p .next/standalone/.next && rm -rf .next/standalone/.next/static && cp -r .next/static .next/standalone/.next/static && rm -rf .next/standalone/public && cp -r public .next/standalone/public && node .next/standalone/server.js"
    $runArgs = @(
      "run", "-d",
      "--name", $webContainerName,
      "--network", "billboard_default",
      "-e", "NODE_ENV=production",
      "-e", "NEXT_TELEMETRY_DISABLED=1",
      "-e", "DATABASE_URL=$databaseUrl",
      "-e", "AUTH_SECRET=$($env:AUTH_SECRET)",
      "-e", "PORT=3000",
      "-e", "HOSTNAME=0.0.0.0",
      "-v", "$repoRoot\src:/app/src:ro",
      "-v", "$repoRoot\prisma:/app/prisma:ro",
      "-v", "$repoRoot\public:/app/public:ro",
      "-v", "$repoRoot\package.json:/app/package.json:ro",
      "-v", "$repoRoot\package-lock.json:/app/package-lock.json:ro",
      "-v", "$repoRoot\next.config.ts:/app/next.config.ts:ro",
      "-v", "$repoRoot\tsconfig.json:/app/tsconfig.json:ro",
      "-v", "$repoRoot\postcss.config.mjs:/app/postcss.config.mjs:ro",
      "-v", "$repoRoot\tailwind.config.ts:/app/tailwind.config.ts:ro",
      $webImage,
      "sh", "-lc", $webCommand
    )

    Invoke-Logged -FilePath "podman" -Arguments $runArgs

    for ($attempt = 1; $attempt -le 120; $attempt++) {
      $status = (& podman inspect $webContainerName --format "{{.State.Status}}" 2>$null)
      if ($status -eq "running") {
        $fetch = & podman exec $webContainerName node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>$null
        if ($LASTEXITCODE -eq 0) {
          Write-Log "Web container is ready"
          break
        }
      }

      if ($attempt -eq 120) {
        throw "Web container did not become ready"
      }

      Start-Sleep -Seconds 2
    }

    $webIp = (& podman inspect $webContainerName --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}").Trim()
    if (-not $webIp) {
      throw "Could not resolve web container IP"
    }

    $tunnelProcess = Start-Tunnel -WebIp $webIp
    $proxyIp = Start-Proxy -WebIp $webIp
    $httpsTunnelProcess = if ($proxyIp) { Start-CaddyTunnel -ProxyIp $proxyIp } else { $null }
    Test-Endpoint

    if ($StayAttached) {
      $watchedProcesses = @($tunnelProcess)
      if ($httpsTunnelProcess) {
        $watchedProcesses += $httpsTunnelProcess
      }

      $processIds = ($watchedProcesses | ForEach-Object { $_.Id }) -join ", "
      Write-Log "StayAttached enabled; monitoring SSH tunnel processes $processIds"

      while ($true) {
        foreach ($process in $watchedProcesses) {
          $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
          if (-not $running) {
            throw "SSH tunnel process $($process.Id) exited"
          }
        }

        Start-Sleep -Seconds 30
      }
    }
  }
  finally {
    Pop-Location
  }

  Write-Log "Startup completed"
}
catch {
  Write-Log "ERROR $($_.Exception.Message)"
  throw
}
