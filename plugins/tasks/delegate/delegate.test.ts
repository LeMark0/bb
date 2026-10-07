import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "../api";
import type { Comment, Project, Task } from "../db";
import { delegationRpcContract } from "./contract";
import { buildSeedPrompt, registerDelegation } from ".";

function createTestPreset(
  store: ReturnType<typeof createStore>,
  overrides: Partial<{
    environmentKind: "project-default" | "new-worktree";
    baseBranch: string | null;
    machineId: string | null;
  }> = {},
) {
  return store.tasks.createPreset({
    name: "Test worker",
    providerId: "claude-code",
    modelId: "claude-sonnet-5",
    reasoningLevel: "high",
    serviceTier: "fast",
    permissionMode: "full",
    environmentKind: overrides.environmentKind ?? "project-default",
    baseBranch: overrides.baseBranch ?? null,
    machineId: overrides.machineId ?? null,
    instructions: "",
    builtin: false,
  });
}

describe("task delegation", () => {
  it("spawns from a preset, attaches the thread, advances status, comments, and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_delegated" }),
          get: async () =>
            makeThreadResponse({ id: "thr_delegated", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Tasks plugin",
      prefix: "TASK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Implement delegation",
      description: "Build the core agent loop.",
      status: "todo",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    const result = delegationRpcContract.delegate.output.parse(
      await harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: "Run the focused tests before reporting back.",
      }),
    );

    expect(result).toEqual({ threadId: "thr_delegated" });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_bb",
          environment: { type: "project-default" },
          providerId: "claude-code",
          model: "claude-sonnet-5",
          reasoningLevel: "high",
          serviceTier: "fast",
          permissionMode: "full",
          title: "TASK-1 · Implement delegation",
          prompt: expect.stringContaining(
            "Run the focused tests before reporting back.",
          ),
          origin: "plugin",
          originPluginId: "tasks",
        }),
      ],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        threadId: "thr_delegated",
        presetName: "Test worker",
        title: "TASK-1 · Implement delegation",
        liveStatus: "starting",
      }),
    ]);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
    expect(store.tasks.listComments(task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Status changed to In Progress · dispatched to Test worker",
        }),
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Dispatched to Test worker",
        }),
      ]),
    );
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
      { channel: "comments:changed", payload: { taskId: task.id } },
    ]);

    await harness.dispose();
  });

  it("corrects the attached row when a delegated thread becomes active immediately", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_fast" }),
          get: async () =>
            makeThreadResponse({ id: "thr_fast", status: "active" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Fast delegation",
      prefix: "FAST",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Transition during spawn",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_fast" }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_fast",
        liveStatus: "working",
      }),
    ]);

    await harness.dispose();
  });

  it("bounds delegated thread titles by display width", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_wide_title" }),
          get: async () =>
            makeThreadResponse({ id: "thr_wide_title", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Tasks plugin",
      prefix: "TASK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "调".repeat(100),
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    const title = `TASK-1 · ${"调".repeat(55)}`;
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [expect.objectContaining({ title })],
    ]);

    await harness.dispose();
  });

  it("spawns a new worktree from the configured branch on the configured machine", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_worktree" }),
          get: async () =>
            makeThreadResponse({ id: "thr_worktree", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Worktree delegation",
      prefix: "WT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use a fresh checkout",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "release/next",
      machineId: "host_remote",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_remote",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "release/next" },
            },
          },
        }),
      ],
    ]);
    expect(harness.sdk.callsTo("system.config")).toEqual([]);

    await harness.dispose();
  });

  it("resolves the default machine and default branch for a worktree preset", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host_primary" }),
        },
        threads: {
          spawn: async () => ({ id: "thr_default_worktree" }),
          get: async () =>
            makeThreadResponse({
              id: "thr_default_worktree",
              status: "starting",
            }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Default worktree target",
      prefix: "DWT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use default worktree target",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("system.config")).toEqual([[]]);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_primary",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("maps a rejected worktree target to a friendly typed delegation error", async () => {
    const spawnError = Object.assign(new Error("HTTP 404: Host not found"), {
      code: "host_not_found",
      status: 404,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => {
            throw spawnError;
          },
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Invalid target",
      prefix: "BAD",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Reject bad machine",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "missing-branch",
      machineId: "host_missing",
    });

    await expect(
      harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message:
        "Could not create a worktree on host_missing from missing-branch: Host not found",
    });

    await harness.dispose();
  });

  it("self-attaches an existing thread through taskThreadsAttach", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_existing",
            title: "𠮷".repeat(100),
            titleFallback: null,
            status: "active",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach current worker",
    });
    registerDelegation(bb, store);

    await expect(
      harness.callRpc("taskThreadsAttach", {
        taskId: task.id,
        threadId: "thr_existing",
      }),
    ).resolves.toEqual({ threadId: "thr_existing", isMain: false });
    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_existing" }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_existing",
        presetName: "Attached",
        title: "𠮷".repeat(60),
        liveStatus: "working",
      }),
    ]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await harness.dispose();
  });
});

