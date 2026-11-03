import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const SAMPLE_INTERVAL_MS = 250;
export const ROOT_CREATION_TOLERANCE_MS = 2_000;

export const windowsSampler = (boundaryPath) => `
$ErrorActionPreference = 'Stop'
$boundary = '${String(boundaryPath).replaceAll("'", "''")}'
while ($true) {
  try {
    $after = if (Test-Path -LiteralPath $boundary) { 1 } else { 0 }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $rows = foreach ($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)) {
      $created = if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
      '{0},{1},{2},{3}' -f $p.ProcessId, $p.ParentProcessId, $created, $p.Name
    }
    [Console]::Out.WriteLine("S\`t$now\`t$after\`t" + ($rows -join "\`t"))
    [Console]::Out.Flush()
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
  Start-Sleep -Milliseconds ${SAMPLE_INTERVAL_MS}
}
`;

export function parseWindowsLine(line) {
  const fields = line.split("\t");
  if (fields[0] !== "S" || fields.length < 3 || !/^\d+$/u.test(fields[1]) || (fields[2] !== "0" && fields[2] !== "1")) return null;
  const processes = [];
  for (const row of fields.slice(3)) {
    const match = /^(\d+),(\d+),(\d+),(.*)$/u.exec(row);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), created: Number(match[3]), name: match[4] });
  }
  return { t: Number(fields[1]), afterBoundary: fields[2] === "1", processes };
}

export function createTreeTracker(rootPid, rootSpawnedAt) {
  const incarnations = new Map();
  const byPid = new Map();
  const records = new Map();
  let rootKey = null;
  const key = (process) => `${process.pid}@${process.created}`;

  function latestIncarnation(pid, createdBy) {
    let latest = null;
    for (const candidate of byPid.get(pid) ?? []) {
      if (candidate.created <= createdBy && (latest === null || candidate.created > latest.created)) latest = candidate;
    }
    return latest;
  }

  function ownedParent(incarnation) {
    const parent = latestIncarnation(incarnation.ppid, incarnation.created);
    if (parent === null || !parent.owned) return null;
    return incarnation.created <= parent.lastSeen ? parent : null;
  }

  function adopt(incarnation, parent, t, events) {
    incarnation.owned = true;
    const record = {
      pid: incarnation.pid,
      ppid: incarnation.ppid,
      name: incarnation.name,
      created: incarnation.created,
      parent: parent === null ? null : parent.key,
      firstSeen: incarnation.firstSeen,
      lastSeen: incarnation.lastSeen,
      goneAt: incarnation.goneAt,
    };
    incarnation.record = record;
    records.set(incarnation.key, record);
    events.push({ ev: "seen", t, ...record });
  }

  return {
    records,
    get rootKey() {
      return rootKey;
    },
    get observedIncarnations() {
      return incarnations.size;
    },
    update({ t, processes }, { rootBindable = false } = {}) {
      const events = [];
      const present = new Set();
      for (const process of processes) {
        const processKey = key(process);
        present.add(processKey);
        let incarnation = incarnations.get(processKey);
        if (incarnation === undefined) {
          incarnation = { key: processKey, ...process, firstSeen: t, lastSeen: t, goneAt: null, owned: false, record: null };
          incarnations.set(processKey, incarnation);
          byPid.set(process.pid, [...(byPid.get(process.pid) ?? []), incarnation]);
        } else {
          incarnation.lastSeen = t;
        }
      }
      for (const incarnation of incarnations.values()) {
        if (!present.has(incarnation.key) && incarnation.goneAt === null) {
          incarnation.goneAt = t;
          if (incarnation.owned) events.push({ ev: "gone", t, pid: incarnation.pid, name: incarnation.name, created: incarnation.created });
        }
      }
      let adopted = true;
      while (adopted) {
        adopted = false;
        for (const incarnation of incarnations.values()) {
          if (incarnation.owned) continue;
          if (rootBindable && rootKey === null && present.has(incarnation.key) && incarnation.pid === rootPid && Math.abs(incarnation.created - rootSpawnedAt) <= ROOT_CREATION_TOLERANCE_MS) {
            rootKey = incarnation.key;
            adopt(incarnation, null, t, events);
            adopted = true;
            continue;
          }
          const parent = ownedParent(incarnation);
          if (parent !== null) {
            adopt(incarnation, parent, t, events);
            adopted = true;
          }
        }
      }
      for (const incarnation of incarnations.values()) {
        if (incarnation.record !== null) {
          incarnation.record.lastSeen = incarnation.lastSeen;
          incarnation.record.goneAt = incarnation.goneAt;
        }
      }
      return events;
    },
    alive() {
      return [...records.values()].filter((record) => record.goneAt === null);
    },
  };
}

