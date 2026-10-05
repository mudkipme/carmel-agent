import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agents, issueAttempts, issues, modelRefs } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createAgent, createUser } from "../test-support.ts";
import { loadSession } from "./session-store.ts";
import { writeAgentSecret } from "./agent-secrets.ts";
import {
  captureIssueWorkspace,
  compareIssueWorkspace,
} from "./issue-results.ts";
import {
  createIssue,
  readIssueView,
  readIssues,
  runIssue,
  sendIssueUpdate,
  moveQueuedIssue,
  removeIssueFromQueue,
  acceptIssue,
  interruptIssue,
  stopIssueQueue,
  startIssueQueue,
  recoverIssueAttempts,
  drainIssueResults,
} from "./issues.ts";
import { shutdownActiveRuns } from "../runtime/run-stream.ts";

initialize();

test("the agent runs a reordered queue serially; review releases the slot and preserves each run's files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "result.txt"), "before");
    f.provider.hold();
    const first = f.issue("First job");
    await runIssue(f.userId, f.agentId, first.id, {});
    await waitFor(() => f.provider.requests.length === 1);
    const second = f.issue("Second job");
    const third = f.issue("Third job");
    assert.equal(
      (await runIssue(f.userId, f.agentId, second.id, {})).status,
      "queued",
    );
    assert.equal(
      (await runIssue(f.userId, f.agentId, third.id, {})).status,
      "queued",
    );
    assert.equal(f.detail(second.id).attempts.length, 0);
    moveQueuedIssue(f.userId, f.agentId, third.id, "up");
    assert.ok(
      f.detail(third.id).queuePosition! < f.detail(second.id).queuePosition!,
    );
    await assert.rejects(
      runIssue(f.userId, f.agentId, second.id, {}),
      /already queued/,
    );
    assert.equal(
      f.provider.requests.length,
      1,
      "queued jobs must not contact the provider",
    );
    f.provider.release();
    await waitFor(() =>
      [first, second, third].every(
        (issue) => f.detail(issue.id).status === "in_review",
      ),
    );
    assert.deepEqual(
      f.provider.starts.map((text) => text.match(/^# (.*)/)?.[1]),
      ["First job", "Third job", "Second job"],
    );
    assert.equal(f.provider.maxRequests, 1);
    const snapshot = f.detail(first.id).attempts[0]!.snapshot!;
    assert.equal(
      snapshot.files.find((file) => file.path === "result.txt")?.before,
      "before",
    );
    assert.equal(
      snapshot.files.find((file) => file.path === "result.txt")?.after,
      "version 1",
    );
    assert.equal(
      await readFile(join(f.root, "result.txt"), "utf8"),
      "version 3",
    );
    assert.deepEqual(
      f.detail(first.id).attempts[0]!.snapshot,
      snapshot,
      "later jobs must not change a saved result",
    );
    const currentAgent = db
      .select()
      .from(agents)
      .where(eq(agents.id, f.agentId))
      .get()!;
    db.update(agents)
      .set({ permissions: { ...currentAgent.permissions, read: false } })
      .where(eq(agents.id, f.agentId))
      .run();
    assert.deepEqual(f.detail(first.id).attempts[0]!.snapshot!.files, []);
    db.update(agents)
      .set({ permissions: currentAgent.permissions })
      .where(eq(agents.id, f.agentId))
      .run();
    acceptIssue(f.userId, f.agentId, first.id);
    assert.equal(f.detail(first.id).status, "done");
  } finally {
    await f.close();
  }
});

