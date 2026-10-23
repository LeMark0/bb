import { describe, expect, it } from "vitest";
import type {
  ExperimentalPluginProviderLineageEntry,
  PluginProviderOptionsContext,
} from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import codexPlugin from "../server.js";

const COORDINATOR_THREAD_ID = "thr_coordinatr1";
const WORKER_THREAD_ID = "thr_reviewer01";
const FORK_THREAD_ID = "thr_forkedcopy1";
const AKAKIY_PRESET_ID = "01M46H89SV62BXPZ3HMXKAE6MN";
const REVIEWER_PRESET_ID = "01M46H8A7EZF44C57SWSFDVPNE";

const LARGE = {
  model: "gpt-6-astra",
  contextWindow: 872_000,
  autoCompactTokenLimit: 784_800,
};
const LARGE_OPTIONS = {
  modelContextWindow: 872_000,
  modelAutoCompactTokenLimit: 784_800,
};

const coordinatorOverrides = JSON.stringify({
  [COORDINATOR_THREAD_ID]: LARGE,
});
const akakiyPresets = JSON.stringify({ [AKAKIY_PRESET_ID]: LARGE });

function started(threadId: string): ExperimentalPluginProviderLineageEntry {
  return { threadId, originPluginId: null, originPluginMetadata: {} };
}

function fromPreset(
  threadId: string,
  presetId: unknown,
): ExperimentalPluginProviderLineageEntry {
  return {
    threadId,
    originPluginId: "tasks",
    originPluginMetadata: { presetId: presetId as string },
  };
}

function sideChat(threadId: string): ExperimentalPluginProviderLineageEntry {
  return {
    threadId,
    originPluginId: "side-chat",
    originPluginMetadata: { anchor: "evt_1" },
  };
}

function loadCodexPlugin() {
  const host = createFakePluginHost({ pluginId: "provider-codex" });
  codexPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "codex",
  );
  if (declaration?.deriveProviderOptions === undefined) {
    throw new Error("expected Codex to derive provider options");
  }
  return { deriveProviderOptions: declaration.deriveProviderOptions, host };
}

function providerOptions(args: {
  lineage: readonly ExperimentalPluginProviderLineageEntry[];
  model: string;
  settings: PluginProviderOptionsContext["settings"];
}) {
  return loadCodexPlugin().deriveProviderOptions({
    threadId: args.lineage[0]?.threadId ?? WORKER_THREAD_ID,
    projectId: "proj_shared",
    model: args.model,
    permissionMode: "accept-edits",
    settings: args.settings,
    experimental_lineage: args.lineage,
  });
}

