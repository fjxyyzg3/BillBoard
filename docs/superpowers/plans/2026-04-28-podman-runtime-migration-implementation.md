# Podman Runtime Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 BillBoard 的开发测试、生产部署、备份恢复容器入口从 Docker 迁移到 Podman Compose 风格。

**Architecture:** 保持现有 Compose 服务拓扑和应用业务代码不变，只改容器入口命名、薄包装脚本、备份恢复调用和运行文档。新增 PowerShell 与 Bash 两个入口脚本，集中设置默认 `PODMAN_COMPOSE_PROVIDER=podman-compose` 并透传到 `podman compose`。

**Tech Stack:** Podman CLI, podman-compose provider, PowerShell, Bash, PostgreSQL 17, Next.js standalone, Prisma, Caddy.

---

## File Structure

- Rename: `Dockerfile` -> `Containerfile`
  - 负责 Next.js production image 构建，内容保持现有多阶段构建。
- Rename: `.dockerignore` -> `.containerignore`
  - 负责 Podman build context 忽略规则。
- Rename: `docker-compose.yml` -> `podman-compose.yml`
  - 负责生产 `web`、`bootstrap`、`db`、`proxy` 服务编排。
- Rename: `docker-compose.dev.yml` -> `podman-compose.dev.yml`
  - 负责本地开发测试 PostgreSQL 服务。
- Create: `ops/podman/compose.ps1`
  - Windows PowerShell 原生 Podman Compose 入口。
- Create: `ops/podman/compose.sh`
  - Linux/Git Bash Podman Compose 入口。
- Modify: `ops/backup/pg_dump.sh`
  - 通过 `ops/podman/compose.sh` 操作 `db` 服务，并用 `podman cp` 复制 dump。
- Modify: `ops/backup/restore-from-dump.sh`
  - 通过 `ops/podman/compose.sh` 操作 `db` 服务，并用 `podman cp` 复制 dump。
- Modify: `AGENTS.md`
  - 更新测试数据库启动说明。
- Modify: `docs/runbooks/home-network-checklist.md`
  - 更新生产新部署检查清单和命令。
- Modify: `docs/runbooks/restore.md`
  - 更新恢复流程命令。
- Modify: `package.json`
  - 保持 `version` 为 `0.3.0`，不要再次递增。
- Modify: `package-lock.json`
  - 保持根项目版本为 `0.3.0`，不要再次递增。

---

### Task 1: Rename Container Entry Files

**Files:**
- Rename: `Dockerfile` -> `Containerfile`
- Rename: `.dockerignore` -> `.containerignore`
- Rename: `docker-compose.yml` -> `podman-compose.yml`
- Rename: `docker-compose.dev.yml` -> `podman-compose.dev.yml`
- Modify: `podman-compose.yml`

- [ ] **Step 1: Verify the current Docker-named files are still present**

Run:

```powershell
@(
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.dev.yml",
  "Containerfile",
  ".containerignore",
  "podman-compose.yml",
  "podman-compose.dev.yml"
) | ForEach-Object { "$_ exists: $(Test-Path $_)" }
```

Expected before implementation:

```text
Dockerfile exists: True
.dockerignore exists: True
docker-compose.yml exists: True
docker-compose.dev.yml exists: True
Containerfile exists: False
.containerignore exists: False
podman-compose.yml exists: False
podman-compose.dev.yml exists: False
```

- [ ] **Step 2: Rename the files with Git**

Run:

```powershell
git mv Dockerfile Containerfile
git mv .dockerignore .containerignore
git mv docker-compose.yml podman-compose.yml
git mv docker-compose.dev.yml podman-compose.dev.yml
```

Expected: commands exit 0.

- [ ] **Step 3: Update production build references**

Edit `podman-compose.yml` so both build entries point to `Containerfile`.

Target `podman-compose.yml`:

