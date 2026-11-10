# Feature ADR contract v1

Use Markdown with non-empty `## Context`, `## Decision`, and `## Consequences` sections and exactly one fenced block whose opening line is ` ```yaml plan-map` (without the leading space). The prose explains the decision; the block holds the data rendered as the map. The parser does not infer steps or dependencies from prose.

The executable schema is `lib/adr.ts` in the viewer repository. The template in `../assets/feature-adr.md` is a complete valid example. Dates use quoted ISO 8601 timestamps with offsets. IDs begin with a letter and then contain letters, digits, underscores or hyphens. IDs are unique within each collection; step IDs remain stable across revisions.

Required root fields: `schema: plan-map/v1`, `id`, `title`, `goal`, `decision_status`, `updated_at`, `baseline`, `groups`, `steps`. Optional collections default to empty: `changes`, `assumptions`, `checks`, `questions`, `sessions`. Unknown fields and duplicate YAML keys are rejected. YAML aliases are not supported.

- `decision_status`: `proposed`, `accepted`, `rejected`, `superseded`. This is the ADR decision state, independent of implementation progress.
- `baseline`: `kind` is `original` or `reconstructed`; `captured_at`, `note`, and `steps` are required. Each baseline step has `id`, `title`, `needs`. In a reconstructed baseline, use `null` for an unknown original title or prerequisite list; never substitute current wording and call it original. New original baselines require both fields. Once created, the whole baseline is immutable. Keep the record under version control with the feature.
- `groups`: each has `id`, `title`, `recap`. They organise the diagram, without adding requirements. Step-to-step dependencies are authoritative; aggregate workstream arrows are derived from them.
- `steps`: each has `id`, `title`, `group`, `status`. Optional `short_title` abbreviates the node only. `needs`, `notes`, `evidence`, `acceptance`, `tickets` are arrays. Status is `todo`, `in_progress`, `blocked`, `done`, or `parked`. Prerequisites must refer to existing steps and form an acyclic graph. Keep removed steps as `parked`. Done requires evidence.
- `changes`: each has `id`, `at`, `author`, `status`, `summary`, `why`, `affects`, `evidence`. Status is `proposed`, `accepted`, `rejected`, or `recorded`. A recorded historical change is not proof of user acceptance. Updates that change current scope require a new accepted or recorded change naming the affected step. Existing records cannot be removed or rewritten.
- `assumptions`: `id`, `statement`, `status`, `evidence`. Status is `untested`, `supported`, or `disproved`; tested claims require evidence.
- `checks`: `id`, `title`, `status`, `evidence`. Status is `not_run`, `passed`, or `failed`; outcomes require evidence.
- `questions`: unresolved questions as strings.
- `sessions`: `id`, `attached_at`. Multiple sessions may attach to the same feature ADR. Add each session once.

An evidence string should identify what was observed, its source and when it was checked. A link, commit, file location, command result or explicitly labelled source report is appropriate. The viewer displays recorded evidence; it does not certify it.

Tickets accept a plain string when only an identifier is known, an HTTP(S) URL string, or an object with `id` (the visible label) and `url` (the full HTTP(S) ticket URL). Prefer the object when the source provides a URL. Follow the owning project's tracker guidance and copy verified destinations from the tracker or user-supplied references. Do not guess a workspace or URL from the identifier. Plain identifiers remain text. Links open a new tab without selecting the node or moving the map. For example:

```yaml
tickets:
  - id: TASK-123
    url: https://example.com/issues/TASK-123
  - id: "#42"
    url: https://github.com/example/project/issues/42
  - TASK-456
```

These are illustrative destinations, not real project references. Existing string-only records remain valid.

The helper validates syntax and references, checks baseline preservation, retains prior change records and rejects stale revisions by SHA-256. Use its `create` and `apply` commands for writes. A direct editor can bypass update-history checks; Git history and code review remain necessary for auditing outside edits.
