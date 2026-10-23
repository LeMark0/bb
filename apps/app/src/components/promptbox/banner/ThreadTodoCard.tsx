import { useLayoutEffect, useRef, type RefObject } from "react";
import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  describePlanStep,
  formatPlanStepAfter,
  PLAN_STEP_ORDER_CAPTION,
  type PlanStepStatusPhrase,
} from "@bb/thread-view";
import { AnimatedDisclosureBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { REDUCED_MOTION_QUERY } from "@bb/shared-ui/hooks/use-media-query";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackHoverChevron,
  useDisclosureFocusHandoff,
} from "@bb/shared-ui/prompt-stack-disclosure";

const STATUS_ACTIVITY_STATE: Record<
  ThreadTimelinePendingTodoItemStatus,
  ActivityRowState
> = {
  in_progress: "active",
  pending: "pending",
  completed: "completed",
  failed: "completed",
};

const STATUS_PHRASE: Record<
  ThreadTimelinePendingTodoItemStatus,
  PlanStepStatusPhrase
> = {
  in_progress: "in progress",
  pending: "pending",
  completed: "completed",
  failed: "failed",
};

interface ThreadTodoCardProps {
  pendingTodos: ThreadTimelinePendingTodos | null;
  isExpanded: boolean;
  onToggle: () => void;
}

const BODY_ID = "thread-todo-card-body";
const TOGGLE_ID = "thread-todo-card-toggle";
const TODO_HEADER_BUTTON_CLASS = activityRowClass(
  "active",
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
);
const TODO_ACTIVE_ROW_CLASS = "shadow-none ring-0";
const TODO_ACTIVE_ICON_CLASS = "text-foreground";

function getTodoSummary(items: readonly ThreadTimelinePendingTodoItem[]): {
  visible: string;
  aria: string;
} {
  let completedCount = 0;
  for (const item of items) {
    if (item.status === "completed") completedCount += 1;
  }
  return {
    visible: `${completedCount}/${items.length} complete`,
    aria: `${completedCount} of ${items.length} ${
      items.length === 1 ? "item" : "items"
    } complete`,
  };
}

function TodoStatusIcon({
  status,
}: {
  status: ThreadTimelinePendingTodoItemStatus;
}) {
  const className = "size-3.5 shrink-0";
  const activityState = STATUS_ACTIVITY_STATE[status];
  switch (status) {
    case "in_progress":
      return (
        <Icon
          name="Square"
          className={cn(className, TODO_ACTIVE_ICON_CLASS)}
          aria-hidden="true"
        />
      );
    case "completed":
      return (
        <Icon
          name="Check"
          className={cn(className, activityIconClass(activityState))}
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <Icon
          name="X"
          className={cn(className, activityIconClass(activityState))}
          aria-hidden="true"
        />
      );
    case "pending":
      return (
        <Icon
          name="Square"
          className={cn(className, activityIconClass(activityState))}
          aria-hidden="true"
        />
      );
  }
}

function revealRowInList(
  list: HTMLElement,
  row: HTMLElement,
  smooth: boolean,
): void {
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const offset =
    rowRect.top < listRect.top
      ? rowRect.top - listRect.top
      : rowRect.bottom > listRect.bottom
        ? rowRect.bottom - listRect.bottom
        : 0;
  if (offset === 0) return;
  const top = list.scrollTop + offset;
  if (smooth && !window.matchMedia(REDUCED_MOTION_QUERY).matches) {
    list.scrollTo({ top, behavior: "smooth" });
  } else {
    list.scrollTop = top;
  }
}

function useRevealActiveTodo(
  listRef: RefObject<HTMLUListElement | null>,
  activeRowRef: RefObject<HTMLLIElement | null>,
  isExpanded: boolean,
  activeItemId: string | null,
): void {
  const revealedRef = useRef<{
    isExpanded: boolean;
    activeItemId: string | null;
  }>({ isExpanded: false, activeItemId: null });
  useLayoutEffect(() => {
    const previous = revealedRef.current;
    revealedRef.current = { isExpanded, activeItemId };
    if (!isExpanded || activeItemId === null) return;
    const opened = !previous.isExpanded;
    if (!opened && previous.activeItemId === activeItemId) return;
    const list = listRef.current;
    const row = activeRowRef.current;
    if (list === null || row === null) return;
    revealRowInList(list, row, !opened);
  }, [activeItemId, activeRowRef, isExpanded, listRef]);
}

function TodoBody({
  pendingTodos,
  isExpanded,
}: {
  pendingTodos: ThreadTimelinePendingTodos;
  isExpanded: boolean;
}) {
  const { order, items } = pendingTodos;
  const listRef = useRef<HTMLUListElement>(null);
  const activeRowRef = useRef<HTMLLIElement>(null);
  const activeItemId =
    items.find((item) => item.status === "in_progress")?.id ?? null;
  useRevealActiveTodo(listRef, activeRowRef, isExpanded, activeItemId);
  const showsDependencies = order === "dependencies";
  return (
    <>
      <ul
        ref={listRef}
        className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-1 pt-2"
      >
        {items.map((item) => {
          const activityState = STATUS_ACTIVITY_STATE[item.status];
          const isActive = item.status === "in_progress";
          const afterNote = showsDependencies
            ? formatPlanStepAfter(item.after)
            : null;
          return (
            <li
              key={item.id}
              ref={item.id === activeItemId ? activeRowRef : undefined}
              className={activityRowClass(
                activityState,
                cn(
                  "flex min-w-0 items-center gap-2 text-xs",
                  isActive && TODO_ACTIVE_ROW_CLASS,
                ),
              )}
            >
              <span className="sr-only">
                {describePlanStep({
                  order,
                  position: item.position,
                  total: items.length,
                  status: STATUS_PHRASE[item.status],
                  after: item.after,
                  text: item.text,
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
                  {item.position}
                </span>
              ) : null}
              <TodoStatusIcon status={item.status} />
              <span
                aria-hidden="true"
                className={activityTextClass(
                  activityState,
                  "min-w-0 flex-1 truncate",
                )}
                title={item.text}
              >
                {item.text}
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
      <p className={activityMetaClass("muted", "px-4.5 pb-2 text-xs")}>
        {PLAN_STEP_ORDER_CAPTION[order]}
      </p>
    </>
  );
}

export function ThreadTodoCard({
  pendingTodos,
  isExpanded,
  onToggle,
}: ThreadTodoCardProps) {
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);
  if (pendingTodos === null || pendingTodos.items.length === 0) {
    return null;
  }
  const summary = getTodoSummary(pendingTodos.items);
  return (
    <PromptStackCard
      ariaLabel="To-do list"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={`To-do list: ${summary.aria}`}
          ref={focus.triggerRef}
          onClick={focus.onTriggerClick}
          className={cn(
            TODO_HEADER_BUTTON_CLASS,
            PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
          )}
        >
          <Icon
            name="ListTodo"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "min-w-0 flex-1 truncate text-left",
            )}
          >
            {summary.visible}
          </span>
          <PromptStackHoverChevron isExpanded={isExpanded} />
        </button>
      </div>
      <AnimatedDisclosureBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel="Collapse to-do list"
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <TodoBody pendingTodos={pendingTodos} isExpanded={isExpanded} />
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}
