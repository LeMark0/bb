import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  markThreadDeleted,
  threads,
  updateThread,
} from "@bb/db";
import { eq } from "drizzle-orm";
import type { EnvironmentRow } from "@bb/db";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import {
  encodeClientTurnRequestIdNumber,
  type PermissionEscalation,
  type Thread,
} from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import * as onlineRpc from "../../src/services/hosts/online-rpc.js";
import * as threadCommands from "../../src/services/threads/thread-commands.js";
import { buildExecutionOptions } from "../../src/services/threads/thread-commands.js";
import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import {
  appendThreadProvisioningEvent,
  buildCwdBranchEntries,
} from "../../src/services/threads/thread-events.js";
import { sendThreadMessage } from "../../src/services/threads/thread-send.js";
import {
  createThreadStartup,
  readThreadProvisionContext,
  saveThreadProvisionContext,
} from "../../src/services/threads/thread-startup-store.js";
import { dispatchTurnDuringReprovision } from "../../src/services/threads/thread-turn-dispatch.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.restoreAllMocks());

interface Family {
  child: Thread;
  environment: EnvironmentRow;
  parent: Thread;
  stranger: Thread;
}

function seedFamily(
  harness: TestAppHarness,
  args: { value: number; childStatus?: "active" | "idle"; orphan?: boolean },
): Family {
  const { host } = seedHostSession(harness.deps, {
    id: `host-parent-escalation-${args.value}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/parent-escalation-${args.value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/parent-escalation-${args.value}`,
    status: "ready",
  });
  const parent = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
  const stranger = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
  });
  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: args.orphan === true ? null : parent.id,
    status: args.childStatus ?? "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-parent-escalation-${args.value}`,
    threadId: child.id,
  });
  return { child, environment, parent, stranger };
}

function currentThread(harness: TestAppHarness, threadId: string): Thread {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error(`Missing thread ${threadId}`);
  return thread;
}

async function tell(
  harness: TestAppHarness,
  family: Family,
  args: {
    mode: "start" | "steer";
    senderThreadId?: string;
    text: string;
  },
): Promise<void> {
  await sendThreadMessage(harness.deps, {
    originPluginId: null,
    environment: family.environment,
    payload: {
      input: textInput(args.text),
      mode: args.mode,
      model: "gpt-5",
      permissionMode: "accept-edits",
      reasoningLevel: "medium",
      serviceTier: "default",
      ...(args.senderThreadId !== undefined
        ? { senderThreadId: args.senderThreadId }
        : {}),
    },
    thread: currentThread(harness, family.child.id),
    trigger: "user",
  });
}

function turnCommandEscalations(
  harness: TestAppHarness,
  threadId: string,
): (PermissionEscalation | null)[] {
  return (["thread.start", "turn.submit"] as const)
    .flatMap((type) => listQueuedThreadCommands(harness, type, threadId))
    .map((command: HostDaemonCommand) =>
      "options" in command &&
      typeof command.options === "object" &&
      command.options !== null &&
      "permissionEscalation" in command.options
        ? (command.options.permissionEscalation as PermissionEscalation | null)
        : null,
    );
}

async function expectEscalations(
  harness: TestAppHarness,
  threadId: string,
  expected: (PermissionEscalation | null)[],
): Promise<void> {
  await vi.waitFor(() => {
    expect(turnCommandEscalations(harness, threadId)).toEqual(expected);
  });
}

async function startActiveTurn(
  harness: TestAppHarness,
  family: Family,
  value: number,
): Promise<void> {
  seedTurnStarted(harness.deps, {
    environmentId: family.environment.id,
    providerThreadId: `provider-parent-escalation-${value}`,
    threadId: family.child.id,
    turnId: `turn-parent-escalation-${value}`,
  });
}

