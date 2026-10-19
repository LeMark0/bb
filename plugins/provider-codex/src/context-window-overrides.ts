import type { PluginSettingValue } from "@get-bb/plugin-sdk";
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

const BB_THREAD_ID_PATTERN = /^thr_[a-z0-9]+$/u;

const contextWindowOverridesSchema = z
  .record(z.string(), contextWindowOverrideSchema)
  .superRefine((overrides, context) => {
    Object.keys(overrides)
      .filter((threadId) => !BB_THREAD_ID_PATTERN.test(threadId))
      .forEach((threadId) => {
        context.addIssue({
          code: "custom",
          message: "keys must be bb thread ids",
          path: [threadId],
        });
      });
  });

type ContextWindowOverrides = z.infer<typeof contextWindowOverridesSchema>;

type ParsedContextWindowOverrides =
  | { success: true; overrides: ContextWindowOverrides }
  | { success: false; message: string };

function parseContextWindowOverrides(
  settingValue: string,
): ParsedContextWindowOverrides {
  if (settingValue.trim() === "") {
    return { success: true, overrides: {} };
  }
  let json: unknown;
  try {
    json = JSON.parse(settingValue);
  } catch {
    return { success: false, message: "Context windows must be valid JSON." };
  }
  const parsed = contextWindowOverridesSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.join(".") ?? "";
    return {
      success: false,
      message: `Context windows${location === "" ? "" : ` (${location})`}: ${issue?.message ?? "invalid value"}.`,
    };
  }
  return { success: true, overrides: parsed.data };
}

export const contextWindowOverridesSettingSchema = z
  .string()
  .superRefine((value, context) => {
    const parsed = parseContextWindowOverrides(value);
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: parsed.message });
    }
  });

interface ContextWindowProviderOptionsArgs {
  settingValue: PluginSettingValue | undefined;
  threadId: string;
  model: string;
}

type ContextWindowProviderOptions = {
  modelContextWindow?: number;
  modelAutoCompactTokenLimit?: number;
};

export function contextWindowProviderOptions(
  args: ContextWindowProviderOptionsArgs,
): ContextWindowProviderOptions {
  if (typeof args.settingValue !== "string") {
    return {};
  }
  const parsed = parseContextWindowOverrides(args.settingValue);
  if (!parsed.success) {
    return {};
  }
  const entry = parsed.overrides[args.threadId];
  if (entry === undefined || entry.model !== args.model) {
    return {};
  }
  return {
    modelContextWindow: entry.contextWindow,
    ...(entry.autoCompactTokenLimit !== undefined
      ? { modelAutoCompactTokenLimit: entry.autoCompactTokenLimit }
      : {}),
  };
}
