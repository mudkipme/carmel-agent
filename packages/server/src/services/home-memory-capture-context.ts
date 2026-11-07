import type { HomeMemorySearchHit } from "@carmel-agent/shared";
import { homeMemoryPassage } from "./home-memory-passages.ts";

type Note = HomeMemorySearchHit & { slot: string };

export function homeCaptureContext(
  notes: Note[],
  query: string,
  recalled: HomeMemorySearchHit[] = [],
) {
  const ranks = new Map(recalled.map((note, index) => [note.id, index]));
  const ordered = [...notes].sort(
    (a, b) =>
      (ranks.get(a.id) ?? recalled.length) - (ranks.get(b.id) ?? recalled.length) ||
      Number(b.origin === "automatic" && !b.pinned) -
        Number(a.origin === "automatic" && !a.pinned) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  const inventory = [];
  let inventoryChars = 2;
  for (const note of ordered) {
    const item = {
      id: note.id,
      revision: note.revision,
      slot: note.slot,
      title: note.title,
      scope: note.scope,
      origin: note.origin,
      pinned: note.pinned,
      placement: note.placement,
      summary: homeMemoryPassage(note, query, 160).content,
    };
    const size = JSON.stringify(item).length + 1;
    if (inventoryChars + size > 12000) continue;
    inventory.push(item);
    inventoryChars += size;
  }
  const existing = [];
  let existingChars = inventoryChars;
  for (const note of ordered) {
    const hit = recalled.find((item) => item.id === note.id);
    const passage = homeMemoryPassage({ ...note, match: hit?.match }, query, 1000);
    const item = {
      id: note.id,
      revision: note.revision,
      slot: note.slot,
      title: note.title,
      scope: note.scope,
      origin: note.origin,
      pinned: note.pinned,
      placement: note.placement,
      aliases: note.aliases,
      expiresAt: note.expiresAt,
      ...passage,
    };
    const size = JSON.stringify(item).length + 1;
    if (existingChars + size > 23900) continue;
    existing.push(item);
    existingChars += size;
  }
  return { inventory, existing, omitted: notes.length - inventory.length };
}
