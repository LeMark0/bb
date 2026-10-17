import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ALLOWLIST,
  LIMITS,
  applyAdditions,
  classifyAllowlist,
  classifyOutcome,
  createBudget,
  namesDiff,
  prepare,
  runPlan,
  runProbe,
  scan,
  sha256File,
  startOwnedChild,
} from "./env-probe-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SLOW = 20_000;
const FAST = 400;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fakePlan(removed, restoring) {
  const calls = [];
  const skips = [];
  let clock = 0;
  const budget = createBudget({
    maxInvocations: LIMITS.maxInvocations,
    deadlineAt: LIMITS.deadlineMs,
    invocationReserveMs: LIMITS.invocationReserveMs,
    cleanupReserveMs: LIMITS.cleanupReserveMs,
    now: () => clock,
  });
  const measure = async (caseId, additions, index) => {
    const durationMs = restoring(additions) ? FAST : SLOW;
    clock += durationMs;
    calls.push(caseId);
    return { index, caseId, additions, durationMs, outcome: "verified" };
  };
  const skip = (caseId, additions, reason) => skips.push({ caseId, reason });
  return { calls, skips, run: () => runPlan({ removed, measure, budget, skip }) };
}

test("names and the allowlist compare case-insensitively and report case duplicates", () => {
  const parent = ["Path", "PATH", "SystemRoot", "PSModulePath", "LocalAppData", "USERNAME", "TEMP"];
  const task = ["PATH", "SYSTEMROOT", "TEMP", "TURBO_HASH"];
  const diff = namesDiff(parent, task);
  assert.deepEqual(diff.removed, ["LocalAppData", "PSModulePath", "USERNAME"]);
  assert.deepEqual(diff.added, ["TURBO_HASH"]);
  assert.deepEqual(diff.caseDuplicates.parent, [["PATH", "Path"]]);
  const allowlist = classifyAllowlist(parent, task);
  assert.deepEqual(allowlist.removed, ["PSModulePath", "LOCALAPPDATA", "USERNAME"]);
  assert.deepEqual(allowlist.retained, []);
  assert.equal(allowlist.missing.length, ALLOWLIST.length - 3);
});

test("additions skip names already present in any case and restore exactly", () => {
  const env = { Path: "p", localappdata: "existing" };
  const before = { ...env };
  const change = applyAdditions(env, ["LOCALAPPDATA", "PSModulePath", "COMPUTERNAME"], {
    LOCALAPPDATA: "captured",
    PSModulePath: "modules",
  });
  assert.deepEqual(change.applied, ["PSModulePath"]);
  assert.deepEqual(change.skipped, [
    { name: "LOCALAPPDATA", reason: "already-present" },
    { name: "COMPUTERNAME", reason: "no-captured-value" },
  ]);
  assert.equal(env.PSModulePath, "modules");
  change.restore();
  assert.deepEqual(env, before);
});

test("the budget refuses a nineteenth invocation and any start that could cross the deadline", () => {
  let clock = 0;
  const budget = createBudget({
    maxInvocations: 18,
    deadlineAt: 480_000,
    invocationReserveMs: 31_000,
    cleanupReserveMs: 15_000,
    now: () => clock,
  });
  for (let i = 0; i < 18; i += 1) {
    assert.equal(budget.check(), null);
    budget.take();
  }
  assert.equal(budget.check(), "max-invocations");
  const late = createBudget({ maxInvocations: 18, deadlineAt: 480_000, invocationReserveMs: 31_000, cleanupReserveMs: 15_000, now: () => clock });
  clock = 434_001;
  assert.equal(late.check(), "deadline");
});

test("outcomes separate verified, invalid identity, timeout and process failure", () => {
  const base = { token: "tok", spawnedAtMs: 1_000_000 };
  assert.equal(classifyOutcome({ ...base, identity: { command: "node x tok", startedAt: 1_000_050 }, durationMs: 400 }).outcome, "verified");
  assert.equal(classifyOutcome({ ...base, identity: { command: "node x other", startedAt: 1_000_050 }, durationMs: 400 }).outcome, "invalid-identity");
  assert.equal(classifyOutcome({ ...base, identity: { command: "node x tok", startedAt: 1_000_000 + 61_000 }, durationMs: 400 }).outcome, "invalid-identity");
  assert.equal(classifyOutcome({ ...base, identity: null, durationMs: 30_012 }).outcome, "timeout");
  assert.equal(classifyOutcome({ ...base, identity: null, durationMs: 1_200 }).outcome, "process-failure");
});

test("the plan selects LOCALAPPDATA alone, repeats it around a baseline and stops", async () => {
  const plan = fakePlan(["PSModulePath", "LOCALAPPDATA", "COMPUTERNAME"], (additions) => additions.includes("LOCALAPPDATA"));
  const summary = await plan.run();
  assert.deepEqual(plan.calls, ["B1", "U1", "L1", "P1", "LP1", "B2", "S2", "B3", "S3"]);
  assert.deepEqual(summary.subset, ["LOCALAPPDATA"]);
  assert.equal(summary.supported, true);
  assert.equal(summary.stopReason, "subset-supported");
  assert.deepEqual(summary.notTestedAlone, ["COMPUTERNAME"]);
});

