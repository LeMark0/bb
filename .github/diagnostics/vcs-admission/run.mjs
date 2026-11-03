import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessCoverage, cleanupOwned, createTreeTracker, startSampler } from "./process-tree.mjs";
import { renderMarkdown, summarise } from "./summarise.mjs";

export const BASE = "d6d5e76ac640bba4b6516955aa18dbd5a9c97fa8";
export const TEST_FILE = "test/vcs-process-admission.test.ts";
export const EXPECTED_TESTS = [
  "admits only the background share of git children while a foreground status can still start",
  "releases admission after real git exit, spawn, and timeout failures",
];
export const VITEST_LIMIT_MS = 180_000;
export const VITEST_EXIT_GRACE_MS = 30_000;
export const OBSERVE_AFTER_MS = 45_000;
export const SAMPLER_START_MS = 30_000;
export const MAX_SNAPSHOT_GAP_MS = 3_000;
export const ALLOWED_CHANGES = [".github/workflows/diagnose-vcs-admission.yml", ".github/diagnostics/vcs-admission/"];
export const PINNED_PATHS = ["packages/process-utils", "vitest.shared.ts", "vitest.global-tmpdir.ts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const packageDir = path.join(repo, "packages", "process-utils");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function checkIdentity({ base, parent, changed, pinned, dirty }) {
  const problems = [];
  if (parent !== base) problems.push(`HEAD^ is ${parent}, not ${base}`);
  const outside = changed.filter((file) => !ALLOWED_CHANGES.some((allowed) => (allowed.endsWith("/") ? file.startsWith(allowed) : file === allowed)));
  if (outside.length > 0) problems.push(`changes outside the diagnostic: ${outside.join(", ")}`);
  for (const entry of pinned) {
    if (entry.head !== entry.base) problems.push(`${entry.path} differs from ${base}`);
  }
  if (dirty.length > 0) problems.push(`working tree differs from HEAD: ${dirty.join(", ")}`);
  return problems;
}

export function exitCode({ identityRefused, limitHit, traceLoaded, coverage, vitestCode }) {
  if (identityRefused) return 2;
  if (limitHit) return 4;
  if (!traceLoaded || !coverage.complete) return 3;
  return typeof vitestCode === "number" ? vitestCode : 1;
}

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function version(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

function readIdentity(base, pnpmVersion) {
  const head = git(["rev-parse", "HEAD"]);
  const parent = git(["rev-parse", "HEAD^"]);
  const changed = git(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean);
  const pinned = PINNED_PATHS.map((file) => ({ path: file, head: git(["rev-parse", `HEAD:${file}`]), base: git(["rev-parse", `${base}:${file}`]) }));
  const dirty = git(["status", "--porcelain", "--untracked-files=no", "--", ...PINNED_PATHS]).split("\n").filter(Boolean);
  return {
    head,
    parent,
    base,
    changed,
    pinned,
    dirty,
    testFileBlob: git(["rev-parse", `HEAD:packages/process-utils/${TEST_FILE}`]),
    toolchain: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osVersion: typeof os.version === "function" ? os.version() : null,
      parallelism: os.availableParallelism(),
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
      pnpm: pnpmVersion,
      vitest: version(path.join(packageDir, "node_modules", "vitest", "package.json")),
      execa: version(path.join(packageDir, "node_modules", "execa", "package.json")),
      runnerImage: process.env.ImageOS ?? null,
      runnerImageVersion: process.env.ImageVersion ?? null,
    },
    run: {
      id: process.env.GITHUB_RUN_ID ?? null,
      attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      sha: process.env.GITHUB_SHA ?? null,
    },
  };
}

function killProcess(pid) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      try {
        process.kill(pid, "SIGKILL");
        resolve({ code: 0 });
      } catch (error) {
        resolve({ code: error.code ?? "error" });
      }
      return;
    }
    const started = Date.now();
    execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 10_000 }, (error) =>
      resolve({ code: error === null ? 0 : (error.code ?? "error"), ms: Date.now() - started }),
    );
  });
}

