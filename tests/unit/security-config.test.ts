import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { configSchema } from "next/dist/server/config-schema";
import { logRequests } from "next/dist/server/dev/log-requests";
import { describe, expect, test, vi } from "vitest";
import getNextConfig from "../../next.config";

const repoRoot = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("locks Next.js to a stable version with the root-parameter cache fixes", () => {
  const packageLock = JSON.parse(readRepoFile("package-lock.json"));
  const lockedVersion: string = packageLock.packages["node_modules/next"].version;
  const installedVersion: string = JSON.parse(readRepoFile("node_modules/next/package.json")).version;

  expect(installedVersion).toBe(lockedVersion);
  expect(lockedVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(lockedVersion.localeCompare("16.4.5", "en", { numeric: true })).toBeGreaterThanOrEqual(0);
});

test.each(["package-lock.json", "desktop/package-lock.json"])(
  "%s uses the reviewed picomatch fix for GHSA-fc5q-39xc-vjpf across the dev toolchain",
  (lockPath) => {
    const lock = JSON.parse(readRepoFile(lockPath)) as {
      packages: Record<string, { name?: string; version?: string; dev?: boolean }>;
    };
    const matchers = Object.entries(lock.packages).filter(
      ([path, entry]) => path.endsWith("/picomatch") || entry.name === "picomatch",
    );

    expect(matchers.length).toBeGreaterThan(0);
    for (const [path, entry] of matchers) {
      expect(entry, path).toMatchObject({ name: "@ryotsu/picomatch", version: "4.0.7-a", dev: true });
    }
  },
);

describe("local ops admin config", () => {
  test("package metadata exposes a loopback-only ops start script", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
      version: string;
    };
    const packageLock = JSON.parse(readRepoFile("package-lock.json")) as {
      packages: Record<string, { version?: string }>;
      version: string;
    };

    expect(packageJson.version).toBe(packageLock.version);
    expect(packageJson.scripts.ops).toBe("next start --hostname 127.0.0.1 --port 32768");
    expect(packageLock.packages[""]?.version).toBe(packageJson.version);
  });

  test("production compose does not publish the ops admin port", () => {
    const compose = readRepoFile("compose.yml");

    expect(compose).not.toContain("32768:32768");
    expect(compose).not.toContain("0.0.0.0:32768");
  });

  test("nginx sample does not explicitly proxy the ops admin route or port", () => {
    const nginx = readRepoFile("ops/nginx/billboard-location.conf");

    expect(nginx).not.toContain("/ops");
    expect(nginx).not.toContain("32768");
  });

  test("README documents loopback-only ops admin startup with placeholders", () => {
    const readme = readRepoFile("README.md");

    expect(readme).toContain("## Local Ops Admin");
    expect(readme).toContain("http://127.0.0.1:32768/ops");
    expect(readme).toContain(
      '$env:OPS_ADMIN_PASSWORD_HASH_BASE64 = "<base64-argon2-hash>"',
    );
    expect(readme).toContain('$env:DATABASE_URL = "<private-database-url>"');
    expect(readme).toContain('$env:AUTH_SECRET = "<private-auth-secret>"');
    expect(readme).toContain('"<private-admin-password>"');
    expect(readme).toContain("Do not publish `32768` through nginx, compose ports, frp, or any public tunnel.");
  });
});

