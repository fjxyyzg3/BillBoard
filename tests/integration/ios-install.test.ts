import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { POST } from "@/app/api/ios/install/route";
import { GET } from "@/app/api/ios/install/[resource]/[ticket]/route";
import { GET as getUpdate, POST as postUpdate } from "@/app/api/ios/update/route";
import { getIosInstallOffer } from "@/lib/ios-install";
import { iosBuildNumber, IOS_INSTALL_TTL_MS } from "@/lib/ios-release-manifest.mjs";

const { session } = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: session }));

const origin = "https://billboard.example";
let repository: string;
let directory: string;
let appSessionId: string;
let identity: { appSessionId: string; id: string; memberId: string; householdId: string };

async function publish(bytes: Buffer, runNumber: number) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const release = {
    schema: 1, version: "1.68.0", build: iosBuildNumber(runNumber, 1),
    bundleId: "com.example.billboard", teamId: "TESTTEAM01", sourceCommit: "a".repeat(40),
    runId: runNumber + 100, runNumber, attempt: 1, sha256, size: bytes.length, validUntil: Date.now() + 3600_000,
  };
  await writeFile(join(directory, `${sha256}.ipa`), bytes);
  await writeFile(join(directory, `${sha256}.json`), JSON.stringify(release));
  await writeFile(join(directory, "latest.json"), JSON.stringify(release));
  return release;
}

async function grant(requestOrigin = origin) {
  return POST(new Request(origin + "/api/ios/install", { method: "POST", headers: { Origin: requestOrigin } }));
}

function checkUpdate(headers?: HeadersInit) {
  return getUpdate(new Request(origin + "/api/ios/update", { headers }));
}

function grantUpdate(currentBuild: string, targetBuild: string, requestOrigin = origin) {
  return postUpdate(new Request(origin + "/api/ios/update", {
    method: "POST",
    headers: { Origin: requestOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ currentBuild, targetBuild }),
  }));
}

async function resource(url: URL, options?: RequestInit, override?: string) {
  const [resource, ticket] = url.pathname.split("/").slice(-2);
  return GET(new Request(url, options), { params: Promise.resolve({ resource: override ?? resource, ticket }) });
}

async function manifestUrl() {
  const response = await grant();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const result = await response.json() as { url: string };
  const installation = new URL(result.url);
  expect(installation.protocol).toBe("itms-services:");
  return new URL(installation.searchParams.get("url")!);
}

