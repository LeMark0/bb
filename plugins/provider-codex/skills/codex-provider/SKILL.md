---
name: codex-provider
description: "Diagnose BB-specific Codex session controls, model acceptance, and durable goals."
---

# Codex provider

Codex supports structured plan requests, editing and rerunning eligible messages,
and compaction through the corresponding core `bb thread` commands.
`bb thread clear-goal <id>` clears its durable active Goal and waits for provider
confirmation. Inspect the thread before recovery actions.

Codex questions from `request_user_input` pause the turn until answered.
Questions from `request_user_input_async` do not pause it: the plugin opens a
question card for each one that stays open for up to an hour after the turn
ends. Submitting sends the answer to the thread as a message
(steering an active turn or starting a new one); dismissing sends nothing.
From the CLI, find it with `bb thread interactions list <thread>` and answer
with `bb thread interactions respond <interactionId> <thread> --value
'{"answers":{"question-1":{"selected":["option-2"]}}}'`. Questions and options
are numbered from 1 in order; use `"freeText"` for a typed answer.

Unlisted model IDs are accepted by this provider; acceptance does not establish
account access. Inspect models on the actual execution host with
`bb provider models codex` using the machine or environment selector.

Service tiers are `default`, `fast`, and `ultrafast`. Codex reports the tiers
each model accepts for the signed-in account, so the model picker and
`bb provider models codex` (Service tiers column, `supportedServiceTiers` in
`--json`) list Ultrafast only for eligible models and accounts. Pass the id to
`--service-tier` on `bb thread spawn` or `bb thread tell`; bb sends an explicit
tier to Codex as given. When the model does not list it, Codex runs the turn
at its default tier and the thread shows its warning that the tier "is not
advertised as supported" and was omitted.

Daybreak is a session option with the id `daybreak`, offered only when the
signed-in account's model list advertises a Daybreak program. Turn it on in the
model picker, with `bb thread spawn --option daybreak=true`, or on an existing
thread with `bb thread options --set daybreak=true`; it applies from the next
turn and Codex stores the choice on its own thread. With it on, each turn asks
for the selected model's Daybreak program (blue when the model lists it,
otherwise red); once it has been turned off, each turn asks for the standard
program. A thread where Daybreak was never set sends no program and leaves the
choice to Codex.
`bb provider models codex` lists the option, and `--json` shows per model
whether it runs with Daybreak, without it, or both (`sessionOptions`, where
`fixed: true` means only the listed value). A model that cannot run in the
current state is disabled in the picker. The `gpt-daybreak-*-latest` alias
models leave the main list when the switch is available and stay selectable
only on threads that already use them.

## Per-thread and per-preset context windows

The `contextWindowOverrides` setting gives selected threads a larger Codex
context window. It is a JSON object keyed by bb thread id; each entry names the
model it applies to:

```sh
bb plugin config provider-codex set contextWindowOverrides '{"thr_abc234defg":{"model":"gpt-6-astra","contextWindow":872000,"autoCompactTokenLimit":784800}}'
```

bb sends `contextWindow` as Codex `model_context_window` and
`autoCompactTokenLimit` as `model_auto_compact_token_limit` when it starts or
resumes that thread's session. An entry applies only while the thread runs the
named model, so a model change falls back to the Codex defaults. Omit
`autoCompactTokenLimit` to keep the Codex default compaction threshold; it must
be below `contextWindow` when present. A thread id mapped to `null` keeps that
thread on the defaults.

`contextWindowPresets` takes the same entries keyed by Tasks preset id. It
covers threads that Tasks started from that preset, with `bb tasks dispatch`
or `bb tasks preset spawn`, which record the preset id on the thread:

```sh
bb plugin config provider-codex set contextWindowPresets '{"01M46H89SV62BXPZ3HMXKAE6MN":{"model":"gpt-6-astra","contextWindow":872000,"autoCompactTokenLimit":784800}}'
```

bb decides each command from the thread and then the threads it was forked
from, nearest first, and uses the first decision it finds:

- a `contextWindowOverrides` entry for that thread, or `null`;
- otherwise the preset that thread was started from, if Tasks recorded one:
  its `contextWindowPresets` entry, or the defaults when the preset has none.

So forks and side chats inherit their source's window, a fork recorded under
another preset or mapped to `null` stops inheritance, and children and
reviewers, which are not forks, keep their own settings. A model mismatch at
the deciding thread means the defaults; bb does not look further back. Threads
started with `bb thread spawn` record no preset, so only a thread entry covers
them; a title or prompt naming a preset does not. The recorded preset id is
ordinary thread metadata that any local API client can rewrite, so treat it as
provenance for configuration, not as an access control.

bb rejects malformed JSON, keys that are not bb thread ids or Tasks preset ids,
unknown fields and non-integer or non-positive token counts when either
setting is saved.

Choose the values from the model's entry in `codex debug models`. In the Codex
0.162.1 catalogue, `gpt-6-astra` has a 272000-token `context_window`, a
`max_context_window` of 872000, `effective_context_window_percent` 95 and no
`auto_compact_token_limit`. Without an override, `bb thread context <id>`
reports 258400 for it, which is 95% of 272000. The example requests the
catalogue maximum as the raw window. If Codex applies the same 95% to an
override, the reported window would be 828400; that is a calculation, not an
observed result. The example's 784800 is 90% of the raw window, chosen to
trigger compaction below that predicted 828400 with room for the next
response. It is a deliberate margin, not a Codex default. This guide does not
establish how Codex derives its own threshold when `autoCompactTokenLimit` is
omitted, whether it clamps either value, or that requests near the raw window
succeed; check `bb thread context <id>` after the next turn rather than
treating the setting as proof.

A change reaches a running thread at its next turn: bb rebuilds the Codex
session on the same provider thread, keeping the conversation. Map a thread
to `null` to put it on the defaults the same way. Removing a thread's entry,
or unsetting a setting with
`bb plugin config provider-codex unset contextWindowOverrides` (or
`contextWindowPresets`), hands each affected thread back to the rest of the
resolution order: its fork source or recorded preset may still give it a
larger window, and only a thread with no other decision returns to the
defaults. Before returning a thread to the default window, make sure its
context is below the default reported window or compact it first.

Use the core CLI skill for command syntax and official Codex guidance for
upstream product behavior.
