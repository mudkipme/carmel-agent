import type { MessageReference } from "@carmel-agent/shared";

type PathReference = Exclude<MessageReference, { kind: "session" }>;
export type ComposerSelection = { start: number; end: number };

export function inlineReferenceToken(reference: PathReference) {
  const path =
    reference.kind === "folder" ? reference.path.replace(/\/+$/, "") + "/" : reference.path;
  // Quoting keeps paths with spaces, quotes, or punctuation unambiguous.
  return "@" + (/^[\p{L}\p{N}_./~-]+$/u.test(path) ? path : JSON.stringify(path));
}

export function hasInlineReference(text: string, reference: MessageReference) {
  if (reference.kind === "session") return false;
  const token = inlineReferenceToken(reference);
  let index = text.indexOf(token);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + token.length];
    if ((!before || /[\s([{]/.test(before)) && (!after || /[\s,;:!?()[\]{}]/.test(after)))
      return true;
    index = text.indexOf(token, index + token.length);
  }
  return false;
}

/** Replace the trigger or selected text without moving the surrounding draft. */
export function insertInlineReference(
  text: string,
  selection: ComposerSelection,
  reference: PathReference,
) {
  const before = text.slice(0, selection.start);
  const after = text.slice(selection.end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const token = inlineReferenceToken(reference);
  const separator = after.startsWith(" ") ? "" : " ";
  return {
    text: before + prefix + token + separator + after,
    // Reuse an existing space after the mention, leaving the rest of the suffix intact.
    cursor: before.length + prefix.length + token.length + 1,
  };
}