describe("approval escalation for a parent's continuation", () => {
  it("lets a tell from the current parent ask, and keeps every other agent sender denied", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 1 });

      await tell(harness, family, {
        mode: "start",
        senderThreadId: family.parent.id,
        text: "parent continues",
      });

      await expectEscalations(harness, family.child.id, ["ask"]);
    });
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 2 });

      await tell(harness, family, {
        mode: "start",
        senderThreadId: family.stranger.id,
        text: "a sibling writes",
      });

      await expectEscalations(harness, family.child.id, ["deny"]);
    });
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 3, orphan: true });

      await tell(harness, family, {
        mode: "start",
        senderThreadId: family.parent.id,
        text: "no owner",
      });

      await expectEscalations(harness, family.child.id, ["deny"]);
    });
  });

  it("keeps the initiator agent on the recorded request", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 4 });

      await tell(harness, family, {
        mode: "start",
        senderThreadId: family.parent.id,
        text: "parent provenance",
      });

      const request = listEvents(harness.db, { threadId: family.child.id })
        .filter((event) => event.type === "client/turn/requested")
        .map((event) => JSON.parse(event.data));
      expect(request).toContainEqual(
        expect.objectContaining({
          initiator: "agent",
          senderThreadId: family.parent.id,
        }),
      );
      expect(
        request.filter((data) => data.senderThreadId === family.parent.id),
      ).not.toContainEqual(expect.objectContaining({ initiator: "user" }));
    });
  });

  it("lets a parent steer ask during a user turn and during an agent turn", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 5, childStatus: "active" });
      await startActiveTurn(harness, family, 5);

      await tell(harness, family, {
        mode: "steer",
        text: "user steer",
      });
      await tell(harness, family, {
        mode: "steer",
        senderThreadId: family.stranger.id,
        text: "sibling steer",
      });
      await tell(harness, family, {
        mode: "steer",
        senderThreadId: family.parent.id,
        text: "parent steer",
      });

      await expectEscalations(harness, family.child.id, ["ask", "deny", "ask"]);
    });
  });

  it("follows the parent at dispatch time after a reparent", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 6, childStatus: "active" });
      await startActiveTurn(harness, family, 6);
      updateThread(harness.db, harness.hub, family.child.id, {
        parentThreadId: family.stranger.id,
      });

      await tell(harness, family, {
        mode: "steer",
        senderThreadId: family.parent.id,
        text: "old parent",
      });
      await tell(harness, family, {
        mode: "steer",
        senderThreadId: family.stranger.id,
        text: "new parent",
      });

      await expectEscalations(harness, family.child.id, ["deny", "ask"]);
    });
  });

  it("decides a queued parent message when it drains, not when it was queued", async () => {
    for (const reparented of [false, true]) {
      await withTestHarness(async (harness) => {
        const value = reparented ? 8 : 7;
        const family = seedFamily(harness, { value });
        seedQueuedMessage(harness.deps, {
          content: textInput("queued by the parent"),
          permissionMode: "accept-edits",
          senderThreadId: family.parent.id,
          threadId: family.child.id,
          waitingOn: { kind: "thread-busy" },
        });
        if (reparented) {
          updateThread(harness.db, harness.hub, family.child.id, {
            parentThreadId: family.stranger.id,
          });
        }

        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: family.child.id,
        });

        await expectEscalations(harness, family.child.id, [
          reparented ? "deny" : "ask",
        ]);
        expect(listQueuedThreadMessages(harness.db, family.child.id)).toEqual(
          [],
        );
      });
    }
  });

  it("rejects a deleted, missing or cascaded parent sender before dispatch", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 9 });
      harness.db
        .update(threads)
        .set({ deletedAt: Date.now() })
        .where(eq(threads.id, family.parent.id))
        .run();

      await expect(
        tell(harness, family, {
          mode: "start",
          senderThreadId: family.parent.id,
          text: "from a deleted parent",
        }),
      ).rejects.toThrow("Sender thread is invalid");
      await expect(
        tell(harness, family, {
          mode: "start",
          senderThreadId: "thread-does-not-exist",
          text: "from nowhere",
        }),
      ).rejects.toThrow("Sender thread is invalid");
      expect(turnCommandEscalations(harness, family.child.id)).toEqual([]);
    });
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 14 });
      markThreadDeleted(harness.db, harness.hub, {
        threadId: family.parent.id,
      });

      await expect(
        tell(harness, family, {
          mode: "start",
          senderThreadId: family.parent.id,
          text: "after the tree was deleted",
        }),
      ).rejects.toThrow("Thread is deleted");
      expect(turnCommandEscalations(harness, family.child.id)).toEqual([]);
    });
  });

  it("keeps retries and system notices denied even when the parent is named", async () => {
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 10 });

      await sendThreadMessage(harness.deps, {
        originPluginId: null,
        environment: family.environment,
        payload: {
          input: textInput("retry of a parent message"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "accept-edits",
          reasoningLevel: "medium",
          senderThreadId: family.parent.id,
          serviceTier: "default",
        },
        retryOf: {
          requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          attempt: 2,
        },
        thread: currentThread(harness, family.child.id),
        trigger: "user",
      });

      await expectEscalations(harness, family.child.id, ["deny"]);
    });
    await withTestHarness(async (harness) => {
      const family = seedFamily(harness, { value: 11 });

      await sendThreadMessage(harness.deps, {
        originPluginId: null,
        environment: family.environment,
        payload: {
          input: textInput("system notice"),
          mode: "start",
          model: "gpt-5",
          permissionMode: "accept-edits",
          reasoningLevel: "medium",
          senderThreadId: family.parent.id,
          serviceTier: "default",
        },
        systemNotice: { kind: "unlabeled", subject: null },
        thread: currentThread(harness, family.child.id),
        trigger: "user",
      });

      await expectEscalations(harness, family.child.id, ["deny"]);
    });
  });
});

