import { useState } from "react";
import type { ThreadTimelinePendingTodos } from "@bb/domain";
import { buildWorkerForest, type WorkerTurn } from "./workers-model.js";
import type { WorkerDetail, WorkersSnapshot } from "./workers-store.js";
import { listEntry } from "./workers-test-fixtures.js";
import { WorkersCard } from "./WorkersCard.js";

export default { title: "plugins/Workers/Coordinator card" };

const NOW = Date.now();
const MINUTE = 60_000;

const PLAN: ThreadTimelinePendingTodos = {
  sourceSeq: 40,
  updatedAt: NOW - 4 * MINUTE,
  order: "dependencies",
  items: [
    { id: "p1", text: "Confirm the data each row needs", status: "completed", position: 1, after: [] },
    { id: "p2", text: "Build the Workers card", status: "in_progress", position: 2, after: [1] },
    { id: "p3", text: "Keep Claude command descriptions as row titles", status: "in_progress", position: 3, after: [1] },
    { id: "p4", text: "Test the card and the CLI", status: "pending", position: 4, after: [2, 3] },
    { id: "p5", text: "Send the frozen candidate for review", status: "pending", position: 5, after: [4] },
    { id: "p6", text: "Open the pull request", status: "pending", position: 6, after: [5] },
  ],
};

function turn(overrides: Partial<WorkerTurn>): WorkerTurn {
  return {
    startedAt: NOW - 30 * MINUTE,
    activity: null,
    approval: null,
    activityIsApproval: false,
    ...overrides,
  };
}

const ENTRIES = [
  listEntry({ id: "sator", title: "Cr-34 · Сатор Арепыч · coordinator-progress-1", createdAt: 1 }),
  listEntry({ id: "guard", parentThreadId: "sator", title: "Cr-34 · Колбасный страж · engineering review", hasPendingInteraction: true, createdAt: 2 }),
  listEntry({ id: "krivin", parentThreadId: "sator", title: "Cr-34 · Господин Кривин · rendered review", status: "idle", updatedAt: NOW - 12 * MINUTE, createdAt: 3 }),
  listEntry({ id: "fantasmagor", title: "Cr-35 · Дядюшка Фантасмагор · a very long experiment title that should never push the state label off the row", createdAt: 4 }),
  ...["Бобыль-1", "Бобыль-2", "Бобыль-3", "Бобыль-4", "Бобыль-5"].map((name, index) =>
    listEntry({
      id: `bobyl-${index}`,
      parentThreadId: "fantasmagor",
      title: `Cr-35 · ${name} · variant ${index + 1}`,
      status: index === 1 ? "error" : "idle",
      updatedAt: NOW - (index + 2) * MINUTE,
      createdAt: 10 + index,
    }),
  ),
  listEntry({ id: "deep", parentThreadId: "bobyl-0", title: "Cr-35 · Бобыль-1a · probe", createdAt: 20 }),
  listEntry({ id: "archivarius", title: "Cr-36 · Грибной Архивариус · history lookup", status: "starting", createdAt: 30 }),
];

const DETAILS = new Map<string, WorkerDetail>([
  [
    "sator",
    {
      todos: PLAN,
      turn: turn({
        activity: {
          text: "Check the zod version and current form validation",
          source: "intent",
          since: NOW - 19_000,
          sinceKind: "running",
          detail: "rg -n zod package.json",
        },
      }),
    },
  ],
  [
    "guard",
    {
      todos: null,
      turn: turn({
        approval: "Run the plugin tests",
        activityIsApproval: true,
        activity: {
          text: "Run the plugin tests",
          source: "intent",
          since: NOW - 42_000,
          sinceKind: "running",
          detail: "pnpm exec turbo run test",
        },
      }),
    },
  ],
  [
    "fantasmagor",
    {
      todos: null,
      turn: turn({
        activity: {
          text: "Comparing the two prototype variants against the frozen experiment brief before choosing which Bobyl to promote",
          source: "commentary",
          since: NOW - 3 * MINUTE,
          sinceKind: "posted",
          detail: null,
        },
      }),
    },
  ],
]);

function snapshot(overrides: Partial<WorkersSnapshot> = {}): WorkersSnapshot {
  return {
    loaded: true,
    complete: true,
    freshness: "live",
    forest: buildWorkerForest("thr_root", ENTRIES),
    details: DETAILS,
    failedDetails: new Set(),
    lastListedAt: NOW - 6 * MINUTE,
    ...overrides,
  };
}

function Frame({ value, initiallyExpanded = true }: { value: WorkersSnapshot; initiallyExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <WorkersCard
        snapshot={value}
        isExpanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        openThread={() => {}}
      />
    </div>
  );
}

export const Working = () => <Frame value={snapshot()} />;

export const PlanFromEarlierTurn = () => (
  <Frame
    value={snapshot({
      details: new Map([
        ...DETAILS,
        [
          "sator",
          {
            todos: { ...PLAN, updatedAt: NOW - 40 * MINUTE },
            turn: turn({ startedAt: NOW - 9 * MINUTE }),
          },
        ],
      ]),
    })}
  />
);

export const StatusUnknown = () => <Frame value={snapshot({ freshness: "stale" })} />;

const LONG_IDLE_ENTRIES = [
  ...[
    "Cr-32 · Сатор Арепыч · upstream sync",
    "Cr-32 · Колбасный страж · sync review",
    "Cr-34 · Сатор Арепыч · native plan order",
    "Cr-34 · Колбасный страж · plan order review",
  ].map((title, index) =>
    listEntry({
      id: `earlier-${index}`,
      title,
      status: "idle",
      updatedAt: NOW - (26 - index) * 60 * MINUTE,
      createdAt: index,
    }),
  ),
  listEntry({ id: "earlier-lead", title: "Cr-34 · Сатор Арепыч · direct review semantics", status: "idle", updatedAt: NOW - 18 * 60 * MINUTE, createdAt: 10 }),
  listEntry({ id: "earlier-krivin", parentThreadId: "earlier-lead", title: "Cr-34 · Господин Кривин · design-1", status: "idle", updatedAt: NOW - 18 * 60 * MINUTE, createdAt: 11 }),
  listEntry({ id: "earlier-guard", parentThreadId: "earlier-lead", title: "Cr-34 · Колбасный страж · review-1", status: "idle", updatedAt: NOW - 18 * 60 * MINUTE, createdAt: 12 }),
  listEntry({ id: "sator", title: "Cr-34 · Сатор Арепыч · coordinator-progress-1", createdAt: 20 }),
];

export const LongIdleFolded = () => (
  <Frame
    value={snapshot({
      forest: buildWorkerForest("thr_root", LONG_IDLE_ENTRIES),
      details: new Map([...DETAILS].filter(([threadId]) => threadId === "sator")),
    })}
  />
);

export const AllIdle = () => (
  <Frame
    initiallyExpanded={false}
    value={snapshot({
      forest: buildWorkerForest(
        "thr_root",
        ENTRIES.map((entry) => ({ ...entry, status: "idle" as const, runtime: { displayStatus: "idle" as const }, hasPendingInteraction: false })),
      ),
      details: new Map(),
    })}
  />
);
