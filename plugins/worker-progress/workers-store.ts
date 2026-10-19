import type { ThreadTimelinePendingTodos } from "@bb/domain";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk";
import {
  buildWorkerForest,
  workerTurn,
  type Freshness,
  type WorkerEntry,
  type WorkerNode,
  type WorkerTurn,
} from "./workers-model.js";

export type WorkersSdk = Pick<PluginBrowserBbSdk, "subscribe"> & {
  threads: Pick<PluginBrowserBbSdk["threads"], "list" | "timeline">;
};

export interface WorkerDetail {
  todos: ThreadTimelinePendingTodos | null;
  turn: WorkerTurn;
}

export interface WorkersSnapshot {
  loaded: boolean;
  complete: boolean;
  freshness: Freshness;
  forest: readonly WorkerNode[];
  details: ReadonlyMap<string, WorkerDetail>;
  failedDetails: ReadonlySet<string>;
  lastListedAt: number | null;
}

export interface WorkersStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorkersSnapshot;
}

export const MAX_WORKERS = 300;
const LIST_PAGE_LIMIT = 100;
const LIST_CONCURRENCY = 4;
const LIST_DEBOUNCE_MS = 400;
const DETAIL_THROTTLE_MS = 1_000;
const LIST_CHANGES = new Set([
  "thread-created",
  "thread-deleted",
  "parent-changed",
  "archived-changed",
  "status-changed",
  "interactions-changed",
  "title-changed",
]);

const EMPTY_SNAPSHOT: WorkersSnapshot = {
  loaded: false,
  complete: true,
  freshness: "live",
  forest: [],
  details: new Map(),
  failedDetails: new Set(),
  lastListedAt: null,
};

export function needsDetail(entry: WorkerEntry): boolean {
  return entry.status === "active" || entry.hasPendingInteraction;
}

export interface WorkerListing {
  entries: WorkerEntry[];
  complete: boolean;
}

async function listChildren(
  sdk: WorkersSdk,
  parentThreadId: string,
  budget: number,
  signal: AbortSignal | undefined,
  offset = 0,
): Promise<WorkerListing> {
  const page = await sdk.threads.list({
    parentThreadId,
    includeHidden: true,
    archived: false,
    limit: LIST_PAGE_LIMIT,
    offset,
    signal,
  });
  const hasMore = page.length === LIST_PAGE_LIMIT;
  if (!hasMore) return { entries: page, complete: true };
  if (page.length >= budget) {
    return { entries: page.slice(0, budget), complete: false };
  }
  const rest = await listChildren(
    sdk,
    parentThreadId,
    budget - page.length,
    signal,
    offset + LIST_PAGE_LIMIT,
  );
  return { entries: [...page, ...rest.entries], complete: rest.complete };
}

async function listLevel(
  sdk: WorkersSdk,
  parents: readonly string[],
  budget: number,
  signal: AbortSignal | undefined,
): Promise<WorkerListing> {
  if (parents.length === 0) return { entries: [], complete: true };
  if (budget <= 0) return { entries: [], complete: false };
  const batch = await Promise.all(
    parents
      .slice(0, LIST_CONCURRENCY)
      .map((parentThreadId) => listChildren(sdk, parentThreadId, budget, signal)),
  );
  const entries = batch.flatMap((listing) => listing.entries);
  const rest = await listLevel(
    sdk,
    parents.slice(LIST_CONCURRENCY),
    budget - entries.length,
    signal,
  );
  return {
    entries: [...entries, ...rest.entries],
    complete: batch.every((listing) => listing.complete) && rest.complete,
  };
}

async function walk(
  sdk: WorkersSdk,
  parents: readonly string[],
  seen: ReadonlySet<string>,
  budget: number,
  signal: AbortSignal | undefined,
): Promise<WorkerListing> {
  if (parents.length === 0) return { entries: [], complete: true };
  const level = await listLevel(sdk, parents, budget, signal);
  const fresh = level.entries.filter((entry) => !seen.has(entry.id));
  const kept = fresh.slice(0, budget);
  const below = await walk(
    sdk,
    kept.map((entry) => entry.id),
    new Set([...seen, ...kept.map((entry) => entry.id)]),
    budget - kept.length,
    signal,
  );
  return {
    entries: [...kept, ...below.entries],
    complete: level.complete && kept.length === fresh.length && below.complete,
  };
}