type LateRelationChange = "none" | "reparent" | "delete-sender";

function changeRelation(
  harness: TestAppHarness,
  args: {
    change: LateRelationChange;
    childId: string;
    parentId: string;
    newParentId: string;
  },
): void {
  if (args.change === "reparent") {
    updateThread(harness.db, harness.hub, args.childId, {
      parentThreadId: args.newParentId,
    });
  }
  if (args.change === "delete-sender") {
    harness.db
      .update(threads)
      .set({ deletedAt: Date.now() })
      .where(eq(threads.id, args.parentId))
      .run();
  }
}

const LATE_RELATION_CASES = [
  { change: "none", expected: "ask" },
  { change: "reparent", expected: "deny" },
  { change: "delete-sender", expected: "deny" },
] as const satisfies readonly {
  change: LateRelationChange;
  expected: PermissionEscalation;
}[];

type LateWindow = "prepare" | "transport";

const LATE_WINDOWS = [
  "prepare",
  "transport",
] as const satisfies readonly LateWindow[];

function changeRelationDuring(
  window: LateWindow,
  args: {
    change: () => void;
    commandType: "thread.start" | "turn.submit";
    threadId: string;
  },
): (PermissionEscalation | null)[] {
  const escalationsWhenChanged: (PermissionEscalation | null)[] = [];
  if (window === "prepare") {
    const prepareSubmit = threadCommands.prepareTurnSubmitCommandPayload;
    vi.spyOn(
      threadCommands,
      "prepareTurnSubmitCommandPayload",
    ).mockImplementation(async (deps, prepareArgs) => {
      escalationsWhenChanged.push(prepareArgs.permissionEscalation);
      args.change();
      return prepareSubmit(deps, prepareArgs);
    });
    const buildStart = threadCommands.buildThreadStartCommand;
    vi.spyOn(threadCommands, "buildThreadStartCommand").mockImplementation(
      async (deps, buildArgs) => {
        escalationsWhenChanged.push(buildArgs.permissionEscalation);
        args.change();
        return buildStart(deps, buildArgs);
      },
    );
    return escalationsWhenChanged;
  }
  const callForWork = onlineRpc.callHostOnlineRpcForWork;
  vi.spyOn(onlineRpc, "callHostOnlineRpcForWork").mockImplementation(
    (deps, callArgs) => {
      const command = callArgs.command;
      if (
        (command.type === "thread.start" || command.type === "turn.submit") &&
        command.type === args.commandType &&
        command.threadId === args.threadId
      ) {
        escalationsWhenChanged.push(command.options.permissionEscalation);
        queueMicrotask(args.change);
      }
      return callForWork(deps, callArgs);
    },
  );
  return escalationsWhenChanged;
}

describe("approval escalation when the parent changes before the command leaves", () => {
  it.each(
    LATE_WINDOWS.flatMap((window) =>
      (["start", "steer"] as const).flatMap((mode) =>
        LATE_RELATION_CASES.map((testCase) => ({ window, mode, ...testCase })),
      ),
    ),
  )(
    "$mode with $change during $window → $expected",
    async ({ window, mode, change, expected }) => {
      await withTestHarness(async (harness) => {
        const value = 30;
        const family = seedFamily(harness, {
          value,
          childStatus: mode === "steer" ? "active" : "idle",
        });
        if (mode === "steer") await startActiveTurn(harness, family, value);
        const escalationsWhenChanged = changeRelationDuring(window, {
          change: () =>
            changeRelation(harness, {
              change,
              childId: family.child.id,
              parentId: family.parent.id,
              newParentId: family.stranger.id,
            }),
          commandType: "turn.submit",
          threadId: family.child.id,
        });

        await tell(harness, family, {
          mode,
          senderThreadId: family.parent.id,
          text: "parent message",
        });

        expect(escalationsWhenChanged).toEqual(["ask"]);
        await expectEscalations(harness, family.child.id, [expected]);
      });
    },
  );

  it.each(
    LATE_WINDOWS.flatMap((window) =>
      LATE_RELATION_CASES.map((testCase) => ({ window, ...testCase })),
    ),
  )(
    "provisioned start with $change during $window → $expected",
    async ({ window, change, expected }) => {
      await withTestHarness(async (harness) => {
        const value = 31;
        const { host } = seedHostSession(harness.deps, {
          id: `host-parent-escalation-${value}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/parent-escalation-${value}`,
          status: "ready",
        });
        const parent = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const stranger = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const child = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          parentThreadId: parent.id,
          status: "starting",
        });
        const requested = createThreadStartup({
          initiator: "agent",
          senderThreadId: parent.id,
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          environmentIntent: { type: "reuse", environmentId: environment.id },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
            source: "client/turn/requested",
          },
          fork: null,
          input: textInput("parent message after provisioning"),
          titleProvided: true,
          seedWithoutRun: false,
        });
        const workspaceReadyEventSequence = appendThreadProvisioningEvent(
          harness.deps,
          {
            threadId: child.id,
            environmentId: environment.id,
            provisioningId: requested.state.provisioningId,
            status: "active",
            entries: buildCwdBranchEntries({
              path: `/tmp/parent-escalation-${value}`,
              branchName: null,
              headSha: null,
            }),
          },
        );
        saveThreadProvisionContext({
          replace: false,
          db: harness.db,
          threadId: child.id,
          context: {
            ...requested,
            state: {
              ...requested.state,
              environmentId: environment.id,
              workspaceReadyEventSequence,
            },
          },
        });
        const escalationsWhenChanged = changeRelationDuring(window, {
          change: () =>
            changeRelation(harness, {
              change,
              childId: child.id,
              parentId: parent.id,
              newParentId: stranger.id,
            }),
          commandType: "thread.start",
          threadId: child.id,
        });

        await advanceThreadProvisioning(harness.deps, { threadId: child.id });
        const start = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === child.id,
        );
        try {
          expect(escalationsWhenChanged).toEqual(["ask"]);
          expect(start.command).toMatchObject({
            options: { permissionEscalation: expected },
          });
        } finally {
          await reportQueuedCommandError(harness, start, {
            errorCode: "test_parent_escalation_cleanup",
            errorMessage: "Test settled provisioned start",
          });
        }
      });
    },
  );
});

