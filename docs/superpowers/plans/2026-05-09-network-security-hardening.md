# Network Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden BillBoard's production network defaults by closing public direct `3000`, rejecting default production credentials, adding proxy security headers, and updating audited dependencies.

**Current Note:** Completed in `v1.0.8`. `v1.11.0` on 2026-05-20 uses nginx root routing for the BillBoard hostname; the public-direct-`3000` closure and loopback-only `3000` security boundary remain current.

**Architecture:** Use static tests to pin security-sensitive config behavior, then update Podman/Caddy/Windows startup files and docs with the smallest compatible changes. Keep app business logic untouched; production traffic defaults to Caddy/HTTPS while direct `3000` is local-only in the Windows fallback path.

**Tech Stack:** Next.js 16, Auth.js, Prisma, Podman Compose, Caddy, PowerShell, Vitest static configuration tests.

---

### Task 1: Add Static Security Regression Tests

**Files:**
- Create: `tests/unit/security-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("production network security config", () => {
  test("production compose does not publish web port 3000 by default", () => {
    const compose = readRepoFile("podman-compose.yml");

    expect(compose).not.toContain("${APP_PORT:-3000}:3000");
    expect(compose).not.toContain("3000:3000");
  });

  test("Windows fallback binds direct web tunnel to loopback only", () => {
    const script = readRepoFile("ops/windows/start-production.ps1");

    expect(script).toContain('"127.0.0.1:3000:${WebIp}:3000"');
    expect(script).not.toContain('"0.0.0.0:3000:${WebIp}:3000"');
  });

  test("production startup rejects placeholder database password", () => {
    const script = readRepoFile("ops/windows/start-production.ps1");
    const containerfile = readRepoFile("Containerfile");

    expect(script).toContain('Assert-RequiredProductionSecret -Name "POSTGRES_PASSWORD"');
    expect(script).toContain('-DefaultValue "billboard"');
    expect(script).toContain("POSTGRES_PASSWORD=<redacted>");
    expect(containerfile).toContain("POSTGRES_PASSWORD must be set to a non-placeholder value");
  });

  test("Caddy sends baseline browser security headers", () => {
    const caddyfile = readRepoFile("ops/caddy/Caddyfile");

    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toContain("X-Content-Type-Options");
    expect(caddyfile).toContain("Referrer-Policy");
    expect(caddyfile).toContain("Permissions-Policy");
    expect(caddyfile).toContain("X-Frame-Options");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/security-config.test.ts`

Expected: FAIL because `podman-compose.yml` still publishes `${APP_PORT:-3000}:3000`, the Windows script still binds `0.0.0.0:3000`, Caddy lacks security headers, and placeholder DB password checks are missing.

### Task 2: Harden Production Entrypoints

**Files:**
- Modify: `podman-compose.yml`
- Modify: `ops/windows/start-production.ps1`
- Modify: `Containerfile`
- Modify: `ops/caddy/Caddyfile`

- [ ] **Step 1: Implement minimal config changes**

Change `podman-compose.yml` so `web` has no default `ports` entry and all production database URLs require `POSTGRES_PASSWORD`.

Change `ops/windows/start-production.ps1` so the web tunnel uses `127.0.0.1:3000:${WebIp}:3000`, and add checks that reject missing, default, or placeholder `AUTH_SECRET` and `POSTGRES_PASSWORD`.

Change `Containerfile` so the production command rejects empty, placeholder, or default database password in `DATABASE_URL`.

Change `ops/caddy/Caddyfile` to add the baseline security headers inside the existing site block.

- [ ] **Step 2: Run static test to verify it passes**

Run: `npm run test:unit -- tests/unit/security-config.test.ts`

Expected: PASS.

### Task 3: Update Operational Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/runbooks/home-network-checklist.md`
- Modify: `docs/runbooks/restore.md`

- [ ] **Step 1: Update docs to match new defaults**

Document that production default entry is Caddy `80/443`, direct `3000` is no longer published by default, Windows fallback `3000` is loopback-only, and production `POSTGRES_PASSWORD` must be real and private.

- [ ] **Step 2: Run targeted static test again**

Run: `npm run test:unit -- tests/unit/security-config.test.ts`

Expected: PASS.

### Task 4: Upgrade Audited Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Upgrade within current major/minor-safe boundaries**

Run: `npm install next@16.2.6 prisma@6.19.3 @prisma/client@6.19.3`

Expected: package files update without dependency resolution errors.

- [ ] **Step 2: Generate Prisma client after dependency upgrade**

Run: `npm run prisma:generate`

Expected: Prisma client generation succeeds.

- [ ] **Step 3: Run audit**

Run: `npm audit --json`

Expected: Remaining audit items, if any, are recorded as residual risk rather than solved by canary, downgrade, or major migration.

- [ ] **Step 4: Add targeted override if stable Next still pins vulnerable PostCSS**

If audit still reports Next's nested `postcss <8.5.10`, add this to `package.json`, run `npm install`, then run `npm audit --json` again.

```json
"overrides": {
  "next": {
    "postcss": "8.5.14"
  }
}
```

Expected: audit reports 0 vulnerabilities.

### Task 5: Full Verification

**Files:**
- No additional files.

- [ ] **Step 1: Run lint**

Run: `npm run lint`

Expected: PASS with zero warnings.

- [ ] **Step 2: Run unit tests**

Run: `npm run test:unit`

Expected: PASS.

- [ ] **Step 3: Run integration tests**

Run: `npm run test:integration`

Expected: PASS against the development/test database.

- [ ] **Step 4: Run e2e tests**

Run: `npm run test:e2e`

Expected: PASS against `http://127.0.0.1:2500`.

- [ ] **Step 5: Check git diff**

Run: `git diff --stat`

Expected: only planned config, docs, test, spec/plan, and package files changed.
