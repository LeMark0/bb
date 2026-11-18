import {
  createQueuedThreadMessage,
  getThread,
  listHeldProgressQueuedThreadMessages,
  type ClaimedQueuedThreadMessageRow,
  type DbQueryConnection,
  type QueuedThreadMessageRow,
} from "@bb/db";
import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  type PromptInput,
  type Thread,
  type ThreadQueuedMessage,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { getActiveTurnId } from "./thread-events.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import {
  ensureThreadQueueIsWritable,
  formatAgentThreadInput,
  type HeldProgressPart,
} from "./thread-send.js";

interface HoldChildProgressUpdateArgs {
  endsTurn: boolean;
  input: PromptInput[];
  senderThreadId: string | undefined;
  thread: Thread;
}

function queuedBefore(
  row: QueuedThreadMessageRow,
  lead: ClaimedQueuedThreadMessageRow,
): boolean {
  return (
    row.sortKey < lead.sortKey ||
    (row.sortKey === lead.sortKey && row.id < lead.id)
  );
}

export function listHeldProgressForDispatch(
  db: DbQueryConnection,
  threadId: string,
  claimed: readonly ClaimedQueuedThreadMessageRow[] | null,
): QueuedThreadMessageRow[] {
  const held = listHeldProgressQueuedThreadMessages(db, threadId).filter(
    (row) => row.senderThreadId !== null,
  );
  const lead = claimed?.[0];
  return lead === undefined
    ? held
    : held.filter((row) => queuedBefore(row, lead));
}

export function heldProgressParts(
  rows: readonly QueuedThreadMessageRow[],
): HeldProgressPart[] {
  return rows.flatMap((row) =>
    row.senderThreadId === null
      ? []
      : [
          {
            input: formatAgentThreadInput({
              input: toThreadQueuedMessage(row).content,
              senderThreadId: row.senderThreadId,
            }),
            senderThreadId: row.senderThreadId,
          },
        ],
  );
}

function isChildOf(
  db: DbQueryConnection,
  senderThreadId: string | undefined,
  parent: Thread,
): senderThreadId is string {
  if (senderThreadId === undefined) return false;
  const sender = getThread(db, senderThreadId);
  return (
    sender !== null &&
    sender.deletedAt === null &&
    sender.parentThreadId === parent.id
  );
}

export async function holdChildProgressUpdate(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: HoldChildProgressUpdateArgs,
): Promise<ThreadQueuedMessage | null> {
  if (args.input.some((item) => item.type !== "text")) {
    throw new ApiError(
      400,
      "invalid_request",
      "A progress update carries text only",
    );
  }
  if (
    isStandaloneBuiltinClearCommand(args.input) ||
    isStandaloneBuiltinCompactCommand(args.input)
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "A progress update cannot be a thread command",
    );
  }
  if (!isChildOf(deps.db, args.senderThreadId, args.thread)) return null;
  ensureThreadQueueIsWritable(args.thread);
  const endsTurnId = args.endsTurn
    ? getActiveTurnId(deps, args.senderThreadId)
    : null;
  if (args.endsTurn && endsTurnId === null) {
    throw new ApiError(
      400,
      "invalid_request",
      "progressEndsTurn needs the sender to be running a turn",
    );
  }
  const execution = await buildExecutionOptions(
    deps,
    {},
    { threadId: args.thread.id },
  );
  const row = createQueuedThreadMessage(deps.db, deps.hub, {
    threadId: args.thread.id,
    content: args.input,
    senderThreadId: args.senderThreadId,
    model: execution.model,
    reasoningLevel: execution.reasoningLevel,
    permissionMode: execution.permissionMode,
    serviceTier: execution.serviceTier,
    waitingOn:
      endsTurnId === null
        ? { kind: "progress" }
        : { kind: "progress", endsTurnId },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
  return toThreadQueuedMessage(row);
}