async function packageUrl(url: URL) {
  const response = await resource(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/xml");
  return new URL(/<key>url<\/key><string>(.*?)<\/string>/.exec(await response.text())![1]);
}

beforeEach(async () => {
  const owner = await db.householdMember.findFirstOrThrow({
    where: { leftAt: null, user: { email: process.env.SEED_USER_A_EMAIL ?? "user-a@example.com" } },
  });
  const original = await db.appSession.create({
    data: { userId: owner.userId, memberId: owner.id, expiresAt: new Date(Date.now() + 3600_000), sessionKey: randomUUID() },
  });
  appSessionId = original.id;
  identity = { appSessionId, id: owner.userId, memberId: owner.id, householdId: owner.householdId };
  session.mockResolvedValue(identity);
  repository = await mkdtemp(join(tmpdir(), "billboard-ios-install-"));
  directory = join(repository, "tmp", "releases", "ios", "published");
  await mkdir(directory, { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(repository);
  vi.stubEnv("APP_BASE_PATH", "");
  vi.stubEnv("APP_PUBLIC_ORIGIN", origin);
  vi.stubEnv("IOS_INSTALL_HOUSEHOLD_ID", owner.householdId);
  vi.stubEnv("AUTH_SECRET", "synthetic-integration-test-secret");
  vi.stubEnv("OPS_ADMIN_INSTANCE", "false");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  session.mockReset();
  await db.appSession.deleteMany({ where: { id: appSessionId } });
  await rm(repository, { recursive: true, force: true });
});

it("issues a grant only to the configured household from the trusted origin", async () => {
  const release = await publish(Buffer.from("approved package"), 10);
  expect(await getIosInstallOffer()).toEqual({ status: "available", version: release.version, build: release.build });
  expect((await grant("https://another.example")).status).toBe(404);
  session.mockRejectedValueOnce(new Error("No cookie"));
  expect((await grant()).status).toBe(404);
  session.mockResolvedValueOnce({ ...identity, householdId: "other-household" });
  expect((await grant()).status).toBe(404);
  vi.stubEnv("OPS_ADMIN_INSTANCE", "true");
  expect((await grant()).status).toBe(404);
});

it("keeps available update metadata private and rechecks the original session", async () => {
  expect((await checkUpdate()).status).toBe(404);
  const release = await publish(Buffer.from("approved update"), 11);
  const response = await checkUpdate();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ version: release.version, build: release.build });
  expect((await checkUpdate({ "Sec-Fetch-Site": "cross-site" })).status).toBe(404);
  expect((await grantUpdate("1.9.99", release.build, "https://another.example")).status).toBe(404);

  session.mockRejectedValueOnce(new Error("No cookie"));
  expect((await checkUpdate()).status).toBe(401);
  session.mockRejectedValueOnce(new Error("No cookie"));
  expect((await grantUpdate("1.9.99", release.build)).status).toBe(401);
  session.mockResolvedValue({ ...identity, householdId: "other-household" });
  expect((await checkUpdate()).status).toBe(404);
  expect((await grantUpdate("1.9.99", release.build)).status).toBe(404);

  session.mockResolvedValue(identity);
  await db.appSession.update({ where: { id: appSessionId }, data: { revokedAt: new Date() } });
  expect((await checkUpdate()).status).toBe(401);
  expect((await grantUpdate("1.9.99", release.build)).status).toBe(401);
});

it("grants only the displayed newer build and keeps its package immutable after publication changes", async () => {
  const earlier = await publish(Buffer.from("previous update"), 10);
  expect(await (await checkUpdate()).json()).toEqual({ version: earlier.version, build: earlier.build });
  const bytes = Buffer.from("target update");
  const newer = await publish(bytes, 11);

  expect((await grantUpdate("1.8.1", earlier.build)).status).toBe(409);
  expect((await grantUpdate(newer.build, newer.build)).status).toBe(409);
  expect((await grantUpdate("2.0.1", newer.build)).status).toBe(409);
  expect((await grantUpdate("1.09.1", newer.build)).status).toBe(400);
  expect((await grantUpdate("9".repeat(1024), newer.build)).status).toBe(400);

  const response = await grantUpdate("1.9.99", newer.build);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const link = await response.json() as { url: string; build: string; expiresAt: number };
  expect(link.build).toBe("1.10.1");
  expect(link.expiresAt).toBeGreaterThan(Date.now());
  const manifest = new URL(new URL(link.url).searchParams.get("url")!);
  await publish(Buffer.from("later update"), 12);
  const ipa = await resource(await packageUrl(manifest));
  expect(Buffer.from(await ipa.arrayBuffer())).toEqual(bytes);
});

it("serves the originally authorized immutable package without Safari cookies", async () => {
  const bytes = Buffer.from("first valid release");
  await publish(bytes, 10);
  const link = await manifestUrl();
  await publish(Buffer.from("a newer release"), 11);
  const url = await packageUrl(link);
  const head = await resource(url, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(bytes.length));
  expect(await head.text()).toBe("");
  const range = await resource(url, { headers: { Range: "bytes=4-8" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe(`bytes 4-8/${bytes.length}`);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(4, 9));
  const full = await resource(url);
  expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
  expect((await resource(url, { headers: { Range: "bytes=1000-" } })).status).toBe(416);
});

it("rejects expired, altered and cross-purpose credentials, including after session revocation", async () => {
  await publish(Buffer.from("approved package"), 10);
  const manifest = await manifestUrl();
  const ipa = await packageUrl(manifest);
  expect((await resource(ipa, undefined, "manifest")).status).toBe(404);
  expect((await resource(manifest, undefined, "package")).status).toBe(404);
  const altered = new URL(manifest);
  altered.pathname += "x";
  expect((await resource(altered)).status).toBe(404);
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + IOS_INSTALL_TTL_MS + 1000);
  expect((await resource(ipa)).status).toBe(404);
  clock.mockRestore();
  await db.appSession.update({ where: { id: appSessionId }, data: { revokedAt: new Date() } });
  expect((await resource(manifest)).status).toBe(404);
  expect((await resource(ipa)).status).toBe(404);
});
