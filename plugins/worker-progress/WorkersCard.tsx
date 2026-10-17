import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import type {
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { CONTEXT_CARD_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { REDUCED_MOTION_QUERY } from "@bb/shared-ui/hooks/use-media-query";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackCollapseRow,
  PromptStackHoverChevron,
  useDisclosureFocusHandoff,
} from "@bb/shared-ui/prompt-stack-disclosure";
import {
  describePlanStep,
  formatPlanStepAfter,
  PLAN_STEP_ORDER_CAPTION,
  type PlanStepStatusPhrase,
} from "@bb/thread-view";
import { cn } from "@bb/shared-ui/lib/utils";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useNow, useNowMinute } from "./use-workers.js";
import {
  countDescendants,
  type WorkerActivity,
  type WorkerNode,
  type WorkerPlan,
  type WorkerState,
} from "./workers-model.js";
import type { WorkersSnapshot } from "./workers-store.js";
import {
  belowFoldSummary,
  describeWorkerRow,
  elapsedText,
  foldLongIdle,
  headerAccessibleName,
  headerSummary,
  nestedRows,
  planSummaryText,
  ROW_STATE_LABEL,
  rowSentence,
  statusLine,
  workerStates,
} from "./workers-view.js";

const HEADER_BUTTON_CLASS =
  "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80";

const STATE_TEXT_CLASS: Record<WorkerState, string> = {
  working: "text-foreground",
  "waiting-approval": "font-medium text-warning-text",
  starting: "text-muted-foreground",
  "waiting-for-host": "text-muted-foreground",
  stopping: "text-muted-foreground",
  idle: "text-subtle-foreground",
  error: "font-medium text-destructive-text",
  unknown: "text-subtle-foreground",
};

const STATE_DOT_CLASS: Record<WorkerState, string> = {
  working: "bg-foreground motion-safe:animate-pulse",
  "waiting-approval": "bg-warning-text",
  starting: "bg-muted-foreground",
  "waiting-for-host": "bg-muted-foreground",
  stopping: "bg-muted-foreground",
  idle: "bg-subtle-foreground",
  error: "bg-destructive-text",
  unknown: "border border-dashed border-subtle-foreground bg-transparent",
};

const STEP_ACTIVITY_STATE: Record<
  ThreadTimelinePendingTodoItemStatus,
  ActivityRowState
> = {
  in_progress: "active",
  pending: "pending",
  completed: "completed",
  failed: "completed",
};

const STEP_STATUS_PHRASE: Record<
  ThreadTimelinePendingTodoItemStatus,
  PlanStepStatusPhrase
> = {
  in_progress: "in progress",
  pending: "pending",
  completed: "completed",
  failed: "failed",
};

const STEP_ICON: Record<ThreadTimelinePendingTodoItemStatus, string> = {
  in_progress: "Square",
  pending: "Square",
  completed: "Check",
  failed: "X",
};

interface RowContext {
  snapshot: WorkersSnapshot;
  openThread: (threadId: string) => void;
  expandedPlans: ReadonlySet<string>;
  togglePlan: (threadId: string) => void;
  expandedNested: ReadonlySet<string>;
  expandNested: (threadId: string) => void;
}

function Elapsed({ activity }: { activity: WorkerActivity }) {
  const now = useNow();
  return (
    <span aria-hidden="true" className="shrink-0 tabular-nums text-subtle-foreground">
      {elapsedText(activity, now)}
    </span>
  );
}

function StatusLine({
  state,
  updatedAt,
  lastSeenAt,
}: {
  state: WorkerState;
  updatedAt: number;
  lastSeenAt: number | null;
}) {
  const now = useNow();
  const text = statusLine({ state, updatedAt, lastSeenAt, now });
  if (text === null) return null;
  return (
    <p aria-hidden="true" className="mt-0.5 truncate pl-3 text-xs text-subtle-foreground">
      {text}
    </p>
  );
}

function PlanSummary({
  plan,
  threadId,
  isOpen,
  onToggle,
}: {
  plan: Extract<WorkerPlan, { kind: "shared" }>;
  threadId: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const now = useNow();
  const listId = `worker-plan-${threadId}`;
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3 text-xs text-subtle-foreground">
      <span
        aria-hidden="true"
        className="min-w-0 truncate tabular-nums"
        title={
          plan.fromEarlierTurn
            ? "The plan was last updated before this worker's current turn."
            : undefined
        }
      >
        {planSummaryText(plan, now)}
      </span>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={listId}
        onClick={onToggle}
        className="ml-auto shrink-0 cursor-pointer rounded px-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
      >
        {isOpen ? "Hide full plan" : "Show full plan"}
      </button>
    </div>
  );
}

