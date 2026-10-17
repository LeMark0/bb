import type { ThreadEventPlanStep, ThreadTimelinePlanOrder } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  describePlanStep,
  formatPlanStepAfter,
  orderPlanSteps,
} from "../src/plan-step-order.js";

function step(
  id: string,
  needs?: string[],
  status: ThreadEventPlanStep["status"] = "pending",
): ThreadEventPlanStep {
  return {
    id,
    step: `Step ${id}`,
    status,
    ...(needs === undefined ? {} : { needs }),
  };
}

function layout(steps: readonly ThreadEventPlanStep[]) {
  const plan = orderPlanSteps(steps);
  return {
    order: plan.order,
    rows: plan.steps.map(
      ({ step: { id }, text, position, after }) =>
        `${position}:${id ?? text}<${after}`,
    ),
  };
}

describe("orderPlanSteps", () => {
  it.each<{
    name: string;
    steps: ThreadEventPlanStep[];
    order: ThreadTimelinePlanOrder;
    rows: string[];
  }>([
    {
      name: "keeps a chain that is already in dependency order",
      steps: [step("a", []), step("b", ["a"]), step("c", ["b"])],
      order: "dependencies",
      rows: ["1:a<", "2:b<1", "3:c<2"],
    },
    {
      name: "moves a prerequisite that the agent added last before its dependants",
      steps: [
        step("a", []),
        step("b", ["a", "d"]),
        step("c", []),
        step("d", ["a"]),
      ],
      order: "dependencies",
      rows: ["1:a<", "2:c<", "3:d<1", "4:b<1,3"],
    },
    {
      name: "shows a branch and a join through prerequisites",
      steps: [
        step("join", ["left", "right"]),
        step("right", ["root"]),
        step("left", ["root"]),
        step("root", []),
      ],
      order: "dependencies",
      rows: ["1:root<", "2:right<1", "3:left<1", "4:join<2,3"],
    },
    {
      name: "orders a single step with no prerequisites by dependencies",
      steps: [step("only", [])],
      order: "dependencies",
      rows: ["1:only<"],
    },
    {
      name: "treats a plan without visible steps as having no dependency data",
      steps: [{ id: "blank", step: " ", needs: [] }],
      order: "dependencies-not-provided",
      rows: [],
    },
    {
      name: "keeps the agent's order when no step carries prerequisites",
      steps: [step("b"), step("a"), step("c")],
      order: "dependencies-not-provided",
      rows: ["1:b<", "2:a<", "3:c<"],
    },
    {
      name: "keeps the agent's order when only some steps carry prerequisites",
      steps: [step("b", ["a"]), step("a")],
      order: "dependencies-not-provided",
      rows: ["1:b<", "2:a<"],
    },
    {
      name: "keeps the agent's order when a step with prerequisites has no id",
      steps: [step("a", []), { step: "Anonymous", needs: ["a"] }],
      order: "dependencies-not-provided",
      rows: ["1:a<", "2:Anonymous<"],
    },
    {
      name: "rejects a cycle",
      steps: [step("a", ["b"]), step("b", ["a"]), step("c", [])],
      order: "dependencies-invalid",
      rows: ["1:a<", "2:b<", "3:c<"],
    },
    {
      name: "rejects a step that needs itself",
      steps: [step("a", ["a"]), step("b", [])],
      order: "dependencies-invalid",
      rows: ["1:a<", "2:b<"],
    },
    {
      name: "rejects a prerequisite that is not in the plan",
      steps: [step("b", ["missing"]), step("a", [])],
      order: "dependencies-invalid",
      rows: ["1:b<", "2:a<"],
    },
    {
      name: "rejects duplicate ids without hiding either step",
      steps: [step("a", []), step("a", []), step("b", ["a"])],
      order: "dependencies-invalid",
      rows: ["1:a<", "2:a<", "3:b<"],
    },
  ])("$name", ({ steps, order, rows }) => {
    expect(layout(steps)).toEqual({ order, rows });
  });

  it("never moves a step when only statuses change", () => {
    const plan = (statuses: ThreadEventPlanStep["status"][]) =>
      [step("c", ["a", "b"]), step("b", ["a"]), step("a", [])].map(
        (entry, index) => ({ ...entry, status: statuses[index] }),
      );
    const keys = (steps: ThreadEventPlanStep[]) =>
      orderPlanSteps(steps).steps.map(({ key, position }) => [key, position]);
    expect(keys(plan(["pending", "pending", "active"]))).toEqual(
      keys(plan(["active", "completed", "completed"])),
    );
    expect(keys(plan(["pending", "failed", "completed"]))).toEqual([
      ["id:a", 1],
      ["id:b", 2],
      ["id:c", 3],
    ]);
  });

  it("drops empty steps before numbering and keeps references between the rest", () => {
    const plan = orderPlanSteps([
      { id: "blank", step: "   ", needs: [] },
      step("b", ["a"]),
      step("a", []),
    ]);
    expect(plan.order).toBe("dependencies");
    expect(
      plan.steps.map(({ text, position, after }) => [text, position, after]),
    ).toEqual([
      ["Step a", 1, []],
      ["Step b", 2, [1]],
    ]);
  });

  it("gives every row a unique key, using provider ids only when they are unique", () => {
    const keys = orderPlanSteps([
      step("a", []),
      step("dup", []),
      step("dup", []),
      { step: "Same text" },
      { step: "Same text" },
    ]).steps.map(({ key }) => key);
    expect(keys).toEqual([
      "id:a",
      "step:0:Step dup",
      "step:1:Step dup",
      "step:0:Same text",
      "step:1:Same text",
    ]);
  });
});

describe("plan step labels", () => {
  it.each([
    [[], null],
    [[2], "after 2"],
    [[1, 2, 3], "after 1, 2, 3"],
    [[1, 2, 3, 4, 5], "after 1, 2 +3"],
  ])("writes the visible prerequisite note for %j", (after, expected) => {
    expect(formatPlanStepAfter(after)).toBe(expected);
  });

  it("describes position, status and prerequisites only in dependency order", () => {
    expect(
      describePlanStep({
        order: "dependencies",
        position: 4,
        total: 7,
        status: "pending",
        after: [3, 5],
        text: "Update the composer to-do card",
      }),
    ).toBe(
      "Step 4 of 7, pending, after steps 3 and 5: Update the composer to-do card",
    );
    expect(
      describePlanStep({
        order: "dependencies",
        position: 1,
        total: 2,
        status: "in progress",
        after: [],
        text: "Read the contract",
      }),
    ).toBe("Step 1 of 2, in progress: Read the contract");
    expect(
      describePlanStep({
        order: "dependencies-invalid",
        position: 2,
        total: 2,
        status: "failed",
        after: [],
        text: "Remove the column",
      }),
    ).toBe("Failed: Remove the column");
  });
});
