/**
 * Narrow an unknown value to a plain object. Arrays are excluded so callers can
 * index string keys safely. Used wherever untrusted JSON is walked: message
 * content parts, imported transcripts, and display serialization.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
