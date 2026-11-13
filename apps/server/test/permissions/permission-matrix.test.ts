import {
  permissionEscalationValues,
  permissionModeValues,
  runtimePermissionPolicySchema,
  runtimePermissionScopeValues,
  threadTurnInitiatorSchema,
} from "@bb/domain";
import type { RuntimePermissionPolicy, ThreadTurnInitiator } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { markThreadDeleted, threads } from "@bb/db";
import { eq } from "drizzle-orm";
import { resolvePermissionEscalation } from "../../src/services/threads/thread-runtime-config.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

type SenderRelation =
  | "none"
  | "current-parent"
  | "other-thread"
  | "deleted-parent"
  | "parent-of-deleted-target";

const ESCALATION_CASES = [
  { initiator: "user", sender: "none", expected: "ask" },
  { initiator: "agent", sender: "current-parent", expected: "ask" },
  { initiator: "agent", sender: "none", expected: "deny" },
  { initiator: "agent", sender: "other-thread", expected: "deny" },
  { initiator: "agent", sender: "deleted-parent", expected: "deny" },
  { initiator: "agent", sender: "parent-of-deleted-target", expected: "deny" },
  { initiator: "system", sender: "none", expected: "deny" },
  { initiator: "system", sender: "current-parent", expected: "deny" },
] as const satisfies readonly {
  initiator: ThreadTurnInitiator;
  sender: SenderRelation;
  expected: "ask" | "deny";
}[];

const threadTurnInitiatorValues = threadTurnInitiatorSchema.options;

describe("permission escalation by turn initiator and sender", () => {
  it("covers every initiator", () => {
    expect(
      new Set(ESCALATION_CASES.map((testCase) => testCase.initiator)),
    ).toEqual(new Set(threadTurnInitiatorValues));
  });

  it.each(ESCALATION_CASES)(
    "$initiator from $sender → $expected",
    async ({ initiator, sender, expected }) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const parent = seedThread(harness.deps, { projectId: project.id });
        const other = seedThread(harness.deps, { projectId: project.id });
        const target = seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
        });
        if (sender === "deleted-parent") {
          harness.db
            .update(threads)
            .set({ deletedAt: Date.now() })
            .where(eq(threads.id, parent.id))
            .run();
        }
        if (sender === "parent-of-deleted-target") {
          markThreadDeleted(harness.db, harness.hub, { threadId: target.id });
        }
        const senderThreadId =
          sender === "none"
            ? null
            : sender === "other-thread"
              ? other.id
              : parent.id;

        expect(
          resolvePermissionEscalation(harness.db, {
            initiator,
            senderThreadId,
            threadId: target.id,
          }),
        ).toBe(expected);
      });
    },
  );
});

const approvalReviewerValues = ["user", "automatic"] as const;
type ReviewerFromPolicy = NonNullable<
  RuntimePermissionPolicy["approvalReviewer"]
>;
const reviewerValuesCoverUnion: [
  (typeof approvalReviewerValues)[number],
] extends [ReviewerFromPolicy]
  ? [ReviewerFromPolicy] extends [(typeof approvalReviewerValues)[number]]
    ? true
    : false
  : false = true;
void reviewerValuesCoverUnion;

const ESCALATION_INPUTS = [...permissionEscalationValues, null] as const;
const REVIEWER_INPUTS = [...approvalReviewerValues, null] as const;

type PolicyCell =
  `${(typeof permissionModeValues)[number]}|${(typeof runtimePermissionScopeValues)[number]}|${NonNullable<(typeof REVIEWER_INPUTS)[number]> | "-"}|${NonNullable<(typeof ESCALATION_INPUTS)[number]> | "-"}`;

const ACCEPTED_POLICY_SHAPES: readonly PolicyCell[] = [
  "accept-edits|workspace|user|ask",
  "accept-edits|workspace|user|deny",
  "auto|workspace|automatic|ask",
  "auto|workspace|automatic|deny",
  "full|full|-|-",
];

const POLICY_CELLS = permissionModeValues.flatMap((permissionMode) =>
  runtimePermissionScopeValues.flatMap((permissionScope) =>
    REVIEWER_INPUTS.flatMap((approvalReviewer) =>
      ESCALATION_INPUTS.map(
        (permissionEscalation) =>
          ({
            permissionMode,
            permissionScope,
            approvalReviewer,
            permissionEscalation,
          }) as const,
      ),
    ),
  ),
);

describe("runtime permission policy shapes", () => {
  it.each(POLICY_CELLS)(
    "$permissionMode × $permissionScope × $approvalReviewer × $permissionEscalation",
    (cell) => {
      const key: PolicyCell = `${cell.permissionMode}|${cell.permissionScope}|${cell.approvalReviewer ?? "-"}|${cell.permissionEscalation ?? "-"}`;
      expect(runtimePermissionPolicySchema.safeParse(cell).success).toBe(
        ACCEPTED_POLICY_SHAPES.includes(key),
      );
    },
  );
});
