import type { AgentFileEntry, MessageReference } from "@carmel-agent/shared";

export const MAX_CHAT_FILE_SIZE = 20 * 1024 * 1024;

/** Upload bytes unchanged; only the resulting workspace path belongs in the prompt. */
export async function uploadChatFile(
  file: File,
  upload: (path: string, file: File) => Promise<Pick<AgentFileEntry, "path">>,
): Promise<Extract<MessageReference, { kind: "file" }>> {
  if (!file.name || file.name === "." || file.name === ".." || /[/\\\0]/.test(file.name)) {
    throw new Error("Upload filenames must not contain a path.");
  }
  if (file.size > MAX_CHAT_FILE_SIZE) throw new Error(`${file.name} exceeds the 20MB file limit.`);
  // A distinct directory preserves the filename without overwriting workspace
  // files, including an earlier upload with the same name.
  const entry = await upload(`uploads/${crypto.randomUUID()}/${file.name}`, file);
  return { kind: "file", path: entry.path };
}
