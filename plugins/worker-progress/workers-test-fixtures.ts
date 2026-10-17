import type {
  ThreadListEntry,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import type { WorkersSdk } from "./workers-store.js";

type TimelineResult = Awaited<ReturnType<WorkersSdk["threads"]["timeline"]>>;
type SubscribeArgs = Parameters<WorkersSdk["subscribe"]>[0];
type ThreadChangedMessage = Parameters<
  Extract<SubscribeArgs, { event: "thread:changed" }>["callback"]
>[0];
type ConnectionEvent = Parameters<
  Extract<SubscribeArgs, { event: "realtime:connection" }>["callback"]
>[0];

export function listEntry(
  overrides: Partial<ThreadListEntry> & { id: string },
): ThreadListEntry {
  return {
    projectId: "proj_1",
    environmentId: null,
    providerId: "claude-code",
    title: overrides.id,
    titleFallback: null,
    sectionId: null,
    status: "active",
    parentThreadId: "thr_root",
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "hidden",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
    runtime: { displayStatus: overrides.status ?? "active" },
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    queuedWork: "none",
    pinSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentWorkspaceDisplayKind: "other",
    ...overrides,
  };
}

export interface FakeTimeline {
  rows: TimelineRow[];
  pendingTodos: ThreadTimelinePendingTodos | null;
}

export function fakeWorkersSdk(args: {
  children: Record<string, ThreadListEntry[]>;
  timelines?: Record<string, FakeTimeline>;
}) {
  const subscriptions = new Set<SubscribeArgs>();
  const listCalls: Parameters<WorkersSdk["threads"]["list"]>[0][] = [];
  const timelineCalls: string[] = [];
  const subscribe = (subscription: SubscribeArgs) => {
    subscriptions.add(subscription);
    return () => {
      subscriptions.delete(subscription);
    };
  };
  const sdk: WorkersSdk = {
    subscribe: subscribe as WorkersSdk["subscribe"],
    threads: {
      list: async (query) => {
        listCalls.push(query);
        const siblings = args.children[query?.parentThreadId ?? ""] ?? [];
        const offset = query?.offset ?? 0;
        return siblings.slice(offset, offset + (query?.limit ?? siblings.length));
      },
      timeline: async (query) => {
        timelineCalls.push(query.threadId);
        const timeline = args.timelines?.[query.threadId] ?? {
          rows: [],
          pendingTodos: null,
        };
        return timeline as unknown as TimelineResult;
      },
    },
  };
  return {
    sdk,
    children: args.children,
    timelines: args.timelines ?? {},
    listCalls,
    timelineCalls,
    subscriptionCount: () => subscriptions.size,
    emitThread(message: Omit<ThreadChangedMessage, "type" | "entity">) {
      subscriptions.forEach((subscription) => {
        if (subscription.event !== "thread:changed") return;
        if (subscription.threadId !== undefined && subscription.threadId !== message.id) {
          return;
        }
        subscription.callback({ type: "changed", entity: "thread", ...message });
      });
    },
    emitConnection(event: ConnectionEvent) {
      subscriptions.forEach((subscription) => {
        if (subscription.event === "realtime:connection") subscription.callback(event);
      });
    },
  };
}
