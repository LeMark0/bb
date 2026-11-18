import { describe, expect, it } from "vitest";
import {
  buildLoadedTimelineState,
  mergeLoadedTimelineWithLatest,
  prependOlderTimelineRows,
} from "@bb/client-core";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
} from "@bb/domain";
import type { Thread, ThreadEventPlanStep } from "@bb/domain";
import type {
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import {
  createProject,
  createThread,
  insertEvents,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import type { DbConnection } from "@bb/db";
import { buildThreadTimelineWithProfile } from "../../../src/services/threads/timeline.js";

const providerThreadId = "provider-root";
const execution = {
  model: "gpt-5",
  serviceTier: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  source: "client/turn/requested",
} as const;

interface SeedTurn {
  text: string;
  plan: ThreadEventPlanStep[] | null;
  completed: boolean;
  filler?: number;
  steers?: string[];
  steerInitiator?: "agent" | "user";
  latePlan?: ThreadEventPlanStep[];
}

function setup(): { db: DbConnection; thread: Thread } {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    status: "active",
  });
  return { db, thread };
}

function seed(db: DbConnection, thread: Thread, turns: SeedTurn[]): void {
  const events: Parameters<typeof insertEvents>[2] = [];
  let sequence = 0;
  const event = (
    type: string,
    scope: ReturnType<typeof turnScope> | ReturnType<typeof threadScope>,
    data: object,
    item?: { id: string; kind: string },
  ) =>
    events.push({
      threadId: thread.id,
      sequence: (sequence += 1),
      type,
      scope,
      ...(scope.kind === "turn" ? { providerThreadId } : {}),
      itemId: item?.id ?? null,
      itemKind: item?.kind ?? null,
      parentToolCallId: null,
      data: JSON.stringify(data),
    } as Parameters<typeof insertEvents>[2][number]);

  turns.forEach((turn, index) => {
    const turnId = `turn-${index + 1}`;
    const clientRequestId = encodeClientTurnRequestIdNumber({
      value: index + 1,
    });
    event("client/turn/requested", threadScope(), {
      direction: "outbound",
      source: "tell",
      initiator: "user",
      request: { method: "turn/start", params: {} },
      requestId: clientRequestId,
      senderThreadId: null,
      input: [{ type: "text", text: turn.text, mentions: [] }],
      target: index === 0 ? { kind: "thread-start" } : { kind: "new-turn" },
      execution,
    });
    event("turn/started", turnScope(turnId), {});
    event("turn/input/accepted", turnScope(turnId), { clientRequestId });
    if (turn.plan !== null) {
      const id = `${turnId}-plan`;
      event(
        "item/completed",
        turnScope(turnId),
        {
          providerThreadId,
          item: {
            type: "planSteps",
            id,
            steps: turn.plan,
            status: "completed",
          },
        },
        { id, kind: "planSteps" },
      );
    }
    (turn.steers ?? []).forEach((text, steerIndex) => {
      const steerRequestId = encodeClientTurnRequestIdNumber({
        value: 1_000 + index * 100 + steerIndex,
      });
      event("client/turn/requested", threadScope(), {
        direction: "outbound",
        source: "tell",
        initiator: turn.steerInitiator ?? "agent",
        request: { method: "turn/start", params: {} },
        requestId: steerRequestId,
        senderThreadId:
          turn.steerInitiator === "user" ? null : "thr_synthetic_sender",
        input: [{ type: "text", text, mentions: [] }],
        target: { kind: "steer", expectedTurnId: turnId },
        execution,
      });
      event("turn/input/accepted", turnScope(turnId), {
        clientRequestId: steerRequestId,
      });
    });
    Array.from({ length: turn.filler ?? 0 }, (_, item) => {
      const id = `${turnId}-note-${item}`;
      return event(
        "item/completed",
        turnScope(turnId),
        { item: { type: "agentMessage", id, text: `Synthetic note ${item}` } },
        { id, kind: "agentMessage" },
      );
    });
    if (turn.latePlan !== undefined) {
      const id = `${turnId}-late-plan`;
      event(
        "item/completed",
        turnScope(turnId),
        {
          providerThreadId,
          item: {
            type: "planSteps",
            id,
            steps: turn.latePlan,
            status: "completed",
          },
        },
        { id, kind: "planSteps" },
      );
    }
    if (!turn.completed) return;
    const answerId = `${turnId}-answer`;
    event(
      "item/completed",
      turnScope(turnId),
      {
        item: { type: "agentMessage", id: answerId, text: "Synthetic answer" },
      },
      { id: answerId, kind: "agentMessage" },
    );
    event("turn/completed", turnScope(turnId), { status: "completed" });
  });
  insertEvents(db, noopNotifier, events);
}

