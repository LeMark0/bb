import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { ChildProcess, execFile as esmExecFile, spawn as esmSpawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { createTrace, gitLabel, instrumentChildProcess, instrumentScheduler, taskkillTargets } from "../trace-core.mjs";

const cjsChildProcess = createRequire(import.meta.url)("node:child_process");

function collect() {
  const events = [];
  return { events, trace: createTrace({ write: (line) => events.push(JSON.parse(line)) }) };
}

function settle(child) {
  return new Promise((resolve) => child.once("close", resolve));
}

describe("launch labels", () => {
  it("names the git subcommand after global options, or the lone option", () => {
    assert.equal(gitLabel(["-c", "alias.bb-delay=!node -e x", "bb-delay"]), "bb-delay");
    assert.equal(gitLabel(["-C", "/tmp/x", "status", "--short"]), "status");
    assert.equal(gitLabel(["bb-no-such-command"]), "bb-no-such-command");
    assert.equal(gitLabel(["--version"]), "--version");
    assert.equal(gitLabel([]), null);
  });

  it("reads taskkill targets and flags", () => {
    assert.deepEqual(taskkillTargets(["/pid", "12", "/PID", "13", "/T", "/F"]), { targets: [12, 13], tree: true, force: true });
    assert.deepEqual(taskkillTargets(["/PID", "7", "/F"]), { targets: [7], tree: false, force: true });
  });
});

describe("child process instrumentation", () => {
  it("records spawn, exit, close and kill through the ESM bindings that execa and host-process use", async () => {
    const { events, trace } = collect();
    const restore = instrumentChildProcess(trace, cjsChildProcess, ChildProcess, syncBuiltinESMExports);
    try {
      const quick = esmSpawn(process.execPath, ["-e", "process.exit(3)"]);
      await settle(quick);
      const slow = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
      slow.kill("SIGKILL");
      await settle(slow);
      const viaExecFile = await new Promise((resolve) => {
        const child = esmExecFile(process.execPath, ["-e", "process.exit(0)"], () => resolve(child));
      });
      assert.equal(trace.liveChildren().length, 0);
      const spawned = events.filter((event) => event.ev === "spawn");
      assert.deepEqual(spawned.map((event) => event.via), ["spawn", "spawn", "execFile"]);
      assert.equal(events.find((event) => event.ev === "exit" && event.pid === quick.pid).code, 3);
      assert.ok(events.some((event) => event.ev === "close" && event.pid === quick.pid));
      assert.deepEqual(
        events.filter((event) => event.ev === "kill").map(({ pid, signal, sent, exited }) => ({ pid, signal, sent, exited })),
        [{ pid: slow.pid, signal: "SIGKILL", sent: true, exited: false }],
      );
      assert.equal(events.find((event) => event.ev === "exit" && event.pid === slow.pid).signal, "SIGKILL");
      assert.ok(events.some((event) => event.ev === "exit" && event.pid === viaExecFile.pid));
    } finally {
      restore();
    }
    const before = events.length;
    await settle(esmSpawn(process.execPath, ["-e", "0"]));
    assert.equal(events.length, before, "restoring removes the instrumentation");
  });

  it("records a failed spawn without a pid and leaves the error to the caller", async () => {
    const { events, trace } = collect();
    const restore = instrumentChildProcess(trace, cjsChildProcess, ChildProcess, syncBuiltinESMExports);
    try {
      const child = esmSpawn("/nonexistent/git", ["--version"]);
      const error = await new Promise((resolve) => child.once("error", resolve));
      assert.equal(error.code, "ENOENT");
      assert.deepEqual(events.map(({ ev, exe, label }) => ({ ev, exe, label })), [{ ev: "spawn-failed", exe: "git", label: "--version" }]);
    } finally {
      restore();
    }
  });

  it("captures execa's spawn when BB_DIAG_EXECA names an installed execa", { skip: process.env.BB_DIAG_EXECA ? false : "BB_DIAG_EXECA is not set" }, async () => {
    const { events, trace } = collect();
    const restore = instrumentChildProcess(trace, cjsChildProcess, ChildProcess, syncBuiltinESMExports);
    try {
      const { execa } = await import(process.env.BB_DIAG_EXECA);
      const result = await execa(process.execPath, ["-e", "process.exit(0)"], { reject: false });
      assert.equal(result.exitCode, 0);
      assert.equal(events.filter((event) => event.ev === "spawn").length, 1);
    } finally {
      restore();
    }
  });
});

describe("scheduler instrumentation", () => {
  it("records queueing, grants and releases on the real scheduler without changing admission", async () => {
    const { runVcsProcess } = await import("../../../../packages/process-utils/src/vcs-process-scheduler.ts");
    const scheduler = globalThis.__bbVcsProcessScheduler;
    const { events, trace } = collect();
    const restore = instrumentScheduler(trace, scheduler);
    try {
      const gates = [];
      const running = [0, 1, 2].map((index) =>
        runVcsProcess("gh", ["api", String(index)], () => new Promise((resolve) => gates.push(() => resolve(index)))),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(gates.length, 2, "GitHub admission still allows two at a time");
      assert.deepEqual(events.map((event) => event.ev), ["queued", "queued", "queued", "granted", "granted"]);
      gates.shift()();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(gates.length, 2, "releasing one admits the third");
      for (const gate of gates.splice(0)) gate();
      assert.deepEqual(await Promise.all(running), [0, 1, 2]);
      assert.equal(events.filter((event) => event.ev === "released").length, 3);
      assert.deepEqual(scheduler.active, { local: 0, network: 0 });
      await assert.rejects(runVcsProcess("git", ["status"], async () => 0, { slots: 0 }), /Invalid VCS process slot count/u);
      assert.equal(events.at(-1).ev, "admission-rejected");
    } finally {
      restore();
    }
  });
});
