# Home Network Checklist

Use this checklist before exposing the production stack to the public internet.

## Secrets and Bootstrap

- Set a real `AUTH_SECRET` before starting the public stack. The production `web` container refuses to start with the placeholder value.
- Install Podman and a Podman Compose provider before running production commands. The project wrappers default `PODMAN_COMPOSE_PROVIDER` to `podman-compose`.
- Decide which production entrypoint is being published:
  - Direct app access: `http://<host>:${APP_PORT:-3000}` via the `web` service.
  - HTTPS/domain access: `80/443 -> proxy -> web:3000`.
- For a first-time deployment on an empty volume, plan to initialize the database before opening the site publicly:
  `bash ops/podman/compose.sh -f podman-compose.yml up -d db`
  `bash ops/podman/compose.sh -f podman-compose.yml --profile bootstrap run --rm bootstrap`
- For replacement-host recovery from an existing backup, follow `docs/runbooks/restore.md` instead of the bootstrap path.

## Domain and DNS

- Confirm you control the production domain or subdomain for BillBoard.
- Point the chosen hostname at your home network's current public IP.
- If the IP changes periodically, configure dynamic DNS before launch.

## Ingress and Routing

- For direct app access, confirm the host firewall and any router/tunnel rules allow `${APP_PORT:-3000}` to reach the machine running the Podman stack.
- For HTTPS/domain access, verify the ISP connection supports inbound traffic on ports `80` and `443`.
- Check whether the network is behind carrier-grade NAT. If it is, revise the deployment approach before launch.
- Forward only the selected entrypoint ports from the router to the machine running the Podman stack.
- Do not expose PostgreSQL to the internet.

## Host Readiness

- Install Podman and `podman-compose` on the target machine.
- Store the production env values somewhere recoverable outside the host, including `AUTH_SECRET`, `APP_DOMAIN`, optional `APP_PORT`, and the `SEED_USER_*` credentials used for the initial bootstrap.
- Confirm the host firewall allows the selected production entrypoint ports.
- Make sure the machine has reliable storage for PostgreSQL data and backup output.

## Validation

- Start the direct app service after the database is prepared: `bash ops/podman/compose.sh -f podman-compose.yml up -d web`.
- Visit `http://<host>:${APP_PORT:-3000}` and confirm the app loads.
- If using HTTPS/domain access, start `proxy` too: `bash ops/podman/compose.sh -f podman-compose.yml up -d web proxy`.
- If using HTTPS/domain access, visit the public hostname and confirm Caddy provisions HTTPS successfully.
- Confirm login works through the selected production entrypoint.
- Run `bash ops/backup/pg_dump.sh ./tmp/backups` and verify a dump file is created.

## Windows Podman Fallback

Use this only when the normal production `web` compose build or port publishing is stuck on Windows. Keep the database in the `billboard_default` Podman network, start `web` from a built application, and expose host port `3000` with an SSH tunnel to the web container IP.

- Preserve and reuse a real `AUTH_SECRET`; changing it invalidates existing JWT cookies.
- If starting `node .next/standalone/server.js` manually, copy `.next/static` to `.next/standalone/.next/static` before starting the server. Otherwise `/_next/static/chunks/*.js` returns `404`, the login form loses its client-side `signIn` handler, and submissions appear as `/login?email=...&password=...`.
- After starting the fallback, verify at least one chunk and the login page:
  `Invoke-WebRequest http://127.0.0.1:3000/_next/static/chunks/<chunk>.js`
  `Invoke-WebRequest http://127.0.0.1:3000/login`
- If Podman `-p 3000:3000` does not create a working Windows listener, remove the host port publishing and create an SSH tunnel with `podman machine inspect` parameters from `0.0.0.0:3000` to `<web-container-ip>:3000`.

## Windows Autostart

When the production host is Windows and the fallback path is required, register the startup task after `.env.production.local` contains the production `AUTH_SECRET`. This registration needs administrator rights because it creates an at-startup scheduled task.

```powershell
.\ops\windows\register-production-startup.ps1
```

The task is named `BillBoard Production Startup`. It runs at system startup under the current Windows user with `S4U` logon, so it can start before an interactive login while still using that user's Podman machine files.

Useful checks:

```powershell
Get-ScheduledTask -TaskName "BillBoard Production Startup"
Get-Content .\tmp\logs\production-startup.log -Tail 80
Invoke-WebRequest http://127.0.0.1:3000/login -UseBasicParsing
```

`LastTaskResult` value `267009` means the task is currently running, which is expected because `start-production.ps1 -StayAttached` waits on the SSH tunnel process.

If the task fails before login, first check whether it can access the current user's Podman machine SSH identity at `C:\Users\<user>\.local\share\containers\podman\machine\machine`. If `S4U` cannot access it on the host, re-register the task with stored Windows credentials or switch to a normal logged-in startup task.
