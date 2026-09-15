import type { ImageContent } from "@earendil-works/pi-ai";

export type PendingPrompt = { text: string; images?: ImageContent[] };

/* The new-session composer creates the session on submit, then hands the first
   message to the session's chat, which sends it once it is connected. Held in
   memory only: a reload must not send it a second time. */
const pendingPrompts = new Map<string, PendingPrompt>();

export function setPendingPrompt(sessionId: string, prompt: PendingPrompt) {
  pendingPrompts.set(sessionId, prompt);
}

/** Returns the prompt at most once, so a remounted chat cannot send it twice. */
export function takePendingPrompt(sessionId: string) {
  const prompt = pendingPrompts.get(sessionId);
  pendingPrompts.delete(sessionId);
  return prompt;
}
