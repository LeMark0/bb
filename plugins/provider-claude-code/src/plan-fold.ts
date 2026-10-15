import type { ThreadEventPlanStep } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

const taskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
type ClaudeTaskStatus = z.infer<typeof taskStatusSchema>;
const taskUpdateStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "deleted",
]);
const taskBlockedBySchema = z.array(z.string()).optional().catch(undefined);

const taskCreateArgsSchema = z
  .object({ subject: z.string(), activeForm: z.string().optional() })
  .passthrough();
const taskCreateOutputSchema = z
  .object({
    task: z.object({ id: z.string(), subject: z.string() }).passthrough(),
  })
  .passthrough();

const taskUpdateArgsSchema = z
  .object({
    taskId: z.string(),
    status: taskUpdateStatusSchema.optional(),
    subject: z.string().optional(),
    activeForm: z.string().optional(),
    addBlocks: z.array(z.string()).optional(),
    addBlockedBy: z.array(z.string()).optional(),
  })
  .passthrough();
const taskUpdateOutputSchema = z
  .object({ success: z.boolean(), taskId: z.string() })
  .passthrough();

const taskListItemSchema = z
  .object({
    id: z.string(),
    status: taskUpdateStatusSchema,
    subject: z.string(),
    blockedBy: taskBlockedBySchema,
  })
  .passthrough();
const taskListOutputSchema = z
  .object({ tasks: z.array(z.unknown()) })
  .passthrough();

