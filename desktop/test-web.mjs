import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { PrismaClient } from "@prisma/client";
import { _electron as electron, expect } from "@playwright/test";
import { hash } from "argon2";
import ExcelJS from "exceljs";
import { tsImport } from "tsx/esm/api";
import { createDesktopStaging } from "../ops/desktop/build-exe.mjs";
import { protectDesktopPrivatePath } from "../ops/desktop/build-config.mjs";
import { createDesktopManifest } from "../src/lib/desktop-update-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const checkOnly = process.argv.includes("--check");
if (process.argv.slice(2).some(value => value !== "--check")) throw new Error("Usage: node desktop/test-web.mjs [--check]");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Real web validation requires Windows x64");
const example = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
const databaseUrl = new URL(example.DATABASE_URL);
assert(["127.0.0.1", "localhost"].includes(databaseUrl.hostname) && /(?:dev|test)/i.test(databaseUrl.pathname), "Web validation requires the example local development database");
assert(process.env.NODE_ENV !== "production", "Web validation cannot run in production");
const electronExecutable = require("./node_modules/electron");
assert(existsSync(electronExecutable), "Install the separate desktop dependencies first");
const openssl = "C:/Program Files/Git/usr/bin/openssl.exe";
assert(existsSync(openssl), "Git OpenSSL is required for the isolated HTTPS proxy");

