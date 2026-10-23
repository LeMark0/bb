import { registerCodexAiService } from "./src/ai-service.js";
import { registerAsyncQuestions } from "./src/async-questions.js";
import { registerUsageSource } from "./src/usage-source.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { codexExtensionKinds } from "./src/extension-kinds.js";
import { CODEX_NATIVE_ROOTS_DECLARATION } from "./src/native-roots.js";
import {
  contextWindowOverridesSettingSchema,
  contextWindowPresetsSettingSchema,
  contextWindowProviderOptions,
} from "./src/context-window-overrides.js";

export default function plugin(bb: BbPluginApi) {
  registerUsageSource(bb);
  registerCodexAiService(bb);
  registerAsyncQuestions(bb);

  bb.settings.define({
    memoryEnabled: {
      type: "boolean",
      label: "Codex memory",
      description:
        "Allow Codex to recall existing memories and generate new memories from bb threads.",
      default: true,
    },
    subagentsDisabled: {
      type: "boolean",
      label: "Disable provider subagents",
      description:
        "Prevent Codex from starting native subagents so agents use bb for delegation.",
      default: false,
    },
    contextWindowOverrides: {
      type: "string",
      label: "Per-thread context windows",
      description:
        "A JSON object keyed by bb thread id whose entries set model, contextWindow and an optional autoCompactTokenLimit, or null to keep that thread on the Codex defaults. An entry also covers the thread's forks and takes precedence over a preset entry. It applies only while the thread runs that model; every other thread keeps the Codex defaults.",
      experimental_multiline: true,
      experimental_schema: contextWindowOverridesSettingSchema,
      default: "",
    },
    contextWindowPresets: {
      type: "string",
      label: "Context windows by dispatch preset",
      description:
        "A JSON object keyed by Tasks preset id, with the same entries. An entry covers threads that Tasks started from that preset (bb tasks dispatch or bb tasks preset spawn) and their forks, while they run that model. A thread started from another preset keeps the Codex defaults.",
      experimental_multiline: true,
      experimental_schema: contextWindowPresetsSettingSchema,
      default: "",
    },
  });

  bb.providers.register({
    id: "codex",
    displayName: "Codex",
    icon: "./icons/codex.svg",
    strings: {
      signInHint: "Run `codex` on the machine to sign in.",
      expiredHint: "Your Codex session expired. Run `codex`, then reload.",
      installUrl: "https://developers.openai.com/codex/cli",
      brandPrefix: "GPT-",
    },
    models: { scope: "host" },
    ...CODEX_NATIVE_ROOTS_DECLARATION,
    maintenance: { health: true, usage: true, installation: true },
    capabilities: {
      supportsServiceTier: true,
      supportsNativeUserQuestion: false,
      fork: "checkpoint",
      supportsManualCompaction: true,
      supportsThreadArchive: true,
      supportsThreadRename: true,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ],
    },
    reasoningLevels: [
      { id: "none", label: "None" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
      {
        id: "ultra",
        label: "Ultra",
        description: "Max effort plus automatic task delegation.",
      },
    ],
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
    ],
    composerActions: ["plan", "goal"],
    deriveProviderOptions(context) {
      return {
        memoryEnabled: context.settings.memoryEnabled !== false,
        providerSubagentsEnabled: context.settings.subagentsDisabled !== true,
        ...contextWindowProviderOptions({
          overridesValue: context.settings.contextWindowOverrides,
          presetsValue: context.settings.contextWindowPresets,
          lineage: context.experimental_lineage,
          model: context.model,
        }),
      };
    },
    extensionKinds: codexExtensionKinds,
  });
}
