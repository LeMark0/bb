See what each worker thread is doing from the thread that started it. Hidden workers and their own workers are included, so you do not have to open each one.

## What you get

- A **Workers** card above the coordinator's composer, next to its to-do list. The header counts workers that need approval, have failed, are working, or are in another state.
- One row per worker: its name, its state, and what it is doing now. The activity comes from the worker's own description of its current command, then its latest short message in the current turn, then a plain label such as "Running command". The raw command is never the main text.
- The worker's own plan when it has shared one: every step in progress, the next step, and a done count. **Show full plan** lists every step in the same order and wording as the worker's own to-do card.
- Waiting for approval shows what the worker wants to run. Idle, failed and unreachable workers stay listed with when they last changed; they are never shown as done.
- Workers started by a worker sit under it. Beyond three, the rest fold into "+N more workers"; deeper workers show as "+N nested workers ›", which opens that worker's thread.
- Workers that have been idle for over an hour, with all of their own workers idle too, fold into one "+N earlier idle workers" row that expands in place.
- When more rows sit below the card's visible area, a footer such as "+6 more below · 1 error" says so and scrolls down a page.

## How it works

The card lists the coordinator's descendants, hidden ones included, and follows bb's realtime thread changes. It reads a running worker's latest timeline page when that worker changes, at most once a second. It does not poll. A plan is only available while a worker is running, so idle and failed rows make no claim about plans.

Live updates keep your focus and scroll position. Collapsing the card is remembered for that thread. When every worker is idle, the card shrinks to "Workers · all idle" and hides the next time the coordinator starts work.

## For agents and scripts

Use `bb workers show [thread-id]` to print the same rows. It defaults to the thread running the command. Add `--json` for machine-readable output.