test("refinement tries other allowed names only after the prioritised ones fail", async () => {
  const plan = fakePlan([...ALLOWLIST], (additions) => additions.includes("COMPUTERNAME"));
  const summary = await plan.run();
  assert.deepEqual(plan.calls, ["B1", "U1", "L1", "P1", "LP1", "B2", "R-PSModuleAnalysisCachePath", "R-ProgramData", "R-ALLUSERSPROFILE", "R-COMPUTERNAME", "S2", "B3", "S3"]);
  assert.deepEqual(summary.subset, ["COMPUTERNAME"]);
  assert.equal(summary.supported, true);
});

test("an interaction-only effect keeps the repetition reserve and never exceeds 18 invocations", async () => {
  const plan = fakePlan([...ALLOWLIST], (additions) => additions.includes("COMPUTERNAME") && additions.includes("USERDOMAIN"));
  const summary = await plan.run();
  assert.equal(plan.calls.length, 18);
  assert.deepEqual(plan.calls.slice(-3), ["S2", "B3", "S3"]);
  assert.deepEqual(summary.subset, [...ALLOWLIST]);
  assert.equal(summary.supported, true);
  assert.ok(summary.notTestedAlone.length > 0);
});

test("the plan reports a negative result when the permitted bundle does not restore latency", async () => {
  const plan = fakePlan(["PSModulePath", "LOCALAPPDATA"], () => false);
  const summary = await plan.run();
  assert.equal(summary.stopReason, "bundle-does-not-restore");
  assert.equal(summary.invocations, 6);
  assert.equal(summary.subset, null);
});

test("the plan stops when the strict baseline is not slow", async () => {
  const plan = fakePlan(["PSModulePath", "LOCALAPPDATA"], () => true);
  const summary = await plan.run();
  assert.equal(summary.stopReason, "baseline-not-slow");
});

test("a baseline that is neither verified nor timed out stops the plan as unusable", async () => {
  const budget = createBudget({ maxInvocations: 18, deadlineAt: 480_000, invocationReserveMs: 31_000, cleanupReserveMs: 15_000, now: () => 0 });
  const measure = async (caseId, additions, index) => ({
    index,
    caseId,
    additions,
    durationMs: 20_000,
    outcome: caseId === "B2" ? "invalid-identity" : "verified",
  });
  const summary = await runPlan({ removed: ["PSModulePath", "LOCALAPPDATA"], measure, budget, skip: () => {} });
  assert.equal(summary.stopReason, "baseline-unusable");
  assert.equal(summary.invocations, 6);
});

test("deadline exhaustion marks every later case as skipped", async () => {
  const calls = [];
  const skips = [];
  let clock = 0;
  const budget = createBudget({ maxInvocations: 18, deadlineAt: 120_000, invocationReserveMs: 31_000, cleanupReserveMs: 15_000, now: () => clock });
  const measure = async (caseId, additions, index) => {
    clock += 30_000;
    calls.push(caseId);
    return { index, caseId, additions, durationMs: 30_000, outcome: "timeout" };
  };
  const summary = await runPlan({
    removed: ["PSModulePath", "LOCALAPPDATA"],
    measure,
    budget,
    skip: (caseId, additions, reason) => skips.push({ caseId, reason }),
  });
  assert.deepEqual(calls, ["B1", "U1", "L1"]);
  assert.equal(summary.stopReason, "budget-deadline");
  assert.deepEqual(skips, [
    { caseId: "P1", reason: "deadline" },
    { caseId: "LP1", reason: "after-budget-stop" },
    { caseId: "B2", reason: "after-budget-stop" },
  ]);
});

