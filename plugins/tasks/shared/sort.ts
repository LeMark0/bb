import { TASK_PRIORITIES, type Task } from "./contract.js";
import type { TaskSort } from "./pagination.js";

type TaskComparator = (a: Task, b: Task) => number;

const PRIORITY_RANK = new Map<Task["priority"], number>(
  TASK_PRIORITIES.map((priority, index) => [priority, index]),
);

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPriority(a: Task, b: Task): number {
  return (
    (PRIORITY_RANK.get(a.priority) ?? TASK_PRIORITIES.length) -
    (PRIORITY_RANK.get(b.priority) ?? TASK_PRIORITIES.length)
  );
}

function byDueDate(a: Task, b: Task): number {
  if (a.dueDate === null) return b.dueDate === null ? 0 : 1;
  if (b.dueDate === null) return -1;
  return compareText(a.dueDate, b.dueDate);
}

function newestFirst(field: "createdAt" | "updatedAt"): TaskComparator {
  return (a, b) => compareText(b[field], a[field]) || compareText(b.id, a.id);
}

const COMPARATORS: Record<Exclude<TaskSort, "manual">, TaskComparator> = {
  priority: (a, b) => byPriority(a, b) || byDueDate(a, b),
  due: (a, b) => byDueDate(a, b) || byPriority(a, b),
  created: newestFirst("createdAt"),
  updated: newestFirst("updatedAt"),
};

export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
  if (sort === "manual") return [...tasks];
  return [...tasks].sort(COMPARATORS[sort]);
}
