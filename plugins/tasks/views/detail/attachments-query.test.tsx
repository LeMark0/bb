// @vitest-environment jsdom
import { useEffect } from "react";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../../shared/contract.js";
import { useTasksQuery } from "../../shell/data.js";
import { TasksRefreshProvider } from "../../shell/refresh.js";
import { TaskAttachments } from "./attachments.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TASK_ID = "01JTASK00000000000000000AA";

function attachment(id: string, fileName: string): Attachment {
  return {
    id,
    taskId: TASK_ID,
    commentId: null,
    fileName,
    mime: "text/markdown",
    sizeBytes: 1024,
    isImage: false,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

const existing = attachment("01JFILE00000000000000000A1", "existing.md");
const uploaded = attachment("01JFILE00000000000000000N1", "uploaded.md");

type Listing = { attachments: Attachment[] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Supersession = "none" | "reconnect" | "explicit refresh";

function renderWithQuery() {
  const requests: Array<ReturnType<typeof deferred<Listing>>> = [];
  const refresh = { current: () => Promise.resolve() };

  function Owner() {
    const query = useTasksQuery(
      async (rpc) =>
        (await rpc.call("listAttachments", { taskId: TASK_ID })).attachments,
      ["tasks:changed"],
      [TASK_ID],
      { relevantTaskIds: [TASK_ID] },
    );
    useEffect(() => {
      refresh.current = query.refresh;
    }, [query.refresh]);
    return (
      <TaskAttachments
        leading={null}
        attachments={query.data}
        loadFailed={!query.isLoading && query.error !== null}
        appliedSettlements={query.appliedSettlements}
        onRetry={query.refresh}
        onUpload={async () => {
          await query.refresh();
          return [uploaded.id];
        }}
        onRemove={async () => {}}
        onError={() => {}}
      />
    );
  }

  const slot = renderSlot(
    {
      component: () => (
        <TasksRefreshProvider>
          <Owner />
        </TasksRefreshProvider>
      ),
    },
    {},
    {
      realtimeConnectionState: "connected",
      rpc: {
        listAttachments: () => {
          const request = deferred<Listing>();
          requests.push(request);
          return request.promise;
        },
      },
    },
  );

  const latest = () => requests[requests.length - 1]!;

  async function succeed(
    request: ReturnType<typeof deferred<Listing>>,
    rows: Attachment[],
  ) {
    await act(async () => {
      request.resolve({ attachments: rows });
      await request.promise;
    });
  }

  async function fail(request: ReturnType<typeof deferred<Listing>>) {
    await act(async () => {
      request.reject(new Error("offline"));
      await request.promise.catch(() => undefined);
    });
  }

  async function supersede(kind: Supersession) {
    if (kind === "none") return;
    const before = requests.length;
    if (kind === "reconnect") {
      await slot.behavior.setRealtimeConnectionState("reconnecting");
      await slot.behavior.setRealtimeConnectionState("connected");
    } else {
      act(() => {
        void refresh.current();
      });
    }
    await waitFor(() => expect(requests).toHaveLength(before + 1));
  }

  async function backgroundLoad(rows: Attachment[]) {
    act(() => {
      void refresh.current();
    });
    await succeed(latest(), rows);
  }

  async function failInitialLoad() {
    await fail(requests[0]!);
    return slot.findByRole("button", { name: "Retry" });
  }

  return {
    slot,
    requests,
    latest,
    succeed,
    fail,
    supersede,
    backgroundLoad,
    failInitialLoad,
  };
}

describe("TaskAttachments Retry with the attachments query", () => {
  it.each<{
    supersession: Supersession;
    outcome: "rows" | "no rows" | "failure";
    focusTarget: string;
  }>([
    { supersession: "none", outcome: "rows", focusTarget: "Attachments (1)" },
    { supersession: "none", outcome: "no rows", focusTarget: "Attach file" },
    { supersession: "none", outcome: "failure", focusTarget: "Retry" },
    {
      supersession: "reconnect",
      outcome: "rows",
      focusTarget: "Attachments (1)",
    },
    {
      supersession: "reconnect",
      outcome: "no rows",
      focusTarget: "Attach file",
    },
    { supersession: "reconnect", outcome: "failure", focusTarget: "Retry" },
    {
      supersession: "explicit refresh",
      outcome: "rows",
      focusTarget: "Attachments (1)",
    },
    {
      supersession: "explicit refresh",
      outcome: "failure",
      focusTarget: "Retry",
    },
  ])(
    "should focus $focusTarget when Retry, superseded by $supersession, ends with $outcome",
    async ({ supersession, outcome, focusTarget }) => {
      const query = renderWithQuery();
      const retry = await query.failInitialLoad();
      retry.focus();
      fireEvent.click(retry);
      expect(query.requests).toHaveLength(2);

      await query.supersede(supersession);
      if (supersession !== "none") {
        await query.succeed(query.requests[1]!, [existing]);
      }
      if (outcome === "failure") await query.fail(query.latest());
      else {
        await query.succeed(
          query.latest(),
          outcome === "rows" ? [existing] : [],
        );
      }

      const target = query.slot.getByRole("button", { name: focusTarget });
      await waitFor(() => expect(document.activeElement).toBe(target));
      if (outcome === "rows") {
        expect(target.getAttribute("aria-expanded")).toBe("false");
      }
    },
  );

  it("should end the Retry intent at a renewed failure so a later background load does not move focus", async () => {
    const query = renderWithQuery();
    const retry = await query.failInitialLoad();
    retry.focus();
    fireEvent.click(retry);
    await query.fail(query.latest());
    expect(document.activeElement).toBe(
      query.slot.getByRole("button", { name: "Retry" }),
    );

    await query.backgroundLoad([existing]);

    expect(
      query.slot.getByRole("button", { name: "Attachments (1)" }),
    ).not.toBe(document.activeElement);
    expect(document.activeElement).toBe(document.body);
  });

  it("should respect a deliberate focus move while the Retry is pending", async () => {
    const query = renderWithQuery();
    const retry = await query.failInitialLoad();
    retry.focus();
    fireEvent.click(retry);
    await query.supersede("reconnect");
    const attach = query.slot.getByRole("button", { name: "Attach file" });
    attach.focus();

    await query.succeed(query.requests[1]!, [existing]);
    await query.succeed(query.latest(), [existing]);

    expect(document.activeElement).toBe(attach);
  });

  it("should not move focus when a background load replaces a Retry that was never pressed", async () => {
    const query = renderWithQuery();
    const retry = await query.failInitialLoad();
    retry.focus();

    await query.backgroundLoad([existing]);

    expect(document.activeElement).toBe(document.body);
  });
});

describe("TaskAttachments upload reveal with the attachments query", () => {
  async function uploadInto(query: ReturnType<typeof renderWithQuery>) {
    await query.succeed(query.requests[0]!, [existing]);
    const attach = query.slot.getByRole("button", { name: "Attach file" });
    attach.focus();
    fireEvent.change(
      query.slot.container.querySelector('input[type="file"]')!,
      { target: { files: [new File(["text"], "uploaded.md")] } },
    );
    expect(query.requests).toHaveLength(2);
    return attach;
  }

  it.each<{ supersession: Supersession }>([
    { supersession: "none" },
    { supersession: "reconnect" },
    { supersession: "explicit refresh" },
  ])(
    "should reveal the uploaded row once it commits when the refresh is superseded by $supersession",
    async ({ supersession }) => {
      const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
      const query = renderWithQuery();
      const attach = await uploadInto(query);

      await query.supersede(supersession);
      if (supersession !== "none") {
        await query.succeed(query.requests[1]!, [existing]);
        expect(scrollIntoView).not.toHaveBeenCalled();
      }
      await query.succeed(query.latest(), [existing, uploaded]);

      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toBe(
        query.slot.getByTitle("uploaded.md").closest("li"),
      );
      expect(document.activeElement).toBe(attach);
    },
  );

  it("should drop the reveal when the list is collapsed before the uploaded row commits", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const query = renderWithQuery();
    await uploadInto(query);
    await query.supersede("reconnect");
    await query.succeed(query.requests[1]!, [existing]);
    const disclosure = query.slot.getByRole("button", {
      name: "Attachments (1)",
    });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(disclosure);
    await query.succeed(query.latest(), [existing, uploaded]);
    fireEvent.click(
      query.slot.getByRole("button", { name: "Attachments (2)" }),
    );

    expect(query.slot.getByTitle("uploaded.md")).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
