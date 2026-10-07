// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const THREAD_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const OFFLINE_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the PR pill",
  position: 1,
});

function taskThreadRow(id: string, threadId: string, title: string) {
  return {
    id,
    taskId: TASK_ID,
    threadId,
    presetName: "Attached",
    title,
    liveStatus: "working",
    isMain: false,
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function detailRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
          color: "blue",
          folderId: null,
          linkedBbProjectId: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    listTasks: (input: unknown) =>
      input !== null && rpcInput(input).parentTaskId
        ? { tasks: [] }
        : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({
      taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
    }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

describe("task detail pull request pills", () => {
  it("links a thread's pull request as a keyboard-reachable anchor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        openUrl: () => true,
        rpc: detailRpc({
          listTaskPullRequests: () => ({
            pullRequests: [
              {
                url: "https://github.com/acme/bb/pull/12",
                number: 12,
                title: "Ship the PR pill",
                state: "merged",
                updatedAt: "2026-07-16T10:00:00.000Z",
                threadIds: ["thr_worker000"],
              },
            ],
            unavailableThreadIds: [],
          }),
        }),
      },
    );

    const link = (await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Merged)",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/bb/pull/12");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(link.textContent).toContain("#12");
    fireEvent.click(link);
    expect(slot.navigateCalls).toEqual([]);
  });

  it("marks threads whose PR lookup failed and stays quiet otherwise", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_offline00", "Offline worker"),
            ],
          }),
          listTaskPullRequests: () => ({
            pullRequests: [],
            unavailableThreadIds: ["thr_offline00"],
          }),
        }),
      },
    );

    await slot.findByText("Offline worker");
    expect(slot.getAllByText("PR unavailable")).toHaveLength(1);
    expect(slot.queryByRole("link")).toBeNull();
  });

  it("detaches a thread from its card after confirmation and refetches the list", async () => {
    let detached = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: detached
              ? []
              : [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
          taskThreadsDetach: (input: unknown) => {
            detached = true;
            return { threadId: rpcInput(input).threadId };
          },
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    fireEvent.click(await slot.findByRole("button", { name: "Detach" }));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsDetach",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      });
    });
    await waitFor(() => expect(slot.queryByText("Worker")).toBeNull());
  });

  it("revalidates PR state on window focus without a task-thread mutation", async () => {
    const basePullRequest = {
      url: "https://github.com/acme/bb/pull/12",
      number: 12,
      title: "Ship the PR pill",
      updatedAt: "2026-07-16T10:00:00.000Z",
      threadIds: ["thr_worker000"],
    };
    let lookupCount = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskPullRequests: () => {
            lookupCount += 1;
            return {
              pullRequests: [
                {
                  ...basePullRequest,
                  state: lookupCount === 1 ? "open" : "merged",
                },
              ],
              unavailableThreadIds: [],
            };
          },
        }),
      },
    );

    await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Open)",
    });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(
        slot.getByRole("link", {
          name: "Pull request #12: Ship the PR pill (Merged)",
        }),
      ).toBeTruthy();
    });
  });
});

