# Worker progress card

Status: **not run**. Recipes added with the plugin; no live verification is recorded yet.

## Setup and entry points

Open a coordinator thread with hidden workers; the Workers card renders above its composer. `bb workers show [thread-id] [--json]` gives agents the same rows.

Use the main skill's isolated targets and evidence rules. A plugin can be present
in this checkout but disabled in an installation. Enable it only in the test
store before checking its surfaces. Read its current command/schema definitions
from the source below; CLI references use the matching source CLI described in
SKILL.md. Inspect nested `--help` before selecting flags and IDs.

## Source

- `plugins/worker-progress/package.json`
- `plugins/worker-progress/server.ts`
- `plugins/worker-progress/app.tsx`
- `plugins/worker-progress/workers-store.ts`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Hidden and nested workers | Spawn hidden workers from a coordinator and a hidden worker from one of them. | The card lists each in spawn order with nested workers under their parent; `bb workers show --json` reports the same tree. |
| Truthful states | Hold one worker on an approval, let one fail, stop one, and leave one idle. | Rows read Needs approval (with what it asks to run), Error, Idle; none reads done; a disconnected client shows Status unknown. |
| Plan and activity | Run a worker that keeps a native plan and runs described commands. | Every in-progress step, the next step and the done count match the worker's own to-do card; the activity shows the command's description, never the raw command. |
| No plan shared | Run a worker without a plan tool. | Only running rows say "No plan shared"; idle and failed rows make no plan claim. |
| Live updates | Keep focus on "Show full plan" and scroll the card while a worker progresses. | Focus, page scroll and card scroll stay put; only elapsed times tick. |
| Idle collapse | Let the last worker go idle, then send the coordinator a message. | The card shows "Workers · all idle" until the coordinator starts, then hides. |
| Long-idle fold and overflow | Keep workers idle for over an hour beside a running one, then add rows until the card scrolls. | Old idle workers fold into "+N earlier idle workers"; a footer counts rows below the visible area and its actionable states, and disappears at the end. |

## Evidence and cleanup

Record each row's UI and CLI result separately. Stop and archive only this run's
workers and coordinator. Provider turns are needed for live states; record when
fixtures or existing sessions stood in for them.