describe("production network security config", () => {
  test("enforces MIME types and same-origin referrers while retaining stricter account rules", async () => {
    const config = await getNextConfig(PHASE_DEVELOPMENT_SERVER);
    const rules = await config.headers!();
    const globalIndex = rules.findIndex((rule) => rule.source === "/:path*");
    expect(rules[globalIndex]?.headers).toEqual(expect.arrayContaining([
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Strict-Transport-Security", value: "max-age=31536000" },
    ]));
    const csp = rules[globalIndex]?.headers.find((header) => header.key === "Content-Security-Policy")?.value;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(rules[globalIndex]?.headers.some((header) => header.key.toLowerCase() === "content-type")).toBe(false);
    for (const source of [
      "/account-link", "/forgot-password", "/account/:path*",
      "/api/voice/audio", "/api/records/export", "/api/household/view", "/api/household/encryption",
      "/api/downloads/:path*", "/api/android/update/:path*", "/api/windows/update/:path*",
      "/api/ios/update", "/api/ios/install/:path*",
    ]) {
      const index = rules.findIndex((rule) => rule.source === source);
      expect(index).toBeGreaterThan(globalIndex);
      expect(rules[index]?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
    }
  });

  test("keeps both framework upload boundaries above the statement limit without making them unbounded", async () => {
    const config = await getNextConfig(PHASE_DEVELOPMENT_SERVER);
    expect(configSchema.safeParse(config).success).toBe(true);
    expect(config.experimental?.serverActions?.bodySizeLimit).toBe("25mb");
    expect(config.experimental?.proxyClientMaxBodySize).toBe("25mb");
    expect(readRepoFile("src/lib/imports/limits.ts")).toContain("20 * 1024 * 1024");
  });

  test("allows same-origin key scanning and voice capture while denying unrelated device capabilities", async () => {
    const config = await getNextConfig(PHASE_DEVELOPMENT_SERVER);
    const rules = await config.headers!();
    const policy = rules.find((rule) => rule.source === "/:path*")?.headers.find((header) => header.key.toLowerCase() === "permissions-policy")?.value;
    expect(policy).toContain("camera=(self)");
    expect(policy).toContain("microphone=(self)");
    for (const capability of ["geolocation", "payment", "usb"]) expect(policy).toContain(`${capability}=()`);
    expect(policy).not.toContain("*");
  });

  test("container build context excludes private env files", () => {
    const containerIgnore = readRepoFile(".dockerignore");

    expect(containerIgnore).toMatch(/^\.env$/m);
    expect(containerIgnore).toMatch(/^\.env\.\*$/m);
    expect(containerIgnore).toMatch(/^\*\*\/\.env\.\*$/m);
    expect(containerIgnore).toMatch(/^\*\*\/\*\.dump$/m);
  });

  test("container build context excludes local-only working directories", () => {
    const containerIgnore = readRepoFile(".dockerignore");

    expect(containerIgnore).toMatch(/^\.worktrees$/m);
    expect(containerIgnore).toMatch(/^\.superpowers$/m);
    expect(containerIgnore).toMatch(/^tmp$/m);
  });

  test("production compose publishes web port 3000 on loopback only for local forwarding", () => {
    const compose = readRepoFile("compose.yml");

    expect(compose).toContain('"127.0.0.1:${APP_PORT:-3000}:3000"');
    expect(compose).not.toContain("3000:3000");
    expect(compose).not.toContain('"80:80"');
    expect(compose).not.toContain('"443:443"');
    expect(compose).not.toContain("caddy:");
  });

  test("development compose publishes PostgreSQL on loopback only", () => {
    const compose = readRepoFile("compose.dev.yml");

    expect(compose).toContain('"127.0.0.1:${POSTGRES_PORT:-5432}:5432"');
    expect(compose).not.toContain('"${POSTGRES_PORT:-5432}:5432"');
  });

  test("voice credentials and public origin are runtime-only and scoped to the web service", () => {
    const compose = readRepoFile("compose.yml").replaceAll("\r\n", "\n");
    const web = compose.split("  web:\n")[1]?.split("  import-agent:")[0];
    const script = readRepoFile("ops/windows/start-production.ps1");
    const containerfile = readRepoFile("Containerfile");

    for (const name of ["VOLCENGINE_ASR_API_KEY", "VOICE_AUDIO_PUBLIC_ORIGIN"]) {
      expect(web).toContain(`${name}: \${${name}:-}`);
      expect(compose.match(new RegExp(`^\\s+${name}:`, "gm"))).toHaveLength(1);
      expect(web?.split("    environment:")[0]).not.toContain(name);
      expect(containerfile).not.toContain(name);
      expect(readRepoFile(".env.example")).toMatch(new RegExp(`^${name}=\\r?$`, "m"));
      expect(script).not.toContain(`"-e", "${name}"`);
      expect(script.split("function Set-LogRedactions")[1]?.split("function Assert-RequiredProductionSecret")[0])
        .toContain(`"${name}"`);
    }
  });

  test("voice temporary storage is bounded and isolated to web memory", () => {
    const compose = readRepoFile("compose.yml").replaceAll("\r\n", "\n");
    const web = compose.split("  web:\n")[1]?.split("  import-agent:")[0];

    expect(web).toContain("tmpfs:\n      - /tmp/billboard-voice:rw,nosuid,nodev,noexec,size=40m,mode=0700");
    expect(compose.match(/\/tmp\/billboard-voice/g)).toHaveLength(1);
  });

  test("web only mounts immutable private client releases read-only, without voice storage or signing material", () => {
    const compose = readRepoFile("compose.yml").replaceAll("\r\n", "\n");
    const web = compose.split("  web:\n")[1]?.split("  import-agent:")[0];
    if (!web) throw new Error("Expected the production web service");

    expect(web.match(/^ {4}volumes:/gm)).toHaveLength(1);
    const mounts = web.match(/^ {4}volumes:\n((?: {6,}\S.*\n)+)/m)?.[1];
    expect(mounts?.trim().split("\n").map((line) => line.trim())).toEqual([
      "- type: bind",
      "source: ./tmp/releases/android/published",
      "target: /var/lib/billboard/android-updates",
      "read_only: true",
      "- type: bind",
      "source: ./tmp/releases/windows/published",
      "target: /var/lib/billboard/windows-updates",
      "read_only: true",
      "- type: bind",
      "source: ./tmp/releases/ios/published",
      "target: /var/lib/billboard/ios-updates",
      "read_only: true",
    ]);
    expect(web).not.toMatch(/^ {4}volumes_from:/m);
    expect(mounts).not.toMatch(/voice|\.env|keystore|\.jks|\.p12|signing|mobileprovision|identity\.txt/i);
    const ignored = readRepoFile(".dockerignore");
    expect(ignored).toMatch(/^desktop$/m);
    expect(ignored).toMatch(/^ops\/desktop\/\*$/m);
    expect(ignored).toMatch(/^!ops\/desktop\/\*\.d\.mts$/m);
    expect(ignored).toMatch(/^ios$/m);
    expect(ignored).toMatch(/^ops\/ios\/\*$/m);
  });

  test("Next development logs omit audio capabilities while retaining other request logs", async () => {
    const config = await getNextConfig(PHASE_DEVELOPMENT_SERVER);
    expect(configSchema.safeParse(config).success).toBe(true);
    const logging = config.logging;
    if (!logging) throw new Error("Expected selective development logging");
    expect(logging.serverFunctions).toBe(false);

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = (url: string, method: string, statusCode: number) => logRequests(
      { url, method } as Parameters<typeof logRequests>[0],
      { statusCode } as Parameters<typeof logRequests>[1],
      logging, 0n, 1_000_000n, undefined, undefined, undefined, undefined,
    );
    try {
      for (const method of ["GET", "HEAD"]) {
        for (const statusCode of [200, 404, 500]) {
          log("/api/voice/audio?token=synthetic-capability", method, statusCode);
          log("/api/voice/audio/?token=synthetic-capability", method, statusCode);
        }
      }
      log("/api/voice/audio", "HEAD", 404);
      expect(write).not.toHaveBeenCalled();

      log("/api/voice/transcribe", "POST", 200);
      log("/login", "GET", 200);
      log("/api/voice/audio-other", "GET", 404);
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(output).toContain("/api/voice/transcribe");
      expect(output).toContain("/login");
      expect(output).toContain("/api/voice/audio-other");
      expect(output).not.toContain("synthetic-capability");
    } finally {
      write.mockRestore();
    }
  });

  test("Windows startup uses Docker Desktop without Podman SSH tunnels", () => {
    const script = readRepoFile("ops/windows/start-production.ps1");

    expect(script).toContain('"--context", "desktop-linux"');
    expect(script).toContain('"compose.yml"');
    expect(script).not.toContain("podman");
    expect(script).not.toContain("ssh.exe");
  });

  test("Windows startup runs ops admin in the production network on loopback only", () => {
    const script = readRepoFile("ops/windows/start-production.ps1");

    expect(script).toContain('$opsContainerName = "billboard-ops"');
    expect(script).toContain('"OPS_ADMIN_INSTANCE=true"');
    expect(script).toContain('"--network", "billboard_default"');
    expect(script).toContain('"-e", "DATABASE_URL"');
    expect(script).toContain('"127.0.0.1:32768:3000"');
    expect(script).not.toContain('"0.0.0.0:32768:3000"');
  });

  test("production startup rejects placeholder database password", () => {
    const script = readRepoFile("ops/windows/start-production.ps1");
    const containerfile = readRepoFile("Containerfile");

    expect(script).toContain('Assert-RequiredProductionSecret -Name "POSTGRES_PASSWORD"');
    expect(script).toContain('-DefaultValue "billboard"');
    expect(script).toContain("Set-LogRedactions -EnvValues $envValues");
    expect(script).not.toContain('"AUTH_SECRET=$');
    expect(script).not.toContain('"POSTGRES_PASSWORD=$');
    expect(containerfile).toContain("POSTGRES_PASSWORD must be set to a non-placeholder value");
  });

  test("Windows production startup applies pending Prisma migrations before starting web", () => {
    const script = readRepoFile("ops/windows/start-production.ps1");
    const migrationIndex = script.indexOf('"npx", "prisma", "migrate", "deploy"');
    const webStartupIndex = script.indexOf(
      '@("up", "-d", "--no-build", "--wait"',
    );

    expect(migrationIndex).toBeGreaterThan(-1);
    expect(webStartupIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeLessThan(webStartupIndex);
    expect(script).not.toContain("prisma/seed.ts");
  });

  test("tracked nginx sample routes the BillBoard hostname root to loopback 3000", () => {
    const nginx = readRepoFile("ops/nginx/billboard-location.conf");

    expect(nginx).toContain("location / {");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:3000");
    expect(nginx).toContain("Strict-Transport-Security");
    expect(nginx).toContain("X-Content-Type-Options");
    expect(nginx).toContain("Referrer-Policy");
    expect(nginx).toContain("Permissions-Policy");
    expect(nginx).toContain('"camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"');
    expect(nginx).toContain("X-Frame-Options");
    expect(nginx).not.toContain("28800");

    const uploadLimitMiB = Number(nginx.match(/client_max_body_size\s+(\d+)m;/)?.[1]);
    expect(uploadLimitMiB).toBeGreaterThan(20);
  });

  test("nginx audio capability requests suppress logs without losing proxy or security headers", () => {
    const nginx = readRepoFile("ops/nginx/billboard-location.conf");
    const audio = nginx.match(/location = \/api\/voice\/audio \{([^}]+)\}/)?.[1];
    const trailingSlash = nginx.match(/location = \/api\/voice\/audio\/ \{([^}]+)\}/)?.[1];
    const root = nginx.match(/location \/ \{([^}]+)\}/)?.[1];
    expect(audio).toBeDefined();
    expect(trailingSlash).toBeDefined();
    expect(root).toBeDefined();
    for (const block of [audio, trailingSlash]) {
      expect(block).toContain("access_log off;");
      expect(block).toContain("error_log /dev/null crit;");
      expect(block).toContain('add_header Referrer-Policy "no-referrer" always;');
    }
    expect(trailingSlash).toContain("return 404;");
    expect(trailingSlash).not.toContain("proxy_pass");
    expect(root).toContain('add_header Referrer-Policy "same-origin" always;');
    expect(root).not.toContain("access_log off;");
    expect(root).not.toContain("error_log /dev/null crit;");

    const preservedDirectives = (block: string) => block.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(add_header|proxy_http_version|proxy_set_header|proxy_pass) /.test(line));
    expect(preservedDirectives(audio ?? "")).toEqual(preservedDirectives(root ?? "").map((line) =>
      line.startsWith("add_header Referrer-Policy ") ? line.replace('"same-origin"', '"no-referrer"')
        : line.startsWith("add_header Permissions-Policy ") ? line.replace("camera=(self)", "camera=()") : line));
    expect(preservedDirectives(audio ?? "")).toHaveLength(13);
    expect(preservedDirectives(trailingSlash ?? "")).toEqual(preservedDirectives(audio ?? "").filter((line) =>
      line.startsWith("add_header ")));
  });

  test("tracked frpc sample exposes BillBoard to the domain forwarding service through remote port 3000 only", () => {
    const frpc = readRepoFile("ops/frp/frpc.billboard.toml.example");

    expect(frpc).toContain('serverAddr = "<frps-server-address>"');
    expect(frpc).toContain('auth.token = "<private-frp-token>"');
    expect(frpc).toContain('name = "billboard-web"');
    expect(frpc).toContain('localIP = "127.0.0.1"');
    expect(frpc).toContain("localPort = 3000");
    expect(frpc).toContain("remotePort = 3000");
    expect(frpc).toContain('healthCheck.path = "/login"');
    expect(frpc).not.toContain("28800");
  });

  test("production docs describe the actual domain forwarding and frpc root entrypoint", () => {
    const readme = readRepoFile("README.md");
    const runbook = readRepoFile("docs/runbooks/home-network-checklist.md");

    const ingress = "HTTPS 域名转发服务 -> frps remote 3000 -> frpc -> 本地 127.0.0.1:3000 -> web:3000";
    expect(readme).toContain(ingress);
    expect(readme).toContain("$env:APP_BASE_PATH = \"/\"");
    expect(runbook).toContain(ingress);
    expect(readme).toMatch(/远端 `3000` 的访问限制须按转发服务的实际\s*来源核验并最小化/);
    expect(runbook).toContain("按转发服务真实来源核验并最小化远端 `3000` 的防火墙／访问范围");
    for (const document of [readme, runbook]) {
      expect(document).toContain("远端未部署 nginx");
      expect(document).toContain("可选");
    }
  });
});
