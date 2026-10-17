import type { ThreadEventPlanStep } from "@bb/domain";
import type { TimelineRowPresentation } from "@bb/server-contract";
import {
  describePlanStep,
  formatPlanStepAfter,
  orderPlanSteps,
  PLAN_STEP_ORDER_CAPTION,
  type PlanStepStatusPhrase,
  type TimelineViewWorkRow,
} from "@bb/thread-view";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { MarkdownPreview } from "../../ui/markdown-preview.js";

export function PresentationDetail({
  presentation,
}: {
  presentation: TimelineRowPresentation | undefined;
}) {
  const detail = presentation?.detail;
  if (detail === undefined || detail.trim().length === 0) {
    return null;
  }
  return (
    <MarkdownPreview
      content={detail}
      className="text-xs text-muted-foreground"
      imagePolicy="alt-text"
    />
  );
}

type PlanStepStatus = NonNullable<ThreadEventPlanStep["status"]>;

const PLAN_STEP_ACTIVITY_STATE: Record<PlanStepStatus, ActivityRowState> = {
  pending: "pending",
  active: "active",
  completed: "completed",
  failed: "completed",
};

const PLAN_STEP_ICON: Record<PlanStepStatus, IconName> = {
  pending: "Square",
  active: "Square",
  completed: "Check",
  failed: "X",
};

const PLAN_STEP_STATUS_PHRASE: Record<PlanStepStatus, PlanStepStatusPhrase> = {
  pending: "pending",
  active: "in progress",
  completed: "completed",
  failed: "failed",
};

export function PlanStepsWorkRowBody({
  row,
}: {
  row: Extract<TimelineViewWorkRow, { workKind: "plan-steps" }>;
}) {
  const plan = orderPlanSteps(row.steps);
  const showsDependencies = plan.order === "dependencies";
  return (
    <div className="space-y-2">
      <PresentationDetail presentation={row.presentation} />
      {row.explanation ? (
        <p className="text-xs text-muted-foreground">{row.explanation}</p>
      ) : null}
      <ul className="space-y-1" data-testid="plan-steps-body">
        {plan.steps.map(({ key, step, text, position, after }) => {
          const status = step.status ?? "pending";
          const activityState = PLAN_STEP_ACTIVITY_STATE[status];
          const afterNote = showsDependencies
            ? formatPlanStepAfter(after)
            : null;
          return (
            <li
              key={key}
              className={activityRowClass(
                activityState,
                "flex min-w-0 items-center gap-2 text-xs",
              )}
              data-plan-step-status={status}
            >
              <span className="sr-only">
                {describePlanStep({
                  order: plan.order,
                  position,
                  total: plan.steps.length,
                  status: PLAN_STEP_STATUS_PHRASE[status],
                  after,
                  text,
                })}
              </span>
              {showsDependencies ? (
                <span
                  aria-hidden="true"
                  className={activityMetaClass(
                    activityState,
                    "min-w-4 shrink-0 text-right tabular-nums",
                  )}
                >
                  {position}
                </span>
              ) : null}
              <Icon
                name={PLAN_STEP_ICON[status]}
                className={cn(
                  "size-3.5 shrink-0",
                  status === "active"
                    ? "text-foreground"
                    : activityIconClass(activityState),
                )}
                aria-hidden="true"
              />
              <span
                aria-hidden="true"
                className={activityTextClass(
                  activityState,
                  "line-clamp-2 min-w-0 flex-1 break-words",
                )}
                title={text}
              >
                {text}
              </span>
              {afterNote === null ? null : (
                <span
                  aria-hidden="true"
                  className={activityMetaClass(
                    activityState,
                    "shrink-0 tabular-nums",
                  )}
                >
                  {afterNote}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className={activityMetaClass("muted", "text-xs")}>
        {PLAN_STEP_ORDER_CAPTION[plan.order]}
      </p>
    </div>
  );
}