test("revisions keep the Pi conversation; a fresh start creates a new one", async () => {
  const f = await fixture();
  try {
    const issue = f.issue("Remember the first brief");
    await runIssue(f.userId, f.agentId, issue.id, {});
    await waitFor(() => f.detail(issue.id).status === "in_review");
    const firstSession = f.detail(issue.id).sessionId;
    await runIssue(f.userId, f.agentId, issue.id, {
      instructions: "Make the second version",
    });
    await waitFor(() => f.detail(issue.id).status === "in_review");
    assert.equal(f.detail(issue.id).sessionId, firstSession);
    const revisionRequest = f.provider.requests.find((body) =>
      lastUser(body).startsWith("Make the second version"),
    )!;
    assert.ok(
      revisionRequest.messages.some(
        (message) =>
          message.role === "user" &&
          contentText(message.content).includes("Work on this issue."),
      ),
    );
    assert.ok(
      revisionRequest.messages.some((message) => message.role === "assistant"),
    );
    const saved = await loadSession(firstSession!);
    assert.equal(
      saved?.messages.filter((message) => message.role === "user").length,
      2,
    );
    await runIssue(f.userId, f.agentId, issue.id, {
      instructions: "Start again",
      fresh: true,
    });
    await waitFor(() => f.detail(issue.id).status === "in_review");
    assert.notEqual(f.detail(issue.id).sessionId, firstSession);
    assert.equal(
      (await loadSession(f.detail(issue.id).sessionId!))?.messages.filter(
        (message) => message.role === "user",
      ).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("live updates use Pi steering and visibly move from queued to delivered", async () => {
  const f = await fixture();
  try {
    f.provider.hold();
    const issue = f.issue("Work with live feedback");
    await runIssue(f.userId, f.agentId, issue.id, {});
    await waitFor(() => f.provider.requests.length === 1);
    const updated = await sendIssueUpdate(
      f.userId,
      f.agentId,
      issue.id,
      "Use the revised acceptance criterion",
    );
    assert.equal(updated.notes.at(-1)?.delivery, "queued");
    f.provider.releaseWithRead();
    await waitFor(() => f.detail(issue.id).status === "in_review");
    assert.equal(
      f
        .detail(issue.id)
        .notes.find(
          (note) => note.body === "Use the revised acceptance criterion",
        )?.delivery,
      "delivered",
    );
    assert.ok(
      f.provider.requests.some((body) =>
        body.messages.some(
          (message) =>
            message.role === "user" &&
            contentText(message.content).includes(
              "Use the revised acceptance criterion",
            ),
        ),
      ),
    );
    await assert.rejects(
      sendIssueUpdate(f.userId, f.agentId, issue.id, "Too late"),
      /not running/,
    );
  } finally {
    await f.close();
  }
});

test("failed and stopped runs advance the queue; an unreported success cannot enter review", async () => {
  const f = await fixture();
  try {
    f.provider.hold();
    const first = f.issue("Fail this job");
    await runIssue(f.userId, f.agentId, first.id, {});
    await waitFor(() => f.provider.requests.length === 1);
    const second = f.issue("No report for this job");
    await runIssue(f.userId, f.agentId, second.id, {});
    f.provider.release();
    await waitFor(
      () =>
        f.detail(first.id).lastRunOutcome === "failed" &&
        f.detail(second.id).status === "needs_input",
    );
    assert.equal(f.detail(first.id).status, "backlog");
    assert.match(f.detail(first.id).lastRunDetail!, /401|Rejected/);
    assert.match(f.detail(second.id).lastRunDetail!, /without delivering/);
    assert.throws(
      () => acceptIssue(f.userId, f.agentId, second.id),
      /awaiting review/,
    );
  } finally {
    await f.close();
  }
});

test("stopping a run advances the queue and never delivers unused steering to the next job", async () => {
  const f = await fixture();
  try {
    f.provider.hold();
    const first = f.issue("Stop this job");
    await runIssue(f.userId, f.agentId, first.id, {});
    await waitFor(() => f.provider.requests.length === 1);
    const second = f.issue("Run after the stop");
    await runIssue(f.userId, f.agentId, second.id, {});
    await sendIssueUpdate(f.userId, f.agentId, first.id, "Unused update");
    interruptIssue(f.userId, f.agentId, first.id);
    await waitFor(
      () =>
        f.detail(first.id).lastRunOutcome === "cancelled" &&
        f.detail(second.id).status === "in_review",
    );
    assert.equal(
      f.detail(first.id).notes.find((note) => note.body === "Unused update")
        ?.delivery,
      "not_delivered",
    );
    f.provider.release();
    assert.ok(
      !f.provider.starts.some((text) => text.includes("Unused update")),
    );
  } finally {
    await f.close();
  }
});

test("shared agents serialize all owners' work while their queues and commands remain private", async () => {
  const f = await fixture();
  try {
    db.update(agents)
      .set({ shared: true })
      .where(eq(agents.id, f.agentId))
      .run();
    f.provider.hold();
    const first = f.issue("Owner's job");
    await runIssue(f.userId, f.agentId, first.id, {});
    await waitFor(() => f.provider.requests.length === 1);
    const otherUser = createUser();
    const privateJob = createIssue(otherUser, f.agentId, {
      title: "Private job",
      description: "",
    });
    const queued = await runIssue(otherUser, f.agentId, privateJob.id, {
      instructions: "Private instructions",
    });
    assert.equal(queued.status, "queued");
    assert.deepEqual(
      readIssues(otherUser, f.agentId).map((issue) => issue.id),
      [privateJob.id],
    );
    assert.equal(readIssues(f.userId, f.agentId).length, 1);
    assert.throws(
      () => moveQueuedIssue(f.userId, f.agentId, privateJob.id, "up"),
      /not found/,
    );
    assert.ok(!("queuedCommand" in queued));
    removeIssueFromQueue(otherUser, f.agentId, privateJob.id);
    assert.ok(
      readIssueView(otherUser, f.agentId, privateJob.id).notes.some(
        (note) => note.kind === "note" && note.body === "Private instructions",
      ),
    );
    assert.equal(
      readIssueView(otherUser, f.agentId, privateJob.id).status,
      "backlog",
    );
    f.provider.release();
    await waitFor(() => f.detail(first.id).status === "in_review");
    assert.equal(f.provider.starts.length, 1);
  } finally {
    await f.close();
  }
});

test("a preflight failure in an older job cannot reject admission of a valid queued job", async () => {
  const f = await fixture();
  try {
    stopIssueQueue();
    const invalid = f.issue("Invalid model selection");
    await runIssue(f.userId, f.agentId, invalid.id, { modelRefId: "missing" });
    startIssueQueue();
    const valid = f.issue("Valid job admitted behind a failure");
    const admitted = await runIssue(f.userId, f.agentId, valid.id, {});
    assert.equal(admitted.status, "queued");
    await waitFor(() => f.detail(valid.id).status === "in_review");
    assert.equal(f.detail(invalid.id).lastRunOutcome, "failed");
  } finally {
    startIssueQueue();
    await f.close();
  }
});

test("queued work survives queue shutdown; restart recovery releases stale claims before resuming", async () => {
  const f = await fixture();
  try {
    stopIssueQueue();
    const first = f.issue("Resume after restart");
    assert.equal(
      (await runIssue(f.userId, f.agentId, first.id, {})).status,
      "queued",
    );
    const stale = f.issue("Interrupted by restart");
    db.insert(issueAttempts)
      .values({
        id: id("attempt"),
        issueId: stale.id,
        instructions: "",
        brief: "Stale",
        outcome: "running",
        createdAt: now(),
      })
      .run();
    db.update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, stale.id))
      .run();
    recoverIssueAttempts();
    assert.equal(f.detail(stale.id).lastRunOutcome, "interrupted");
    assert.equal(f.detail(stale.id).running, false);
    startIssueQueue();
    await waitFor(() => f.detail(first.id).status === "in_review");
    assert.equal(f.provider.starts.length, 1);
  } finally {
    startIssueQueue();
    await f.close();
  }
});

test("workspace capture honors permission, excludes secrets and symlinks, and preserves bounded text versions", async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "carmel-result-outside-"));
  try {
    const agent = db
      .select()
      .from(agents)
      .where(eq(agents.id, f.agentId))
      .get()!;
    await writeFile(join(f.root, "document.md"), "original");
    await writeFile(join(f.root, ".env"), "PRIVATE=secret");
    await writeFile(join(outside, "private.txt"), "private data");
    await symlink(join(outside, "private.txt"), join(f.root, "external.txt"));
    writeAgentSecret(
      f.userId,
      f.agentId,
      "FIXTURE_TOKEN",
      "captured-secret-value",
    );
    await writeFile(
      join(f.root, "configuration.txt"),
      "token=captured-secret-value",
    );
    await writeFile(join(f.root, "oversized.txt"), "x".repeat(300 * 1024));
    const before = await captureIssueWorkspace(agent);
    assert.equal(
      before.files.get("configuration.txt")?.text,
      "token=[redacted:FIXTURE_TOKEN]",
    );
    await writeFile(join(f.root, "document.md"), "delivered");
    await writeFile(join(f.root, "oversized.txt"), "now small enough");
    const result = compareIssueWorkspace(
      before,
      await captureIssueWorkspace(agent),
    );
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["document.md"],
    );
    assert.equal(result.files[0]?.before, "original");
    assert.equal(result.files[0]?.after, "delivered");
    assert.ok(!JSON.stringify(result).includes("private data"));
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    const denied = await captureIssueWorkspace({
      ...agent,
      permissions: { ...agent.permissions, read: false },
    });
    assert.equal(denied.files.size, 0);
    assert.match(denied.warning!, /read permission/);
  } finally {
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});

