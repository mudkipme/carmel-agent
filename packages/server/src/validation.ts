import { zValidator } from "@hono/zod-validator";
import { z, ZodError } from "zod";
export * from "@carmel-agent/shared";

export function jsonValidator<TSchema extends z.ZodType>(schema: TSchema) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) return c.json({ error: validationErrorMessage(result.error) }, 400);
  });
}

export function isValidationError(error: unknown) {
  return error instanceof ZodError;
}

export function validationErrorMessage(error: unknown) {
  if (!(error instanceof ZodError)) return "Invalid request body.";
  const issue = error.issues[0];
  if (!issue) return "Invalid request body.";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}
