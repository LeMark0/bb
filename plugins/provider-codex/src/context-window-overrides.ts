import type {
  ExperimentalPluginProviderLineageEntry,
  PluginSettingValue,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const contextWindowOverrideSchema = z
  .strictObject({
    model: z.string().min(1, "model must name the Codex model id"),
    contextWindow: z
      .number()
      .int("contextWindow must be a whole number of tokens")
      .positive("contextWindow must be positive"),
    autoCompactTokenLimit: z
      .number()
      .int("autoCompactTokenLimit must be a whole number of tokens")
      .positive("autoCompactTokenLimit must be positive")
      .optional(),
  })
  .refine(
    (entry) =>
      entry.autoCompactTokenLimit === undefined ||
      entry.autoCompactTokenLimit < entry.contextWindow,
    {
      message: "autoCompactTokenLimit must be below contextWindow",
      path: ["autoCompactTokenLimit"],
    },
  );

type ContextWindowOverride = z.infer<typeof contextWindowOverrideSchema>;

const BB_THREAD_ID_PATTERN = /^thr_[a-z0-9]+$/u;
const TASKS_PRESET_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const TASKS_PLUGIN_ID = "tasks";

function keyedEntriesSchema<Entry extends z.ZodType>(
  entry: Entry,
  keyPattern: RegExp,
  keyMessage: string,
) {
  return z.record(z.string(), entry).superRefine((entries, context) => {
    Object.keys(entries)
      .filter((key) => !keyPattern.test(key))
      .forEach((key) => {
        context.addIssue({ code: "custom", message: keyMessage, path: [key] });
      });
  });
}

const contextWindowOverridesSchema = keyedEntriesSchema(
  contextWindowOverrideSchema.nullable(),
  BB_THREAD_ID_PATTERN,
  "keys must be bb thread ids",
);

const contextWindowPresetsSchema = keyedEntriesSchema(
  contextWindowOverrideSchema,
  TASKS_PRESET_ID_PATTERN,
  "keys must be bb Tasks preset ids",
);

type Parsed<Value> =
  | { success: true; value: Value }
  | { success: false; message: string };

function parseSettingJson<Schema extends z.ZodType>(
  schema: Schema,
  label: string,
  settingValue: string,
): Parsed<z.infer<Schema>> {
  let json: unknown = {};
  if (settingValue.trim() !== "") {
    try {
      json = JSON.parse(settingValue);
    } catch {
      return { success: false, message: `${label} must be valid JSON.` };
    }
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join(".") ?? "";
    return {
      success: false,
      message: `${label}${location === "" ? "" : ` (${location})`}: ${issue?.message ?? "invalid value"}.`,
    };
  }
  return { success: true, value: parsed.data };
}

function settingSchema<Schema extends z.ZodType>(
  schema: Schema,
  label: string,
) {
  return z.string().superRefine((value, context) => {
    const parsed = parseSettingJson(schema, label, value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: parsed.message });
    }
  });
}

export const contextWindowOverridesSettingSchema = settingSchema(
  contextWindowOverridesSchema,
  "Context windows",
);

export const contextWindowPresetsSettingSchema = settingSchema(
  contextWindowPresetsSchema,
  "Preset context windows",
);

function storedEntries<Schema extends z.ZodType>(
  schema: Schema,
  settingValue: PluginSettingValue | undefined,
): z.infer<Schema> | Record<string, never> {
  if (typeof settingValue !== "string") {
    return {};
  }
  const parsed = parseSettingJson(schema, "", settingValue);
  return parsed.success ? parsed.value : {};
}

type LineageDecision =
  | { kind: "entry"; entry: ContextWindowOverride | null }
  | { kind: "none" };

function tasksPresetDecision(
  link: ExperimentalPluginProviderLineageEntry,
  presets: Readonly<Record<string, ContextWindowOverride>>,
): LineageDecision {
  if (
    link.originPluginId !== TASKS_PLUGIN_ID ||
    !Object.hasOwn(link.originPluginMetadata, "presetId")
  ) {
    return { kind: "none" };
  }
  const presetId = link.originPluginMetadata.presetId;
  return {
    kind: "entry",
    entry:
      typeof presetId === "string" && Object.hasOwn(presets, presetId)
        ? (presets[presetId] ?? null)
        : null,
  };
}

function linkDecision(
  link: ExperimentalPluginProviderLineageEntry,
  overrides: Readonly<Record<string, ContextWindowOverride | null>>,
  presets: Readonly<Record<string, ContextWindowOverride>>,
): LineageDecision {
  return Object.hasOwn(overrides, link.threadId)
    ? { kind: "entry", entry: overrides[link.threadId] ?? null }
    : tasksPresetDecision(link, presets);
}

function nearestDecision(
  lineage: readonly ExperimentalPluginProviderLineageEntry[],
  overrides: Readonly<Record<string, ContextWindowOverride | null>>,
  presets: Readonly<Record<string, ContextWindowOverride>>,
): ContextWindowOverride | null {
  const decision = lineage
    .map((link) => linkDecision(link, overrides, presets))
    .find((candidate) => candidate.kind === "entry");
  return decision?.kind === "entry" ? decision.entry : null;
}

interface ContextWindowProviderOptionsArgs {
  overridesValue: PluginSettingValue | undefined;
  presetsValue: PluginSettingValue | undefined;
  lineage: readonly ExperimentalPluginProviderLineageEntry[];
  model: string;
}

type ContextWindowProviderOptions = {
  modelContextWindow?: number;
  modelAutoCompactTokenLimit?: number;
};

export function contextWindowProviderOptions(
  args: ContextWindowProviderOptionsArgs,
): ContextWindowProviderOptions {
  const entry = nearestDecision(
    args.lineage,
    storedEntries(contextWindowOverridesSchema, args.overridesValue),
    storedEntries(contextWindowPresetsSchema, args.presetsValue),
  );
  if (entry === null || entry.model !== args.model) {
    return {};
  }
  return {
    modelContextWindow: entry.contextWindow,
    ...(entry.autoCompactTokenLimit !== undefined
      ? { modelAutoCompactTokenLimit: entry.autoCompactTokenLimit }
      : {}),
  };
}
