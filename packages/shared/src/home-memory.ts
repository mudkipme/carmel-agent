import { z } from "zod";

export const homeMemoryModeSchema = z.enum(["off", "manual", "automatic"]);
export const homeMemoryKindSchema = z.enum(["preference", "fact", "decision"]);
export const homeMemoryPlacementSchema = z.enum(["core", "topic"]);
export const homeMemoryAliasesSchema = z.array(z.string().trim().min(1).max(40)).max(12);
export const homeMemoryInputSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    scope: z.string().trim().max(120).default(""),
    kind: homeMemoryKindSchema.default("fact"),
    placement: homeMemoryPlacementSchema.default("topic"),
    aliases: homeMemoryAliasesSchema.default([]),
    expiresAt: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const homeMemoryPatchSchema = z
  .object({
    content: z.string().trim().min(1).max(2000).optional(),
    scope: z.string().trim().max(120).optional(),
    kind: homeMemoryKindSchema.optional(),
    placement: homeMemoryPlacementSchema.optional(),
    aliases: homeMemoryAliasesSchema.optional(),
    expiresAt: z.number().int().positive().nullable().optional(),
    expectedRevision: z.number().int().positive(),
    pinned: z.boolean().optional(),
  })
  .strict();
export const homeMemorySettingsSchema = z
  .object({
    mode: homeMemoryModeSchema,
  })
  .strict();
export type HomeMemoryInput = z.input<typeof homeMemoryInputSchema>;
export type HomeMemoryPatch = z.input<typeof homeMemoryPatchSchema>;
export type HomeMemoryMode = z.infer<typeof homeMemoryModeSchema>;
export type HomeMemory = z.output<typeof homeMemoryInputSchema> & {
  id: string;
  revision: number;
  pinned: boolean;
  origin: "manual" | "explicit" | "automatic";
  sourceEventId: string | null;
  sourceEntryId: string | null;
  sourceQuote: string | null;
  createdAt: number;
  updatedAt: number;
};
export type HomeMemoryRevision = {
  revision: number;
  content: string;
  scope: string;
  kind: HomeMemory["kind"];
  placement?: HomeMemory["placement"];
  aliases?: string[];
  expiresAt: number | null;
  createdAt: number;
};
/** Internal diagnostics for the last background learning call, stored per Home. */
export type HomeMemoryCaptureReport = {
  at: number;
  model: string | null;
  /** How the answer arrived: a tool call, reply text, or nothing usable. */
  route: "tool" | "text" | "none";
  stopReason: string;
  candidates: number;
  curated: number;
  saved: number;
  rejected: string[];
  usage: {
    input: number;
    output: number;
    totalTokens: number;
    cost: number;
  } | null;
  error: string | null;
};
export type HomeMemoryOverview = {
  mode: HomeMemoryMode;
  memories: HomeMemory[];
  total: number;
  coreIds: string[];
  coreLines: number;
  coreBytes: number;
  coreMaxLines: number;
  coreMaxBytes: number;
  lastCaptureAt: number | null;
  /** Diagnostics for the most recent learning call, including quiet, empty runs. */
  lastCapture: HomeMemoryCaptureReport | null;
  error: string | null;
};
