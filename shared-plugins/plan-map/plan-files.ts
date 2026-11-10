import { posix } from "node:path";

import { parseBoundedAdr } from "./adr-guard.ts";
import { validateUpdate } from "./upstream/lib/adr.ts";

export const MAX_ADR_BYTES = 1_000_000;

export type ProjectRoot = { projectId: string; name: string; hostId: string; root: string };
export type ReadResult = { text: string; sha256: string; sizeBytes: number };
export type WriteResult = { outcome: "written"; sha256: string } | { outcome: "conflict"; currentSha256: string | null };

export type PlanFileDeps = {
  project: (projectId: string) => Promise<ProjectRoot | null>;
  readFile: (args: { hostId: string; path: string; rootPath: string }) => Promise<ReadResult>;
  writeFile: (args: { hostId: string; path: string; rootPath: string; content: string; expectedSha256: string | null }) => Promise<WriteResult>;
  boundPaths: (projectId: string) => Promise<string[]>;
  addBoundPath: (projectId: string, path: string) => Promise<boolean>;
  announce: (projectId: string) => void;
};

export type AdrSummary = { path: string; id: string; title: string; steps: number; changes: number; sha256: string };

export class PlanFileError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function insideRoot(root: string, path: string): boolean {
  const base = posix.normalize(root).replace(/\/+$/u, "");

  return path === base || path.startsWith(`${base}/`);
}

export function resolveInProject(root: string, input: string): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.includes("\0")) throw new PlanFileError("invalid_path", "Enter the path of a Markdown ADR in this project.");
  const path = posix.normalize(posix.isAbsolute(trimmed) ? trimmed : posix.join(root, trimmed));
  if (!insideRoot(root, path)) {
    throw new PlanFileError("outside_project", `${trimmed} is outside this project (${root}).`, "Use a path inside the project folder.");
  }
  if (!path.endsWith(".md")) throw new PlanFileError("not_markdown", `${trimmed} is not a Markdown (.md) file.`);

  return path;
}

export function resolveForCommand(root: string, cwd: string | undefined, input: string): string {
  const trimmed = input.trim();
  if (posix.isAbsolute(trimmed) || !cwd) return resolveInProject(root, trimmed);
  const base = posix.normalize(cwd);
  if (!insideRoot(root, base)) return resolveInProject(root, trimmed);

  return resolveInProject(root, posix.join(base, trimmed));
}

function summarise(path: string, text: string, sha256: string): AdrSummary {
  const { plan } = parseBoundedAdr(text);

  return { path, id: plan.id, title: plan.title, steps: plan.steps.length, changes: plan.changes.length, sha256 };
}

function invalid(path: string, cause: unknown): PlanFileError {
  const message = cause instanceof Error ? cause.message : String(cause);

  return new PlanFileError("invalid_adr", `${path} is not a valid Plan Map ADR:\n${message}`, "Fix the ADR, then run the command again.");
}

async function requireProject(deps: PlanFileDeps, projectId: string | undefined): Promise<ProjectRoot> {
  if (!projectId) throw new PlanFileError("no_project", "This command needs a project.", "Run it from a conversation in the project.");
  const project = await deps.project(projectId);
  if (!project) throw new PlanFileError("no_project_folder", "This project has no local folder to read the ADR from.");

  return project;
}

function isMissing(cause: unknown, message: string): boolean {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";

  return code === "ENOENT" || code === "not_found" || /ENOENT|no such file/i.test(message);
}

export async function readProjectFile(deps: PlanFileDeps, project: ProjectRoot, path: string): Promise<ReadResult> {
  if (!insideRoot(project.root, path) || !path.endsWith(".md")) {
    throw new PlanFileError("outside_project", `${path} is outside this project (${project.root}).`, "Use a Markdown file inside the project folder.");
  }
  let file: ReadResult;
  try {
    file = await deps.readFile({ hostId: project.hostId, path, rootPath: project.root });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    if (isMissing(cause, message)) throw new PlanFileError("not_found", `${path} doesn't exist.`, "Check the path and try again.");
    throw new PlanFileError("unreadable", `Cannot read ${path}: ${message}`);
  }
  if (file.sizeBytes > MAX_ADR_BYTES) throw new PlanFileError("too_large", `${path} is over 1 MB.`);

  return file;
}

