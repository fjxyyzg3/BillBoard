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
postgres_db="${POSTGRES_DB:-billboard}"
postgres_user="${POSTGRES_USER:-billboard}"
container_dump="/tmp/billboard-restore.dump"

cd "$repo_root"
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

container_id="$(docker compose -f docker-compose.yml ps -q db)"

if [ "$container_id" = "" ]; then
  echo "could not resolve the db container id" >&2
  exit 1
fi

docker cp "$dump_file" "${container_id}:${container_dump}" >/dev/null
docker compose -f docker-compose.yml exec -T db pg_restore \
  --clean \
  --create \
  --if-exists \
  --no-owner \
  -U "$postgres_user" \
  -d postgres \
  "$container_dump"
docker compose -f docker-compose.yml exec -T db rm -f "$container_dump"

echo "restored $dump_file into $postgres_db"