export function listWorkerEntries(
  sdk: WorkersSdk,
  rootThreadId: string,
  signal?: AbortSignal,
): Promise<WorkerListing> {
  return walk(sdk, [rootThreadId], new Set([rootThreadId]), MAX_WORKERS, signal);
}

export async function readWorkerDetail(
  sdk: WorkersSdk,
  threadId: string,
  signal?: AbortSignal,
): Promise<WorkerDetail> {
  const timeline = await sdk.threads.timeline({
    threadId,
    segmentLimit: "1",
    deferContent: "true",
    signal,
  });
  return { todos: timeline.pendingTodos, turn: workerTurn(timeline.rows) };
}

function flattenForest(forest: readonly WorkerNode[]): WorkerEntry[] {
  return forest.flatMap((node) => [node.entry, ...flattenForest(node.children)]);
}

interface Session {
  abort: AbortController;
  listTimer: ReturnType<typeof setTimeout> | null;
  listInFlight: boolean;
  listQueued: boolean;
  knownIds: Set<string>;
  detailSubscriptions: Map<string, () => void>;
  detailTimers: Map<string, ReturnType<typeof setTimeout>>;
  detailLastRun: Map<string, number>;
  detailInFlight: Set<string>;
  detailDirty: Set<string>;
  degraded: boolean;
  disconnects: number;
  seenConnected: boolean;
  unsubscribe: readonly (() => void)[];
}

