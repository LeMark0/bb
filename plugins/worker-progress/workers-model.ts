import type {
  ThreadListEntry,
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { TimelineRow, TimelineWorkRow } from "@bb/server-contract";

export type WorkerEntry = Pick<
  ThreadListEntry,
  | "id"
  | "title"
  | "titleFallback"
  | "parentThreadId"
  | "status"
  | "runtime"
  | "hasPendingInteraction"
  | "createdAt"
  | "updatedAt"
>;

export type WorkerState =
  | "working"
  | "waiting-approval"
  | "starting"
  | "waiting-for-host"
  | "stopping"
  | "idle"
  | "error"
  | "unknown";

export type Freshness = "live" | "stale";

export function workerState(
  entry: Pick<WorkerEntry, "runtime" | "hasPendingInteraction">,
  freshness: Freshness,
): WorkerState {
  if (freshness === "stale") return "unknown";
  if (entry.hasPendingInteraction) return "waiting-approval";
  switch (entry.runtime.displayStatus) {
    case "active":
      return "working";
    case "pending":
    case "starting":
    case "provisioning":
      return "starting";
    case "waiting-for-host":
      return "waiting-for-host";
    case "stopping":
      return "stopping";
    case "idle":
      return "idle";
    case "error":
      return "error";
  }
}

export function isWorkerBusy(state: WorkerState): boolean {
  return state !== "idle";
}

export type WorkerPlan =
  | {
      kind: "shared";
      todos: ThreadTimelinePendingTodos;
      completed: number;
      total: number;
      current: readonly ThreadTimelinePendingTodoItem[];
      next: ThreadTimelinePendingTodoItem | null;
      fromEarlierTurn: boolean;
    }
  | { kind: "none" }
  | { kind: "unavailable" };

export function workerPlan(args: {
  isActive: boolean;
  todos: ThreadTimelinePendingTodos | null;
  currentTurnStartedAt: number | null;
}): WorkerPlan {
  if (!args.isActive) return { kind: "unavailable" };
  const todos = args.todos;
  if (todos === null || todos.items.length === 0) return { kind: "none" };
  return {
    kind: "shared",
    todos,
    completed: todos.items.filter((item) => item.status === "completed")
      .length,
    total: todos.items.length,
    current: todos.items.filter((item) => item.status === "in_progress"),
    next: todos.items.find((item) => item.status === "pending") ?? null,
    fromEarlierTurn:
      args.currentTurnStartedAt !== null &&
      todos.updatedAt < args.currentTurnStartedAt,
  };
}

export type ActivitySource = "intent" | "commentary" | "label";

export interface WorkerActivity {
  text: string;
  source: ActivitySource;
  since: number;
  sinceKind: "running" | "posted";
  detail: string | null;
}

export interface WorkerTurn {
  startedAt: number | null;
  activity: WorkerActivity | null;
  approval: string | null;
  activityIsApproval: boolean;
}

const COMMENTARY_MAX_LENGTH = 240;

function flattenRows(rows: readonly TimelineRow[]): TimelineRow[] {
  return rows.flatMap((row) =>
    row.kind === "turn" && row.children !== null
      ? [row, ...flattenRows(row.children)]
      : [row],
  );
}

function lastMatch<T, S extends T>(
  items: readonly T[],
  predicate: (item: T) => item is S,
): S | null {
  return [...items].reverse().find(predicate) ?? null;
}

function currentSegment(rows: readonly TimelineRow[]): TimelineRow[] {
  const flat: TimelineRow[] = flattenRows(rows).filter(
    (row) => row.kind !== "turn",
  );
  const lastUser = lastMatch(
    flat,
    (row): row is TimelineRow =>
      row.kind === "conversation" && row.role === "user",
  );
  return lastUser === null ? flat : flat.slice(flat.lastIndexOf(lastUser));
}

function presentationOf(row: TimelineWorkRow) {
  return "presentation" in row ? row.presentation : undefined;
}

function nonEmpty(text: string | null | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function rowIntent(row: TimelineWorkRow): string | null {
  const presentation = presentationOf(row);
  if (row.workKind === "command") {
    return nonEmpty(presentation?.detail) === null
      ? null
      : nonEmpty(presentation?.title);
  }
  if (row.workKind === "delegation") {
    return nonEmpty(presentation?.title) ?? nonEmpty(row.description);
  }
  return null;
}

function rowLabel(row: TimelineWorkRow): string | null {
  const presentation = presentationOf(row);
  const verb = nonEmpty(presentation?.label.pending);
  if (verb === null) return null;
  if (row.workKind === "command") return verb;
  const title = nonEmpty(presentation?.title);
  return title === null ? verb : `${verb} ${title}`;
}

function commandDetail(row: TimelineWorkRow): string | null {
  return row.workKind === "command" ? nonEmpty(row.command) : null;
}

function commentaryText(text: string): string | null {
  const firstParagraph = text.trim().split(/\n\s*\n/u, 1)[0] ?? "";
  const flat = firstParagraph.replace(/\s+/gu, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > COMMENTARY_MAX_LENGTH
    ? `${flat.slice(0, COMMENTARY_MAX_LENGTH - 1)}…`
    : flat;
}

function isRunningWork(row: TimelineRow): row is TimelineWorkRow {
  return (
    row.kind === "work" &&
    row.status === "pending" &&
    row.workKind !== "plan-steps" &&
    row.workKind !== "approval"
  );
}

export function workerTurn(rows: readonly TimelineRow[]): WorkerTurn {
  const segment = currentSegment(rows);
  const first = segment[0];
  const startedAt = first === undefined ? null : first.startedAt;
  const running = lastMatch(segment, isRunningWork);
  const waiting = lastMatch(
    segment,
    (row): row is TimelineWorkRow =>
      isRunningWork(row) &&
      row.workKind === "command" &&
      row.approvalStatus === "waiting_for_approval",
  );
  const commentary = lastMatch(
    segment,
    (row): row is Extract<TimelineRow, { kind: "conversation" }> =>
      row.kind === "conversation" && row.role === "assistant",
  );
  const intent = running === null ? null : rowIntent(running);
  const comment = commentary === null ? null : commentaryText(commentary.text);
  const label = running === null ? null : rowLabel(running);
  const activity: WorkerActivity | null =
    running !== null && intent !== null
      ? {
          text: intent,
          source: "intent",
          since: running.startedAt,
          sinceKind: "running",
          detail: commandDetail(running),
        }
      : commentary !== null && comment !== null
        ? {
            text: comment,
            source: "commentary",
            since: commentary.createdAt,
            sinceKind: "posted",
            detail: null,
          }
        : running !== null && label !== null
          ? {
              text: label,
              source: "label",
              since: running.startedAt,
              sinceKind: "running",
              detail: commandDetail(running),
            }
          : null;
  return {
    startedAt,
    activity,
    approval:
      waiting === null ? null : (rowIntent(waiting) ?? rowLabel(waiting)),
    activityIsApproval:
      waiting !== null &&
      waiting === running &&
      activity !== null &&
      activity.source !== "commentary",
  };
}

const TRACKER_KEY_PREFIX = /^[A-Za-z][A-Za-z0-9]*-\d+\s+·\s+/u;

export function splitWorkerTitle(title: string): {
  name: string;
  subject: string | null;
} {
  const withoutKey = title.replace(TRACKER_KEY_PREFIX, "");
  const separator = withoutKey.indexOf(" · ");
  if (separator === -1) return { name: withoutKey.trim(), subject: null };
  return {
    name: withoutKey.slice(0, separator).trim(),
    subject: nonEmpty(withoutKey.slice(separator + 3)),
  };
}

export function workerTitle(entry: Pick<WorkerEntry, "title" | "titleFallback">) {
  return nonEmpty(entry.title) ?? nonEmpty(entry.titleFallback) ?? "Untitled thread";
}

export interface WorkerNode {
  entry: WorkerEntry;
  children: WorkerNode[];
}

function bySpawnOrder(a: WorkerEntry, b: WorkerEntry): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function buildWorkerForest(
  rootThreadId: string,
  entries: readonly WorkerEntry[],
): WorkerNode[] {
  const byParent = entries.reduce((groups, entry) => {
    if (entry.parentThreadId === null) return groups;
    const siblings = groups.get(entry.parentThreadId) ?? [];
    return groups.set(entry.parentThreadId, [...siblings, entry]);
  }, new Map<string, WorkerEntry[]>());
  const build = (parentId: string, seen: ReadonlySet<string>): WorkerNode[] =>
    [...(byParent.get(parentId) ?? [])]
      .filter((entry) => !seen.has(entry.id))
      .sort(bySpawnOrder)
      .map((entry) => ({
        entry,
        children: build(entry.id, new Set([...seen, entry.id])),
      }));
  return build(rootThreadId, new Set([rootThreadId]));
}

export function countDescendants(node: WorkerNode): number {
  return node.children.reduce(
    (total, child) => total + 1 + countDescendants(child),
    0,
  );
}