describe("approval escalation for a parent's continuation through provisioning", () => {
  it("records the sender on a reprovision so its later start can be decided", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        status: "error",
        path: "/tmp/parent-escalation-reprovision",
        environmentProviderId: "personal-workspace",
        environmentProviderPluginId: "bb-plugin-environment-personal-workspace",
        isGitRepo: false,
      });
      const parent = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });
      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        parentThreadId: parent.id,
        status: "idle",
      });
      const execution = await buildExecutionOptions(
        harness.deps,
        {
          model: "gpt-5",
          reasoningLevel: "medium",
          serviceTier: "default",
          permissionMode: "accept-edits",
        },
        { threadId: child.id },
      );

      await expect(
        dispatchTurnDuringReprovision({
          originPluginId: null,
          deps: harness.deps,
          environment,
          execution,
          initiator: "agent",
          input: textInput("parent message during reprovision"),
          senderThreadId: parent.id,
          thread: child,
        }),
      ).resolves.toBe(true);

      expect(
        readThreadProvisionContext(harness.db, child.id)?.request,
      ).toMatchObject({ initiator: "agent", senderThreadId: parent.id });
    });
  });

  it("asks for the parent's provisioned start and denies it after a reparent", async () => {
    for (const reparented of [false, true]) {
      await withTestHarness(async (harness) => {
        const value = reparented ? 13 : 12;
        const { host } = seedHostSession(harness.deps, {
          id: `host-parent-escalation-${value}`,
        });
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
          path: `/tmp/parent-escalation-${value}`,
          status: "ready",
        });
        const parent = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const stranger = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
        });
        const child = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          parentThreadId: parent.id,
          status: "starting",
        });
        const requested = createThreadStartup({
          initiator: "agent",
          senderThreadId: parent.id,
          clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          environmentIntent: { type: "reuse", environmentId: environment.id },
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
            source: "client/turn/requested",
          },
          fork: null,
          input: textInput("parent message after provisioning"),
          titleProvided: true,
          seedWithoutRun: false,
        });
        const provisioningId = requested.state.provisioningId;
        const workspaceReadyEventSequence = appendThreadProvisioningEvent(
          harness.deps,
          {
            threadId: child.id,
            environmentId: environment.id,
            provisioningId,
            status: "active",
            entries: buildCwdBranchEntries({
              path: `/tmp/parent-escalation-${value}`,
              branchName: null,
              headSha: null,
            }),
          },
        );
        saveThreadProvisionContext({
          replace: false,
          db: harness.db,
          threadId: child.id,
          context: {
            ...requested,
            state: {
              ...requested.state,
              environmentId: environment.id,
              workspaceReadyEventSequence,
            },
          },
        });
        if (reparented) {
          updateThread(harness.db, harness.hub, child.id, {
            parentThreadId: stranger.id,
          });
        }

        await advanceThreadProvisioning(harness.deps, { threadId: child.id });
        const start = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.start" && command.threadId === child.id,
        );
        try {
          expect(start.command).toMatchObject({
            options: { permissionEscalation: reparented ? "deny" : "ask" },
          });
        } finally {
          await reportQueuedCommandError(harness, start, {
            errorCode: "test_parent_escalation_cleanup",
            errorMessage: "Test settled provisioned start",
          });
        }
      });
    }
  });
});
