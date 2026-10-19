import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MessageReference } from "./schemas.ts";

/** Application metadata stored alongside the native model-facing input. */
export type ReferenceMessage = AgentMessage & {
  references?: MessageReference[];
  referenceContext?: string;
};

export function getMessageReferences(message: AgentMessage): MessageReference[] {
  return (message as ReferenceMessage).references ?? [];
}

export function referenceKey(reference: MessageReference) {
  return reference.kind === "session"
    ? `session:${reference.sessionId}`
    : `${reference.kind}:${reference.path}`;
}

export function referenceLabel(reference: MessageReference) {
  return reference.kind === "session" ? reference.label : reference.path;
}
