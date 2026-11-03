import { z } from "zod";

export const collaborationCapabilities = ["consult", "createTask", "queueTask"] as const;
export const collaborationGrantSchema = z
  .object({
    consult: z.boolean().default(false),
    createTask: z.boolean().default(false),
    queueTask: z.boolean().default(false),
  })
  .strict();
export const collaborationConnectionSchema = z
  .object({
    peerAgentId: z.string().min(1),
    direction: z.enum(["incoming", "outgoing"]),
    capabilities: collaborationGrantSchema,
  })
  .strict();
export type CollaborationGrant = z.infer<typeof collaborationGrantSchema>;
export type CollaborationConnection = z.infer<typeof collaborationConnectionSchema>;

export type CollaborationSummary = {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  sourceSessionId: string;
  targetSessionId: string | null;
  sourceIssueId: string | null;
  targetIssueId: string | null;
  kind: "consult" | "task";
  status: "queued" | "working" | "answered" | "failed" | "cancelled";
  request: string;
  answer: string | null;
  createdAt: number;
};
