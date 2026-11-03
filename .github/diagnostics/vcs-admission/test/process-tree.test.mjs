import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessCoverage, cleanupOwned, createTreeTracker, parseWindowsLine, windowsSampler } from "../process-tree.mjs";

const proc = (pid, ppid, created, name) => ({ pid, ppid, created, name });
const owned = (tracker) => [...tracker.records.values()].map((record) => `${record.name}#${record.pid}`).sort();

describe("snapshot parsing", () => {
  it("reads the Windows sampler line with its boundary flag, keeping commas in names", () => {
    assert.deepEqual(parseWindowsLine("S\t1000\t1\t4,0,0,System\t100,4,900,node.exe\t101,100,950,odd,name.exe"), {
      t: 1000,
      afterBoundary: true,
      processes: [proc(4, 0, 0, "System"), proc(100, 4, 900, "node.exe"), proc(101, 100, 950, "odd,name.exe")],
    });
    assert.equal(parseWindowsLine("S\t1000\t0\t4,0,0,System").afterBoundary, false);
    assert.equal(parseWindowsLine("S\t1000\t4,0,0,System"), null, "a row without the boundary flag is not a snapshot");
    assert.equal(parseWindowsLine("S\t1000\t2\t4,0,0,System"), null);
    assert.equal(parseWindowsLine("not a snapshot"), null);
  });

  it("checks the boundary file before reading the clock and the process table, with the path quoted for PowerShell", () => {
    const script = windowsSampler("D:\\a\\_temp\\it's\\spawn-boundary");
    assert.ok(script.includes("$boundary = 'D:\\a\\_temp\\it''s\\spawn-boundary'"));
    const check = script.indexOf("Test-Path -LiteralPath $boundary");
    assert.ok(check > 0 && check < script.indexOf("UtcNow") && script.indexOf("UtcNow") < script.indexOf("Get-CimInstance"));
    assert.ok(script.includes("$now`t$after`t"));
  });
});

