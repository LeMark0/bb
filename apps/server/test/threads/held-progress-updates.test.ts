import {
  deliverHeldProgressQueuedThreadMessagesInTransaction,
  listStoredProjectPromptHistoryRows,
  listStoredThreadPromptHistoryRows,
  getThread,
  listEvents,
  listHeldProgressQueuedThreadMessages,
  listQueuedThreadMessages,
  updateQueuedThreadMessage,
} from "@bb/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  turnRequestEventDataSchema,
  type PromptInput,
  type TurnRequestEventData,
} from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import type { PluginHookName } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import { createQueuedMessageForThread } from "../../src/services/threads/queued-messages.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { waitForQueuedCommand } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/held-progress-project";

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function holdDispatches(holding: { value: boolean }): void {
  const registry: HookRegistry = {
    "message.dispatch": [
      {
        pluginId: "progress-test",
        handler: () =>
          holding.value
            ? { action: "wait", reason: "Held for the test" }
            : { action: "proceed" },
      },
    ],
  };
  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

afterEach(() => {
  setPluginHookProvider(undefined);
});

function seedFamily(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });
  const parent = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-${hostId}`,
    threadId: parent.id,
  });
  const seedChild = (title: string, turnId: string) => {
    const child = seedThread(harness.deps, {
      environmentId: environment.id,
      parentThreadId: parent.id,
      projectId: project.id,
      status: "active",
      title,
    });
    seedTurnStarted(harness.deps, {
      environmentId: environment.id,
      providerThreadId: `provider-${child.id}`,
      threadId: child.id,
      turnId,
    });
    return child;
  };
  return { environment, parent, project, seedChild };
}

function allTurnRequests(
  harness: TestAppHarness,
  threadId: string,
): TurnRequestEventData[] {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

function turnRequestsAfter(
  harness: TestAppHarness,
  threadId: string,
  before: number,
): TurnRequestEventData[] {
  return allTurnRequests(harness, threadId).slice(before);
}

function timelineUserRows(harness: TestAppHarness, threadId: string) {
  const maxSeq = listEvents(harness.db, { threadId }).at(-1)?.sequence ?? 0;
  return buildThreadTimelineWithProfile(
    harness.db,
    currentThread(harness, threadId),
    {
      completedTurnDisplay: "collapse",
      eventBudget: 1_000_000,
      includeClearedContextHistory: false,
      includeDiagnosticOperations: false,
      compactionOfferEnabled: false,
      summarizeShellCommands: true,
      maxInlineOutputChars: null,
      maxSeq,
      page: { kind: "latest", segmentLimit: Number.MAX_SAFE_INTEGER },
    },
  ).response.rows.flatMap((row) =>
    row.kind === "conversation" && row.role === "user" ? [row] : [],
  );
}

function texts(input: PromptInput[]): string[] {
  return input.flatMap((item) => (item.type === "text" ? [item.text] : []));
}

function currentThread(harness: TestAppHarness, threadId: string) {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error(`missing thread ${threadId}`);
  return thread;
}

function send(
  harness: TestAppHarness,
  threadId: string,
  payload: Omit<SendMessageRequest, "mode"> &
    Partial<Pick<SendMessageRequest, "mode">>,
) {
  return acceptThreadSendRequest(harness.deps, {
    payload: { mode: "steer-if-active", ...payload },
    thread: currentThread(harness, threadId),
  });
}

function sendProgress(
  harness: TestAppHarness,
  parentId: string,
  senderThreadId: string,
  text: string,
  endsTurn = false,
) {
  return send(harness, parentId, {
    input: textInput(text),
    progress: true,
    senderThreadId,
    ...(endsTurn ? { progressEndsTurn: true } : {}),
  });
}

describe("held progress updates", () => {
  it("hold a child's update on its parent without starting a turn", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-hold");
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const child = seedChild("Worker", "turn-worker-1");

      const response = await sendProgress(
        harness,
        parent.id,
        child.id,
        "Draft ready for review",
      );
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now() + 60_000,
      });

      expect(response).toMatchObject({
        delivery: "queued",
        queuedMessage: {
          senderThreadId: child.id,
          waitingOn: { kind: "progress" },
        },
      });
      expect(turnRequestsAfter(harness, parent.id, turnsBefore)).toEqual([]);
      expect(
        listQueuedThreadMessages(harness.db, parent.id).map(
          toThreadQueuedMessage,
        ),
      ).toEqual([expect.objectContaining({ waitingOn: { kind: "progress" } })]);
    });
  });

  it("go first, in order and once, with the parent's next actionable turn", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-ride");
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const first = seedChild("First", "turn-first-1");
      const second = seedChild("Second", "turn-second-1");

      await sendProgress(harness, parent.id, first.id, "First step done");
      await sendProgress(harness, parent.id, second.id, "Second step done");
      const response = await send(harness, parent.id, {
        input: textInput("Final result"),
        senderThreadId: first.id,
      });

      expect(response).toEqual({ ok: true, delivery: "sent" });
      const [turn, ...others] = turnRequestsAfter(
        harness,
        parent.id,
        turnsBefore,
      );
      expect(others).toEqual([]);
      expect(turn!.senderThreadId).toBe(first.id);
      expect(turn!.inputGroups?.map(texts)).toEqual([
        [expect.stringContaining(`thread:${first.id}`)],
        [expect.stringContaining(`thread:${second.id}`)],
        [expect.stringContaining(`thread:${first.id}`)],
      ]);
      expect(texts(turn!.input).join("\n")).toMatch(
        /First step done[\s\S]*Second step done[\s\S]*Final result/,
      );
      expect(
        timelineUserRows(harness, parent.id)
          .slice(-3)
          .map((row) => [row.initiator, row.senderThreadId]),
      ).toEqual([
        ["agent", first.id],
        ["agent", second.id],
        ["agent", first.id],
      ]);
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
    });
  });

  it("stay readable from their sender beside a person's own message, which stays editable", async () => {
    await withTestHarness(async (harness) => {
      const { parent, project, seedChild } = seedFamily(
        harness,
        "host-progress-user",
      );
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const child = seedChild("Worker", "turn-user-1");

      await sendProgress(harness, parent.id, child.id, "Tests are green");
      await send(harness, parent.id, { input: textInput("What next?") });

      const [turn, ...others] = turnRequestsAfter(
        harness,
        parent.id,
        turnsBefore,
      );
      expect(others).toEqual([]);
      expect(turn).toMatchObject({
        initiator: "user",
        senderThreadId: null,
        progressSenders: [child.id],
      });
      expect(turn!.inputGroups?.map(texts)).toEqual([
        [
          expect.stringMatching(
            new RegExp(`thread:${child.id}[\\s\\S]*Tests are green`),
          ),
        ],
        ["What next?"],
      ]);
      expect(
        timelineUserRows(harness, parent.id)
          .slice(-2)
          .map((row) => ({
            initiator: row.initiator,
            senderThreadId: row.senderThreadId,
            text: row.text,
            isGrouped: row.turnRequest.isGrouped,
          })),
      ).toEqual([
        {
          initiator: "agent",
          senderThreadId: child.id,
          text: expect.stringContaining("Tests are green"),
          isGrouped: false,
        },
        {
          initiator: "user",
          senderThreadId: null,
          text: "What next?",
          isGrouped: false,
        },
      ]);
      const history = JSON.stringify([
        ...listStoredThreadPromptHistoryRows(harness.db, {
          threadId: parent.id,
          limit: 10,
        }),
        ...listStoredProjectPromptHistoryRows(harness.db, {
          projectId: project.id,
          limit: 10,
        }),
      ]);
      expect(history).toContain("What next?");
      expect(history).not.toContain("Tests are green");
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
    });
  });

  it("go with the first message that starts a parent still waiting to start", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedFamily(
        harness,
        "host-progress-cold",
      );
      const holding = { value: true };
      holdDispatches(holding);
      const parent = await createThreadFromRequest(harness.deps, {
        environment: {
          type: "host",
          hostId: environment.hostId,
          workspace: { type: "unmanaged", path: WORKSPACE_PATH },
        },
        input: textInput("Initial request"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });
      const child = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: parent.id,
        projectId: project.id,
        status: "active",
      });

      await sendProgress(harness, parent.id, child.id, "Cold progress");
      const pending = currentThread(harness, parent.id).status;
      holding.value = false;
      await send(harness, parent.id, { input: textInput("Start now") });
      const start = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.start" && command.threadId === parent.id,
      );

      expect(pending).toBe("pending");
      if (start.command.type !== "thread.start") throw new Error("not a start");
      expect(texts(start.command.input).join("\n")).toMatch(
        /Cold progress[\s\S]*Start now/,
      );
      expect(
        listHeldProgressQueuedThreadMessages(harness.db, parent.id),
      ).toEqual([]);
    });
  });

  it("are sent normally when the sender is not a child of the target", async () => {
    await withTestHarness(async (harness) => {
      const { parent, project, environment } = seedFamily(
        harness,
        "host-progress-stranger",
      );
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const stranger = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      const fromStranger = await sendProgress(
        harness,
        parent.id,
        stranger.id,
        "Not my parent",
      );

      const withoutSender = await send(harness, parent.id, {
        input: textInput("No sender"),
        progress: true,
      });

      expect(fromStranger).toEqual({ ok: true, delivery: "sent" });
      expect(withoutSender).toMatchObject({ ok: true });
      expect(
        listQueuedThreadMessages(harness.db, parent.id).map(
          (row) => toThreadQueuedMessage(row).waitingOn?.kind,
        ),
      ).not.toContain("progress");
      expect(turnRequestsAfter(harness, parent.id, turnsBefore)).toHaveLength(
        1,
      );
      expect(
        listHeldProgressQueuedThreadMessages(harness.db, parent.id),
      ).toEqual([]);
    });
  });

  it("refuse attachments and thread commands instead of holding them", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-refuse");
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const child = seedChild("Worker", "turn-refuse-1");

      await expect(
        send(harness, parent.id, {
          input: [
            ...textInput("See attached"),
            { type: "image", url: "data:image/png;base64,AA==" },
          ],
          progress: true,
          senderThreadId: child.id,
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        send(harness, parent.id, {
          input: createStandaloneBuiltinCompactCommandInput(),
          progress: true,
          senderThreadId: child.id,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      expect(turnRequestsAfter(harness, parent.id, turnsBefore)).toEqual([]);
    });
  });

  it("do not hold back an actionable queued row behind them", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-queue");
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const child = seedChild("Worker", "turn-queue-1");

      await sendProgress(harness, parent.id, child.id, "Halfway there");
      await createQueuedMessageForThread(harness.deps, {
        payload: { input: textInput("Check the build") },
        thread: currentThread(harness, parent.id),
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now() + 60_000,
      });

      const [turn, ...others] = turnRequestsAfter(
        harness,
        parent.id,
        turnsBefore,
      );
      expect(others).toEqual([]);
      expect(texts(turn!.input).join("\n")).toMatch(
        /Halfway there[\s\S]*Check the build/,
      );
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
    });
  });

  it("stay held when they changed under a dispatch", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-edit");
      const child = seedChild("Worker", "turn-edit-1");
      await sendProgress(harness, parent.id, child.id, "Before edit");
      const listed = listHeldProgressQueuedThreadMessages(
        harness.db,
        parent.id,
      );
      updateQueuedThreadMessage(harness.db, harness.deps.hub, {
        content: textInput("After edit"),
        execution: null,
        expectedUpdatedAt: listed[0]!.updatedAt,
        id: listed[0]!.id,
        reschedule: null,
        threadId: parent.id,
      });

      const delivered = harness.db.transaction((tx) =>
        deliverHeldProgressQueuedThreadMessagesInTransaction(tx, listed),
      );

      expect(delivered).toBe(false);
      expect(
        listHeldProgressQueuedThreadMessages(harness.db, parent.id).map(
          (row) => toThreadQueuedMessage(row).content,
        ),
      ).toEqual([textInput("After edit")]);
    });
  });
});

describe("held progress around a trigger that cannot dispatch yet", () => {
  it("keeps earlier progress held and sends both together when the trigger clears", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-wait");
      const turnsBefore = allTurnRequests(harness, parent.id).length;
      const child = seedChild("Worker", "turn-wait-1");
      const holding = { value: true };
      holdDispatches(holding);

      await sendProgress(harness, parent.id, child.id, "Earlier update");
      const trigger = await send(harness, parent.id, {
        input: textInput("Result is ready"),
        senderThreadId: child.id,
      });
      await sendProgress(harness, parent.id, child.id, "Later update");
      const waiting = turnRequestsAfter(harness, parent.id, turnsBefore);
      holding.value = false;
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(trigger).toMatchObject({
        delivery: "queued",
        queuedMessage: { waitingOn: { kind: "plugin" } },
      });
      expect(waiting).toEqual([]);
      const [turn, ...others] = turnRequestsAfter(
        harness,
        parent.id,
        turnsBefore,
      );
      expect(others).toEqual([]);
      expect(texts(turn!.input).join("\n")).toMatch(
        /Earlier update[\s\S]*Result is ready/,
      );
      expect(texts(turn!.input).join("\n")).not.toContain("Later update");
      expect(
        listQueuedThreadMessages(harness.db, parent.id).map(
          (row) => toThreadQueuedMessage(row).content,
        ),
      ).toEqual([textInput("Later update")]);
    });
  });
});

describe("a progress update that ends the sender's turn", () => {
  it("stands for that turn's completion and no later one", async () => {
    await withTestHarness(async (harness) => {
      const { parent, seedChild } = seedFamily(harness, "host-progress-end");
      const child = seedChild("Worker", "turn-end-1");

      const held = await sendProgress(
        harness,
        parent.id,
        child.id,
        "Waiting on review",
        true,
      );
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnId: "turn-end-1",
        turnStatus: "completed",
      });
      const afterCovered = listQueuedThreadMessages(harness.db, parent.id).map(
        toThreadQueuedMessage,
      );
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnId: "turn-end-2",
        turnStatus: "completed",
      });

      expect(held).toMatchObject({
        queuedMessage: {
          waitingOn: { kind: "progress", endsTurnId: "turn-end-1" },
        },
      });
      expect(afterCovered).toEqual([
        expect.objectContaining({
          waitingOn: { kind: "progress", endsTurnId: "turn-end-1" },
        }),
      ]);
      expect(
        listQueuedThreadMessages(harness.db, parent.id).map(
          (row) => row.coalesceKey,
        ),
      ).toEqual([null, "child-outcomes"]);
    });
  });

  it.each(["failed", "interrupted"] as const)(
    "does not stand for a %s end of that turn",
    async (turnStatus) => {
      await withTestHarness(async (harness) => {
        const { parent, seedChild } = seedFamily(
          harness,
          `host-progress-${turnStatus}`,
        );
        const child = seedChild("Worker", `turn-${turnStatus}-1`);

        await sendProgress(harness, parent.id, child.id, "Nearly done", true);
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId: parent.id,
          turnId: `turn-${turnStatus}-1`,
          turnStatus,
        });

        expect(
          listQueuedThreadMessages(harness.db, parent.id).map(
            (row) => row.coalesceKey,
          ),
        ).toEqual([null, "child-outcomes"]);
      });
    },
  );

  it("is refused when the sender is not running a turn", async () => {
    await withTestHarness(async (harness) => {
      const { parent, project, environment } = seedFamily(
        harness,
        "host-progress-noturn",
      );
      const idleChild = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: parent.id,
        projectId: project.id,
        status: "idle",
      });

      await expect(
        sendProgress(harness, parent.id, idleChild.id, "Done?", true),
      ).rejects.toMatchObject({ status: 400 });
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
    });
  });
});
