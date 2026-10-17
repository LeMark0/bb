---
name: workers
description: "Show the state, shared plan and current activity of every worker thread below a coordinator thread, hidden ones included."
---

# Workers

Use `bb workers show [thread-id] [--json]` to see what the threads below a
coordinator are doing. Without a thread id it uses the thread running the
command.

```sh
bb workers show --json
bb workers show <thread-id>
```

Each row reports the worker's state from its thread status and pending
approvals: `working`, `waiting-approval`, `starting`, `waiting-for-host`,
`stopping`, `idle`, `error`, or `unknown`. A plan appears only while the worker
is running (`plan.kind` is `shared` or `none`); otherwise it is `unavailable`.
Activity is the running command's description, then the latest short
assistant message in the current turn, then a generic label. It never infers
progress from commands. Use `bb thread show <id>` or `bb thread log <id>` for a
worker's full detail.
