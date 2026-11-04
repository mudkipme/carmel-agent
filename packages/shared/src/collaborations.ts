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
    direction: z.literal("outgoing"),
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

export type CollaborationReply = {
  id: string;
  agentId: string;
  agentName?: string;
  answer: string;
  taskId?: string;
  sessionId?: string;
};

export function collaborationReply(message: {
  text: string;
  collaboration?: CollaborationReply;
}): CollaborationReply | undefined {
  if (message.collaboration) return message.collaboration;
  const match = message.text.match(
    /^Agent (agent_[^\s]+) replied to collaboration (collaboration_[^\s:]+):\n([\s\S]*)$/,
  );
  if (!match) return;
  const task = match[3]!.match(
    /\nTask: \/agents\/[^/\s]+\/tasks\/([^\s.]+)\. Reported results still require human acceptance\.$/,
  );
  return {
    id: match[2]!,
    agentId: match[1]!,
    answer: task ? match[3]!.slice(0, task.index) : match[3]!,
    ...(task ? { taskId: task[1] } : {}),
  };
}

export type Collaborator = {
  agentId: string;
  name: string;
  description: string;
  capabilities: CollaborationGrant;
};
