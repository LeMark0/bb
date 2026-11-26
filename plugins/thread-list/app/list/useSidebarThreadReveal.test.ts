import { describe, expect, it } from "vitest";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  type SidebarThreadOverrides,
} from "../model/fixtures.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { sectionKeyForThreadSection } from "../model/section-keys.js";
import { CHRONOLOGICAL_CONTAINER_ID } from "../model/project-thread-groups.js";
import {
  INITIAL_SIDEBAR_THREAD_REVEAL_STATE,
  resolveThreadRevealExpansion,
  stepSidebarThreadReveal,
} from "./useSidebarThreadReveal.js";

function thread(id: string, overrides: SidebarThreadOverrides = {}) {
  return makeSidebarThread({
    id,
    projectId: "proj_personal",
    sectionId: id,
    lastReadAt: 1,
    latestAttentionAt: 1,
    ...overrides,
  });
}

interface RevealInputs {
  selectedThreadId: string | undefined;
  threads: SidebarThread[];
  threadsReady: boolean;
  preferencesReady: boolean;
}

function startReveal(
  initial: Partial<RevealInputs> & { threads: SidebarThread[] },
) {
  let state = INITIAL_SIDEBAR_THREAD_REVEAL_STATE;
  const current: RevealInputs = {
    selectedThreadId: "first",
    threadsReady: true,
    preferencesReady: true,
    ...initial,
  };
  const reveal = (next: Partial<RevealInputs> = {}) => {
    Object.assign(current, next);
    const step = stepSidebarThreadReveal(state, {
      ...current,
      threadById: new Map(current.threads.map((item) => [item.id, item])),
    });
    state = step.state;
    return [...step.revealIds];
  };
  return { initial: reveal(), reveal };
}

describe("useSidebarThreadReveal", () => {
  it("requires leaving and returning before revealing the open thread again", () => {
    const { initial, reveal } = startReveal({
      threads: [thread("first"), thread("second")],
    });
    expect(initial).toEqual(["first"]);

    expect(
      reveal({
        threads: [
          thread("first", { title: "Updated", latestAttentionAt: 2 }),
          thread("second"),
        ],
      }),
    ).toEqual([]);

    expect(reveal({ selectedThreadId: undefined })).toEqual([]);
    expect(reveal({ selectedThreadId: "first" })).toEqual(["first"]);
  });

  it("reveals only newly unread non-open threads", () => {
    const { reveal } = startReveal({
      threads: [thread("first"), thread("second"), thread("third")],
    });
    expect(
      reveal({
        threads: [
          thread("first", { latestAttentionAt: 2 }),
          thread("second", { latestAttentionAt: 2 }),
          thread("third"),
        ],
      }),
    ).toEqual(["second"]);

    expect(
      reveal({
        threads: [
          thread("first", { latestAttentionAt: 2 }),
          thread("second", { latestAttentionAt: 3 }),
          thread("third"),
        ],
      }),
    ).toEqual([]);

    expect(
      reveal({
        threads: [
          thread("first"),
          thread("second", { lastReadAt: 3, latestAttentionAt: 3 }),
          thread("third"),
        ],
      }),
    ).toEqual([]);
    expect(
      reveal({
        threads: [
          thread("first"),
          thread("second", { lastReadAt: 3, latestAttentionAt: 4 }),
          thread("third"),
        ],
      }),
    ).toEqual(["second"]);
  });

  it("keeps initially unread threads collapsed and ignores hidden unread threads", () => {
    const { initial, reveal } = startReveal({
      threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
    });
    expect(initial).toEqual(["first"]);
    expect(
      reveal({
        threads: [
          thread("first"),
          thread("second", { latestAttentionAt: 2 }),
          thread("third", { latestAttentionAt: 2, isHidden: true }),
        ],
      }),
    ).toEqual([]);
  });

  it("waits for the threads to be ready before establishing the unread baseline", () => {
    const { initial, reveal } = startReveal({
      threads: [thread("first")],
      threadsReady: false,
    });
    expect(initial).toEqual([]);

    expect(
      reveal({
        threadsReady: true,
        threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
      }),
    ).toEqual(["first"]);

    expect(reveal({ threads: [thread("first"), thread("second")] })).toEqual(
      [],
    );
    expect(
      reveal({
        threads: [thread("first"), thread("second", { latestAttentionAt: 2 })],
      }),
    ).toEqual(["second"]);
  });

  it("waits for preferences and the destination thread before revealing navigation", () => {
    const { initial, reveal } = startReveal({
      threads: [],
      preferencesReady: false,
    });
    expect(initial).toEqual([]);
    expect(reveal({ preferencesReady: true })).toEqual([]);
    expect(reveal({ threads: [thread("first")] })).toEqual(["first"]);
  });

  it("reveals the pinned ancestors and environment of a newly unread child", () => {
    const parent = thread("parent", {
      pinnedAt: 1,
      environment: makeSidebarEnvironment({ id: "env_parent" }),
    });
    const child = thread("child", {
      parentThreadId: "parent",
      environment: makeSidebarEnvironment({ id: "env_child" }),
      latestAttentionAt: 2,
    });
    const threads = [thread("first"), parent, child];

    const { threadIdsToExpand, environmentIdsToExpand, expansion } =
      resolveThreadRevealExpansion({
        thread: child,
        threadById: new Map(threads.map((item) => [item.id, item])),
        effectivePinnedThreadIds: buildPinnedSidebarState({ threads })
          .effectivePinnedThreadIds,
        organizationMode: "chronological",
        personalProjectId: "proj_personal",
      });

    expect([...threadIdsToExpand]).toEqual(["parent"]);
    expect([...environmentIdsToExpand].sort()).toEqual([
      "env_child",
      "env_parent",
    ]);
    expect(expansion).toEqual({ sidebarSectionId: "pinned" });
  });

  it("reveals the custom section and machine where a nested hidden child renders", () => {
    const parent = thread("parent", {
      sectionId: "section-a",
      host: { id: "host_a", name: "Laptop" },
    });
    const child = thread("hidden_child", {
      parentThreadId: "parent",
      sectionId: null,
      isHidden: true,
      host: { id: "host_b", name: "Desktop" },
    });
    const threadById = new Map([parent, child].map((item) => [item.id, item]));
    const reveal = (organizationMode: "chronological" | "machine") =>
      resolveThreadRevealExpansion({
        thread: child,
        threadById,
        effectivePinnedThreadIds: new Set(),
        organizationMode,
        personalProjectId: "proj_personal",
      });

    expect([...reveal("chronological").threadIdsToExpand]).toEqual(["parent"]);
    expect(reveal("chronological").expansion).toEqual({
      sectionKey: sectionKeyForThreadSection(
        CHRONOLOGICAL_CONTAINER_ID,
        "section-a",
      ),
    });
    expect(reveal("machine").expansion).toEqual({ machineKey: "host_a" });
  });
});