```yaml
services:
  web:
    build:
      context: .
      dockerfile: Containerfile
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER:-billboard}:${POSTGRES_PASSWORD:-billboard}@db:5432/${POSTGRES_DB:-billboard}?schema=public
      AUTH_SECRET: ${AUTH_SECRET:-change-me-before-launch}
    restart: unless-stopped

  bootstrap:
    build:
      context: .
      dockerfile: Containerfile
      target: tools
    command: >-
      sh -lc "npx prisma migrate deploy && node --import tsx prisma/seed.ts"
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-billboard}:${POSTGRES_PASSWORD:-billboard}@db:5432/${POSTGRES_DB:-billboard}?schema=public
      SEED_HOUSEHOLD_NAME: ${SEED_HOUSEHOLD_NAME:-Household}
      SEED_USER_A_EMAIL: ${SEED_USER_A_EMAIL:-}
      SEED_USER_A_PASSWORD: ${SEED_USER_A_PASSWORD:-}
      SEED_USER_A_NAME: ${SEED_USER_A_NAME:-Me}
      SEED_USER_B_EMAIL: ${SEED_USER_B_EMAIL:-}
      SEED_USER_B_PASSWORD: ${SEED_USER_B_PASSWORD:-}
      SEED_USER_B_NAME: ${SEED_USER_B_NAME:-Spouse}
    profiles:
      - bootstrap
    restart: "no"

  db:
    image: postgres:17
    environment:
      POSTGRES_DB: ${POSTGRES_DB:-billboard}
      POSTGRES_USER: ${POSTGRES_USER:-billboard}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-billboard}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-billboard} -d ${POSTGRES_DB:-billboard}"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    volumes:
      - postgres-data:/var/lib/postgresql/data

  proxy:
    image: caddy:2.10
    depends_on:
      web:
        condition: service_started
    environment:
      APP_DOMAIN: ${APP_DOMAIN:-localhost}
    ports:
      - "80:80"
      - "443:443"
    restart: unless-stopped
    volumes:
      - ./ops/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  postgres-data:
  caddy-data:
  caddy-config:
```

- [ ] **Step 4: Verify renamed files and build references**

Run:

```powershell
@(
  "Dockerfile",
  ".dockerignore",
  "docker-compose.yml",
  "docker-compose.dev.yml",
  "Containerfile",
  ".containerignore",
  "podman-compose.yml",
  "podman-compose.dev.yml"
) | ForEach-Object { "$_ exists: $(Test-Path $_)" }

Select-String -Path podman-compose.yml -Pattern "dockerfile: Dockerfile","dockerfile: Containerfile"
```

Expected after implementation:

```text
Dockerfile exists: False
.dockerignore exists: False
docker-compose.yml exists: False
docker-compose.dev.yml exists: False
Containerfile exists: True
.containerignore exists: True
podman-compose.yml exists: True
podman-compose.dev.yml exists: True
```

Expected `Select-String`: two `dockerfile: Containerfile` matches and zero `dockerfile: Dockerfile` matches.

---

### Task 2: Add Podman Compose Wrapper Scripts

**Files:**
- Create: `ops/podman/compose.ps1`
- Create: `ops/podman/compose.sh`

- [ ] **Step 1: Verify wrapper scripts are absent**

Run:

```powershell
Test-Path ops\podman\compose.ps1
Test-Path ops\podman\compose.sh
```

Expected before implementation:

```text
False
False
```

- [ ] **Step 2: Create the PowerShell wrapper**

Create `ops/podman/compose.ps1`:

```powershell
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ComposeArgs
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
  Write-Error "podman command not found. Install Podman and podman-compose before running this script."
  exit 127
}

if (-not $env:PODMAN_COMPOSE_PROVIDER) {
  $env:PODMAN_COMPOSE_PROVIDER = "podman-compose"
}

& podman compose @ComposeArgs
exit $LASTEXITCODE
```

- [ ] **Step 3: Create the Bash wrapper**

Create `ops/podman/compose.sh`:

```bash
#!/usr/bin/env bash

set -euo pipefail

if ! command -v podman >/dev/null 2>&1; then
  echo "podman command not found. Install Podman and podman-compose before running this script." >&2
  exit 127
fi

export PODMAN_COMPOSE_PROVIDER="${PODMAN_COMPOSE_PROVIDER:-podman-compose}"

exec podman compose "$@"
```

- [ ] **Step 4: Verify wrapper script content**

Run:

```powershell
Select-String -Path ops\podman\compose.ps1 -Pattern "PODMAN_COMPOSE_PROVIDER","podman-compose","podman compose","exit 127"
Select-String -Path ops\podman\compose.sh -Pattern "PODMAN_COMPOSE_PROVIDER","podman-compose","podman compose","exit 127"
```

