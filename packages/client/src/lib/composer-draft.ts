import {
  messageReferenceSchema,
  type ChatAttachment,
  type MessageReference,
} from "@carmel-agent/shared";

export type ComposerDraft = {
  value: string;
  references: MessageReference[];
  attachments: ChatAttachment[];
};

export function isComposerDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<ComposerDraft>;
  return (
    typeof draft.value === "string" &&
    Array.isArray(draft.references) &&
    draft.references.every((reference) => messageReferenceSchema.safeParse(reference).success) &&
    Array.isArray(draft.attachments) &&
    draft.attachments.every(
      (attachment) =>
        attachment &&
        typeof attachment.id === "string" &&
        attachment.type === "image" &&
        typeof attachment.fileName === "string" &&
        typeof attachment.mimeType === "string" &&
        typeof attachment.size === "number" &&
        [attachment.content, attachment.preview, attachment.url].every(
          (part) => part === undefined || typeof part === "string",
        ),
    )
  );
}
