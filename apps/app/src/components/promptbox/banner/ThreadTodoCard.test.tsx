// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
  ThreadTimelinePlanOrder,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadTodoCard } from "./ThreadTodoCard";

const ROW_HEIGHT = 24;
const LIST_HEIGHT = 160;

function todos(
  order: ThreadTimelinePlanOrder,
  items: [string, ThreadTimelinePendingTodoItemStatus, number[]][],
): ThreadTimelinePendingTodos {
  return {
    sourceSeq: 1,
    updatedAt: 1,
    order,
    items: items.map(
      ([text, status, after], index): ThreadTimelinePendingTodoItem => ({
        id: `id:${text}`,
        text,
        status,
        position: index + 1,
        after,
      }),
    ),
  };
}

function dependencyPlan(
  statuses: ThreadTimelinePendingTodoItemStatus[],
): ThreadTimelinePendingTodos {
  return todos("dependencies", [
    ["Read the contract", statuses[0] ?? "pending", []],
    ["Update the card", statuses[1] ?? "pending", [1]],
    ["Update the fold", statuses[2] ?? "pending", [1]],
    ["Verify both", statuses[3] ?? "pending", [2, 3]],
  ]);
}

function renderCard(
  pendingTodos: ThreadTimelinePendingTodos,
  isExpanded = true,
) {
  return render(
    <ThreadTodoCard
      pendingTodos={pendingTodos}
      isExpanded={isExpanded}
      onToggle={() => {}}
    />,
  );
}

function rowSentences(): string[] {
  return within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((item) => within(item).getByText(/: /).textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadTodoCard plan order", () => {
  it("shows steps in plan order with positions, prerequisites and the dependency caption", () => {
    renderCard(dependencyPlan(["completed", "in_progress", "failed"]));

    expect(rowSentences()).toEqual([
      "Step 1 of 4, completed: Read the contract",
      "Step 2 of 4, in progress, after step 1: Update the card",
      "Step 3 of 4, failed, after step 1: Update the fold",
      "Step 4 of 4, pending, after steps 2 and 3: Verify both",
    ]);
    expect(screen.getByText("after 2, 3")).toBeTruthy();
    expect(screen.getByText("Ordered by dependencies.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "To-do list: 1 of 4 items complete" }),
    ).toBeTruthy();
  });

  it("gives screen readers and the tooltip the whole of a long step while the row clips it", () => {
    const label = `${"Migrate every stored plan snapshot ".repeat(7)}then run the final backfill check`;
    renderCard(todos("dependencies", [[label, "in_progress", []]]));

    expect(label.length).toBeGreaterThan(240);
    expect(rowSentences()).toEqual([`Step 1 of 1, in progress: ${label}`]);
    const visibleLabel = screen.getByTitle(label);
    expect(visibleLabel.getAttribute("aria-hidden")).toBe("true");
    expect(visibleLabel.className).toContain("truncate");
  });

  it("keeps every row and its identity in place when only statuses change", () => {
    const view = renderCard(dependencyPlan(["in_progress"]));
    const before = within(screen.getByRole("list")).getAllByRole("listitem");

    view.rerender(
      <ThreadTodoCard
        pendingTodos={dependencyPlan([
          "completed",
          "completed",
          "in_progress",
          "pending",
        ])}
        isExpanded
        onToggle={() => {}}
      />,
    );

    const after = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(after).toHaveLength(before.length);
    after.forEach((item, index) => expect(item).toBe(before[index]));
    expect(rowSentences().map((sentence) => sentence.split(": ")[1])).toEqual([
      "Read the contract",
      "Update the card",
      "Update the fold",
      "Verify both",
    ]);
  });

  it.each<[ThreadTimelinePlanOrder, string]>([
    ["dependencies-not-provided", "Agent's order. Dependencies not provided."],
    ["dependencies-invalid", "Agent's order. Dependencies couldn't be read."],
  ])(
    "keeps the agent's order without numbers when the plan is %s",
    (order, caption) => {
      renderCard(
        todos(order, [
          ["Migrate the column", "in_progress", []],
          ["Remove the old column", "pending", []],
        ]),
      );

      expect(rowSentences()).toEqual([
        "In progress: Migrate the column",
        "Pending: Remove the old column",
      ]);
      expect(screen.getByText(caption)).toBeTruthy();
      expect(screen.queryByText(/^after /)).toBeNull();
    },
  );
});

describe("ThreadTodoCard active row", () => {
  function tenStepPlan(activeIndex: number): ThreadTimelinePendingTodos {
    return todos(
      "dependencies-not-provided",
      Array.from({ length: 10 }, (_, index) => [
        `Step ${index + 1} text`,
        index < activeIndex
          ? "completed"
          : index === activeIndex
            ? "in_progress"
            : "pending",
        [],
      ]),
    );
  }

  function layOutRowsInFixedHeightList() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const list = this.closest("ul");
        if (this.tagName === "UL") return new DOMRect(0, 0, 300, LIST_HEIGHT);
        if (this.tagName !== "LI" || list === null) return new DOMRect();
        const index = Array.from(list.children).indexOf(this);
        return new DOMRect(
          0,
          index * ROW_HEIGHT - list.scrollTop,
          300,
          ROW_HEIGHT,
        );
      },
    );
  }

  function renderWithFocusedComposer(pendingTodos: ThreadTimelinePendingTodos) {
    const view = render(
      <>
        <button type="button">Composer</button>
        <ThreadTodoCard
          pendingTodos={pendingTodos}
          isExpanded={false}
          onToggle={() => {}}
        />
      </>,
    );
    const composer = screen.getByRole("button", { name: "Composer" });
    composer.focus();
    const rerender = (next: ThreadTimelinePendingTodos, isExpanded: boolean) =>
      view.rerender(
        <>
          <button type="button">Composer</button>
          <ThreadTodoCard
            pendingTodos={next}
            isExpanded={isExpanded}
            onToggle={() => {}}
          />
        </>,
      );
    return { composer, rerender };
  }

  it("brings the active row into view when the card opens and when the agent moves on, without taking focus", () => {
    layOutRowsInFixedHeightList();
    const { composer, rerender } = renderWithFocusedComposer(tenStepPlan(8));

    rerender(tenStepPlan(8), true);
    const list = screen.getByRole("list");
    expect(list.scrollTop).toBe(9 * ROW_HEIGHT - LIST_HEIGHT);

    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;
    rerender(tenStepPlan(9), true);
    expect(scrollTo).toHaveBeenCalledWith({
      top: 10 * ROW_HEIGHT - LIST_HEIGHT,
      behavior: "smooth",
    });
    expect(document.activeElement).toBe(composer);
  });

  it("leaves a manual scroll alone until the active step changes", () => {
    layOutRowsInFixedHeightList();
    const { rerender } = renderWithFocusedComposer(tenStepPlan(8));
    rerender(tenStepPlan(8), true);
    const list = screen.getByRole("list");
    list.scrollTop = 0;

    rerender(
      {
        ...tenStepPlan(8),
        sourceSeq: 2,
      },
      true,
    );

    expect(list.scrollTop).toBe(0);
  });

  it("jumps instead of animating when reduced motion is requested", () => {
    layOutRowsInFixedHeightList();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(prefers-reduced-motion: reduce)",
          media: query,
        }) as MediaQueryList,
    );
    const { rerender } = renderWithFocusedComposer(tenStepPlan(8));
    rerender(tenStepPlan(8), true);
    const list = screen.getByRole("list");
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;

    rerender(tenStepPlan(9), true);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(10 * ROW_HEIGHT - LIST_HEIGHT);
  });
});
