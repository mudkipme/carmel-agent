/**
 * Best-effort removal of secret values from sandbox output.
 *
 * The agent is deliberately given these values, so this is not a containment
 * boundary -- anything that wants to leak a secret can base64 it. What it stops
 * is the accident: an `env`, a `set -x`, a curl that echoes its own headers,
 * writing a live credential into a session transcript that is then stored on
 * disk and replayed into model context on every subsequent turn.
 *
 * Redaction is stateful because output arrives in chunks and a secret can
 * straddle two of them. The redactor holds back the last `maxLength - 1`
 * characters of each chunk -- enough that any partial value is still in hand
 * when the rest arrives -- and releases them on the next push or on flush.
 */

export type SecretRedactor = {
  /** Redact a chunk, returning the portion safe to release now. */
  push: (chunk: string) => string;
  /** Release whatever is still held back. Call once the stream has ended. */
  flush: () => string;
};

/**
 * Short values are left alone. A two-character secret would match constantly
 * and shred unrelated output, and the placeholder would leak its length anyway.
 */
const minRedactableLength = 4;

const passthrough: SecretRedactor = { push: (chunk) => chunk, flush: () => "" };

export function createSecretRedactor(secrets: ReadonlyArray<{ name: string; value: string }>): SecretRedactor {
  const seen = new Set<string>();
  const entries = secrets
    .filter((secret) => {
      if (secret.value.length < minRedactableLength || seen.has(secret.value)) return false;
      seen.add(secret.value);
      return true;
    })
    // Longest first, so a secret that contains a shorter one is replaced whole
    // instead of being left as a partly-redacted fragment.
    .sort((left, right) => right.value.length - left.value.length);

  if (entries.length === 0) return passthrough;

  const carry = Math.max(...entries.map((entry) => entry.value.length)) - 1;
  let pending = "";

  const redact = (text: string) => {
    let result = text;
    for (const entry of entries) result = result.split(entry.value).join(`[redacted:${entry.name}]`);
    return result;
  };

  return {
    push(chunk) {
      const redacted = redact(pending + chunk);
      if (redacted.length <= carry) {
        pending = redacted;
        return "";
      }
      pending = redacted.slice(redacted.length - carry);
      return redacted.slice(0, redacted.length - carry);
    },
    flush() {
      const remaining = redact(pending);
      pending = "";
      return remaining;
    },
  };
}
