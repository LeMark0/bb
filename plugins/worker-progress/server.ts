import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { buildWorkerForest, type WorkerNode } from "./workers-model.js";
import {
  listWorkerEntries,
  needsDetail,
  readWorkerDetail,
  type WorkerDetail,
  type WorkersSdk,
  type WorkersSnapshot,
} from "./workers-store.js";
import { describeWorkerRow, formatWorkersText } from "./workers-view.js";

const DETAIL_CONCURRENCY = 4;

async function readDetailsInChunks(
  sdk: WorkersSdk,
  threadIds: readonly string[],
): Promise<PromiseSettledResult<readonly [string, WorkerDetail]>[]> {
  if (threadIds.length === 0) return [];
  const chunk = await Promise.allSettled(
    threadIds
      .slice(0, DETAIL_CONCURRENCY)
      .map(async (threadId) => [threadId, await readWorkerDetail(sdk, threadId)] as const),
  );
  return [
    ...chunk,
    ...(await readDetailsInChunks(sdk, threadIds.slice(DETAIL_CONCURRENCY))),
  ];
}

export async function loadWorkersSnapshot(
  sdk: WorkersSdk,
  threadId: string,
  now: number,
): Promise<WorkersSnapshot> {
  const { entries, complete } = await listWorkerEntries(sdk, threadId);
  const wanted = entries.filter(needsDetail).map((entry) => entry.id);
  const results = await readDetailsInChunks(sdk, wanted);
  const details = new Map(
    results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    ),
  );
  return {
    loaded: true,
    complete,
    freshness: "live",
    forest: buildWorkerForest(threadId, entries),
    details,
    failedDetails: new Set(wanted.filter((id) => !details.has(id))),
    lastListedAt: now,
  };
}

function workersJson(snapshot: WorkersSnapshot) {
  const rows = (nodes: readonly WorkerNode[], depth: number): unknown[] =>
    nodes.flatMap((node) => {
      const row = describeWorkerRow(node.entry, snapshot);
      const plan = row.plan;
      return [
        {
          threadId: row.threadId,
          parentThreadId: node.entry.parentThreadId,
          depth,
          name: row.name,
          subject: row.subject,
          state: row.state,
          request: row.request,
          activity: row.activity,
          plan:
            plan.kind === "shared"
              ? {
                  kind: plan.kind,
                  completed: plan.completed,
                  total: plan.total,
                  current: plan.current.map((step) => step.text),
                  next: plan.next?.text ?? null,
                  fromEarlierTurn: plan.fromEarlierTurn,
                  updatedAt: plan.todos.updatedAt,
                }
              : { kind: plan.kind },
          updatedAt: row.updatedAt,
        },
        ...rows(node.children, depth + 1),
      ];
    });
  return { complete: snapshot.complete, workers: rows(snapshot.forest, 0) };
}

export default function workerProgressPlugin(bb: BbPluginApi): void {
  bb.cli.register(
    defineCli({
      name: "workers",
      summary: "Show each worker thread's plan and current activity",
      description:
        "Lists the threads below a coordinator, hidden ones included, with the state, plan and activity the Workers card shows above the coordinator's composer.",
      commands: {
        show: cliCommand({
          summary: "Show the workers below a thread",
          positionals: [
            {
              name: "thread-id",
              description:
                "Coordinator thread id; defaults to the thread running the command",
            },
          ],
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input, ctx) {
            const threadId = input.positionals["thread-id"] ?? ctx.threadId;
            if (threadId === undefined) {
              throw new PluginCliError("No thread to show workers for", {
                code: "thread_required",
                hint: "Pass a thread id: `bb workers show <thread-id>`.",
              });
            }
            const now = Date.now();
            const snapshot = await loadWorkersSnapshot(bb.sdk, threadId, now);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(workersJson(snapshot))
                : formatWorkersText(snapshot, now),
            };
          },
        }),
      },
    }),
  );
}
