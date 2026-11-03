import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agents, sessions, issues, collaborations } from "../db/schema.ts";
import { createAgent, createModelRef, createSession, createUser } from "../test-support.ts";
import {
  authorizeCollaboration,
  saveConnection,
  listCollaborators,
  createCollaboration,
  collaborationView,
  assertReceiverAccess,
  cancelCollaboration,
  readCollaboration,
  dispatchCollaborations,
} from "./collaborations.ts";
import { createServerExecution } from "../runtime/tools.ts";
import { createCollaborationTools } from "../runtime/collaboration-tools.ts";
import { BACKGROUND_CONTEXT } from "../effectors/pi-durable/index.ts";
initialize();
function fixture() {
  const userId = createUser();
  const { sessionId } = createSession({ userId });
  const source = db.select().from(sessions).where(eq(sessions.id, sessionId)).get()!;
  const target = createAgent({
    ownerUserId: userId,
    defaultModelRefId: createModelRef({ ownerUserId: userId }),
  });
  const owner = { userId, agentId: source.agentId, sessionId };
  const grant = { consult: true, createTask: true, queueTask: false };
  const connect = () => {
    saveConnection(userId, source.agentId, {
      peerAgentId: target,
      direction: "outgoing",
      capabilities: grant,
    });
    saveConnection(userId, target, {
      peerAgentId: source.agentId,
      direction: "incoming",
      capabilities: grant,
    });
  };
  return { userId, source, target, owner, grant, connect };
}
const brief = {
  title: "Research",
  description: "Find facts",
  criteria: [],
  priority: "normal" as const,
  queue: false,
};
test("contact requires bilateral grants, ownership and user visibility", () => {
  const f = fixture();
  assert.throws(() => authorizeCollaboration(f.userId, f.source.agentId, f.target, "consult"));
  saveConnection(f.userId, f.source.agentId, {
    peerAgentId: f.target,
    direction: "outgoing",
    capabilities: f.grant,
  });
  assert.deepEqual(listCollaborators(f.owner), []);
  f.connect();
  assert.equal(listCollaborators(f.owner)[0]?.agentId, f.target);
  assert.throws(() => authorizeCollaboration(createUser(), f.source.agentId, f.target, "consult"));
  assert.throws(() =>
    saveConnection(createUser(), f.target, {
      peerAgentId: f.source.agentId,
      direction: "incoming",
      capabilities: f.grant,
    }),
  );
  assert.throws(() => authorizeCollaboration(f.userId, f.source.agentId, f.target, "queueTask"));
});
test("delegation is idempotent, user-owned and backlog-only without queue permission", () => {
  const f = fixture();
  f.connect();
  const result = createCollaboration(f.owner, f.target, "call", brief.description, brief);
  assert.equal(
    createCollaboration(f.owner, f.target, "call", brief.description, brief).id,
    result.id,
  );
  const issue = db.select().from(issues).where(eq(issues.id, result.targetIssueId!)).get()!;
  assert.equal(issue.agentId, f.target);
  assert.equal(issue.userId, f.userId);
  assert.equal(issue.status, "backlog");
  assert.equal(issue.collaborationId, result.id);
  assert.throws(() =>
    createCollaboration(f.owner, f.target, "execute", brief.description, { ...brief, queue: true }),
  );
  assert.throws(() => assertReceiverAccess("", issue.id));
  assert.throws(() => collaborationView({ ...f.owner, userId: createUser() }, result.id));
  assert.throws(() =>
    collaborationView(
      { ...f.owner, sessionId: createSession({ userId: f.userId }).sessionId },
      result.id,
    ),
  );
});
test("consultation tools and environment exclude mutation, shell, MCP, history and further delegation", async () => {
  const f = fixture();
  f.connect();
  const result = createCollaboration(f.owner, f.target, "call", "Question");
  const { sessionId: targetSession } = createSession({ userId: f.userId });
  db.update(sessions)
    .set({ agentId: f.target, collaborationId: result.id })
    .where(eq(sessions.id, targetSession))
    .run();
  db.update(collaborations)
    .set({ targetSessionId: targetSession, status: "working" })
    .where(eq(collaborations.id, result.id))
    .run();
  db.update(agents)
    .set({
      permissions: { read: true, write: true, edit: true, bash: true, network: true },
      codemodeEnabled: true,
    })
    .where(eq(agents.id, f.target))
    .run();
  const execution = createServerExecution(
    db.select().from(agents).where(eq(agents.id, f.target)).get()!,
    undefined,
    f.userId,
    targetSession,
  );
  try {
    await execution.prepare();
    const names = execution
      .resolveTools(
        createCollaborationTools(
          { userId: f.userId, agentId: f.target, sessionId: targetSession },
          true,
        ),
      )
      .map((tool) => tool.name);
    assert.ok(names.includes("read"));
    for (const forbidden of [
      "write",
      "edit",
      "bash",
      "codemode",
      "session_search",
      "session_read",
      "ask_agent",
      "delegate_task",
      "schedule_task",
    ])
      assert.ok(!names.includes(forbidden), forbidden);
    assert.equal(execution.env.agent.permissions.bash, false);
    assert.equal(execution.env.agent.permissions.write, false);
    assert.throws(() =>
      createCollaboration(
        { userId: f.userId, agentId: f.target, sessionId: targetSession },
        f.source.agentId,
        "nested",
        "Nested",
      ),
    );
    saveConnection(f.userId, f.target, {
      peerAgentId: f.source.agentId,
      direction: "incoming",
      capabilities: { ...f.grant, consult: false },
    });
    assert.throws(() => assertReceiverAccess(targetSession));
  } finally {
    await execution.cleanup(BACKGROUND_CONTEXT);
  }
});
test("persistent scope denies retries after deletion of a collaboration", () => {
  const f = fixture();
  f.connect();
  const result = createCollaboration(f.owner, f.target, "task", "Brief", brief);
  db.delete(collaborations).where(eq(collaborations.id, result.id)).run();
  assert.throws(() => assertReceiverAccess("", result.targetIssueId));
});
test("cancellation closes linked work and denies receiver execution", () => {
  const f = fixture();
  f.connect();
  const result = createCollaboration(f.owner, f.target, "task", "Brief", brief);
  cancelCollaboration(f.owner, result.id);
  assert.equal(
    db.select().from(issues).where(eq(issues.id, result.targetIssueId!)).get()?.status,
    "cancelled",
  );
  assert.throws(() => assertReceiverAccess("", result.targetIssueId));
  assert.equal(readCollaboration(f.owner, result.id).status, "cancelled");
});
test("early results keep a registered wait until the parent attempt settles", async () => {
  const f = fixture();
  f.connect();
  const result = createCollaboration(f.owner, f.target, "ask", "Question");
  const { createIssue } = await import("./issues.ts");
  const parent = createIssue(f.userId, f.source.agentId, brief);
  db.update(collaborations)
    .set({ sourceIssueId: parent.id, status: "answered", answer: "Evidence", waiting: true })
    .where(eq(collaborations.id, result.id))
    .run();
  db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, parent.id)).run();
  await dispatchCollaborations();
  assert.equal(readCollaboration(f.owner, result.id).waiting, true);
  assert.equal(readCollaboration(f.owner, result.id).deliveredKey, null);
  db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, parent.id)).run();
  await dispatchCollaborations();
  assert.equal(readCollaboration(f.owner, result.id).waiting, false);
});
