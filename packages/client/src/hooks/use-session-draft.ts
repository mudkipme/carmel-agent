import { useCallback, useRef, useState, type SetStateAction } from "react";
import { readSessionDraft, writeSessionDraft } from "@/lib/session-draft";

/** Callers key their form by resource; write immediately so navigation cannot lose a keystroke. */
export function useSessionDraft<T>(
  key: string | undefined,
  initial: T,
  valid: (value: unknown) => value is T,
) {
  const [value, setValue] = useState(() =>
    readSessionDraft(key, initial, valid),
  );
  const current = useRef(value);
  const update = useCallback(
    (next: SetStateAction<T>) => {
      const draft =
        typeof next === "function"
          ? (next as (value: T) => T)(current.current)
          : next;
      current.current = draft;
      writeSessionDraft(key, draft);
      setValue(draft);
    },
    [key],
  );
  return [value, update] as const;
}
