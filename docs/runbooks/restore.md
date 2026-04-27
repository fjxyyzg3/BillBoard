# Restore Runbook

Use this runbook to recover BillBoard onto a new or rebuilt machine.

## Prerequisites

- Podman and `podman-compose` are installed.
- The repository contents are available on the target machine.
- Production environment values are restored, especially `AUTH_SECRET`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, and `APP_DOMAIN`.
- A PostgreSQL dump created by `bash ops/backup/pg_dump.sh` is available locally.

## Restore Steps

1. Copy the production environment file or export the required production variables before starting the stack.
2. Start the database service first: `bash ops/podman/compose.sh -f podman-compose.yml up -d db`
3. Wait for PostgreSQL to become healthy: `bash ops/podman/compose.sh -f podman-compose.yml ps`
4. Restore the latest dump: `bash ops/backup/restore-from-dump.sh /path/to/billboard-YYYYMMDD-HHMMSS.dump`
5. Start only the public app services: `bash ops/podman/compose.sh -f podman-compose.yml up -d web proxy`
6. Validate the app at the public hostname or local proxy URL.

## Validation Checklist

- Log in with a known account.
- Open `/home` and confirm totals render.
- Create a test record and confirm it appears in history.
- Open the records view and confirm older history is present.
- During the launch-gate rehearsal, run `npm run test:e2e -- tests/e2e/create-expense.spec.ts`, `npm run test:e2e -- tests/e2e/create-income.spec.ts`, and `npm run test:e2e -- tests/e2e/home-drilldown.spec.ts` before sign-off.
- Run a fresh backup and confirm a new `.dump` file appears after the restore validation.
- If the recovery target is the final production machine, run a fresh backup after validation.
