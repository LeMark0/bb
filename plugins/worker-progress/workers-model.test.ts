import { describe, expect, it } from "vitest";
import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type {
  TimelineCommandWorkRow,
  TimelineConversationRow,
  TimelineFileReadWorkRow,
  TimelineRow,
} from "@bb/server-contract";
import {
  buildWorkerForest,
  countDescendants,
  splitWorkerTitle,
  workerPlan,
  workerState,
  workerTurn,
  type WorkerEntry,
} from "./workers-model.js";

function entry(overrides: Partial<WorkerEntry> & { id: string }): WorkerEntry {
  return {
    title: overrides.id,
    titleFallback: null,
    parentThreadId: "thr_root",
    status: "active",
    runtime: { displayStatus: "active" },
    hasPendingInteraction: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const base = { threadId: "thr_w", turnId: "turn-2", sourceSeqEnd: 1 };

function userRow(at: number): TimelineConversationRow {
  return {
    ...base,
    id: `user-${at}`,
    sourceSeqStart: at,
    startedAt: at,
    createdAt: at,
    kind: "conversation",
    role: "user",
    messageSeq: at,
    text: "Do the task",
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
    mentions: [],
  };
}

function assistantRow(at: number, text: string): TimelineConversationRow {
  return {
    ...base,
    id: `assistant-${at}`,
    sourceSeqStart: at,
    startedAt: at,
    createdAt: at,
    kind: "conversation",
    role: "assistant",
    messageSeq: at,
    text,
    attachments: null,
    turnRequest: null,
  };
}

const commandVerbs = { pending: "Running command", completed: "Ran command" };

function commandRow(
  at: number,
  overrides: Partial<TimelineCommandWorkRow> = {},
): TimelineCommandWorkRow {
  return {
    ...base,
    id: `command-${at}`,
    sourceSeqStart: at,
    startedAt: at,
    createdAt: at,
    kind: "work",
    workKind: "command",
    status: "pending",
    callId: `call-${at}`,
    command: "/bin/zsh -lc 'pnpm test'",
    cwd: null,
    source: null,
    output: "",
    exitCode: null,
    completedAt: null,
    approvalStatus: null,
    activityIntents: [],
    presentation: {
      label: commandVerbs,
      icon: { glyph: "Terminal" },
      title: "pnpm test",
    },
    ...overrides,
  };
}

function fileReadRow(at: number): TimelineFileReadWorkRow {
  return {
    ...base,
    id: `read-${at}`,
    sourceSeqStart: at,
    startedAt: at,
    createdAt: at,
    kind: "work",
    workKind: "file-read",
    status: "pending",
    callId: `read-call-${at}`,
    path: "/repo/src/app.tsx",
    cmd: null,
    completedAt: null,
    presentation: {
      label: { pending: "Reading file", completed: "Read file" },
      icon: { glyph: "FileText" },
      title: "app.tsx",
    },
  };
}

function item(
  position: number,
  status: ThreadTimelinePendingTodoItem["status"],
  after: number[] = [],
): ThreadTimelinePendingTodoItem {
  return { id: `step-${position}`, text: `Step ${position}`, status, position, after };
}

function todos(
  items: ThreadTimelinePendingTodoItem[],
  updatedAt = 100,
): ThreadTimelinePendingTodos {
  return { sourceSeq: 10, updatedAt, order: "dependencies", items };
}

describe("workerState", () => {
  it("prefers a pending approval over the runtime status", () => {
    expect(
      workerState(entry({ id: "w", hasPendingInteraction: true }), "live"),
    ).toBe("waiting-approval");
  });

  it("reports unknown when the data is stale, whatever was last seen", () => {
    expect(workerState(entry({ id: "w" }), "stale")).toBe("unknown");
  });

  it("maps every runtime status to a truthful label without inventing 'stopped' or 'done'", () => {
    const states = (
      [
        "pending",
        "starting",
        "provisioning",
        "waiting-for-host",
        "active",
        "stopping",
        "idle",
        "error",
      ] as const
    ).map((displayStatus) =>
      workerState(entry({ id: "w", runtime: { displayStatus } }), "live"),
    );
    expect(states).toEqual([
      "starting",
      "starting",
      "starting",
      "waiting-for-host",
      "working",
      "stopping",
      "idle",
      "error",
    ]);
  });
});

describe("workerPlan", () => {
  it("makes no plan claim for a worker that is not running", () => {
    expect(
      workerPlan({ isActive: false, todos: null, currentTurnStartedAt: null }),
    ).toEqual({ kind: "unavailable" });
  });

  it("says no plan was shared only for a running worker without one", () => {
    expect(
      workerPlan({ isActive: true, todos: null, currentTurnStartedAt: null }),
    ).toEqual({ kind: "none" });
    expect(
      workerPlan({
        isActive: true,
        todos: todos([]),
        currentTurnStartedAt: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("keeps several in-progress steps and picks the next pending step in plan order", () => {
    const plan = workerPlan({
      isActive: true,
      todos: todos([
        item(1, "completed"),
        item(2, "in_progress", [1]),
        item(3, "in_progress", [1]),
        item(4, "pending", [2, 3]),
        item(5, "pending"),
        item(6, "failed"),
      ]),
      currentTurnStartedAt: 50,
    });
    expect(plan).toMatchObject({
      kind: "shared",
      completed: 1,
      total: 6,
      fromEarlierTurn: false,
    });
    if (plan.kind !== "shared") throw new Error("expected a shared plan");
    expect(plan.current.map((step) => step.position)).toEqual([2, 3]);
    expect(plan.next?.position).toBe(4);
  });

  it("flags a plan last updated before the worker's current turn", () => {
    const plan = workerPlan({
      isActive: true,
      todos: todos([item(1, "pending")], 100),
      currentTurnStartedAt: 200,
    });
    expect(plan).toMatchObject({ kind: "shared", fromEarlierTurn: true });
  });
});

describe("workerTurn", () => {
  it("uses the running command's description and keeps the command as detail", () => {
    const turn = workerTurn([
      userRow(10),
      assistantRow(11, "Checking the build first."),
      commandRow(12, {
        presentation: {
          label: commandVerbs,
          icon: { glyph: "Terminal" },
          title: "Check the zod version",
          detail: "rg -n zod package.json",
        },
        command: "rg -n zod package.json",
      }),
    ]);
    expect(turn.activity).toEqual({
      text: "Check the zod version",
      source: "intent",
      since: 12,
      sinceKind: "running",
      detail: "rg -n zod package.json",
    });
    expect(turn.startedAt).toBe(10);
  });

  it("falls back to commentary timed from when it was posted, not from the new command", () => {
    const turn = workerTurn([
      userRow(10),
      assistantRow(11, "Checking the zod version and form validation.\n\nMore later."),
      commandRow(40),
    ]);
    expect(turn.activity).toEqual({
      text: "Checking the zod version and form validation.",
      source: "commentary",
      since: 11,
      sinceKind: "posted",
      detail: null,
    });
  });

  it("uses a generic label, never the raw command, when nothing explains the command", () => {
    const turn = workerTurn([userRow(10), commandRow(12)]);
    expect(turn.activity).toMatchObject({
      text: "Running command",
      source: "label",
      since: 12,
    });
    expect(turn.activity?.text).not.toContain("pnpm");
  });

  it("names the file for a running read when no commentary exists", () => {
    expect(workerTurn([userRow(10), fileReadRow(12)]).activity?.text).toBe(
      "Reading file app.tsx",
    );
  });

  it("ignores commentary and work from earlier turns", () => {
    const earlierTurn: TimelineRow = {
      ...base,
      id: "turn-1",
      turnId: "turn-1",
      sourceSeqStart: 1,
      startedAt: 1,
      createdAt: 1,
      kind: "turn",
      status: "completed",
      summaryCount: 2,
      completedAt: 5,
      children: [userRow(1), assistantRow(2, "Old plan for yesterday.")],
    };
    const turn = workerTurn([earlierTurn, userRow(10)]);
    expect(turn.activity).toBeNull();
    expect(turn.startedAt).toBe(10);
  });

  it("names what a waiting command needs approval for", () => {
    const turn = workerTurn([
      userRow(10),
      commandRow(12, {
        approvalStatus: "waiting_for_approval",
        presentation: {
          label: commandVerbs,
          icon: { glyph: "Terminal" },
          title: "Install dependencies",
          detail: "pnpm install",
        },
      }),
    ]);
    expect(turn.approval).toBe("Install dependencies");
    expect(turn.activityIsApproval).toBe(true);
  });

  it("keeps request and activity apart when the activity is commentary", () => {
    const turn = workerTurn([
      userRow(10),
      assistantRow(11, "Running the full suite before review."),
      commandRow(12, { approvalStatus: "waiting_for_approval" }),
    ]);
    expect(turn.approval).toBe("Running command");
    expect(turn.activity?.source).toBe("commentary");
    expect(turn.activityIsApproval).toBe(false);
  });
});

describe("splitWorkerTitle", () => {
  it("separates the worker name from its subject after a tracker key", () => {
    expect(splitWorkerTitle("Cr-34 · Сатор Арепыч · coordinator-progress-1")).toEqual({
      name: "Сатор Арепыч",
      subject: "coordinator-progress-1",
    });
  });

  it("keeps a plain title whole", () => {
    expect(splitWorkerTitle("Fix the flaky test")).toEqual({
      name: "Fix the flaky test",
      subject: null,
    });
  });
});

describe("buildWorkerForest", () => {
  it("orders siblings by spawn time and nests children under their parent", () => {
    const forest = buildWorkerForest("thr_root", [
      entry({ id: "b", createdAt: 20 }),
      entry({ id: "a", createdAt: 10 }),
      entry({ id: "a1", parentThreadId: "a", createdAt: 30 }),
      entry({ id: "a1x", parentThreadId: "a1", createdAt: 40 }),
      entry({ id: "elsewhere", parentThreadId: "thr_other", createdAt: 5 }),
    ]);
    expect(forest.map((node) => node.entry.id)).toEqual(["a", "b"]);
    expect(forest[0]?.children.map((node) => node.entry.id)).toEqual(["a1"]);
    expect(forest[0] ? countDescendants(forest[0]) : 0).toBe(2);
  });

  it("does not loop when a stale duplicate points back up the tree", () => {
    const forest = buildWorkerForest("thr_root", [
      entry({ id: "a" }),
      entry({ id: "b", parentThreadId: "a" }),
      entry({ id: "a", parentThreadId: "b" }),
    ]);
    expect(forest).toHaveLength(1);
    expect(forest[0] ? countDescendants(forest[0]) : 0).toBe(1);
  });
});
