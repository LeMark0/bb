import { createHash } from "node:crypto";

import { PluginCliError, cliCommand, defineCli, defineRpcContract, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { MAPS_CHANGED } from "./channels.ts";
import {
  PlanFileError,
  applyAdr,
  bindAdr,
  checkAdr,
  createAdr,
  insideRoot,
  readProjectFile,
  type PlanFileDeps,
  type ProjectRoot,
} from "./plan-files.ts";

const projectIdSchema = z.string().regex(/^proj_[a-z0-9]+$/u);
const adrPathSchema = z.string().regex(/^\/[^\0]*\.md$/u);
const mapsSettingSchema = z.record(projectIdSchema, z.union([adrPathSchema, z.array(adrPathSchema).min(1)]));

export const mapEntrySchema = z.object({ id: z.string(), name: z.string(), path: z.string() }).strict();
export type MapEntry = z.infer<typeof mapEntrySchema>;

const failureSchema = z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).strict();

export const rpcContract = defineRpcContract({
  listMaps: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.object({ projectId: projectIdSchema, maps: z.array(mapEntrySchema) }).strict(),
  },
  readMap: {
    input: z.object({ projectId: projectIdSchema, mapId: z.string().max(64) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), text: z.string() }).strict(),
      z.object({ ok: z.literal(false), message: z.string() }).strict(),
    ]),
  },
  projectInfo: {
    input: z.object({ projectId: projectIdSchema }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), projectId: projectIdSchema, name: z.string(), root: z.string() }).strict(),
      failureSchema,
    ]),
  },
  bindMap: {
    input: z.object({ projectId: projectIdSchema, path: z.string().min(1).max(4096) }).strict(),
    output: z.discriminatedUnion("ok", [
      z
        .object({ ok: z.literal(true), path: z.string(), title: z.string(), steps: z.number(), alreadyBound: z.boolean() })
        .strict(),
      failureSchema,
    ]),
  },
});

export function parseMapsSetting(raw: string): Map<string, string[]> | null {
  try {
    const parsed = mapsSettingSchema.safeParse(JSON.parse(raw.trim() === "" ? "{}" : raw));
    if (!parsed.success) return null;

    return new Map(Object.entries(parsed.data).map(([project, paths]) => [project, typeof paths === "string" ? [paths] : paths]));
  } catch {
    return null;
  }
}

export function withBinding(raw: string, projectId: string, paths: string[]): string {
  const current = parseMapsSetting(raw);
  if (current === null) {
    throw new PlanFileError("settings_invalid", "The Plan Map ADRs setting is not valid JSON, so it was left unchanged.", "Fix the setting in Plan Map's settings.");
  }
  current.set(projectId, paths);

  return JSON.stringify(Object.fromEntries(current), null, 2);
}

export function mapEntries(paths: string[]): MapEntry[] {
  return paths.map((path) => ({
    id: createHash("sha256").update(path).digest("hex").slice(0, 24),
    name: path.split("/").at(-1) ?? path,
    path,
  }));
}

export type PlanMapDeps = PlanFileDeps;

export type MapsSetting = { read: () => Promise<string>; write: (raw: string) => Promise<void> };

export function createBindingStore(setting: MapsSetting) {
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);

    return run;
  };

  return {
    boundPaths: async (projectId: string) => parseMapsSetting(await setting.read())?.get(projectId) ?? [],
    addBoundPath: (projectId: string, path: string) =>
      serially(async () => {
        const raw = await setting.read();
        const paths = parseMapsSetting(raw)?.get(projectId) ?? [];
        if (paths.includes(path)) return false;
        await setting.write(withBinding(raw, projectId, [...paths, path]));

        return true;
      }),
  };
}

function failure(cause: unknown) {
  if (cause instanceof PlanFileError) return { ok: false as const, code: cause.code, message: cause.hint ? `${cause.message} ${cause.hint}` : cause.message };

  return { ok: false as const, code: "failed", message: cause instanceof Error ? cause.message.split("\n")[0] ?? "" : String(cause) };
}

