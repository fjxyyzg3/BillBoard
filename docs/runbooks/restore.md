# Restore Runbook

Use this runbook to recover BillBoard onto a new or rebuilt machine.

## Prerequisites

- Docker Engine and Docker Compose are installed.
- The repository contents are available on the target machine.
- Production environment values are restored, especially `AUTH_SECRET`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and `APP_DOMAIN`.
- A PostgreSQL dump created by `bash ops/backup/pg_dump.sh` is available locally.

## Restore Steps

1. Copy the production environment file or export the required production variables before starting the stack.
2. Start the database service first: `docker compose up -d db`
3. Wait for PostgreSQL to become healthy: `docker compose ps`
4. Restore the latest dump: `bash ops/backup/restore-from-dump.sh /path/to/billboard-YYYYMMDD-HHMMSS.dump`
5. Start only the public app services: `docker compose up -d web proxy`
6. Validate the app at the public hostname or local proxy URL.

## Validation Checklist

- Log in with a known account.
- Open `/home` and confirm totals render.
- Create a test record and confirm it appears in history.
- Open the records view and confirm older history is present.
- Run a fresh backup and confirm a new `.dump` file appears after the restore validation.
- If the recovery target is the final production machine, run a fresh backup after validation.
