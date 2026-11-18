// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { TimelineRequestPlan } from "@bb/server-contract";
import { afterEach, describe, expect, it } from "vitest";
import { RequestPlanChecklist } from "./RequestPlanChecklist";

const STEPS: TimelineRequestPlan["steps"] = [
  { step: "Read the synthetic notes", status: "completed" },
  { step: "Compare synthetic totals", status: "active" },
  { step: "Draft the synthetic reply", status: "pending" },
];

function plan(
  turnStatus: TimelineRequestPlan["turnStatus"],
  steps: TimelineRequestPlan["steps"] = STEPS,
): TimelineRequestPlan {
  return { revisionSeq: 10, steps, explanation: null, turnStatus };
}

function stepItems() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

afterEach(cleanup);

describe("RequestPlanChecklist", () => {
  it("should mark only the running step as current while the turn is live", () => {
    render(<RequestPlanChecklist plan={plan("pending")} />);

    expect(
      screen.getByRole("region", { name: "Plan, 1 of 3 steps done" }),
    ).toBeTruthy();
    const items = stepItems();
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([
      null,
      "step",
      null,
    ]);
    expect(
      items[1]?.querySelector(".animate-spin.motion-reduce\\:animate-none"),
    ).not.toBeNull();
    expect(screen.queryByText(/with 1 of 3 steps done/)).toBeNull();
  });

  it.each([
    ["completed", "The turn ended with 1 of 3 steps done."],
    ["interrupted", "Stopped with 1 of 3 steps done."],
    ["error", "The turn failed with 1 of 3 steps done."],
  ] as const)(
    "should stop activity and keep open steps open after a %s turn",
    (turnStatus, note) => {
      const { container } = render(
        <RequestPlanChecklist plan={plan(turnStatus)} />,
      );

      expect(container.querySelector(".animate-spin")).toBeNull();
      expect(stepItems().map((item) => item.dataset.planStepStatus)).toEqual([
        "completed",
        "active",
        "pending",
      ]);
      expect(
        stepItems().some((item) => item.getAttribute("aria-current")),
      ).toBe(false);
      expect(screen.getByText(note)).toBeTruthy();
    },
  );

  it("should not add an ended note when every step finished", () => {
    render(
      <RequestPlanChecklist
        plan={plan(
          "completed",
          STEPS.map((step) => ({ ...step, status: "completed" })),
        )}
      />,
    );

    expect(screen.queryByText(/steps done\./)).toBeNull();
  });

  it("should render nothing for a plan without readable steps", () => {
    const { container } = render(
      <RequestPlanChecklist
        plan={plan("pending", [{ step: "  ", status: "active" }])}
      />,
    );

    expect(container.childElementCount).toBe(0);
  });

  it("should show a window around the current step of a long plan", () => {
    const steps = Array.from({ length: 9 }, (_, index) => ({
      step: `Synthetic step ${index + 1}`,
      status:
        index < 5
          ? ("completed" as const)
          : index === 5
            ? ("active" as const)
            : ("pending" as const),
    }));
    render(<RequestPlanChecklist plan={plan("pending", steps)} />);

    expect(stepItems().map((item) => item.textContent)).toEqual(
      [5, 6, 7, 8, 9].map((n) =>
        expect.stringContaining(`Synthetic step ${n}`),
      ),
    );
    const toggle = screen.getByRole("button", { name: "Show all 9 steps" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(stepItems()).toHaveLength(9);
    expect(
      screen
        .getByRole("button", { name: "Show fewer steps" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("should keep the only active step in the window after earlier open steps", () => {
    const steps = [
      ...Array.from({ length: 5 }, (_, index) => ({
        step: `Synthetic open step ${index + 1}`,
        status: "pending" as const,
      })),
      { step: "Synthetic running step", status: "active" as const },
      { step: "Synthetic later step", status: "pending" as const },
    ];
    render(<RequestPlanChecklist plan={plan("pending", steps)} />);

    const current = stepItems().filter(
      (item) => item.getAttribute("aria-current") === "step",
    );
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain("Synthetic running step");
  });

  it("should mark one current step when the provider reports several active", () => {
    render(
      <RequestPlanChecklist
        plan={plan("pending", [
          { step: "Synthetic step A", status: "active" },
          { step: "Synthetic step B", status: "active" },
          { step: "Synthetic step C", status: "pending" },
        ])}
      />,
    );

    expect(stepItems().map((item) => item.dataset.planStepStatus)).toEqual([
      "active",
      "active",
      "pending",
    ]);
    expect(
      stepItems().map((item) => item.getAttribute("aria-current")),
    ).toEqual(["step", null, null]);
    expect(
      stepItems().map((item) =>
        item.querySelector("[title]")?.classList.contains("font-medium"),
      ),
    ).toEqual([true, false, false]);
    expect(
      stepItems().map((item) => item.querySelector(".animate-spin") !== null),
    ).toEqual([true, true, false]);
  });

  it("should render nothing once the provider clears the plan", () => {
    const { container } = render(
      <RequestPlanChecklist plan={plan("pending", [])} />,
    );

    expect(container.childElementCount).toBe(0);
  });
});
