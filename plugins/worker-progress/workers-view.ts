import {
  countDescendants,
  splitWorkerTitle,
  workerPlan,
  workerState,
  workerTitle,
  type WorkerActivity,
  type WorkerEntry,
  type WorkerNode,
  type WorkerPlan,
  type WorkerState,
} from "./workers-model.js";
import type { WorkersSnapshot } from "./workers-store.js";

export const MAX_NESTED_ROWS = 3;
export const LONG_IDLE_FOLD_MS = 60 * 60_000;

const HEADER_ORDER: readonly { state: WorkerState; label: string }[] = [
  { state: "waiting-approval", label: "needs approval" },
  { state: "error", label: "error" },
  { state: "working", label: "working" },
  { state: "starting", label: "starting" },
  { state: "waiting-for-host", label: "waiting for host" },
  { state: "stopping", label: "stopping" },
  { state: "unknown", label: "unknown" },
];

export const ROW_STATE_LABEL: Readonly<Record<WorkerState, string>> = {
  working: "Working",
  "waiting-approval": "Needs approval",
  starting: "Starting",
  "waiting-for-host": "Waiting for host",
  stopping: "Stopping",
  idle: "Idle",
  error: "Error",
  unknown: "Status unknown",
};

function headerCounts(
  states: readonly WorkerState[],
  complete: boolean,
): string[] {
  const parts = HEADER_ORDER.flatMap(({ state, label }) => {
    const count = states.filter((candidate) => candidate === state).length;
    return count === 0 ? [] : [`${count} ${label}`];
  });
  if (!complete) return ["some not shown", ...parts];
  return parts.length === 0 ? ["all idle"] : parts;
}

export function headerSummary(
  states: readonly WorkerState[],
  complete = true,
): string {
  return ["Workers", ...headerCounts(states, complete)].join(" · ");
}

export function belowFoldSummary(states: readonly WorkerState[]): string {
  const actionable = HEADER_ORDER.filter(({ state }) => state !== "working")
    .flatMap(({ state, label }) => {
      const count = states.filter((candidate) => candidate === state).length;
      return count === 0 ? [] : [`${count} ${label}`];
    });
  return [`+${states.length} more below`, ...actionable].join(" · ");
}

