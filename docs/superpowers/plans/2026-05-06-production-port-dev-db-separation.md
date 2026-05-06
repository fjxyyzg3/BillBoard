# Production Port And Dev Database Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production directly reachable on host port `3000`, move the default dev server to `2500`, and separate dev and production database defaults.

**Architecture:** Keep production container internals on `3000`, add a host `3000` mapping to the production `web` service, and preserve the existing `proxy` service. Move local dev and Playwright to `2500`; use `billboard_dev` as the default local development database while production compose keeps `billboard`.

**Tech Stack:** Next.js scripts, Playwright config, Podman Compose, PostgreSQL, Prisma environment variables, Markdown docs.

---

## File Structure

- Modify `package.json`: change only the `dev` script to bind Next dev to `2500`.
- Modify `playwright.config.ts`: change e2e `baseURL` and `webServer.port` from `3000` to `2500`.
- Modify `.env.example`: point the default `DATABASE_URL` at `billboard_dev`.
- Modify `podman-compose.dev.yml`: set the development PostgreSQL database name to `billboard_dev` and the compose project name to `billboard-dev`.
- Modify `podman-compose.yml`: add host port mapping for production `web` with default `APP_PORT=3000`, set the compose project name to `billboard`, and leave `proxy` unchanged.
- Modify `README.md`: update local setup, LAN/tunnel commands, direct production port, and verification notes.
- Modify `AGENTS.md`: update repository instructions for dev port, production direct port, and database separation.

## Task 1: Port Configuration

**Files:**
- Modify: `package.json`
- Modify: `playwright.config.ts`
- Modify: `podman-compose.yml`

- [ ] **Step 1: Update dev script**

Change `package.json`:

```json
"dev": "next dev --port 2500"
```

- [ ] **Step 2: Update Playwright dev endpoint**

Change `playwright.config.ts`:

```ts
use: {
  baseURL: "http://127.0.0.1:2500",
  trace: "on-first-retry",
},
webServer: {
  command: "npm run dev",
  port: 2500,
  reuseExistingServer: !process.env.CI,
},
```

- [ ] **Step 3: Expose production web on host port 3000**

Add to `podman-compose.yml` under `services.web`:

```yaml
    ports:
      - "${APP_PORT:-3000}:3000"
```

Expected: `proxy` remains present and unchanged.

- [ ] **Step 5: Set production compose project name**

Add to the top of `podman-compose.yml`:

```yaml
name: billboard
```

- [ ] **Step 4: Verify port config by search**

Run:

```powershell
rg -n "127.0.0.1:2500|--port 2500|APP_PORT:-3000|3000:3000|web:3000" package.json playwright.config.ts podman-compose.yml ops\caddy\Caddyfile
```

Expected:
- `package.json` contains `next dev --port 2500`.
- `playwright.config.ts` contains `http://127.0.0.1:2500` and `port: 2500`.
- `podman-compose.yml` contains `${APP_PORT:-3000}:3000`.
- `ops\caddy\Caddyfile` still contains `reverse_proxy web:3000`.

## Task 2: Database Defaults

**Files:**
- Modify: `.env.example`
- Modify: `podman-compose.dev.yml`

- [ ] **Step 1: Update local default DATABASE_URL**

Change `.env.example`:

```env
DATABASE_URL=postgresql://billboard:billboard@127.0.0.1:5432/billboard_dev?schema=public
```

- [ ] **Step 2: Update dev PostgreSQL database name**

Change `podman-compose.dev.yml`:

```yaml
name: billboard-dev

services:
  db:
    environment:
      POSTGRES_DB: billboard_dev
```

- [ ] **Step 3: Verify database separation config**

Run:

```powershell
rg -n "name: billboard|name: billboard-dev|billboard_dev|POSTGRES_DB: \$\{POSTGRES_DB:-billboard\}|postgres-data|postgres-dev-data" .env.example podman-compose.dev.yml podman-compose.yml
```

Expected:
- `.env.example` points to `billboard_dev`.
- `podman-compose.dev.yml` uses `name: billboard-dev`, `POSTGRES_DB: billboard_dev`, and `postgres-dev-data`.
- `podman-compose.yml` uses `name: billboard`, still defaults production `POSTGRES_DB` to `billboard`, and uses `postgres-data`.

## Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update README local setup**

Update local setup examples so the tunnel `DATABASE_URL` uses `billboard_dev`, plain `npm run dev` means `2500`, LAN examples use `--port 2500`, and the development tunnel text no longer assumes `127.0.0.1:3000`.

- [ ] **Step 2: Add production direct port note**

Add a concise README note that production compose exposes `web` on `http://<host>:3000` by default through `APP_PORT`, while the existing `proxy` service remains available for `80/443` reverse proxy use.

- [ ] **Step 3: Update verification notes**

Update README and AGENTS to say Playwright uses `http://127.0.0.1:2500`, starts `npm run dev`, and must point at the development/test database rather than production.

- [ ] **Step 4: Verify docs references**

Run:

```powershell
rg -n "127.0.0.1:3000|--port 3000|Playwright uses|billboard_dev|APP_PORT|正式服务|开发服" README.md AGENTS.md
```

Expected:
- No stale dev-server guidance tells users to run development on port `3000`.
- README documents `APP_PORT` production direct access.
- AGENTS documents development port `2500` and production direct port `3000`.

## Task 4: Final Verification

**Files:**
- Verify all modified config and docs.

- [ ] **Step 1: Run lint**

Run:

```powershell
npm run lint
```

Expected: PASS with zero warnings.

- [ ] **Step 2: Search all active configuration references**

Run:

```powershell
rg -n "3000|2500|billboard_dev|DATABASE_URL|POSTGRES_DB|APP_PORT" package.json playwright.config.ts .env.example podman-compose.dev.yml podman-compose.yml README.md AGENTS.md Containerfile ops\caddy\Caddyfile
```

Expected:
- `3000` remains for production container/direct host access and Caddy reverse proxy.
- `2500` is used for local dev and Playwright.
- `billboard_dev` is used for development defaults.
- production compose still defaults `POSTGRES_DB` to `billboard`.

- [ ] **Step 3: Decide commit readiness**

If committing this feature now, run the repository-required full verification:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected: all PASS before any commit.

## Self-Review

- Spec coverage: Tasks cover production direct `3000`, development `2500`, database default separation including compose project names, retaining `proxy`, and documentation updates.
- Placeholder scan: no TBD/TODO/implement-later placeholders.
- Type and config consistency: `2500` is consistently the dev/e2e port; `3000` remains the production container and direct host port; `billboard_dev` is consistently the development database default.
