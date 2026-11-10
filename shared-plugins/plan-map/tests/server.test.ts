import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ADR_LIMITS, checkAdrShape, parseBoundedAdr } from "../adr-guard.ts";
import { PlanFileError, applyAdr, bindAdr, checkAdr, createAdr, resolveForCommand, resolveInProject, type PlanFileDeps } from "../plan-files.ts";
import { createBindingStore, createPlanMapHandlers, mapEntries, parseMapsSetting } from "../server.ts";

const fixture = readFileSync(new URL("../upstream/docs/adr/0001-reusable-plan-maps.md", import.meta.url), "utf8");
const template = readFileSync(new URL("../upstream/skills/plan-map/assets/feature-adr.md", import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const revised = template
  .replace('updated_at: "2026-09-09T00:00:00Z"', 'updated_at: "2026-09-10T00:00:00Z"')
  .replace("Replace with an observable completion criterion.", "The first deliverable is visible to a user.");
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

type World = {
  files: Map<string, string>;
  links: Map<string, string>;
  settings: string;
  announced: string[];
  reads: { path: string; rootPath: string }[];
  writes: { path: string; rootPath: string; expectedSha256: string | null }[];
};

const PROJECTS = {
  proj_alpha: { projectId: "proj_alpha", name: "Alpha", hostId: "host_1", root: "/work/alpha" },
  proj_beta: { projectId: "proj_beta", name: "Beta", hostId: "host_1", root: "/work/beta" },
};

function world(files: Record<string, string> = {}, settings = "{}", links: Record<string, string> = {}) {
  const state: World = { files: new Map(Object.entries(files)), links: new Map(Object.entries(links)), settings, announced: [], reads: [], writes: [] };
  const bindings = createBindingStore({
    read: async () => {
      await tick();
      return state.settings;
    },
    write: async (raw) => {
      await tick();
      state.settings = raw;
    },
  });
  const deps: PlanFileDeps = {
    project: async (projectId) => PROJECTS[projectId as keyof typeof PROJECTS] ?? null,
    readFile: async ({ path, rootPath }) => {
      state.reads.push({ path, rootPath });
      const real = state.links.get(path) ?? path;
      if (!real.startsWith(`${rootPath}/`)) throw new Error("Path resolves outside the root");
      const text = state.files.get(real);
      if (text === undefined) throw new Error("ENOENT: no such file");

      return { text, sha256: sha(text), sizeBytes: Buffer.byteLength(text) };
    },
    writeFile: async ({ path, rootPath, content, expectedSha256 }) => {
      state.writes.push({ path, rootPath, expectedSha256 });
      const current = state.files.get(path);
      if (expectedSha256 === null && current !== undefined) return { outcome: "conflict", currentSha256: sha(current) };
      if (expectedSha256 !== null && (current === undefined || sha(current) !== expectedSha256)) {
        return { outcome: "conflict", currentSha256: current === undefined ? null : sha(current) };
      }
      state.files.set(path, content);

      return { outcome: "written", sha256: sha(content) };
    },
    boundPaths: bindings.boundPaths,
    addBoundPath: bindings.addBoundPath,
    announce: (projectId) => void state.announced.push(projectId),
  };

  return { deps, state };
}

async function rejects(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => error instanceof PlanFileError && error.code === code);
}

function allReadsScoped(state: World, root: string) {
  assert.ok(state.reads.length > 0);
  for (const read of state.reads) assert.equal(read.rootPath, root);
}

describe("resolveInProject", () => {
  it("should keep paths inside the project folder and reject escapes and non-Markdown files", () => {
    assert.equal(resolveInProject("/work/alpha", "docs/adr/0001.md"), "/work/alpha/docs/adr/0001.md");
    assert.equal(resolveInProject("/work/alpha", "/work/alpha/./docs/x.md"), "/work/alpha/docs/x.md");
    assert.throws(() => resolveInProject("/work/alpha", "../beta/docs/x.md"), /outside this project/u);
    assert.throws(() => resolveInProject("/work/alpha", "/work/alphabet/x.md"), /outside this project/u);
    assert.throws(() => resolveInProject("/work/alpha", "docs/notes.txt"), /not a Markdown/u);
    assert.throws(() => resolveInProject("/work/alpha", "   "), /Enter the path/u);
  });

  it("should resolve command paths against the working directory only when it is inside the project", () => {
    assert.equal(resolveForCommand("/work/alpha", "/work/alpha/docs", "adr/1.md"), "/work/alpha/docs/adr/1.md");
    assert.equal(resolveForCommand("/work/alpha", "/tmp", "docs/1.md"), "/work/alpha/docs/1.md");
    assert.throws(() => resolveForCommand("/work/alpha", "/tmp", "/tmp/draft.md"), /outside this project/u);
    assert.throws(() => resolveForCommand("/work/alpha", "/work/alpha", "../beta/x.md"), /outside this project/u);
  });
});

describe("project boundary", () => {
  it("should refuse to check, copy or apply a file from another project or outside any project", async () => {
    const path = "/work/alpha/docs/adr/0001.md";
    const { deps, state } = world({ "/work/beta/private.md": fixture, "/tmp/draft.md": template, [path]: template, "/work/beta/next.md": revised });
    await rejects(checkAdr(deps, { projectId: "proj_alpha", path: "/work/beta/private.md" }), "outside_project");
    await rejects(createAdr(deps, { projectId: "proj_alpha", candidate: "/work/beta/private.md", destination: "/work/alpha/copy.md" }), "outside_project");
    await rejects(createAdr(deps, { projectId: "proj_alpha", cwd: "/tmp", candidate: "/tmp/draft.md", destination: "docs/adr/0002.md" }), "outside_project");
    await rejects(applyAdr(deps, { projectId: "proj_alpha", adr: path, candidate: "/work/beta/next.md", expected: sha(template) }), "outside_project");
    await rejects(checkAdr(deps, { projectId: "proj_alpha", path: "/work/alpha/notes.txt" }), "not_markdown");
    assert.deepEqual(state.reads.filter((read) => !read.path.startsWith("/work/alpha/")), []);
    assert.equal(state.files.get("/work/alpha/copy.md"), undefined);
    assert.equal(state.files.get(path), template);
  });

  it("should pass the project root on every read so a symlink cannot leave the folder", async () => {
    const { deps, state } = world({ "/work/beta/private.md": fixture }, "{}", { "/work/alpha/link.md": "/work/beta/private.md" });
    await rejects(checkAdr(deps, { projectId: "proj_alpha", path: "link.md" }), "unreadable");
    await rejects(bindAdr(deps, { projectId: "proj_alpha", path: "link.md" }), "unreadable");
    allReadsScoped(state, "/work/alpha");
    assert.equal(state.settings, "{}");
  });

  it("should not read a foreign path that settings bind to this project, and keep the settings", async () => {
    const settings = JSON.stringify({ proj_alpha: ["/work/beta/private.md", "/work/alpha/a.md"] });
    const { deps, state } = world({ "/work/beta/private.md": "secret", "/work/alpha/a.md": fixture }, settings);
    const handlers = createPlanMapHandlers(deps);
    const [foreign, own] = mapEntries(["/work/beta/private.md", "/work/alpha/a.md"]);
    const refused = await handlers.readMap({ projectId: "proj_alpha", mapId: foreign?.id ?? "" });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.message, /outside this project's folder/u);
    assert.equal((await handlers.readMap({ projectId: "proj_alpha", mapId: own?.id ?? "" })).ok, true);
    assert.deepEqual(state.reads, [{ path: "/work/alpha/a.md", rootPath: "/work/alpha" }]);
    assert.equal(state.settings, settings);
  });
});

describe("bindAdr", () => {
  it("should validate the ADR, bind it to this project only and keep other projects' maps", async () => {
    const { deps, state } = world({ "/work/alpha/docs/adr/0001.md": fixture }, JSON.stringify({ proj_beta: "/work/beta/plan.md" }));
    const result = await bindAdr(deps, { projectId: "proj_alpha", path: "docs/adr/0001.md" });
    assert.equal(result.title, "Reusable ADR-driven plan maps");
    assert.equal(result.alreadyBound, false);
    assert.deepEqual(parseMapsSetting(state.settings)?.get("proj_alpha"), ["/work/alpha/docs/adr/0001.md"]);
    assert.deepEqual(parseMapsSetting(state.settings)?.get("proj_beta"), ["/work/beta/plan.md"]);
    assert.deepEqual(state.announced, ["proj_alpha"]);
    allReadsScoped(state, "/work/alpha");
  });

  it("should not duplicate a binding or announce a change on a repeated bind", async () => {
    const { deps, state } = world({ "/work/alpha/a.md": fixture }, JSON.stringify({ proj_alpha: ["/work/alpha/a.md"] }));
    const result = await bindAdr(deps, { projectId: "proj_alpha", path: "/work/alpha/a.md" });
    assert.equal(result.alreadyBound, true);
    assert.deepEqual(parseMapsSetting(state.settings)?.get("proj_alpha"), ["/work/alpha/a.md"]);
    assert.deepEqual(state.announced, []);
  });

  it("should keep every binding when binds run at the same time, in one project and across projects", async () => {
    const files = { "/work/alpha/a.md": fixture, "/work/alpha/b.md": fixture, "/work/alpha/c.md": fixture, "/work/beta/d.md": fixture };
    const { deps, state } = world(files, JSON.stringify({ proj_alpha: "/work/alpha/existing.md" }));
    const results = await Promise.all([
      bindAdr(deps, { projectId: "proj_alpha", path: "a.md" }),
      bindAdr(deps, { projectId: "proj_alpha", path: "b.md" }),
      bindAdr(deps, { projectId: "proj_beta", path: "d.md" }),
      bindAdr(deps, { projectId: "proj_alpha", path: "c.md" }),
      bindAdr(deps, { projectId: "proj_alpha", path: "a.md" }),
    ]);
    assert.deepEqual(results.map((result) => result.alreadyBound), [false, false, false, false, true]);
    assert.deepEqual(parseMapsSetting(state.settings)?.get("proj_alpha"), ["/work/alpha/existing.md", "/work/alpha/a.md", "/work/alpha/b.md", "/work/alpha/c.md"]);
    assert.deepEqual(parseMapsSetting(state.settings)?.get("proj_beta"), ["/work/beta/d.md"]);
  });

  it("should refuse a file in another project, a missing file and an invalid ADR without changing settings", async () => {
    const { deps, state } = world({ "/work/beta/plan.md": fixture, "/work/alpha/bad.md": "# not a plan" });
    await rejects(bindAdr(deps, { projectId: "proj_alpha", path: "/work/beta/plan.md" }), "outside_project");
    await rejects(bindAdr(deps, { projectId: "proj_alpha", path: "missing.md" }), "not_found");
    await rejects(bindAdr(deps, { projectId: "proj_alpha", path: "bad.md" }), "invalid_adr");
    await rejects(bindAdr(deps, { path: "bad.md" }), "no_project");
    assert.equal(state.settings, "{}");
    assert.deepEqual(state.announced, []);
  });

  it("should leave an invalid settings value untouched", async () => {
    const { deps, state } = world({ "/work/alpha/a.md": fixture }, "{not json");
    await rejects(bindAdr(deps, { projectId: "proj_alpha", path: "a.md" }), "settings_invalid");
    assert.equal(state.settings, "{not json");
  });
});

describe("createAdr", () => {
  it("should validate a candidate inside the project and write a new ADR, create-only", async () => {
    const { deps, state } = world({ "/work/alpha/docs/adr/0001-feature.draft.md": template });
    const summary = await createAdr(deps, { projectId: "proj_alpha", cwd: "/work/alpha", candidate: "docs/adr/0001-feature.draft.md", destination: "docs/adr/0001-feature.md" });
    assert.equal(summary.path, "/work/alpha/docs/adr/0001-feature.md");
    assert.deepEqual(state.writes, [{ path: "/work/alpha/docs/adr/0001-feature.md", rootPath: "/work/alpha", expectedSha256: null }]);
    allReadsScoped(state, "/work/alpha");
  });

  it("should never overwrite, and refuse invalid candidates and destinations outside the project", async () => {
    const { deps, state } = world({ "/work/alpha/draft.md": template, "/work/alpha/bad.md": "# nope", "/work/alpha/docs/adr/0001.md": "existing" });
    await rejects(createAdr(deps, { projectId: "proj_alpha", candidate: "/work/alpha/draft.md", destination: "/work/alpha/docs/adr/0001.md" }), "exists");
    assert.equal(state.files.get("/work/alpha/docs/adr/0001.md"), "existing");
    await rejects(createAdr(deps, { projectId: "proj_alpha", candidate: "/work/alpha/bad.md", destination: "/work/alpha/x.md" }), "invalid_adr");
    await rejects(createAdr(deps, { projectId: "proj_alpha", candidate: "/work/alpha/draft.md", destination: "/work/beta/x.md" }), "outside_project");
  });
});

describe("applyAdr", () => {
  it("should replace the ADR only with the expected sha256 and a valid update", async () => {
    const path = "/work/alpha/docs/adr/0001.md";
    const { deps, state } = world({ [path]: template, "/work/alpha/docs/adr/0001.draft.md": revised });
    const summary = await applyAdr(deps, { projectId: "proj_alpha", adr: path, candidate: "/work/alpha/docs/adr/0001.draft.md", expected: sha(template) });
    assert.equal(summary.sha256, sha(revised));
    assert.equal(state.files.get(path), revised);
    assert.deepEqual(state.writes.at(-1), { path, rootPath: "/work/alpha", expectedSha256: sha(template) });
    allReadsScoped(state, "/work/alpha");
  });

  it("should refuse a stale hash and an update that breaks Plan Map's history rules", async () => {
    const path = "/work/alpha/docs/adr/0001.md";
    const sameTime = template.replace("Replace with an observable completion criterion.", "Changed without advancing updated_at.");
    const { deps, state } = world({ [path]: template, "/work/alpha/next.md": revised, "/work/alpha/same-time.md": sameTime });
    await rejects(applyAdr(deps, { projectId: "proj_alpha", adr: path, candidate: "/work/alpha/next.md", expected: "0".repeat(64) }), "stale");
    await rejects(applyAdr(deps, { projectId: "proj_alpha", adr: path, candidate: "/work/alpha/same-time.md", expected: sha(template) }), "rejected_update");
    assert.equal(state.files.get(path), template);
  });
});

describe("checkAdr", () => {
  it("should print upstream's summary fields", async () => {
    const { deps } = world({ "/work/alpha/a.md": fixture });
    const summary = await checkAdr(deps, { projectId: "proj_alpha", path: "/work/alpha/a.md" });
    assert.deepEqual(Object.keys(summary), ["path", "id", "title", "steps", "changes", "sha256"]);
    assert.equal(summary.sha256, sha(fixture));
  });
});

describe("ADR shape limits", () => {
  const withPlan = (yaml: string) => fixture.replace("```yaml plan-map\n", `\`\`\`yaml plan-map\n${yaml}`);

  it("should accept real plans and moderate nesting", () => {
    assert.equal(parseBoundedAdr(fixture).plan.title, "Reusable ADR-driven plan maps");
    assert.doesNotThrow(() => checkAdrShape(withPlan(`deep: ${"[".repeat(ADR_LIMITS.flowDepth)}${"]".repeat(ADR_LIMITS.flowDepth)}\n`)));
  });

  it("should reject deep flow nesting and oversized blocks before parsing them", async () => {
    const deep = withPlan(`deep: ${"[".repeat(400_000)}${"]".repeat(400_000)}\n`);
    const started = performance.now();
    assert.throws(() => parseBoundedAdr(deep), /more than 32 levels deep/u);
    assert.ok(performance.now() - started < 200);
    assert.throws(() => parseBoundedAdr(withPlan(`wide: [${Array(60_000).fill("a").join(",")}]\n`)), /too large to read safely/u);
    const { deps } = world({ "/work/alpha/deep.md": deep });
    await rejects(checkAdr(deps, { projectId: "proj_alpha", path: "deep.md" }), "invalid_adr");
  });
});

describe("createPlanMapHandlers", () => {
  it("should list and read only the requesting project's ADRs", async () => {
    const { deps } = world({ "/work/beta/plan.md": "secret", "/work/alpha/a.md": fixture }, JSON.stringify({ proj_alpha: "/work/alpha/a.md", proj_beta: "/work/beta/plan.md" }));
    const handlers = createPlanMapHandlers(deps);
    assert.deepEqual((await handlers.listMaps({ projectId: "proj_alpha" })).maps.map((entry) => entry.name), ["a.md"]);
    const [other] = mapEntries(["/work/beta/plan.md"]);
    assert.deepEqual(await handlers.readMap({ projectId: "proj_alpha", mapId: other?.id ?? "" }), { ok: false, message: "This ADR is not bound to this project." });
    const [own] = mapEntries(["/work/alpha/a.md"]);
    assert.equal((await handlers.readMap({ projectId: "proj_alpha", mapId: own?.id ?? "" })).ok, true);
  });

  it("should report bind failures as values with a code, not thrown errors", async () => {
    const { deps } = world({});
    const result = await createPlanMapHandlers(deps).bindMap({ projectId: "proj_alpha", path: "../beta/x.md" });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.code, "outside_project");
  });

  it("should word bind failures for the tab, not for the command line", async () => {
    const { deps } = world({ "/work/alpha/bad.md": "# not a plan" });
    const failed = deps.readFile;
    const handlers = createPlanMapHandlers(deps);
    assert.deepEqual(await handlers.bindMap({ projectId: "proj_alpha", path: " missing.md " }), {
      ok: false,
      code: "not_found",
      message: "missing.md isn't in this project. Check the path and try again.",
    });
    const invalid = await handlers.bindMap({ projectId: "proj_alpha", path: "bad.md" });
    assert.equal(invalid.ok ? "" : invalid.code, "invalid_adr");
    assert.match(invalid.ok ? "" : invalid.message, /then press Bind plan again\.$/u);
    deps.readFile = async () => {
      throw new Error("EACCES: permission denied");
    };
    const denied = await handlers.bindMap({ projectId: "proj_alpha", path: "bad.md" });
    assert.equal(denied.ok ? "" : denied.code, "unreadable");
    assert.match(denied.ok ? "" : denied.message, /EACCES/u);
    deps.readFile = failed;
  });

  it("should describe the project for the empty state", async () => {
    const { deps } = world({});
    assert.deepEqual(await createPlanMapHandlers(deps).projectInfo({ projectId: "proj_alpha" }), { ok: true, projectId: "proj_alpha", name: "Alpha", root: "/work/alpha" });
    assert.equal((await createPlanMapHandlers(deps).projectInfo({ projectId: "proj_gamma" })).ok, false);
  });
});

describe("parseMapsSetting", () => {
  it("should accept one path or a list per project and reject anything else", () => {
    assert.deepEqual(parseMapsSetting(JSON.stringify({ proj_a: "/x/a.md" }))?.get("proj_a"), ["/x/a.md"]);
    assert.deepEqual(parseMapsSetting('{"proj_a": ["/x/a.md", "/x/b.md"]}')?.get("proj_a"), ["/x/a.md", "/x/b.md"]);
    assert.equal(parseMapsSetting("")?.size, 0);
    assert.equal(parseMapsSetting('{"proj_a": "relative/adr.md"}'), null);
    assert.equal(parseMapsSetting('{"not-a-project": "/adr.md"}'), null);
    assert.equal(parseMapsSetting("{bad"), null);
  });
});
