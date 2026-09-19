import { toSessionRow, type AgentThinkingLevel } from "@carmel-agent/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agents, sessions } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import type { AgentRunInput } from "../runtime/agent-runtime.ts";
import { resolveRunModel } from "./model-context.ts";

type SessionRecord = typeof sessions.$inferSelect;
type AgentRecord = typeof agents.$inferSelect;

export type NewSession = {
  userId: string;
  agentId: string;
  modelRefId: string;
  thinkingLevel: AgentThinkingLevel;
  title: string;
  taskId?: string;
  issueId?: string;
};

/** Insert an empty session. Its Pi storage is provisioned on first open. */
export function insertSession(fields: NewSession): SessionRecord {
  const timestamp = now();
  const sessionId = id("session");
  db.insert(sessions)
    .values(toSessionRow({ ...fields, id: sessionId, revision: 0, createdAt: timestamp, updatedAt: timestamp }))
    .run();
  return db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
}

export type PreparedSessionRun = Omit<AgentRunInput, "promptInput" | "sessionAddons">;

/**
 * Resolve a run's model, then create the session it runs in.
 *
 * In that order, so a run that cannot start never leaves an empty session
 * behind. An unset model or thinking level falls back to the agent's default.
 */
export async function prepareSessionRun(options: {
  agent: AgentRecord;
  userId: string;
  modelRefId?: string;
  thinkingLevel?: AgentThinkingLevel;
  session: Pick<NewSession, "title" | "taskId" | "issueId">;
}): Promise<{ ok: true; value: PreparedSessionRun } | { ok: false; reason: "not_found" | "no_auth" }> {
  const { agent, userId } = options;
  const model = await resolveRunModel(
    userId,
    options.modelRefId ?? agent.defaultModelRefId,
    options.thinkingLevel ?? agent.defaultThinkingLevel ?? "off",
  );
  if (!model.ok) return model;
  const { modelRef, providerConfig, modelRuntime, thinkingLevel } = model.value;
  const session = insertSession({
    ...options.session,
    userId,
    agentId: agent.id,
    modelRefId: modelRef.id,
    thinkingLevel,
  });
  return { ok: true, value: { agent, session, modelRef, providerConfig, modelRuntime, thinkingLevel } };
}
