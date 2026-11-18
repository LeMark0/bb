import { useState, type ReactNode } from "react";
import type {
  TimelineRequestPlan,
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";
import { Button } from "@bb/shared-ui/button";
import { ThreadTimelineRows } from "@/components/thread/timeline";
import {
  commandRow,
  conversationRow,
  planStepsRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../../.ladle/story-card";

export default {
  title: "thread/timeline/rows/Request Plan",
};

const THREAD_ID = "thr_synthetic01";
const TURN_ID = "turn-synthetic-1";
const NEXT_TURN_ID = "turn-synthetic-2";
const T0 = 1_794_998_000_000;

type Steps = TimelineRequestPlan["steps"];

function at(seconds: number): number {
  return T0 + seconds * 1_000;
}

function TimelineStage({
  children,
  width = 760,
}: {
  children: ReactNode;
  width?: number;
}) {
  return (
    <div className="@container/page mx-auto w-full" style={{ maxWidth: width }}>
      {children}
    </div>
  );
}

function requestRow(
  text: string,
  plan: TimelineRequestPlan | undefined,
  options: { id?: string; seq?: number; turnId?: string } = {},
): TimelineUserConversationRow {
  const row = conversationRow({
    id: options.id ?? `${THREAD_ID}:user:1`,
    threadId: THREAD_ID,
    turnId: options.turnId ?? TURN_ID,
    role: "user",
    seq: options.seq ?? 1,
    startedAt: at(options.seq ?? 1),
    createdAt: at(options.seq ?? 1),
    text,
  });
  if (row.role !== "user") throw new Error("Expected a user row");
  return plan === undefined ? row : { ...row, requestPlan: plan };
}

function plan(
  steps: Steps,
  turnStatus: TimelineRequestPlan["turnStatus"],
  revisionSeq: number,
): TimelineRequestPlan {
  return { revisionSeq, steps, explanation: null, turnStatus };
}

function planUpdate(steps: Steps, seq: number): TimelineRow {
  return planStepsRow({
    id: `${THREAD_ID}:plan:${seq}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    seq,
    startedAt: at(seq),
    createdAt: at(seq),
    steps,
  });
}

function command(text: string, seq: number): TimelineRow {
  return commandRow({
    id: `${THREAD_ID}:command:${seq}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    seq,
    startedAt: at(seq),
    createdAt: at(seq),
    command: text,
    status: "completed",
  });
}

function answer(text: string, seq: number, turnId = TURN_ID): TimelineRow {
  return conversationRow({
    id: `${THREAD_ID}:assistant:${seq}`,
    threadId: THREAD_ID,
    turnId,
    role: "assistant",
    seq,
    startedAt: at(seq),
    createdAt: at(seq),
    text,
  });
}

function steer(text: string, seq: number): TimelineRow {
  return conversationRow({
    id: `${THREAD_ID}:user:${seq}`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    role: "user",
    seq,
    startedAt: at(seq),
    createdAt: at(seq),
    text,
    turnRequest: { isGrouped: false, kind: "steer", status: "accepted" },
  });
}

function collapsedTurn(
  status: "completed" | "interrupted" | "error",
  endSeq: number,
): TimelineRow {
  return turnRow({
    id: `${THREAD_ID}:${TURN_ID}:turn`,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    sourceSeqStart: 2,
    sourceSeqEnd: endSeq,
    startedAt: at(2),
    createdAt: at(2),
    durationMs: (endSeq - 2) * 1_000,
    status,
    summaryCount: 6,
  });
}

const REQUEST_TEXT = "Check the synthetic invoice export and fix the totals";

const FIRST_PLAN: Steps = [
  { step: "Read the synthetic export fixture", status: "active" },
  { step: "Compare totals with the ledger sample", status: "pending" },
  { step: "Fix the rounding in the export", status: "pending" },
];
const REVISED_PLAN: Steps = [
  { step: "Read the synthetic export fixture", status: "completed" },
  { step: "Compare totals with the ledger sample", status: "active" },
  { step: "Fix the rounding in the export", status: "pending" },
];
const STEERED_PLAN: Steps = [
  { step: "Read the synthetic export fixture", status: "completed" },
  { step: "Compare totals with the ledger sample", status: "completed" },
  { step: "Fix the rounding in the export", status: "active" },
  { step: "Add a regression test for the rounding", status: "pending" },
];
const FINISHED_PLAN: Steps = STEERED_PLAN.map((step) => ({
  ...step,
  status: "completed",
}));

interface Stage {
  label: string;
  hint: string;
  running: boolean;
  rows: TimelineRow[];
}

const STAGES: Stage[] = [
  {
    label: "Request sent",
    hint: "No plan yet, so no checklist.",
    running: true,
    rows: [requestRow(REQUEST_TEXT, undefined), command("ls fixtures", 3)],
  },
  {
    label: "Plan published",
    hint: "The first step runs; the others wait.",
    running: true,
    rows: [
      requestRow(REQUEST_TEXT, plan(FIRST_PLAN, "pending", 4)),
      command("ls fixtures", 3),
      planUpdate(FIRST_PLAN, 4),
      command("cat fixtures/export.csv", 5),
    ],
  },
  {
    label: "Plan updated",
    hint: "The same checklist updates in place.",
    running: true,
    rows: [
      requestRow(REQUEST_TEXT, plan(REVISED_PLAN, "pending", 6)),
      command("ls fixtures", 3),
      planUpdate(FIRST_PLAN, 4),
      command("cat fixtures/export.csv", 5),
      planUpdate(REVISED_PLAN, 6),
      command("diff totals.csv ledger.csv", 7),
    ],
  },
  {
    label: "Steered",
    hint: "The steer joins the turn; the checklist stays with the request.",
    running: true,
    rows: [
      requestRow(REQUEST_TEXT, plan(STEERED_PLAN, "pending", 10)),
      command("ls fixtures", 3),
      planUpdate(FIRST_PLAN, 4),
      command("cat fixtures/export.csv", 5),
      planUpdate(REVISED_PLAN, 6),
      command("diff totals.csv ledger.csv", 7),
      steer("Add a regression test as well", 8),
      planUpdate(STEERED_PLAN, 10),
    ],
  },
  {
    label: "Turn ended early",
    hint: "The turn finished with a step still open; no motion, nothing ticked off.",
    running: false,
    rows: [
      requestRow(REQUEST_TEXT, plan(STEERED_PLAN, "completed", 10)),
      collapsedTurn("completed", 12),
      answer(
        "I fixed the rounding but couldn't add the test yet: the fixture is missing a ledger sample.",
        13,
      ),
    ],
  },
  {
    label: "Stopped",
    hint: "The user stopped the turn.",
    running: false,
    rows: [
      requestRow(REQUEST_TEXT, plan(STEERED_PLAN, "interrupted", 10)),
      collapsedTurn("interrupted", 11),
    ],
  },
  {
    label: "Finished",
    hint: "Every step completed.",
    running: false,
    rows: [
      requestRow(REQUEST_TEXT, plan(FINISHED_PLAN, "completed", 12)),
      collapsedTurn("completed", 12),
      answer("Totals now match the ledger sample and the test covers it.", 13),
    ],
  },
  {
    label: "Next request, no plan",
    hint: "A later request without a plan shows no checklist; the earlier one keeps its own.",
    running: false,
    rows: [
      requestRow(REQUEST_TEXT, plan(FINISHED_PLAN, "completed", 12)),
      collapsedTurn("completed", 12),
      answer("Totals now match the ledger sample and the test covers it.", 13),
      requestRow("Thanks, what changed in the export?", undefined, {
        id: `${THREAD_ID}:user:20`,
        seq: 20,
        turnId: NEXT_TURN_ID,
      }),
      answer("Only the rounding in the totals column.", 21, NEXT_TURN_ID),
    ],
  },
];

function TransitionsStage({ width }: { width?: number }) {
  const [index, setIndex] = useState(0);
  const stage = STAGES[index] ?? STAGES[0];
  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index === 0}
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={index === STAGES.length - 1}
          onClick={() =>
            setIndex((value) => Math.min(STAGES.length - 1, value + 1))
          }
        >
          Next state
        </Button>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {index + 1}/{STAGES.length} · {stage.label}: {stage.hint}
        </span>
      </div>
      <TimelineStage width={width}>
        <ThreadTimelineRows
          timelineRows={stage.rows}
          threadRuntimeDisplayStatus={stage.running ? "active" : "idle"}
        />
      </TimelineStage>
    </div>
  );
}

