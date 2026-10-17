import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ALLOWLIST = Object.freeze([
  "PSModulePath",
  "LOCALAPPDATA",
  "ProgramData",
  "ALLUSERSPROFILE",
  "COMPUTERNAME",
  "USERNAME",
  "USERDOMAIN",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
  "OS",
]);

export const PRIORITY = Object.freeze(["LOCALAPPDATA", "PSModulePath"]);

export const PRODUCTION_READER_SHA256 =
  "8cc61b2a28dcf82afe1f5be1624c25248c7160318b992b8d345317db10a26746";

export const LIMITS = Object.freeze({
  maxInvocations: 18,
  productionTimeoutMs: 30_000,
  deadlineMs: 480_000,
  invocationReserveMs: 31_000,
  cleanupReserveMs: 15_000,
  slowThresholdMs: 10_000,
  restoreCeilingMs: 5_000,
  restoreRatio: 0.25,
  startToleranceMs: 60_000,
  repetitionReserve: 3,
  childLifetimeMs: 720_000,
  childStopGraceMs: 5_000,
  leakScanMinLength: 6,
});

export const PLAN_RULE = Object.freeze([
  "B1 strict baseline; U1 baseline plus every removed allowlisted name; L1 LOCALAPPDATA; P1 PSModulePath; LP1 both; B2 baseline (cases for names not removed are omitted)",
  "slow: verified or timeout and at least slowThresholdMs; B1 or B2 with any other outcome stops as baseline-unusable; both must be slow, otherwise stop as baseline-not-slow",
  "restores: verified, at most restoreCeilingMs and at most restoreRatio times the faster of B1 and B2",
  "subset: the first restoring case among L1, P1, LP1; otherwise, if U1 restores, single removed names outside the priority in allowlist order while a three-invocation repetition reserve remains, then the bundle; if U1 does not restore, stop as bundle-does-not-restore",
  "repetition: S2 subset, B3 baseline, S3 subset; supported when the selecting case, S2 and S3 restore and B3 is slow",
  "budget: at most maxInvocations queries and no start unless invocationReserveMs plus cleanupReserveMs fit before the deadline; later cases are recorded as skipped",
]);

const fold = (name) => name.toUpperCase();

export function caseGroups(names) {
  const groups = new Map();
  for (const name of names) {
    const key = fold(name);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort());
}

export function namesDiff(parentNames, taskNames) {
  const taskKeys = new Set(taskNames.map(fold));
  const parentKeys = new Set(parentNames.map(fold));
  return {
    removed: parentNames.filter((name) => !taskKeys.has(fold(name))).sort(),
    added: taskNames.filter((name) => !parentKeys.has(fold(name))).sort(),
    caseDuplicates: { parent: caseGroups(parentNames), task: caseGroups(taskNames) },
  };
}

export function classifyAllowlist(parentNames, taskNames, allowlist = ALLOWLIST) {
  const parentKeys = new Set(parentNames.map(fold));
  const taskKeys = new Set(taskNames.map(fold));
  const removed = [];
  const retained = [];
  const missing = [];
  for (const name of allowlist) {
    const key = fold(name);
    if (!parentKeys.has(key)) missing.push(name);
    else if (taskKeys.has(key)) retained.push(name);
    else removed.push(name);
  }
  return { removed, retained, missing };
}

export function findKey(env, name) {
  const key = fold(name);
  return Object.keys(env).find((candidate) => fold(candidate) === key);
}

export function captureValues(env, allowlist = ALLOWLIST) {
  const values = {};
  for (const name of allowlist) {
    const key = findKey(env, name);
    if (key !== undefined && typeof env[key] === "string") values[name] = env[key];
  }
  return values;
}

export function applyAdditions(env, names, values) {
  const applied = [];
  const skipped = [];
  for (const name of names) {
    if (findKey(env, name) !== undefined) {
      skipped.push({ name, reason: "already-present" });
    } else if (typeof values[name] !== "string") {
      skipped.push({ name, reason: "no-captured-value" });
    } else {
      env[name] = values[name];
      applied.push(name);
    }
  }
  return {
    applied,
    skipped,
    restore() {
      for (const name of applied) delete env[name];
    },
  };
}

export function createBudget({ maxInvocations, deadlineAt, invocationReserveMs, cleanupReserveMs, now }) {
  let started = 0;
  return {
    get started() {
      return started;
    },
    remaining() {
      return maxInvocations - started;
    },
    check() {
      if (started >= maxInvocations) return "max-invocations";
      if (now() + invocationReserveMs + cleanupReserveMs > deadlineAt) return "deadline";
      return null;
    },
    take() {
      started += 1;
    },
  };
}

