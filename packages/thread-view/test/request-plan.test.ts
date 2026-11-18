import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import type {
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import { buildThreadTimelineFromEvents } from "../src/build-thread-timeline.js";
import { formatThreadTimelineText } from "../src/format-timeline-text.js";
import {
  createTimelineEventFactory,
  fromRows,
} from "./timeline-test-harness.js";

function timeline(
  events: ThreadEventRow[],
  threadStatus: "active" | "idle" = "idle",
) {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents: [],
    events: fromRows(events),
    options: {
      completedTurnDisplay: "collapse",
      includeDiagnosticOperations: false,
      includeNestedRows: false,
      isLatestPage: true,
      summarizeShellCommands: true,
      threadStatus,
      threadName: "",
      workspaceRoot: null,
    },
  });
}

function userRows(rows: readonly TimelineRow[]): TimelineUserConversationRow[] {
  return rows.flatMap((row) =>
    row.kind === "conversation" && row.role === "user" ? [row] : [],
  );
}

function requestTurn(
  event: ReturnType<typeof createTimelineEventFactory>,
  turnId: string,
  text: string,
) {
  const request = event.clientTurnRequested({
    target: { kind: "new-turn" },
    text,
  });
  return [
    request,
    event.turnStarted({ turnId }),
    event.inputAccepted({ clientRequestId: request.data.requestId, turnId }),
  ];
}

const DRAFT_PLAN = [
  { step: "Read the fixture", status: "completed" as const },
  { step: "Compare the outputs", status: "active" as const },
  { step: "Write the summary", status: "pending" as const },
];

