import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkerForest } from "./workers-model.js";
import {
  createWorkersStore,
  listWorkerEntries,
  MAX_WORKERS,
} from "./workers-store.js";
import {
  fakeWorkersSdk,
  listEntry,
  type FakeTimeline,
} from "./workers-test-fixtures.js";
import { headerSummary, workerStates } from "./workers-view.js";

function timelineWithStep(text: string): FakeTimeline {
  return {
    rows: [],
    pendingTodos: {
      sourceSeq: 1,
      updatedAt: 1,
      order: "dependencies-not-provided",
      items: [{ id: "step", text, status: "in_progress", position: 1, after: [] }],
    },
  };
}

function setup() {
  const fake = fakeWorkersSdk({
    children: {
      thr_root: [
        listEntry({ id: "a", createdAt: 1 }),
        listEntry({ id: "b", status: "idle", createdAt: 2 }),
      ],
      a: [
        listEntry({
          id: "a1",
          parentThreadId: "a",
          status: "idle",
          hasPendingInteraction: true,
        }),
      ],
    },
  });
  const store = createWorkersStore(fake.sdk, "thr_root");
  const unsubscribe = store.subscribe(() => {});
  return { fake, store, unsubscribe };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createWorkersStore", () => {
  it("lists hidden descendants level by level and reads detail only for running or waiting workers", async () => {
    const { fake, store } = setup();
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.listCalls).toEqual(
      ["thr_root", "a", "b", "a1"].map((parentThreadId) =>
        expect.objectContaining({
          parentThreadId,
          includeHidden: true,
          archived: false,
        }),
      ),
    );
    expect(store.getSnapshot().forest.map((node) => node.entry.id)).toEqual([
      "a",
      "b",
    ]);
    expect([...fake.timelineCalls].sort()).toEqual(["a", "a1"]);
  });

  it("reads a running worker once for a burst of appended events", async () => {
    const { fake } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.timelineCalls.length;

    Array.from({ length: 5 }).forEach(() =>
      fake.emitThread({ id: "a", changes: ["events-appended"] }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fake.timelineCalls.length - before).toBe(1);
  });

  it("walks the tree once for a burst of new descendants", async () => {
    const { fake } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.listCalls.length;

    Array.from({ length: 3 }).forEach((_, index) =>
      fake.emitThread({ id: `new-${index}`, changes: ["thread-created"] }),
    );
    await vi.advanceTimersByTimeAsync(400);

    expect(fake.listCalls.length - before).toBe(4);
  });

  it("ignores unrelated threads' changes", async () => {
    const { fake } = setup();
    await vi.advanceTimersByTimeAsync(0);
    const before = fake.listCalls.length;

    fake.emitThread({ id: "elsewhere", changes: ["status-changed"] });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fake.listCalls.length).toBe(before);
  });

  it("marks data stale while realtime is disconnected and refreshes on reconnect", async () => {
    const { fake, store } = setup();
    await vi.advanceTimersByTimeAsync(0);

    fake.emitConnection({ state: "disconnected", reconnected: false, reconnectDelayMs: 1_000 });
    expect(store.getSnapshot().freshness).toBe("stale");

    const before = fake.listCalls.length;
    fake.emitConnection({ state: "connected", reconnected: true, reconnectDelayMs: null });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(store.getSnapshot().freshness).toBe("live");
    expect(fake.listCalls.length).toBeGreaterThan(before);
  });

  it("stops reading and releases every subscription when the last listener leaves", async () => {
    const { fake, unsubscribe } = setup();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.subscriptionCount()).toBeGreaterThan(0);

    unsubscribe();
    const before = fake.timelineCalls.length;
    fake.emitThread({ id: "a", changes: ["events-appended"] });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fake.subscriptionCount()).toBe(0);
    expect(fake.timelineCalls.length).toBe(before);
  });

  it("finds a running worker however deep it sits", async () => {
    const fake = fakeWorkersSdk({
      children: {
        thr_root: [listEntry({ id: "a", status: "idle" })],
        a: [listEntry({ id: "b", parentThreadId: "a", status: "idle" })],
        b: [listEntry({ id: "c", parentThreadId: "b", status: "idle" })],
        c: [listEntry({ id: "d", parentThreadId: "c", hasPendingInteraction: true })],
      },
    });
    const listing = await listWorkerEntries(fake.sdk, "thr_root");

    expect(listing.entries.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
    expect(listing.complete).toBe(true);
    const states = workerStates({
      forest: buildWorkerForest("thr_root", listing.entries),
      freshness: "live",
    });
    expect(headerSummary(states, listing.complete)).toBe("Workers · 1 needs approval");
  });

  it("pages through more siblings than one list request returns", async () => {
    const siblings = Array.from({ length: 101 }, (_, index) =>
      listEntry({ id: `s${index}`, status: index === 100 ? "active" : "idle", createdAt: index }),
    );
    const fake = fakeWorkersSdk({ children: { thr_root: siblings } });
    const listing = await listWorkerEntries(fake.sdk, "thr_root");

    expect(listing.entries).toHaveLength(101);
    expect(listing.entries.some((entry) => entry.id === "s100")).toBe(true);
    expect(listing.complete).toBe(true);
    expect(
      fake.listCalls
        .filter((call) => call?.parentThreadId === "thr_root")
        .map((call) => call?.offset),
    ).toEqual([0, 100]);
  });

  it("reports an incomplete list instead of exact counts beyond its bound", async () => {
    const siblings = Array.from({ length: MAX_WORKERS + 1 }, (_, index) =>
      listEntry({ id: `s${index}`, status: "idle", createdAt: index }),
    );
    const fake = fakeWorkersSdk({ children: { thr_root: siblings } });
    const listing = await listWorkerEntries(fake.sdk, "thr_root");

    expect(listing.entries).toHaveLength(MAX_WORKERS);
    expect(listing.complete).toBe(false);
    expect(headerSummary(["idle"], listing.complete)).toBe(
      "Workers · some not shown",
    );
  });

  it("never lets an older detail response replace a newer one", async () => {
    const fake = fakeWorkersSdk({
      children: { thr_root: [listEntry({ id: "w" })] },
    });
    const pending: ((value: FakeTimeline) => void)[] = [];
    fake.sdk.threads.timeline = (async () =>
      new Promise<FakeTimeline>((resolve) => {
        pending.push(resolve);
      })) as unknown as typeof fake.sdk.threads.timeline;
    const store = createWorkersStore(fake.sdk, "thr_root");
    store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);

    fake.emitThread({ id: "w", changes: ["events-appended"] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pending).toHaveLength(1);

    pending[0]?.(timelineWithStep("OLD progress"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pending).toHaveLength(2);
    pending[1]?.(timelineWithStep("NEW progress"));
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getSnapshot().details.get("w")?.todos?.items[0]?.text).toBe(
      "NEW progress",
    );
  });

  it("ignores a detail response for a worker that stopped running meanwhile", async () => {
    const fake = fakeWorkersSdk({
      children: { thr_root: [listEntry({ id: "w" })] },
    });
    const pending: ((value: FakeTimeline) => void)[] = [];
    fake.sdk.threads.timeline = (async () =>
      new Promise<FakeTimeline>((resolve) => {
        pending.push(resolve);
      })) as unknown as typeof fake.sdk.threads.timeline;
    const store = createWorkersStore(fake.sdk, "thr_root");
    store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);

    fake.children.thr_root = [listEntry({ id: "w", status: "idle" })];
    fake.emitThread({ id: "w", changes: ["status-changed"] });
    await vi.advanceTimersByTimeAsync(400);
    pending[0]?.(timelineWithStep("Late progress"));
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getSnapshot().details.has("w")).toBe(false);
  });

  it("stays stale when a list response lands while realtime is disconnected", async () => {
    const fake = fakeWorkersSdk({ children: {} });
    const resolvers: ((value: never[]) => void)[] = [];
    const list = fake.sdk.threads.list;
    fake.sdk.threads.list = (async (query) =>
      resolvers.length === 0
        ? new Promise<never[]>((resolve) => {
            resolvers.push(resolve);
          })
        : list(query)) as typeof fake.sdk.threads.list;
    const store = createWorkersStore(fake.sdk, "thr_root");
    store.subscribe(() => {});

    fake.emitConnection({ state: "disconnected", reconnected: false, reconnectDelayMs: 1_000 });
    resolvers[0]?.([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().freshness).toBe("stale");

    fake.emitConnection({ state: "connected", reconnected: true, reconnectDelayMs: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getSnapshot().freshness).toBe("live");
  });

  it("drops a worker's detail once it stops running", async () => {
    const { fake, store } = setup();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.getSnapshot().details.has("a")).toBe(true);

    fake.children.thr_root = [
      listEntry({ id: "a", status: "idle", createdAt: 1 }),
      listEntry({ id: "b", status: "idle", createdAt: 2 }),
    ];
    fake.emitThread({ id: "a", changes: ["status-changed"] });
    await vi.advanceTimersByTimeAsync(400);

    expect(store.getSnapshot().details.has("a")).toBe(false);
  });
});
