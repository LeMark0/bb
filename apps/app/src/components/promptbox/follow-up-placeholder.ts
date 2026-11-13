import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import { assertNever } from "@bb/core-ui";
import { modifierSubmitShortcutLabel } from "./modifier-submit-shortcut";

type FollowUpPlaceholderState =
  | ThreadRuntimeDisplayStatus
  | "active-steers-on-enter"
  | "active-queues-on-enter";

export function getFollowUpPromptPlaceholder(
  displayStatus: FollowUpPlaceholderState,
): string {
  switch (displayStatus) {
    case "provisioning":
      return "Setting up workspace...";
    case "starting":
      return "Starting thread...";
    case "stopping":
      return "Queue a message to run after the stop";
    case "waiting-for-host":
      return "Queue a message for when the host reconnects";
    case "active-steers-on-enter":
      return `Steer this run, or ${modifierSubmitShortcutLabel()} to queue a message for after it`;
    case "active-queues-on-enter":
      return "Queue a message for after this run";
    case "error":
      return "Retry by sending a follow-up message";
    case "pending":
    case "idle":
    case "active":
      return "Ask for a follow-up. @ to mention files, folders, sections, or threads";
    default:
      return assertNever(displayStatus);
  }
}

export function getCompactFollowUpPromptPlaceholder(
  displayStatus: FollowUpPlaceholderState,
): string {
  switch (displayStatus) {
    case "provisioning":
      return "Setting up...";
    case "starting":
      return "Starting...";
    case "stopping":
      return "Queue for after the stop";
    case "waiting-for-host":
      return "Queue for when the host is back";
    case "active-steers-on-enter":
      return "Steer this run";
    case "active-queues-on-enter":
      return "Queue for after this run";
    case "error":
      return "Send a follow-up";
    case "pending":
    case "idle":
    case "active":
      return "Ask a follow-up";
    default:
      return assertNever(displayStatus);
  }
}
