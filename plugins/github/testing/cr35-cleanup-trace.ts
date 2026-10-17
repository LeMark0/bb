import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const TRACE_FILE = "cr35-gh-trace.ndjson";
const AFTER_FAILURE_WINDOW_MS = 3_000;
const AFTER_FAILURE_INTERVAL_MS = 50;

interface ChildSummary {
  pid: number;
  exe: string | null;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  runningBeforeCleanup: boolean | "EPERM";
}

interface RemovalAttempt {
  ms: number;
  code: string | null;
}

interface BeforeCleanup {
  fakeGhExisted: boolean;
  children: ChildSummary[];
  malformedTraceLines: number;
  msSinceLastChildExit: number | null;
}

interface AfterFailure {
  fakeGhRemained: boolean;
  fakeGhUnlink: RemovalAttempt | null;
  removedAfterMs: number | null;
  attempts: number;
  codes: string[];
}

interface CleanupRecord {
  run: string;
  test: string;
  platform: NodeJS.Platform;
  beforeCleanup: BeforeCleanup | { instrumentationError: string };
  cleanup: { ms: number; error: string | null; directoryRemains: boolean };
  afterFailure: AfterFailure | { instrumentationError: string } | null;
}

interface TraceFixtureCleanupArgs {
  binDir: string;
  testName: string;
}

export function childTraceSource(binDir: string): string {
  if (process.env.CR35_EVIDENCE_DIR === undefined) return "";
  const tracePath = JSON.stringify(join(binDir, TRACE_FILE));
  return `const cr35Trace = (event, extra) => fs.appendFileSync(${tracePath}, JSON.stringify({ event, pid: process.pid, ppid: process.ppid, exe: path.basename(process.execPath), at: Date.now(), ...extra }) + "\\n");
cr35Trace("start", {});
process.on("exit", (code) => cr35Trace("exit", { code }));
`;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String(error.code);
  }
  return String(error);
}

function processState(pid: number): boolean | "EPERM" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM" ? "EPERM" : false;
  }
}

function readChildren(tracePath: string): {
  children: ChildSummary[];
  malformedTraceLines: number;
} {
  const byPid = new Map<number, ChildSummary>();
  let malformedTraceLines = 0;
  const lines = existsSync(tracePath)
    ? readFileSync(tracePath, "utf8").split("\n")
    : [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformedTraceLines += 1;
      continue;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("event" in value) ||
      !("pid" in value) ||
      !("at" in value) ||
      typeof value.pid !== "number" ||
      typeof value.at !== "number"
    ) {
      malformedTraceLines += 1;
      continue;
    }
    const summary = byPid.get(value.pid) ?? {
      pid: value.pid,
      exe: "exe" in value && typeof value.exe === "string" ? value.exe : null,
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      runningBeforeCleanup: false,
    };
    if (value.event === "start") summary.startedAt = value.at;
    if (value.event === "exit") {
      summary.exitedAt = value.at;
      summary.exitCode =
        "code" in value && typeof value.code === "number" ? value.code : null;
    }
    byPid.set(value.pid, summary);
  }
  return {
    children: [...byPid.values()].map((summary) => ({
      ...summary,
      runningBeforeCleanup: processState(summary.pid),
    })),
    malformedTraceLines,
  };
}

function attemptUnlink(file: string): RemovalAttempt {
  const startedAt = performance.now();
  try {
    unlinkSync(file);
    return { ms: Math.round(performance.now() - startedAt), code: null };
  } catch (error) {
    return {
      ms: Math.round(performance.now() - startedAt),
      code: errorCode(error),
    };
  }
}

function fakeGhPath(binDir: string): string {
  return join(binDir, process.platform === "win32" ? "gh.exe" : "gh");
}

function observeBeforeCleanup(binDir: string): BeforeCleanup {
  const fakeGhExisted = existsSync(fakeGhPath(binDir));
  const { children, malformedTraceLines } = readChildren(
    join(binDir, TRACE_FILE),
  );
  const exits = children.flatMap((child) =>
    child.exitedAt === null ? [] : [child.exitedAt],
  );
  return {
    fakeGhExisted,
    children,
    malformedTraceLines,
    msSinceLastChildExit:
      exits.length === 0 ? null : Date.now() - Math.max(...exits),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function probeAfterFailure(binDir: string): AfterFailure {
  const fakeGh = fakeGhPath(binDir);
  const fakeGhRemained = existsSync(fakeGh);
  const fakeGhUnlink = fakeGhRemained ? attemptUnlink(fakeGh) : null;
  const startedAt = performance.now();
  const codes = new Set<string>();
  let attempts = 0;
  while (performance.now() - startedAt <= AFTER_FAILURE_WINDOW_MS) {
    attempts += 1;
    try {
      rmSync(binDir, { recursive: true, force: true });
      return {
        fakeGhRemained,
        fakeGhUnlink,
        removedAfterMs: Math.round(performance.now() - startedAt),
        attempts,
        codes: [...codes],
      };
    } catch (error) {
      codes.add(errorCode(error));
      sleepSync(AFTER_FAILURE_INTERVAL_MS);
    }
  }
  return {
    fakeGhRemained,
    fakeGhUnlink,
    removedAfterMs: null,
    attempts,
    codes: [...codes],
  };
}

function appendRecord(evidenceDir: string, record: CleanupRecord): void {
  try {
    mkdirSync(evidenceDir, { recursive: true });
    appendFileSync(
      join(evidenceDir, `github-rpc-cleanup-run-${record.run}.ndjson`),
      `${JSON.stringify(record)}\n`,
    );
  } catch (error) {
    console.error(`cr35 cleanup evidence was not written: ${String(error)}`);
  }
}

export function traceFixtureCleanup(
  args: TraceFixtureCleanupArgs,
  cleanup: () => void,
): void {
  const evidenceDir = process.env.CR35_EVIDENCE_DIR;
  if (evidenceDir === undefined) {
    cleanup();
    return;
  }
  let beforeCleanup: CleanupRecord["beforeCleanup"];
  try {
    beforeCleanup = observeBeforeCleanup(args.binDir);
  } catch (error) {
    beforeCleanup = { instrumentationError: String(error) };
  }
  const record: CleanupRecord = {
    run: process.env.CR35_RUN ?? "local",
    test: args.testName,
    platform: process.platform,
    beforeCleanup,
    cleanup: { ms: 0, error: null, directoryRemains: false },
    afterFailure: null,
  };
  const startedAt = performance.now();
  try {
    cleanup();
    record.cleanup = {
      ms: Math.round(performance.now() - startedAt),
      error: null,
      directoryRemains: existsSync(args.binDir),
    };
  } catch (error) {
    record.cleanup = {
      ms: Math.round(performance.now() - startedAt),
      error: errorCode(error),
      directoryRemains: existsSync(args.binDir),
    };
    try {
      record.afterFailure = probeAfterFailure(args.binDir);
    } catch (probeError) {
      record.afterFailure = { instrumentationError: String(probeError) };
    }
    throw error;
  } finally {
    appendRecord(evidenceDir, record);
  }
}
