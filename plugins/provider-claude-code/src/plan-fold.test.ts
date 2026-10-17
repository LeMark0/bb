import type { ThreadEventPlanStep } from "@get-bb/plugin-sdk/provider-bridge";
import { describe, expect, it } from "vitest";
import {
  foldClaudeTaskToolResult,
  type ClaudeTaskPlanState,
} from "./plan-fold.js";

type FoldCall = { toolName: string; input: unknown; output: unknown };

function create(id: string): FoldCall {
  return {
    toolName: "TaskCreate",
    input: { subject: `Task ${id}`, description: "" },
    output: { task: { id, subject: `Task ${id}` } },
  };
}

function update(taskId: string, fields: Record<string, unknown>): FoldCall {
  return {
    toolName: "TaskUpdate",
    input: { taskId, ...fields },
    output: { success: true, taskId, updatedFields: Object.keys(fields) },
  };
}

function list(
  tasks: { id: string; status: string; blockedBy: string[] }[],
): FoldCall {
  return {
    toolName: "TaskList",
    input: {},
    output: {
      tasks: tasks.map((task) => ({ ...task, subject: `Task ${task.id}` })),
    },
  };
}

function get(
  taskId: string,
  task: { status: string; blockedBy: string[] } | null,
): FoldCall {
  return {
    toolName: "TaskGet",
    input: { taskId },
    output: {
      task:
        task === null
          ? null
          : {
              id: taskId,
              subject: `Task ${taskId}`,
              description: "",
              ...task,
              blocks: [],
            },
    },
  };
}

function fold(calls: FoldCall[]): (ThreadEventPlanStep[] | null)[] {
  const state: ClaudeTaskPlanState = new Map();
  return calls.map((call) =>
    foldClaudeTaskToolResult({ state, failed: false, ...call }),
  );
}

function needsById(steps: ThreadEventPlanStep[] | null | undefined) {
  return Object.fromEntries(
    (steps ?? []).map((step) => [step.id, step.needs ?? "not provided"]),
  );
}

describe("foldClaudeTaskToolResult dependencies", () => {
  it("gives created tasks their id and no prerequisites", () => {
    const [, second] = fold([create("1"), create("2")]);
    expect(second).toEqual([
      { id: "1", step: "Task 1", status: "pending", needs: [] },
      { id: "2", step: "Task 2", status: "pending", needs: [] },
    ]);
  });

  it("emits a snapshot for a dependency-only update and none when it repeats", () => {
    const snapshots = fold([
      create("1"),
      create("2"),
      update("2", { addBlockedBy: ["1"] }),
      update("2", { addBlockedBy: ["1"] }),
    ]);
    expect(needsById(snapshots[2])).toEqual({ "1": [], "2": ["1"] });
    expect(snapshots[3]).toBeNull();
  });

  it("records addBlocks on the task it blocks", () => {
    const snapshots = fold([
      create("1"),
      create("2"),
      create("3"),
      update("1", { addBlocks: ["2", "3"] }),
    ]);
    expect(needsById(snapshots[3])).toEqual({
      "1": [],
      "2": ["1"],
      "3": ["1"],
    });
  });

  it("keeps a self-block that Claude stores so the plan can be flagged", () => {
    const snapshots = fold([create("1"), update("1", { addBlockedBy: ["1"] })]);
    expect(needsById(snapshots[1])).toEqual({ "1": ["1"] });
  });

  it("does not confirm a blocker that bb has not seen, even once a task takes that id", () => {
    const snapshots = fold([
      create("1"),
      update("1", { addBlockedBy: ["2"] }),
      create("2"),
    ]);
    expect(needsById(snapshots[1])).toEqual({ "1": "not provided" });
    expect(needsById(snapshots[2])).toEqual({
      "1": "not provided",
      "2": [],
    });
  });

  it("removes a deleted task from every prerequisite list, as Claude does", () => {
    const snapshots = fold([
      create("1"),
      create("2"),
      create("3"),
      update("3", { addBlockedBy: ["1", "2"] }),
      update("2", { status: "deleted" }),
      get("1", null),
    ]);
    expect(needsById(snapshots[4])).toEqual({ "1": [], "3": ["1"] });
    expect(needsById(snapshots[5])).toEqual({ "3": [] });
  });

  it("keeps known blockers that TaskList omits once they are completed", () => {
    const snapshots = fold([
      create("1"),
      create("2"),
      update("2", { addBlockedBy: ["1"] }),
      update("1", { status: "completed" }),
      list([
        { id: "1", status: "completed", blockedBy: [] },
        { id: "2", status: "pending", blockedBy: [] },
      ]),
    ]);
    expect(needsById(snapshots[4])).toEqual({ "1": [], "2": ["1"] });
  });

  it("trusts TaskList blockers for unseen tasks only while nothing is completed", () => {
    const [open] = fold([
      list([
        { id: "1", status: "pending", blockedBy: [] },
        { id: "2", status: "pending", blockedBy: ["1"] },
      ]),
    ]);
    const [partlyDone] = fold([
      list([
        { id: "1", status: "completed", blockedBy: [] },
        { id: "2", status: "pending", blockedBy: [] },
      ]),
    ]);
    expect(needsById(open)).toEqual({ "1": [], "2": ["1"] });
    expect(needsById(partlyDone)).toEqual({
      "1": "not provided",
      "2": "not provided",
    });
  });

  it("takes TaskGet's full blocker list as the task's prerequisites", () => {
    const snapshots = fold([
      list([
        { id: "1", status: "completed", blockedBy: [] },
        { id: "2", status: "pending", blockedBy: [] },
      ]),
      get("2", { status: "pending", blockedBy: ["1"] }),
    ]);
    expect(needsById(snapshots[1])).toEqual({
      "1": "not provided",
      "2": ["1"],
    });
  });
});