export function headerAccessibleName(
  states: readonly WorkerState[],
  complete = true,
): string {
  return `Workers: ${headerCounts(states, complete).join(", ")}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatAgo(ms: number): string {
  return ms < 60_000 ? "just now" : `${formatDuration(ms)} ago`;
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function elapsedText(activity: WorkerActivity, now: number): string {
  const elapsed = now - activity.since;
  return activity.sinceKind === "running"
    ? formatDuration(elapsed)
    : formatAgo(elapsed);
}

export function statusLine(args: {
  state: WorkerState;
  updatedAt: number;
  lastSeenAt: number | null;
  now: number;
}): string | null {
  switch (args.state) {
    case "error":
      return `Stopped with an error · ${formatAgo(args.now - args.updatedAt)}`;
    case "idle":
      return `Not running · last update ${formatAgo(args.now - args.updatedAt)}`;
    case "unknown":
      return args.lastSeenAt === null
        ? "No update received"
        : `No update received · last seen ${formatAgo(args.now - args.lastSeenAt)}`;
    default:
      return null;
  }
}

export function planSummaryText(
  plan: Extract<WorkerPlan, { kind: "shared" }>,
  now: number,
): string {
  const done = `${plan.completed} of ${plan.total} done`;
  return plan.fromEarlierTurn
    ? `${done} · plan from ${formatAgo(now - plan.todos.updatedAt)}`
    : done;
}

export function rowSentence(args: {
  name: string;
  state: WorkerState;
  request: string | null;
  activity: WorkerActivity | null;
  plan: WorkerPlan;
}): string {
  const head = [
    args.name,
    ROW_STATE_LABEL[args.state].toLowerCase(),
    ...(args.request === null ? [] : [`request: ${args.request}`]),
  ].join(", ");
  const activity =
    args.activity === null
      ? null
      : `${args.activity.text}, ${
          args.activity.sinceKind === "running" ? "running since" : "posted at"
        } ${formatClock(args.activity.since)}`;
  const plan =
    args.plan.kind === "shared"
      ? `${args.plan.completed} of ${args.plan.total} done${
          args.plan.fromEarlierTurn ? ", plan last updated before this turn" : ""
        }`
      : args.plan.kind === "none"
        ? "no plan shared"
        : "plan not available while not running";
  return [head, activity, plan]
    .filter((part): part is string => part !== null)
    .map((part) => `${part}.`)
    .join(" ");
}

export interface WorkerRowView {
  threadId: string;
  name: string;
  subject: string | null;
  state: WorkerState;
  request: string | null;
  activity: WorkerActivity | null;
  requestIsActivity: boolean;
  plan: WorkerPlan;
  updatedAt: number;
}

export function describeWorkerRow(
  entry: WorkerEntry,
  snapshot: Pick<WorkersSnapshot, "freshness" | "details" | "failedDetails">,
): WorkerRowView {
  const state = workerState(entry, snapshot.freshness);
  const detail = snapshot.failedDetails.has(entry.id)
    ? undefined
    : snapshot.details.get(entry.id);
  const isRunning = state === "working" || state === "waiting-approval";
  const { name, subject } = splitWorkerTitle(workerTitle(entry));
  const request =
    state === "waiting-approval" ? (detail?.turn.approval ?? null) : null;
  const activity = isRunning ? (detail?.turn.activity ?? null) : null;
  return {
    threadId: entry.id,
    name: name.length > 0 ? name : "Untitled worker",
    subject,
    state,
    request,
    activity,
    requestIsActivity:
      request !== null &&
      activity !== null &&
      detail?.turn.activityIsApproval === true,
    plan:
      isRunning && detail !== undefined
        ? workerPlan({
            isActive: entry.status === "active",
            todos: detail.todos,
            currentTurnStartedAt: detail.turn.startedAt,
          })
        : { kind: "unavailable" },
    updatedAt: entry.updatedAt,
  };
}

function rowTextLines(
  row: WorkerRowView,
  lastSeenAt: number | null,
  now: number,
): string[] {
  const head = [
    row.name,
    ...(row.subject === null ? [] : [row.subject]),
    ROW_STATE_LABEL[row.state],
    ...(row.plan.kind === "none" ? ["No plan shared"] : []),
  ].join(" · ");
  const status = statusLine({
    state: row.state,
    updatedAt: row.updatedAt,
    lastSeenAt,
    now,
  });
  const plan = row.plan;
  const elapsed =
    row.activity === null ? null : elapsedText(row.activity, now);
  return [
    head,
    ...(row.request === null
      ? []
      : [
          row.requestIsActivity && elapsed !== null
            ? `  Request · ${row.request} (${elapsed})`
            : `  Request · ${row.request}`,
        ]),
    ...(row.activity === null || row.requestIsActivity
      ? []
      : [`  ${row.activity.text} (${elapsed})`]),
    ...(plan.kind === "shared"
      ? [
          ...plan.current.map((step) => `  Now · ${step.text}`),
          ...(plan.next === null ? [] : [`  Next · ${plan.next.text}`]),
          `  ${planSummaryText(plan, now)}`,
        ]
      : []),
    ...(status === null ? [] : [`  ${status}`]),
  ];
}

export function formatWorkersText(
  snapshot: WorkersSnapshot,
  now: number,
): string {
  const lines = (nodes: readonly WorkerNode[], depth: number): string[] =>
    nodes.flatMap((node) => [
      ...rowTextLines(
        describeWorkerRow(node.entry, snapshot),
        snapshot.lastListedAt,
        now,
      ).map((line) => `${"  ".repeat(depth)}${line}`),
      ...lines(node.children, depth + 1),
    ]);
  const states = workerStates(snapshot);
  return states.length === 0
    ? "No workers below this thread."
    : [headerSummary(states, snapshot.complete), ...lines(snapshot.forest, 0)].join("\n");
}

export interface NestedRows {
  shown: readonly WorkerNode[];
  collapsedCount: number;
}

export function nestedRows(node: WorkerNode, expanded: boolean): NestedRows {
  if (expanded || node.children.length <= MAX_NESTED_ROWS) {
    return { shown: node.children, collapsedCount: 0 };
  }
  return {
    shown: node.children.slice(0, MAX_NESTED_ROWS),
    collapsedCount: node.children.length - MAX_NESTED_ROWS,
  };
}

export function allNodes(forest: readonly WorkerNode[]): WorkerNode[] {
  return forest.flatMap((node) => [node, ...allNodes(node.children)]);
}

export interface FoldedForest {
  shown: readonly WorkerNode[];
  folded: readonly WorkerNode[];
  foldedCount: number;
}

export function foldLongIdle(
  forest: readonly WorkerNode[],
  freshness: WorkersSnapshot["freshness"],
  now: number,
): FoldedForest {
  const isLongIdle = (node: WorkerNode) => {
    const subtree = allNodes([node]);
    return (
      subtree.every((member) => workerState(member.entry, freshness) === "idle") &&
      Math.max(...subtree.map((member) => member.entry.updatedAt)) <
        now - LONG_IDLE_FOLD_MS
    );
  };
  const folded = forest.filter(isLongIdle);
  return {
    shown: forest.filter((node) => !isLongIdle(node)),
    folded,
    foldedCount: allNodes(folded).length,
  };
}

export function workerStates(
  snapshot: Pick<WorkersSnapshot, "forest" | "freshness">,
): WorkerState[] {
  return allNodes(snapshot.forest).map((node) =>
    workerState(node.entry, snapshot.freshness),
  );
}

export interface IdleCardState {
  anyBusy: boolean;
  coordinatorRunning: boolean;
  dismissed: boolean;
  expanded: boolean;
}

export function nextIdleCardState(
  previous: IdleCardState,
  anyBusy: boolean,
  coordinatorRunning: boolean,
): IdleCardState {
  if (anyBusy) {
    return { anyBusy, coordinatorRunning, dismissed: false, expanded: false };
  }
  const coordinatorStarted = coordinatorRunning && !previous.coordinatorRunning;
  return {
    ...previous,
    anyBusy,
    coordinatorRunning,
    dismissed: previous.dismissed || coordinatorStarted,
  };
}

export type CardVisibility = "expanded-or-collapsed" | "all-idle" | "hidden";

export function cardVisibility(args: {
  workerCount: number;
  anyBusy: boolean;
  dismissedWhileIdle: boolean;
}): CardVisibility {
  if (args.workerCount === 0) return "hidden";
  if (args.anyBusy) return "expanded-or-collapsed";
  return args.dismissedWhileIdle ? "hidden" : "all-idle";
}
