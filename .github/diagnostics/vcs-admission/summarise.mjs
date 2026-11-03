export const TASKKILL_BUDGET_MS = 2_000;
export const PIPE_HELD_MS = 500;

const isGit = (exe) => /^git(\.exe)?$/u.test(exe ?? "");
const isTaskkill = (exe) => /^taskkill(\.exe)?$/u.test(exe ?? "");
const round = (value) => (value === null || value === undefined ? null : Number(value.toFixed(1)));

function testsFrom(results) {
  const tests = [];
  for (const file of results?.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      const message = (assertion.failureMessages ?? [])[0] ?? null;
      tests.push({
        name: assertion.title,
        status: assertion.status,
        durationMs: round(assertion.duration ?? null),
        failure: message === null ? null : message.split("\n")[0].slice(0, 300),
      });
    }
  }
  return tests;
}

export function summarise({ events, tree, results, identity, vitest }) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const admissions = new Map();
  const spawns = [];
  const exits = new Map();
  const closes = new Map();
  const kills = new Map();
  for (const event of sorted) {
    if (event.ev === "queued") admissions.set(event.id, { id: event.id, command: event.command, label: event.label, priority: event.priority, queued: event.t });
    else if (event.ev === "granted") Object.assign(admissions.get(event.id) ?? {}, { granted: event.t });
    else if (event.ev === "released") Object.assign(admissions.get(event.id) ?? {}, { released: event.t });
    else if (event.ev === "admission-rejected") Object.assign(admissions.get(event.id) ?? {}, { rejected: event.code ?? true });
    else if (event.ev === "spawn") spawns.push(event);
    else if (event.ev === "exit") exits.set(event.pid, event);
    else if (event.ev === "close") closes.set(event.pid, event);
    else if (event.ev === "kill") kills.set(event.pid, [...(kills.get(event.pid) ?? []), event]);
  }
  const taskkills = spawns.filter((event) => isTaskkill(event.exe)).map((event) => {
    const exit = exits.get(event.pid);
    return {
      pid: event.pid,
      targets: event.targets ?? [],
      start: event.t,
      elapsedMs: round(exit?.ms ?? null),
      code: exit?.code ?? null,
      signal: exit?.signal ?? null,
      overBudget: exit === undefined || exit.ms > TASKKILL_BUDGET_MS,
    };
  });
  const matched = new Set();
  const chains = [];
  for (const admission of [...admissions.values()].sort((a, b) => a.queued - b.queued)) {
    const spawn = spawns.find(
      (event) =>
        isGit(event.exe) &&
        !matched.has(event.pid) &&
        event.label === admission.label &&
        admission.granted !== undefined &&
        event.t >= admission.granted &&
        (admission.released === undefined || event.t <= admission.released),
    );
    if (spawn) matched.add(spawn.pid);
    const exit = spawn ? exits.get(spawn.pid) : undefined;
    const close = spawn ? closes.get(spawn.pid) : undefined;
    const kill = spawn ? taskkills.find((entry) => entry.targets.includes(spawn.pid)) : undefined;
    chains.push({
      id: admission.id,
      label: admission.label,
      priority: admission.priority,
      waitMs: round(admission.granted === undefined ? null : admission.granted - admission.queued),
      holdMs: round(admission.granted === undefined || admission.released === undefined ? null : admission.released - admission.granted),
      rejected: admission.rejected ?? null,
      gitPid: spawn?.pid ?? null,
      pidMatch: spawn ? "inferred" : "none",
      spawnToTaskkillMs: round(kill && spawn ? kill.start - spawn.t : null),
      taskkill: kill ? { elapsedMs: kill.elapsedMs, code: kill.code, overBudget: kill.overBudget } : null,
      rootKills: spawn ? (kills.get(spawn.pid) ?? []).map((event) => ({ signal: event.signal, sent: event.sent, exited: event.exited })) : [],
      exitMs: round(exit?.ms ?? null),
      exitCode: exit?.code ?? null,
      exitSignal: exit?.signal ?? null,
      closeAfterExitMs: round(exit && close ? close.t - exit.t : null),
      neverClosed: spawn !== undefined && close === undefined,
    });
  }
  const records = tree ?? [];
  const vitestExit = vitest?.exitedAt ?? null;
  const descendants = records.filter((record) => record.parent !== null);
  const aliveAfter = (record, t) => t !== null && (record.goneAt === null || record.goneAt > t);
  const tests = testsFrom(results);
  return {
    identity,
    vitest: vitest ?? null,
    tests,
    admissions: chains,
    taskkills,
    tree: {
      tracked: records.length,
      descendants: descendants.map((record) => ({
        pid: record.pid,
        ppid: record.ppid,
        name: record.name,
        created: record.created,
        goneAt: record.goneAt,
      })),
      aliveAfterVitestExit: descendants.filter((record) => aliveAfter(record, vitestExit)).map((record) => `${record.name}#${record.pid}`),
      aliveAtEnd: descendants.filter((record) => record.goneAt === null).map((record) => `${record.name}#${record.pid}`),
    },
    flags: {
      timedOutTests: tests.filter((test) => /timed out/iu.test(test.failure ?? "")).map((test) => test.name),
      failedTests: tests.filter((test) => test.status !== "passed").map((test) => test.name),
      taskkillOverBudget: taskkills.filter((entry) => entry.overBudget).length,
      taskkillFailed: taskkills.filter((entry) => entry.code !== null && entry.code !== 0).length,
      pipesHeldAfterExit: chains.filter((chain) => chain.neverClosed || (chain.closeAfterExitMs ?? 0) > PIPE_HELD_MS).map((chain) => chain.id),
      unmatchedGitSpawns: spawns.filter((event) => isGit(event.exe) && !matched.has(event.pid)).length,
    },
  };
}