export async function cleanupOwned({ tracker, latestSnapshot, now, maxAgeMs, kill }) {
  const results = [];
  for (const candidate of tracker.alive().map((record) => ({ key: `${record.pid}@${record.created}`, pid: record.pid, name: record.name, created: record.created }))) {
    const label = { pid: candidate.pid, name: candidate.name, created: candidate.created };
    const record = tracker.records.get(candidate.key);
    const snapshot = latestSnapshot();
    if (record === undefined || record.goneAt !== null) {
      results.push({ ...label, skipped: "no longer alive in the owned tree" });
      continue;
    }
    if (snapshot === null || now() - snapshot.t > maxAgeMs) {
      results.push({ ...label, skipped: `no snapshot within ${maxAgeMs} ms` });
      continue;
    }
    const current = snapshot.processes.find((process) => process.pid === record.pid);
    if (current === undefined || current.created !== record.created) {
      results.push({ ...label, skipped: current === undefined ? "absent from the latest snapshot" : "the pid now belongs to another process" });
      continue;
    }
    results.push({ ...label, ...(await kill(record.pid)) });
  }
  return results;
}

export function startSampler(kind, { onSnapshot, onError, onExit, boundaryPath }) {
  if (kind === "none") return { pid: null, stop: () => Promise.resolve() };
  let stopping = false;
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsSampler(boundaryPath), "utf16le").toString("base64")], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.on("error", onError);
  child.once("exit", (code, signal) => {
    if (!stopping) onExit({ code, signal, at: Date.now() });
  });
  child.stderr.on("data", (chunk) => onError(new Error(String(chunk).slice(0, 500))));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const snapshot = parseWindowsLine(line);
    if (snapshot) onSnapshot(snapshot);
  });
  return {
    pid: child.pid ?? null,
    stop: () =>
      new Promise((resolve) => {
        stopping = true;
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return resolve();
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
}

export function assessCoverage({ sampler, snapshotTimes, spawnedAt, observedUntil, maxGapMs, rootObserved, samplerExit, results, expectedTests }) {
  const problems = [];
  const ran = new Map();
  for (const file of results?.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) ran.set(assertion.title, assertion.status);
  }
  for (const name of expectedTests) {
    const status = ran.get(name);
    if (status !== "passed" && status !== "failed") problems.push(`test "${name}" did not run (status ${status ?? "absent"})`);
  }
  if (sampler === "none") {
    problems.push("process sampling was disabled");
    return { complete: false, problems, snapshots: 0, maxGapMs: null };
  }
  if (samplerExit) problems.push(`the sampler exited unexpectedly at ${samplerExit.at} (code ${samplerExit.code}, signal ${samplerExit.signal})`);
  if (!rootObserved) problems.push("the Vitest process was never observed, so no owned tree exists");
  const inside = snapshotTimes.filter((time) => time > spawnedAt && time <= observedUntil).sort((a, b) => a - b);
  const points = [spawnedAt, ...inside, observedUntil];
  let largest = 0;
  for (let index = 1; index < points.length; index += 1) largest = Math.max(largest, points[index] - points[index - 1]);
  if (largest > maxGapMs) problems.push(`the largest gap between snapshots from Vitest start to the end of observation was ${largest} ms, over ${maxGapMs} ms`);
  return { complete: problems.length === 0, problems, snapshots: inside.length, maxGapMs: largest };
}
