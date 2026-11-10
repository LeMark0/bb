---
name: plan-map
description: Create, update or bind a project's Plan Map feature ADR in bb, a structured implementation plan with a baseline and change history shown in the Plan Map tab. Use when the user asks to initialise, update, attach or show a Plan Map, or sends the request added by the Plan Map tab's "Initialise plan" button.
---

Maintain one feature ADR per feature across sessions. The ADR belongs to the feature's owning project and stays in that project's folder. The Plan Map tab only reads it. This skill does not implement the feature, commit, push, publish, or change unrelated agent configuration.

This is the Moonshot Plan Map skill (revision `2b8fd59`) adapted for bb: the `bb plan-map` commands replace the standalone helper and viewer.

## Commands

Every command works on the project of the conversation it runs in. Every path, including a draft candidate, must be a Markdown file inside that project's folder; the commands refuse anything else. Paths may be absolute or relative to the working directory, or to the project folder when the working directory is elsewhere. A plan-map block must stay under 60,000 YAML tokens (several times a large real plan) and nest `[ ]` or `{ }` at most 32 levels deep.

- `bb plan-map status`: the project's folder and the ADRs already bound to its Plan Map tab.
- `bb plan-map check <ADR.md>`: validate an ADR and print its `sha256`.
- `bb plan-map create <candidate.md> <destination.md>`: validate a candidate and write it as a new ADR inside the project folder. It never overwrites an existing file.
- `bb plan-map apply <ADR.md> <candidate.md> --expected <sha256>`: replace an ADR with a validated candidate, only if the ADR still has the `sha256` you read and the update keeps the baseline, stable IDs and change history.
- `bb plan-map bind <ADR.md>`: show a valid ADR inside the project folder in the Plan Map tab. Existing maps stay bound.

Run `bb plan-map --help` for the exact usage. When a command fails, report its error; do not claim the map changed.

## Choose the record

- Start with `bb plan-map status`. If an ADR is already bound, attach to it.
- Otherwise look in the project folder for an existing feature ADR, plan or decision record (for example `docs/adr/`). Reuse one that fits, and tell the user what you found before creating anything new. If several fit and the context does not distinguish them, ask which one.
- To create, use the project's existing ADR naming convention, otherwise `docs/adr/<next-number>-<feature>.md`. Keep significant independent architectural decisions in linked ADRs as the feature grows.
- Existing work uses the same workflow. Reconstruct from the conversation, plan files and cited evidence available to you. Label a reconstructed baseline explicitly. Missing history remains unknown; do not manufacture original wording, dates or approval.

## Initialise or update

Read [the ADR contract](references/adr-format.md) and use [the template](assets/feature-adr.md). The document combines Context, Decision and Consequences with exactly one `yaml plan-map` block. Use its versioned schema; do not generate a custom report or a separate hand-maintained plan.

Follow the owning project's guidance for issue tracking and evidence sources. Verify ticket identifiers and URLs from the tracker or from references the user gave you. Do not guess a URL from an identifier; leave unknown destinations unlinked. Ticket state, PR/CI evidence and implementation progress are separate facts.

Step status is a claim. Use `done` only with evidence, and `in_progress` or `blocked` only when a source shows it. Use `todo` only when you know the work has not started. When no source settles a step's progress, say so in its notes with what you checked and when, and ask the user rather than picking a status that looks safe.

For a new ADR:

1. Define the current goal and a small set of real steps with stable IDs, dependencies and completion criteria. Include workstreams only when they help navigation. Keep the decision proposed unless the conversation contains acceptance.
2. Capture the baseline once. For a new plan, baseline steps match the initial steps. For reconstructed work, record the source and uncertainty of the reconstruction, and use the actual time of capture.
3. Write the complete draft as a candidate inside the project next to its destination, for example `docs/adr/0001-feature.draft.md`. Run `bb plan-map check` on it, then `bb plan-map create <candidate.md> <destination.md>`, and delete the draft once it succeeds.
4. Run `bb plan-map bind <destination.md>` so the map appears in the Plan Map tab.

For an update:

1. Run `bb plan-map check <ADR.md>` and keep its `sha256`. Read the ADR and the current evidence before preparing changes.
2. Keep baseline fields and stable IDs. Park removed work. Append a change for additions, title or dependency changes and parking: what, why, author, affected IDs, evidence and proposed/accepted/recorded/rejected status. Keep previous change records unchanged; a later acceptance or reversal is a new record referring to the earlier ID.
3. An agent suggestion stays proposed until the user accepts it. Do not apply proposed scope changes to current steps. `recorded` is for faithfully importing documented history whose approval is unavailable, not for bypassing acceptance of a new proposal.
4. Record actual tests and observations. `done`, passed or failed checks and supported or disproved assumptions require evidence. Distinguish commands run here from completion merely reported by another source.
5. Advance `updated_at`, write a complete candidate `.draft.md` next to the ADR and apply it with `bb plan-map apply <ADR.md> <candidate.md> --expected <sha256>`, then delete the draft. If the ADR changed meanwhile, re-read and reconcile; never force an overwrite.

Update the ADR after meaningful progress, a tested assumption, a blocker or an agreed change before handing back. Respect read-only requests. Avoid rewriting it after every tool call.

## Show the map

Bound ADRs appear in the project's Plan Map tab, which re-reads them when it opens or when the user presses its refresh button, and offers **Load update** for a newer revision. Finish with the ADR location, whether it is bound, and any missing evidence or unresolved decision that matters.
