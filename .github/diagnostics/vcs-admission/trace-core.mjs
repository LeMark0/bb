import path from "node:path";

const gitOptionsWithValue = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

export function executableName(file) {
  return path.win32.basename(String(file)).toLowerCase();
}

export function gitLabel(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  let index = 0;
  while (index < list.length && list[index].startsWith("-")) {
    index += gitOptionsWithValue.has(list[index]) ? 2 : 1;
  }
  return list[index] ?? list.at(-1) ?? null;
}

export function taskkillTargets(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const targets = [];
  for (let index = 0; index < list.length - 1; index += 1) {
    if (list[index].toLowerCase() === "/pid") targets.push(Number(list[index + 1]));
  }
  return {
    targets,
    tree: list.some((arg) => arg.toUpperCase() === "/T"),
    force: list.some((arg) => arg.toUpperCase() === "/F"),
  };
}

function describeLaunch(file, args) {
  const exe = executableName(file);
  const stem = exe.replace(/\.(exe|cmd|bat)$/u, "");
  if (stem === "git") return { exe, label: gitLabel(args) };
  if (stem === "taskkill") return { exe, label: null, ...taskkillTargets(args) };
  return { exe, label: null };
}

export function createTrace({ write, now = () => performance.timeOrigin + performance.now() }) {
  const live = new Map();
  return {
    now,
    live,
    record(event) {
      write(JSON.stringify({ t: Number(now().toFixed(3)), ...event }));
    },
    liveChildren() {
      return [...live.entries()].map(([pid, entry]) => ({ pid, exe: entry.exe, label: entry.label }));
    },
  };
}

export function schedulerSnapshot(scheduler) {
  if (scheduler === undefined || scheduler === null) return null;
  return {
    active: scheduler.active ? { ...scheduler.active } : null,
    githubActive: scheduler.githubActive ?? null,
    queued: Array.isArray(scheduler.queue) ? scheduler.queue.length : null,
  };
}

export function instrumentChildProcess(trace, childProcess, ChildProcessClass, syncExports) {
  const original = { spawn: childProcess.spawn, execFile: childProcess.execFile, kill: ChildProcessClass.prototype.kill };
  function observe(via, file, args, child) {
    const launch = describeLaunch(file, Array.isArray(args) ? args : []);
    const pid = child?.pid;
    if (pid === undefined) {
      trace.record({ ev: "spawn-failed", via, ...launch });
      return;
    }
    const started = trace.now();
    trace.live.set(pid, { ...launch, started });
    trace.record({ ev: "spawn", via, pid, ...launch });
    child.once("exit", (code, signal) => {
      trace.live.delete(pid);
      trace.record({ ev: "exit", pid, exe: launch.exe, code, signal, ms: Number((trace.now() - started).toFixed(3)) });
    });
    child.once("close", (code, signal) => {
      trace.record({ ev: "close", pid, exe: launch.exe, code, signal, ms: Number((trace.now() - started).toFixed(3)) });
    });
  }
  childProcess.spawn = function spawn(file, args, ...rest) {
    const child = original.spawn.call(this, file, args, ...rest);
    observe("spawn", file, args, child);
    return child;
  };
  childProcess.execFile = function execFile(file, args, ...rest) {
    const child = original.execFile.call(this, file, args, ...rest);
    observe("execFile", file, args, child);
    return child;
  };
  ChildProcessClass.prototype.kill = function kill(signal) {
    const exited = this.exitCode !== null || this.signalCode !== null;
    const sent = original.kill.call(this, signal);
    trace.record({ ev: "kill", pid: this.pid ?? null, signal: signal ?? "SIGTERM", sent, exited });
    return sent;
  };
  syncExports();
  return () => {
    childProcess.spawn = original.spawn;
    childProcess.execFile = original.execFile;
    ChildProcessClass.prototype.kill = original.kill;
    syncExports();
  };
}

export function instrumentScheduler(trace, scheduler) {
  const original = scheduler.acquire;
  let sequence = 0;
  scheduler.acquire = function acquire(command, args, options) {
    const id = (sequence += 1);
    trace.record({
      ev: "queued",
      id,
      command,
      label: command === "git" ? gitLabel(args) : null,
      priority: options?.priority ?? null,
      scheduler: schedulerSnapshot(this),
    });
    return original.call(this, command, args, options).then(
      (release) => {
        trace.record({ ev: "granted", id, scheduler: schedulerSnapshot(this) });
        let released = false;
        return () => {
          if (!released) {
            released = true;
            trace.record({ ev: "released", id });
          }
          release();
        };
      },
      (error) => {
        trace.record({ ev: "admission-rejected", id, code: error?.code ?? null });
        throw error;
      },
    );
  };
  return () => {
    scheduler.acquire = original;
  };
}
