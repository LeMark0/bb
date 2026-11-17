// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Task } from "../../shared/contract.js";
import { LIST_PREFERENCE_STORAGE_KEY } from "./list-preference.js";
import { labelsByProject, makeTask, rpcInput } from "../../test-fixtures.js";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const project = {
  id: PROJECT_ID,
  name: "Synthetic",
  prefix: "SYN",
  nextTaskNumber: 4,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function task(number: number, title: string): Task {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZZT${number}`,
    projectId: PROJECT_ID,
    number,
    key: `SYN-${number}`,
    title,
    position: number,
  });
}

const everyTask = [
  task(1, "Deploy runbook"),
  task(2, "Rotate keys"),
  task(3, "Deploy checklist"),
];

function renderList(
  calls: Record<string, unknown>[],
  resultsBySearch: Record<string, Task[]>,
  subPath = "all",
) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        labelsByProject: labelsByProject([]),
        listTaskCardMeta: () => ({ cards: [] }),
        listAllTasks: (raw: unknown) => {
          const input = rpcInput(raw);
          calls.push(input);
          const search = typeof input.search === "string" ? input.search : "";
          return { tasks: resultsBySearch[search] ?? [] };
        },
      },
    },
  );
}

function searchBox(slot: ReturnType<typeof renderList>) {
  return slot.getByRole("searchbox", { name: "Search tasks" });
}

describe("Tasks list search", () => {
  it("asks the server for matches within the active filters", async () => {
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: { all: { filters: { statuses: ["todo"] }, sort: "manual" } },
      }),
    );
    const calls: Record<string, unknown>[] = [];
    const slot = renderList(calls, {
      "": everyTask,
      deploy: [everyTask[0]!, everyTask[2]!],
    });
    await slot.findByText("Rotate keys");

    fireEvent.change(searchBox(slot), { target: { value: "  deploy " } });

    await waitFor(() => expect(slot.queryByText("Rotate keys")).toBeNull());
    expect(slot.getByText("Deploy runbook")).toBeTruthy();
    expect(slot.getByText("Deploy checklist")).toBeTruthy();
    await waitFor(() =>
      expect(calls).toContainEqual(
        expect.objectContaining({ search: "deploy", statuses: ["todo"] }),
      ),
    );

    fireEvent.keyDown(searchBox(slot), { key: "Escape" });

    expect(searchBox(slot)).toHaveProperty("value", "");
    expect(await slot.findByText("Rotate keys")).toBeTruthy();
  });

  it("keeps a server match whose letters only differ by non-ASCII case", async () => {
    const greek = task(4, "ΟΣ");
    const slot = renderList([], { "": everyTask, Σ: [greek] });
    await slot.findByText("Rotate keys");

    fireEvent.change(searchBox(slot), { target: { value: "Σ" } });

    expect(await slot.findByText("ΟΣ")).toBeTruthy();
    expect(slot.queryByText("No tasks match “Σ”")).toBeNull();
  });

  it("explains an empty result and clears the search from it", async () => {
    const calls: Record<string, unknown>[] = [];
    const slot = renderList(calls, { "": everyTask, nothing: [] });
    await slot.findByText("Rotate keys");

    fireEvent.change(searchBox(slot), { target: { value: "nothing" } });
    expect(await slot.findByText("No tasks match “nothing”")).toBeTruthy();
    fireEvent.click(slot.getByText("Clear search"));

    expect(searchBox(slot)).toHaveProperty("value", "");
    expect(await slot.findByText("Rotate keys")).toBeTruthy();
    expect(calls.at(-1)).not.toHaveProperty("search");
  });

  it("keeps each list's search when the list is opened again", async () => {
    const results = { "": everyTask, rotate: [everyTask[1]!] };
    const first = renderList([], results);
    fireEvent.change(searchBox(first), { target: { value: "rotate" } });
    first.lifecycle.unmount();

    const reopened = renderList([], results);
    expect(searchBox(reopened)).toHaveProperty("value", "rotate");
    expect(await reopened.findByText("Rotate keys")).toBeTruthy();
    expect(reopened.queryByText("Deploy runbook")).toBeNull();
    reopened.lifecycle.unmount();

    const project = renderList([], results, PROJECT_ID);
    expect(searchBox(project)).toHaveProperty("value", "");
  });
});
