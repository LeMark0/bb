// @vitest-environment jsdom

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  fakeWorkersSdk,
  listEntry,
  type FakeTimeline,
} from "./workers-test-fixtures.js";

const app = await loadPluginApp(() => import("./app"));
const banner = app.composerCustomizations[0]!.banners![0]!;

const base = { threadId: "thr_w", turnId: "turn-1", sourceSeqEnd: 1 };
const startedAt = Date.now() - 19_000;

const userRow: TimelineRow = {
  ...base,
  id: "user-1",
  sourceSeqStart: 1,
  startedAt,
  createdAt: startedAt,
  kind: "conversation",
  role: "user",
  messageSeq: 1,
  text: "Implement it",
  attachments: null,
  initiator: "agent",
  senderThreadId: "thr_root",
  systemMessageKind: "unlabeled",
  systemMessageSubject: null,
  turnRequest: { isGrouped: false, kind: "message", status: "accepted" },
  mentions: [],
};

function commandRow(
  id: string,
  title: string,
  command: string,
  approvalStatus: "waiting_for_approval" | null = null,
): TimelineRow {
  return {
    ...base,
    id,
    sourceSeqStart: 2,
    startedAt,
    createdAt: startedAt,
    kind: "work",
    workKind: "command",
    status: "pending",
    callId: `${id}-call`,
    command,
    cwd: null,
    source: null,
    output: "",
    exitCode: null,
    completedAt: null,
    approvalStatus,
    activityIntents: [],
    presentation: {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" },
      title,
      detail: command,
    },
  };
}

const satorTimeline: FakeTimeline = {
  rows: [userRow, commandRow("cmd-1", "Check the zod version", "rg -n zod package.json")],
  pendingTodos: {
    sourceSeq: 3,
    updatedAt: startedAt + 1_000,
    order: "dependencies",
    items: [
      { id: "s1", text: "Read the provider data", status: "completed", position: 1, after: [] },
      { id: "s2", text: "Build the card", status: "in_progress", position: 2, after: [1] },
      { id: "s3", text: "Write the tests", status: "in_progress", position: 3, after: [1] },
      { id: "s4", text: "Send for review", status: "pending", position: 4, after: [2, 3] },
    ],
  },
};

const guardTimeline: FakeTimeline = {
  rows: [
    userRow,
    commandRow("cmd-2", "Run the plugin tests", "pnpm exec turbo run test", "waiting_for_approval"),
  ],
  pendingTodos: null,
};

function workers() {
  return fakeWorkersSdk({
    children: {
      thr_root: [
        listEntry({ id: "sator", title: "Cr-34 · Сатор Арепыч · coordinator-progress-1", createdAt: 1 }),
        listEntry({ id: "krivin", title: "Cr-34 · Господин Кривин · design", status: "idle", updatedAt: Date.now() - 5 * 60_000, createdAt: 2 }),
      ],
      sator: [
        listEntry({
          id: "guard",
          parentThreadId: "sator",
          title: "Cr-34 · Колбасный страж · review",
          hasPendingInteraction: true,
          createdAt: 3,
        }),
      ],
    },
    timelines: { sator: satorTimeline, guard: guardTimeline },
  });
}

