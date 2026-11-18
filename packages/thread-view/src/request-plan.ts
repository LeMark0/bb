import type { TimelineRequestPlan } from "@bb/server-contract";
import type {
  EventProjection,
  EventProjectionMessage,
  EventProjectionUserMessage,
} from "./event-projection-types.js";

type PlanStepsMessage = Extract<EventProjectionMessage, { kind: "plan-steps" }>;

function isInitiatingRequest(
  message: EventProjectionMessage,
): message is EventProjectionUserMessage {
  return (
    message.kind === "user" &&
    message.turnRequest.kind === "message" &&
    message.turnRequest.status !== "rejected" &&
    message.progressNote !== true
  );
}

function findLastRequest(
  messages: readonly EventProjectionMessage[],
): EventProjectionUserMessage | undefined {
  const requests = messages.filter(isInitiatingRequest);
  return requests[requests.length - 1];
}

function latestRootPlan(
  messages: readonly EventProjectionMessage[],
): PlanStepsMessage | null {
  let latest: PlanStepsMessage | null = null;
  for (const message of messages) {
    if (
      message.kind !== "plan-steps" ||
      message.parentToolCallId !== undefined ||
      message.status !== "completed"
    ) {
      continue;
    }
    if (latest === null || message.sourceSeqEnd >= latest.sourceSeqEnd) {
      latest = message;
    }
  }
  return latest;
}

function threadStartRequestsByTurn(
  projection: EventProjection,
): ReadonlyMap<string, EventProjectionUserMessage> {
  const requests = new Map<string, EventProjectionUserMessage>();
  for (const entry of projection.entries) {
    if (
      entry.kind === "projected-message" &&
      isInitiatingRequest(entry.message) &&
      entry.message.acceptedTurnId !== undefined
    ) {
      requests.set(entry.message.acceptedTurnId, entry.message);
    }
  }
  return requests;
}

export function collectRequestPlans(
  projection: EventProjection,
): ReadonlyMap<EventProjectionMessage, TimelineRequestPlan> {
  const plans = new Map<EventProjectionMessage, TimelineRequestPlan>();
  const threadStartRequests = threadStartRequestsByTurn(projection);
  for (const entry of projection.entries) {
    if (entry.kind !== "turn") continue;
    const messages = entry.turn.messages ?? [];
    const request =
      findLastRequest(messages) ?? threadStartRequests.get(entry.turn.turnId);
    if (request === undefined) continue;
    const plan = latestRootPlan(messages);
    if (plan === null) continue;
    plans.set(request, {
      revisionSeq:
        entry.turn.status === "pending"
          ? plan.sourceSeqEnd
          : Math.max(plan.sourceSeqEnd, entry.turn.sourceSeqEnd),
      steps: plan.steps,
      explanation: plan.explanation,
      turnStatus: entry.turn.status,
    });
  }
  return plans;
}