describe("owned process tree", () => {
  it("follows descendants, keeps established orphans after their parent exits and records when each goes", () => {
    const tracker = createTreeTracker(100, 10);
    const unrelated = proc(50, 4, 5, "svchost.exe");
    const first = tracker.update({
      t: 1_000,
      processes: [unrelated, proc(202, 201, 40, "node.exe"), proc(201, 200, 35, "sh.exe"), proc(200, 101, 30, "git.exe"), proc(101, 100, 20, "node.exe"), proc(100, 9, 10, "node.exe")],
    }, { rootBindable: true });
    assert.deepEqual(first.map((event) => event.pid).sort(), [100, 101, 200, 201, 202]);
    const second = tracker.update({ t: 2_000, processes: [unrelated, proc(202, 201, 40, "node.exe"), proc(201, 200, 35, "sh.exe"), proc(100, 9, 10, "node.exe"), proc(101, 100, 20, "node.exe")] });
    assert.deepEqual(second, [{ ev: "gone", t: 2_000, pid: 200, name: "git.exe", created: 30 }]);
    tracker.update({ t: 3_000, processes: [unrelated, proc(202, 201, 40, "node.exe")] });
    assert.deepEqual(tracker.alive().map((record) => `${record.name}#${record.pid}`), ["node.exe#202"]);
    assert.deepEqual(owned(tracker), ["git.exe#200", "node.exe#100", "node.exe#101", "node.exe#202", "sh.exe#201"]);
  });

  it("never adopts the child of a process that reused an owned pid, including after that process exits", () => {
    const tracker = createTreeTracker(100, 10);
    tracker.update({ t: 1_000, processes: [proc(100, 9, 10, "node.exe"), proc(200, 100, 200, "git.exe")] }, { rootBindable: true });
    tracker.update({ t: 2_000, processes: [proc(100, 9, 10, "node.exe")] });
    assert.deepEqual(tracker.update({ t: 3_000, processes: [proc(100, 9, 10, "node.exe"), proc(200, 7, 2_500, "other.exe"), proc(300, 200, 2_600, "child.exe")] }), []);
    assert.deepEqual(tracker.update({ t: 4_000, processes: [proc(100, 9, 10, "node.exe"), proc(300, 200, 2_600, "child.exe")] }), []);
    assert.deepEqual(tracker.update({ t: 5_000, processes: [proc(300, 200, 2_600, "child.exe")] }), [{ ev: "gone", t: 5_000, pid: 100, name: "node.exe", created: 10 }]);
    assert.deepEqual(owned(tracker), ["git.exe#200", "node.exe#100"]);
    assert.deepEqual(tracker.alive(), []);
  });

  it("does not adopt a child created after its owned parent was last seen, even if the reusing parent was never sampled", () => {
    const tracker = createTreeTracker(100, 10);
    tracker.update({ t: 1_000, processes: [proc(100, 9, 10, "node.exe"), proc(200, 100, 200, "git.exe")] }, { rootBindable: true });
    assert.deepEqual(tracker.update({ t: 3_000, processes: [proc(100, 9, 10, "node.exe"), proc(300, 200, 2_600, "child.exe")] }).map((event) => event.ev), ["gone"]);
    assert.deepEqual(owned(tracker), ["git.exe#200", "node.exe#100"]);
  });

  it("adopts a child first seen with its parent once the parent has been seen alive after the child's creation", () => {
    const tracker = createTreeTracker(100, 10);
    tracker.update({ t: 1_000, processes: [proc(100, 9, 10, "node.exe")] }, { rootBindable: true });
    assert.deepEqual(tracker.update({ t: 2_000, processes: [proc(100, 9, 10, "node.exe"), proc(200, 100, 2_100, "git.exe")] }), []);
    assert.deepEqual(tracker.update({ t: 3_000, processes: [proc(100, 9, 10, "node.exe"), proc(200, 100, 2_100, "git.exe")] }).map((event) => event.pid), [200]);
  });

  it("takes as root only the process created when the driver started it", () => {
    const stale = createTreeTracker(100, 50_000);
    assert.deepEqual(stale.update({ t: 51_000, processes: [proc(100, 9, 10, "node.exe"), proc(200, 100, 20, "git.exe")] }, { rootBindable: true }), []);
    assert.equal(stale.rootKey, null);
    const fresh = createTreeTracker(100, 50_000);
    fresh.update({ t: 51_000, processes: [proc(100, 9, 50_020, "node.exe")] }, { rootBindable: true });
    assert.equal(fresh.rootKey, "100@50020");
  });

  it("never binds a root from a snapshot processed after the driver saw Vitest exit, even within the creation window", () => {
    const tracker = createTreeTracker(100, 1_000);
    assert.deepEqual(tracker.update({ t: 1_050, processes: [proc(7, 4, 1, "other.exe")] }, { rootBindable: true }), []);
    const afterExit = { t: 2_000, processes: [proc(100, 9, 1_900, "node.exe"), proc(101, 100, 1_950, "node.exe")] };
    assert.deepEqual(tracker.update(afterExit), []);
    assert.deepEqual(tracker.update({ ...afterExit, t: 3_000 }), []);
    assert.equal(tracker.rootKey, null);
    assert.deepEqual(tracker.alive(), []);
  });

  it("ignores a buffered predecessor row with the same pid and binds the real Vitest incarnation from a later snapshot", () => {
    const tracker = createTreeTracker(600, 1_000);
    const buffered = { t: 900, processes: [proc(600, 9, 100, "node.exe"), proc(602, 600, 200, "node.exe")] };
    assert.deepEqual(tracker.update(buffered, { rootBindable: false }), []);
    const fresh = { t: 1_300, processes: [proc(602, 600, 200, "node.exe"), proc(600, 8, 1_010, "node.exe"), proc(610, 600, 1_200, "node.exe")] };
    assert.deepEqual(tracker.update(fresh, { rootBindable: true }).map((event) => event.pid), [600, 610]);
    assert.equal(tracker.rootKey, "600@1010");
    assert.deepEqual(owned(tracker), ["node.exe#600", "node.exe#610"]);
  });

  it("does not bind a root first seen in a snapshot processed while unbindable", () => {
    const tracker = createTreeTracker(100, 1_000);
    tracker.update({ t: 1_500, processes: [proc(100, 9, 1_010, "node.exe")] });
    assert.deepEqual(tracker.update({ t: 2_500, processes: [proc(7, 4, 1, "other.exe")] }, { rootBindable: true }), []);
    assert.equal(tracker.rootKey, null);
  });
});

