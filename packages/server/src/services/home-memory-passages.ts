import type { HomeMemorySearchHit } from "@carmel-agent/shared";
import { hasCjk, homeMemoryQueryTerms, sameMemoryWord } from "./home-memory.ts";

export function homeMemoryPassage(note: HomeMemorySearchHit, query: string, maxChars: number) {
  const { content } = note;
  const totalLines = content.split("\n").length;
  if (content.length <= maxChars)
    return { content, fromLine: 1, toLine: totalLines, totalLines, truncated: false };
  const limit = Math.max(0, maxChars - 2);
  const padding = Math.min(100, Math.floor(limit / 4));
  const matchWidth = limit - padding * 2;
  const regionStart = note.match?.start ?? 0;
  const regionEnd = note.match?.end ?? content.length;
  const slice = content.slice(regionStart, regionEnd);
  const terms = homeMemoryQueryTerms(query);
  const cjkTerms = terms.filter(hasCjk);
  const wordTerms = terms.filter((term) => !hasCjk(term));
  const hits: Array<{ word: string; start: number }> = [];
  for (const hit of slice.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    const raw = hit[0].toLowerCase();
    const matched = wordTerms.find((term) => sameMemoryWord(term, raw));
    if (matched) hits.push({ word: matched, start: hit.index + regionStart });
  }
  if (cjkTerms.length) {
    const lowerSlice = slice.toLowerCase();
    for (const term of cjkTerms) {
      let at = lowerSlice.indexOf(term);
      while (at >= 0) {
        hits.push({ word: term, start: at + regionStart });
        at = lowerSlice.indexOf(term, at + 1);
      }
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const counts = new Map<string, number>();
  let left = 0;
  let bestTerms = 0;
  let bestHits = 0;
  let start = regionStart;
  for (let right = 0; right < hits.length; right++) {
    const hit = hits[right]!;
    counts.set(hit.word, (counts.get(hit.word) ?? 0) + 1);
    while (left < right && hit.start + hit.word.length - hits[left]!.start > matchWidth) {
      const word = hits[left++]!.word;
      const count = counts.get(word)! - 1;
      if (count) counts.set(word, count);
      else counts.delete(word);
    }
    if (counts.size > bestTerms || (counts.size === bestTerms && right - left + 1 > bestHits)) {
      bestTerms = counts.size;
      bestHits = right - left + 1;
      start = Math.max(regionStart, hits[left]!.start - padding);
    }
  }
  start = Math.max(regionStart, Math.min(start, Math.max(regionStart, regionEnd - limit)));
  const end = Math.min(regionEnd, start + limit);
  const fromLine = content.slice(0, start).split("\n").length;
  return {
    content:
      `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`.slice(
        0,
        maxChars,
      ),
    fromLine,
    toLine: fromLine + content.slice(start, end).split("\n").length - 1,
    totalLines,
    truncated: start > 0 || end < content.length,
  };
}
