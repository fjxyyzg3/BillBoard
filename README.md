# BillBoard

BillBoard is a mobile-first household accounting app for two people. The core workflow is quick entry, member-perspective review, and time-range recap.

## Current Product Shape

- `/login`: credentials login for seeded household users.
- `/home`: household overview with income, expense, net, trend, category breakdown, and recent records.
- `/add`: quick income or expense entry. After saving, the page stays ready for the next entry and shows a lightweight top toast with the saved type and amount for 2.5 seconds.
- `/records`: filterable history with edit and soft-delete support.
- UI locale defaults to Chinese and can be switched to English with the header language control.

## Key Rules

- Store money as integer fen in `amountFen`.
- Calculate transaction dates and ranges in `Asia/Shanghai`.
- Exclude soft-deleted transactions from active lists and reports.
- Scope household data by the current session's `householdId` and `memberId`.
- Default categories are seeded from `prisma/seed.ts`; built-in category names are stored in English and translated only for UI display.

## Local Setup

Install dependencies:

```powershell
npm install
```

Start the development PostgreSQL database:

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
```

On Windows, Podman may print `Executing external compose provider "podman-compose"`; this is informational, not an error. If the database container is running but Prisma cannot reach `127.0.0.1:5432`, keep an SSH tunnel open in a separate PowerShell:

```powershell
$dbIp = podman inspect billboard_db_1 --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"
$machine = podman machine inspect podman-machine-default | ConvertFrom-Json
ssh.exe -i $machine.SSHConfig.IdentityPath -p $machine.SSHConfig.Port -N -L "127.0.0.1:15432:${dbIp}:5432" "$($machine.SSHConfig.RemoteUsername)@127.0.0.1"
```

Then run Prisma and Next.js commands with the tunnel URL:

```powershell
$env:DATABASE_URL = "postgresql://billboard:billboard@127.0.0.1:15432/billboard?schema=public"
```

Prepare the schema and seed data:

```powershell
npm run prisma:migrate
npm run prisma:seed
```

Run the app:

```powershell
npm run dev
```

For LAN device testing, bind the dev server to the machine's LAN IP:

```powershell
npm run dev -- --hostname <LAN_IP> --port 3000
```

If a tunnel such as frpc maps `127.0.0.1:3000` to an external IP and port, bind Next.js to all local interfaces so both loopback and LAN access work:

```powershell
npm run dev -- --hostname 0.0.0.0 --port 3000
```

When using an external IP or domain with `next dev`, add that host to `allowedDevOrigins` in `next.config.ts` and restart the dev server. Otherwise Next.js can block development resources, leaving the login form without client-side `signIn` handling. The current temporary frp test host `115.29.200.7` is already allowed.

The default seed logins are defined in `.env.example`:

- 老公: `lehary@home.com`
- 老婆: `noma@home.com`
- Password: `10212286`

## Verification

Use the smallest command that proves the change:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Integration and E2E tests need PostgreSQL plus seed data. Playwright uses `http://127.0.0.1:3000` and starts `npm run dev` automatically. E2E runs clear the `Transaction` table before and after the suite, so point them only at a test database.

If Podman on Windows reports the database container is running but Prisma cannot reach `127.0.0.1:5432`, restart the Podman machine or use the SSH tunnel from Local Setup and point `DATABASE_URL` at `127.0.0.1:15432`.

## Operations Docs

- `docs/runbooks/home-network-checklist.md`: production home-network launch checklist.
- `docs/runbooks/restore.md`: restore procedure for a rebuilt or replacement machine.
- `docs/superpowers/specs/` and `docs/superpowers/plans/`: historical design and implementation records.