type ProviderBody = {
  messages: { role: string; content?: unknown; tool_call_id?: string }[];
};
function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n");
  return "";
}
function lastUser(body: ProviderBody) {
  return contentText(
    body.messages.findLast((message) => message.role === "user")?.content,
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "carmel-issue-queue-"));
  const userId = createUser();
  const modelRefId = id("model_ref");
  const provider = await fakeProvider(root);
  db.insert(modelRefs)
    .values({
      id: modelRefId,
      ownerUserId: userId,
      label: "Fixture",
      provider: "ollama",
      modelId: modelRefId,
      api: "openai-completions",
      baseUrl: `${provider.url}/v1`,
      input: ["text"],
      reasoning: false,
      createdAt: now(),
      updatedAt: now(),
    })
    .run();
  const agentId = createAgent({
    ownerUserId: userId,
    defaultModelRefId: modelRefId,
  });
  db.update(agents)
    .set({ workingDir: root })
    .where(eq(agents.id, agentId))
    .run();
  return {
    root,
    userId,
    agentId,
    provider,
    issue: (title: string) =>
      createIssue(userId, agentId, { title, description: "" }),
    detail: (issueId: string) => readIssueView(userId, agentId, issueId),
    close: async () => {
      provider.release();
      await shutdownActiveRuns();
      await drainIssueResults();
      provider.close();
      db.delete(issues)
        .where(and(eq(issues.userId, userId), eq(issues.agentId, agentId)))
        .run();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function fakeProvider(root: string) {
  const requests: ProviderBody[] = [];
  const starts: string[] = [];
  let unblock: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let readOnRelease = false;
  let concurrent = 0;
  let maxRequests = 0;
  let serial = 0;
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    requests.push(body);
    concurrent++;
    maxRequests = Math.max(maxRequests, concurrent);
    response.once("close", () => concurrent--);
    const held = gate;
    if (held) {
      gate = undefined;
      await held;
    }
    if (response.destroyed) return;
    const last = lastUser(body);
    const context = body.messages
      .filter((message) => message.role === "system")
      .map((message) => contentText(message.content))
      .join("\n");
    const currentTitle =
      context.match(/## Issue brief\n\n# ([^\n]+)/)?.[1] ?? "";
    if (`${context} ${last}`.includes("Fail this job")) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Rejected fixture" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (delta: object, finish_reason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const latestUser = body.messages.findLastIndex(
      (message) => message.role === "user",
    );
    const reported = body.messages
      .slice(latestUser + 1)
      .some(
        (message) =>
          message.role === "tool" &&
          message.tool_call_id?.startsWith("report_"),
      );
    if (readOnRelease) {
      readOnRelease = false;
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "read_fixture",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "missing.txt" }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    } else if (reported || `${context} ${last}`.includes("No report")) {
      send({
        role: "assistant",
        content: "The result is ready for your review.",
      });
      send({}, "stop");
    } else {
      starts.push(last === "Work on this issue." ? `# ${currentTitle}` : last);
      await writeFile(join(root, "result.txt"), `version ${++serial}`);
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `report_${serial}`,
            type: "function",
            function: {
              name: "report_issue",
              arguments: JSON.stringify({
                state: "done",
                summary: `Delivered version ${serial}`,
                evidence: "Verified the result file. No remaining uncertainty.",
              }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    starts,
    get maxRequests() {
      return maxRequests;
    },
    hold() {
      gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
    },
    release() {
      unblock?.();
      unblock = undefined;
    },
    releaseWithRead() {
      readOnRelease = true;
      unblock?.();
      unblock = undefined;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      const attempts = db.select().from(issueAttempts).all();
      throw new Error(
        `Issue test timed out: ${JSON.stringify(attempts.map((attempt) => ({ outcome: attempt.outcome, summary: attempt.summary })))}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
