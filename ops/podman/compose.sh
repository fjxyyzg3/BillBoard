#!/usr/bin/env bash

set -euo pipefail

if ! command -v podman >/dev/null 2>&1; then
  echo "podman command not found. Install Podman and podman-compose before running this script." >&2
  exit 127
fi

export PODMAN_COMPOSE_PROVIDER="${PODMAN_COMPOSE_PROVIDER:-podman-compose}"

exec podman compose "$@"
