import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { TimelineRow } from "@bb/server-contract";
import plugin from "./server.js";
import { fakeWorkersSdk, listEntry } from "./workers-test-fixtures.js";

const startedAt = Date.now() - 5_000;

const commandRow: TimelineRow = {
  id: "cmd-1",
  threadId: "lead",
  turnId: "turn-1",
  sourceSeqStart: 2,
  sourceSeqEnd: 2,
  startedAt,
  createdAt: startedAt,
  kind: "work",
  workKind: "command",
  status: "pending",
  callId: "call-1",
  command: "pnpm exec turbo run test",
  cwd: null,
  source: null,
  output: "",
  exitCode: null,
  completedAt: null,
  approvalStatus: "waiting_for_approval",
  activityIntents: [],
  presentation: {
    label: { pending: "Running command", completed: "Ran command" },
    icon: { glyph: "Terminal" },
    title: "Run the plugin tests",
    detail: "pnpm exec turbo run test",
  },
};

async function setup() {
  const workers = fakeWorkersSdk({
    children: {
      thr_root: [
        listEntry({
          id: "lead",
          title: "Cr-34 · Сатор Арепыч · implementation",
          hasPendingInteraction: true,
        }),
      ],
      lead: [
        listEntry({
          id: "reviewer",
          parentThreadId: "lead",
          title: "Колбасный страж",
          status: "idle",
          updatedAt: Date.now() - 12 * 60_000,
        }),
      ],
    },
    timelines: { lead: { rows: [commandRow], pendingTodos: null } },
  });
  const fake = createFakePluginHost({
    sdk: { subscribe: workers.sdk.subscribe, threads: workers.sdk.threads },
  });
  await plugin(fake.bb);
  return { fake, workers };
}

describe("bb workers show", () => {
  it("prints the same rows as the card, without raw commands", async () => {
    const { fake } = await setup();
    const result = await fake.harness.behavior.runCli(["show", "thr_root"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "Workers · 1 needs approval",
      "Сатор Арепыч · implementation · Needs approval · No plan shared",
      expect.stringMatching(/^ {2}Request · Run the plugin tests \(\d+s\)$/),
      "  Колбасный страж · Idle",
      "    Not running · last update 12 min ago",
    ]);
    expect(result.stdout).not.toContain("pnpm exec");
  });

  it("defaults to the thread that runs the command and offers JSON", async () => {
    const { fake } = await setup();
    const result = await fake.harness.behavior.runCli(["show", "--json"], {
      threadId: "thr_root",
    });

    const parsed = JSON.parse(result.stdout) as { workers: unknown[] };
    expect(parsed.workers).toEqual([
      expect.objectContaining({
        threadId: "lead",
        depth: 0,
        state: "waiting-approval",
        request: "Run the plugin tests",
        plan: { kind: "none" },
      }),
      expect.objectContaining({
        threadId: "reviewer",
        parentThreadId: "lead",
        depth: 1,
        state: "idle",
        activity: null,
        plan: { kind: "unavailable" },
      }),
    ]);
  });

  it("asks for a thread id outside a thread", async () => {
    const { fake } = await setup();
    const result = await fake.harness.behavior.runCli(["show", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("thread_required");
  });

  it("says so when a thread has no workers", async () => {
    const { fake } = await setup();
    const result = await fake.harness.behavior.runCli(["show", "thr_empty"]);

    expect(result.stdout).toBe("No workers below this thread.");
  });
});
