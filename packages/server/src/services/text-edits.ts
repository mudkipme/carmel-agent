export type TextEdit = { oldText: string; newText: string };

/**
 * Apply exact replacements the way the file `edit` tool does.
 * Every edit is matched against the original text. Each `oldText` must be
 * unique, and the matches must not overlap.
 */
export function applyTextEdits(content: string, edits: readonly TextEdit[], label: string): string {
  const source = normalizeLines(content);
  const normalized = edits.map((edit) => ({
    oldText: normalizeLines(edit.oldText),
    newText: normalizeLines(edit.newText),
  }));
  if (normalized.length === 0) {
    throw new Error(`Could not edit ${label}. edits must contain at least one replacement.`);
  }
  const matches: { editIndex: number; index: number; length: number; newText: string }[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const oldText = normalized[i].oldText;
    const single = normalized.length === 1;
    if (oldText.length === 0) {
      throw new Error(
        single
          ? `oldText must not be empty in ${label}.`
          : `edits[${i}].oldText must not be empty in ${label}.`,
      );
    }
    const count = countOccurrences(source, oldText);
    if (count === 0) {
      throw new Error(
        single
          ? `Could not find the exact text in ${label}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${i}] in ${label}. The oldText must match exactly including all whitespace and newlines.`,
      );
    }
    if (count > 1) {
      throw new Error(
        single
          ? `Found ${count} occurrences of the text in ${label}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${count} occurrences of edits[${i}] in ${label}. Each oldText must be unique. Please provide more context to make it unique.`,
      );
    }
    matches.push({
      editIndex: i,
      index: source.indexOf(oldText),
      length: oldText.length,
      newText: normalized[i].newText,
    });
  }
  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    const previous = matches[i - 1];
    const current = matches[i];
    if (previous.index + previous.length > current.index) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${label}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }
  let next = source;
  for (const match of [...matches].reverse()) {
    next = next.slice(0, match.index) + match.newText + next.slice(match.index + match.length);
  }
  if (next === source) {
    throw new Error(
      normalized.length === 1
        ? `No changes made to ${label}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${label}. The replacements produced identical content.`,
    );
  }
  return next;
}

function normalizeLines(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countOccurrences(content: string, oldText: string) {
  let count = 0;
  let from = 0;
  while (from <= content.length) {
    const at = content.indexOf(oldText, from);
    if (at < 0) return count;
    count += 1;
    from = at + oldText.length;
  }
  return count;
}