export function renderMarkdown(summary) {
  const lines = ["## VCS admission diagnostic", ""];
  lines.push(`Source ${summary.identity?.head ?? "unknown"} (base ${summary.identity?.base ?? "unknown"}); vitest exit ${summary.vitest?.code ?? "unknown"}; outcome ${summary.outcome ?? "unknown"}.`, "");
  if (summary.coverage) {
    lines.push(
      summary.coverage.complete
        ? `Coverage complete: ${summary.coverage.snapshots} snapshots, largest gap ${summary.coverage.maxGapMs} ms.`
        : `INCOMPLETE: ${summary.coverage.problems.join("; ")}. Absent records below do not show that no process survived.`,
      "",
    );
  }
  lines.push("| Test | Status | ms | Failure |", "| --- | --- | ---: | --- |");
  for (const test of summary.tests) lines.push(`| ${test.name} | ${test.status} | ${test.durationMs ?? ""} | ${(test.failure ?? "").replaceAll("|", "/")} |`);
  lines.push("", "| Admission | Label | Wait ms | Hold ms | git pid | taskkill ms (code) | exit ms | close after exit ms |", "| ---: | --- | ---: | ---: | ---: | --- | ---: | ---: |");
  for (const chain of summary.admissions) {
    const kill = chain.taskkill ? `${chain.taskkill.elapsedMs ?? "none"} (${chain.taskkill.code ?? "none"})` : "";
    lines.push(`| ${chain.id} | ${chain.label ?? ""} | ${chain.waitMs ?? ""} | ${chain.holdMs ?? ""} | ${chain.gitPid ?? ""} | ${kill} | ${chain.exitMs ?? ""} | ${chain.neverClosed ? "never" : (chain.closeAfterExitMs ?? "")} |`);
  }
  lines.push("", `Owned descendants alive after vitest exit: ${summary.tree.aliveAfterVitestExit.join(", ") || "none"}.`);
  lines.push(`Owned descendants alive at the end of observation: ${summary.tree.aliveAtEnd.join(", ") || "none"}.`);
  lines.push(`Flags: ${JSON.stringify(summary.flags)}`);
  lines.push("", "git pids are matched to admissions by label and time order (inferred). A pass does not establish the earlier failure's cause.");
  return `${lines.join("\n")}\n`;
}