function sidebarThread(
  overrides: Pick<PluginSidebarThread, "id" | "displayTitle" | "href"> &
    Partial<PluginSidebarThread>,
): PluginSidebarThread {
  return {
    projectId: "proj_bb0000000000000000000001",
    title: overrides.displayTitle,
    titleFallback: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    status: "active",
    runtimeStatus: "active",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    isHidden: false,
    environment: null,
    host: null,
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

describe("task detail thread cards", () => {
  it("links Open thread to the live thread and shows its current title", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(),
        sidebarThreads: {
          threads: [
            sidebarThread({
              id: "thr_worker000",
              displayTitle: "Cr-5 · Renamed worker",
              href: "/projects/proj_bb0000000000000000000001/threads/thr_worker000",
            }),
          ],
        },
      },
    );

    const link = await slot.findByRole("link", {
      name: "Open thread: Cr-5 · Renamed worker",
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/proj_bb0000000000000000000001/threads/thr_worker000",
    );
    expect(slot.queryByText("Worker")).toBeNull();
    expect(
      slot.getByRole("button", { name: "Detach Cr-5 · Renamed worker" }),
    ).toBeTruthy();
  });

  it("opens threads missing from the live list by id and keeps their stored title", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc() },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Open thread: Worker" }),
    );
    expect(slot.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_worker000" },
    ]);
  });

  it("names manual attachments once and keeps the preset for dispatched threads", async () => {
    const attachedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              {
                ...taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
                attachedAt,
              },
              {
                ...taskThreadRow(OFFLINE_ROW_ID, "thr_manager0", "Manager"),
                presetName: "Akakiy Kurolesov · Chief Coordinator",
                attachedAt,
              },
            ],
          }),
        }),
      },
    );

    expect(await slot.findByText("Attached 6m ago")).toBeTruthy();
    expect(
      slot.getByText("Akakiy Kurolesov · Chief Coordinator · attached 6m ago"),
    ).toBeTruthy();
  });
});

const MANAGER_HREF =
  "/projects/proj_bb0000000000000000000001/threads/thr_manager0";
const WORKER_HREF =
  "/projects/proj_bb0000000000000000000001/threads/thr_worker000";

function managerRow(isMain: boolean) {
  return {
    ...taskThreadRow(OFFLINE_ROW_ID, "thr_manager0", "Manager (stored)"),
    isMain,
  };
}

function workerRow() {
  return taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker");
}

function renderDetail(
  taskThreads: () => unknown[],
  options: Omit<NonNullable<Parameters<typeof renderSlot>[2]>, "rpc"> & {
    rpc?: Record<string, unknown>;
  } = {},
) {
  const { rpc, ...rest } = options;
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "task/TSK-5" },
    {
      ...rest,
      rpc: detailRpc({
        listTaskThreads: () => ({ taskThreads: taskThreads() }),
        ...rpc,
      }),
    },
  );
}

