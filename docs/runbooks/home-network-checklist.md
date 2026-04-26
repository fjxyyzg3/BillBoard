# Home Network Checklist

Use this checklist before exposing the production stack to the public internet.

## Secrets and Bootstrap

- Set a real `AUTH_SECRET` before starting the public stack. The production `web` container refuses to start with the placeholder value.
- For a first-time deployment on an empty volume, plan to initialize the database before opening the site publicly:
  `docker compose up -d db`
  `docker compose --profile bootstrap run --rm bootstrap`
- For replacement-host recovery from an existing backup, follow `docs/runbooks/restore.md` instead of the bootstrap path.

## Domain and DNS

- Confirm you control the production domain or subdomain for BillBoard.
- Point the chosen hostname at your home network's current public IP.
- If the IP changes periodically, configure dynamic DNS before launch.

## Ingress and Routing

- Verify the ISP connection supports inbound traffic on ports `80` and `443`.
- Check whether the network is behind carrier-grade NAT. If it is, revise the deployment approach before launch.
- Forward only ports `80` and `443` from the router to the machine running the Docker stack.
- Do not expose PostgreSQL or the app container directly to the internet.

## Host Readiness

- Install Docker Engine and Docker Compose on the target machine.
- Store the production env values somewhere recoverable outside the host, including `AUTH_SECRET`, `APP_DOMAIN`, and the `SEED_USER_*` credentials used for the initial bootstrap.
- Confirm the host firewall allows inbound `80` and `443`.
- Make sure the machine has reliable storage for PostgreSQL data and backup output.

## Validation

- Start only the public services after the database is prepared: `docker compose up -d web proxy`.
- Visit the public hostname and confirm Caddy provisions HTTPS successfully.
- Confirm login works over HTTPS.
- Run `bash ops/backup/pg_dump.sh ./tmp/backups` and verify a dump file is created.