describe("request plan projection", () => {
  it("should attach the latest root plan to the initiating request while the turn runs", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const { rows } = timeline(
      [
        ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
        event.planStepsCompleted({
          turnId: "turn-1",
          steps: [{ step: "Read the fixture", status: "active" }],
        }),
        event.commandCompleted({ turnId: "turn-1", command: "ls" }),
        event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
      ],
      "active",
    );

    const [request] = userRows(rows);
    expect(request?.requestPlan).toMatchObject({
      steps: DRAFT_PLAN,
      turnStatus: "pending",
    });
    expect(
      rows.filter(
        (row) => row.kind === "work" && row.workKind === "plan-steps",
      ),
    ).toHaveLength(2);
  });

  it("should keep the last real step states after a collapsed completion", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const { rows } = timeline([
      ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
      event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
      event.commandCompleted({ turnId: "turn-1", command: "ls" }),
      event.assistantCompleted({ turnId: "turn-1", text: "Done" }),
      event.turnCompleted({ turnId: "turn-1" }),
    ]);

    const [request] = userRows(rows);
    expect(request?.requestPlan).toMatchObject({
      steps: DRAFT_PLAN,
      turnStatus: "completed",
    });
    expect(rows.some((row) => row.kind === "turn")).toBe(true);
  });

  it("should report an interrupted turn without changing step states", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const { rows } = timeline([
      ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
      event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);

    expect(userRows(rows)[0]?.requestPlan).toMatchObject({
      steps: DRAFT_PLAN,
      turnStatus: "interrupted",
    });
  });

  it("should annotate only requests whose turn published a plan, cleared ones included", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const { rows } = timeline([
      ...requestTurn(event, "turn-1", "First request"),
      event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
      event.assistantCompleted({ turnId: "turn-1", text: "Done" }),
      event.turnCompleted({ turnId: "turn-1" }),
      ...requestTurn(event, "turn-2", "Second request"),
      event.planStepsCompleted({ turnId: "turn-2", steps: DRAFT_PLAN }),
      event.planStepsCompleted({ turnId: "turn-2", steps: [] }),
      event.assistantCompleted({ turnId: "turn-2", text: "Done" }),
      event.turnCompleted({ turnId: "turn-2" }),
      ...requestTurn(event, "turn-3", "Third request"),
      event.assistantCompleted({ turnId: "turn-3", text: "Done" }),
      event.turnCompleted({ turnId: "turn-3" }),
    ]);

    const requests = userRows(rows);
    expect(requests.map((row) => row.text)).toEqual([
      "First request",
      "Second request",
      "Third request",
    ]);
    expect(requests[0]?.requestPlan?.steps).toEqual(DRAFT_PLAN);
    expect(requests[1]?.requestPlan).toMatchObject({
      steps: [],
      turnStatus: "completed",
    });
    expect(requests[2]).not.toHaveProperty("requestPlan");
  });

  it("should keep a plan revised after a steer on the initiating request", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const steer = event.clientTurnRequested({
      target: { kind: "steer", expectedTurnId: "turn-1" },
      text: "Also check the second fixture",
    });
    const revised = [
      ...DRAFT_PLAN,
      { step: "Check the second fixture", status: "pending" as const },
    ];
    const { rows } = timeline(
      [
        ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
        event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
        steer,
        event.inputAccepted({
          clientRequestId: steer.data.requestId,
          turnId: "turn-1",
        }),
        event.planStepsCompleted({ turnId: "turn-1", steps: revised }),
      ],
      "active",
    );

    const requests = userRows(rows);
    expect(requests.map((row) => row.turnRequest.kind)).toEqual([
      "message",
      "steer",
    ]);
    expect(requests[0]?.requestPlan?.steps).toEqual(revised);
    expect(requests[1]).not.toHaveProperty("requestPlan");
  });

  it("should ignore a plan published by a delegated child", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const childPlan = event.planStepsCompleted({
      turnId: "turn-1",
      steps: [{ step: "Child step", status: "active" }],
    });
    const { rows } = timeline(
      [
        ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
        event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
        {
          ...childPlan,
          data: {
            ...childPlan.data,
            item: { ...childPlan.data.item, parentToolCallId: "delegation-1" },
          },
        },
      ],
      "active",
    );

    expect(userRows(rows)[0]?.requestPlan?.steps).toEqual(DRAFT_PLAN);
  });

  it("should not annotate anything when a page starts inside the turn", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const events = [
      ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
      event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
      event.assistantCompleted({ turnId: "turn-1", text: "Done" }),
      event.turnCompleted({ turnId: "turn-1" }),
    ];
    const { rows } = timeline(events.slice(1));

    expect(userRows(rows)).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain("requestPlan");
  });

  it("should not give a retry's plan to a prepended progress note", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const progress = {
      type: "text" as const,
      text: "Synthetic progress from a worker",
      mentions: [],
    };
    const retryInput = {
      type: "text" as const,
      text: "Continue the synthetic work",
      mentions: [],
      visibility: "agent-only" as const,
    };
    const retry = event.clientTurnRequested({
      text: "",
      initiator: "system",
      target: { kind: "new-turn" },
      input: [progress, retryInput],
      inputGroups: [[progress], [retryInput]],
    });
    const { rows } = timeline(
      [
        ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
        event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
        event.turnCompleted({ turnId: "turn-1", status: "failed" }),
        { ...retry, data: { ...retry.data, progressSenders: ["thr_sender"] } },
        event.turnStarted({ turnId: "turn-2" }),
        event.inputAccepted({
          clientRequestId: retry.data.requestId,
          turnId: "turn-2",
        }),
        event.planStepsCompleted({
          turnId: "turn-2",
          steps: [{ step: "Retry the synthetic work", status: "active" }],
        }),
      ],
      "active",
    );

    const byText = new Map(userRows(rows).map((row) => [row.text, row]));
    expect([...byText.keys()].sort()).toEqual([
      "Check the synthetic fixture",
      "Synthetic progress from a worker",
    ]);
    expect(
      byText.get("Check the synthetic fixture")?.requestPlan?.steps,
    ).toEqual(DRAFT_PLAN);
    expect(byText.get("Synthetic progress from a worker")).not.toHaveProperty(
      "requestPlan",
    );
  });

  it("should give a thread-start request the plan of the turn that accepted it", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const start = event.clientTurnRequested({
      target: { kind: "thread-start" },
      text: "Start the synthetic thread",
    });
    const { rows } = timeline(
      [
        start,
        event.turnStarted({ turnId: "foreign" }),
        event.planStepsCompleted({
          turnId: "foreign",
          steps: [{ step: "Foreign synthetic plan", status: "active" }],
        }),
        event.turnCompleted({ turnId: "foreign" }),
        event.turnStarted({ turnId: "own" }),
        event.inputAccepted({
          clientRequestId: start.data.requestId,
          turnId: "own",
        }),
        event.planStepsCompleted({ turnId: "own", steps: DRAFT_PLAN }),
      ],
      "active",
    );

    const [request] = userRows(rows);
    expect(request?.requestPlan).toMatchObject({
      steps: DRAFT_PLAN,
      turnStatus: "pending",
    });
  });

  it("should print the request plan under the user message in CLI text", () => {
    const event = createTimelineEventFactory({ threadId: "thread-1" });
    const { rows } = timeline([
      ...requestTurn(event, "turn-1", "Check the synthetic fixture"),
      event.planStepsCompleted({ turnId: "turn-1", steps: DRAFT_PLAN }),
      event.turnCompleted({ turnId: "turn-1", status: "interrupted" }),
    ]);

    expect(formatThreadTimelineText(rows)).toContain(
      [
        "Check the synthetic fixture",
        "  Plan (1 of 3 done, stopped)",
        "  [x] Read the fixture",
        "  [>] Compare the outputs",
        "  [ ] Write the summary",
      ].join("\n"),
    );
  });
});