describe("observation coverage", () => {
  const passed = {
    testResults: [{ assertionResults: [{ title: "a", status: "passed" }, { title: "b", status: "failed" }] }],
  };
  const base = { sampler: "windows", spawnedAt: 1_000, observedUntil: 10_000, maxGapMs: 3_000, rootObserved: true, samplerExit: null, results: passed, expectedTests: ["a", "b"] };

  it("is complete with fresh snapshots from start to the end of observation and both tests run", () => {
    const coverage = assessCoverage({ ...base, snapshotTimes: [500, 1_400, 3_000, 5_500, 8_000, 9_900] });
    assert.deepEqual(coverage, { complete: true, problems: [], snapshots: 5, maxGapMs: 2_500 });
  });

  it("is incomplete when the sampler gave one snapshot before the test and stopped, even if Vitest passed", () => {
    const coverage = assessCoverage({ ...base, snapshotTimes: [900], rootObserved: false, samplerExit: { code: 0, signal: null, at: 950 } });
    assert.equal(coverage.complete, false);
    assert.equal(coverage.snapshots, 0);
    assert.match(coverage.problems.join("\n"), /exited unexpectedly/u);
    assert.match(coverage.problems.join("\n"), /never observed/u);
    assert.match(coverage.problems.join("\n"), /largest gap .* 9000 ms/u);
  });

  it("is incomplete when sampling stops before the end of observation or a test did not run", () => {
    assert.match(assessCoverage({ ...base, snapshotTimes: [1_200, 3_000, 5_000] }).problems.join(), /largest gap .* 5000 ms/u);
    const skipped = { testResults: [{ assertionResults: [{ title: "a", status: "passed" }, { title: "b", status: "skipped" }] }] };
    assert.match(assessCoverage({ ...base, results: skipped, snapshotTimes: [2_000, 4_000, 6_000, 8_000, 9_900] }).problems.join(), /"b" did not run \(status skipped\)/u);
    assert.match(assessCoverage({ ...base, results: null, snapshotTimes: [2_000, 4_000, 6_000, 8_000, 9_900] }).problems.join(), /"a" did not run \(status absent\)/u);
  });

  it("is incomplete without sampling", () => {
    assert.deepEqual(assessCoverage({ ...base, sampler: "none", snapshotTimes: [] }).problems, ["process sampling was disabled"]);
  });
});

describe("owned cleanup", () => {
  function setup() {
    const clock = { now: 1_000 };
    const tracker = createTreeTracker(100, 10);
    let latest = { t: 1_000, processes: [proc(100, 9, 10, "node.exe"), proc(601, 100, 20, "git.exe"), proc(602, 100, 30, "git.exe")] };
    tracker.update(latest, { rootBindable: true });
    tracker.update({ ...latest, processes: latest.processes.filter((entry) => entry.pid !== 100) });
    const kills = [];
    return {
      clock,
      tracker,
      kills,
      latestSnapshot: () => latest,
      setLatest: (snapshot) => {
        latest = snapshot;
        tracker.update(snapshot);
      },
    };
  }

  it("rechecks each target after a slow kill and refuses a pid reused while it waited", async () => {
    const state = setup();
    const kill = async (pid) => {
      state.kills.push(pid);
      if (pid === 601) {
        state.clock.now = 5_000;
        state.setLatest({ t: 4_900, processes: [proc(602, 7, 4_500, "unrelated.exe")] });
      }
      return { code: 0 };
    };
    const results = await cleanupOwned({ tracker: state.tracker, latestSnapshot: state.latestSnapshot, now: () => state.clock.now, maxAgeMs: 3_000, kill });
    assert.deepEqual(state.kills, [601]);
    assert.deepEqual(results.map((entry) => [entry.pid, entry.skipped ?? entry.code]), [[601, 0], [602, "no longer alive in the owned tree"]]);
  });

  it("refuses to kill when the latest snapshot is too old or names another process", async () => {
    const state = setup();
    const kill = async (pid) => {
      state.kills.push(pid);
      state.clock.now = 5_000;
      return { code: 0 };
    };
    const stale = await cleanupOwned({ tracker: state.tracker, latestSnapshot: state.latestSnapshot, now: () => state.clock.now, maxAgeMs: 3_000, kill });
    assert.deepEqual(state.kills, [601]);
    assert.equal(stale[1].skipped, "no snapshot within 3000 ms");
    const other = setup();
    other.clock.now = 1_500;
    const reused = { t: 1_400, processes: [proc(601, 7, 1_300, "unrelated.exe"), proc(602, 100, 30, "git.exe")] };
    const results = await cleanupOwned({ tracker: other.tracker, latestSnapshot: () => reused, now: () => other.clock.now, maxAgeMs: 3_000, kill: async (pid) => (other.kills.push(pid), { code: 0 }) });
    assert.deepEqual(other.kills, [602]);
    assert.equal(results[0].skipped, "the pid now belongs to another process");
  });
});
