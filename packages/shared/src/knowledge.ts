import { z } from "zod";

export const knowledgeSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  acceleration: z.enum(["auto", "cpu", "vulkan", "cuda"]).default("auto"),
});
export type KnowledgeSettings = z.infer<typeof knowledgeSettingsSchema>;
export const knowledgeSourceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1).max(2000),
  description: z.string().trim().max(1000).default(""),
});
export type KnowledgeSourceInput = z.infer<typeof knowledgeSourceInputSchema>;
export type KnowledgeSource = KnowledgeSourceInput & {
  id: string;
  agentId: string;
  createdAt: number;
};
export const knowledgeSearchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  mode: z.enum(["fast", "semantic", "deep"]).default("fast"),
  sourceId: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export type KnowledgeSearchInput = z.input<typeof knowledgeSearchSchema>;
export const knowledgeReadSchema = z.object({
  sourceId: z.string().min(1).max(100),
  path: z.string().min(1).max(2000),
  fromLine: z.number().int().min(1).max(1_000_000).default(1),
  maxLines: z.number().int().min(1).max(300).default(100),
});
export type KnowledgeReadInput = z.input<typeof knowledgeReadSchema>;
export type KnowledgeDocument = {
  sourceId: string;
  path: string;
  title: string;
  content: string;
  revision: string;
  fromLine: number;
  totalLines: number;
  citation: string;
};
export type KnowledgeHit = Omit<KnowledgeDocument, "content"> & {
  excerpt: string;
  score: number;
  sourceName: string;
};
export type KnowledgeSearchResult = {
  hits: KnowledgeHit[];
  mode: "fast" | "semantic" | "deep";
  warning?: string;
};
export type KnowledgeStatus = {
  state: "disabled" | "idle" | "updating" | "embedding" | "ready" | "error";
  lastUpdatedAt: number | null;
  documents: number;
  needsEmbedding: number;
  error: string | null;
  backend: string | null;
  devices: string[];
};
export const memoryInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(20_000),
  expectedRevision: z.string().max(100).optional(),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;
export type SavedMemory = {
  id: string;
  agentId: string;
  title: string;
  content: string;
  revision: string;
  contributorId: string;
  createdAt: number;
  updatedAt: number;
};
export type KnowledgeOverview = {
  embeddingModel: string;
  settings: KnowledgeSettings;
  sources: KnowledgeSource[];
  status: KnowledgeStatus;
  memories: SavedMemory[];
};
