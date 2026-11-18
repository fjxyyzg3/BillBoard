#!/usr/bin/env bash

set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: bash ops/backup/restore-from-dump.sh <dump-file>" >&2
  exit 1
fi

dump_file="$1"
if [ ! -f "$dump_file" ]; then
  echo "dump file not found: $dump_file" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
container_dump="/tmp/billboard-restore.dump"
compose_cmd=(docker compose)

cd "$repo_root"
compose_env_file="${COMPOSE_ENV_FILE:-}"
if [ -z "$compose_env_file" ] && [ -f .env.production.local ]; then
  compose_env_file=.env.production.local
fi
if [ -n "$compose_env_file" ]; then
  compose_cmd+=(--env-file "$compose_env_file")
fi
compose_cmd+=(-f compose.yml)
"${compose_cmd[@]}" up -d db >/dev/null

attempts=0
until "${compose_cmd[@]}" exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "database did not become ready within 30 seconds" >&2
    exit 1
  fi
  sleep 1
done

container_id="$("${compose_cmd[@]}" ps -q db)"

if [ "$container_id" = "" ]; then
  echo "could not resolve the db container id" >&2
  exit 1
fi

docker cp "$dump_file" "${container_id}:${container_dump}" >/dev/null
"${compose_cmd[@]}" exec -T db sh -c \
  'exec pg_restore --clean --create --if-exists --no-owner --exit-on-error -U "$POSTGRES_USER" -d postgres "$1"' \
  sh "$container_dump"
"${compose_cmd[@]}" exec -T db rm -f "$container_dump"

echo "restored $dump_file"