describe("task thread detach", () => {
  it("detaches an attached thread through taskThreadsDetach and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: threadId === "thr_dead" ? "error" : "idle",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Respawned work",
    });
    const otherTask = store.tasks.createTask({
      projectId: project.id,
      title: "Other work",
    });
    registerDelegation(bb, store);

    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_dead",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_live",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: otherTask.id,
      threadId: "thr_dead",
    });
    harness.realtimeSignals.length = 0;

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).resolves.toEqual({ threadId: "thr_dead", wasMain: false });

    expect(
      store.tasks.listTaskThreads(task.id).map((thread) => thread.threadId),
    ).toEqual(["thr_live"]);
    expect(
      store.tasks
        .listTaskThreads(otherTask.id)
        .map((thread) => thread.threadId),
    ).toEqual(["thr_dead"]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).rejects.toThrow(`Thread thr_dead is not attached to ${task.key}`);

    await harness.dispose();
  });
});

function mainThreadFixture(spawnDelayMs: (call: number) => number = () => 0) {
  let spawned = 0;
  const host = createFakePluginHost({
    pluginId: "tasks",
    sdk: {
      threads: {
        spawn: async () => {
          const call = ++spawned;
          await new Promise((resolve) =>
            setTimeout(resolve, spawnDelayMs(call)),
          );
          return { id: `thr_dispatch${call}` };
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, status: "idle" }),
      },
    },
  });
  const store = createStore(host.bb);
  const project = store.tasks.createProject({
    name: "Main",
    prefix: "MAIN",
    color: "blue",
    linkedBbProjectId: "proj_bb",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Find the manager",
  });
  registerDelegation(host.bb, store);
  const preset = createTestPreset(store);
  const mainThreadIds = () =>
    store.tasks
      .listTaskThreads(task.id)
      .filter((thread) => thread.isMain)
      .map((thread) => thread.threadId);
  return { ...host, store, task, preset, mainThreadIds };
}

describe("task main thread", () => {
  it("marks only the first dispatch to a task without threads as main", async () => {
    const { harness, store, task, preset, mainThreadIds } = mainThreadFixture();

    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });
    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });

    expect(
      store.tasks.listTaskThreads(task.id).map((thread) => ({
        threadId: thread.threadId,
        isMain: thread.isMain,
      })),
    ).toEqual([
      { threadId: "thr_dispatch1", isMain: true },
      { threadId: "thr_dispatch2", isMain: false },
    ]);
    expect(mainThreadIds()).toEqual(["thr_dispatch1"]);

    await harness.dispose();
  });

  it("leaves a dispatch unmarked when the task already has attached threads", async () => {
    const { harness, task, preset, mainThreadIds } = mainThreadFixture();
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_legacy",
    });

    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });

    expect(mainThreadIds()).toEqual([]);

    await harness.dispose();
  });

  it("marks the thread attached first when two dispatches race", async () => {
    const { harness, task, preset, mainThreadIds } = mainThreadFixture(
      (call) => (call === 1 ? 20 : 0),
    );

    await Promise.all([
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
    ]);

    expect(mainThreadIds()).toEqual(["thr_dispatch2"]);

    await harness.dispose();
  });

  it("reassigns, clears, and refuses unattached main threads without touching attachment data", async () => {
    const { harness, store, task, mainThreadIds } = mainThreadFixture();
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_first",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_second",
    });
    const attachedBefore = store.tasks
      .listTaskThreads(task.id)
      .map(({ threadId, presetName, title, liveStatus, attachedAt }) => ({
        threadId,
        presetName,
        title,
        liveStatus,
        attachedAt,
      }));
    harness.realtimeSignals.length = 0;

    await expect(
      harness.callRpc("taskThreadsSetMain", {
        taskId: task.id,
        threadId: "thr_first",
      }),
    ).resolves.toEqual({ mainThreadId: "thr_first" });
    await harness.callRpc("taskThreadsSetMain", {
      taskId: task.id,
      threadId: "thr_second",
    });
    expect(mainThreadIds()).toEqual(["thr_second"]);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "threads:changed",
      payload: { taskId: task.id },
    });

    await expect(
      harness.callRpc("taskThreadsSetMain", {
        taskId: task.id,
        threadId: "thr_stranger",
      }),
    ).rejects.toThrow(`Thread thr_stranger is not attached to ${task.key}`);
    expect(mainThreadIds()).toEqual(["thr_second"]);

    await expect(
      harness.callRpc("taskThreadsSetMain", {
        taskId: task.id,
        threadId: null,
      }),
    ).resolves.toEqual({ mainThreadId: null });
    expect(mainThreadIds()).toEqual([]);
    expect(
      store.tasks
        .listTaskThreads(task.id)
        .map(({ threadId, presetName, title, liveStatus, attachedAt }) => ({
          threadId,
          presetName,
          title,
          liveStatus,
          attachedAt,
        })),
    ).toEqual(attachedBefore);

    await harness.dispose();
  });

  it("attaches as main on request and leaves plain attaches unmarked", async () => {
    const { harness, task, mainThreadIds } = mainThreadFixture();
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_worker",
    });
    expect(mainThreadIds()).toEqual([]);

    await expect(
      harness.callRpc("taskThreadsAttach", {
        taskId: task.id,
        threadId: "thr_replacement",
        main: true,
      }),
    ).resolves.toEqual({ threadId: "thr_replacement", isMain: true });
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_replacement",
    });

    expect(mainThreadIds()).toEqual(["thr_replacement"]);

    await harness.dispose();
  });

  it("detaching the main thread leaves the task without a main thread", async () => {
    const { harness, task, preset, mainThreadIds } = mainThreadFixture();
    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });
    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dispatch1",
      }),
    ).resolves.toEqual({ threadId: "thr_dispatch1", wasMain: true });

    expect(mainThreadIds()).toEqual([]);

    await harness.dispose();
  });
});

