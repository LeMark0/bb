import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createThread, threads } from "@bb/db";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import { buildPluginProviderRegistration } from "../../src/services/providers/plugin-provider-registration.js";
import { buildThreadStartCommand } from "../../src/services/threads/thread-commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { stubHostArtifact } from "../helpers/provider-registry.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER_ID = "lineage-echo";
const PLUGIN_ID = "provider-lineage-echo";

function registerLineageEcho(harness: TestAppHarness): void {
  harness.deps.providerRegistry.register({
    ...buildPluginProviderRegistration({
      iconHash: null,
      available: true,
      pluginId: PLUGIN_ID,
      declaration: validatePluginProviderDeclaration({
        id: PROVIDER_ID,
        displayName: "Lineage echo",
        maintenance: { health: false, usage: false, installation: false },
        capabilities: {
          supportsServiceTier: false,
          supportsNativeUserQuestion: false,
          fork: "none",
          supportsManualCompaction: false,
          supportsThreadArchive: false,
          supportsThreadRename: false,
          permissionModes: ["accept-edits", "auto", "full"],
          reasoningLevels: ["medium"],
        },
        composerActions: [],
        deriveProviderOptions: (context) => ({
          lineage: context.experimental_lineage.map((link) => ({
            threadId: link.threadId,
            originPluginId: link.originPluginId,
            originPluginMetadata: JSON.stringify(link.originPluginMetadata),
            frozen: Object.isFrozen(link.originPluginMetadata),
          })),
        }),
      }),
      readSettings: () => ({}),
    }),
    pluginId: PLUGIN_ID,
    iconNames: new Set<string>(),
  });
  harness.deps.pluginHostArtifacts.set(PLUGIN_ID, stubHostArtifact(PLUGIN_ID));
}

function seedWorkspace(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-lineage" });
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  return { project, environment };
}

function createLinked(
  harness: TestAppHarness,
  workspace: ReturnType<typeof seedWorkspace>,
  args: {
    sourceThreadId?: string;
    originPluginId?: string;
    metadata?: Record<string, string>;
  } = {},
) {
  return createThread(harness.db, harness.hub, {
    projectId: workspace.project.id,
    environmentId: workspace.environment.id,
    providerId: PROVIDER_ID,
    ...(args.sourceThreadId === undefined
      ? {}
      : { sourceThreadId: args.sourceThreadId }),
    ...(args.originPluginId === undefined
      ? {}
      : {
          originPluginId: args.originPluginId,
          ...(args.metadata === undefined
            ? {}
            : {
                pluginMetadata: {
                  pluginId: args.originPluginId,
                  metadata: args.metadata,
                },
              }),
        }),
  });
}

async function startLineage(
  harness: TestAppHarness,
  workspace: ReturnType<typeof seedWorkspace>,
  thread: ReturnType<typeof createLinked>,
) {
  const command = await buildThreadStartCommand(harness.deps, {
    environment: workspace.environment,
    execution: {
      model: "echo-model",
      permissionMode: "auto",
      reasoningLevel: "medium",
      serviceTier: "default",
      source: "client/turn/requested",
    },
    fork: null,
    permissionEscalation: "ask",
    input: textInput("hello"),
    projectId: workspace.project.id,
    providerId: PROVIDER_ID,
    requestId: encodeClientTurnRequestIdNumber({ value: 1 }),
    syncGeneratedTitle: false,
    thread,
  });
  return command.options.providerOptions.lineage as Array<{
    threadId: string;
    originPluginId: string | null;
    originPluginMetadata: string;
    frozen: boolean;
  }>;
}

describe("the provider options lineage", () => {
  it("lists the thread and its fork sources with each creator's metadata", async () => {
    await withTestHarness(async (harness) => {
      registerLineageEcho(harness);
      const workspace = seedWorkspace(harness);
      const dispatched = createLinked(harness, workspace, {
        originPluginId: "tasks",
        metadata: { presetId: "01M46H89SV62BXPZ3HMXKAE6MN" },
      });
      const sideChat = createLinked(harness, workspace, {
        sourceThreadId: dispatched.id,
        originPluginId: "side-chat",
        metadata: { anchor: "evt_1" },
      });
      const bareFork = createLinked(harness, workspace, {
        sourceThreadId: sideChat.id,
      });

      expect(await startLineage(harness, workspace, bareFork)).toEqual([
        {
          threadId: bareFork.id,
          originPluginId: null,
          originPluginMetadata: "{}",
          frozen: true,
        },
        {
          threadId: sideChat.id,
          originPluginId: "side-chat",
          originPluginMetadata: JSON.stringify({ anchor: "evt_1" }),
          frozen: true,
        },
        {
          threadId: dispatched.id,
          originPluginId: "tasks",
          originPluginMetadata: JSON.stringify({
            presetId: "01M46H89SV62BXPZ3HMXKAE6MN",
          }),
          frozen: true,
        },
      ]);
    });
  });

  it("stops at a thread already listed, at a deleted source and after sixteen threads", async () => {
    await withTestHarness(async (harness) => {
      registerLineageEcho(harness);
      const workspace = seedWorkspace(harness);

      const first = createLinked(harness, workspace);
      const second = createLinked(harness, workspace, {
        sourceThreadId: first.id,
      });
      harness.db
        .update(threads)
        .set({ sourceThreadId: second.id })
        .where(eq(threads.id, first.id))
        .run();
      expect(
        (await startLineage(harness, workspace, second)).map(
          (link) => link.threadId,
        ),
      ).toEqual([second.id, first.id]);

      const removed = createLinked(harness, workspace);
      const orphan = createLinked(harness, workspace, {
        sourceThreadId: removed.id,
      });
      harness.db.delete(threads).where(eq(threads.id, removed.id)).run();
      expect(
        (await startLineage(harness, workspace, orphan)).map(
          (link) => link.threadId,
        ),
      ).toEqual([orphan.id]);

      const chain = Array.from({ length: 19 }).reduce<
        Array<ReturnType<typeof createLinked>>
      >((created) => {
        const previous = created.at(-1);
        return [
          ...created,
          createLinked(
            harness,
            workspace,
            previous === undefined ? {} : { sourceThreadId: previous.id },
          ),
        ];
      }, []);
      const newest = chain.at(-1);
      if (newest === undefined) throw new Error("expected a chain");
      expect(
        (await startLineage(harness, workspace, newest)).map(
          (link) => link.threadId,
        ),
      ).toEqual(
        chain
          .slice(-16)
          .reverse()
          .map((thread) => thread.id),
      );
    });
  });
});
