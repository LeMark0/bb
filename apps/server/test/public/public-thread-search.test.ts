import { archiveThread } from "@bb/db";
import { threadSearchResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

interface SeededSearchThreads {
  activeThreadId: string;
  archivedThreadId: string;
  hiddenThreadId: string;
  hiddenArchivedThreadId: string;
}

function seedSearchThreads(harness: TestAppHarness): SeededSearchThreads {
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const activeThread = seedThread(harness.deps, {
    projectId: project.id,
    title: "routeactive",
    titleFallback: "routeactive",
  });
  const archivedThread = seedThread(harness.deps, {
    projectId: project.id,
    title: "routearchived",
    titleFallback: "routearchived",
  });
  archiveThread(harness.deps.db, harness.deps.hub, archivedThread.id);
  const hiddenThread = seedThread(harness.deps, {
    projectId: project.id,
    title: "routehidden",
    titleFallback: "routehidden",
    visibility: "hidden",
  });
  const hiddenArchivedThread = seedThread(harness.deps, {
    projectId: project.id,
    title: "routehiddenarchived",
    titleFallback: "routehiddenarchived",
    visibility: "hidden",
  });
  archiveThread(harness.deps.db, harness.deps.hub, hiddenArchivedThread.id);
  return {
    activeThreadId: activeThread.id,
    archivedThreadId: archivedThread.id,
    hiddenThreadId: hiddenThread.id,
    hiddenArchivedThreadId: hiddenArchivedThread.id,
  };
}

describe("public thread search route", () => {
  it.each([
    { includeHiddenParam: "", searchesHidden: false },
    { includeHiddenParam: "&includeHidden=false", searchesHidden: false },
    { includeHiddenParam: "&includeHidden=true", searchesHidden: true },
  ])(
    "returns active and archived groups for includeHidden '$includeHiddenParam'",
    async ({ includeHiddenParam, searchesHidden }) => {
      await withTestHarness(async (harness) => {
        const seeded = seedSearchThreads(harness);

        const response = await harness.app.request(
          `/api/v1/threads/search?query=route&limitPerGroup=10${includeHiddenParam}`,
        );

        expect(response.status).toBe(200);
        const body = threadSearchResponseSchema.parse(await readJson(response));
        const activeIds = body.active.results.map((result) => result.thread.id);
        const archivedIds = body.archived.results.map(
          (result) => result.thread.id,
        );
        expect(activeIds).toContain(seeded.activeThreadId);
        expect(archivedIds).toContain(seeded.archivedThreadId);
        expect(activeIds.includes(seeded.hiddenThreadId)).toBe(searchesHidden);
        expect(archivedIds.includes(seeded.hiddenArchivedThreadId)).toBe(
          searchesHidden,
        );
        expect(body.active.total).toBe(searchesHidden ? 2 : 1);
        expect(body.archived.total).toBe(searchesHidden ? 2 : 1);
        expect(
          [...body.active.results, ...body.archived.results]
            .filter((result) => result.thread.visibility === "hidden")
            .map((result) => result.thread.id)
            .sort(),
        ).toEqual(
          searchesHidden
            ? [seeded.hiddenThreadId, seeded.hiddenArchivedThreadId].sort()
            : [],
        );
      });
    },
  );

  it("validates query, limit and includeHidden parameters before the thread-id route", async () => {
    await withTestHarness(async (harness) => {
      const missingQueryResponse = await harness.app.request(
        "/api/v1/threads/search",
      );
      expect(missingQueryResponse.status).toBe(400);

      const shortQueryResponse = await harness.app.request(
        "/api/v1/threads/search?query=x",
      );
      expect(shortQueryResponse.status).toBe(400);

      const badLimitResponse = await harness.app.request(
        "/api/v1/threads/search?query=valid&limitPerGroup=bad",
      );
      expect(badLimitResponse.status).toBe(400);

      const badIncludeHiddenResponse = await harness.app.request(
        "/api/v1/threads/search?query=valid&includeHidden=yes",
      );
      expect(badIncludeHiddenResponse.status).toBe(400);
      await expect(readJson(badIncludeHiddenResponse)).resolves.toMatchObject({
        code: "invalid_request",
      });
    });
  });
});