export function classifyOutcome({ identity, durationMs, token, spawnedAtMs, limits = LIMITS }) {
  if (identity === null || identity === undefined) {
    return {
      outcome: durationMs >= limits.productionTimeoutMs - 100 ? "timeout" : "process-failure",
      commandMatches: false,
      startMatches: false,
      startDeltaMs: null,
    };
  }
  const commandMatches = typeof identity.command === "string" && identity.command.includes(token);
  const startDeltaMs =
    typeof identity.startedAt === "number" && Number.isFinite(identity.startedAt)
      ? identity.startedAt - spawnedAtMs
      : null;
  const startMatches = startDeltaMs !== null && Math.abs(startDeltaMs) <= limits.startToleranceMs;
  return {
    outcome: commandMatches && startMatches ? "verified" : "invalid-identity",
    commandMatches,
    startMatches,
    startDeltaMs,
  };
}

export function isSlow(entry, limits = LIMITS) {
  return (
    entry !== null &&
    (entry.outcome === "verified" || entry.outcome === "timeout") &&
    entry.durationMs >= limits.slowThresholdMs
  );
}

export async function runPlan({ removed, measure, budget, skip, limits = LIMITS }) {
  const entries = [];
  const decisions = [];
  let stopReason = null;
  const run = async (caseId, additions) => {
    if (stopReason !== null) {
      skip(caseId, additions, "after-budget-stop");
      return null;
    }
    const blocked = budget.check();
    if (blocked !== null) {
      stopReason = `budget-${blocked}`;
      skip(caseId, additions, blocked);
      return null;
    }
    budget.take();
    const entry = await measure(caseId, additions, budget.started);
    entries.push(entry);
    return entry;
  };
  const has = (name) => removed.includes(name);
  const finish = (extra) => {
    const testedAlone = new Set(
      entries.filter((entry) => entry.additions.length === 1).map((entry) => entry.additions[0]),
    );
    return {
      invocations: entries.length,
      stopReason,
      decisions,
      removedAllowlist: removed,
      testedAlone: removed.filter((name) => testedAlone.has(name)),
      notTestedAlone: removed.filter((name) => !testedAlone.has(name)),
      ...extra,
    };
  };

  const b1 = await run("B1", []);
  if (removed.length === 0) {
    await run("B2", []);
    stopReason ??= "no-allowlisted-name-removed";
    return finish({ subset: null, supported: false });
  }
  const u1 = await run("U1", [...removed]);
  const l1 = has("LOCALAPPDATA") ? await run("L1", ["LOCALAPPDATA"]) : null;
  const p1 = has("PSModulePath") ? await run("P1", ["PSModulePath"]) : null;
  const lp1 = has("LOCALAPPDATA") && has("PSModulePath") ? await run("LP1", ["LOCALAPPDATA", "PSModulePath"]) : null;
  const b2 = await run("B2", []);
  if (stopReason !== null) return finish({ subset: null, supported: false });

  const usable = (entry) => entry.outcome === "verified" || entry.outcome === "timeout";
  if (!usable(b1) || !usable(b2)) {
    stopReason = "baseline-unusable";
    return finish({ subset: null, supported: false });
  }
  if (!isSlow(b1, limits) || !isSlow(b2, limits)) {
    stopReason = "baseline-not-slow";
    return finish({ subset: null, supported: false });
  }
  const reference = Math.min(b1.durationMs, b2.durationMs);
  const restores = (entry) =>
    entry !== null &&
    entry.outcome === "verified" &&
    entry.durationMs <= limits.restoreCeilingMs &&
    entry.durationMs <= limits.restoreRatio * reference;
  decisions.push({ step: "reference", referenceMs: reference });

  let subset = null;
  let selectedBy = null;
  for (const [entry, names] of [
    [l1, ["LOCALAPPDATA"]],
    [p1, ["PSModulePath"]],
    [lp1, ["LOCALAPPDATA", "PSModulePath"]],
  ]) {
    if (restores(entry)) {
      subset = names;
      selectedBy = entry;
      break;
    }
  }
  if (subset === null) {
    if (!restores(u1)) {
      stopReason = "bundle-does-not-restore";
      return finish({ subset: null, supported: false });
    }
    decisions.push({ step: "refine", reason: "bundle restores but no prioritised subset does" });
    for (const name of removed.filter((candidate) => !PRIORITY.includes(candidate))) {
      if (budget.remaining() - 1 < limits.repetitionReserve) {
        decisions.push({ step: "refine-stopped", reason: "repetition reserve" });
        break;
      }
      const entry = await run(`R-${name}`, [name]);
      if (entry === null) break;
      if (restores(entry)) {
        subset = [name];
        selectedBy = entry;
        break;
      }
    }
    if (subset === null && stopReason === null) {
      subset = [...removed];
      selectedBy = u1;
    }
  }
  if (subset === null) return finish({ subset: null, supported: false });
  decisions.push({ step: "selected", subset, by: selectedBy.caseId });

  const s2 = await run("S2", subset);
  const b3 = await run("B3", []);
  const s3 = await run("S3", subset);
  const supported = [selectedBy, s2, s3].every(restores) && isSlow(b3, limits);
  stopReason ??= supported ? "subset-supported" : "subset-not-repeated";
  return finish({ subset, supported });
}

