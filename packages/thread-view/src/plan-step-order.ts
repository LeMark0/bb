import type { ThreadEventPlanStep, ThreadTimelinePlanOrder } from "@bb/domain";
import { capitalize } from "./format-helpers.js";

export interface OrderedPlanStep {
  key: string;
  step: ThreadEventPlanStep;
  text: string;
  position: number;
  after: number[];
}

export interface PlanStepOrder {
  order: ThreadTimelinePlanOrder;
  steps: OrderedPlanStep[];
}

export type PlanStepStatusPhrase =
  | "pending"
  | "in progress"
  | "completed"
  | "failed";

export const PLAN_STEP_ORDER_CAPTION: Readonly<
  Record<ThreadTimelinePlanOrder, string>
> = {
  dependencies: "Ordered by dependencies.",
  "dependencies-not-provided": "Agent's order. Dependencies not provided.",
  "dependencies-invalid": "Agent's order. Dependencies couldn't be read.",
};

type ProviderOrderReason = Exclude<ThreadTimelinePlanOrder, "dependencies">;

interface VisiblePlanStep {
  key: string;
  step: ThreadEventPlanStep;
  text: string;
}

const AFTER_NOTE_LISTED_LIMIT = 3;
const AFTER_NOTE_SHORTENED_COUNT = 2;

function visiblePlanSteps(
  steps: readonly ThreadEventPlanStep[],
): VisiblePlanStep[] {
  const nonEmpty = steps
    .map((step) => ({ step, text: step.step.trim() }))
    .filter(({ text }) => text.length > 0);
  const idCounts = new Map<string, number>();
  for (const { step } of nonEmpty) {
    if (step.id !== undefined) {
      idCounts.set(step.id, (idCounts.get(step.id) ?? 0) + 1);
    }
  }
  const textOccurrences = new Map<string, number>();
  return nonEmpty.map(({ step, text }) => {
    if (step.id !== undefined && idCounts.get(step.id) === 1) {
      return { key: `id:${step.id}`, step, text };
    }
    const occurrence = textOccurrences.get(text) ?? 0;
    textOccurrences.set(text, occurrence + 1);
    return { key: `step:${occurrence}:${text}`, step, text };
  });
}

function resolvePrerequisites(
  visible: readonly VisiblePlanStep[],
): number[][] | ProviderOrderReason {
  if (visible.length === 0) return "dependencies-not-provided";
  const ids: string[] = [];
  const needs: string[][] = [];
  for (const { step } of visible) {
    if (step.id === undefined || step.needs === undefined) {
      return "dependencies-not-provided";
    }
    ids.push(step.id);
    needs.push(step.needs);
  }
  const indexById = new Map(ids.map((id, index) => [id, index]));
  if (indexById.size !== ids.length) return "dependencies-invalid";
  const prerequisites: number[][] = [];
  for (const [index, stepNeeds] of needs.entries()) {
    const targets = [...new Set(stepNeeds)].map((id) => indexById.get(id));
    if (targets.some((target) => target === undefined || target === index)) {
      return "dependencies-invalid";
    }
    prerequisites.push(
      targets.filter((target): target is number => target !== undefined),
    );
  }
  return prerequisites;
}

function dependencyOrder(
  prerequisites: readonly (readonly number[])[],
): number[] | null {
  const placed = new Set<number>();
  const ordered: number[] = [];
  while (ordered.length < prerequisites.length) {
    const next = prerequisites.findIndex(
      (needs, index) =>
        !placed.has(index) && needs.every((need) => placed.has(need)),
    );
    if (next === -1) return null;
    placed.add(next);
    ordered.push(next);
  }
  return ordered;
}

function inProviderOrder(
  order: ProviderOrderReason,
  visible: readonly VisiblePlanStep[],
): PlanStepOrder {
  return {
    order,
    steps: visible.map((entry, index) => ({
      ...entry,
      position: index + 1,
      after: [],
    })),
  };
}

export function orderPlanSteps(
  steps: readonly ThreadEventPlanStep[],
): PlanStepOrder {
  const visible = visiblePlanSteps(steps);
  const prerequisites = resolvePrerequisites(visible);
  if (typeof prerequisites === "string") {
    return inProviderOrder(prerequisites, visible);
  }
  const ordered = dependencyOrder(prerequisites);
  if (ordered === null) {
    return inProviderOrder("dependencies-invalid", visible);
  }
  const positions = new Map(
    ordered.map((visibleIndex, displayIndex) => [
      visibleIndex,
      displayIndex + 1,
    ]),
  );
  return {
    order: "dependencies",
    steps: ordered.map((visibleIndex, displayIndex) => ({
      ...visible[visibleIndex],
      position: displayIndex + 1,
      after: prerequisites[visibleIndex]
        .flatMap((need) => positions.get(need) ?? [])
        .sort((left, right) => left - right),
    })),
  };
}

export function formatPlanStepAfter(after: readonly number[]): string | null {
  if (after.length === 0) return null;
  if (after.length <= AFTER_NOTE_LISTED_LIMIT) {
    return `after ${after.join(", ")}`;
  }
  const listed = after.slice(0, AFTER_NOTE_SHORTENED_COUNT).join(", ");
  return `after ${listed} +${after.length - AFTER_NOTE_SHORTENED_COUNT}`;
}

export function formatPlanStepLine(args: {
  order: ThreadTimelinePlanOrder;
  position: number;
  after: readonly number[];
  text: string;
}): string {
  if (args.order !== "dependencies") return args.text;
  const note = formatPlanStepAfter(args.after);
  const line = `${args.position}. ${args.text}`;
  return note === null ? line : `${line} (${note})`;
}

function joinWithAnd(values: readonly number[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

export function describePlanStep(args: {
  order: ThreadTimelinePlanOrder;
  position: number;
  total: number;
  status: PlanStepStatusPhrase;
  after: readonly number[];
  text: string;
}): string {
  if (args.order !== "dependencies") {
    return `${capitalize(args.status)}: ${args.text}`;
  }
  const prerequisites =
    args.after.length === 0
      ? ""
      : `, after ${args.after.length === 1 ? "step" : "steps"} ${joinWithAnd(args.after)}`;
  return `Step ${args.position} of ${args.total}, ${args.status}${prerequisites}: ${args.text}`;
}
