param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ComposeArgs
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
  [Console]::Error.WriteLine("podman command not found. Install Podman and podman-compose before running this script.")
  exit 127
}

if (-not $env:PODMAN_COMPOSE_PROVIDER) {
  $env:PODMAN_COMPOSE_PROVIDER = "podman-compose"
}

& podman compose @ComposeArgs
exit $LASTEXITCODE
