import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNS_PER_ITERATION = 3;
const RUN_TIMEOUT_MS = 10_000;
const UNLINK_WINDOW_MS = 5_000;
const START_DEADLINE_MS = 30_000;

const [outDir, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg ?? "2");
if (!outDir || !Number.isInteger(iterations) || iterations < 1 || iterations > 3) {
  console.error("usage: node gh-unlink-probe.mjs <out-dir> [iterations 1-3]");
  process.exit(2);
}
const probeStarted = Date.now();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (relative) =>
  createHash("sha256").update(readFileSync(path.join(repoRoot, relative))).digest("hex");
const evidence = {
  kind: "mirror-control",
  scope: "a simplified copy of the fake gh installation, separate from the real RPC fixture",
  platform: process.platform,
  node: process.version,
  mirrors: {
    "plugins/github/testing/fake-gh.ts": sha("plugins/github/testing/fake-gh.ts"),
  },
  budget: { RUNS_PER_ITERATION, RUN_TIMEOUT_MS, UNLINK_WINDOW_MS, START_DEADLINE_MS },
  iterations: [],
  stoppedByDeadline: false,
};
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "gh-unlink-mirror-control.json");
const checkpoint = () => writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
const pastDeadline = () => Date.now() - probeStarted >= START_DEADLINE_MS;

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function installFakeGh(binDir) {
  const source = 'require("node:fs").writeSync(1, "[]\\n");\nprocess.exit(0);\n';
  if (process.platform === "win32") {
    const script = path.join(binDir, "fake-gh.cjs");
    writeFileSync(script, source);
    const target = path.join(binDir, "gh.exe");
    let method = "hardlink";
    try {
      linkSync(process.execPath, target);
    } catch {
      copyFileSync(process.execPath, target);
      method = "copy";
    }
    return { file: target, method, env: { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(script)}` } };
  }
  const target = path.join(binDir, "gh");
  writeFileSync(target, `#!${process.execPath}\n${source}`);
  chmodSync(target, 0o755);
  return { file: target, method: "script", env: process.env };
}

function runGh(fake) {
  return new Promise((resolve) => {
    const started = Date.now();
    let exitedAt = null;
    const child = execFile(fake.file, ["api", "graphql"], { env: fake.env, timeout: RUN_TIMEOUT_MS }, (error) => {
      resolve({
        pid: child.pid,
        exitAfterMs: exitedAt === null ? null : exitedAt - started,
        closeAfterMs: Date.now() - started,
        error: error ? String(error.code ?? error.message) : null,
        runningAfterClose: child.pid === undefined ? null : isRunning(child.pid),
      });
    });
    child.on("exit", () => {
      exitedAt = Date.now();
    });
  });
}

checkpoint();
for (let iteration = 1; iteration <= iterations; iteration += 1) {
  if (pastDeadline()) {
    evidence.stoppedByDeadline = true;
    break;
  }
  const binDir = mkdtempSync(path.join(tmpdir(), "bb-cr35-gh-probe-"));
  const fake = installFakeGh(binDir);
  const record = { iteration, method: fake.method, runs: [], unlink: null, cleanup: null };
  evidence.iterations.push(record);
  for (let run = 0; run < RUNS_PER_ITERATION; run += 1) {
    if (pastDeadline()) {
      evidence.stoppedByDeadline = true;
      break;
    }
    record.runs.push(await runGh(fake));
    checkpoint();
  }
  const unlinkStarted = Date.now();
  const attempts = [];
  while (Date.now() - unlinkStarted <= UNLINK_WINDOW_MS) {
    try {
      unlinkSync(fake.file);
      attempts.push({ atMs: Date.now() - unlinkStarted, code: null });
      break;
    } catch (error) {
      attempts.push({ atMs: Date.now() - unlinkStarted, code: error?.code ?? String(error) });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  record.unlink = {
    succeeded: attempts.at(-1)?.code === null,
    attempts: attempts.length,
    firstSuccessMs: attempts.find((attempt) => attempt.code === null)?.atMs ?? null,
    codes: [...new Set(attempts.map((attempt) => attempt.code).filter(Boolean))],
  };
  const rmStarted = Date.now();
  let rmError = null;
  try {
    rmSync(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    rmError = error?.code ?? String(error);
  }
  record.cleanup = { rmError, rmMs: Date.now() - rmStarted, directoryRemains: existsSync(binDir) };
  checkpoint();
}
console.log(JSON.stringify(evidence.iterations.map((i) => [i.method, i.unlink?.succeeded, i.unlink?.firstSuccessMs, i.unlink?.codes, i.cleanup?.directoryRemains])));
process.exit(evidence.iterations.every((i) => i.cleanup?.directoryRemains === false) ? 0 : 1);