export function createEvidence(dir) {
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    event(type, fields = {}) {
      appendFileSync(
        path.join(dir, "events.ndjson"),
        `${JSON.stringify({ type, at: new Date().toISOString(), ...fields })}\n`,
      );
    },
    write(name, value) {
      writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

export function scanForValues(dir, values, minLength = LIMITS.leakScanMinLength) {
  const needles = [
    ...new Set(
      Object.values(values)
        .filter((value) => typeof value === "string" && value.length >= minLength)
        .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
    ),
  ];
  const hits = [];
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    if (needles.some((needle) => text.includes(needle))) hits.push(name);
  }
  return hits;
}

export function prepare({ release, scratch, evidence, env = process.env, reader, readerSha256, limits }) {
  const probeDir = path.join(scratch, "pkgs", "probe");
  const privateDir = path.join(scratch, "private");
  mkdirSync(probeDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  const record = createEvidence(evidence);
  const names = Object.keys(env).sort();
  record.write("parent-names.json", { names, caseDuplicates: caseGroups(names) });
  const privateValuesPath = path.join(privateDir, "values.json");
  writeFileSync(privateValuesPath, JSON.stringify(captureValues(env)), { mode: 0o600 });
  writeFileSync(
    path.join(scratch, "package.json"),
    `${JSON.stringify({ name: "cr35-env-probe-root", private: true, packageManager: "pnpm@9.15.0" }, null, 2)}\n`,
  );
  writeFileSync(path.join(scratch, "pnpm-workspace.yaml"), "packages:\n  - pkgs/*\n");
  writeFileSync(
    path.join(scratch, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  pkgs/probe: {}\n",
  );
  writeFileSync(path.join(scratch, "turbo.json"), `${JSON.stringify({ tasks: { probe: { cache: false } } }, null, 2)}\n`);
  writeFileSync(
    path.join(probeDir, "package.json"),
    `${JSON.stringify({ name: "cr35-env-probe", private: true, type: "module", scripts: { probe: "node env-probe.mjs" } }, null, 2)}\n`,
  );
  copyFileSync(path.join(here, "env-probe.mjs"), path.join(probeDir, "env-probe.mjs"));
  copyFileSync(path.join(here, "env-probe-lib.mjs"), path.join(probeDir, "env-probe-lib.mjs"));
  const config = {
    readerPath: reader ?? path.join(release, "packages", "process-utils", "src", "process-info.ts"),
    readerSha256: readerSha256 ?? PRODUCTION_READER_SHA256,
    evidenceDir: evidence,
    privateValuesPath,
    parentNamesPath: path.join(evidence, "parent-names.json"),
    ...(limits === undefined ? {} : { limits }),
  };
  writeFileSync(path.join(scratch, "probe-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  record.event("prepared", { parentNameCount: names.length });
  return config;
}

export function scan({ evidence, env = process.env }) {
  const record = createEvidence(evidence);
  const hits = scanForValues(evidence, captureValues(env));
  for (const name of hits) {
    writeFileSync(path.join(evidence, name), "redacted: this file contained a captured environment value\n");
  }
  record.write("leak-scan.json", { redacted: hits });
  return hits.length === 0 ? 0 : 3;
}

export class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeFailure";
    this.code = code;
  }
}

export function describeFailure(phase, error) {
  const errorName = error instanceof Error && /^[A-Za-z]{1,40}$/u.test(error.name) ? error.name : "unknown";
  const systemCode =
    error instanceof Error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,60}$/u.test(error.code)
      ? error.code
      : null;
  return { phase, errorName, code: error instanceof ProbeFailure ? error.code : (systemCode ?? "-") };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHILD_SCRIPT =
  "const started=Date.now();const parent=process.ppid;const lifetime=Number(process.argv[2]);" +
  "setInterval(()=>{try{process.kill(parent,0)}catch{process.exit(0)}if(Date.now()-started>lifetime)process.exit(0)},1000);" +
  "process.stdout.write('ready');";

export async function startOwnedChild({ token, lifetimeMs }) {
  const spawnedAtMs = Date.now();
  const child = spawn(process.execPath, ["-e", CHILD_SCRIPT, token, String(lifetimeMs)], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  const ready = once(child.stdout, "data");
  const outcome = await Promise.race([
    ready.then(() => "ready"),
    exited.then(() => "exited"),
  ]);
  if (outcome !== "ready") throw new ProbeFailure("child-not-ready");
  return {
    pid: child.pid,
    spawnedAtMs,
    token,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop(graceMs = LIMITS.childStopGraceMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { alreadyExited: true, forced: false, exited: true };
      }
      child.kill();
      const done = await Promise.race([exited.then(() => true), delay(graceMs).then(() => false)]);
      if (!done) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(graceMs)]);
      }
      return {
        alreadyExited: false,
        forced: !done,
        exited: child.exitCode !== null || child.signalCode !== null,
      };
    },
  };
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export async function runProbe({
  config,
  env = process.env,
  now = Date.now,
  importReader = (file) => import(pathToFileURL(file).href),
  token = `bb-cr35-env-${randomUUID()}`,
  log = console.log,
}) {
  const limits = { ...LIMITS, ...(config.limits ?? {}) };
  const evidence = createEvidence(config.evidenceDir);
  const startMs = now();
  evidence.event("probe-start", { limits, rule: PLAN_RULE, allowlist: ALLOWLIST, priority: PRIORITY });
  let child = null;
  let exitCode = 0;
  let phase = "names";
  try {
    const taskNames = Object.keys(env).sort();
    const parentNames = JSON.parse(readFileSync(config.parentNamesPath, "utf8")).names;
    const allowlist = classifyAllowlist(parentNames, taskNames);
    evidence.write("names.json", {
      taskNames,
      parentNameCount: parentNames.length,
      diff: namesDiff(parentNames, taskNames),
      allowlist,
    });
    evidence.event("names-recorded", {
      removed: allowlist.removed,
      retained: allowlist.retained,
      missing: allowlist.missing,
    });

    phase = "reader-parity";
    const readerSha256 = sha256File(config.readerPath);
    const parity = readerSha256 === config.readerSha256;
    evidence.event("reader-parity", { readerSha256, expected: config.readerSha256, parity });
    if (!parity) throw new ProbeFailure("reader-mismatch");
    phase = "reader-import";
    const reader = await importReader(config.readerPath);
    if (typeof reader.readProcessIdentity !== "function") throw new ProbeFailure("reader-export-missing");

    phase = "values";
    const captured = JSON.parse(readFileSync(config.privateValuesPath, "utf8"));
    const values = {};
    for (const name of ALLOWLIST) if (typeof captured[name] === "string") values[name] = captured[name];
    evidence.event("values-loaded", { names: Object.keys(values) });

    phase = "child-start";
    child = await startOwnedChild({ token, lifetimeMs: limits.childLifetimeMs });
    evidence.event("child-ready", { pid: child.pid });

    const budget = createBudget({
      maxInvocations: limits.maxInvocations,
      deadlineAt: startMs + limits.deadlineMs,
      invocationReserveMs: limits.invocationReserveMs,
      cleanupReserveMs: limits.cleanupReserveMs,
      now,
    });
    const measure = async (caseId, additions, index) => {
      evidence.event("case-start", { index, caseId, additions });
      if (!child.alive()) throw new ProbeFailure("child-stopped");
      const change = applyAdditions(env, additions, values);
      const started = performance.now();
      let identity;
      try {
        identity = await reader.readProcessIdentity(child.pid);
      } finally {
        change.restore();
      }
      const durationMs = Math.round(performance.now() - started);
      const entry = {
        index,
        caseId,
        additions,
        applied: change.applied,
        skipped: change.skipped,
        durationMs,
        ...classifyOutcome({ identity, durationMs, token, spawnedAtMs: child.spawnedAtMs, limits }),
      };
      evidence.event("case-end", entry);
      log(`${caseId} [${additions.join(",")}] ${entry.outcome} ${durationMs}ms`);
      return entry;
    };
    phase = "plan";
    const summary = await runPlan({
      removed: allowlist.removed,
      measure,
      budget,
      limits,
      skip: (caseId, additions, reason) => evidence.event("case-skipped", { caseId, additions, reason }),
    });
    phase = "summary";
    evidence.write("summary.json", summary);
    log(`stop: ${summary.stopReason}; subset: ${JSON.stringify(summary.subset)}; supported: ${summary.supported}`);
  } catch (error) {
    exitCode = 2;
    const failure = describeFailure(phase, error);
    evidence.write("harness-error.json", failure);
    evidence.event("harness-error", failure);
    log(`harness error: ${failure.phase} ${failure.errorName} ${failure.code}`);
  } finally {
    if (child !== null) evidence.event("child-stopped", await child.stop(limits.childStopGraceMs));
    rmSync(config.privateValuesPath, { force: true });
    evidence.event("private-values-removed", { exists: existsSync(config.privateValuesPath) });
    evidence.event("probe-end", { exitCode, elapsedMs: now() - startMs });
  }
  return exitCode;
}
