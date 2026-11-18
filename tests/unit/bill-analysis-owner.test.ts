import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getBillAnalysisOwner, isBillAnalysisOwnerStopped } from "@/lib/reports/bill-analysis-owner";

describe("analysis execution ownership", () => {
  it("does not confuse a live owner, an unfamiliar runtime or elapsed time with a stopped process", () => {
    const owner = getBillAnalysisOwner();
    expect(getBillAnalysisOwner().id).toBe(owner.id);
    expect(isBillAnalysisOwnerStopped(owner)).toBe(false);
    expect(isBillAnalysisOwnerStopped({ ...owner, runtime: `${owner.runtime}-unknown`, pid: 2_000_000_000 })).toBe(false);
    expect(isBillAnalysisOwnerStopped({ ...owner, startedAt: new Date(0) })).toBe(false);
  });

  it("proves a local child owner stopped only after operating-system exit", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { windowsHide: true });
    await once(child.stdout!, "data");
    const owner = { ...getBillAnalysisOwner(), id: "child-owner", pid: child.pid!, startedAt: new Date() };
    try { expect(isBillAnalysisOwnerStopped(owner)).toBe(false); }
    finally { const stopped = once(child, "close"); child.kill("SIGKILL"); await stopped; }
    expect(isBillAnalysisOwnerStopped(owner)).toBe(true);
  });
});

describe("trusted stopped-runtime cleanup arguments", () => {
  it("requires explicit bounded proof arguments and rejects shell-like or foreign options", async () => {
    const modulePath = new URL("../../ops/reports/reap-bill-analysis.mjs", import.meta.url).href;
    const { parseStoppedRuntimes } = await import(/* @vite-ignore */ modulePath) as { parseStoppedRuntimes: (args: unknown) => string[] };
    expect(parseStoppedRuntimes(["--stopped-runtime", "a1b2c3d4e5f6", "--stopped-runtime", "a1b2c3d4e5f6"])).toEqual(["a1b2c3d4e5f6"]);
    for (const args of [[], ["--stopped-runtime"], ["--runtime", "a1b2c3d4e5f6"], ["--stopped-runtime", "a; stop-service"], ["--stopped-runtime", "../runtime"],
      ["--stopped-runtime", "x".repeat(254)], Array.from({ length: 17 }, () => ["--stopped-runtime", "runtime"]).flat(), null]) {
      expect(() => parseStoppedRuntimes(args)).toThrow();
    }
  });
});

