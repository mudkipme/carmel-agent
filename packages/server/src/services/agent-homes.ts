import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { agentHomes, sessions } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import {
  readVisibleAgent,
  readUsableModelRef,
  resolveSupportedThinkingLevel,
} from "./agent-access.ts";
import { insertSession } from "./session-launch.ts";
import { withPiSession, hasPendingPiSessionWork } from "./pi-session-storage.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getActiveAgentRunForSession } from "../runtime/run-stream.ts";
import { blockingUserRequest } from "./user-requests.ts";

export class HomeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 409,
  ) {
    super(message);
  }
}

export function readHome(userId: string, agentId: string) {
  if (!readVisibleAgent(userId, agentId)) throw new HomeError("Agent not found.", 404);
  return db
    .select()
    .from(agentHomes)
    .where(and(eq(agentHomes.userId, userId), eq(agentHomes.agentId, agentId)))
    .get();
}

export function sessionHome(sessionId: string) {
  return db.select().from(agentHomes).where(eq(agentHomes.sessionId, sessionId)).get();
}

export function ensureHome(userId: string, agentId: string) {
  const current = readHome(userId, agentId);
  if (current) return current;
  const agent = readVisibleAgent(userId, agentId)!;
  const model = readUsableModelRef(userId, agent.defaultModelRefId);
  if (!model) throw new HomeError("Choose an available default model for this agent.", 400);
  return db.transaction(() => {
    const existing = readHome(userId, agentId);
    if (existing) return existing;
    const session = insertSession({
      userId,
      agentId,
      modelRefId: model.id,
      thinkingLevel: resolveSupportedThinkingLevel(model, agent.defaultThinkingLevel),
      title: "Home",
    });
    const timestamp = now();
    db.insert(agentHomes)
      .values({
        userId,
        agentId,
        sessionId: session.id,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    return readHome(userId, agentId)!;
  });
}

export async function resetHome(userId: string, agentId: string) {
  const home = readHome(userId, agentId);
  if (!home) throw new HomeError("Home not found.", 404);
  if (
    getActiveAgentRunForSession(userId, home.sessionId) ||
    blockingUserRequest(home.sessionId) ||
    (await hasPendingPiSessionWork(home.sessionId))
  )
    throw new HomeError("Finish or stop the current reply before starting a new context.");
  await withPiSession(home.sessionId, async (pi) => {
    if (getActiveAgentRunForSession(userId, home.sessionId))
      throw new HomeError("Finish the current reply first.");
    await pi.conversation.reset(undefined, BACKGROUND_CONTEXT);
    await pi.conversation.submit(
      {
        type: "write",
        entry: { kind: "carmel.notice", data: { text: "New context", timestamp: now() } },
      },
      BACKGROUND_CONTEXT,
    );
  });
  db.update(sessions)
    .set({
      revision:
        db.select().from(sessions).where(eq(sessions.id, home.sessionId)).get()!.revision + 1,
      updatedAt: now(),
    })
    .where(eq(sessions.id, home.sessionId))
    .run();
}