export function Transitions() {
  return (
    <StoryCard>
      <StoryRow
        label="desktop"
        hint="Synthetic data. Step through one request's lifecycle."
      >
        <TransitionsStage />
      </StoryRow>
    </StoryCard>
  );
}

export function MobileTransitions() {
  return (
    <div className="p-3">
      <TransitionsStage />
    </div>
  );
}

const LONG_PLAN: Steps = Array.from({ length: 9 }, (_, index) => ({
  step: `Synthetic migration step ${index + 1}: update the fixture table and check its totals`,
  status: index < 4 ? "completed" : index === 4 ? "active" : "pending",
}));

const DEPENDENCY_PLAN: Steps = [
  {
    id: "read",
    needs: [],
    step: "Read the synthetic schema",
    status: "completed",
  },
  {
    id: "api",
    needs: ["read"],
    step: "Update the API handler",
    status: "active",
  },
  {
    id: "ui",
    needs: ["read"],
    step: "Update the settings form",
    status: "pending",
  },
  {
    id: "verify",
    needs: ["api", "ui"],
    step: "Verify both together",
    status: "pending",
  },
];

const PARALLEL_PLAN: Steps = [
  { step: "Read the synthetic schema", status: "completed" },
  { step: "Update the synthetic API handler", status: "active" },
  { step: "Update the synthetic settings form", status: "active" },
  { step: "Verify both together", status: "pending" },
];

