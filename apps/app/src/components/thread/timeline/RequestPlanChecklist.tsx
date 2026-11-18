import { useId, useState } from "react";
import type { ThreadEventPlanStep } from "@bb/domain";
import type { TimelineRequestPlan } from "@bb/server-contract";
import {
  describePlanStep,
  formatPlanStepAfter,
  orderPlanSteps,
  type OrderedPlanStep,
  type PlanStepStatusPhrase,
} from "@bb/thread-view";
import {
  activityIconClass,
  activityMetaClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Button } from "@bb/shared-ui/button";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

type PlanStepStatus = NonNullable<ThreadEventPlanStep["status"]>;
type TurnStatus = TimelineRequestPlan["turnStatus"];

const COLLAPSED_STEP_LIMIT = 5;
const LEAD_TEXT_CLASS = "font-medium text-foreground";
const PARALLEL_CLASS = "text-muted-foreground";
const UPCOMING_CLASS = "text-subtle-foreground";
const COLLAPSE_THRESHOLD = 6;

const STEP_STATE: Record<PlanStepStatus, ActivityRowState> = {
  pending: "pending",
  active: "active",
  completed: "completed",
  failed: "failed",
};

const STEP_ICON: Record<PlanStepStatus, IconName> = {
  pending: "Circle",
  active: "Spinner",
  completed: "Check",
  failed: "X",
};

const STEP_PHRASE: Record<PlanStepStatus, PlanStepStatusPhrase> = {
  pending: "pending",
  active: "in progress",
  completed: "completed",
  failed: "failed",
};

const ENDED_NOTE: Record<Exclude<TurnStatus, "pending">, string> = {
  completed: "The turn ended",
  interrupted: "Stopped",
  error: "The turn failed",
};

function stepStatus(step: OrderedPlanStep): PlanStepStatus {
  return step.step.status ?? "pending";
}

function anchorIndex(steps: readonly OrderedPlanStep[]): number {
  const active = steps.findIndex((step) => stepStatus(step) === "active");
  if (active !== -1) return active;
  const pending = steps.findIndex((step) => stepStatus(step) === "pending");
  return pending === -1 ? steps.length - 1 : pending;
}

function collapsedWindow(
  steps: readonly OrderedPlanStep[],
  anchor: number,
): readonly OrderedPlanStep[] {
  const start = Math.max(
    0,
    Math.min(anchor - 1, steps.length - COLLAPSED_STEP_LIMIT),
  );
  return steps.slice(start, start + COLLAPSED_STEP_LIMIT);
}

function ChecklistStep({
  step,
  total,
  showsDependencies,
  order,
  live,
  anchor,
}: {
  step: OrderedPlanStep;
  total: number;
  showsDependencies: boolean;
  order: ReturnType<typeof orderPlanSteps>["order"];
  live: boolean;
  anchor: boolean;
}) {
  const status = stepStatus(step);
  const current = status === "active";
  const lead = current && anchor;
  const spinning = current && live;
  const state: ActivityRowState = current ? "pending" : STEP_STATE[status];
  const afterNote = showsDependencies ? formatPlanStepAfter(step.after) : null;
  return (
    <li
      className="flex min-w-0 items-start gap-2 px-2 py-1"
      data-plan-step-status={status}
      aria-current={spinning && lead ? "step" : undefined}
    >
      <span className="sr-only">
        {describePlanStep({
          order,
          position: step.position,
          total,
          status: STEP_PHRASE[status],
          after: step.after,
          text: step.text,
        })}
      </span>
      {showsDependencies ? (
        <span
          aria-hidden="true"
          className={activityMetaClass(
            state,
            "mt-0.5 min-w-4 shrink-0 text-right text-xs tabular-nums",
          )}
        >
          {step.position}
        </span>
      ) : null}
      <span aria-hidden="true" className="flex h-5 shrink-0 items-center">
        <Icon
          name={spinning ? "Spinner" : current ? "Circle" : STEP_ICON[status]}
          className={cn(
            "size-3.5",
            lead
              ? "text-foreground"
              : current
                ? PARALLEL_CLASS
                : status === "pending"
                  ? UPCOMING_CLASS
                  : activityIconClass(state),
            spinning && "animate-spin motion-reduce:animate-none",
          )}
        />
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "line-clamp-2 min-w-0 flex-1 break-words",
          lead
            ? LEAD_TEXT_CLASS
            : current
              ? PARALLEL_CLASS
              : status === "pending"
                ? UPCOMING_CLASS
                : activityTextClass(state),
        )}
        title={step.text}
      >
        {step.text}
      </span>
      {afterNote === null ? null : (
        <span
          aria-hidden="true"
          className={activityMetaClass(
            state,
            "mt-0.5 shrink-0 text-xs tabular-nums",
          )}
        >
          {afterNote}
        </span>
      )}
    </li>
  );
}

export function RequestPlanChecklist({ plan }: { plan: TimelineRequestPlan }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const ordered = orderPlanSteps(plan.steps);
  const steps = ordered.steps;
  if (steps.length === 0) return null;

  const live = plan.turnStatus === "pending";
  const doneCount = steps.filter(
    (step) => stepStatus(step) === "completed",
  ).length;
  const showsDependencies = ordered.order === "dependencies";
  const collapsible = steps.length >= COLLAPSE_THRESHOLD;
  const anchor = anchorIndex(steps);
  const anchorKey = steps[anchor]?.key;
  const visible =
    collapsible && !expanded ? collapsedWindow(steps, anchor) : steps;
  const progress = `${doneCount} of ${steps.length} ${
    steps.length === 1 ? "step" : "steps"
  } done`;
  const endedNote =
    plan.turnStatus === "pending" || doneCount === steps.length
      ? null
      : `${ENDED_NOTE[plan.turnStatus]} with ${progress}.`;

  return (
    <section
      aria-label={`Plan, ${progress}`}
      className="mt-2 rounded-lg border border-border/70 py-1 text-sm"
      data-request-plan-status={plan.turnStatus}
    >
      <ol id={listId} className="flex flex-col">
        {visible.map((step) => (
          <ChecklistStep
            key={step.key}
            step={step}
            total={steps.length}
            showsDependencies={showsDependencies}
            order={ordered.order}
            live={live}
            anchor={step.key === anchorKey}
          />
        ))}
      </ol>
      {endedNote === null && !collapsible ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 px-2 pt-0.5">
          {endedNote === null ? null : (
            <p className={activityMetaClass("muted", "py-1 text-xs")}>
              {endedNote}
            </p>
          )}
          {collapsible ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-controls={listId}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              className="-mx-1 h-6 px-1 text-muted-foreground"
            >
              {expanded ? "Show fewer steps" : `Show all ${steps.length} steps`}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
