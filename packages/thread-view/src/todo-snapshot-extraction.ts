import type {
  Thread,
  ThreadEvent,
  ThreadEventPlanStep,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";
import { orderPlanSteps } from "./plan-step-order.js";

interface SnapshotCandidateMeta {
  seq: number;
  createdAt: number;
}

const PLAN_STEP_TODO_STATUSES: Readonly<
  Record<
    NonNullable<ThreadEventPlanStep["status"]>,
    ThreadTimelinePendingTodoItemStatus
  >
> = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "failed",
};

interface PlanStepsSnapshot {
  steps: readonly ThreadEventPlanStep[];
  meta: SnapshotCandidateMeta;
}

function planStepsSnapshot(
  event: ThreadEvent,
  meta: SnapshotCandidateMeta,
): PlanStepsSnapshot | null {
  if (event.type !== "item/completed" || event.item.type !== "planSteps") {
    return null;
  }
  return { steps: event.item.steps, meta };
}

export function extractThreadTimelinePendingTodos(
  threadStatus: Thread["status"],
  events: readonly ThreadEventWithMeta[],
): ThreadTimelinePendingTodos | null {
  if (threadStatus !== "active") return null;

  let latest: PlanStepsSnapshot | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const candidate = planStepsSnapshot(event, meta);
    if (!candidate) continue;
    if (latest === null || candidate.meta.seq > latest.meta.seq) {
      latest = candidate;
    }
  }
  if (latest === null) return null;
  const { order, steps } = orderPlanSteps(latest.steps);
  return {
    sourceSeq: latest.meta.seq,
    updatedAt: latest.meta.createdAt,
    order,
    items: steps.map(({ key, step, text, position, after }) => ({
      id: key,
      text,
      status: PLAN_STEP_TODO_STATUSES[step.status ?? "pending"],
      position,
      after,
    })),
  };
}