export function createWorkersStore(
  sdk: WorkersSdk,
  rootThreadId: string,
  now: () => number = Date.now,
): WorkersStore {
  let snapshot = EMPTY_SNAPSHOT;
  let session: Session | null = null;
  const listeners = new Set<() => void>();

  const publish = (current: Session, next: Partial<WorkersSnapshot>) => {
    if (session !== current) return;
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };

  const fetchDetail = async (current: Session, threadId: string) => {
    current.detailLastRun.set(threadId, now());
    current.detailInFlight.add(threadId);
    try {
      const detail = await readWorkerDetail(
        sdk,
        threadId,
        current.abort.signal,
      );
      if (!current.detailSubscriptions.has(threadId)) return;
      const details = new Map(snapshot.details);
      details.set(threadId, detail);
      const failedDetails = new Set(snapshot.failedDetails);
      failedDetails.delete(threadId);
      publish(current, { details, failedDetails });
    } catch {
      if (!current.detailSubscriptions.has(threadId)) return;
      publish(current, {
        failedDetails: new Set([...snapshot.failedDetails, threadId]),
      });
    } finally {
      current.detailInFlight.delete(threadId);
      if (current.detailDirty.delete(threadId)) {
        scheduleDetail(current, threadId);
      }
    }
  };

  function scheduleDetail(current: Session, threadId: string) {
    if (session !== current || !current.detailSubscriptions.has(threadId)) {
      return;
    }
    if (current.detailInFlight.has(threadId)) {
      current.detailDirty.add(threadId);
      return;
    }
    if (current.detailTimers.has(threadId)) return;
    const elapsed = now() - (current.detailLastRun.get(threadId) ?? 0);
    current.detailTimers.set(
      threadId,
      setTimeout(
        () => {
          current.detailTimers.delete(threadId);
          void fetchDetail(current, threadId);
        },
        Math.max(0, DETAIL_THROTTLE_MS - elapsed),
      ),
    );
  }

  const stopDetail = (current: Session, threadId: string) => {
    current.detailSubscriptions.get(threadId)?.();
    current.detailSubscriptions.delete(threadId);
    current.detailDirty.delete(threadId);
    const timer = current.detailTimers.get(threadId);
    if (timer !== undefined) clearTimeout(timer);
    current.detailTimers.delete(threadId);
  };

  const reconcileDetails = (
    current: Session,
    entries: readonly WorkerEntry[],
  ): Map<string, WorkerDetail> => {
    const wanted = new Set(entries.filter(needsDetail).map((entry) => entry.id));
    [...current.detailSubscriptions.keys()]
      .filter((threadId) => !wanted.has(threadId))
      .forEach((threadId) => stopDetail(current, threadId));
    wanted.forEach((threadId) => {
      if (current.detailSubscriptions.has(threadId)) return;
      current.detailSubscriptions.set(
        threadId,
        sdk.subscribe({
          event: "thread:changed",
          threadId,
          callback: (message) => {
            if (message.changes.includes("events-appended")) {
              scheduleDetail(current, threadId);
            }
          },
        }),
      );
      scheduleDetail(current, threadId);
    });
    return new Map(
      [...snapshot.details].filter(([threadId]) => wanted.has(threadId)),
    );
  };

  const refreshList = async (current: Session) => {
    if (session !== current) return;
    if (current.listInFlight) {
      current.listQueued = true;
      return;
    }
    current.listInFlight = true;
    const disconnectsAtStart = current.disconnects;
    try {
      const listing = await listWorkerEntries(
        sdk,
        rootThreadId,
        current.abort.signal,
      );
      if (session !== current) return;
      current.knownIds = new Set([
        rootThreadId,
        ...listing.entries.map((entry) => entry.id),
      ]);
      const forest = buildWorkerForest(rootThreadId, listing.entries);
      const observedThroughout =
        !current.degraded && current.disconnects === disconnectsAtStart;
      publish(current, {
        loaded: true,
        complete: listing.complete,
        freshness: observedThroughout ? "live" : "stale",
        forest,
        details: reconcileDetails(current, flattenForest(forest)),
        lastListedAt: now(),
      });
    } catch {
      publish(current, { loaded: true, freshness: "stale" });
    } finally {
      current.listInFlight = false;
      if (current.listQueued) {
        current.listQueued = false;
        scheduleList(current);
      }
    }
  };

  function scheduleList(current: Session) {
    if (session !== current || current.listTimer !== null) return;
    current.listTimer = setTimeout(() => {
      current.listTimer = null;
      void refreshList(current);
    }, LIST_DEBOUNCE_MS);
  }

  const start = () => {
    const current: Session = {
      abort: new AbortController(),
      listTimer: null,
      listInFlight: false,
      listQueued: false,
      knownIds: new Set([rootThreadId]),
      detailSubscriptions: new Map(),
      detailTimers: new Map(),
      detailLastRun: new Map(),
      detailInFlight: new Set(),
      detailDirty: new Set(),
      degraded: false,
      disconnects: 0,
      seenConnected: false,
      unsubscribe: [],
    };
    session = current;
    current.unsubscribe = [
      sdk.subscribe({
        event: "thread:changed",
        callback: (message) => {
          const relevant =
            message.id === undefined ||
            current.knownIds.has(message.id) ||
            message.changes.includes("thread-created") ||
            message.changes.includes("parent-changed");
          if (
            relevant &&
            message.changes.some((change) => LIST_CHANGES.has(change))
          ) {
            scheduleList(current);
          }
        },
      }),
      sdk.subscribe({
        event: "realtime:connection",
        callback: (event) => {
          if (event.state === "disconnected") {
            current.degraded = true;
            current.disconnects += 1;
            publish(current, { freshness: "stale" });
            return;
          }
          if (event.state !== "connected") return;
          const recovering =
            current.degraded || !current.seenConnected || event.reconnected;
          current.degraded = false;
          current.seenConnected = true;
          if (!recovering) return;
          void refreshList(current);
          [...current.detailSubscriptions.keys()].forEach((threadId) =>
            scheduleDetail(current, threadId),
          );
        },
      }),
    ];
    void refreshList(current);
  };

  const stop = () => {
    const current = session;
    if (current === null) return;
    session = null;
    current.abort.abort();
    current.unsubscribe.forEach((unsubscribe) => unsubscribe());
    if (current.listTimer !== null) clearTimeout(current.listTimer);
    [...current.detailSubscriptions.keys()].forEach((threadId) =>
      stopDetail(current, threadId),
    );
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getSnapshot: () => snapshot,
  };
}
