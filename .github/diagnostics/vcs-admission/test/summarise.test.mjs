import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown, summarise } from "../summarise.mjs";

function admission(id, label, t, gitPid, { taskkillMs = null, taskkillCode = 0, closeGap = 5, exitAt = 200 } = {}) {
  const events = [
    { t, ev: "queued", id, command: "git", label, priority: null },
    { t: t + 1, ev: "granted", id },
    { t: t + 2, ev: "spawn", via: "spawn", pid: gitPid, exe: "git.exe", label },
  ];
  if (taskkillMs !== null) {
    events.push({ t: t + 102, ev: "spawn", via: "execFile", pid: gitPid + 1000, exe: "taskkill.exe", label: null, targets: [gitPid], tree: true, force: true });
    events.push({ t: t + 102 + taskkillMs, ev: "exit", pid: gitPid + 1000, exe: "taskkill.exe", code: taskkillCode, signal: null, ms: taskkillMs });
    events.push({ t: t + 103 + taskkillMs, ev: "kill", pid: gitPid, signal: "SIGKILL", sent: true, exited: false });
  }
  events.push({ t: t + exitAt, ev: "exit", pid: gitPid, exe: "git.exe", code: 1, signal: null, ms: exitAt - 2 });
  if (closeGap !== null) events.push({ t: t + exitAt + closeGap, ev: "close", pid: gitPid, exe: "git.exe", code: 1, signal: null, ms: exitAt + closeGap - 2 });
  events.push({ t: t + exitAt + (closeGap ?? 30_000) + 1, ev: "released", id });
  return events;
}

const results = (failure) => ({
  testResults: [
    {
      assertionResults: [
        { title: "admits only the background share", status: "passed", duration: 900 },
        { title: "releases admission after real git exit, spawn, and timeout failures", status: failure ? "failed" : "passed", duration: failure ? 20_010 : 3_000, failureMessages: failure ? ["Error: Test timed out in 20000ms.\n    at stack"] : [] },
      ],
    },
  ],
});

describe("diagnostic summary", () => {
  it("reconstructs a stalled timeout: slow failing taskkill, pipe held after exit and a surviving grandchild", () => {
    const events = [
      ...admission(1, "bb-delay", 1_000, 10, { taskkillMs: 150 }),
      ...admission(2, "bb-delay", 1_000.5, 20, { taskkillMs: 2_400, taskkillCode: 1, closeGap: null, exitAt: 2_600 }),
      { t: 1_000.7, ev: "queued", id: 3, command: "git", label: "--version", priority: null },
      { t: 1_000.8, ev: "granted", id: 3 },
      { t: 1_000.9, ev: "released", id: 3 },
    ];
    const tree = [
      { pid: 100, ppid: 9, name: "node.exe", created: 1, parent: null, goneAt: 26_000 },
      { pid: 21, ppid: 20, name: "sh.exe", created: 2, parent: "20@2", goneAt: 3_000 },
      { pid: 22, ppid: 21, name: "node.exe", created: 3, parent: "21@2", goneAt: null },
    ];
    const summary = summarise({ events, tree, results: results(true), identity: { head: "h", base: "b" }, vitest: { code: 1, exitedAt: 25_000 } });
    assert.deepEqual(summary.flags, {
      timedOutTests: ["releases admission after real git exit, spawn, and timeout failures"],
      failedTests: ["releases admission after real git exit, spawn, and timeout failures"],
      taskkillOverBudget: 1,
      taskkillFailed: 1,
      pipesHeldAfterExit: [2],
      unmatchedGitSpawns: 0,
    });
    const stalled = summary.admissions.find((chain) => chain.id === 2);
    assert.equal(stalled.gitPid, 20);
    assert.equal(stalled.taskkill.elapsedMs, 2_400);
    assert.equal(stalled.neverClosed, true);
    assert.deepEqual(stalled.rootKills, [{ signal: "SIGKILL", sent: true, exited: false }]);
    assert.equal(summary.admissions.find((chain) => chain.id === 3).gitPid, null, "an admission that threw before spawning is not matched to a later spawn");
    assert.deepEqual(summary.tree.aliveAfterVitestExit, ["node.exe#22"]);
    assert.deepEqual(summary.tree.aliveAtEnd, ["node.exe#22"]);
    const markdown = renderMarkdown(summary);
    assert.match(markdown, /\| 2 \| bb-delay \| .* \| 20 \| 2400 \(1\) \| .* \| never \|/u);
    assert.match(markdown, /A pass does not establish/u);
  });

  it("raises no flags for a clean run", () => {
    const events = [...admission(1, "bb-delay", 1_000, 10, { taskkillMs: 120 }), ...admission(2, "bb-delay", 1_001, 20, { taskkillMs: 130 })];
    const summary = summarise({ events, tree: [], results: results(false), identity: {}, vitest: { code: 0, exitedAt: 5_000 } });
    assert.deepEqual(summary.flags, { timedOutTests: [], failedTests: [], taskkillOverBudget: 0, taskkillFailed: 0, pipesHeldAfterExit: [], unmatchedGitSpawns: 0 });
  });
});
