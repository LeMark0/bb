import { jsonObjectSchema, turnScope } from "@bb/domain";
import type { Thread, ThreadEventPlanStep } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { extractThreadTimelinePendingTodos } from "../src/todo-snapshot-extraction.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

const ACTIVE: Thread["status"] = "active";

function planStepsEvent({
  steps,
  seq,
  type = "item/completed",
  explanation,
}: {
  steps: ThreadEventPlanStep[];
  seq: number;
  type?: "item/started" | "item/completed";
  explanation?: string;
}): ThreadEventWithMeta {
  return {
    event: {
      type,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "planSteps",
        id: `plan-${seq}`,
        steps,
        ...(explanation === undefined ? {} : { explanation }),
        status: type === "item/completed" ? "completed" : "pending",
      },
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  };
}

function legacyTodoWriteToolCallEvent(seq: number): ThreadEventWithMeta {
  return {
    event: {
      type: "item/completed",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "toolCall",
        id: `todo-write-${seq}`,
        tool: "TodoWrite",
        arguments: jsonObjectSchema.parse({
          todos: [{ content: "Legacy todo", status: "pending" }],
        }),
        status: "completed",
      },
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  };
}

describe("extractThreadTimelinePendingTodos", () => {
  it("reads the latest planSteps snapshot, mapping step statuses to banner statuses", () => {
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 1,
        steps: [{ step: "Older snapshot", status: "active" }],
      }),
      planStepsEvent({
        seq: 2,
        steps: [
          { step: "Read the spec", status: "completed" },
          { step: "Writing the code", status: "active" },
          { step: "Run the tests", status: "pending" },
          { step: "Flaky step", status: "failed" },
          { step: "   ", status: "pending" },
          { step: "No status" },
        ],
      }),
    ]);
    expect(result).toEqual({
      sourceSeq: 2,
      updatedAt: 2,
      order: "dependencies-not-provided",
      items: [
        {
          id: "step:0:Read the spec",
          text: "Read the spec",
          status: "completed",
          position: 1,
          after: [],
        },
        {
          id: "step:0:Writing the code",
          text: "Writing the code",
          status: "in_progress",
          position: 2,
          after: [],
        },
        {
          id: "step:0:Run the tests",
          text: "Run the tests",
          status: "pending",
          position: 3,
          after: [],
        },
        {
          id: "step:0:Flaky step",
          text: "Flaky step",
          status: "failed",
          position: 4,
          after: [],
        },
        {
          id: "step:0:No status",
          text: "No status",
          status: "pending",
          position: 5,
          after: [],
        },
      ],
    });
  });

  it("orders the banner by dependencies and keeps row identity when statuses change", () => {
    const steps = (statuses: ThreadEventPlanStep["status"][]) =>
      [
        { id: "verify", step: "Verify", needs: ["fold", "card"] },
        { id: "card", step: "Update the card", needs: ["contract"] },
        { id: "contract", step: "Read the contract", needs: [] },
        { id: "fold", step: "Update the fold", needs: ["contract"] },
      ].map((step, index) => ({ ...step, status: statuses[index] }));
    const before = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 1,
        steps: steps(["pending", "pending", "active", "pending"]),
      }),
    ]);
    const after = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 2,
        steps: steps(["pending", "active", "completed", "failed"]),
      }),
    ]);
    const layout = (todos: typeof before) =>
      todos?.items.map(({ id, position, after: prerequisites }) => ({
        id,
        position,
        after: prerequisites,
      }));
    expect(before?.order).toBe("dependencies");
    expect(layout(before)).toEqual([
      { id: "id:contract", position: 1, after: [] },
      { id: "id:card", position: 2, after: [1] },
      { id: "id:fold", position: 3, after: [1] },
      { id: "id:verify", position: 4, after: [2, 3] },
    ]);
    expect(layout(after)).toEqual(layout(before));
    expect(after?.items.map((item) => item.status)).toEqual([
      "completed",
      "in_progress",
      "failed",
      "pending",
    ]);
  });

  it("picks the newest snapshot by sequence even when the input is unordered", () => {
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({ seq: 30, steps: [{ step: "third", status: "active" }] }),
      planStepsEvent({ seq: 10, steps: [{ step: "first", status: "active" }] }),
      planStepsEvent({
        seq: 20,
        steps: [{ step: "second", status: "active" }],
      }),
    ]);
    expect(result?.sourceSeq).toBe(30);
    expect(result?.items.map((item) => item.text)).toEqual(["third"]);
  });

  it("keeps a step label longer than 240 characters whole for the banner", () => {
    const label = `${"Migrate every stored plan snapshot ".repeat(7)}then 𠮷 run the final backfill check`;
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 1,
        steps: [{ id: "a", step: `  ${label}  `, status: "active", needs: [] }],
      }),
    ]);
    expect(label.length).toBeGreaterThan(240);
    expect(result?.items[0]?.text).toBe(label);
  });

  it("ignores an opened (pending) snapshot and an empty one clears the banner", () => {
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        planStepsEvent({
          seq: 5,
          type: "item/started",
          steps: [{ step: "not settled", status: "active" }],
        }),
      ]),
    ).toBeNull();
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        planStepsEvent({ seq: 6, steps: [{ step: "old", status: "active" }] }),
        planStepsEvent({ seq: 7, steps: [] }),
      ]),
    ).toEqual({
      sourceSeq: 7,
      updatedAt: 7,
      order: "dependencies-not-provided",
      items: [],
    });
  });

  it("does not read a tool call by its name, whatever its arguments carry", () => {
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        legacyTodoWriteToolCallEvent(41),
      ]),
    ).toBeNull();
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 42,
        steps: [{ step: "planned", status: "active" }],
      }),
      legacyTodoWriteToolCallEvent(43),
    ]);
    expect(result?.sourceSeq).toBe(42);
  });

  it("returns null unless the thread is active", () => {
    const events = [
      planStepsEvent({ seq: 1, steps: [{ step: "x", status: "active" }] }),
    ];
    expect(extractThreadTimelinePendingTodos("idle", events)).toBeNull();
    expect(extractThreadTimelinePendingTodos("error", events)).toBeNull();
    expect(extractThreadTimelinePendingTodos(ACTIVE, events)).not.toBeNull();
  });
});