type ScriptReceipt = { reaped?: number; error?: string; logs: string[]; calls: Array<{ args: string[]; quiet: boolean }> };
function startupFixture(scenario: string): ScriptReceipt {
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:BILL_ANALYSIS_SCRIPT_PATH, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'Startup script parse failure' }
    $names = @('Get-BillAnalysisRuntimeCandidates', 'Clear-StoppedBillAnalysisExecutions')
    $functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name }, $true)
    if ($functions.Count -ne 2) { throw 'Missing runtime supervisor functions' }
    foreach ($definition in $functions) { Invoke-Expression $definition.Extent.Text }
    $script:calls = New-Object 'System.Collections.Generic.List[object]'
    $script:logs = New-Object 'System.Collections.Generic.List[string]'
    $script:phase = 'before'
    $script:oldId = 'a' * 64; $script:newId = 'b' * 64
    $envFile = 'private.env'; $composeFile = 'compose.yml'
    function Write-Log { param([string]$Message) [void]$script:logs.Add($Message) }
    function Invoke-Docker {
      param([string[]]$Arguments, [switch]$Quiet, [switch]$AllowFailure)
      [void]$script:calls.Add([PSCustomObject]@{ args = @($Arguments); quiet = [bool]$Quiet })
      $case = $env:BILL_ANALYSIS_SCRIPT_SCENARIO
      if ($Arguments[0] -eq 'compose') {
        if ($Arguments -contains 'run') { return @{ ExitCode = 0; Output = @('Synthetic tools container started', '{"reaped":1}') } }
        if ($Arguments -contains 'ps') {
          if ($script:phase -eq 'before') {
            if ($case -eq 'empty') { return @{ ExitCode = 0; Output = @() } }
            return @{ ExitCode = 0; Output = @($script:oldId) }
          }
          if ($case -eq 'engine-failure') { throw 'Synthetic Docker engine failure' }
          return @{ ExitCode = 0; Output = @(if ($case -eq 'current') { $script:oldId } else { $script:newId }) }
        }
      }
      if ($Arguments[0] -eq 'container' -and $Arguments[1] -eq 'ls') {
        return @{ ExitCode = 0; Output = @(if ($case -ne 'removed') { $script:oldId }) }
      }
      if ($Arguments[0] -eq 'container' -and $Arguments[1] -eq 'stop') {
        if ($case -eq 'stop-failure') { throw 'Synthetic Docker stop failure' }
        return @{ ExitCode = 0; Output = @($script:oldId) }
      }
      if ($Arguments[0] -eq 'container' -and $Arguments[1] -eq 'inspect') {
        if ($Arguments[-1] -match 'State.Running') {
          $running = if ($case -eq 'still-running') { 'true' } else { 'false' }
          return @{ ExitCode = 0; Output = @("$script:oldId aaaaaaaaaaaa $running false") }
        }
        $project = if ($case -eq 'foreign-project' -or ($case -eq 'changed-identity' -and $script:phase -eq 'after')) { 'another-project' } else { 'billboard' }
        $runtime = if ($case -eq 'shared-hostname') { 'shared-runtime' } else { 'aaaaaaaaaaaa' }
        return @{ ExitCode = 0; Output = @("$script:oldId $runtime $project web False") }
      }
      throw 'Unexpected synthetic Docker command'
    }
    try {
      $candidates = @(Get-BillAnalysisRuntimeCandidates)
      $script:phase = 'after'
      $reaped = Clear-StoppedBillAnalysisExecutions -Candidates $candidates
      @{ reaped = $reaped; calls = $script:calls.ToArray(); logs = $script:logs.ToArray() } | ConvertTo-Json -Depth 8 -Compress
    } catch {
      @{ error = $_.Exception.Message; calls = $script:calls.ToArray(); logs = $script:logs.ToArray() } | ConvertTo-Json -Depth 8 -Compress
    }
  `;
  return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
    env: { ...process.env, BILL_ANALYSIS_SCRIPT_PATH: resolve("ops/windows/start-production.ps1"), BILL_ANALYSIS_SCRIPT_SCENARIO: scenario },
  }).trim());
}

describe.runIf(process.platform === "win32")("Windows retired-runtime supervisor", () => {
  it.each(["removed", "stopped"])("reclaims only a captured %s web runtime with quiet non-seed tools execution", (scenario) => {
    const receipt = startupFixture(scenario);
    expect(receipt.error).toBeUndefined();
    expect(receipt.reaped).toBe(1);
    expect(receipt.calls.every(({ quiet }) => quiet)).toBe(true);
    const cleanup = receipt.calls.filter(({ args }) => args.includes("ops/reports/reap-bill-analysis.mjs"));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0].args).toEqual(expect.arrayContaining(["run", "--rm", "--no-deps", "bootstrap", "node", "--import", "tsx", "--stopped-runtime", "aaaaaaaaaaaa"]));
    expect(JSON.stringify(cleanup)).not.toContain("seed");
    expect(JSON.stringify(receipt.logs)).not.toContain("aaaaaaaaaaaa");
    if (scenario === "stopped") {
      const stopIndex = receipt.calls.findIndex(({ args }) => args[0] === "container" && args[1] === "stop");
      const stateIndex = receipt.calls.findIndex(({ args }) => args.some((arg) => arg.includes("State.Running")));
      const reapIndex = receipt.calls.indexOf(cleanup[0]);
      expect(stopIndex).toBeGreaterThan(-1);
      expect(stateIndex).toBeGreaterThan(stopIndex);
      expect(reapIndex).toBeGreaterThan(stateIndex);
    }
  }, 20_000);

  it.each(["current", "empty"])("does not reclaim the %s runtime set", (scenario) => {
    const receipt = startupFixture(scenario);
    expect(receipt.error).toBeUndefined();
    expect(receipt.reaped).toBe(0);
    expect(receipt.calls.some(({ args }) => args.includes("ops/reports/reap-bill-analysis.mjs"))).toBe(false);
    expect(receipt.calls.some(({ args }) => args[1] === "stop")).toBe(false);
  }, 20_000);

  it.each(["foreign-project", "shared-hostname", "changed-identity", "engine-failure", "stop-failure", "still-running"])("retains resources when proof is unavailable: %s", (scenario) => {
    const receipt = startupFixture(scenario);
    expect(receipt.error).toEqual(expect.any(String));
    expect(receipt.calls.some(({ args }) => args.includes("ops/reports/reap-bill-analysis.mjs"))).toBe(false);
  }, 20_000);

  it("captures before replacement and runs cleanup only after verified replacement startup", () => {
    const script = readFileSync("ops/windows/start-production.ps1", "utf8");
    const capture = script.indexOf("$previousWebRuntimes = @(Get-BillAnalysisRuntimeCandidates)");
    const replace = script.indexOf('@("up", "-d", "--no-build", "--wait"');
    const cleanup = script.indexOf("$null = Clear-StoppedBillAnalysisExecutions -Candidates $previousWebRuntimes");
    expect(capture).toBeGreaterThan(-1);
    expect(replace).toBeGreaterThan(capture);
    expect(cleanup).toBeGreaterThan(replace);
  });
});