async function waitFor(operation, description, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { const value = await operation(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${description}${last ? `: ${last.message}` : ""}`);
}

function sourceDigest(directory) {
  const files = [];
  function visit(relative = "") {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const filename = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(directory, filename));
      assert(!info.isSymbolicLink(), "Validation source cannot contain symbolic links");
      if (info.isDirectory()) visit(filename);
      else { assert(info.isFile()); files.push(filename); }
    }
  }
  visit();
  const hash = createHash("sha256");
  for (const filename of files.sort()) { hash.update(filename); hash.update(readFileSync(join(directory, filename))); }
  return hash.digest("hex");
}

async function main() {
  if (checkOnly) {
    process.stdout.write("PASS static Windows web-validation wiring; no server or database changes performed\n");
    return;
  }
  process.env.DATABASE_URL = example.DATABASE_URL;
  const { startAgentFixture } = await tsImport("../tests/e2e/agent-fixture.ts", import.meta.url);
  const { resetLoginBudget } = await tsImport("../tests/e2e/db-cleanup.ts", import.meta.url);
  const prisma = new PrismaClient();
  const temporary = join(root, "tmp");
  mkdirSync(temporary, { recursive: true });
  const work = mkdtempSync(join(temporary, "windows-web-validation-"));
  protectDesktopPrivatePath(work, { directory: true });
  const suffix = randomBytes(5).toString("hex");
  const appId = `com.billboard.desktop.validation.web${suffix}`;
  const productName = `BillBoard Web Validation ${suffix}`;
  const password = `synthetic-${randomBytes(20).toString("hex")}`;
  const manualNote = `desktop-web-manual-${suffix}`;
  const evidence = { appId, checks: [], limitations: [
    "The native file chooser result and save destination are selected deterministically by the validation driver; DownloadItem writes and subsequent file readback are real.",
    "This suite does not verify microphone or camera hardware, NSIS installation, or coverage beyond its representative business flows.",
  ] };
  function record(check, detail = {}) {
    evidence.checks.push({ check, ...detail });
    writeFileSync(join(work, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    process.stdout.write(`PASS ${check}\n`);
  }
  let application;
  let activePage;
  let next;
  let stopAgent;
  let proxy;
  let owner;
  let partner;
  let household;
  const releaseFiles = [];
  const sockets = new Set();
  const published = join(root, "tmp/releases/windows/published");
  const latestPath = join(published, "latest.json");
  assert(!existsSync(latestPath), "Retain the existing development release; web validation needs an unused development publication slot");
  const keyPath = join(work, "localhost-key.pem");
  const certificatePath = join(work, "localhost-cert.pem");
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2", "-keyout", keyPath,
    "-out", certificatePath, "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  const certificate = new X509Certificate(readFileSync(certificatePath));
  const spki = createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const signing = generateKeyPairSync("ed25519");
  const installerBytes = Buffer.alloc(512 * 1024, 0x57);
  installerBytes.write("MZ synthetic web validation payload; never execute");
  const release = { schema: 1, productId: "com.billboard.desktop", platform: "win32", arch: "x64", version: "0.0.2", size: installerBytes.length,
    sha256: createHash("sha256").update(installerBytes).digest("hex"), notes: { "zh-CN": "真实网页联调的隔离合成更新。", "en-US": "Isolated update for real web validation." } };
  let dropNextAction = false;
  let droppedActions = 0;
  let actionPosts = 0;
  const naturalText = "老婆付款午饭35元，打车22元";
  let submissionActionId;
  let expectedRecoveryUuid;
  let captureRecovery = false;
  const recoveryRequests = [];
  let origin;
  try {
    // Refuse to attach to another test run or an independently running application.
    const existing = await fetch("http://127.0.0.1:2500/login", { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
    assert(!existing, "The exclusive development-server window is not available");
    proxy = httpsServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (incoming, outgoing) => {
      const nextAction = incoming.method === "POST" && incoming.headers["next-action"];
      if (nextAction) actionPosts += 1;
      const discard = Boolean(nextAction && incoming.url?.startsWith("/add") && dropNextAction);
      if (discard) { dropNextAction = false; submissionActionId = incoming.headers["next-action"]; }
      let recoveryObservation;
      if (nextAction && captureRecovery && expectedRecoveryUuid) {
        const chunks = [];
        let bytes = 0;
        incoming.on("data", chunk => { bytes += chunk.length; if (bytes <= 65536) chunks.push(chunk); });
        incoming.once("end", () => {
          if (bytes > 65536) return;
          const body = Buffer.concat(chunks).toString("utf8");
          if (!body.includes(expectedRecoveryUuid)) return;
          recoveryObservation = { path: new URL(incoming.url, origin).pathname, originalUuid: expectedRecoveryUuid,
            actionId: incoming.headers["next-action"], containsOriginalInput: body.includes(naturalText) };
          recoveryRequests.push(recoveryObservation);
        });
      }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: 2500, method: incoming.method, path: incoming.url,
        headers: { ...incoming.headers, host: new URL(origin).host, "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "https" } }, response => {
        if (recoveryObservation) recoveryObservation.status = response.statusCode;
        if (discard) {
          response.resume();
          response.once("end", () => {
            droppedActions += 1;
            outgoing.writeHead(502, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
            outgoing.end("Synthetic committed response unavailable");
          });
        } else { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); }
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.on("aborted", () => upstream.destroy());
      outgoing.on("close", () => { if (!outgoing.writableEnded) upstream.destroy(); });
      incoming.pipe(upstream);
    });
    proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    proxy.on("clientError", (_error, socket) => socket.destroy());
    proxy.on("upgrade", (request, socket, head) => {
      const upstream = connect(2500, "127.0.0.1", () => {
        const headers = { ...request.headers, host: new URL(origin).host, "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "https" };
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
    });
    await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
    origin = `https://localhost:${proxy.address().port}`;
    const stage = createDesktopStaging({ directory: join(work, "app"), origin,
      publicKey: signing.publicKey.export({ type: "spki", format: "pem" }).toString(), version: "0.0.1", appId, productName });
    evidence.nativeSourceSha256 = sourceDigest(join(stage, "src"));
    evidence.webSourceSha256 = sourceDigest(join(root, "src"));
    assert.equal(sourceDigest(join(root, "desktop/src")), evidence.nativeSourceSha256);
    mkdirSync(published, { recursive: true });
    protectDesktopPrivatePath(published, { directory: true });
    const artifactPath = join(published, `${release.sha256}.exe`);
    const envelopeBytes = Buffer.from(JSON.stringify(createDesktopManifest(release, signing.privateKey)));
    for (const [path, bytes] of [[artifactPath, installerBytes], [latestPath, envelopeBytes]]) {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
      releaseFiles.push({ path, digest: createHash("sha256").update(bytes).digest("hex") });
    }
    stopAgent = await startAgentFixture();
    const serverEnvironment = { ...example, ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:DATABASE_URL|AUTH_|NEXTAUTH_|APP_PUBLIC_ORIGIN|OPS_|IMPORT_AGENT_|SMTP_|DEEPSEEK_|VOLCENGINE_|VOICE_|BILLBOARD_DESKTOP_|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/.test(key))),
    DATABASE_URL: example.DATABASE_URL, AUTH_SECRET: "replace-me", AUTH_URL: origin, APP_PUBLIC_ORIGIN: origin, AUTH_TRUST_HOST: "true",
    IMPORT_AGENT_URL: process.env.IMPORT_AGENT_URL, IMPORT_AGENT_TOKEN: process.env.IMPORT_AGENT_TOKEN,
    NEXT_ALLOWED_DEV_ORIGINS: "localhost", PLAYWRIGHT_TEST_BASE_URL: "http://127.0.0.1:2500", BROWSER: "none" };
    const log = createWriteStream(join(work, "next.log"));
    next = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--port", "2500"],
      { cwd: root, env: serverEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    next.stdout.pipe(log); next.stderr.pipe(log);
    await waitFor(() => fetch("http://127.0.0.1:2500/login", { signal: AbortSignal.timeout(2000) }).then(response => response.status === 200), "Development server did not start", 60000);
    await resetLoginBudget();
    owner = await prisma.user.create({ data: { email: `desktop-web-${suffix}@example.test`, passwordHash: await hash(password),
      emailVerifiedAt: new Date(), displayName: "桌面成员甲", aiProcessingEnabled: true, voiceProcessingEnabled: true } });
    partner = await prisma.user.create({ data: { email: `desktop-partner-${suffix}@example.test`, passwordHash: await hash(password),
      emailVerifiedAt: new Date(), displayName: "桌面成员乙" } });
    household = await prisma.household.create({ data: { name: "Desktop web validation household", members: { create: [
      { userId: owner.id, memberName: "桌面成员甲", role: "OWNER" }, { userId: partner.id, memberName: "桌面成员乙", role: "MEMBER" } ] },
    ledgers: { create: [{ name: "Default", isDefault: true, acceptsLegacyDrafts: true }, { name: "桌面账本", isDefault: false }] } }, include: { members: true, ledgers: true } });
    const actor = household.members.find(member => member.userId === partner.id);
    const creator = household.members.find(member => member.userId === owner.id);
    const target = household.ledgers.find(ledger => !ledger.isDefault);
    const login = async page => {
      await expect(page.getByLabel("邮箱", { exact: true })).toBeVisible();
      await page.getByLabel("邮箱", { exact: true }).fill(owner.email);
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page).toHaveURL(/\/home$/, { timeout: 30000 });
    };
    async function launch() {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|BILLBOARD_DESKTOP_|CSC_|WIN_CSC_)/.test(key)));
      env.NODE_EXTRA_CA_CERTS = certificatePath;
      application = await electron.launch({ executablePath: electronExecutable, args: [stage, `--ignore-certificate-errors-spki-list=${spki}`], env, chromiumSandbox: true, timeout: 45000 });
      await waitFor(() => application.evaluate(({ BrowserWindow, webContents }, trustedOrigin) => BrowserWindow.getAllWindows().length > 0
        && webContents.getAllWebContents().some(contents => contents.getURL().startsWith(`${trustedOrigin}/`)), origin), "The native window did not load the isolated web origin");
      const metadata = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), profile: app.getPath("userData"), version: app.getVersion() }));
      assert.equal(realpathSync(metadata.appPath), realpathSync(stage), "The wrong Electron application was launched");
      assert(metadata.profile.endsWith(appId), "The real application profile was not isolated");
      await application.evaluate(({ BrowserWindow, ipcMain, dialog, webContents }, { origin, work }) => {
        globalThis.webValidation = { commands: [], events: [], dialogs: [], saved: [], permitClose: false };
        ipcMain.on("bb:command", (_event, raw, generation) => {
          try {
            const value = JSON.parse(raw);
            if (["status", "check", "download", "cancel", "prepared", "safety", "install"].includes(value.command)) globalThis.webValidation.commands.push({ command: value.command, generation, loading: _event.sender.isLoadingMainFrame(), ready: value.ready, busy: value.busy, dirty: value.dirty });
            if (globalThis.webValidation.commands.length > 256) globalThis.webValidation.commands.shift();
          } catch { /* Observe only bounded coordination metadata, never business inputs. */ }
        });
        dialog.showMessageBox = async (_window, options) => {
          globalThis.webValidation.dialogs.push({ type: options.type, title: options.title });
          return { response: globalThis.webValidation.permitClose && options.type === "warning" ? 1 : 0, checkboxChecked: false };
        };
        const remote = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(`${origin}/`));
        const send = remote.send.bind(remote);
        remote.send = (channel, ...values) => {
          if (channel === "bb:ready") globalThis.webValidation.events.push({ channel, ...values[0] });
          if (channel === "bb:event") {
            try { const value = JSON.parse(values[0]); globalThis.webValidation.events.push({ channel, type: value.type, status: value.status }); } catch { /* Ignore malformed observations. */ }
          }
          return send(channel, ...values);
        };
        if (remote) remote.session.on("will-download", (_event, item, contents) => {
          if (contents !== remote || !/^[A-Za-z0-9_.-]+$/.test(item.getFilename())) return;
          const path = `${work}/${item.getFilename()}`;
          item.setSavePath(path);
          item.once("done", (_event, state) => globalThis.webValidation.saved.push({ path, state }));
        });
        const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus();
      }, { origin, work });
      const page = await waitFor(() => application.context().pages().find(page => page.url().startsWith(`${origin}/`)), "The real WebContentsView did not become a Playwright page");
      activePage = page;
      page.setDefaultTimeout(20000);
      await page.emulateMedia({ reducedMotion: "reduce" });
      return page;
    }
    async function stopNormally(permitClose = false) {
      const electronProcess = application.process();
      await application.evaluate(({ BrowserWindow }, permit) => { globalThis.webValidation.permitClose = permit; BrowserWindow.getAllWindows()[0].close(); }, permitClose);
      await waitFor(() => electronProcess.exitCode !== null, "The isolated application did not exit normally");
      assert.equal(electronProcess.exitCode, 0);
      application = null;
    }
    async function savedFile(name, trigger) {
      const count = await application.evaluate(() => globalThis.webValidation.saved.length);
      await trigger();
      const saved = await waitFor(async () => (await application.evaluate(() => globalThis.webValidation.saved)).slice(count).find(item => item.path.endsWith(name)), "The real DownloadItem did not save the selected file");
      assert.equal(saved.state, "completed", "The selected file download failed");
      assert(existsSync(saved.path));
      return saved.path;
    }
    async function protectedPendingState(page, uuid) {
      return await page.evaluate(async uuid => {
        const database = await new Promise((resolve, reject) => { const request = indexedDB.open("billboard-household-keys-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          const store = database.transaction("keys").objectStore("keys");
          const keysRequest = store.getAllKeys();
          const valuesRequest = store.getAll();
          const [keys, values] = await Promise.all([keysRequest, valuesRequest].map(request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); })));
          const pending = values.filter((_value, index) => typeof keys[index] === "string" && keys[index].startsWith("state:") && keys[index].includes(":billboard:natural-language-pending:"));
          return { count: pending.length, encrypted: pending.every(value => typeof value === "string" && JSON.parse(value).encrypted === true && !value.includes(uuid)) };
        } finally { database.close(); }
      }, uuid);
    }
    let page = await launch();
    await login(page);
    const sandbox = await page.evaluate(() => ({ node: typeof window.require, process: typeof window.process, bridge: typeof window.BillBoardDesktop?.postMessage }));
    assert.deepEqual(sandbox, { node: "undefined", process: "undefined", bridge: "function" });
    await expect(page.getByRole("button", { name: /客户端更新/ })).toBeVisible();
    record("real authenticated Next.js page in the sandboxed HTTPS WebContentsView");
    const mediaDevices = await page.evaluate(async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return { audioinput: devices.filter(device => device.kind === "audioinput").length,
        audiooutput: devices.filter(device => device.kind === "audiooutput").length, videoinput: devices.filter(device => device.kind === "videoinput").length };
    });
    record("native media device counts without device identifiers; hardware capture not exercised", mediaDevices);
    await page.goto(`${origin}/add?ledger=${target.id}&entryLedger=${target.id}`);
    await page.getByRole("textbox", { name: "金额", exact: true }).fill("12.34");
    await page.getByRole("radio", { name: actor.memberName, exact: true }).check();
    await page.getByRole("button", { name: "添加备注", exact: true }).click();
    await page.getByLabel("备注", { exact: true }).fill(manualNote);
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "金额", exact: true })).toHaveValue("");
    const manual = await prisma.transaction.findFirstOrThrow({ where: { householdId: household.id, note: manualNote, deletedAt: null } });
    assert(manual.clientRequestId && manual.amountFen === 1234 && manual.ledgerId === target.id && manual.actorMemberId === actor.id && manual.createdByMemberId === creator.id);
    await page.goto(`${origin}/records?ledger=all&mode=all`);
    await page.getByRole("link").filter({ hasText: manualNote }).click();
    const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });
    await editor.getByLabel("金额", { exact: true }).fill("15.67");
    await editor.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(editor).toBeHidden();
    const changed = await prisma.transaction.findUniqueOrThrow({ where: { id: manual.id } });
    assert(changed.amountFen === 1567 && changed.clientRequestId === manual.clientRequestId && changed.actorMemberId === actor.id && changed.ledgerId === target.id);
    await page.getByRole("combobox", { name: "查看范围", exact: true }).selectOption(household.ledgers.find(ledger => ledger.isDefault).id);
    await expect(page.getByRole("link").filter({ hasText: manualNote })).toHaveCount(0);
    await page.getByRole("combobox", { name: "查看范围", exact: true }).selectOption("all");
    await expect(page.getByRole("link").filter({ hasText: manualNote })).toBeVisible();
    record("manual entry, household scope and editing retain integer amounts, member, ledger and original UUID");

    const workbook = new ExcelJS.Workbook();
    const headers = ["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户2", "账户币种", "金额", "成员", "商家", "项目分类", "项目", "记账人", "备注"];
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date());
    workbook.addWorksheet("支出").addRows([headers, ["支出", date, "餐饮", "三餐", "现金", "", "CNY", "8.90", actor.memberName, "", "", "", actor.memberName, `desktop-web-import-${suffix}`]]);
    workbook.addWorksheet("收入").addRow(headers);
    const upload = join(work, "synthetic-import.xlsx");
    await workbook.xlsx.writeFile(upload);
    await page.goto(`${origin}/records/import?ledger=${target.id}&entryLedger=${target.id}`);
    await page.getByRole("radio", { name: "随手记", exact: true }).check();
    const chooser = page.waitForEvent("filechooser");
    await page.locator('input[type="file"]:visible').click();
    await (await chooser).setFiles(upload);
    await page.getByRole("button", { name: "上传并解析", exact: true }).click();
    await expect(page).toHaveURL(/\/records\/import\?draft=/);
    const members = page.locator("form", { has: page.getByRole("heading", { name: "成员映射", exact: true }) });
    if (await members.isVisible()) {
      await members.locator("label", { hasText: actor.memberName }).getByRole("combobox").selectOption({ label: actor.memberName });
      await members.getByRole("button", { name: "保存成员映射", exact: true }).click();
    }
    const mappings = page.locator("form", { has: page.getByRole("heading", { name: "分类映射", exact: true }) });
    await mappings.locator("label", { hasText: "支出 · 餐饮 / 三餐" }).getByRole("combobox").selectOption({ label: "餐饮" });
    await mappings.getByRole("button", { name: "保存映射", exact: true }).click();
    await page.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(page.getByRole("heading", { name: "导入已完成", exact: true })).toBeVisible();
    const imported = await prisma.transaction.findFirstOrThrow({ where: { householdId: household.id, source: "sui_shou_ji", deletedAt: null } });
    assert(imported.amountFen === 890 && imported.actorMemberId === actor.id && imported.createdByMemberId === actor.id && imported.ledgerId === target.id && imported.sourceFingerprint && imported.sourceImportedAt);
    record("real native file selection uploads XLSX through the existing authorized import pipeline");
    await page.goto(`${origin}/records?ledger=all&mode=all`);
    await page.getByRole("button", { name: "导出", exact: true }).click();
    const exporting = page.getByRole("dialog", { name: "导出账目", exact: true });
    const exportName = `billboard-records_${await exporting.getByLabel("开始日期", { exact: true }).inputValue()}_${await exporting.getByLabel("结束日期", { exact: true }).inputValue()}.xlsx`;
    const exportedPath = await savedFile(exportName, () => exporting.getByRole("button", { name: "下载 Excel", exact: true }).click());
    const exported = new ExcelJS.Workbook(); await exported.xlsx.readFile(exportedPath);
    assert(exported.worksheets.some(sheet => JSON.stringify(sheet.getSheetValues()).includes(manualNote)), "The real exported workbook is missing the authorized record");
    await exporting.getByRole("button", { name: "取消", exact: true }).click();
    record("real DownloadItem saves Excel to the selected private destination and its bytes read back");

    await page.goto(`${origin}/home`);
    await page.getByRole("button", { name: /客户端更新/ }).click();
    const updating = page.getByRole("dialog", { name: "Windows 客户端更新", exact: true });
    await expect(updating.getByText("0.0.1", { exact: true })).toBeVisible();
    await expect(updating.getByText("0.0.2", { exact: true })).toBeVisible();
    await updating.getByRole("button", { name: "下载更新", exact: true }).click();
    await expect(updating.getByRole("button", { name: "重启并安装", exact: true })).toBeDisabled();
    await waitFor(() => application.evaluate(() => globalThis.webValidation.commands.some(value => value.command === "safety" && value.ready && !value.busy && !value.dirty)), "The real update safety heartbeat did not become ready");
    await updating.getByRole("checkbox").check();
    await updating.getByRole("button", { name: "重启并安装", exact: true }).click();
    await waitFor(() => application.evaluate(() => globalThis.webValidation.commands.some(value => value.command === "prepared" && value.ready && !value.busy && !value.dirty)), "The real page did not accept the native preparation handshake");
    assert.equal(application.process().exitCode, null, "Cancelling native confirmation must retain the running client");
    await page.screenshot({ path: join(work, "real-windows-update.png") });
    await updating.getByRole("button", { name: "关闭", exact: true }).click();
    record("real authenticated update download, installed version and native prepare handshake; installation confirmation cancelled");

    await page.goto(`${origin}/account/household`);
    const settings = page.getByTestId("household-encryption-settings");
    await settings.getByRole("button", { name: "开启加密", exact: true }).click();
    const candidate = settings.getByTestId("encryption-candidate");
    await expect(candidate).toBeVisible();
    const code = await candidate.locator("textarea[readonly]").inputValue();
    const labels = ["保存解锁码副本", "保存恢复文件", "保存临时操作恢复文件"];
    const savedBackups = [];
    for (const label of labels) {
      const count = await application.evaluate(() => globalThis.webValidation.saved.length);
      await candidate.getByRole("button", { name: label, exact: true }).click();
      const saved = await waitFor(async () => (await application.evaluate(() => globalThis.webValidation.saved))[count], "The recovery file did not finish saving");
      assert.equal(saved.state, "completed"); savedBackups.push(saved.path);
    }
    assert.equal(readFileSync(savedBackups[0], "utf8"), code);
    for (let index = 0; index < savedBackups.length; index += 1) await candidate.locator('input[type="file"]').nth(index).setInputFiles(savedBackups[index]);
    await candidate.getByRole("checkbox").check();
    await candidate.getByRole("button", { name: "确认并执行", exact: true }).click();
    await expect(settings.getByText("操作已完成", { exact: true })).toBeVisible({ timeout: 60000 });
    record("family code, ciphertext recovery package and operation file save and verify using their actual native copies");

    await page.goto(`${origin}/add?ledger=${target.id}&entryLedger=${target.id}`);
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    const beforeNatural = await prisma.transaction.count({ where: { householdId: household.id, deletedAt: null } });
    dropNextAction = true;
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill(naturalText);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible({ timeout: 30000 });
    assert.equal(droppedActions, 1, "The fixture did not lose the committed response");
    const pendingUuid = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("billboard:natural-language-pending:v2:"))?.[1]);
    assert(/^[a-f0-9-]{36}$/.test(pendingUuid ?? ""), "The original pending UUID was not retained");
    await waitFor(async () => { const state = await protectedPendingState(page, pendingUuid); return state.count === 1 && state.encrypted; }, "The original pending UUID was not durably stored as protected ciphertext");
    const original = await prisma.naturalLanguageRequest.findFirstOrThrow({ where: { householdId: household.id, clientRequestId: pendingUuid } });
    assert(original.ledgerId === target.id && original.createdByMemberId === creator.id);
    assert.equal(await prisma.transaction.count({ where: { householdId: household.id, deletedAt: null } }), beforeNatural + 2);
    const originalSession = await prisma.appSession.findFirstOrThrow({ where: { userId: owner.id, revokedAt: null } });
    const postsAtClose = actionPosts;
    await stopNormally(true);
    expectedRecoveryUuid = pendingUuid;
    captureRecovery = true;
    page = await launch();
    await expect(page).toHaveURL(/\/home$/, { timeout: 30000 });
    await expect(page.getByRole("heading", { name: "首页", exact: true })).toBeVisible();
    await waitFor(() => application.evaluate(() => globalThis.webValidation.commands.some(value => value.command === "safety" && value.ready && !value.busy)), "The recovered original task did not reach a known terminal state");
    await waitFor(async () => !(await page.evaluate(() => Object.entries(sessionStorage).some(([key, value]) => key.startsWith("billboard:natural-language-pending:") && Boolean(value)))), "The original pending UUID was not reconciled after restart");
    const restoredQuery = await waitFor(() => recoveryRequests.find(request => request.status === 200), "No real Server Action queried the original UUID after restart");
    assert.equal(restoredQuery.originalUuid, pendingUuid);
    assert.equal(restoredQuery.containsOriginalInput, false, "Restart replayed the original submit input");
    assert.notEqual(restoredQuery.actionId, submissionActionId, "Restart replayed the submit action instead of querying its immutable result");
    await waitFor(async () => (await protectedPendingState(page, pendingUuid)).count === 0, "The restored query did not clear the original protected pending state");
    assert(actionPosts > postsAtClose, "Restart did not send an actual Server Action query");
    assert.equal(await prisma.naturalLanguageRequest.count({ where: { householdId: household.id, clientRequestId: pendingUuid } }), 1);
    assert.equal(await prisma.transaction.count({ where: { householdId: household.id, deletedAt: null } }), beforeNatural + 2);
    assert.equal(await prisma.appSession.count({ where: { userId: owner.id } }), 1, "Restart silently created a different app session");
    const restoredSession = await prisma.appSession.findUniqueOrThrow({ where: { id: originalSession.id } });
    assert.equal(restoredSession.expiresAt.getTime(), originalSession.expiresAt.getTime(), "Restart extended the original session");
    await page.goto(`${origin}/records?ledger=all&mode=all`);
    await expect(page.getByRole("link").filter({ hasText: manualNote })).toBeVisible();
    await expect(page.getByRole("link").filter({ hasText: "午饭" })).toContainText("桌面成员乙");
    await expect(page.getByRole("link").filter({ hasText: "打车" })).toContainText("桌面成员甲");
    await page.screenshot({ path: join(work, "real-windows-records.png") });
    const protectedState = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => { const opening = indexedDB.open("billboard-household-keys-v1", 1); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
      const key = await new Promise((resolve, reject) => { const request = database.transaction("keys").objectStore("keys").get("device"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const codes = await new Promise((resolve, reject) => { const request = database.transaction("codes").objectStore("codes").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      database.close();
      return { nonExtractable: key instanceof CryptoKey && !key.extractable, savedEncryptedCode: codes.length === 1 && codes[0].ciphertext instanceof ArrayBuffer };
    });
    assert(protectedState.nonExtractable && protectedState.savedEncryptedCode);
    record("normal restart preserves the original AppSession, protected family material and pending UUID without duplicate transactions", {
      queryOnlyActions: recoveryRequests.filter(request => request.status === 200 && !request.containsOriginalInput && request.actionId !== submissionActionId).length,
      queryPath: restoredQuery.path, originalUuid: pendingUuid, protectedPendingBeforeRestart: 1, protectedPendingAfterRestart: 0 });
    await prisma.appSession.update({ where: { id: originalSession.id }, data: { revokedAt: new Date() } });
    await page.goto(`${origin}/home`);
    await expect(page).toHaveURL(/\/login\?reason=session-expired$/, { timeout: 30000 });
    record("revoked server-side session remains rejected after native persistence");
    await stopNormally(true);
    assert.equal(sourceDigest(join(root, "desktop/src")), evidence.nativeSourceSha256, "Native source changed during real web validation");
    assert.equal(sourceDigest(join(root, "src")), evidence.webSourceSha256, "Web source changed during real web validation");
    record("native and web source digests remain unchanged throughout validation");
  } catch (error) {
    evidence.failure = { name: error.name, message: error.message };
    if (application) evidence.failure.native = await application.evaluate(() => globalThis.webValidation).catch(() => undefined);
    if (activePage && !activePage.isClosed()) {
      evidence.failure.page = await activePage.evaluate(() => ({ url: location.pathname, bridge: typeof window.BillBoardDesktop?.postMessage,
        buttons: [...document.querySelectorAll("button")].map(button => button.textContent?.trim()).slice(0, 60) })).catch(() => undefined);
      await activePage.screenshot({ path: join(work, "failure.png") }).catch(() => {});
    }
    writeFileSync(join(work, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    throw error;
  } finally {
    if (application) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await application.close().catch(() => {});
    }
    if (next?.pid && next.exitCode === null) {
      try { execFileSync("taskkill.exe", ["/pid", String(next.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); }
      catch { next.kill(); }
    }
    if (stopAgent) await stopAgent();
    sockets.forEach(socket => socket.destroy());
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    for (const file of releaseFiles.reverse()) {
      if (existsSync(file.path) && createHash("sha256").update(readFileSync(file.path)).digest("hex") === file.digest) unlinkSync(file.path);
    }
    if (household) {
      await prisma.$transaction([
        prisma.appEvent.deleteMany({ where: { OR: [{ householdId: household.id }, { memberId: { in: household.members.map(member => member.id) } }] } }),
        prisma.identityAuditLog.deleteMany({ where: { OR: [{ householdId: household.id }, { actorUserId: { in: [owner.id, partner.id] } }] } }),
        prisma.appSession.deleteMany({ where: { userId: { in: [owner.id, partner.id] } } }),
        prisma.importDraftRow.deleteMany({ where: { draft: { householdId: household.id } } }), prisma.importDraft.deleteMany({ where: { householdId: household.id } }),
        prisma.transaction.deleteMany({ where: { householdId: household.id } }), prisma.naturalLanguageRequest.deleteMany({ where: { householdId: household.id } }),
        prisma.importCategoryMapping.deleteMany({ where: { householdId: household.id } }), prisma.importMemberMapping.deleteMany({ where: { householdId: household.id } }),
        prisma.resourceLease.deleteMany({ where: { householdId: household.id } }), prisma.voiceProcessingAdmission.deleteMany({ where: { householdId: household.id } }),
        prisma.ledgerAuditLog.deleteMany({ where: { householdId: household.id } }), prisma.encryptionOperation.deleteMany({ where: { householdId: household.id } }),
        prisma.householdEncryption.deleteMany({ where: { householdId: household.id } }), prisma.ledger.deleteMany({ where: { householdId: household.id } }),
        prisma.householdMember.deleteMany({ where: { householdId: household.id } }), prisma.household.delete({ where: { id: household.id } }),
      ]);
    }
    const userIds = [owner?.id, partner?.id].filter(Boolean);
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    process.stdout.write(`Private web validation evidence: ${work}\n`);
  }
}

await main();
