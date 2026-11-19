import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "hono";
import type { ZodType } from "zod";
import { validationErrorMessage } from "../validation.ts";
import { ErrorSchema, OKSchema } from "./schemas.ts";

/** A router whose routes carry their OpenAPI definition and validate requests against it. */
export function createRouter<E extends Env>() {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: validationErrorMessage(result.error) }, 400);
    },
  });
}

export function json<T extends ZodType>(schema: T, description = "Successful operation") {
  return { description, content: { "application/json": { schema } } };
}

export function jsonBody<T extends ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } };
}

const binary = { schema: { type: "string", format: "binary" } } as const;

export const error = json(ErrorSchema, "Error");
export const success = json(OKSchema, "Success");

export const activeRunConflict = {
  ...json(ErrorSchema.extend({ runId: ErrorSchema.shape.error.optional() }), "Resource is busy"),
  headers: { "x-agent-run-id": { schema: { type: "string" } } },
} as const;

export const safeEntryConflict = json(
  ErrorSchema.extend({ safeEntryId: ErrorSchema.shape.error.optional() }),
  "Invalid cut point",
);

export const download = {
  description: "File bytes or a zip archive",
  headers: { "content-disposition": { schema: { type: "string" } } },
  content: { "application/octet-stream": binary, "application/zip": binary },
} as const;

export const image = {
  description: "Binary image",
  content: { "image/png": binary, "image/jpeg": binary, "image/webp": binary },
} as const;
