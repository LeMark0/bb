import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessIdentity } from "@bb/process-utils";
import { expect, it, onTestFinished } from "vitest";
import {
  isProcessRunning,
  stopVerifiedProcess,
} from "../src/verified-process-stop.js";

const READER_SOURCE = readFileSync(
  fileURLToPath(
    new URL("../../process-utils/src/process-info.ts", import.meta.url),
  ),
  "utf8",
);
const QUERY_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
];
const QUERY_PREFIX = "Get-CimInstance Win32_Process -Filter 'ProcessId = ";
const QUERY_SUFFIX =
  "' | ForEach-Object { @{ command = $_.CommandLine; startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }";
const READER_FRAGMENTS = [
  '"WindowsPowerShell"',
  '"powershell.exe"',
  '"-NoProfile"',
  '"-NonInteractive"',
  '"-Command"',
  ...QUERY_PRELUDE.map((line) => JSON.stringify(line)),
  `${QUERY_PREFIX}\${pid}${QUERY_SUFFIX}`,
  '].join("; ")',
  'encoding: "utf8"',
  "windowsHide: true",
  "timeout: 30_000",
  "maxBuffer: 1024 * 1024",
  "pending.child.stdin?.end()",
];
const PRODUCTION_TIMEOUT_MS = 30_000;
const RAW_QUERY_TIMEOUT_MS = 40_000;
const STARTUP_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 2_000;

const evidence: Record<string, unknown> = {
  platform: process.platform,
  node: process.version,
};

function checkpoint(key: string, value: unknown): void {
  evidence[key] = value;
  const evidenceDir = process.env.CR35_EVIDENCE_DIR;
  if (evidenceDir === undefined) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    path.join(evidenceDir, "verified-process-stop.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

async function phase<T>(
  key: string,
  run: () => Promise<T>,
  describe: (value: T) => unknown = (value) => value,
): Promise<T> {
  const startedAt = performance.now();
  checkpoint(key, { state: "started" });
  try {
    const value = await run();
    checkpoint(key, {
      durationMs: Math.round(performance.now() - startedAt),
      result: describe(value),
    });
    return value;
  } catch (error) {
    checkpoint(key, {
      durationMs: Math.round(performance.now() - startedAt),
      error: String(error),
    });
    throw error;
  }
}

interface PowerShellRun {
  exitCode: number | null;
  errorCode: string | null;
  signal: string | null;
  killedByTimeout: boolean;
  stdout: string;
  stderr: string;
}

function clip(text: string): string {
  return text.length > OUTPUT_LIMIT
    ? `${text.slice(0, OUTPUT_LIMIT)}...[${text.length} chars]`
    : text;
}

function runPowerShell(
  command: string,
  timeoutMs: number,
): Promise<PowerShellRun> {
  return new Promise((resolve) => {
    const child = execFile(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : null,
          errorCode:
            error !== null && typeof error.code === "string"
              ? error.code
              : null,
          signal: error?.signal ?? null,
          killedByTimeout: error?.killed === true,
          stdout: clip(stdout),
          stderr: clip(stderr),
        });
      },
    );
    child.stdin?.end();
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeQuery(run: PowerShellRun, token: string, startedAt: string) {
  const parsed = parseJson(run.stdout);
  const isObject = typeof parsed === "object" && parsed !== null;
  const command = isObject && "command" in parsed ? parsed.command : null;
  const actualStart =
    isObject && "startedAt" in parsed ? parsed.startedAt : null;
  return {
    ...run,
    commandContainsToken:
      typeof command === "string" && command.includes(token),
    startedAtDeltaMs:
      typeof actualStart === "number"
        ? actualStart - Date.parse(startedAt)
        : null,
  };
}

it("verifies a real process's command and start time before stopping it", async () => {
  const missingFragments = READER_FRAGMENTS.filter(
    (fragment) => !READER_SOURCE.includes(fragment),
  );
  checkpoint("reader", {
    sha256: createHash("sha256").update(READER_SOURCE).digest("hex"),
    missingFragments,
    productionTimeoutMs: PRODUCTION_TIMEOUT_MS,
  });
  expect(missingFragments).toEqual([]);
  const token = `bb-process-identity-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  const child = spawn(
    process.execPath,
    [
      "-e",
      'setInterval(() => {}, 1000); process.stdout.write("ready");',
      token,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  onTestFinished(async () => {
    child.kill("SIGKILL");
    await closed;
  });
  await once(child.stdout, "data");
  if (child.pid === undefined) throw new Error("Child did not start");
  const pid = child.pid;
  checkpoint("child", { pid, token, startedAt });
  const readStartedAt = Date.now();
  const identity = await phase("identityRead", () => readProcessIdentity(pid));
  const readReport = `identity read for pid ${pid} returned ${JSON.stringify(identity)} after ${Date.now() - readStartedAt}ms`;
  expect.soft(identity?.command ?? "", readReport).toContain(token);
  expect.soft(identity?.startedAt ?? null, readReport).not.toBeNull();
  if (process.platform === "win32") {
    await phase(
      "rawQuery",
      () =>
        runPowerShell(
          [...QUERY_PRELUDE, `${QUERY_PREFIX}${pid}${QUERY_SUFFIX}`].join(
            "; ",
          ),
          RAW_QUERY_TIMEOUT_MS,
        ),
      (run) => describeQuery(run, token, startedAt),
    );
    await phase("powerShellStartup", () =>
      runPowerShell("exit 0", STARTUP_TIMEOUT_MS),
    );
  }
  const args = {
    pid,
    startedAt,
    signal: "SIGTERM" as const,
    timeoutMs: 2_000,
    killTimeoutMs: 2_000,
    verifyTokens: [token],
  };
  const commandControl = await phase("commandControl", () =>
    stopVerifiedProcess({ ...args, verifyTokens: ["wrong-token"] }),
  );
  expect.soft(commandControl).toMatchObject({
    kind: "unverified",
    reason: "command",
  });
  const runningAfterCommandControl = isProcessRunning(pid);
  checkpoint("runningAfterCommandControl", runningAfterCommandControl);
  expect.soft(runningAfterCommandControl).toBe(true);
  const startTimeControl = await phase("startTimeControl", () =>
    stopVerifiedProcess({ ...args, startedAt: "2000-01-01T00:00:00Z" }),
  );
  expect.soft(startTimeControl).toMatchObject({
    kind: "unverified",
    reason: "start-time",
  });
  const runningAfterStartTimeControl = isProcessRunning(pid);
  checkpoint("runningAfterStartTimeControl", runningAfterStartTimeControl);
  expect.soft(runningAfterStartTimeControl).toBe(true);
  const stopped = await phase("stop", () => stopVerifiedProcess(args));
  expect.soft(stopped).toEqual({
    kind: "stopped",
    usedKill: false,
  });
  const runningAfterStop = isProcessRunning(pid);
  checkpoint("runningAfterStop", runningAfterStop);
  expect.soft(runningAfterStop).toBe(false);
}, 200_000);
