#!/usr/bin/env bash

set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: bash ops/backup/pg_dump.sh <output-dir>" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
output_dir="$1"
timestamp="$(date +"%Y%m%d-%H%M%S")"
container_dump="/tmp/billboard-${timestamp}.dump"
dump_file="${output_dir%/}/billboard-${timestamp}.dump"
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
mkdir -p "$output_dir"

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

"${compose_cmd[@]}" exec -T db sh -c \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --create --format=custom --file="$1"' \
  sh "$container_dump"

container_id="$("${compose_cmd[@]}" ps -q db)"

if [ "$container_id" = "" ]; then
  echo "could not resolve the db container id" >&2
  exit 1
fi

docker cp "${container_id}:${container_dump}" "$dump_file" >/dev/null
"${compose_cmd[@]}" exec -T db rm -f "$container_dump"
find "$output_dir" -maxdepth 1 -name "billboard-*.dump" -type f -mtime +14 -delete

echo "$dump_file"
