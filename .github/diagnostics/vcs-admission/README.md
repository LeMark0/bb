# VCS admission diagnostic

One bounded Windows run of `packages/process-utils/test/vcs-process-admission.test.ts` with tracing, to explain the 20 s timeout of "releases admission after real git exit, spawn, and timeout failures" on the hosted `windows-2025` runner. The later green CI run restored that package's tests from the Turbo cache, so the file has not run on Windows since the failure.

The test file, its assertions and timeouts, and the code under test are unchanged. `run.mjs` refuses to start unless the commit's parent is `d6d5e76a`, the commit changes only this folder and its workflow, and `packages/process-utils`, the root Vitest files, `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` match `d6d5e76a` in the commit and the working tree.

## What runs

`.github/workflows/diagnose-vcs-admission.yml` runs only on a push to `cr40-diagnose-vcs-admission` in `LeMark0/bb`, with read-only contents permission. It sets up Node 22.x and pnpm 9.15.0 as the Windows host packages job does, restores the Windows dependency disk without saving any cache, installs `bb`, `@bb/process-utils...` and `@bb/test-helpers...` (the root Vitest global setup imports test-helpers, whose tsconfig extends `@bb/tsconfig`), and runs:

```sh
node .github/diagnostics/vcs-admission/run.mjs --out "$RUNNER_TEMP/vcs-admission-diagnostic" --sampler windows --pnpm-version "$(pnpm --version)"
```

`run.mjs` starts Vitest directly on the one test file with the package's own Vitest config plus `trace-setup.mjs` as an extra setup file. Turbo is not involved, so no cache can replace the run.

## What it records

- `trace-setup.mjs`, in the test worker: each scheduler admission (queued, granted, released, with the git subcommand and the scheduler's active and queued counts); each `spawn` and `execFile` with the executable name, pid, git subcommand or taskkill target pids; each exit and stream close with elapsed time; each `ChildProcess.kill` call. It wraps these functions and passes every call through unchanged.
- `process-tree.mjs`, in a separate PowerShell sampler requested every 250 ms: the pid, parent pid, creation time and name of each process descended from the Vitest process. The sampler reads the full process table in memory and writes only owned processes. It never records command lines or environment.
- `summary.json` and `summary.md`: per admission, the wait and hold time, the git pid (matched by subcommand and time order, so inferred), taskkill elapsed time and exit code, the time from git spawn to taskkill start, root kills, exit time and the gap between exit and stream close; test outcomes; owned processes still alive after Vitest exited and at the end; observation coverage; flags for timed-out tests, taskkill over its 2 s budget or failing, and pipes held after exit.

## Which processes count as owned

The Vitest process is the root only if it appears, with a creation time within 2 s of the driver starting it, in a snapshot that the sampler collected after the driver created `spawn-boundary` and that the driver processes before it sees Vitest exit. The driver creates that file only after `spawn` has returned Vitest's pid, so it already holds Vitest's process handle; each sampler pass checks for the file before it reads the clock and the process table and reports the result in its row. Windows does not reuse a process ID while a handle to the process is open, so a process with that pid in such a snapshot is Vitest itself. Rows collected earlier, even if delivered later, never bind the root. A root not seen this way is never bound: the outcome is incomplete, and nothing is owned or cleaned. Any other process is owned only if the latest observed process with its parent pid, created no later than it, is owned and was itself seen alive at or after the child's creation time. Every observed process, owned or not, is remembered by pid and creation time, so a pid reused by an unrelated process, or a parent whose pid could have been reused unseen, never makes a child owned. Only owned processes are written to the trace or cleaned up.

A child whose parent lived and exited between two samples is therefore not adopted, even though the in-process trace may show that parent's pid. An absent record does not prove that no orphan existed.

## Coverage

The result counts as complete only if: the trace setup file loaded in the worker; both tests in the file ran (passed or failed); the sampler never exited on its own; the Vitest process was observed; and no gap between snapshots, from Vitest starting to the end of the post-exit watch, exceeded 3 s. Otherwise the outcome is incomplete even when the tests passed, and the partial traces are still uploaded. CIM enumeration adds its own time to each 250 ms interval, so processes that live shorter than a gap can be missed.

## Limits

Vitest gets 180 s, then the driver kills it and waits up to 30 s more for it to exit before carrying on without it. The driver then watches for 45 s, longer than the test's 30 s child timers, and then stops owned processes one at a time. Immediately before each kill, including after a slow earlier kill, it checks that target again: still alive in the owned tree, present in the latest snapshot with the same pid and creation time, and that snapshot at most 3 s old. Otherwise it skips the target and records why. The instant between that check and the kill itself remains. The step has 6 minutes and the job 20; those are the outer bounds if any internal stop fails. The artifact keeps every raw trace for 14 days, pass or fail.

The tracing adds a promise continuation to each admission, a synchronous file append to each event, and CIM sampling load, so it can itself create or hide a timing failure. A failure to write the trace aborts the diagnostic and is not the original failure. A run of one file under no other load differs from the CI job, which ran nine packages two at a time and may have shared a test worker and the global scheduler with other process-utils files. A pass therefore does not establish what caused the earlier timeout; a timeout here should show which step stalled.

## Exit codes

0 or 1: Vitest's own result, with complete evidence. 2: identity refused, nothing ran. 3: incomplete evidence (see Coverage). 4: the driver killed Vitest at 180 s. 5: the driver itself failed.

## Tests

```sh
node --test ".github/diagnostics/vcs-admission/test/*.test.mjs"
```

Set `BB_DIAG_EXECA` to an installed `execa/index.js` to include the check that execa's spawn is traced.
