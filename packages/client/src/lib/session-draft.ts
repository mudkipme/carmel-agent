/** Drafts stay in this tab, isolated by signed-in user and resource. */
const memoryDrafts = new Map<string, unknown>();

export function draftStorageKey(userId: string, ...parts: string[]) {
  return `carmel-draft:${[userId, ...parts].map(encodeURIComponent).join(":")}`;
}

export function readSessionDraft<T>(
  key: string | undefined,
  initial: T,
  valid: (value: unknown) => value is T,
): T {
  if (!key) return initial;
  const cached = memoryDrafts.get(key);
  if (valid(cached)) return cached;
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    return valid(stored) ? stored : initial;
  } catch {
    return initial;
  }
}

export function writeSessionDraft(key: string | undefined, value: unknown) {
  if (!key) return;
  // Preserve navigation drafts even when storage is blocked or an image exceeds its quota.
  memoryDrafts.set(key, value);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The in-memory copy still survives navigation in this tab.
  }
}

export function clearSessionDraft(key: string | undefined) {
  if (!key) return;
  memoryDrafts.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // No persisted draft to clear when storage is unavailable.
  }
}