describe("task thread shortcut row", () => {
  it("offers no shortcut when no thread is attached", async () => {
    const slot = renderDetail(() => []);

    await slot.findByRole("textbox", { name: "Task title" });
    expect(slot.queryByText("Main thread")).toBeNull();
    expect(slot.queryByText("Thread")).toBeNull();
    expect(slot.queryByRole("button", { name: /^Threads/ })).toBeNull();
  });

  it("links a single unmarked thread without calling it main", async () => {
    const slot = renderDetail(() => [workerRow()], {
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_worker000",
            displayTitle: "Live worker",
            href: WORKER_HREF,
          }),
        ],
      },
    });

    const link = await slot.findByRole("link", {
      name: "Open thread: Live worker, working",
    });
    expect(link.getAttribute("href")).toBe(WORKER_HREF);
    expect(slot.queryByText("Main thread")).toBeNull();
  });

  it("lists several unmarked threads in a neutral chooser whose items open by id", async () => {
    const slot = renderDetail(() => [managerRow(false), workerRow()], {
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_worker000",
            displayTitle: "Worker",
            href: WORKER_HREF,
          }),
        ],
      },
    });

    const trigger = await slot.findByRole("button", { name: "Threads (2)" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    const items = await slot.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Manager (stored)",
      "Worker",
    ]);
    expect(
      items.filter(
        (item) => item.tagName === "A" || item.querySelector("a, button"),
      ),
    ).toEqual([]);
    expect(slot.queryByText("Main thread")).toBeNull();
    fireEvent.click(items[1]!);
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_worker000",
    });
  });

  it("links the stored main thread by its live title and jumps to the other threads", async () => {
    const slot = renderDetail(() => [managerRow(true), workerRow()], {
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_manager0",
            displayTitle: "Cr-10 · Live manager",
            href: MANAGER_HREF,
          }),
        ],
      },
    });

    const link = await slot.findByRole("link", {
      name: "Open main thread: Cr-10 · Live manager, working",
    });
    expect(link.getAttribute("href")).toBe(MANAGER_HREF);

    fireEvent.click(slot.getByRole("button", { name: "+1 thread" }));
    expect(document.activeElement).toBe(
      slot.getByRole("region", { name: "Agent threads" }),
    );
    expect(
      slot.getByRole("button", { name: "Make Worker the main thread" }),
    ).toBeTruthy();
    expect(
      slot.queryByRole("button", {
        name: "Make Cr-10 · Live manager the main thread",
      }),
    ).toBeNull();
  });

  it("keeps an archived main thread labelled and never promotes its released child", async () => {
    const slot = renderDetail(() => [managerRow(true), workerRow()], {
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_worker000",
            displayTitle: "Released worker",
            href: WORKER_HREF,
            parentThreadId: null,
          }),
        ],
      },
      sdk: {
        threads: {
          get: async () =>
            makeThreadResponse({
              id: "thr_manager0",
              title: "Archived manager",
              archivedAt: Date.now(),
            }),
        },
      },
    });

    const opener = await slot.findByRole("button", {
      name: "Open main thread: Archived manager, working, archived",
    });
    fireEvent.click(opener);
    expect(slot.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_manager0",
    });
    expect(
      slot.getByRole("button", {
        name: "Make Released worker the main thread",
      }),
    ).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Detach Archived manager" }),
    ).toBeTruthy();
    expect(slot.queryByText("Manager (stored)")).toBeNull();
  });

  it("re-resolves a completed archived main when Refresh follows its deletion", async () => {
    let deleted = false;
    let lookups = 0;
    const slot = renderDetail(
      () => [{ ...managerRow(true), liveStatus: "completed" }],
      {
        sdk: {
          threads: {
            get: async () => {
              lookups += 1;
              if (deleted) throw new Error("thread_not_found");
              return makeThreadResponse({
                id: "thr_manager0",
                title: "Archived manager",
                archivedAt: Date.now(),
              });
            },
          },
        },
      },
    );
    await slot.findByRole("button", {
      name: /^Open main thread: Archived manager/,
    });

    deleted = true;
    fireEvent.click(slot.getByRole("button", { name: "Refresh tasks" }));

    expect(await slot.findByText("Main thread unavailable")).toBeTruthy();
    expect(
      slot.queryByRole("button", { name: /^Open main thread/ }),
    ).toBeNull();
    expect(lookups).toBe(2);
  });

  it("recovers a main whose lookup failed once a threads signal arrives", async () => {
    let failing = true;
    const slot = renderDetail(() => [managerRow(true)], {
      sdk: {
        threads: {
          get: async () => {
            if (failing) throw new Error("network down");
            return makeThreadResponse({
              id: "thr_manager0",
              title: "Archived manager",
              archivedAt: Date.now(),
            });
          },
        },
      },
    });
    expect(await slot.findByText("Main thread unavailable")).toBeTruthy();

    failing = false;
    await slot.emitRealtime("threads:changed", { taskId: TASK_ID });

    expect(
      await slot.findByRole("button", {
        name: "Open main thread: Archived manager, working, archived",
      }),
    ).toBeTruthy();
    expect(slot.queryByText("Main thread unavailable")).toBeNull();
  });

  it("names the current thread when it is the only unmarked attachment", async () => {
    const slot = renderDetail(() => [workerRow()], {
      context: {
        projectId: "proj_bb0000000000000000000001",
        threadId: "thr_worker000",
      },
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_worker000",
            displayTitle: "Live worker",
            href: WORKER_HREF,
          }),
        ],
      },
    });

    expect(await slot.findAllByText("This thread")).toHaveLength(2);
    expect(slot.queryByRole("link", { name: /^Open thread/ })).toBeNull();
  });

  it("shows an unavailable main thread with its last known title and no link", async () => {
    const slot = renderDetail(() => [managerRow(true)], {
      sdk: {
        threads: {
          get: async () => {
            throw new Error("thread_not_found");
          },
        },
      },
    });

    expect(await slot.findByText("Main thread unavailable")).toBeTruthy();
    expect(slot.getByText("last known: Manager (stored)")).toBeTruthy();
    expect(slot.queryByRole("link", { name: /^Open main thread/ })).toBeNull();
    expect(
      slot.queryByRole("button", { name: /^Open main thread/ }),
    ).toBeNull();
    expect(slot.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(
      slot.queryByRole("button", { name: "Open thread: Manager (stored)" }),
    ).toBeNull();
    expect(
      slot.getByRole("button", { name: "Detach Manager (stored)" }),
    ).toBeTruthy();
  });

  it("keeps the main card's opener while the live thread list is still loading", async () => {
    const slot = renderDetail(() => [managerRow(true)], {
      sidebarThreads: { status: "loading" },
    });

    expect(
      await slot.findByRole("button", {
        name: "Open thread: Manager (stored)",
      }),
    ).toBeTruthy();
    expect(slot.queryByText("Main thread unavailable")).toBeNull();
    expect(slot.queryByText("Unavailable")).toBeNull();
    expect(slot.inspection.sdkCalls).toEqual([]);
  });

  it("marks a hidden main thread", async () => {
    const slot = renderDetail(() => [managerRow(true)], {
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_manager0",
            displayTitle: "Hidden manager",
            href: MANAGER_HREF,
            isHidden: true,
          }),
        ],
      },
    });

    expect(
      await slot.findByRole("link", {
        name: "Open main thread: Hidden manager, working, hidden",
      }),
    ).toBeTruthy();
  });

  it("names the current thread instead of linking to itself", async () => {
    const slot = renderDetail(() => [managerRow(true)], {
      context: {
        projectId: "proj_bb0000000000000000000001",
        threadId: "thr_manager0",
      },
      sidebarThreads: {
        threads: [
          sidebarThread({
            id: "thr_manager0",
            displayTitle: "Cr-10 · Live manager",
            href: MANAGER_HREF,
          }),
        ],
      },
    });

    expect(await slot.findAllByText("This thread")).toHaveLength(2);
    expect(slot.queryByRole("link", { name: /^Open main thread/ })).toBeNull();
    expect(
      slot.queryByRole("link", { name: "Open thread: Cr-10 · Live manager" }),
    ).toBeNull();
  });

  it("ignores a late lookup for a thread that is no longer main", async () => {
    let mainIsManager = true;
    let resolveLookup: (
      value: ReturnType<typeof makeThreadResponse>,
    ) => void = () => {};
    const slot = renderDetail(
      () =>
        mainIsManager
          ? [managerRow(true), workerRow()]
          : [managerRow(false), { ...workerRow(), isMain: true }],
      {
        sidebarThreads: {
          threads: [
            sidebarThread({
              id: "thr_worker000",
              displayTitle: "Live worker",
              href: WORKER_HREF,
            }),
          ],
        },
        sdk: {
          threads: {
            get: () =>
              new Promise((resolve) => {
                resolveLookup = resolve;
              }),
          },
        },
      },
    );
    await slot.findByRole("link", { name: /^Open thread: Live worker/ });

    mainIsManager = false;
    await slot.emitRealtime("threads:changed", { taskId: TASK_ID });
    await slot.findByRole("link", {
      name: "Open main thread: Live worker, working",
    });
    resolveLookup(
      makeThreadResponse({
        id: "thr_manager0",
        title: "Stale manager",
        archivedAt: Date.now(),
      }),
    );

    await waitFor(() =>
      expect(
        slot.getByRole("link", {
          name: "Open main thread: Live worker, working",
        }),
      ).toBeTruthy(),
    );
    expect(slot.queryByText("Stale manager")).toBeNull();
    expect(slot.queryByText("Archived")).toBeNull();
  });

  const liveManagerAndWorker = {
    threads: [
      sidebarThread({
        id: "thr_manager0",
        displayTitle: "Manager",
        href: MANAGER_HREF,
      }),
      sidebarThread({
        id: "thr_worker000",
        displayTitle: "Worker",
        href: WORKER_HREF,
      }),
    ],
  };

  it("makes a thread main from its card and moves focus to the new main card", async () => {
    let mainIsWorker = false;
    const slot = renderDetail(
      () =>
        mainIsWorker
          ? [{ ...workerRow(), isMain: true }, managerRow(false)]
          : [managerRow(true), workerRow()],
      {
        sidebarThreads: liveManagerAndWorker,
        rpc: {
          taskThreadsSetMain: (input: unknown) => {
            mainIsWorker = true;
            return { mainThreadId: rpcInput(input).threadId };
          },
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Make Worker the main thread" }),
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        slot.getByRole("link", { name: "Open thread: Worker" }),
      ),
    );
    expect(slot.rpcCalls).toContainEqual({
      method: "taskThreadsSetMain",
      input: { taskId: TASK_ID, threadId: "thr_worker000" },
    });
    expect(slot.getByText("Worker is now the main thread")).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Make Manager the main thread" }),
    ).toBeTruthy();
  });

  it("keeps the Make main focus request through a refresh that still shows the old main", async () => {
    let mainIsWorker = false;
    let acknowledge = () => {};
    const slot = renderDetail(
      () =>
        mainIsWorker
          ? [{ ...workerRow(), isMain: true }, managerRow(false)]
          : [managerRow(true), workerRow()],
      {
        sidebarThreads: liveManagerAndWorker,
        rpc: {
          taskThreadsSetMain: (input: unknown) =>
            new Promise((resolve) => {
              acknowledge = () => {
                mainIsWorker = true;
                resolve({ mainThreadId: rpcInput(input).threadId });
              };
            }),
        },
      },
    );
    const listCalls = () =>
      slot.rpcCalls.filter((call) => call.method === "listTaskThreads").length;

    fireEvent.click(
      await slot.findByRole("button", { name: "Make Worker the main thread" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsSetMain",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      }),
    );
    const before = listCalls();
    await slot.emitRealtime("threads:changed", { taskId: TASK_ID });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    await act(async () => acknowledge());

    await waitFor(() =>
      expect(document.activeElement).toBe(
        slot.getByRole("link", { name: "Open thread: Worker" }),
      ),
    );
  });

  it("leaves focus alone after a failed Make main or a background refresh", async () => {
    const slot = renderDetail(() => [managerRow(true), workerRow()], {
      sidebarThreads: liveManagerAndWorker,
      rpc: {
        taskThreadsSetMain: () => {
          throw new Error("set main failed");
        },
      },
    });
    const title = await slot.findByRole("textbox", { name: "Task title" });
    title.focus();

    fireEvent.click(
      await slot.findByRole("button", { name: "Make Worker the main thread" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsSetMain",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      }),
    );
    await slot.emitRealtime("threads:changed", { taskId: TASK_ID });
    await waitFor(() =>
      expect(
        slot.rpcCalls.filter((call) => call.method === "listTaskThreads")
          .length,
      ).toBeGreaterThan(1),
    );

    expect(document.activeElement).toBe(title);
    expect(slot.queryByText("Worker is now the main thread")).toBeNull();
  });

  it("warns that detaching the main thread leaves the task without one", async () => {
    const slot = renderDetail(() => [managerRow(true), workerRow()]);

    fireEvent.click(
      await slot.findByRole("button", { name: "Detach Manager (stored)" }),
    );

    expect(
      await slot.findByText(
        /This is the task's main thread\. After you detach it, the task has no main thread until you choose one\./,
      ),
    ).toBeTruthy();
  });
});
