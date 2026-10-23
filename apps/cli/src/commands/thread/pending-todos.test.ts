import { describe, expect, it, vi } from "vitest";
import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import {
  createNodeBbSdk,
  type BbSdk,
  type FetchImplementation,
} from "@bb/sdk/node";

import { fetchThreadPendingTodos, printPendingTodos } from "./pending-todos.js";

function captureLogLines(fn: () => void): { lines: string[] } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    const lines: string[] = [];
    for (const call of spy.mock.calls) {
      lines.push(String(call[0] ?? ""));
    }
    return { lines };
  } finally {
    spy.mockRestore();
  }
}

function todo(
  id: string,
  text: string,
  status: ThreadTimelinePendingTodoItemStatus,
  position: number,
  after: number[] = [],
): ThreadTimelinePendingTodoItem {
  return { id, text, status, position, after };
}

describe("printPendingTodos", () => {
  it("prints nothing when pendingTodos is null", () => {
    const { lines } = captureLogLines(() => printPendingTodos(null));
    expect(lines).toEqual([]);
  });

  it("prints nothing when items is empty (observed-empty snapshot)", () => {
    const snapshot: ThreadTimelinePendingTodos = {
      sourceSeq: 1,
      updatedAt: 1,
      order: "dependencies-not-provided",
      items: [],
    };
    const { lines } = captureLogLines(() => printPendingTodos(snapshot));
    expect(lines).toEqual([]);
  });

  it("renders count-only heading when no items are completed", () => {
    const snapshot: ThreadTimelinePendingTodos = {
      sourceSeq: 1,
      updatedAt: 1,
      order: "dependencies-not-provided",
      items: [
        todo("a", "Investigate bug", "in_progress", 1),
        todo("b", "Write fix", "pending", 2),
        todo("c", "Add regression test", "pending", 3),
      ],
    };
    const { lines } = captureLogLines(() => printPendingTodos(snapshot));
    expect(lines).toEqual([
      "",
      "TODOs (3):",
      "  Agent's order. Dependencies not provided.",
      "  [>] Investigate bug",
      "  [ ] Write fix",
      "  [ ] Add regression test",
    ]);
  });

  it("keeps the agent's order when statuses differ and says dependencies were not provided", () => {
    const snapshot: ThreadTimelinePendingTodos = {
      sourceSeq: 1,
      updatedAt: 1,
      order: "dependencies-not-provided",
      items: [
        todo("a", "First done", "completed", 1),
        todo("b", "Active work", "in_progress", 2),
        todo("c", "Queued work", "pending", 3),
        todo("d", "Second done", "completed", 4),
      ],
    };
    const { lines } = captureLogLines(() => printPendingTodos(snapshot));
    expect(lines).toEqual([
      "",
      "TODOs (2/4 done):",
      "  Agent's order. Dependencies not provided.",
      "  [x] First done",
      "  [>] Active work",
      "  [ ] Queued work",
      "  [x] Second done",
    ]);
  });

  it("numbers dependency-ordered steps and names their prerequisites", () => {
    const snapshot: ThreadTimelinePendingTodos = {
      sourceSeq: 1,
      updatedAt: 1,
      order: "dependencies",
      items: [
        todo("id:1", "Read the contract", "completed", 1),
        todo("id:2", "Update the fold", "in_progress", 2, [1]),
        todo("id:3", "Update the card", "pending", 3, [1]),
        todo("id:4", "Verify both", "failed", 4, [2, 3]),
      ],
    };
    const { lines } = captureLogLines(() => printPendingTodos(snapshot));
    expect(lines).toEqual([
      "",
      "TODOs (1/4 done):",
      "  Ordered by dependencies.",
      "  [x] 1. Read the contract",
      "  [>] 2. Update the fold (after 1)",
      "  [ ] 3. Update the card (after 1)",
      "  [!] 4. Verify both (after 2, 3)",
    ]);
  });

  it("keeps the section visible when every item is completed (mirrors UI)", () => {
    const snapshot: ThreadTimelinePendingTodos = {
      sourceSeq: 1,
      updatedAt: 1,
      order: "dependencies-invalid",
      items: [
        todo("a", "Read planning doc", "completed", 1),
        todo("b", "Build banner", "completed", 2),
      ],
    };
    const { lines } = captureLogLines(() => printPendingTodos(snapshot));
    expect(lines).toEqual([
      "",
      "TODOs (2/2 done):",
      "  Agent's order. Dependencies couldn't be read.",
      "  [x] Read planning doc",
      "  [x] Build banner",
    ]);
  });
});

describe("fetchThreadPendingTodos", () => {
  function makeTimelineResponse(
    pendingTodos: ThreadTimelinePendingTodos | null,
  ): ThreadTimelineResponse {
    return {
      activePromptMode: null,
      contextBoundarySeq: null,
      completedTurnDisplay: "collapse",
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      pendingTodos,
      goal: null,
      providerCommands: null,
      sessionOptions: null,
      modelFallback: null,
      rows: [],
      maxSeq: 0,
      timelinePage: {
        returnedSegmentCount: 0,
        olderCursor: null,
        historySnapshot: "snapshot-1",
        olderRowsSourceSeqEnd: null,
      },
    };
  }

  interface SdkOverHttpBoundary {
    requestUrls: string[];
    sdk: BbSdk;
  }

  function makeSdkOverHttpBoundary(
    fetchImpl: (url: string) => Promise<Response>,
  ): SdkOverHttpBoundary {
    const requestUrls: string[] = [];
    const fetchMock: FetchImplementation = async (input) => {
      const url = String(input);
      requestUrls.push(url);
      return fetchImpl(url);
    };
    return {
      requestUrls,
      sdk: createNodeBbSdk({ baseUrl: "http://bb.test", fetch: fetchMock }),
    };
  }

  it("requests a summary-only timeline and returns its pendingTodos field", async () => {
    const snapshot: ThreadTimelinePendingTodos = {
      sourceSeq: 7,
      updatedAt: 7,
      order: "dependencies-not-provided",
      items: [todo("a", "Work", "in_progress", 1)],
    };
    const { requestUrls, sdk } = makeSdkOverHttpBoundary(async () =>
      Response.json(makeTimelineResponse(snapshot)),
    );
    const result = await fetchThreadPendingTodos({
      sdk,
      threadId: "thread-1",
    });
    expect(result).toEqual(snapshot);
    expect(requestUrls).toEqual([
      "http://bb.test/api/v1/threads/thread-1/timeline?summaryOnly=true",
    ]);
  });

  it("returns null when the timeline request fails at the network level (best-effort contract)", async () => {
    const { sdk } = makeSdkOverHttpBoundary(async () => {
      throw new Error("network down");
    });
    const result = await fetchThreadPendingTodos({
      sdk,
      threadId: "thread-1",
    });
    expect(result).toBeNull();
  });

  it("returns null when the server responds with an HTTP error (best-effort contract)", async () => {
    const { sdk } = makeSdkOverHttpBoundary(async () =>
      Response.json({ message: "Thread not found" }, { status: 404 }),
    );
    const result = await fetchThreadPendingTodos({
      sdk,
      threadId: "thread-1",
    });
    expect(result).toBeNull();
  });
});
