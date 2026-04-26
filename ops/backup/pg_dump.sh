#!/usr/bin/env bash

set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: bash ops/backup/pg_dump.sh <output-dir>" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
output_dir="$1"
postgres_db="${POSTGRES_DB:-billboard}"
postgres_user="${POSTGRES_USER:-billboard}"
timestamp="$(date +"%Y%m%d-%H%M%S")"
container_dump="/tmp/billboard-${timestamp}.dump"
dump_file="${output_dir%/}/billboard-${timestamp}.dump"

cd "$repo_root"
mkdir -p "$output_dir"

docker compose -f docker-compose.yml up -d db >/dev/null

attempts=0
until docker compose -f docker-compose.yml exec -T db pg_isready -U "$postgres_user" -d "$postgres_db" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "database did not become ready within 30 seconds" >&2
    exit 1
  fi
  sleep 1
done

docker compose -f docker-compose.yml exec -T db pg_dump \
  -U "$postgres_user" \
  -d "$postgres_db" \
  --clean \
  --create \
  --format=custom \
  --file="$container_dump"

container_id="$(docker compose -f docker-compose.yml ps -q db)"

if [ "$container_id" = "" ]; then
  echo "could not resolve the db container id" >&2
  exit 1
fi

docker cp "${container_id}:${container_dump}" "$dump_file" >/dev/null
docker compose -f docker-compose.yml exec -T db rm -f "$container_dump"
find "$output_dir" -maxdepth 1 -name "billboard-*.dump" -type f -mtime +14 -delete

echo "$dump_file"
