import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { z } from "zod";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const SELECTED_THREAD_ID = "thr_contextsel1";
const WORKER_THREAD_ID = "thr_contextwrk1";

const coordinatorWindow = {
  modelContextWindow: 872_000,
  modelAutoCompactTokenLimit: 784_800,
} as const;

const constructionRequestSchema = z.object({
  method: z.enum(["thread/start", "thread/resume", "thread/fork"]),
  params: z.looseObject({
    threadId: z.string().optional(),
    config: z.record(z.string(), z.unknown()),
  }),
});

let harness: ReturnType<typeof createBridgeJsonRpcTestHarness>;
let workspaceDir: string;
let requestLogPath: string;
let nextRequestId: number;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-codex-context-window-"));
  requestLogPath = join(workspaceDir, "requests.jsonl");
  const scriptPath = join(workspaceDir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ requestLogPath }));
  stubFakeCodexAppServer(scriptPath);
  harness = createBridgeJsonRpcTestHarness(handleLine);
  nextRequestId = 1;
});

afterEach(async () => {
  for (const threadId of [SELECTED_THREAD_ID, WORKER_THREAD_ID]) {
    const cleanupId = nextRequestId++;
    harness.sendRequest(cleanupId, "thread/stop", {
      threadId,
      providerThreadId: "context-window-cleanup",
      intent: "release",
      activeTurnId: null,
    });
    await harness.waitForResponse(cleanupId).catch(() => undefined);
  }
  harness.restore();
  vi.unstubAllEnvs();
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function request(
  method: string,
  params: Parameters<typeof harness.sendRequest>[2],
) {
  const id = nextRequestId++;
  harness.sendRequest(id, method, params);
  const response = await harness.waitForResponse(id);
  expect(response.error).toBeUndefined();
  return response;
}

function sessionOptions(providerOptions?: Record<string, number>) {
  return {
    ...FULL_ACCESS_SESSION_OPTIONS,
    reasoningLevel: "xhigh",
    providerOptions: { memoryEnabled: false, ...providerOptions },
  };
}

async function startThread(
  threadId: string,
  providerOptions?: Record<string, number>,
): Promise<string> {
  const started = await request("thread/start", {
    threadId,
    cwd: workspaceDir,
    instructionMode: "append",
    options: sessionOptions(providerOptions),
  });
  return z.object({ providerThreadId: z.string() }).parse(started.result)
    .providerThreadId;
}

async function runTurn(args: {
  threadId: string;
  providerThreadId: string;
  clientRequestId: string;
  providerOptions?: Record<string, number>;
}): Promise<void> {
  await request("turn/start", {
    threadId: args.threadId,
    providerThreadId: args.providerThreadId,
    clientRequestId: args.clientRequestId,
    input: [{ type: "text", text: "say hello", mentions: [] }],
    options: sessionOptions(args.providerOptions),
  });
}

function constructionRequests() {
  return readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .flatMap((entry) => {
      const parsed = constructionRequestSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
}

function sessionReplacements() {
  return harness.messages.filter(
    (message) => message.method === "session/replaced",
  );
}

it.each(["start", "resume"] as const)(
  "sends the selected window when constructing a %s session and leaves an unselected worker on Codex defaults",
  async (kind) => {
    await request(`thread/${kind}`, {
      threadId: SELECTED_THREAD_ID,
      ...(kind === "resume" ? { providerThreadId: "codex-coordinator" } : {}),
      cwd: workspaceDir,
      instructionMode: "append",
      options: sessionOptions(coordinatorWindow),
    });
    await startThread(WORKER_THREAD_ID);

    const [coordinator, worker] = constructionRequests();
    expect(coordinator).toMatchObject({
      method: `thread/${kind}`,
      params: {
        ...(kind === "resume" ? { threadId: "codex-coordinator" } : {}),
        config: {
          model_context_window: 872_000,
          model_auto_compact_token_limit: 784_800,
          model_reasoning_effort: "xhigh",
          "memories.use_memories": false,
        },
      },
    });
    expect(worker?.method).toBe("thread/start");
    expect(worker?.params.config).toMatchObject({
      model_reasoning_effort: "xhigh",
      "memories.use_memories": false,
    });
    expect(worker?.params.config).not.toHaveProperty("model_context_window");
    expect(worker?.params.config).not.toHaveProperty(
      "model_auto_compact_token_limit",
    );
  },
  30_000,
);

it("rebuilds a live session on the same Codex thread when the window is added, changed or removed", async () => {
  const providerThreadId = await startThread(SELECTED_THREAD_ID);
  const steps = [
    {
      clientRequestId: "creq_ctxwindwza",
      providerOptions: undefined,
      rebuilt: false,
    },
    {
      clientRequestId: "creq_ctxwindwzb",
      providerOptions: coordinatorWindow,
      rebuilt: true,
    },
    {
      clientRequestId: "creq_ctxwindwzc",
      providerOptions: coordinatorWindow,
      rebuilt: false,
    },
    {
      clientRequestId: "creq_ctxwindwzd",
      providerOptions: { modelContextWindow: 872_000 },
      rebuilt: true,
    },
    {
      clientRequestId: "creq_ctxwindwze",
      providerOptions: undefined,
      rebuilt: true,
    },
  ];
  const expectedConfigs: Array<Record<string, unknown> | undefined> = [];

  for (const step of steps) {
    const replacementsBefore = sessionReplacements().length;
    await runTurn({
      threadId: SELECTED_THREAD_ID,
      providerThreadId,
      clientRequestId: step.clientRequestId,
      providerOptions: step.providerOptions,
    });
    expect(sessionReplacements().length - replacementsBefore).toBe(
      step.rebuilt ? 1 : 0,
    );
    if (step.rebuilt) {
      expectedConfigs.push(step.providerOptions);
    }
  }

  const resumes = constructionRequests().filter(
    (entry) => entry.method === "thread/resume",
  );
  expect(resumes.map((entry) => entry.params.threadId)).toEqual([
    providerThreadId,
    providerThreadId,
    providerThreadId,
  ]);
  expect(
    resumes.map((entry) => ({
      contextWindow: entry.params.config.model_context_window,
      autoCompactTokenLimit: entry.params.config.model_auto_compact_token_limit,
    })),
  ).toEqual(
    expectedConfigs.map((options) => ({
      contextWindow: options?.modelContextWindow,
      autoCompactTokenLimit: options?.modelAutoCompactTokenLimit,
    })),
  );
  expect(sessionReplacements().map((message) => message.params)).toEqual(
    resumes.map(() =>
      expect.objectContaining({
        threadId: SELECTED_THREAD_ID,
        providerThreadId,
        contextLost: false,
      }),
    ),
  );
}, 60_000);
