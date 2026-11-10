export const INIT_REQUEST_OPENING = "Initialise a Plan Map for this project";

export function initRequest(projectName: string): string {
  return [
    `${INIT_REQUEST_OPENING}, “${projectName}”. Use the plan-map skill.`,
    "",
    "1. Run `bb plan-map status`, then look in the project folder for an existing Plan Map ADR, plan or decision record. Reuse one that fits, and tell me what you found before creating anything new.",
    "2. If none fits, draft one feature ADR from the project's own evidence. Keep the decision proposed unless I accept it, and only mark progress you can show evidence for. Where progress is unknown, say so in the step's notes and ask me.",
    "3. Check the draft with `bb plan-map check`, write it with `bb plan-map create` (it never overwrites a file), then show it in the Plan Map tab with `bb plan-map bind`.",
  ].join("\n");
}

export function hasInitRequest(draft: string): boolean {
  return draft.includes(INIT_REQUEST_OPENING);
}