test("a probe run reaches the analysis-cache singleton, keeps captured values out of evidence and removes the private file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cr35-env-probe-test-"));
  try {
    const marker = `SECRET-MARKER-${Date.now()}`;
    const reader = path.join(root, "fake-reader.mjs");
    writeFileSync(reader, "export async function readProcessIdentity() { return null; }\n");
    const parentEnv = {
      PATH: "/bin",
      LOCALAPPDATA: `${marker}-local`,
      PSModulePath: `${marker}-modules`,
      PSModuleAnalysisCachePath: `C:\\${marker}\\ModuleAnalysisCache`,
      OS: "Windows_NT",
    };
    const config = prepare({
      release: root,
      scratch: path.join(root, "scratch"),
      evidence: path.join(root, "evidence"),
      env: parentEnv,
      reader,
      readerSha256: sha256File(reader),
      limits: { slowThresholdMs: 50, restoreCeilingMs: 40, restoreRatio: 0.8 },
    });
    const taskEnv = { PATH: "/bin" };
    const lines = [];
    const exitCode = await runProbe({
      config,
      env: taskEnv,
      token: "tok-test",
      log: (line) => lines.push(line),
      importReader: async () => ({
        async readProcessIdentity() {
          const restored = "PSModuleAnalysisCachePath" in taskEnv;
          await new Promise((resolve) => setTimeout(resolve, restored ? 5 : 80));
          return { command: "node -e x tok-test", startedAt: Date.now() };
        },
      }),
    });
    assert.equal(exitCode, 0);
    assert.equal(existsSync(config.privateValuesPath), false);
    assert.equal("PSModuleAnalysisCachePath" in taskEnv, false);
    const summary = JSON.parse(readFileSync(path.join(root, "evidence", "summary.json"), "utf8"));
    assert.deepEqual(summary.subset, ["PSModuleAnalysisCachePath"]);
    assert.equal(summary.supported, true);
    const ends = readFileSync(path.join(root, "evidence", "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "case-end");
    assert.deepEqual(
      ends.map((event) => event.caseId),
      ["B1", "U1", "L1", "P1", "LP1", "B2", "R-PSModuleAnalysisCachePath", "S2", "B3", "S3"],
    );
    assert.deepEqual(ends.find((event) => event.caseId === "R-PSModuleAnalysisCachePath").applied, ["PSModuleAnalysisCachePath"]);
    for (const name of readdirSync(path.join(root, "evidence"))) {
      assert.ok(!readFileSync(path.join(root, "evidence", name), "utf8").includes(marker), name);
    }
    assert.ok(lines.length > 0 && lines.every((line) => !line.includes(marker)));
    assert.equal(scan({ evidence: path.join(root, "evidence"), env: parentEnv }), 0);
    writeFileSync(path.join(root, "evidence", "leak.log"), `${JSON.stringify({ leaked: parentEnv.PSModuleAnalysisCachePath })}\n`);
    assert.equal(scan({ evidence: path.join(root, "evidence"), env: parentEnv }), 3);
    assert.ok(!readFileSync(path.join(root, "evidence", "leak.log"), "utf8").includes(marker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a harness failure records a fixed code instead of error text and still removes the private file", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cr35-env-probe-test-"));
  try {
    const marker = `SECRET-MARKER-${Date.now()}`;
    const reader = path.join(root, "fake-reader.mjs");
    writeFileSync(reader, "export {};\n");
    const parentEnv = { LOCALAPPDATA: `C:\\Users\\${marker}\\AppData\\Local` };
    const config = prepare({
      release: root,
      scratch: path.join(root, "scratch"),
      evidence: path.join(root, "evidence"),
      env: parentEnv,
      reader,
      readerSha256: sha256File(reader),
    });
    const lines = [];
    const exitCode = await runProbe({
      config,
      env: {},
      log: (line) => lines.push(line),
      importReader: async () => {
        throw new Error(`could not load ${parentEnv.LOCALAPPDATA}`);
      },
    });
    assert.equal(exitCode, 2);
    assert.equal(existsSync(config.privateValuesPath), false);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, "evidence", "harness-error.json"), "utf8")), {
      phase: "reader-import",
      errorName: "Error",
      code: "-",
    });
    assert.deepEqual(lines, ["harness error: reader-import Error -"]);
    for (const name of readdirSync(path.join(root, "evidence"))) {
      assert.ok(!readFileSync(path.join(root, "evidence", name), "utf8").includes(marker), name);
    }
    writeFileSync(path.join(root, "evidence", "escaped.json"), `${JSON.stringify({ leaked: parentEnv.LOCALAPPDATA })}\n`);
    assert.equal(scan({ evidence: path.join(root, "evidence"), env: parentEnv }), 3);
    assert.ok(!readFileSync(path.join(root, "evidence", "escaped.json"), "utf8").includes(marker));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the owned child is stopped after a failure", async () => {
  const child = await startOwnedChild({ token: "tok-cleanup", lifetimeMs: 60_000 });
  try {
    assert.ok(isAlive(child.pid));
    await assert.rejects(async () => {
      try {
        throw new Error("simulated failure");
      } finally {
        await child.stop();
      }
    });
  } finally {
    await child.stop();
  }
  assert.equal(isAlive(child.pid), false);
});

test("the owned child exits by itself when its parent disappears", async () => {
  const script = `import { startOwnedChild } from ${JSON.stringify(pathToFileURL(path.join(here, "env-probe-lib.mjs")).href)};
const child = await startOwnedChild({ token: "tok-orphan", lifetimeMs: 60000 });
process.stdout.write(String(child.pid));
process.exit(0);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  parent.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await once(parent, "exit");
  const pid = Number(output);
  assert.ok(Number.isInteger(pid) && pid > 0);
  const deadline = Date.now() + 8_000;
  while (isAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isAlive(pid), false);
});
