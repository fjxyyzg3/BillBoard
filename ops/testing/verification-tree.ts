import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function captureVerificationTree() {
  const scratch = mkdtempSync(join(tmpdir(), "billboard-verification-"));
  const git = (args: string[], env = process.env) => execFileSync("git", args, {
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env,
  }).trim();
  try {
    const objects = git(["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
    const temporaryObjects = join(scratch, "objects");
    mkdirSync(temporaryObjects);
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index"),
      GIT_OBJECT_DIRECTORY: temporaryObjects, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    git(["read-tree", "HEAD"], env);
    const paths = ["."];
    const nextTypes = readFileSync("next-env.d.ts", "utf8").replaceAll("\r\n", "\n").trim();
    const committed = git(["show", "HEAD:next-env.d.ts"]).replaceAll("\r\n", "\n");
    // Playwright's Next dev process changes only the generated route-type import paths.
    if (nextTypes.replaceAll(".next/dev/types/", ".next/types/") === committed) paths.push(":(exclude)next-env.d.ts");
    git(["add", "-A", "--", ...paths], env);
    return git(["write-tree"], env);
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
