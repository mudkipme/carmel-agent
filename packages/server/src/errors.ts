/** The one way to turn an unknown thrown value into a human-readable message. */
export function errorMessage(error: unknown, fallback = "Unexpected error") {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}