const taskGetArgsSchema = z.object({ taskId: z.string() }).passthrough();
const taskGetOutputSchema = z
  .object({
    task: z
      .object({
        id: z.string(),
        status: taskStatusSchema,
        subject: z.string(),
        blockedBy: taskBlockedBySchema,
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export interface ClaudeTaskPlanItem {
  id: string;
  subject: string;
  activeForm: string | null;
  status: ClaudeTaskStatus;
  blockedBy: readonly string[] | null;
}

export type ClaudeTaskPlanState = Map<string, ClaudeTaskPlanItem>;

export const CLAUDE_TASK_PLAN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function optionalText(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function snapshot(state: ClaudeTaskPlanState): ThreadEventPlanStep[] {
  const shown = [...state.values()].flatMap((task) => {
    const text =
      task.status === "in_progress" && task.activeForm !== null
        ? task.activeForm
        : task.subject;
    return text.length === 0 ? [] : [{ task, text }];
  });
  const shownIds = new Set(shown.map(({ task }) => task.id));
  return shown.map(({ task, text }) => {
    const needs =
      task.blockedBy !== null && task.blockedBy.every((id) => shownIds.has(id))
        ? [...task.blockedBy]
        : undefined;
    return {
      step: text,
      status: task.status === "in_progress" ? "active" : task.status,
      id: task.id,
      ...(needs === undefined ? {} : { needs }),
    };
  });
}

function withBlockers(
  blockedBy: readonly string[] | null,
  added: readonly string[],
): readonly string[] | null {
  if (blockedBy === null) return null;
  const missing = [...new Set(added)].filter((id) => !blockedBy.includes(id));
  return missing.length === 0 ? blockedBy : [...blockedBy, ...missing];
}

function sameBlockers(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((id) => right.includes(id));
}

function isSameTask(left: ClaudeTaskPlanItem, right: ClaudeTaskPlanItem) {
  return (
    left.id === right.id &&
    left.subject === right.subject &&
    left.activeForm === right.activeForm &&
    left.status === right.status &&
    sameBlockers(left.blockedBy, right.blockedBy)
  );
}

function deleteTask(state: ClaudeTaskPlanState, taskId: string): boolean {
  if (!state.delete(taskId)) return false;
  for (const task of state.values()) {
    if (task.blockedBy?.includes(taskId)) {
      state.set(task.id, {
        ...task,
        blockedBy: task.blockedBy.filter((id) => id !== taskId),
      });
    }
  }
  return true;
}

function addBlocks(
  state: ClaudeTaskPlanState,
  blockerId: string,
  blockedIds: readonly string[],
): void {
  for (const blockedId of blockedIds) {
    const blocked = state.get(blockedId);
    if (blocked !== undefined) {
      state.set(blockedId, {
        ...blocked,
        blockedBy: withBlockers(blocked.blockedBy, [blockerId]),
      });
    }
  }
}

function listedBlockers(args: {
  listed: readonly string[] | undefined;
  previous: readonly string[] | null;
  listedIds: ReadonlySet<string>;
  completedBlockersOmitted: boolean;
}): readonly string[] | null {
  if (args.listed?.some((id) => !args.listedIds.has(id))) return null;
  if (args.previous !== null) {
    return withBlockers(
      args.previous.filter((id) => args.listedIds.has(id)),
      args.listed ?? [],
    );
  }
  if (args.listed === undefined || args.completedBlockersOmitted) return null;
  return args.listed;
}

export function foldClaudeTaskToolResult(args: {
  state: ClaudeTaskPlanState;
  toolName: string;
  input: unknown;
  output: unknown;
  failed: boolean;
}): ThreadEventPlanStep[] | null {
  if (args.failed || !CLAUDE_TASK_PLAN_TOOL_NAMES.has(args.toolName)) {
    return null;
  }
  const { state } = args;
  const output = parseMaybeJson(args.output);
  switch (args.toolName) {
    case "TaskCreate": {
      const parsedArgs = taskCreateArgsSchema.safeParse(args.input);
      const parsedOutput = taskCreateOutputSchema.safeParse(output);
      if (!parsedArgs.success || !parsedOutput.success) return null;
      const subject =
        optionalText(parsedArgs.data.subject) ??
        optionalText(parsedOutput.data.task.subject) ??
        "";
      state.set(parsedOutput.data.task.id, {
        id: parsedOutput.data.task.id,
        subject,
        activeForm: optionalText(parsedArgs.data.activeForm),
        status: "pending",
        blockedBy: [],
      });
      return snapshot(state);
    }
    case "TaskUpdate": {
      const parsedArgs = taskUpdateArgsSchema.safeParse(args.input);
      const parsedOutput = taskUpdateOutputSchema.safeParse(output);
      if (
        !parsedArgs.success ||
        !parsedOutput.success ||
        !parsedOutput.data.success
      ) {
        return null;
      }
      const update = parsedArgs.data;
      if (update.status === "deleted") {
        return deleteTask(state, update.taskId) ? snapshot(state) : null;
      }
      const existing = state.get(update.taskId);
      if (existing === undefined) return null;
      const blockedIds = update.addBlocks ?? [];
      const affected = [
        existing,
        ...blockedIds.flatMap((id) => state.get(id) ?? []),
      ];
      const addBlockedBy = update.addBlockedBy ?? [];
      state.set(update.taskId, {
        id: update.taskId,
        subject: optionalText(update.subject) ?? existing.subject,
        activeForm:
          update.activeForm === undefined
            ? existing.activeForm
            : optionalText(update.activeForm),
        status: update.status ?? existing.status,
        blockedBy: addBlockedBy.every((id) => state.has(id))
          ? withBlockers(existing.blockedBy, addBlockedBy)
          : null,
      });
      addBlocks(state, update.taskId, blockedIds);
      const changed = affected.some((before) => {
        const after = state.get(before.id);
        return after === undefined || !isSameTask(before, after);
      });
      return changed ? snapshot(state) : null;
    }
    case "TaskList": {
      const parsedOutput = taskListOutputSchema.safeParse(output);
      if (!parsedOutput.success) return null;
      const listed = parsedOutput.data.tasks.flatMap((raw) => {
        const task = taskListItemSchema.safeParse(raw);
        if (!task.success) return [];
        const { id, subject, status, blockedBy } = task.data;
        return status === "deleted" ? [] : [{ id, subject, status, blockedBy }];
      });
      const listedIds = new Set(listed.map((task) => task.id));
      const completedBlockersOmitted = listed.some(
        (task) => task.status === "completed",
      );
      const previous = new Map(state);
      state.clear();
      for (const task of listed) {
        state.set(task.id, {
          id: task.id,
          subject: task.subject.trim(),
          activeForm: null,
          status: task.status,
          blockedBy: listedBlockers({
            listed: task.blockedBy,
            previous: previous.get(task.id)?.blockedBy ?? null,
            listedIds,
            completedBlockersOmitted,
          }),
        });
      }
      return snapshot(state);
    }
    case "TaskGet": {
      const parsedArgs = taskGetArgsSchema.safeParse(args.input);
      const parsedOutput = taskGetOutputSchema.safeParse(output);
      if (!parsedArgs.success || !parsedOutput.success) return null;
      const task = parsedOutput.data.task;
      if (task === null) {
        return deleteTask(state, parsedArgs.data.taskId)
          ? snapshot(state)
          : null;
      }
      const existing = state.get(task.id);
      const next: ClaudeTaskPlanItem = {
        id: task.id,
        subject: task.subject.trim(),
        activeForm: existing?.activeForm ?? null,
        status: task.status,
        blockedBy: task.blockedBy ?? existing?.blockedBy ?? null,
      };
      if (existing !== undefined && isSameTask(existing, next)) return null;
      state.set(task.id, next);
      return snapshot(state);
    }
    default:
      return null;
  }
}
