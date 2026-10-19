import { describe, expect, it } from "vitest";
import type { PluginProviderOptionsContext } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import codexPlugin from "../server.js";

const COORDINATOR_THREAD_ID = "thr_coordinatr1";
const WORKER_THREAD_ID = "thr_reviewer01";

const coordinatorOverrides = JSON.stringify({
  [COORDINATOR_THREAD_ID]: {
    model: "gpt-6-astra",
    contextWindow: 872_000,
    autoCompactTokenLimit: 784_800,
  },
});

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
  threadId: string;
  model: string;
  settings: PluginProviderOptionsContext["settings"];
}) {
  return loadCodexPlugin().deriveProviderOptions({
    threadId: args.threadId,
    projectId: "proj_shared",
    model: args.model,
    permissionMode: "accept-edits",
    settings: args.settings,
  });
}

describe("the Codex per-thread context window setting", () => {
  it("is empty by default and leaves every thread on the Codex defaults", () => {
    const { host } = loadCodexPlugin();

    expect(
      host.harness.registrations.settingsDescriptors.contextWindowOverrides,
    ).toMatchObject({
      type: "string",
      experimental_multiline: true,
      default: "",
    });
    expect(
      providerOptions({
        threadId: COORDINATOR_THREAD_ID,
        model: "gpt-6-astra",
        settings: {},
      }),
    ).toEqual({ memoryEnabled: true, providerSubagentsEnabled: true });
  });

  it.each([
    {
      name: "the selected thread on its model",
      threadId: COORDINATOR_THREAD_ID,
      model: "gpt-6-astra",
      window: {
        modelContextWindow: 872_000,
        modelAutoCompactTokenLimit: 784_800,
      },
    },
    {
      name: "a worker in the same project on the same model",
      threadId: WORKER_THREAD_ID,
      model: "gpt-6-astra",
      window: {},
    },
    {
      name: "the selected thread after a model change",
      threadId: COORDINATOR_THREAD_ID,
      model: "gpt-6.1-sol",
      window: {},
    },
  ])("derives the window for $name", ({ threadId, model, window }) => {
    expect(
      providerOptions({
        threadId,
        model,
        settings: {
          memoryEnabled: false,
          subagentsDisabled: true,
          contextWindowOverrides: coordinatorOverrides,
        },
      }),
    ).toEqual({
      memoryEnabled: false,
      providerSubagentsEnabled: false,
      ...window,
    });
  });

  it("leaves the compaction limit to Codex when an entry omits it", () => {
    expect(
      providerOptions({
        threadId: COORDINATOR_THREAD_ID,
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
        threadId: COORDINATOR_THREAD_ID,
        model: "gpt-6-astra",
        settings: { contextWindowOverrides: "{" },
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
        [COORDINATOR_THREAD_ID]: {
          model: "gpt-6-astra",
          contextWindow: 872_000,
          reasoning: "max",
        },
      }),
      message: "Context windows",
    },
  ])("rejects $value when it is saved", async ({ value, message }) => {
    const { host } = loadCodexPlugin();

    await expect(
      host.harness.setSettings({ contextWindowOverrides: value }),
    ).rejects.toThrow(message);
  });

  it.each([coordinatorOverrides, ""])(
    "accepts %j when it is saved",
    async (value) => {
      const { host } = loadCodexPlugin();

      await expect(
        host.harness.setSettings({ contextWindowOverrides: value }),
      ).resolves.toBeUndefined();
    },
  );
});