describe("delegation seed prompt", () => {
  it("captures task context and the complete report-back contract", () => {
    const project: Project = {
      id: "01J00000000000000000000001",
      name: "Tasks plugin",
      prefix: "TASK",
      nextTaskNumber: 4,
      color: "blue",
      folderId: null,
      linkedBbProjectId: "proj_tasks",
      createdAt: "2026-07-15T17:00:00.000Z",
    };
    const task: Task = {
      id: "01J00000000000000000000002",
      projectId: project.id,
      number: 1,
      key: "TASK-1",
      title: "Delegate work",
      description:
        "Implement **preset-driven** delegation.\n\nKeep the prompt useful.",
      status: "todo",
      priority: "high",
      dueDate: null,
      parentTaskId: null,
      position: 1_024,
      createdAt: "2026-07-15T17:01:00.000Z",
      updatedAt: "2026-07-15T17:01:00.000Z",
    };
    const subtask: Task = {
      ...task,
      id: "01J00000000000000000000003",
      number: 2,
      key: "TASK-2",
      title: "Add focused tests",
      status: "in_progress",
      parentTaskId: task.id,
    };
    const comments: Comment[] = [
      {
        id: "01J00000000000000000000004",
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        presetName: null,
        threadId: null,
        body: "Preserve the existing domain path.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:02:00.000Z",
      },
      {
        id: "01J00000000000000000000005",
        taskId: task.id,
        kind: "agent",
        authorName: "Worker",
        presetName: "Sonnet · high",
        threadId: "thr_prior",
        body: "The schema study is complete.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:03:00.000Z",
      },
    ];

    expect(
      buildSeedPrompt({
        task,
        project,
        subtasks: [subtask],
        attachments: [
          {
            id: "01J00000000000000000000006",
            fileName: "delegation-notes.md",
          },
        ],
        recentComments: comments,
        presetInstructions: "Prefer focused changes.",
        extraInstructions: "Run the backend gates.",
      }),
    ).toMatchInlineSnapshot(`
      "# TASK-1 · Delegate work

      ## Description

      Implement **preset-driven** delegation.

      Keep the prompt useful.

      ## Project context

      - Name: Tasks plugin
      - Linked bb project: proj_tasks

      ## Sub-tasks

      - TASK-2 · Add focused tests (in_progress)

      ## Attachments

      - delegation-notes.md · 01J00000000000000000000006
        Fetch with: bb tasks attachment get 01J00000000000000000000006 --out <path>

      ## Recent comments

      ### Sawyer · user · 2026-07-15T17:02:00.000Z

      Preserve the existing domain path.

      ### Worker · agent · 2026-07-15T17:03:00.000Z

      The schema study is complete.

      ## Report-back contract

      You are working on task TASK-1. Use the bb tasks CLI: comment substantive updates (bb tasks comment TASK-1 --body ...), attach result artifacts, set status when done (bb tasks update TASK-1 --status in_review) or explain blockage in a comment. Your thread is already attached to the task.

      ## Preset instructions

      Prefer focused changes.

      ## Additional instructions

      Run the backend gates.
      "
    `);
  });
});
