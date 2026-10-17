import { describe, expect, it } from "vitest";
import { buildWorkerForest } from "./workers-model.js";
import { listEntry } from "./workers-test-fixtures.js";
import {
  allNodes,
  belowFoldSummary,
  foldLongIdle,
  LONG_IDLE_FOLD_MS,
  cardVisibility,
  formatAgo,
  formatDuration,
  headerAccessibleName,
  headerSummary,
  nextIdleCardState,
  statusLine,
} from "./workers-view.js";

describe("headerSummary", () => {
  it("puts actionable counts first and omits zero counts", () => {
    expect(
      headerSummary([
        "working",
        "unknown",
        "working",
        "error",
        "idle",
        "waiting-approval",
      ]),
    ).toBe("Workers · 1 needs approval · 1 error · 2 working · 1 unknown");
  });

  it("says all idle when nothing is running", () => {
    expect(headerSummary(["idle", "idle"])).toBe("Workers · all idle");
  });

  it("never claims all idle when the list was cut short", () => {
    expect(headerSummary(["idle", "idle"], false)).toBe("Workers · some not shown");
    expect(headerSummary(["working"], false)).toBe(
      "Workers · some not shown · 1 working",
    );
    expect(headerAccessibleName(["working", "working"], false)).toBe(
      "Workers: some not shown, 2 working",
    );
  });

  it("gives the header toggle the full summary as its accessible name", () => {
    expect(
      headerAccessibleName(["working", "waiting-approval", "unknown", "error"]),
    ).toBe("Workers: 1 needs approval, 1 error, 1 working, 1 unknown");
  });
});

describe("belowFoldSummary", () => {
  it("counts hidden rows and names the actionable ones without working rows", () => {
    expect(
      belowFoldSummary(["working", "idle", "error", "idle", "starting", "working"]),
    ).toBe("+6 more below · 1 error · 1 starting");
  });
});

describe("foldLongIdle", () => {
  const now = 10 * 60 * 60_000;
  const old = now - LONG_IDLE_FOLD_MS - 60_000;
  const recent = now - 5 * 60_000;
  const forest = buildWorkerForest("thr_root", [
    listEntry({ id: "old", status: "idle", updatedAt: old, createdAt: 1 }),
    listEntry({ id: "old-child", parentThreadId: "old", status: "idle", updatedAt: old, createdAt: 2 }),
    listEntry({ id: "busy", createdAt: 3 }),
    listEntry({ id: "old-under-busy", parentThreadId: "busy", status: "idle", updatedAt: old, createdAt: 4 }),
    listEntry({ id: "recent", status: "idle", updatedAt: recent, createdAt: 5 }),
    listEntry({ id: "old-with-busy-child", status: "idle", updatedAt: old, createdAt: 6 }),
    listEntry({ id: "busy-child", parentThreadId: "old-with-busy-child", createdAt: 7 }),
  ]);

  it("folds only idle subtrees whose newest update is older than the threshold, counting nested rows", () => {
    const result = foldLongIdle(forest, "live", now);
    expect(result.folded.map((node) => node.entry.id)).toEqual(["old"]);
    expect(result.foldedCount).toBe(2);
    expect(result.shown.map((node) => node.entry.id)).toEqual([
      "busy",
      "recent",
      "old-with-busy-child",
    ]);
  });

  it("unfolds a worker in its spawn position as soon as it runs again", () => {
    const woken = buildWorkerForest(
      "thr_root",
      allNodes(forest).map((node) =>
        node.entry.id === "old"
          ? { ...node.entry, status: "active" as const, runtime: { displayStatus: "active" as const } }
          : node.entry,
      ),
    );
    expect(foldLongIdle(woken, "live", now).shown[0]?.entry.id).toBe("old");
  });

  it("folds nothing while data is stale", () => {
    expect(foldLongIdle(forest, "stale", now).foldedCount).toBe(0);
  });
});

describe("elapsed wording", () => {
  it("counts seconds, then minutes, then hours", () => {
    expect(formatDuration(19_400)).toBe("19s");
    expect(formatDuration(125_000)).toBe("2 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
  });

  it("calls a fresh message just now", () => {
    expect(formatAgo(20_000)).toBe("just now");
    expect(formatAgo(3 * 60_000)).toBe("3 min ago");
  });
});

describe("statusLine", () => {
  it("never calls an idle or failed worker done", () => {
    const now = 13 * 60_000;
    expect(
      statusLine({ state: "idle", updatedAt: 60_000, lastSeenAt: null, now }),
    ).toBe("Not running · last update 12 min ago");
    expect(
      statusLine({ state: "error", updatedAt: 10 * 60_000, lastSeenAt: null, now }),
    ).toBe("Stopped with an error · 3 min ago");
    expect(
      statusLine({ state: "working", updatedAt: 0, lastSeenAt: null, now }),
    ).toBeNull();
  });

  it("shows when an unknown worker was last seen", () => {
    expect(
      statusLine({ state: "unknown", updatedAt: 0, lastSeenAt: 0, now: 6 * 60_000 }),
    ).toBe("No update received · last seen 6 min ago");
  });
});

describe("idle card", () => {
  const initial = {
    anyBusy: false,
    coordinatorRunning: false,
    dismissed: false,
    expanded: false,
  };

  it("keeps the all-idle header until the coordinator next starts, then hides it", () => {
    const idle = nextIdleCardState(initial, false, false);
    expect(cardVisibility({ workerCount: 2, anyBusy: false, dismissedWhileIdle: idle.dismissed })).toBe("all-idle");

    const started = nextIdleCardState(idle, false, true);
    expect(cardVisibility({ workerCount: 2, anyBusy: false, dismissedWhileIdle: started.dismissed })).toBe("hidden");
  });

  it("does not hide when the coordinator was already running as workers went idle", () => {
    const running = nextIdleCardState({ ...initial, anyBusy: true, coordinatorRunning: true }, false, true);
    expect(running.dismissed).toBe(false);
  });

  it("shows again as soon as a worker runs", () => {
    const dismissed = { ...initial, coordinatorRunning: true, dismissed: true };
    const busy = nextIdleCardState(dismissed, true, true);
    expect(cardVisibility({ workerCount: 2, anyBusy: true, dismissedWhileIdle: busy.dismissed })).toBe("expanded-or-collapsed");
  });

  it("hides when there are no workers", () => {
    expect(cardVisibility({ workerCount: 0, anyBusy: false, dismissedWhileIdle: false })).toBe("hidden");
  });
});