function bindFailure(cause: unknown, input: string) {
  if (!(cause instanceof PlanFileError)) return failure(cause);
  if (cause.code === "not_found") return { ok: false as const, code: cause.code, message: `${input.trim()} isn't in this project. Check the path and try again.` };
  if (cause.code === "invalid_adr") return { ok: false as const, code: cause.code, message: `${cause.message} Fix the ADR, then press Bind plan again.` };

  return failure(cause);
}

export function createPlanMapHandlers(deps: PlanMapDeps) {
  return {
    listMaps: async ({ projectId }: { projectId: string }) => ({
      projectId,
      maps: mapEntries(await deps.boundPaths(projectId)),
    }),
    readMap: async ({ projectId, mapId }: { projectId: string; mapId: string }) => {
      const entry = mapEntries(await deps.boundPaths(projectId)).find((item) => item.id === mapId);
      if (!entry) return { ok: false as const, message: "This ADR is not bound to this project." };
      const project = await deps.project(projectId);
      if (project === null) return { ok: false as const, message: "This project has no machine to read the ADR from." };
      if (!insideRoot(project.root, entry.path)) {
        return { ok: false as const, message: `${entry.path} is outside this project's folder, so Plan Map won't read it. Bind a plan inside ${project.root}.` };
      }
      try {
        const file = await readProjectFile(deps, project, entry.path);

        return { ok: true as const, text: file.text };
      } catch (cause) {
        return { ok: false as const, message: cause instanceof Error ? cause.message.split("\n")[0] ?? "" : String(cause) };
      }
    },
    projectInfo: async ({ projectId }: { projectId: string }) => {
      const project = await deps.project(projectId);
      if (project === null) return { ok: false as const, code: "no_project_folder", message: "This project has no local folder." };

      return { ok: true as const, projectId, name: project.name, root: project.root };
    },
    bindMap: async ({ projectId, path }: { projectId: string; path: string }) => {
      try {
        const bound = await bindAdr(deps, { projectId, path });

        return { ok: true as const, path: bound.path, title: bound.title, steps: bound.steps, alreadyBound: bound.alreadyBound };
      } catch (cause) {
        return bindFailure(cause, path);
      }
    },
  };
}

function output(value: unknown, json: boolean, text: string) {
  return { exitCode: 0, stdout: `${json ? JSON.stringify(value, null, 2) : text}\n` };
}

async function cliRun<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof PlanFileError) throw new PluginCliError(cause.message, { code: cause.code, ...(cause.hint ? { hint: cause.hint } : {}) });
    throw cause;
  }
}