export async function checkAdr(deps: PlanFileDeps, args: { projectId?: string; cwd?: string; path: string }): Promise<AdrSummary> {
  const project = await requireProject(deps, args.projectId);
  const path = resolveForCommand(project.root, args.cwd, args.path);
  const file = await readProjectFile(deps, project, path);
  try {
    return summarise(path, file.text, file.sha256);
  } catch (cause) {
    throw invalid(path, cause);
  }
}

export async function createAdr(
  deps: PlanFileDeps,
  args: { projectId?: string; cwd?: string; candidate: string; destination: string },
): Promise<AdrSummary> {
  const project = await requireProject(deps, args.projectId);
  const candidatePath = resolveForCommand(project.root, args.cwd, args.candidate);
  const destination = resolveForCommand(project.root, args.cwd, args.destination);
  const candidate = await readProjectFile(deps, project, candidatePath);
  try {
    parseBoundedAdr(candidate.text);
  } catch (cause) {
    throw invalid(candidatePath, cause);
  }
  const written = await deps.writeFile({ hostId: project.hostId, path: destination, rootPath: project.root, content: candidate.text, expectedSha256: null });
  if (written.outcome === "conflict") {
    throw new PlanFileError("exists", `${destination} already exists. Nothing was overwritten.`, "Update it with `bb plan-map apply` and the sha256 from `bb plan-map check`.");
  }

  return summarise(destination, candidate.text, written.sha256);
}

export async function applyAdr(
  deps: PlanFileDeps,
  args: { projectId?: string; cwd?: string; adr: string; candidate: string; expected: string },
): Promise<AdrSummary> {
  const project = await requireProject(deps, args.projectId);
  const adrPath = resolveForCommand(project.root, args.cwd, args.adr);
  const candidatePath = resolveForCommand(project.root, args.cwd, args.candidate);
  const before = await readProjectFile(deps, project, adrPath);
  if (before.sha256 !== args.expected) {
    throw new PlanFileError("stale", "ADR changed since it was read. Re-read and reconcile this update.", `Current sha256: ${before.sha256}`);
  }
  const after = await readProjectFile(deps, project, candidatePath);
  let beforePlan;
  let afterPlan;
  try {
    beforePlan = parseBoundedAdr(before.text).plan;
  } catch (cause) {
    throw invalid(adrPath, cause);
  }
  try {
    afterPlan = parseBoundedAdr(after.text).plan;
  } catch (cause) {
    throw invalid(candidatePath, cause);
  }
  try {
    validateUpdate(beforePlan, afterPlan);
  } catch (cause) {
    throw new PlanFileError("rejected_update", cause instanceof Error ? cause.message : String(cause));
  }
  const written = await deps.writeFile({ hostId: project.hostId, path: adrPath, rootPath: project.root, content: after.text, expectedSha256: before.sha256 });
  if (written.outcome === "conflict") {
    throw new PlanFileError("stale", "Concurrent ADR update. Re-read the file.", `Current sha256: ${written.currentSha256 ?? "deleted"}`);
  }

  return summarise(adrPath, after.text, written.sha256);
}

export type BindResult = AdrSummary & { alreadyBound: boolean };

export async function bindAdr(deps: PlanFileDeps, args: { projectId?: string; cwd?: string; path: string }): Promise<BindResult> {
  const project = await requireProject(deps, args.projectId);
  const path = resolveForCommand(project.root, args.cwd, args.path);
  const file = await readProjectFile(deps, project, path);
  let summary: AdrSummary;
  try {
    summary = summarise(path, file.text, file.sha256);
  } catch (cause) {
    throw invalid(path, cause);
  }
  const added = await deps.addBoundPath(project.projectId, path);
  if (added) deps.announce(project.projectId);

  return { ...summary, alreadyBound: !added };
}
