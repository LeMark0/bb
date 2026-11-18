import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type BridgeJsonRpcObject,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { experimental_killAllChildrenForTests, handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workDir: string;
let launchLogPath: string;
let requestLogPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "bb-codex-owner-"));
  launchLogPath = join(workDir, "launches.jsonl");
  requestLogPath = join(workDir, "requests.jsonl");
  const scriptPath = join(workDir, "script.json");
  await writeFile(
    scriptPath,
    JSON.stringify({ launchLogPath, requestLogPath, turns: [] }),
  );
  stubFakeCodexAppServer(scriptPath);
  vi.stubEnv("BB_THREAD_ID", "thr_inherited_stale");
  harness = createBridgeJsonRpcTestHarness(handleLine);
});

afterEach(async () => {
  experimental_killAllChildrenForTests();
  harness.restore();
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

async function launchedOwners(): Promise<(string | null)[]> {
  const schema = z.object({ ownerThreadId: z.string().nullable() });
  return (await readFile(launchLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)).ownerThreadId);
}

async function shellOwners(): Promise<(string | undefined)[]> {
  const schema = z.object({
    method: z.string(),
    params: z.looseObject({
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  });
  return (await readFile(requestLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)))
    .filter((entry) => entry.method === "thread/start")
    .map((entry) => {
      const owner =
        entry.params.config?.["shell_environment_policy.set.BB_THREAD_ID"];
      return typeof owner === "string" ? owner : undefined;
    });
}

async function send(
  id: number,
  method: string,
  params: BridgeJsonRpcObject,
): Promise<void> {
  harness.sendRequest(id, method, params);
  expect((await harness.waitForResponse(id)).error).toBeUndefined();
}

function threadParams(threadId: string, envVars: Record<string, string> = {}) {
  return {
    threadId,
    cwd: workDir,
    instructionMode: "append",
    options: { ...FULL_ACCESS_SESSION_OPTIONS, envVars },
  };
}

it("gives each thread's app-server its own thread id, never an inherited or supplied one", async () => {
  await send(1, "thread/start", threadParams("thr_owner_a"));
  await send(
    2,
    "thread/start",
    threadParams("thr_owner_b", { BB_THREAD_ID: "thr_supplied" }),
  );

  expect(await launchedOwners()).toEqual(["thr_owner_a", "thr_owner_b"]);
  expect(await shellOwners()).toEqual(["thr_owner_a", "thr_owner_b"]);
}, 30_000);

it.each(["resume", "fork"] as const)(
  "launches a %s with the restored thread's own id",
  async (kind) => {
    await send(1, `thread/${kind}`, {
      ...threadParams("thr_owner_restored"),
      ...(kind === "resume" ? { providerThreadId: "provider-owner" } : {}),
      ...(kind === "fork" ? { sourceProviderThreadId: "provider-owner" } : {}),
    });

    expect(await launchedOwners()).toEqual(["thr_owner_restored"]);
  },
  30_000,
);

it("rebuilds a thread's app-server with the same owner", async () => {
  await send(1, "thread/start", threadParams("thr_owner_rebuilt"));
  await send(
    2,
    "thread/start",
    threadParams("thr_owner_rebuilt", { PATH: "/usr/bin:/bin" }),
  );

  expect(await launchedOwners()).toEqual([
    "thr_owner_rebuilt",
    "thr_owner_rebuilt",
  ]);
}, 30_000);

it("launches a maintenance app-server with no owner", async () => {
  await send(1, "model/list", { envVars: {} });

  expect(await launchedOwners()).toEqual([null]);
}, 30_000);