export function planMapCli(deps: PlanMapDeps) {
  const json = { type: "boolean", description: "Print machine-readable JSON" } as const;
  const where = (ctx: PluginCliContext) => ({ ...(ctx.projectId ? { projectId: ctx.projectId } : {}), ...(ctx.cwd ? { cwd: ctx.cwd } : {}) });

  return defineCli({
    name: "plan-map",
    summary: "Create, update and bind Plan Map ADRs for this project",
    description:
      "Every command works on the project of the conversation it runs in. ADRs are written only inside that project's folder, never over an existing file, and updates need the sha256 printed by check.",
    commands: {
      status: cliCommand({
        summary: "Show this project's folder and bound Plan Map ADRs",
        options: { json },
        run: (input, ctx) =>
          cliRun(async () => {
            if (!ctx.projectId) throw new PlanFileError("no_project", "This command needs a project.", "Run it from a conversation in the project.");
            const project = await deps.project(ctx.projectId);
            const maps = await deps.boundPaths(ctx.projectId);
            const value = { projectId: ctx.projectId, name: project?.name ?? null, root: project?.root ?? null, maps };
            const text = [`Project: ${value.name ?? ctx.projectId} (${ctx.projectId})`, `Folder: ${value.root ?? "none"}`, maps.length ? `Bound ADRs:\n${maps.map((path) => `  ${path}`).join("\n")}` : "Bound ADRs: none"].join("\n");

            return output(value, Boolean(input.options.json), text);
          }),
      }),
      check: cliCommand({
        summary: "Validate an ADR and print its sha256",
        positionals: [{ name: "adr", description: "ADR Markdown file", required: true }],
        options: { json },
        run: (input, ctx) =>
          cliRun(async () => {
            const summary = await checkAdr(deps, { ...where(ctx), path: input.positionals.adr });

            return output(summary, true, "");
          }),
      }),
      create: cliCommand({
        summary: "Validate a candidate and write it as a new ADR in this project; never overwrites",
        positionals: [
          { name: "candidate", description: "Validated candidate Markdown file", required: true },
          { name: "destination", description: "New ADR path inside this project, for example docs/adr/0001-feature.md", required: true },
        ],
        run: (input, ctx) =>
          cliRun(async () => output(await createAdr(deps, { ...where(ctx), candidate: input.positionals.candidate, destination: input.positionals.destination }), true, "")),
      }),
      apply: cliCommand({
        summary: "Replace an ADR with a validated candidate if it still has the expected sha256",
        positionals: [
          { name: "adr", description: "Existing ADR inside this project", required: true },
          { name: "candidate", description: "Updated candidate Markdown file", required: true },
        ],
        options: { expected: { type: "string", required: true, description: "sha256 printed by `bb plan-map check` before editing" } },
        run: (input, ctx) =>
          cliRun(async () =>
            output(
              await applyAdr(deps, { ...where(ctx), adr: input.positionals.adr, candidate: input.positionals.candidate, expected: input.options.expected }),
              true,
              "",
            ),
          ),
      }),
      bind: cliCommand({
        summary: "Show a validated ADR in this project's Plan Map tab; keeps existing maps",
        positionals: [{ name: "adr", description: "ADR inside this project", required: true }],
        run: (input, ctx) => cliRun(async () => output(await bindAdr(deps, { ...where(ctx), path: input.positionals.adr }), true, "")),
      }),
    },
  });
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    maps: {
      type: "string",
      label: "Plan Map ADRs",
      description:
        'Set by "Bind existing plan" and `bb plan-map bind`. JSON keyed by bb project id: the absolute path of that project\'s Plan Map feature ADR, or a list of them.',
      experimental_multiline: true,
      experimental_schema: z.string().refine((value) => parseMapsSetting(value) !== null, 'Use {"proj_…": "/absolute/path/to/adr.md"}'),
      default: "{}",
    },
  });

  const project = async (projectId: string): Promise<ProjectRoot | null> => {
    const record = await bb.sdk.projects.get({ projectId });
    const source = record.sources.find((item) => item.isDefault) ?? record.sources[0];
    if (!source?.hostId || !source.path) return null;

    return { projectId, name: record.name, hostId: source.hostId, root: source.path };
  };

  const bindings = createBindingStore({
    read: async () => (await settings.get()).maps,
    write: async (raw) => {
      await settings.experimental_set({ maps: raw });
    },
  });

  const deps: PlanMapDeps = {
    project,
    readFile: async ({ hostId, path, rootPath }) => {
      const file = await bb.sdk.files.read({ hostId, path, rootPath });
      const text = file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;

      return { text, sha256: file.sha256, sizeBytes: file.sizeBytes };
    },
    writeFile: async ({ hostId, path, rootPath, content, expectedSha256 }) => {
      const result = await bb.sdk.files.write({ hostId, path, rootPath, content, expectedSha256, createParents: true });

      return result.outcome === "written" ? { outcome: "written", sha256: result.sha256 } : { outcome: "conflict", currentSha256: result.currentSha256 };
    },
    boundPaths: bindings.boundPaths,
    addBoundPath: bindings.addBoundPath,
    announce: (projectId) => bb.realtime.publish(MAPS_CHANGED, { projectId }),
  };

  bb.rpc.register(rpcContract, createPlanMapHandlers(deps));
  bb.cli.register(planMapCli(deps));
}