function parseArgs(argv) {
  const args = { out: null, sampler: process.platform === "win32" ? "windows" : "none", pnpmVersion: null, base: BASE };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (flag === "--out") args.out = path.resolve(value);
    else if (flag === "--sampler") args.sampler = value;
    else if (flag === "--pnpm-version") args.pnpmVersion = value;
    else if (flag === "--base") args.base = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.out) throw new Error("--out is required");
  if (!["windows", "none"].includes(args.sampler)) throw new Error(`unknown sampler ${args.sampler}`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (existsSync(args.out)) throw new Error(`${args.out} exists; use a new output directory`);
  mkdirSync(args.out, { recursive: true });
  const write = (name, value) => writeFileSync(path.join(args.out, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  const identity = readIdentity(args.base, args.pnpmVersion);
  write("identity.json", identity);
  const problems = checkIdentity(identity);
  if (problems.length > 0) {
    write("refused.json", { problems });
    console.error(`refusing to run: ${problems.join("; ")}`);
    return exitCode({ identityRefused: true });
  }

  const treeLog = path.join(args.out, "tree.jsonl");
  const snapshotTimes = [];
  let tracker = null;
  let latest = null;
  let samplerErrors = 0;
  let samplerExit = null;
  let vitestRunning = false;
  const boundaryPath = path.join(args.out, "spawn-boundary");
  const sampler = startSampler(args.sampler, {
    boundaryPath,
    onSnapshot: (snapshot) => {
      latest = snapshot;
      snapshotTimes.push(snapshot.t);
      const rootBindable = vitestRunning && snapshot.afterBoundary === true;
      if (tracker) for (const event of tracker.update(snapshot, { rootBindable })) appendFileSync(treeLog, `${JSON.stringify(event)}\n`);
    },
    onError: (error) => {
      samplerErrors += 1;
      if (samplerErrors <= 5) appendFileSync(path.join(args.out, "sampler-errors.log"), `${String(error.message ?? error).slice(0, 500)}\n`);
    },
    onExit: (exit) => {
      samplerExit = exit;
    },
  });
  if (args.sampler !== "none") {
    const deadline = Date.now() + SAMPLER_START_MS;
    while (latest === null && samplerExit === null && Date.now() < deadline) await sleep(100);
    if (latest === null) console.error("the process sampler produced no snapshot; continuing with the in-process trace, the result will be incomplete");
  }

  const output = createWriteStream(path.join(args.out, "vitest-output.log"));
  const spawnedAt = Date.now();
  const vitest = spawn(process.execPath, [path.join(packageDir, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.join(here, "vitest.config.mts"), TEST_FILE], {
    cwd: packageDir,
    env: { ...process.env, BB_VCS_DIAG_DIR: args.out },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  vitest.once("exit", () => {
    vitestRunning = false;
  });
  if (vitest.pid !== undefined) {
    writeFileSync(boundaryPath, `${vitest.pid}\n`);
    vitestRunning = true;
  }
  tracker = createTreeTracker(vitest.pid, spawnedAt);
  vitest.stdout.pipe(output, { end: false });
  vitest.stderr.pipe(output, { end: false });
  let limitHit = false;
  const exited = new Promise((resolve) => vitest.once("exit", (exitCodeValue, signal) => resolve(exitCodeValue ?? signal)));
  const limit = setTimeout(() => {
    limitHit = true;
    void killProcess(vitest.pid);
  }, VITEST_LIMIT_MS);
  const code = await Promise.race([exited, sleep(VITEST_LIMIT_MS + VITEST_EXIT_GRACE_MS).then(() => "no-exit")]);
  clearTimeout(limit);
  const exitedAt = Date.now();
  await sleep(OBSERVE_AFTER_MS);
  const observedUntil = Date.now();

  const cleanup = await cleanupOwned({ tracker, latestSnapshot: () => latest, now: Date.now, maxAgeMs: MAX_SNAPSHOT_GAP_MS, kill: killProcess });
  if (args.sampler !== "none" && samplerExit === null) await sleep(2_000);
  await sampler.stop();
  output.end();

  const events = [];
  for (const name of readdirSync(args.out).filter((file) => /^events-\d+\.jsonl$/u.test(file))) {
    for (const line of readFileSync(path.join(args.out, name), "utf8").split("\n")) if (line) events.push(JSON.parse(line));
  }
  const resultsPath = path.join(args.out, "vitest-results.json");
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : null;
  const tree = [...tracker.records.values()];
  const coverage = assessCoverage({
    sampler: args.sampler,
    snapshotTimes,
    spawnedAt,
    observedUntil,
    maxGapMs: MAX_SNAPSHOT_GAP_MS,
    rootObserved: tracker.rootKey !== null,
    samplerExit,
    results,
    expectedTests: EXPECTED_TESTS,
  });
  write("tree.json", tree);
  write("cleanup.json", cleanup);
  const traceLoaded = events.some((event) => event.ev === "trace-start");
  const summary = summarise({
    events,
    tree,
    results,
    identity: { head: identity.head, base: identity.base, testFileBlob: identity.testFileBlob, toolchain: identity.toolchain },
    vitest: { code, spawnedAt, exitedAt, observedUntil, durationMs: exitedAt - spawnedAt, limitHit },
  });
  summary.coverage = { ...coverage, traceLoaded, samplerErrors, samplerExit, observedIncarnations: tracker.observedIncarnations };
  summary.limits = {
    vitestLimitMs: VITEST_LIMIT_MS,
    vitestExitGraceMs: VITEST_EXIT_GRACE_MS,
    observeAfterMs: OBSERVE_AFTER_MS,
    maxSnapshotGapMs: MAX_SNAPSHOT_GAP_MS,
    sampler: args.sampler,
  };
  summary.cleanup = cleanup;
  summary.outcome = exitCode({ limitHit, traceLoaded, coverage, vitestCode: code });
  write("summary.json", summary);
  const markdown = renderMarkdown(summary);
  write("summary.md", markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (!traceLoaded) console.error("the trace setup file did not load in the test worker");
  if (!coverage.complete) console.error(`incomplete diagnostic: ${coverage.problems.join("; ")}`);
  return summary.outcome;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(5);
    },
  );
}
