import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const rootDir = process.cwd();
const serverStatePath = join(rootDir, "test-results", "e2e-dev-server.json");
const serverLogPath = join(rootDir, "test-results", "e2e-dev-server.log");
const baseUrl = "http://127.0.0.1:2501";

type ServerState = {
  started: boolean;
  pid?: number;
};

async function isServerAvailable() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);

  try {
    const response = await fetch(`${baseUrl}/login`, {
      redirect: "manual",
      signal: controller.signal,
    });

    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    if (await isServerAvailable()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for e2e dev server at ${baseUrl}. See ${serverLogPath}`);
}

function writeServerState(state: ServerState) {
  mkdirSync(dirname(serverStatePath), { recursive: true });
  writeFileSync(serverStatePath, JSON.stringify(state), "utf8");
}

function readServerState(): ServerState | null {
  if (!existsSync(serverStatePath)) {
    return null;
  }

  return JSON.parse(readFileSync(serverStatePath, "utf8")) as ServerState;
}

function removeServerState() {
  rmSync(serverStatePath, { force: true });
}

function stopPid(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // The process may already be gone.
  }
}

export async function startE2eDevServer() {
  process.env.PLAYWRIGHT_TEST_BASE_URL = baseUrl;

  if (await isServerAvailable()) {
    throw new Error(`${baseUrl} is already in use; stop the existing server before starting the isolated E2E server`);
  }

  mkdirSync(dirname(serverLogPath), { recursive: true });
  const outFd = openSync(serverLogPath, "a");
  const errFd = openSync(serverLogPath, "a");
  const nextCli = join(rootDir, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", "2501"], {
    cwd: rootDir,
    detached: true,
    env: {
      ...process.env,
      AUTH_URL: baseUrl,
      BROWSER: "none",
      FORCE_COLOR: "1",
    },
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
  });

  closeSync(outFd);
  closeSync(errFd);

  if (!child.pid) {
    throw new Error("Failed to start e2e dev server");
  }

  child.unref();
  writeServerState({ started: true, pid: child.pid });

  try {
    await waitForServer();
  } catch (error) {
    stopPid(child.pid);
    removeServerState();
    throw error;
  }
}

export function stopE2eDevServer() {
  const state = readServerState();
  removeServerState();

  if (!state?.started || !state.pid) {
    return;
  }

  stopPid(state.pid);
}
