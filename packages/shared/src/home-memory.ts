import { z } from "zod";

export const homeMemoryModeSchema = z.enum(["off", "manual", "automatic"]);
export const homeMemoryKindSchema = z.enum(["preference", "fact", "decision"]);
export const homeMemoryInputSchema = z
  .object({
    content: z.string().trim().min(1).max(2000),
    scope: z.string().trim().max(120).default(""),
    kind: homeMemoryKindSchema.default("fact"),
    expiresAt: z.number().int().positive().nullable().default(null),
  })
  .strict();
export const homeMemoryPatchSchema = z
  .object({
    content: z.string().trim().min(1).max(2000).optional(),
    scope: z.string().trim().max(120).optional(),
    kind: homeMemoryKindSchema.optional(),
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
  expiresAt: number | null;
  createdAt: number;
};
export type HomeMemoryOverview = {
  mode: HomeMemoryMode;
  memories: HomeMemory[];
  total: number;
  pinnedTokens: number;
  pinBudget: number;
  lastCaptureAt: number | null;
  error: string | null;
};