describe("the Codex context window settings", () => {
  it("are empty by default and leave every thread on the Codex defaults", () => {
    const { host } = loadCodexPlugin();

    expect(host.harness.registrations.settingsDescriptors).toMatchObject({
      contextWindowOverrides: {
        type: "string",
        experimental_multiline: true,
        default: "",
      },
      contextWindowPresets: {
        type: "string",
        experimental_multiline: true,
        default: "",
      },
    });
    expect(
      providerOptions({
        lineage: [fromPreset(COORDINATOR_THREAD_ID, AKAKIY_PRESET_ID)],
        model: "gpt-6-astra",
        settings: {},
      }),
    ).toEqual({ memoryEnabled: true, providerSubagentsEnabled: true });
  });

  it.each([
    {
      name: "an explicitly listed thread on its model",
      lineage: [started(COORDINATOR_THREAD_ID)],
      model: "gpt-6-astra",
      window: LARGE_OPTIONS,
    },
    {
      name: "a worker in the same project on the same model",
      lineage: [started(WORKER_THREAD_ID)],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "an explicitly listed thread after a model change",
      lineage: [started(COORDINATOR_THREAD_ID)],
      model: "gpt-6.1-sol",
      window: {},
    },
    {
      name: "a thread Tasks started from the configured preset",
      lineage: [fromPreset(WORKER_THREAD_ID, AKAKIY_PRESET_ID)],
      model: "gpt-6-astra",
      window: LARGE_OPTIONS,
    },
    {
      name: "a thread Tasks started from another preset on the same model",
      lineage: [fromPreset(WORKER_THREAD_ID, REVIEWER_PRESET_ID)],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "a side chat forked from a preset thread",
      lineage: [
        sideChat(FORK_THREAD_ID),
        fromPreset(WORKER_THREAD_ID, AKAKIY_PRESET_ID),
      ],
      model: "gpt-6-astra",
      window: LARGE_OPTIONS,
    },
    {
      name: "a fork of an explicitly listed thread",
      lineage: [started(FORK_THREAD_ID), started(COORDINATOR_THREAD_ID)],
      model: "gpt-6-astra",
      window: LARGE_OPTIONS,
    },
    {
      name: "a fork that Tasks attributes to another preset",
      lineage: [
        fromPreset(FORK_THREAD_ID, REVIEWER_PRESET_ID),
        started(COORDINATOR_THREAD_ID),
      ],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "a fork whose preset provenance is malformed",
      lineage: [
        fromPreset(FORK_THREAD_ID, 42),
        fromPreset(WORKER_THREAD_ID, AKAKIY_PRESET_ID),
      ],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "a thread whose non-Tasks origin metadata names the preset",
      lineage: [
        {
          threadId: WORKER_THREAD_ID,
          originPluginId: "slack",
          originPluginMetadata: { presetId: AKAKIY_PRESET_ID },
        },
      ],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "a thread Tasks started before it recorded presets",
      lineage: [
        {
          threadId: WORKER_THREAD_ID,
          originPluginId: "tasks",
          originPluginMetadata: {},
        },
      ],
      model: "gpt-6-astra",
      window: {},
    },
  ])("derives the window for $name", ({ lineage, model, window }) => {
    expect(
      providerOptions({
        lineage,
        model,
        settings: {
          memoryEnabled: false,
          subagentsDisabled: true,
          contextWindowOverrides: coordinatorOverrides,
          contextWindowPresets: akakiyPresets,
        },
      }),
    ).toEqual({
      memoryEnabled: false,
      providerSubagentsEnabled: false,
      ...window,
    });
  });

  it.each([
    {
      name: "null keeps a preset thread on the defaults",
      overrides: { [WORKER_THREAD_ID]: null },
      lineage: [fromPreset(WORKER_THREAD_ID, AKAKIY_PRESET_ID)],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "null on a fork stops what it would inherit",
      overrides: { [FORK_THREAD_ID]: null },
      lineage: [
        sideChat(FORK_THREAD_ID),
        fromPreset(WORKER_THREAD_ID, AKAKIY_PRESET_ID),
      ],
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "a thread entry wins over its preset entry",
      overrides: {
        [WORKER_THREAD_ID]: { model: "gpt-6-astra", contextWindow: 500_000 },
      },
      lineage: [fromPreset(WORKER_THREAD_ID, AKAKIY_PRESET_ID)],
      model: "gpt-6-astra",
      window: { modelContextWindow: 500_000 },
    },
    {
      name: "a model mismatch on the nearest entry does not fall through to an older matching entry",
      overrides: {
        [FORK_THREAD_ID]: { model: "gpt-6-astra", contextWindow: 500_000 },
        [COORDINATOR_THREAD_ID]: {
          model: "gpt-6.1-sol",
          contextWindow: 600_000,
        },
      },
      lineage: [started(FORK_THREAD_ID), started(COORDINATOR_THREAD_ID)],
      model: "gpt-6.1-sol",
      window: {},
    },
    {
      name: "a preset thread on another model does not fall through to a listed ancestor",
      overrides: {
        [COORDINATOR_THREAD_ID]: {
          model: "gpt-6.1-sol",
          contextWindow: 600_000,
        },
      },
      lineage: [
        fromPreset(FORK_THREAD_ID, AKAKIY_PRESET_ID),
        started(COORDINATOR_THREAD_ID),
      ],
      model: "gpt-6.1-sol",
      window: {},
    },
  ])("$name", ({ overrides, lineage, model, window }) => {
    expect(
      providerOptions({
        lineage,
        model,
        settings: {
          contextWindowOverrides: JSON.stringify(overrides),
          contextWindowPresets: akakiyPresets,
        },
      }),
    ).toEqual({
      memoryEnabled: true,
      providerSubagentsEnabled: true,
      ...window,
    });
  });

  it("leaves the compaction limit to Codex when an entry omits it", () => {
    expect(
      providerOptions({
        lineage: [started(COORDINATOR_THREAD_ID)],
        model: "gpt-6-astra",
        settings: {
          contextWindowOverrides: JSON.stringify({
            [COORDINATOR_THREAD_ID]: {
              model: "gpt-6-astra",
              contextWindow: 872_000,
            },
          }),
        },
      }),
    ).toEqual({
      memoryEnabled: true,
      providerSubagentsEnabled: true,
      modelContextWindow: 872_000,
    });
  });

  it("ignores a stored value that no longer validates instead of failing every Codex turn", () => {
    expect(
      providerOptions({
        lineage: [fromPreset(COORDINATOR_THREAD_ID, AKAKIY_PRESET_ID)],
        model: "gpt-6-astra",
        settings: {
          contextWindowOverrides: "{",
          contextWindowPresets: "{",
        },
      }),
    ).toEqual({ memoryEnabled: true, providerSubagentsEnabled: true });
  });

  it.each([
    { value: "{", message: "must be valid JSON" },
    { value: "[]", message: "Context windows" },
    {
      value: JSON.stringify({
        "codex-thread": { model: "gpt-6-astra", contextWindow: 872_000 },
      }),
      message: "keys must be bb thread ids",
    },
    {
      value: JSON.stringify({ [COORDINATOR_THREAD_ID]: { contextWindow: 1 } }),
      message: "model",
    },
    ...[0, -1, 1.5, "872000"].map((contextWindow) => ({
      value: JSON.stringify({
        [COORDINATOR_THREAD_ID]: { model: "gpt-6-astra", contextWindow },
      }),
      message: "contextWindow",
    })),
    {
      value: JSON.stringify({
        [COORDINATOR_THREAD_ID]: {
          model: "gpt-6-astra",
          contextWindow: 872_000,
          autoCompactTokenLimit: 872_000,
        },
      }),
      message: "autoCompactTokenLimit must be below contextWindow",
    },
    {
      value: JSON.stringify({
        [COORDINATOR_THREAD_ID]: { ...LARGE, reasoning: "max" },
      }),
      message: "Context windows",
    },
  ])(
    "rejects $value when it is saved as thread entries",
    async ({ value, message }) => {
      const { host } = loadCodexPlugin();

      await expect(
        host.harness.setSettings({ contextWindowOverrides: value }),
      ).rejects.toThrow(message);
    },
  );

  it.each([
    {
      value: JSON.stringify({ [COORDINATOR_THREAD_ID]: LARGE }),
      message: "keys must be bb Tasks preset ids",
    },
    {
      value: JSON.stringify({ [AKAKIY_PRESET_ID]: null }),
      message: "Preset context windows",
    },
    {
      value: JSON.stringify({ [AKAKIY_PRESET_ID]: { contextWindow: 1 } }),
      message: "model",
    },
  ])(
    "rejects $value when it is saved as preset entries",
    async ({ value, message }) => {
      const { host } = loadCodexPlugin();

      await expect(
        host.harness.setSettings({ contextWindowPresets: value }),
      ).rejects.toThrow(message);
    },
  );

  it.each<Record<string, string>>([
    { contextWindowOverrides: coordinatorOverrides },
    { contextWindowOverrides: JSON.stringify({ [WORKER_THREAD_ID]: null }) },
    { contextWindowOverrides: "" },
    { contextWindowPresets: akakiyPresets },
    { contextWindowPresets: "" },
  ])("accepts %j when it is saved", async (settings) => {
    const { host } = loadCodexPlugin();

    await expect(host.harness.setSettings(settings)).resolves.toBeUndefined();
  });
});
