import { describe, expect, it } from "vitest";
import { captureFirstPartyProviderDeclarations } from "@bb/agent-runtime/test";
import { getLatestThreadSequence, getThread, listEvents } from "@bb/db";
import { turnRequestEventDataSchema, turnScope } from "@bb/domain";
import { threadResponseSchema } from "@bb/server-contract";
import { buildPluginProviderRegistration } from "../../../src/services/providers/plugin-provider-registration.js";
import { prepareTurnSubmitCommandPayload } from "../../../src/services/threads/thread-commands.js";
import {
  registerTestHostRpcCapture,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import { installDefaultEnvironmentProviders } from "../../helpers/environment-provider.js";
import { textInput } from "../../helpers/prompt-input.js";
import { stubHostArtifact } from "../../helpers/provider-registry.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedPrimaryHost,
  seedProjectWithSource,
  seedThread,
  seedThreadIdentity,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../../helpers/test-app.js";

const LARGE = {
  model: "gpt-6-astra",
  contextWindow: 872_000,
  autoCompactTokenLimit: 784_800,
};
const LARGE_OPTIONS = {
  modelContextWindow: 872_000,
  modelAutoCompactTokenLimit: 784_800,
};
const WORKSPACE_PATH = "/tmp/tasks-preset-context-windows";

type CodexSettings = {
  contextWindowOverrides?: string;
  contextWindowPresets?: string;
};

async function registerCodexWithSettings(
  server: RunningTestServer,
  settings: CodexSettings,
): Promise<void> {
  const [declaration] =
    await captureFirstPartyProviderDeclarations("provider-codex");
  if (declaration === undefined) throw new Error("expected Codex");
  server.deps.providerRegistry.register({
    ...buildPluginProviderRegistration({
      available: true,
      pluginId: "provider-codex",
      declaration,
      iconHash: null,
      readSettings: () => settings,
    }),
    pluginId: "provider-codex",
    iconNames: new Set<string>(),
  });
  server.deps.pluginHostArtifacts.set(
    "provider-codex",
    stubHostArtifact("provider-codex"),
  );
}

async function postJson(
  server: RunningTestServer,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await server.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  expect(response.status, JSON.stringify(payload)).toBeLessThan(300);
  return payload;
}

async function tasksRpc<Result>(
  server: RunningTestServer,
  method: string,
  body: Record<string, unknown>,
): Promise<Result> {
  const payload = (await postJson(
    server,
    `/api/v1/plugins/tasks/rpc/${method}`,
    body,
  )) as { result: Result };
  return payload.result;
}

async function queuedStart(server: RunningTestServer, threadId: string) {
  const queued = await waitForQueuedCommand(
    server,
    ({ command }) =>
      command.type === "thread.start" && command.threadId === threadId,
  );
  if (queued.command.type !== "thread.start") {
    throw new Error("expected thread.start");
  }
  return { queued, options: queued.command.options };
}

async function firstStart(server: RunningTestServer, threadId: string) {
  return (await queuedStart(server, threadId)).options;
}

function firstRequest(server: RunningTestServer, threadId: string) {
  const row = listEvents(server.db, { threadId }).find(
    (event) => event.type === "client/turn/requested",
  );
  if (row === undefined) throw new Error("expected a first request");
  return turnRequestEventDataSchema.parse(JSON.parse(row.data));
}

async function withTasksAndCodex(
  run: (fixture: {
    server: RunningTestServer;
    settings: CodexSettings;
    hostId: string;
    projectId: string;
    environment: ReturnType<typeof seedEnvironment>;
    akakiyPresetId: string;
    reviewerPresetId: string;
    taskId: string;
  }) => Promise<void>,
): Promise<void> {
  const server = await startTestServer({ seedFirstPartyProviders: false });
  try {
    installDefaultEnvironmentProviders();
    const settings: CodexSettings = {};
    await registerCodexWithSettings(server, settings);
    server.pluginService.bindSdk({ baseUrl: server.baseUrl });
    const entry = await server.pluginService.install("builtin:tasks", {
      kind: "root",
    });
    expect(entry.status, entry.statusDetail ?? undefined).toBe("running");

    const { host, session } = seedHostSession(server.deps, {
      id: "host-tasks-preset-context",
    });
    seedPrimaryHost(server.deps, host.id);
    registerTestHostRpcCapture(server, {
      hostId: host.id,
      sessionId: session.id,
      gitSourceInspectionResult: {
        isWorktree: false,
        checkout: { kind: "branch", branchName: "main", headSha: "abc123" },
        defaultBranch: null,
        defaultBranchRelation: null,
        hasUncommittedChanges: false,
        operation: { kind: "none" },
        originDefaultBranch: null,
      },
    });
    const { project } = seedProjectWithSource(server.deps, {
      hostId: host.id,
      path: WORKSPACE_PATH,
    });
    const environment = seedEnvironment(server.deps, {
      hostId: host.id,
      projectId: project.id,
      path: WORKSPACE_PATH,
    });
    const tracker = await tasksRpc<{ project: { id: string } }>(
      server,
      "createProject",
      {
        name: "Coordination",
        prefix: "CR",
        color: "#336699",
        linkedBbProjectId: project.id,
      },
    );
    const preset = (name: string, permissionMode: string) =>
      tasksRpc<{ preset: { id: string } }>(server, "createPreset", {
        name,
        providerId: "codex",
        modelId: "gpt-6-astra",
        reasoningLevel: "xhigh",
        serviceTier: "default",
        permissionMode,
      });
    const akakiy = await preset("Akakiy Kurolesov · Chief Coordinator", "full");
    const reviewer = await preset("Astra reviewer", "accept-edits");
    const task = await tasksRpc<{ task: { id: string } }>(
      server,
      "createTask",
      { projectId: tracker.project.id, title: "Coordinate the release" },
    );
    settings.contextWindowPresets = JSON.stringify({
      [akakiy.preset.id]: LARGE,
    });

    await run({
      server,
      settings,
      hostId: host.id,
      projectId: project.id,
      environment,
      akakiyPresetId: akakiy.preset.id,
      reviewerPresetId: reviewer.preset.id,
      taskId: task.task.id,
    });
  } finally {
    await server.pluginService.stop();
    await server.close();
  }
}

describe("context windows for threads started from a Tasks preset", () => {
  it("covers dispatched and preset-spawned threads from their first start and leaves other routes on the defaults", async () => {
    await withTasksAndCodex(
      async ({
        server,
        hostId,
        projectId,
        environment,
        akakiyPresetId,
        reviewerPresetId,
        taskId,
      }) => {
        const dispatched = await tasksRpc<{ threadId: string }>(
          server,
          "delegate",
          { taskId, presetId: akakiyPresetId },
        );
        expect(
          (await firstStart(server, dispatched.threadId)).providerOptions,
        ).toMatchObject(LARGE_OPTIONS);

        const slackSession = await tasksRpc<{ threadId: string }>(
          server,
          "presetSpawn",
          {
            presetId: akakiyPresetId,
            projectId,
            environmentId: environment.id,
            prompt: "Bootstrap the channel session",
            title: "Cr-6 · Akakiy · Slack #general",
            reasoningLevel: "high",
          },
        );
        const slackOptions = await firstStart(server, slackSession.threadId);
        expect(slackOptions.providerOptions).toMatchObject(LARGE_OPTIONS);
        expect(slackOptions.reasoningLevel).toBe("high");
        expect(firstRequest(server, slackSession.threadId)).toMatchObject({
          source: "spawn",
          initiator: "user",
          senderThreadId: null,
          target: { kind: "thread-start" },
          input: [{ type: "text", text: "Bootstrap the channel session" }],
        });

        const reviewer = await tasksRpc<{ threadId: string }>(
          server,
          "presetSpawn",
          {
            presetId: reviewerPresetId,
            projectId,
            environmentId: environment.id,
            prompt: "Review the change",
          },
        );
        const reviewerOptions = (await firstStart(server, reviewer.threadId))
          .providerOptions;
        expect(reviewerOptions).not.toHaveProperty("modelContextWindow");
        expect(reviewerOptions).not.toHaveProperty(
          "modelAutoCompactTokenLimit",
        );

        const bare = threadResponseSchema.parse(
          await postJson(server, "/api/v1/threads", {
            origin: "sdk",
            projectId,
            providerId: "codex",
            model: "gpt-6-astra",
            title: "Cr-6 · Akakiy Kurolesov · Chief Coordinator",
            input: textInput(
              "You are Akakiy Kurolesov, dispatched from preset 01M46H89SV62BXPZ3HMXKAE6MN.",
            ),
            environment: {
              type: "host",
              hostId,
              workspace: { type: "unmanaged", path: WORKSPACE_PATH },
            },
          }),
        );
        expect(
          (await firstStart(server, bare.id)).providerOptions,
        ).not.toHaveProperty("modelContextWindow");
      },
    );
  });

  it("lets a fork inherit, stops at an opt-out and keeps a listed thread's window on resume", async () => {
    await withTasksAndCodex(
      async ({ server, settings, projectId, environment, akakiyPresetId }) => {
        const source = await tasksRpc<{ threadId: string }>(
          server,
          "presetSpawn",
          {
            presetId: akakiyPresetId,
            projectId,
            environmentId: environment.id,
            prompt: "Coordinate",
          },
        );
        const providerThreadId = "provider-preset-fork-source";
        const sourceStart = await queuedStart(server, source.threadId);
        await reportQueuedCommandSuccess(server, sourceStart.queued, {
          providerThreadId,
        });
        seedThreadIdentity(server.deps, {
          threadId: source.threadId,
          environmentId: environment.id,
          providerThreadId,
        });
        const lastSequence = getLatestThreadSequence(server.db, {
          threadId: source.threadId,
        });
        seedTurnStarted(server.deps, {
          environmentId: environment.id,
          providerThreadId,
          sequence: lastSequence + 1,
          threadId: source.threadId,
          turnId: "turn-preset-fork-source",
        });
        seedEvent(server.deps, {
          environmentId: environment.id,
          providerThreadId,
          sequence: lastSequence + 2,
          threadId: source.threadId,
          type: "turn/completed",
          scope: turnScope("turn-preset-fork-source"),
          data: {
            providerThreadId,
            status: "completed",
            providerCheckpointId: "checkpoint-preset-fork-source",
          },
        });

        const forked = threadResponseSchema.parse(
          await postJson(server, "/api/v1/threads/fork", {
            sourceThreadId: source.threadId,
            input: textInput("Side question"),
          }),
        );
        expect(
          (await firstStart(server, forked.id)).providerOptions,
        ).toMatchObject(LARGE_OPTIONS);

        const fork = getThread(server.db, forked.id);
        const existing = seedThread(server.deps, {
          projectId,
          environmentId: environment.id,
        });
        if (fork === null) throw new Error("expected the fork");
        for (const [thread, providerThreadId] of [
          [fork, "provider-preset-fork"],
          [existing, "provider-existing-coordinator"],
        ] as const) {
          seedThreadIdentity(server.deps, {
            threadId: thread.id,
            environmentId: environment.id,
            providerThreadId,
          });
          seedThreadRuntimeState(server.deps, {
            environmentId: environment.id,
            model: "gpt-6-astra",
            permissionMode: "full",
            providerThreadId,
            threadId: thread.id,
          });
        }
        settings.contextWindowOverrides = JSON.stringify({
          [fork.id]: null,
          [existing.id]: LARGE,
        });
        const resume = (thread: typeof fork) =>
          prepareTurnSubmitCommandPayload(server.deps, {
            environment,
            execution: {
              model: "gpt-6-astra",
              permissionMode: "full",
              reasoningLevel: "high",
              serviceTier: "default",
              source: "client/turn/requested",
            },
            permissionEscalation: "ask",
            input: textInput("Continue"),
            target: { mode: "start" },
            thread,
          });
        expect((await resume(fork)).options.providerOptions).not.toHaveProperty(
          "modelContextWindow",
        );
        expect((await resume(existing)).options.providerOptions).toMatchObject(
          LARGE_OPTIONS,
        );
      },
    );
  });
});