function FullPlan({
  todos,
  threadId,
}: {
  todos: ThreadTimelinePendingTodos;
  threadId: string;
}) {
  const showsDependencies = todos.order === "dependencies";
  return (
    <div id={`worker-plan-${threadId}`} className="mt-1 pl-3">
      <ul className="space-y-1">
        {todos.items.map((item) => {
          const state = STEP_ACTIVITY_STATE[item.status];
          const afterNote = showsDependencies
            ? formatPlanStepAfter(item.after)
            : null;
          return (
            <li
              key={item.id}
              className={activityRowClass(
                state,
                cn(
                  "flex min-w-0 items-center gap-2 text-xs",
                  item.status === "in_progress" && "shadow-none ring-0",
                ),
              )}
            >
              <span className="sr-only">
                {describePlanStep({
                  order: todos.order,
                  position: item.position,
                  total: todos.items.length,
                  status: STEP_STATUS_PHRASE[item.status],
                  after: item.after,
                  text: item.text,
                })}
              </span>
              {showsDependencies ? (
                <span
                  aria-hidden="true"
                  className={activityMetaClass(
                    state,
                    "min-w-4 shrink-0 text-right tabular-nums",
                  )}
                >
                  {item.position}
                </span>
              ) : null}
              <Icon
                name={STEP_ICON[item.status]}
                aria-hidden="true"
                className={cn(
                  "size-3.5 shrink-0",
                  item.status === "in_progress"
                    ? "text-foreground"
                    : activityIconClass(state),
                )}
              />
              <span
                aria-hidden="true"
                title={item.text}
                className={activityTextClass(state, "min-w-0 flex-1 truncate")}
              >
                {item.text}
              </span>
              {afterNote === null ? null : (
                <span
                  aria-hidden="true"
                  className={activityMetaClass(state, "shrink-0 tabular-nums")}
                >
                  {afterNote}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className={activityMetaClass("muted", "pt-1 text-xs")}>
        {PLAN_STEP_ORDER_CAPTION[todos.order]}
      </p>
    </div>
  );
}

function StepLine({ prefix, text }: { prefix: "Now" | "Next"; text: string }) {
  return (
    <p
      aria-hidden="true"
      title={text}
      className={cn(
        "mt-0.5 truncate pl-3 text-xs",
        prefix === "Now" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="text-subtle-foreground">{prefix} · </span>
      {text}
    </p>
  );
}

function WorkerRow({ node, context }: { node: WorkerNode; context: RowContext }) {
  const { snapshot } = context;
  const { entry } = node;
  const {
    name: displayName,
    subject,
    state,
    request,
    activity,
    requestIsActivity,
    plan,
  } = describeWorkerRow(entry, snapshot);
  const isPlanOpen = context.expandedPlans.has(entry.id);
  return (
    <div data-worker-state={state} className="min-w-0 py-1.5">
      <p className="sr-only">
        {rowSentence({ name: displayName, state, request, activity, plan })}
      </p>
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          aria-hidden="true"
          className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT_CLASS[state])}
        />
        <span
          aria-hidden="true"
          title={displayName}
          className="min-w-0 truncate font-medium text-foreground"
        >
          {displayName}
        </span>
        {subject === null ? null : (
          <span
            aria-hidden="true"
            title={subject}
            className="min-w-0 flex-1 truncate text-subtle-foreground @max-[30rem]/workers:hidden"
          >
            {subject}
          </span>
        )}
        {plan.kind === "none" ? (
          <span
            aria-hidden="true"
            className="ml-auto min-w-0 shrink-[100] overflow-hidden whitespace-nowrap text-subtle-foreground"
          >
            <span className="@max-[30rem]/workers:hidden">No plan shared</span>
            <span className="hidden @max-[30rem]/workers:inline">No plan</span>
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className={cn(
            "shrink-0",
            plan.kind === "none" ? null : "ml-auto",
            STATE_TEXT_CLASS[state],
          )}
        >
          {ROW_STATE_LABEL[state]}
        </span>
        <button
          type="button"
          onClick={() => context.openThread(entry.id)}
          aria-label={`Open ${displayName}'s thread`}
          title={`Open ${displayName}'s thread`}
          className="flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded text-subtle-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="ChevronRight" aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      {request === null ? null : (
        <div
          aria-hidden="true"
          className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3 text-xs"
        >
          <span title={request} className="min-w-0 truncate text-warning-text">
            Request · {request}
          </span>
          {requestIsActivity && activity !== null ? (
            <>
              <span className="shrink-0 text-subtle-foreground">·</span>
              <Elapsed activity={activity} />
            </>
          ) : null}
        </div>
      )}
      {activity === null || requestIsActivity ? null : (
        <div
          aria-hidden="true"
          className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-3 text-xs text-muted-foreground"
        >
          <span title={activity.detail ?? activity.text} className="min-w-0 truncate">
            {activity.text}
          </span>
          <Elapsed activity={activity} />
        </div>
      )}
      {plan.kind === "shared" ? (
        <>
          {plan.current.map((step) => (
            <StepLine key={step.id} prefix="Now" text={step.text} />
          ))}
          {plan.next === null ? null : <StepLine prefix="Next" text={plan.next.text} />}
          <PlanSummary
            plan={plan}
            threadId={entry.id}
            isOpen={isPlanOpen}
            onToggle={() => context.togglePlan(entry.id)}
          />
          {isPlanOpen ? <FullPlan todos={plan.todos} threadId={entry.id} /> : null}
        </>
      ) : null}
      <StatusLine
        state={state}
        updatedAt={entry.updatedAt}
        lastSeenAt={snapshot.lastListedAt}
      />
    </div>
  );
}

function NestedWorkers({ node, context }: { node: WorkerNode; context: RowContext }) {
  const { shown, collapsedCount } = nestedRows(
    node,
    context.expandedNested.has(node.entry.id),
  );
  if (shown.length === 0) return null;
  return (
    <ul className="ml-3.5 border-l border-border pl-2">
      {shown.map((child) => {
        const nested = countDescendants(child);
        const noun = nested === 1 ? "nested worker" : "nested workers";
        const childName = describeWorkerRow(child.entry, context.snapshot).name;
        return (
          <li key={child.entry.id} className="border-t border-border/60 first:border-t-0">
            <WorkerRow node={child} context={context} />
            {nested === 0 ? null : (
              <button
                type="button"
                onClick={() => context.openThread(child.entry.id)}
                aria-label={`Open ${childName}'s thread to see ${nested} ${noun}`}
                className="mb-1 ml-3 cursor-pointer rounded px-1 text-xs text-subtle-foreground hover:bg-state-hover hover:text-foreground"
              >
                +{nested} {noun} ›
              </button>
            )}
          </li>
        );
      })}
      {collapsedCount === 0 ? null : (
        <li className="border-t border-border/60">
          <button
            type="button"
            aria-expanded={false}
            onClick={() => context.expandNested(node.entry.id)}
            className="my-1 cursor-pointer rounded px-1 text-xs text-subtle-foreground hover:bg-state-hover hover:text-foreground"
          >
            +{collapsedCount} more {collapsedCount === 1 ? "worker" : "workers"}
          </button>
        </li>
      )}
    </ul>
  );
}

const WORKER_STATES: ReadonlySet<string> = new Set<WorkerState>([
  "working",
  "waiting-approval",
  "starting",
  "waiting-for-host",
  "stopping",
  "idle",
  "error",
  "unknown",
]);

function isWorkerState(value: string | undefined): value is WorkerState {
  return value !== undefined && WORKER_STATES.has(value);
}

function measureRowsBelow(
  container: HTMLElement,
  footer: HTMLElement | null,
): WorkerState[] {
  const visibleBottom =
    container.getBoundingClientRect().bottom -
    (footer?.getBoundingClientRect().height ?? 0);
  return [...container.querySelectorAll<HTMLElement>("[data-worker-state]")]
    .filter((row) => row.getBoundingClientRect().bottom > visibleBottom + 1)
    .map((row) => row.dataset.workerState)
    .filter(isWorkerState);
}

function sameStates(a: readonly WorkerState[], b: readonly WorkerState[]) {
  return a.length === b.length && a.every((state, index) => state === b[index]);
}

function useRowsBelow(
  scrollRef: RefObject<HTMLDivElement | null>,
  footerRef: RefObject<HTMLButtonElement | null>,
): WorkerState[] {
  const [below, setBelow] = useState<WorkerState[]>([]);
  const hasFooter = below.length > 0;
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measureRowsBelow(container, footerRef.current);
        setBelow((current) => (sameStates(current, next) ? current : next));
      });
    };
    measure();
    container.addEventListener("scroll", measure, { passive: true });
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(container);
    const content = container.firstElementChild;
    if (content !== null) resize?.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [scrollRef, footerRef, hasFooter]);
  return below;
}

function TopLevelWorker({ node, context }: { node: WorkerNode; context: RowContext }) {
  return (
    <li className="border-t border-border/60 first:border-t-0">
      <WorkerRow node={node} context={context} />
      <NestedWorkers node={node} context={context} />
    </li>
  );
}

function WorkersBody({ context }: { context: RowContext }) {
  const { snapshot } = context;
  const now = useNowMinute();
  const { shown, folded, foldedCount } = foldLongIdle(
    snapshot.forest,
    snapshot.freshness,
    now,
  );
  const [foldOpen, setFoldOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLButtonElement>(null);
  const below = useRowsBelow(scrollRef, footerRef);
  const footerText = below.length === 0 ? null : belowFoldSummary(below);
  const scrollOnePage = () => {
    const container = scrollRef.current;
    if (container === null) return;
    const step = container.clientHeight - (footerRef.current?.offsetHeight ?? 0);
    const reachesEnd =
      container.scrollTop + container.clientHeight + step >=
      container.scrollHeight - 1;
    if (reachesEnd) container.focus({ preventScroll: true });
    container.scrollBy({
      top: step,
      behavior: window.matchMedia(REDUCED_MOTION_QUERY).matches ? "auto" : "smooth",
    });
  };
  return (
    <div ref={scrollRef} tabIndex={-1} className="max-h-60 overflow-y-auto outline-none">
      <ul className="px-2 py-1">
        {shown.map((node) => (
          <TopLevelWorker key={node.entry.id} node={node} context={context} />
        ))}
        {foldedCount === 0 ? null : (
          <li className="border-t border-border/60 first:border-t-0">
            <button
              type="button"
              aria-expanded={foldOpen}
              onClick={() => setFoldOpen((current) => !current)}
              className="my-1 cursor-pointer rounded px-1 text-xs text-subtle-foreground hover:bg-state-hover hover:text-foreground"
            >
              {foldOpen
                ? `Hide ${foldedCount} earlier idle ${foldedCount === 1 ? "worker" : "workers"}`
                : `+${foldedCount} earlier idle ${foldedCount === 1 ? "worker" : "workers"}`}
            </button>
            {foldOpen ? (
              <ul>
                {folded.map((node) => (
                  <TopLevelWorker key={node.entry.id} node={node} context={context} />
                ))}
              </ul>
            ) : null}
          </li>
        )}
      </ul>
      {footerText === null ? null : (
        <button
          type="button"
          ref={footerRef}
          onClick={scrollOnePage}
          className="sticky bottom-0 w-full cursor-pointer border-t border-border/60 bg-surface-raised-solid px-3 py-1 text-left text-xs text-subtle-foreground hover:text-foreground"
        >
          {footerText}
        </button>
      )}
    </div>
  );
}

export function WorkersCard({
  snapshot,
  isExpanded,
  onToggle,
  openThread,
}: {
  snapshot: WorkersSnapshot;
  isExpanded: boolean;
  onToggle: () => void;
  openThread: (threadId: string) => void;
}) {
  const bodyId = useId();
  const toggleId = useId();
  const { triggerRef, collapseRef, onTriggerClick, onCollapseClick } =
    useDisclosureFocusHandoff(isExpanded, onToggle);
  const [expandedPlans, setExpandedPlans] = useState<ReadonlySet<string>>(new Set());
  const [expandedNested, setExpandedNested] = useState<ReadonlySet<string>>(new Set());
  const states = workerStates(snapshot);
  const summary = headerSummary(states, snapshot.complete);
  const context: RowContext = {
    snapshot,
    openThread,
    expandedPlans,
    togglePlan: (threadId) =>
      setExpandedPlans((current) => {
        const next = new Set(current);
        if (!next.delete(threadId)) next.add(threadId);
        return next;
      }),
    expandedNested,
    expandNested: (threadId) =>
      setExpandedNested((current) => new Set([...current, threadId])),
  };
  return (
    <section aria-label="Workers" className={cn(CONTEXT_CARD_CLASS, "@container/workers overflow-hidden")}>
      <button
        type="button"
        id={toggleId}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        aria-label={headerAccessibleName(states, snapshot.complete)}
        ref={triggerRef}
        onClick={onTriggerClick}
        className={cn(
          activityRowClass("active", HEADER_BUTTON_CLASS),
          PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
        )}
      >
        <Icon
          name="UserRound"
          aria-hidden="true"
          className={activityIconClass("active", "size-3.5 shrink-0")}
        />
        <span className={activityTextClass("active", "min-w-0 flex-1 truncate text-left font-medium")}>
          {summary}
        </span>
        <PromptStackHoverChevron isExpanded={isExpanded} />
      </button>
      {isExpanded ? (
        <div id={bodyId} role="region" aria-labelledby={toggleId} className="border-t border-border">
          <WorkersBody context={context} />
          <PromptStackCollapseRow
            buttonRef={collapseRef}
            controlsId={bodyId}
            label="Collapse workers"
            onCollapse={onCollapseClick}
            className="mb-1"
          />
        </div>
      ) : null}
    </section>
  );
}

export function useRememberedExpansion(
  storageKey: string,
  defaultExpanded: boolean,
): [boolean, () => void] {
  const [stored, setStored] = useState(() =>
    window.localStorage.getItem(storageKey),
  );
  const expanded = stored === null ? defaultExpanded : stored === "expanded";
  const toggle = () => {
    const next = expanded ? "collapsed" : "expanded";
    window.localStorage.setItem(storageKey, next);
    setStored(next);
  };
  return [expanded, toggle];
}