const options = {
  completedTurnDisplay: "collapse" as const,
  extensionStateKinds: [],
  includeClearedContextHistory: false,
  includeDiagnosticOperations: false,
  compactionOfferEnabled: false,
  summarizeShellCommands: true,
  includeNestedRows: false,
  maxInlineOutputChars: null,
  maxSeq: 0,
  eventBudget: 1_000_000,
};

function requests(rows: readonly TimelineRow[]) {
  return rows.flatMap((row) =>
    row.kind === "conversation" && row.role === "user"
      ? [requestSummary(row)]
      : [],
  );
}

function requestSummary(row: TimelineUserConversationRow) {
  return {
    text: row.text,
    steps: row.requestPlan?.steps.map((step) => step.step) ?? null,
    turnStatus: row.requestPlan?.turnStatus ?? null,
  };
}

const firstPlan: ThreadEventPlanStep[] = [
  { step: "Read the synthetic notes", status: "completed" },
  { step: "Draft the synthetic reply", status: "active" },
];
const thirdPlan: ThreadEventPlanStep[] = [
  { step: "Open the synthetic fixture", status: "active" },
  { step: "Compare synthetic totals", status: "pending" },
];

describe("timeline request plans", () => {
  it("should keep each request's own plan across reloads and page boundaries", () => {
    const { db, thread } = setup();
    seed(db, thread, [
      { text: "First synthetic request", plan: firstPlan, completed: true },
      { text: "Second synthetic request", plan: null, completed: true },
      { text: "Third synthetic request", plan: thirdPlan, completed: false },
    ]);

    const reload = buildThreadTimelineWithProfile(db, thread, {
      ...options,
      page: { kind: "latest", segmentLimit: 20 },
    }).response;
    expect(requests(reload.rows)).toEqual([
      {
        text: "First synthetic request",
        steps: firstPlan.map((step) => step.step),
        turnStatus: "completed",
      },
      { text: "Second synthetic request", steps: null, turnStatus: null },
      {
        text: "Third synthetic request",
        steps: thirdPlan.map((step) => step.step),
        turnStatus: "pending",
      },
    ]);
    expect(reload.rows.some((row) => row.kind === "turn")).toBe(true);

    const pages: TimelineRow[][] = [];
    let page = buildThreadTimelineWithProfile(db, thread, {
      ...options,
      page: { kind: "latest", segmentLimit: 1 },
    }).response;
    pages.push(page.rows);
    while (page.timelinePage.olderCursor !== null) {
      page = buildThreadTimelineWithProfile(db, thread, {
        ...options,
        page: {
          kind: "older",
          beforeCursor: page.timelinePage.olderCursor,
          segmentLimit: 1,
        },
      }).response;
      pages.push(page.rows);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.reverse().flatMap(requests)).toEqual(requests(reload.rows));
    db.$client.close();
  });

  it("should give a budget-split request its final plan and turn status", () => {
    const { db, thread } = setup();
    const latePlan = firstPlan.map((step) => ({
      ...step,
      status: "completed" as const,
    }));
    seed(db, thread, [
      {
        text: "Long synthetic request",
        plan: firstPlan,
        completed: true,
        filler: 60,
        latePlan,
      },
    ]);
    const budgeted = { ...options, eventBudget: 12 };
    const pages: TimelineRow[][] = [];
    let page = buildThreadTimelineWithProfile(db, thread, {
      ...budgeted,
      page: { kind: "latest", segmentLimit: 1 },
    }).response;
    pages.push(page.rows);
    while (page.timelinePage.olderCursor !== null) {
      page = buildThreadTimelineWithProfile(db, thread, {
        ...budgeted,
        page: {
          kind: "older",
          beforeCursor: page.timelinePage.olderCursor,
          segmentLimit: 1,
        },
      }).response;
      pages.push(page.rows);
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(
      pages.flatMap((rows) =>
        rows.flatMap((row) =>
          row.kind === "conversation" && row.role === "user"
            ? [row.requestPlan]
            : [],
        ),
      ),
    ).toEqual([
      expect.objectContaining({ steps: latePlan, turnStatus: "completed" }),
    ]);
    db.$client.close();
  });

  it.each([true, false])(
    "should resend a left-out request when its plan changes after steers (completed: %s)",
    (completed) => {
      const { db, thread } = setup();
      const latePlan = firstPlan.map((step) => ({
        ...step,
        status: "completed" as const,
      }));
      seed(db, thread, [
        {
          text: "Steered synthetic request",
          plan: firstPlan,
          completed,
          steers: ["First synthetic steer", "Second synthetic steer"],
          steerInitiator: completed ? "user" : "agent",
          latePlan,
        },
      ]);

      const latest = buildThreadTimelineWithProfile(db, thread, {
        ...options,
        page: { kind: "latest", segmentLimit: 1 },
      }).response;

      expect(requests(latest.rows).map((request) => request.text)).toEqual([
        "Second synthetic steer",
      ]);
      expect(
        requests(latest.timelinePage.olderRowUpdates ?? []).filter(
          (request) => request.steps !== null,
        ),
      ).toEqual([
        {
          text: "Steered synthetic request",
          steps: latePlan.map((step) => step.step),
          turnStatus: completed ? "completed" : "pending",
        },
      ]);
      db.$client.close();
    },
  );

  it.each([
    ["cleared", []],
    [
      "replaced",
      firstPlan.map((step) => ({ ...step, status: "completed" as const })),
    ],
  ] as const)(
    "should merge a %s plan on a loaded older request the same as a fresh read",
    (_label, latePlan) => {
      const { db, thread } = setup();
      seed(db, thread, [
        {
          text: "Steered synthetic request",
          plan: firstPlan,
          completed: true,
          steers: ["First synthetic steer", "Second synthetic steer"],
          steerInitiator: "user",
          latePlan: [...latePlan],
        },
      ]);
      const read = (maxSeq: number, segmentLimit: number) =>
        buildThreadTimelineWithProfile(db, thread, {
          ...options,
          completedTurnDisplay: "flat",
          maxSeq,
          page: { kind: "latest", segmentLimit },
        }).response;
      const plans = (rows: readonly TimelineRow[]) =>
        rows.flatMap((row) =>
          row.kind === "conversation" && row.role === "user"
            ? [
                {
                  text: row.text,
                  steps: row.requestPlan?.steps ?? null,
                  turnStatus: row.requestPlan?.turnStatus ?? null,
                },
              ]
            : [],
        );

      const before = read(8, 1);
      let loadedRows = before.rows;
      let cursor = before.timelinePage.olderCursor;
      while (cursor !== null) {
        const older = buildThreadTimelineWithProfile(db, thread, {
          ...options,
          completedTurnDisplay: "flat",
          maxSeq: 8,
          page: { kind: "older", beforeCursor: cursor, segmentLimit: 1 },
        }).response;
        loadedRows = prependOlderTimelineRows({
          loadedRows,
          olderRows: older.rows,
        });
        cursor = older.timelinePage.olderCursor;
      }
      expect(plans(loadedRows)[0]?.steps).toEqual(firstPlan);
      const loaded = buildLoadedTimelineState({
        historySnapshot: before.timelinePage.historySnapshot,
        latestWindowEndSequence: before.maxSeq,
        latestRows: loadedRows,
        olderCursor: cursor,
        surfaceKey: "synthetic",
      });

      const updated = mergeLoadedTimelineWithLatest({
        current: loaded,
        latestTimeline: { ...read(9, 1), tag: "synthetic-9" },
        surfaceKey: "synthetic",
      });
      expect(plans(updated.rows)).toEqual(plans(read(9, 3).rows));
      expect(plans(updated.rows)[0]?.steps).toEqual(latePlan);

      const ended = mergeLoadedTimelineWithLatest({
        current: updated,
        latestTimeline: { ...read(11, 1), tag: "synthetic-11" },
        surfaceKey: "synthetic",
      });
      expect(plans(ended.rows)).toEqual(plans(read(11, 3).rows));
      expect(plans(ended.rows)[0]?.turnStatus).toBe("completed");
      db.$client.close();
    },
  );
});
