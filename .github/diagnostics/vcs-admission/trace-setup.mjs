import { appendFileSync, mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterAll, afterEach, beforeEach } from "vitest";
import "../../../packages/process-utils/src/vcs-process-scheduler.ts";
import { createTrace, instrumentChildProcess, instrumentScheduler, schedulerSnapshot } from "./trace-core.mjs";

const directory = process.env.BB_VCS_DIAG_DIR;
const state = (globalThis.__bbVcsAdmissionDiagnostic ??= {});

if (directory) {
  if (state.trace === undefined) {
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `events-${process.pid}.jsonl`);
    state.trace = createTrace({ write: (line) => appendFileSync(file, `${line}\n`) });
    state.trace.record({
      ev: "trace-start",
      pid: process.pid,
      ppid: process.ppid,
      node: process.version,
      platform: process.platform,
      parallelism: availableParallelism(),
    });
    instrumentChildProcess(state.trace, createRequire(import.meta.url)("node:child_process"), ChildProcess, syncBuiltinESMExports);
    instrumentScheduler(state.trace, globalThis.__bbVcsProcessScheduler);
  }
  const trace = state.trace;
  const scheduler = () => schedulerSnapshot(globalThis.__bbVcsProcessScheduler);
  beforeEach((context) => {
    trace.record({ ev: "test-start", name: context.task.name, scheduler: scheduler() });
  });
  afterEach((context) => {
    trace.record({
      ev: "test-end",
      name: context.task.name,
      state: context.task.result?.state ?? null,
      live: trace.liveChildren(),
      scheduler: scheduler(),
    });
  });
  afterAll(() => {
    trace.record({ ev: "file-end", live: trace.liveChildren(), scheduler: scheduler() });
  });
}
