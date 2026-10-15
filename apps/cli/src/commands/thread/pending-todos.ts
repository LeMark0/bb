import type {
  ThreadTimelinePendingTodos,
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
} from "@bb/domain";
import type { BbSdk } from "@bb/sdk";
import { formatPlanStepLine, PLAN_STEP_ORDER_CAPTION } from "@bb/thread-view";

interface FetchThreadPendingTodosArgs {
  sdk: Pick<BbSdk, "threads">;
  threadId: string;
}

export async function fetchThreadPendingTodos(
  args: FetchThreadPendingTodosArgs,
): Promise<ThreadTimelinePendingTodos | null> {
  try {
    const response = await args.sdk.threads.timeline({
      threadId: args.threadId,
      summaryOnly: "true",
    });
    return response.pendingTodos;
  } catch {
    return null;
  }
}

const STATUS_BULLET: Record<ThreadTimelinePendingTodoItemStatus, string> = {
  in_progress: "[>]",
  pending: "[ ]",
  completed: "[x]",
  failed: "[!]",
};

interface TodoCounts {
  completed: number;
  total: number;
}

function countTodos(
  items: readonly ThreadTimelinePendingTodoItem[],
): TodoCounts {
  let completed = 0;
  for (const item of items) {
    if (item.status === "completed") completed += 1;
  }
  return { completed, total: items.length };
}

export function printPendingTodos(
  pendingTodos: ThreadTimelinePendingTodos | null,
): void {
  if (!pendingTodos || pendingTodos.items.length === 0) return;
  const counts = countTodos(pendingTodos.items);

  console.log("");
  const heading =
    counts.completed === 0
      ? `TODOs (${counts.total}):`
      : `TODOs (${counts.completed}/${counts.total} done):`;
  console.log(heading);
  console.log(`  ${PLAN_STEP_ORDER_CAPTION[pendingTodos.order]}`);
  for (const item of pendingTodos.items) {
    const line = formatPlanStepLine({
      order: pendingTodos.order,
      position: item.position,
      after: item.after,
      text: item.text,
    });
    console.log(`  ${STATUS_BULLET[item.status]} ${line}`);
  }
}