function renderBanner(fake: ReturnType<typeof workers>) {
  return renderSlot(
    banner,
    {},
    {
      composer: { scope: { kind: "thread", threadId: "thr_root" }, isRunning: false },
      sdk: fake.sdk,
    },
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Workers card", () => {
  it("renders nothing for a thread without workers", async () => {
    const fake = fakeWorkersSdk({ children: {} });
    const slot = renderBanner(fake);
    await waitFor(() => expect(fake.listCalls.length).toBeGreaterThan(0));
    expect(slot.queryByRole("region", { name: "Workers" })).toBeNull();
    expect(slot.container.textContent).toBe("");
  });

  it("shows each worker's state, plan and described activity without opening its thread", async () => {
    const slot = renderBanner(workers());
    await slot.findByText("Check the zod version");

    expect(
      slot.getByRole("button", { name: "Workers: 1 needs approval, 1 working" }),
    ).toBeTruthy();
    expect(slot.getByText("Workers · 1 needs approval · 1 working")).toBeTruthy();
    expect(slot.getByText("Сатор Арепыч")).toBeTruthy();
    expect(slot.getByText("Build the card")).toBeTruthy();
    expect(slot.getByText("Write the tests")).toBeTruthy();
    expect(slot.getByText("Send for review")).toBeTruthy();
    expect(slot.getByText("1 of 4 done")).toBeTruthy();
    expect(slot.getByText("Request · Run the plugin tests")).toBeTruthy();
    expect(slot.queryByText("Run the plugin tests")).toBeNull();
    expect(slot.getAllByText("No plan shared")).toHaveLength(1);
    expect(slot.getByText(/Not running · last update/)).toBeTruthy();
    expect(slot.container.textContent).not.toContain("rg -n zod");
    expect(slot.container.textContent).not.toContain("pnpm exec");
  });

  it("gives each row one accessible sentence with clock times instead of ticking text", async () => {
    const slot = renderBanner(workers());
    await slot.findByText("Check the zod version");
    const sentence = slot.getByText(/^Сатор Арепыч, working\./);
    expect(sentence.textContent).toMatch(
      /Check the zod version, running since \d{1,2}:\d{2}( [AP]M)?\. 1 of 4 done\.$/,
    );
    expect(slot.getByText(/^Господин Кривин, idle\./).textContent).toContain(
      "plan not available while not running",
    );
  });

  it("opens the full plan in PR #5 wording and keeps focus through a live update", async () => {
    const fake = workers();
    const slot = renderBanner(fake);
    await slot.findByText("Check the zod version");

    const toggle = slot.getByRole("button", { name: "Show full plan" });
    fireEvent.click(toggle);
    expect(slot.getByText("Ordered by dependencies.")).toBeTruthy();
    toggle.focus();

    fake.timelines.sator = {
      ...satorTimeline,
      rows: [userRow, commandRow("cmd-3", "Run the card tests", "pnpm test")],
    };
    await act(async () => {
      fake.emitThread({ id: "sator", changes: ["events-appended"] });
    });
    await slot.findByText("Run the card tests", undefined, { timeout: 3_000 });

    expect(document.activeElement).toBe(slot.getByRole("button", { name: "Hide full plan" }));
  });

  it("opens a worker's own thread from its row", async () => {
    const slot = renderBanner(workers());
    await slot.findByText("Check the zod version");
    fireEvent.click(slot.getByRole("button", { name: "Open Колбасный страж's thread" }));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toThread", threadId: "guard" }),
    );
  });

  it("links a nested worker's own workers to its thread without calling them 'below'", async () => {
    const fake = fakeWorkersSdk({
      children: {
        thr_root: [listEntry({ id: "lead", title: "Lead" })],
        lead: [listEntry({ id: "child", title: "Cr-34 · Колбасный страж · review", parentThreadId: "lead" })],
        child: [listEntry({ id: "grandchild", title: "Probe", parentThreadId: "child" })],
      },
    });
    const slot = renderBanner(fake);
    const link = await slot.findByRole("button", {
      name: "Open Колбасный страж's thread to see 1 nested worker",
    });
    expect(link.textContent).toBe("+1 nested worker ›");
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toThread", threadId: "child" }),
    );
  });

  it("collapses nested workers beyond three and expands them in place", async () => {
    const fake = fakeWorkersSdk({
      children: {
        thr_root: [listEntry({ id: "lead", title: "Lead" })],
        lead: ["one", "two", "three", "four", "five"].map((name, index) =>
          listEntry({ id: name, title: name, parentThreadId: "lead", status: "idle", createdAt: index }),
        ),
      },
    });
    const slot = renderBanner(fake);
    await slot.findByText("three");
    expect(slot.queryByText("four")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "+2 more workers" }));
    expect(slot.getByText("five")).toBeTruthy();
  });

  it("folds workers idle for over an hour into one row that expands in place", async () => {
    const longAgo = Date.now() - 3 * 60 * 60_000;
    const fake = fakeWorkersSdk({
      children: {
        thr_root: [
          listEntry({ id: "old-1", title: "Old one", status: "idle", updatedAt: longAgo, createdAt: 1 }),
          listEntry({ id: "busy", title: "Busy", createdAt: 2 }),
          listEntry({ id: "old-2", title: "Old two", status: "idle", updatedAt: longAgo, createdAt: 3 }),
        ],
      },
    });
    const slot = renderBanner(fake);
    const fold = await slot.findByRole("button", { name: "+2 earlier idle workers" });
    expect(slot.queryByText("Old one")).toBeNull();

    fireEvent.click(fold);
    expect(slot.getByRole("button", { name: "Hide 2 earlier idle workers" })).toBe(fold);
    expect(slot.getByText("Old one")).toBeTruthy();
    expect(slot.getByText("Old two")).toBeTruthy();
  });

  it("collapses the card from its header and remembers that for the thread", async () => {
    const slot = renderBanner(workers());
    await slot.findByText("Check the zod version");
    fireEvent.click(slot.getByRole("button", { name: /^Workers: / }));
    expect(slot.queryByText("Check the zod version")).toBeNull();
    cleanup();

    const again = renderBanner(workers());
    await again.findByRole("button", { name: /^Workers: 1 needs approval/ });
    expect(again.queryByText("Check the zod version")).toBeNull();
  });
});
