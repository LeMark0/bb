# Plan Map for bb

Plan Map shows a project's feature ADR as a read-only map in a bb conversation: steps, dependencies, decisions, status and change history. It is the Moonshot Plan Map viewer ported to a bb plugin, with a status board, search, details panel and dependency inspection.

An ADR (architecture decision record) is a Markdown file that records a decision. A Plan Map ADR also holds the feature's plan in one `yaml plan-map` block, and it stays in its project. Plan Map only reads it. Creating or changing an ADR goes through the `bb plan-map` commands, which never overwrite a file and refuse stale updates.

## Requirements

- bb 0.49.0 or later (plugin SDK 0.6.132 or later).
- A bb project with a local folder.

## Install

Install this directory with bb's plugin installer, from a Git checkout of the repository that contains it:

```sh
bb plugin install git:<repository URL>@<ref> --subdirectory <path to this directory>
```

For a Git install, bb installs the dependencies and builds the plugin.

To install from a local copy, install its dependencies first, then point bb at the directory:

```sh
npm install --omit=dev
```

```sh
bb plugin install path:<path to this directory>
```

## Use

Open a conversation in your project and open the **Plan map** tab from its actions.

- **Initialise plan** adds a request to the conversation's message box. It names the project and asks the agent to look for an existing ADR or plan first, then draft, check, create and bind one. Nothing runs until you send it.
- **Bind existing plan** takes the path of an ADR inside the project folder, checks that it is a valid Plan Map ADR and shows it. Other bound maps stay.
- Once a map is bound, the conversation's info panel shows **Open plan map**.

The tab re-reads the ADR when it opens and when you press its refresh button. A newer revision waits for **Load update**, so your view does not move under you. The view you were looking at is restored when you reopen the tab.

## Commands for agents

Each command works on the project of the conversation it runs in, and writes only inside that project's folder.

| Command | What it does |
| --- | --- |
| `bb plan-map status` | Shows the project folder and its bound ADRs. |
| `bb plan-map check <ADR.md>` | Validates an ADR and prints its `sha256`. |
| `bb plan-map create <candidate.md> <destination.md>` | Writes a validated candidate as a new ADR. Never overwrites. |
| `bb plan-map apply <ADR.md> <candidate.md> --expected <sha256>` | Replaces an ADR only if it still has that `sha256` and the update keeps its baseline, IDs and history. |
| `bb plan-map bind <ADR.md>` | Shows a valid ADR in the Plan map tab. |

The plugin ships a `plan-map` skill that tells agents how to use these commands and the ADR format. The format is described in [`skills/plan-map/references/adr-format.md`](skills/plan-map/references/adr-format.md), and [`skills/plan-map/assets/feature-adr.md`](skills/plan-map/assets/feature-adr.md) is a complete example. Both travel with the skill when bb installs it.

## Settings

**Plan Map ADRs** records which ADRs each project shows. "Bind existing plan" and `bb plan-map bind` maintain it; you do not need to edit it.

## Develop

```sh
npm install --include=dev
npm run typecheck
npm test
bb plugin build
```

## Provenance

See [PROVENANCE.md](PROVENANCE.md) for the upstream source and every change made for bb. The package has no licence file.
