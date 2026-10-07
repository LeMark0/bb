// @vitest-environment jsdom
import { useEffect, useState, type ComponentProps } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../../shared/contract.js";
import { TaskAttachments } from "./attachments.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "01JFILE00000000000000000AA",
    taskId: "01JTASK00000000000000000AA",
    commentId: null,
    fileName: "notes.md",
    mime: "text/markdown",
    sizeBytes: 1024,
    isImage: false,
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function image(overrides: Partial<Attachment> = {}): Attachment {
  return attachment({
    id: "01JIMAGE0000000000000000AA",
    fileName: "diagram.png",
    mime: "image/png",
    isImage: true,
    ...overrides,
  });
}

function baseProps(
  overrides: Partial<ComponentProps<typeof TaskAttachments>> = {},
): ComponentProps<typeof TaskAttachments> {
  return {
    leading: null,
    attachments: [],
    loadFailed: false,
    appliedSettlements: 0,
    onRetry: vi.fn(),
    onUpload: vi.fn().mockResolvedValue([]),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    ...overrides,
  };
}

function renderAttachments(
  overrides: Partial<ComponentProps<typeof TaskAttachments>> = {},
) {
  return render(<TaskAttachments {...baseProps(overrides)} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function trigger(screen: ReturnType<typeof render>) {
  return screen.getByRole("button", { name: /^Attachments \(\d+\)$/ });
}

describe("TaskAttachments disclosure", () => {
  it("should keep the list collapsed until the trigger toggles it", () => {
    const screen = renderAttachments({
      attachments: [
        attachment(),
        attachment({ id: "01JFILE00000000000000000AB", fileName: "a.md" }),
      ],
    });

    expect(trigger(screen).textContent).toBe("Attachments (2)");
    expect(trigger(screen).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();

    fireEvent.click(trigger(screen));
    expect(trigger(screen).getAttribute("aria-expanded")).toBe("true");
    expect(
      within(screen.getByRole("list")).getAllByRole("listitem"),
    ).toHaveLength(2);

    fireEvent.click(trigger(screen));
    expect(trigger(screen).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("should show only Attach file while loading and when there are no attachments", () => {
    const screen = renderAttachments({ attachments: undefined });
    expect(screen.getByRole("button", { name: "Attach file" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Attachments/ })).toBeNull();
    expect(screen.queryByText("Couldn't load attachments")).toBeNull();

    screen.rerender(<TaskAttachments {...baseProps()} />);
    expect(screen.queryByRole("button", { name: /^Attachments/ })).toBeNull();
  });

  it("should list rows in server order with files and images mixed", () => {
    const screen = renderAttachments({
      attachments: [
        image({ id: "01JIMAGE0000000000000000A1", fileName: "first.png" }),
        attachment({ id: "01JFILE00000000000000000A1", fileName: "second.md" }),
        image({ id: "01JIMAGE0000000000000000A2", fileName: "third.png" }),
      ],
    });
    fireEvent.click(trigger(screen));

    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(
      rows.map((row) => row.querySelector("[title]")?.getAttribute("title")),
    ).toEqual(["first.png", "second.md", "third.png"]);
    const fileLink = within(rows[1]!).getByRole("link");
    expect(fileLink.getAttribute("download")).toBe("second.md");
    expect(fileLink.getAttribute("href")).toContain(
      "01JFILE00000000000000000A1",
    );
  });

  it("should give duplicate file names distinct remove labels", () => {
    const screen = renderAttachments({
      attachments: [
        attachment({ fileName: "review-1.md", sizeBytes: 13 * 1024 }),
        attachment({
          id: "01JFILE00000000000000000AB",
          fileName: "review-1.md",
          sizeBytes: 7 * 1024,
        }),
      ],
    });
    fireEvent.click(trigger(screen));

    const labels = screen
      .getAllByRole("button", { name: /^Remove review-1\.md/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(labels[0]).toMatch(/^Remove review-1\.md, 13 KB, added /);
    expect(labels[1]).toMatch(/^Remove review-1\.md, 7 KB, added /);
  });
});

describe("TaskAttachments load failure", () => {
  function renderFailedLoad() {
    const reload = deferred<void>();
    const props = baseProps({
      attachments: undefined,
      loadFailed: true,
      appliedSettlements: 1,
      onRetry: vi.fn(() => reload.promise),
    });
    const screen = render(<TaskAttachments {...props} />);
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    return { screen, props, reload, retry };
  }

  it("should offer a retry instead of rendering nothing when loading fails", () => {
    const { screen, props } = renderFailedLoad();

    expect(screen.getByText("Couldn't load attachments")).toBeDefined();
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      outcome: "attachments",
      returned: [
        attachment(),
        attachment({ id: "01JFILE00000000000000000AB", fileName: "a.md" }),
      ],
      focusTarget: "Attachments (2)",
    },
    { outcome: "no attachments", returned: [], focusTarget: "Attach file" },
  ])(
    "should focus $focusTarget when Retry loads $outcome",
    async ({ returned, focusTarget }) => {
      const { screen, props, reload } = renderFailedLoad();

      await act(async () => {
        screen.rerender(
          <TaskAttachments
            {...props}
            attachments={returned}
            loadFailed={false}
            appliedSettlements={2}
          />,
        );
        reload.resolve();
        await reload.promise;
      });

      const target = screen.getByRole("button", { name: focusTarget });
      await waitFor(() => expect(document.activeElement).toBe(target));
      expect(target.getAttribute("aria-expanded")).toBe(
        returned.length > 0 ? "false" : null,
      );
    },
  );

  it("should keep focus on Retry when it fails again and leave focus alone on a later background load", async () => {
    const { screen, props, reload, retry } = renderFailedLoad();

    await act(async () => {
      screen.rerender(<TaskAttachments {...props} appliedSettlements={2} />);
      reload.resolve();
      await reload.promise;
    });
    expect(document.activeElement).toBe(retry);

    await act(async () => {
      screen.rerender(
        <TaskAttachments
          {...props}
          attachments={[attachment()]}
          loadFailed={false}
          appliedSettlements={3}
        />,
      );
    });
    expect(document.activeElement).not.toBe(trigger(screen));
    expect(document.activeElement).not.toBe(
      screen.getByRole("button", { name: "Attach file" }),
    );
  });
});

describe("TaskAttachments upload", () => {
  const existing = [
    attachment({ id: "01JFILE00000000000000000A1", fileName: "old-1.md" }),
    attachment({ id: "01JFILE00000000000000000A2", fileName: "old-2.md" }),
  ];
  const uploaded = [
    attachment({ id: "01JFILE00000000000000000N1", fileName: "new-1.md" }),
    attachment({ id: "01JFILE00000000000000000N2", fileName: "new-2.md" }),
  ];

  function pickFiles(screen: ReturnType<typeof render>) {
    const input = screen.container.querySelector('input[type="file"]')!;
    const files = [
      new File(["one"], "new-1.md", { type: "text/markdown" }),
      new File(["two"], "new-2.md", { type: "text/markdown" }),
    ];
    fireEvent.change(input, { target: { files } });
    return files;
  }

  it("should reveal the first uploaded row without moving focus from Attach file", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const upload = deferred<string[]>();
    const props = baseProps({
      attachments: existing,
      onUpload: vi.fn(() => upload.promise),
    });
    const screen = render(<TaskAttachments {...props} />);
    const attach = screen.getByRole("button", { name: "Attach file" });
    attach.focus();

    pickFiles(screen);
    await act(async () => {
      screen.rerender(
        <TaskAttachments {...props} attachments={[...existing, ...uploaded]} />,
      );
      upload.resolve(uploaded.map((entry) => entry.id));
      await upload.promise;
    });

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoView.mock.contexts[0]).toBe(
      screen.getByTitle("new-1.md").closest("li"),
    );
    expect(document.activeElement).toBe(attach);
  });

  it("should not scroll after a failed upload or a background change", async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const props = baseProps({
      attachments: existing,
      onUpload: vi.fn().mockResolvedValue([]),
    });
    const screen = render(<TaskAttachments {...props} />);

    pickFiles(screen);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Attach file" })).toBeDefined(),
    );
    expect(trigger(screen).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger(screen));
    await act(async () => {
      screen.rerender(
        <TaskAttachments
          {...props}
          attachments={[...existing, uploaded[0]!]}
        />,
      );
    });

    expect(screen.getByTitle("new-1.md")).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("should show a busy Attach file and expand the list after a paperclip upload", async () => {
    const upload = deferred<string[]>();
    const onUpload = vi.fn(() => upload.promise);
    const screen = renderAttachments({
      attachments: [attachment()],
      onUpload,
    });
    const input = screen.container.querySelector('input[type="file"]')!;
    const file = new File(["body"], "report.md", { type: "text/markdown" });

    fireEvent.change(input, { target: { files: [file] } });

    const busy = screen.getByRole("button", { name: "Uploading…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(onUpload).toHaveBeenCalledWith([file]);
    expect(trigger(screen).getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      upload.resolve(["01JFILE00000000000000000N1"]);
      await upload.promise;
    });

    expect(screen.getByRole("button", { name: "Attach file" })).toBeDefined();
    expect(trigger(screen).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("TaskAttachments removal", () => {
  const rows = [
    attachment({ id: "01JFILE00000000000000000A1", fileName: "first.md" }),
    attachment({ id: "01JFILE00000000000000000A2", fileName: "second.md" }),
    attachment({ id: "01JFILE00000000000000000A3", fileName: "third.md" }),
  ];

  type RemovalStep =
    | { confirm: string }
    | { succeed: string; rowLeaves: "before" | "after" }
    | { fail: string };

  function renderRemovalOwner(initial: Attachment[]) {
    const outcomes = new Map<string, ReturnType<typeof deferred<void>>>();
    const removeRow = { current: (_id: string) => {} };
    function Owner() {
      const [current, setCurrent] = useState(initial);
      useEffect(() => {
        removeRow.current = (id) =>
          setCurrent((entries) => entries.filter((entry) => entry.id !== id));
      }, []);
      return (
        <TaskAttachments
          {...baseProps({
            attachments: current,
            onRemove: (entry) => {
              const outcome = deferred<void>();
              outcomes.set(entry.id, outcome);
              return outcome.promise;
            },
          })}
        />
      );
    }
    const screen = render(<Owner />);
    fireEvent.click(trigger(screen));
    const idOf = (fileName: string) =>
      initial.find((entry) => entry.fileName === fileName)!.id;

    async function run(step: RemovalStep) {
      if ("confirm" in step) {
        const remove = screen.getByRole("button", {
          name: (name) => name.startsWith(`Remove ${step.confirm},`),
        });
        remove.focus();
        fireEvent.click(remove);
        fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(remove));
        return;
      }
      if ("fail" in step) {
        const outcome = outcomes.get(idOf(step.fail))!;
        await act(async () => {
          outcome.reject(new Error("blob is busy"));
          await outcome.promise.catch(() => undefined);
        });
        return;
      }
      const id = idOf(step.succeed);
      const outcome = outcomes.get(id)!;
      if (step.rowLeaves === "before") {
        await act(async () => removeRow.current(id));
      }
      await act(async () => {
        outcome.resolve();
        await outcome.promise;
      });
      if (step.rowLeaves === "after") {
        await act(async () => removeRow.current(id));
      }
    }

    return { screen, run };
  }

  it.each<{
    situation: string;
    list: Attachment[];
    steps: RemovalStep[];
    focusTarget: string;
    remaining: string[];
  }>([
    {
      situation: "removing a middle row",
      list: rows,
      steps: [
        { confirm: "second.md" },
        { succeed: "second.md", rowLeaves: "after" },
      ],
      focusTarget: "third.md",
      remaining: ["first.md", "third.md"],
    },
    {
      situation: "removing the last row",
      list: rows,
      steps: [
        { confirm: "third.md" },
        { succeed: "third.md", rowLeaves: "before" },
      ],
      focusTarget: "second.md",
      remaining: ["first.md", "second.md"],
    },
    {
      situation: "removing the only row",
      list: rows.slice(0, 1),
      steps: [
        { confirm: "first.md" },
        { succeed: "first.md", rowLeaves: "before" },
      ],
      focusTarget: "Attach file",
      remaining: [],
    },
    {
      situation: "overlapping removals finishing in order",
      list: rows,
      steps: [
        { confirm: "first.md" },
        { confirm: "second.md" },
        { succeed: "first.md", rowLeaves: "before" },
        { succeed: "second.md", rowLeaves: "before" },
      ],
      focusTarget: "third.md",
      remaining: ["third.md"],
    },
    {
      situation: "overlapping removals finishing in reverse",
      list: rows,
      steps: [
        { confirm: "first.md" },
        { confirm: "second.md" },
        { succeed: "second.md", rowLeaves: "before" },
        { succeed: "first.md", rowLeaves: "after" },
      ],
      focusTarget: "third.md",
      remaining: ["third.md"],
    },
    {
      situation: "an earlier removal failing while a later one succeeds",
      list: rows,
      steps: [
        { confirm: "first.md" },
        { confirm: "second.md" },
        { fail: "first.md" },
        { succeed: "second.md", rowLeaves: "after" },
      ],
      focusTarget: "third.md",
      remaining: ["first.md", "third.md"],
    },
    {
      situation: "a later removal failing while an earlier one succeeds",
      list: rows,
      steps: [
        { confirm: "first.md" },
        { confirm: "second.md" },
        { fail: "second.md" },
        { succeed: "first.md", rowLeaves: "before" },
      ],
      focusTarget: "Remove second.md",
      remaining: ["second.md", "third.md"],
    },
  ])(
    "should keep focus on a live control after $situation",
    async ({ list, steps, focusTarget, remaining }) => {
      const { screen, run } = renderRemovalOwner(list);

      for (const step of steps) await run(step);

      const expected =
        focusTarget === "Attach file"
          ? screen.getByRole("button", { name: "Attach file" })
          : focusTarget.startsWith("Remove ")
            ? screen.getByRole("button", {
                name: (name) => name.startsWith(`${focusTarget},`),
              })
            : screen.getByTitle(focusTarget);
      await waitFor(() => expect(document.activeElement).toBe(expected));
      expect(
        screen
          .queryAllByRole("listitem")
          .map((row) => row.querySelector("[title]")?.getAttribute("title")),
      ).toEqual(remaining);
    },
  );

  it("should return focus to the row's Remove button when the confirmation is cancelled", async () => {
    const onRemove = vi.fn();
    const screen = renderAttachments({ attachments: rows, onRemove });
    fireEvent.click(trigger(screen));
    const remove = screen.getByRole("button", {
      name: (name) => name.startsWith("Remove second.md,"),
    });

    fireEvent.click(remove);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(remove));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("should show the busy row, then surface the server error and restore the row on failure", async () => {
    const removal = deferred<void>();
    const onRemove = vi.fn(() => removal.promise);
    const onError = vi.fn();
    const screen = renderAttachments({
      attachments: [image()],
      onRemove,
      onError,
    });
    fireEvent.click(trigger(screen));

    fireEvent.click(
      screen.getByRole("button", { name: /^Remove diagram\.png,/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    const row = screen.getByRole("listitem");
    await waitFor(() => expect(row.getAttribute("aria-busy")).toBe("true"));
    expect(within(row).getByRole("status", { name: "Removing" })).toBeDefined();

    await act(async () => {
      removal.reject(new Error("blob is busy"));
      await removal.promise.catch(() => undefined);
    });

    await waitFor(() => expect(onError).toHaveBeenCalledWith("blob is busy"));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(row.getAttribute("aria-busy")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /^Remove diagram\.png,/ })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

describe("TaskAttachments image preview", () => {
  it("should return focus to the image row when the lightbox closes", () => {
    const screen = renderAttachments({ attachments: [image()] });
    fireEvent.click(trigger(screen));
    const row = screen.getByTitle("diagram.png");

    fireEvent.click(row);
    expect(screen.getByRole("dialog", { name: "diagram.png" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});
