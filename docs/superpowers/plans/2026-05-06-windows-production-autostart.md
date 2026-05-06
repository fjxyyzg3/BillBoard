# Windows Production Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure BillBoard production to start on Windows boot before an interactive user login.

**Architecture:** Use Windows Task Scheduler with an at-startup trigger under the existing `littleclaw\fjxyy` user context so the task can access the existing Podman machine, SSH identity, and repository files. The startup script keeps PostgreSQL in the `billboard_default` Podman network, starts the current Windows fallback web container, copies standalone static assets before starting Next.js, and keeps the host `3000` SSH tunnel alive.

**Tech Stack:** PowerShell 7, Windows Task Scheduler, Podman machine, Podman containers, OpenSSH local port forwarding, Next.js standalone output.

**Execution Status:** Completed and manually verified on 2026-05-06. The registered task is `BillBoard Production Startup`; `LastTaskResult=267009` means the task is running and holding the SSH tunnel open.

---

## File Structure

- Create `ops/windows/start-production.ps1`: idempotent production startup script. It reads `.env.production.local`, starts Podman, starts `db`, recreates `billboard_web_1`, creates the `3000` tunnel, verifies `/login`, and optionally stays attached for Task Scheduler.
- Create `ops/windows/register-production-startup.ps1`: registers or replaces the `BillBoard Production Startup` scheduled task.
- Modify `docs/runbooks/home-network-checklist.md`: document the autostart task and verification commands.

## Task 1: Startup Script

**Files:**
- Create: `ops/windows/start-production.ps1`

- [x] **Step 1: Implement the PowerShell startup script**

The script must:

- read `.env.production.local` from the repository root;
- require `AUTH_SECRET`;
- start `podman-machine-default` when needed;
- start `db` via `podman compose`;
- wait for `pg_isready`;
- recreate `billboard_web_1` from `localhost/billboard-tools:latest`;
- copy `.next/static` to `.next/standalone/.next/static` before `server.js`;
- start an SSH tunnel from `0.0.0.0:3000` to the web container IP;
- verify `/login` and one JS chunk;
- stay attached when `-StayAttached` is passed.

- [x] **Step 2: Verify manually**

Run:

```powershell
.\ops\windows\start-production.ps1
```

Expected:

- `billboard_db_1` is healthy.
- `billboard_web_1` is running.
- `http://127.0.0.1:3000/login` returns `200`.
- A `/_next/static/chunks/*.js` URL returns `200`.

## Task 2: Scheduled Task Registration

**Files:**
- Create: `ops/windows/register-production-startup.ps1`

- [x] **Step 1: Implement the registration script**

Register or replace a task named `BillBoard Production Startup` with:

- trigger: at startup;
- action: `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\ops\windows\start-production.ps1 -StayAttached`;
- principal: current Windows user with `S4U` logon type and highest run level;
- settings: start when available, allow battery start, restart on failure, long execution time.

- [x] **Step 2: Register the task**

Run:

```powershell
.\ops\windows\register-production-startup.ps1
```

Expected: `Get-ScheduledTask -TaskName "BillBoard Production Startup"` shows the task.

- [x] **Step 3: Trigger and verify**

Run:

```powershell
Start-ScheduledTask -TaskName "BillBoard Production Startup"
```

Expected:

- The scheduled task reaches `Running`.
- `netstat -ano` shows `0.0.0.0:3000` listening.
- `Invoke-WebRequest http://127.0.0.1:3000/login` returns `200`.

## Task 3: Documentation

**Files:**
- Modify: `docs/runbooks/home-network-checklist.md`

- [x] **Step 1: Add autostart notes**

Document:

- the scheduled task name;
- the registration command;
- where startup logs are written;
- how to verify the task and endpoint.

- [x] **Step 2: Verify docs**

Run:

```powershell
rg -n "BillBoard Production Startup|start-production|register-production-startup|tmp/logs" docs/runbooks/home-network-checklist.md
```

Expected: all important names and paths appear.

## Self-Review

- Spec coverage: Covers unattended startup, current Windows Podman fallback, persistent tunnel, and verification.
- Placeholder scan: no TBD/TODO placeholders.
- Scope check: Does not change product code, database schema, seed data, or production credentials in tracked files.