const FAILED_PLAN: Steps = [
  { step: "Install the synthetic toolchain", status: "completed" },
  { step: "Run the fixture migration", status: "failed" },
  { step: "Report the result", status: "pending" },
];

function Static({
  rows,
  running,
  width,
}: {
  rows: TimelineRow[];
  running: boolean;
  width?: number;
}) {
  return (
    <TimelineStage width={width}>
      <ThreadTimelineRows
        timelineRows={rows}
        threadRuntimeDisplayStatus={running ? "active" : "idle"}
      />
    </TimelineStage>
  );
}

export function EdgeCases() {
  return (
    <StoryCard>
      <StoryRow
        label="long plan"
        hint="Nine steps collapse to a window around the current step."
      >
        <Static
          running
          rows={[requestRow(REQUEST_TEXT, plan(LONG_PLAN, "pending", 4))]}
        />
      </StoryRow>
      <StoryRow
        label="dependencies"
        hint="Provider-supplied order with prerequisites."
      >
        <Static
          running
          rows={[requestRow(REQUEST_TEXT, plan(DEPENDENCY_PLAN, "pending", 4))]}
        />
      </StoryRow>
      <StoryRow
        label="parallel steps"
        hint="The provider reports two steps in progress; the first leads."
      >
        <Static
          running
          rows={[requestRow(REQUEST_TEXT, plan(PARALLEL_PLAN, "pending", 4))]}
        />
      </StoryRow>
      <StoryRow label="failed step" hint="The turn failed on a step.">
        <Static
          running={false}
          rows={[
            requestRow(REQUEST_TEXT, plan(FAILED_PLAN, "error", 4)),
            collapsedTurn("error", 6),
          ]}
        />
      </StoryRow>
      <StoryRow label="narrow long plan" hint="360px column.">
        <Static
          running
          width={360}
          rows={[requestRow(REQUEST_TEXT, plan(LONG_PLAN, "pending", 4))]}
        />
      </StoryRow>
    </StoryCard>
  );
}