Expected: each pattern appears in the relevant script.

- [ ] **Step 5: Run lightweight script behavior checks**

Run on Windows:

```powershell
.\ops\podman\compose.ps1 --help
```

Expected when Podman is installed: exit 0 and `podman compose` help text appears.

Expected when Podman is not installed:

```text
podman command not found. Install Podman and podman-compose before running this script.
```

Run in Bash:

```bash
bash ops/podman/compose.sh --help
```

Expected when Podman is installed: exit 0 and `podman compose` help text appears.

Expected when Podman is not installed:

```text
podman command not found. Install Podman and podman-compose before running this script.
```

---

### Task 3: Move Backup And Restore To Podman

**Files:**
- Modify: `ops/backup/pg_dump.sh`
- Modify: `ops/backup/restore-from-dump.sh`

- [ ] **Step 1: Verify backup scripts still contain Docker calls**

Run:

```powershell
Select-String -Path ops\backup\pg_dump.sh,ops\backup\restore-from-dump.sh -Pattern "docker compose","docker cp","podman cp","ops/podman/compose.sh"
```

Expected before implementation: matches for `docker compose` and `docker cp`; no matches for `podman cp` or `ops/podman/compose.sh`.

- [ ] **Step 2: Replace `pg_dump.sh` with the Podman-backed version**

Target `ops/backup/pg_dump.sh`:

```bash
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
compose_cmd=(bash ops/podman/compose.sh -f podman-compose.yml)

cd "$repo_root"
mkdir -p "$output_dir"

"${compose_cmd[@]}" up -d db >/dev/null

attempts=0
until "${compose_cmd[@]}" exec -T db pg_isready -U "$postgres_user" -d "$postgres_db" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "database did not become ready within 30 seconds" >&2
    exit 1
  fi
  sleep 1
done

"${compose_cmd[@]}" exec -T db pg_dump \
  -U "$postgres_user" \
  -d "$postgres_db" \
  --clean \
  --create \
  --format=custom \
  --file="$container_dump"

container_id="$("${compose_cmd[@]}" ps -q db)"

if [ "$container_id" = "" ]; then
  echo "could not resolve the db container id" >&2
  exit 1
fi

podman cp "${container_id}:${container_dump}" "$dump_file" >/dev/null
"${compose_cmd[@]}" exec -T db rm -f "$container_dump"
find "$output_dir" -maxdepth 1 -name "billboard-*.dump" -type f -mtime +14 -delete

echo "$dump_file"
```

- [ ] **Step 3: Replace `restore-from-dump.sh` with the Podman-backed version**

Target `ops/backup/restore-from-dump.sh`:

```bash
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
compose_cmd=(bash ops/podman/compose.sh -f podman-compose.yml)

cd "$repo_root"
"${compose_cmd[@]}" up -d db >/dev/null

attempts=0
until "${compose_cmd[@]}" exec -T db pg_isready -U "$postgres_user" -d "$postgres_db" >/dev/null 2>&1; do
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

podman cp "$dump_file" "${container_id}:${container_dump}" >/dev/null
"${compose_cmd[@]}" exec -T db pg_restore \
  --clean \
  --create \
  --if-exists \
  --no-owner \
  -U "$postgres_user" \
  -d postgres \
  "$container_dump"
"${compose_cmd[@]}" exec -T db rm -f "$container_dump"

echo "restored $dump_file into $postgres_db"
```

- [ ] **Step 4: Verify backup scripts use the Podman path**

Run:

```powershell
Select-String -Path ops\backup\pg_dump.sh,ops\backup\restore-from-dump.sh -Pattern "docker compose","docker cp"
Select-String -Path ops\backup\pg_dump.sh,ops\backup\restore-from-dump.sh -Pattern "ops/podman/compose.sh","podman cp","podman-compose.yml"
```

Expected: first command prints no matches. Second command prints matches in both scripts.

---

### Task 4: Update Operational Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/runbooks/home-network-checklist.md`
- Modify: `docs/runbooks/restore.md`

- [ ] **Step 1: Verify primary docs still mention Docker as the runtime path**

Run:

