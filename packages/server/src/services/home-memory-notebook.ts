import type { HomeMemory } from "@carmel-agent/shared";

export const HOME_MEMORY_MAX_LINES = 200;
export const HOME_MEMORY_MAX_BYTES = 24_000;
export const HOME_MEMORY_TOPIC_INDEX_MAX_TOPICS = 40;
export const HOME_MEMORY_TOPIC_INDEX_MAX_CHARS = 2_000;
export const HOME_MEMORY_RECALL_MAX_CHARS = 6_000;

type Note = Pick<HomeMemory, "id" | "revision" | "scope" | "content">;

function memoryJson(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function renderHomeMemoryNotes(notes: readonly Note[]) {
  if (!notes.length) return "";
  return `[\n${notes.map(({ id, revision, scope, content }) => memoryJson({ id, revision, scope, content })).join(",\n")}\n]`;
}

export function homeMemoryNotebookSize(notes: readonly Note[]) {
  const text = renderHomeMemoryNotes(notes);
  return { lines: text ? text.split("\n").length : 0, bytes: Buffer.byteLength(text, "utf8") };
}

export function homeMemoryNotebookFits(notes: readonly Note[]) {
  const size = homeMemoryNotebookSize(notes);
  return size.lines <= HOME_MEMORY_MAX_LINES && size.bytes <= HOME_MEMORY_MAX_BYTES;
}

export function homeMemoryTopicGroups(notes: readonly HomeMemory[]) {
  const groups = new Map<string, { scope: string; aliases: string[]; notes: HomeMemory[] }>();
  for (const note of notes) {
    if (note.pinned || note.placement === "core") continue;
    const key = note.scope.normalize("NFKC").toLowerCase().trim();
    const group = groups.get(key) ?? { scope: note.scope, aliases: [], notes: [] };
    group.notes.push(note);
    group.aliases = [...new Set([...group.aliases, ...note.aliases])].slice(0, 12);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}

export function renderHomeMemoryTopicIndex(notes: readonly HomeMemory[]) {
  const groups = homeMemoryTopicGroups(notes);
  const lines: string[] = [];
  let omitted = 0;
  for (const { scope, aliases, notes: items } of groups) {
    const line = memoryJson({ scope, aliases, notes: items.length });
    if (
      lines.length >= HOME_MEMORY_TOPIC_INDEX_MAX_TOPICS ||
      [...lines, line].join("\n").length > HOME_MEMORY_TOPIC_INDEX_MAX_CHARS - 60
    ) {
      omitted++;
      continue;
    }
    lines.push(line);
  }
  if (omitted) lines.push(JSON.stringify({ omittedTopics: omitted }));
  return lines.length ? lines.join("\n") : undefined;
}
