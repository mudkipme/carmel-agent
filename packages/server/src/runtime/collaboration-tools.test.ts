import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { db, initialize } from "../db/index.ts";
import { collaborations } from "../db/schema.ts";
import { createSession, createAgent } from "../test-support.ts";
import { fauxHarnessModels, openTestHarness } from "../effectors/testing/pi-harness.ts";
import { saveConnection } from "../services/collaborations.ts";
import { createCollaborationTools } from "./collaboration-tools.ts";
initialize();

for (const background of [false, true]) {
  test(
    background
      ? "background consultation yields through the native wait tool"
      : "a normal consultation terminates the run before any polling generation",
    async () => {
      const source = createSession();
      const target = createAgent({
        ownerUserId: source.userId,
        defaultModelRefId: source.modelRefId,
      });
      saveConnection(source.userId, source.agentId, {
        peerAgentId: target,
        direction: "outgoing",
        capabilities: { consult: true, createTask: false, queueTask: false },
      });
      const owner = { userId: source.userId, agentId: source.agentId, sessionId: source.sessionId };
      const provider = fauxHarnessModels();
      let polled = false;
      provider.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("ask_agent", {
            agentId: target,
            question: "Find a fact",
            ...(background ? { background: true } : {}),
          }),
          { stopReason: "toolUse" },
        ),
        ...(background
          ? [
              () => {
                const row = db
                  .select()
                  .from(collaborations)
                  .where(eq(collaborations.sourceSessionId, source.sessionId))
                  .get()!;
                return fauxAssistantMessage(
                  fauxToolCall("wait_for_collaboration", { collaborationId: row.id }),
                  { stopReason: "toolUse" },
                );
              },
            ]
          : []),
        () => {
          polled = true;
          return fauxAssistantMessage("Would have started a sleep loop.");
        },
      ]);
      const run = await openTestHarness(source.sessionId, {
        ...provider,
        tools: createCollaborationTools(owner),
      });
      try {
        await run.prompt("Ask the other agent and wait for its reply.");
        assert.equal(
          polled,
          false,
          "native termination must prevent further model calls while waiting",
        );
        const row = db
          .select()
          .from(collaborations)
          .where(eq(collaborations.sourceSessionId, source.sessionId))
          .get()!;
        assert.equal(row.waiting, true);
      } finally {
        await run.close();
      }
    },
  );
}