```powershell
Select-String -Path AGENTS.md,docs\runbooks\home-network-checklist.md,docs\runbooks\restore.md -Pattern "docker compose","Docker Engine","Docker Compose","Docker stack","Dockerfile","docker-compose"
```

Expected before implementation: matches in all three files.

- [ ] **Step 2: Update `AGENTS.md` test environment command**

Replace the test environment bullet with this text:

```markdown
- 测试环境：集成测试和 e2e 依赖 PostgreSQL 与 seed 数据；本地数据库优先用 `.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db`，Linux/Bash 环境用 `bash ops/podman/compose.sh -f podman-compose.dev.yml up -d db`，seed 用 `npm run prisma:seed`。Playwright 默认使用 `http://127.0.0.1:3000` 并启动 `npm run dev`。
```

- [ ] **Step 3: Replace the home network checklist**

Target `docs/runbooks/home-network-checklist.md`:

```markdown
# Home Network Checklist

Use this checklist before exposing the production stack to the public internet.

## Secrets and Bootstrap

- Set a real `AUTH_SECRET` before starting the public stack. The production `web` container refuses to start with the placeholder value.
- Install Podman and a Podman Compose provider before running production commands. The project wrappers default `PODMAN_COMPOSE_PROVIDER` to `podman-compose`.
- For a first-time deployment on an empty volume, plan to initialize the database before opening the site publicly:
  `bash ops/podman/compose.sh -f podman-compose.yml up -d db`
  `bash ops/podman/compose.sh -f podman-compose.yml --profile bootstrap run --rm bootstrap`
- For replacement-host recovery from an existing backup, follow `docs/runbooks/restore.md` instead of the bootstrap path.

## Domain and DNS

- Confirm you control the production domain or subdomain for BillBoard.
- Point the chosen hostname at your home network's current public IP.
- If the IP changes periodically, configure dynamic DNS before launch.

## Ingress and Routing

- Verify the ISP connection supports inbound traffic on ports `80` and `443`.
- Check whether the network is behind carrier-grade NAT. If it is, revise the deployment approach before launch.
- Forward only ports `80` and `443` from the router to the machine running the Podman stack.
- Do not expose PostgreSQL or the app container directly to the internet.

## Host Readiness

- Install Podman and `podman-compose` on the target machine.
- Store the production env values somewhere recoverable outside the host, including `AUTH_SECRET`, `APP_DOMAIN`, and the `SEED_USER_*` credentials used for the initial bootstrap.
- Confirm the host firewall allows inbound `80` and `443`.
- Make sure the machine has reliable storage for PostgreSQL data and backup output.

## Validation

