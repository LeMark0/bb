Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier <tier>`. A tier is an id the provider lists for the model
(`default`, `fast`, or another such as Codex `ultrafast`; see
`bb provider models <provider> --json`):

```sh
bb tasks preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--clear-service-tier` clears a tier.
Do not combine it with `--service-tier`; `none` is a literal tier id.

To start a thread from a preset without a task, use `preset spawn`. It uses
the preset's provider, model and environment, and accepts `--reasoning`,
`--service-tier` and `--permission` overrides for this thread only. Pass the
first message with `--prompt` or `--prompt-file`, read on the invoking
machine (or `--machine`) with trailing newlines dropped, as
`bb thread spawn --prompt-file` does. The preset's instructions are not added:

```sh
bb tasks preset spawn "Codex high" --project proj_abc234defg \
  --environment env_abc234defg --title "Release coordination" \
  --prompt-file brief.md --json
```

Both `bb tasks dispatch` and `preset spawn` record the preset's id on the
thread they create, as Tasks plugin metadata `presetId`. Providers can key
settings on it; the Codex provider's `contextWindowPresets` does. A thread
started with `bb thread spawn` records no preset, even with a preset's
instructions in its prompt.
