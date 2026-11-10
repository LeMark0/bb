# Provenance

## Upstream

The viewer, plan model, schema and validation come from Moonshot Plan Map, `plan-map/` at commit `2b8fd59c666044150136611f3fdf5f8ce0f864eb` (pull request 5, "feat: add Plan Map board, search and navigation").

`upstream/` holds the copied files. 22 of them are byte-identical to that commit:

- `lib/adr.ts`, `lib/plan.ts`, `lib/plan-view.ts`, `lib/plan-search.ts`, `lib/plan-blockers.ts`, `lib/graph-layout.ts`, `lib/utils.ts`;
- `lib/__tests__/` (3 test files);
- `components/plan-board.tsx`, `plan-list.tsx`, `plan-parts.tsx`, `plan-blocker.tsx`, `plan-dependency.tsx`, `plan-edge.tsx`, `map-picker.tsx`, `ui/button.tsx`;
- `docs/adr/0001-reusable-plan-maps.md`, `docs/adr/0002-node-http-service.md`;
- `skills/plan-map/references/adr-format.md`, `skills/plan-map/assets/feature-adr.md`.

Four files are adapted, only where bb requires it:

| Change | File | Reason |
| --- | --- | --- |
| A1 | `components/plan-explorer.tsx` | View, scope and selection lived in the page URL and browser history, which belong to bb. Each explorer keeps the same URL shape in memory and saves only that view reference in plugin-scoped storage, so reopening restores it. |
| A2 | `components/plan-explorer.tsx` | Keyboard shortcuts act only while focus is inside the map. |
| A3 | `components/plan-explorer.tsx` | "Copy link" copies the ADR path and current view, because a bb tab has no shareable URL. |
| A4 | `components/ui/select-menu.tsx`, `components/plan-explorer.tsx` | Popups render into a plugin-scoped container. |
| A5 | `components/plan-panel-layout.tsx` | The divider measures the workspace, not the window. |
| A6 | `app/globals.css` | Uses bb's theme tokens and scopes every rule to the plugin. |
| A7 | `components/plan-explorer.tsx`, `app/globals.css` | Breakpoints follow the tab's width, not the window's. |
| A8 | `components/plan-panel-layout.tsx` | The panel layout preference is stored under the plugin id. |
| A9 | `app/globals.css` | The plugin root owns vertical scrolling in the stacked layout, standing in for upstream's page scroll. |

Not ported: upstream's standalone app shell and theme toggle (bb provides both), its Node viewer service and registry (bb reads the bound ADR), and its CLI, whose `check`, `create` and `apply` semantics the `bb plan-map` commands keep.

Known upstream behaviour carried over unchanged: in the stacked layout the first "Details" shortcut can scroll before the panel finishes rendering, leaving the panel low; a second press lands it.

## Added for bb

`app.tsx`, `plan-map-view.tsx`, `bb-host-adapter.ts`, `init-actions.tsx`, `init-request.ts`, `server.ts`, `plan-files.ts`, `adr-guard.ts` (a size and nesting check before upstream's parser runs), `channels.ts`, `shell.css`, `css.d.ts`, `skills/plan-map/SKILL.md` (adapted from upstream's skill for the `bb plan-map` commands) and `tests/`.

`skills/plan-map/references/adr-format.md` and `skills/plan-map/assets/feature-adr.md` are byte-identical copies of `upstream/skills/plan-map/references/adr-format.md` and `upstream/skills/plan-map/assets/feature-adr.md`. bb exports only the skill's own directory, so the skill carries its own copies.

## Licence

None. Plan Map is a personal project, and this package adds no licence file or licence terms.