- Start only the public services after the database is prepared: `bash ops/podman/compose.sh -f podman-compose.yml up -d web proxy`.
- Visit the public hostname and confirm Caddy provisions HTTPS successfully.
- Confirm login works over HTTPS.
- Run `bash ops/backup/pg_dump.sh ./tmp/backups` and verify a dump file is created.
```

- [ ] **Step 4: Replace the restore runbook**

Target `docs/runbooks/restore.md`:

```markdown
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
```

- [ ] **Step 5: Verify primary docs use Podman as the runtime path**

Run:

```powershell
Select-String -Path AGENTS.md,docs\runbooks\home-network-checklist.md,docs\runbooks\restore.md -Pattern "docker compose","Docker Engine","Docker Compose","Docker stack","Dockerfile","docker-compose"
Select-String -Path AGENTS.md,docs\runbooks\home-network-checklist.md,docs\runbooks\restore.md -Pattern "podman-compose.yml","podman-compose.dev.yml","ops/podman/compose.ps1","ops/podman/compose.sh"
```

Expected: first command prints no matches. Second command prints matches in the updated files.

---

### Task 5: Static Migration Verification

**Files:**
- Verify: repository tracked files and primary runtime docs

- [ ] **Step 1: Verify old container entry filenames are no longer tracked**

Run:

```powershell
git ls-files | Select-String -Pattern '(^|/)(Dockerfile|docker-compose(\.dev)?\.yml|\.dockerignore)$'
```

Expected: no matches.

- [ ] **Step 2: Verify new container entry filenames are tracked**

Run:

```powershell
git ls-files | Select-String -Pattern '(^|/)(Containerfile|podman-compose(\.dev)?\.yml|\.containerignore)$'
```

Expected:

```text
.containerignore
Containerfile
podman-compose.dev.yml
podman-compose.yml
```

- [ ] **Step 3: Verify primary runtime scripts no longer call Docker**

Run:

```powershell
Select-String -Path ops\backup\pg_dump.sh,ops\backup\restore-from-dump.sh,ops\podman\compose.ps1,ops\podman\compose.sh -Pattern "docker compose","docker cp"
```

Expected: no matches.

- [ ] **Step 4: Verify version remains aligned with the design commit**

Run:

```powershell
node -e "const fs=require('node:fs'); const pkg=require('./package.json'); const lock=require('./package-lock.json'); if (pkg.version !== '0.3.0') process.exit(1); if (lock.version !== '0.3.0') process.exit(2); if (lock.packages[''].version !== '0.3.0') process.exit(3); console.log('version ok')"
```

Expected:

```text
version ok
```

---

### Task 6: Full Verification And Single Feature Commit

**Files:**
- Verify: all changed files
- Modify: Git history for the current feature branch only

- [ ] **Step 1: Prepare the database needed by integration and e2e tests**

Preferred when Podman is available:

```powershell
.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db
npm run prisma:generate
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:5432/billboard?schema=public'; npx prisma migrate deploy
npm run prisma:seed
```

Expected: database starts, Prisma client is generated, migrations apply, seed exits 0.

If Podman is unavailable but a PostgreSQL test database is already reachable at `127.0.0.1:5432`, run the Prisma generate/migrate/seed commands above and record that Podman runtime validation is blocked by local environment.

- [ ] **Step 2: Run the repository verification commands**

Run:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected:

```text
npm run lint: exits 0
npm run test:unit: exits 0
npm run test:integration: exits 0
npm run test:e2e: exits 0
```

- [ ] **Step 3: Review the final diff**

Run:

```powershell
git status --short --branch
git diff --stat
git diff -- Containerfile .containerignore podman-compose.yml podman-compose.dev.yml
git diff -- ops/podman/compose.ps1 ops/podman/compose.sh ops/backup/pg_dump.sh ops/backup/restore-from-dump.sh
git diff -- AGENTS.md docs/runbooks/home-network-checklist.md docs/runbooks/restore.md
```

Expected: only files listed in this plan are changed, plus the plan document itself.

- [ ] **Step 4: Stage all Podman migration files**

Run:

```powershell
git add AGENTS.md `
  Containerfile `
  .containerignore `
  podman-compose.yml `
  podman-compose.dev.yml `
  ops/podman/compose.ps1 `
  ops/podman/compose.sh `
  ops/backup/pg_dump.sh `
  ops/backup/restore-from-dump.sh `
  docs/runbooks/home-network-checklist.md `
  docs/runbooks/restore.md `
  docs/superpowers/specs/2026-04-27-podman-runtime-migration-design.md `
  docs/superpowers/plans/2026-04-28-podman-runtime-migration-implementation.md `
  package.json `
  package-lock.json
```

Expected: command exits 0.

- [ ] **Step 5: Amend the existing design commit into one feature commit**

The branch already contains the approved design commit for this same feature and version `0.3.0`. Keep the feature as one commit by amending that commit instead of creating a second feature commit.

Run:

```powershell
git commit --amend -m "v0.3.0 转向 Podman 运行链路" -m "将容器入口迁到 Podman Compose，新增 PowerShell/Bash 包装脚本，更新备份恢复和部署验证文档。"
```

Expected: one commit exists on top of `origin/master`.

- [ ] **Step 6: Verify final branch shape**

Run:

```powershell
git log --oneline origin/master..HEAD
git status --short --branch
```

Expected:

```text
<hash> v0.3.0 转向 Podman 运行链路
## codex/podman-runtime-design...origin/master [ahead 1]
```

No unstaged or untracked implementation files should remain.

---

## Self-Review

- Spec coverage: 文件改名、双入口、provider 默认值、开发测试、生产部署、备份恢复、文档更新、验证边界均有任务覆盖。
- Placeholder scan: 本计划没有未定占位内容；每个代码文件修改都给出了目标内容或精确替换文本。
- Type and command consistency: `podman-compose.yml`、`podman-compose.dev.yml`、`ops/podman/compose.ps1`、`ops/podman/compose.sh` 命名在所有任务中保持一致。
