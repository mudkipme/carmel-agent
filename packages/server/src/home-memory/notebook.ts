import type { HomeMemory } from "@carmel-agent/shared";

export const HOME_MEMORY_MAX_LINES = 200;
export const HOME_MEMORY_MAX_BYTES = 24_000;
export const HOME_MEMORY_TOPIC_INDEX_MAX_TOPICS = 40;
export const HOME_MEMORY_TOPIC_INDEX_MAX_CHARS = 2_000;
export const HOME_MEMORY_RECALL_MAX_CHARS = 6_000;

type Note = Pick<HomeMemory, "id" | "revision" | "scope" | "content"> &
  Partial<Pick<HomeMemory, "title" | "expiresAt">> & { fromLine?: number; toLine?: number };

export function cleanMemoryPromptText(value: string) {
  return value
    .replace(/<\/?[a-z_][\w-]*[^>]*>/giu, (tag) =>
      tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    )
    .replace(/```/gu, "'''")
    .trim();
}

export function renderHomeMemoryNotes(notes: readonly Note[]) {
  if (!notes.length) return "";
  return notes
    .map(({ id, scope, content, title, fromLine, toLine, expiresAt }) => {
      const cleanScope = scope ? cleanMemoryPromptText(scope) : "";
      const cleanTitle = title ? cleanMemoryPromptText(title) : "";
      const heading =
        cleanScope && cleanTitle && cleanScope.toLowerCase() !== cleanTitle.toLowerCase()
          ? `${cleanScope} / ${cleanTitle}`
          : cleanScope || cleanTitle;
      const range =
        fromLine !== undefined && toLine !== undefined ? `lines ${fromLine}–${toLine}` : "";
      const until =
        typeof expiresAt === "number" && Number.isFinite(expiresAt)
          ? `until ${new Date(expiresAt - 1).toISOString().slice(0, 10)}`
          : "";
      const meta = [heading, ...(fromLine !== undefined ? [`id: ${id}`, range] : []), until]
        .filter(Boolean)
        .join(" · ");
      const body = cleanMemoryPromptText(content)
        .replace(/\s*\n+\s*/gu, " ")
        .replace(/[ \t]+/gu, " ");
      return `- ${meta ? `[${meta}] ` : ""}${body}`;
    })
    .join("\n");
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
    const topic = (note.scope || note.title || "General").trim();
    const key = topic.normalize("NFKC").toLowerCase();
    const group = groups.get(key) ?? { scope: topic, aliases: [], notes: [] };
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
    const cleanAliases = aliases.map(cleanMemoryPromptText).filter(Boolean);
    const also = cleanAliases.length ? ` (also: ${cleanAliases.join(", ")})` : "";
    const count = `${items.length} ${items.length === 1 ? "note" : "notes"}`;
    const line = `- ${cleanMemoryPromptText(scope)}${also} — ${count}`;
    if (
      lines.length >= HOME_MEMORY_TOPIC_INDEX_MAX_TOPICS ||
      [...lines, line].join("\n").length > HOME_MEMORY_TOPIC_INDEX_MAX_CHARS - 60
    ) {
      omitted++;
      continue;
    }
    lines.push(line);
  }
  if (omitted) lines.push(`- …and ${omitted} more ${omitted === 1 ? "topic" : "topics"}`);
  return lines.length ? lines.join("\n") : undefined;
}
