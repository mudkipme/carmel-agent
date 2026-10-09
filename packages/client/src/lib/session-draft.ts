/** Drafts stay in this tab, isolated by signed-in user and resource. */
export function draftStorageKey(userId: string, ...parts: string[]) {
  return `carmel-draft:${[userId, ...parts].map(encodeURIComponent).join(":")}`;
}

export function readSessionDraft<T>(
  key: string | undefined,
  initial: T,
  valid: (value: unknown) => value is T,
): T {
  if (!key) return initial;
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    return valid(stored) ? stored : initial;
  } catch {
    return initial;
  }
}

export function writeSessionDraft(key: string | undefined, value: unknown) {
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable; the mounted form still retains its draft.
  }
}

export function clearSessionDraft(key: string | undefined) {
  if (!key) return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // No persisted draft to clear when storage is unavailable.
  }
}
