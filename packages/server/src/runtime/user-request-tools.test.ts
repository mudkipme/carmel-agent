import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TaskId, ToolRegistration } from "@earendil-works/pi-durable";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agents } from "../db/schema.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createServerExecution } from "./tools.ts";
import { agentEnvironmentId, createSession } from "../test-support.ts";
import { fauxHarnessModels, openTestHarness } from "../effectors/testing/pi-harness.ts";
import {
  answerQuestion,
  answerSecretRequest,
  pendingUserReply,
  readUserRequests,
} from "../services/user-requests.ts";
import { readEnvironmentSecretEnv, storeSessionSecret } from "../services/environment-secrets.ts";
import { createBashTool, type ExecutionEnv } from "../effectors/pi-durable/index.ts";
import {
  USER_REQUEST_SIGNAL_KEY,
  UserRequestResponse,
  createUserRequestTools,
  redactSessionSecrets,
} from "./user-request-tools.ts";

initialize();
type TestRun = Awaited<ReturnType<typeof openTestHarness>>;

/** What a continuation run does: wake the parked call, then let it finish the run. */
async function signalReply(run: TestRun, sessionId: string) {
  const reply = pendingUserReply(sessionId)!;
  return run.session.native.signal(
    Number(reply.taskId) as TaskId,
    UserRequestResponse,
    USER_REQUEST_SIGNAL_KEY,
    { status: reply.status as "answered" },
    run.context,
  );
}
function userMessages(branch: Awaited<ReturnType<TestRun["branch"]>>) {
  return branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
}
function tools(fixture: ReturnType<typeof createSession>, extra: ToolRegistration[] = []) {
  return [...createUserRequestTools({ ...fixture, bash: true }), ...extra].map((tool) =>
    redactSessionSecrets(tool, fixture.sessionId, agentEnvironmentId(fixture.agentId)),
  );
}

test("credential redaction preserves bash retained output and nested structured results", async () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "bash-retention-test-key";
  const fixture = createSession();
  storeSessionSecret(
    fixture.userId,
    fixture.sessionId,
    "GITHUB_TOKEN",
    "long-token-requiring-a-held-back-redaction-tail",
  );
  const provider = fauxHarnessModels();
  const inspect: ToolRegistration = {
    name: "inspect_bash",
    description: "Inspect a shell result",
    parameters: { type: "object", properties: {} },
    async execute(_args, api, context) {
      const result = await api.executeTool("bash", { command: "test" }, context);
      assert.deepEqual(result.structuredOutput, {
        output: "Short output\n",
        truncated: false,
        exitCode: 0,
      });
      return { output: [{ type: "text", text: "Retained output verified." }] };
    },
  };
  const env = {
    cwd: "/tmp",
    async exec(_command, options, context) {
      assert.ok(options?.window, "native bash output retention stays enabled");
      options?.onOutput?.("Short output\n", context, { stream: "stdout" });
      return { ok: true, value: { exitCode: 0 } };
    },
  } as ExecutionEnv;
  provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("inspect_bash", {}), { stopReason: "toolUse" }),
    (context) => {
      assert.match(JSON.stringify(context), /Retained output verified/);
      return fauxAssistantMessage("Done.");
    },
  ]);
  const run = await openTestHarness(fixture.sessionId, {
    ...provider,
    env,
    tools: tools(fixture, [createBashTool(), inspect]),
  });
  try {
    await run.prompt("Check shell output");
  } finally {
    await run.close();
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
});

test("a question parks its call; the answer wakes it once across reopen and duplicate delivery", async () => {
  const fixture = createSession();
  const provider = fauxHarnessModels();
  provider.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("ask_user_question", {
        question: "Which branch?",
        options: [{ id: "main", label: "Main" }],
        allowFreeText: false,
      }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.match(JSON.stringify(context.messages), /Main/);
      return fauxAssistantMessage("Using Main.");
    },
  ]);
  const first = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  await first.prompt("Choose a branch");
  assert.equal(provider.faux.state.callCount, 1, JSON.stringify(await first.branch()));
  assert.equal(await first.harness.hasPending(first.context), true, "the run stays parked");
  const request = readUserRequests(fixture.sessionId)[0]!;
  assert.equal(request.status, "pending");
  await first.close();
  answerQuestion(fixture.userId, fixture.sessionId, request.id, { selected: ["main"] });
  // A crash after the signal is kept but before the call ran: the next run delivers it again.
  const second = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  assert.equal(await signalReply(second, fixture.sessionId), "delivered");
  await second.close();
  assert.equal(readUserRequests(fixture.sessionId)[0]!.delivery, "pending");
  const third = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  try {
    assert.equal(await signalReply(third, fixture.sessionId), "duplicate");
    await third.harness.resume(third.context);
    assert.equal(provider.faux.state.callCount, 2);
    const branch = await third.branch();
    assert.equal(userMessages(branch).length, 1, "the answer is the call's result, not a new turn");
    const result = branch.find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    assert.match(JSON.stringify(result), /Main/);
    assert.match(JSON.stringify(result), /userRequestReceipt/);
    assert.equal(readUserRequests(fixture.sessionId)[0]!.delivery, "submitted");
    assert.equal(pendingUserReply(fixture.sessionId), undefined);
    assert.equal(await third.harness.hasPending(third.context), false);
  } finally {
    await third.close();
  }
});

test("stopping a parked question declines it and leaves nothing to deliver", async () => {
  const fixture = createSession();
  const provider = fauxHarnessModels();
  provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user_question", { question: "Proceed?" }), {
      stopReason: "toolUse",
    }),
  ]);
  const run = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  try {
    await run.prompt("Ask first");
    await run.lane.abort(run.context);
    const [request] = readUserRequests(fixture.sessionId);
    assert.equal(request?.status, "cancelled");
    assert.equal(request?.delivery, null);
    assert.equal(pendingUserReply(fixture.sessionId), undefined);
    assert.equal(await run.harness.hasPending(run.context), false);
  } finally {
    await run.close();
  }
});

test("tools after a question in its round run once the user answers", async () => {
  const fixture = createSession();
  const provider = fauxHarnessModels();
  let calls = 0;
  const probe: ToolRegistration = {
    name: "probe",
    description: "Side effect",
    parameters: { type: "object", properties: {} },
    async execute() {
      calls++;
      return { output: [{ type: "text", text: "executed" }] };
    },
  };
  provider.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("probe", {}),
        fauxToolCall("ask_user_question", { question: "Proceed?" }),
        fauxToolCall("probe", {}),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  const run = await openTestHarness(fixture.sessionId, {
    ...provider,
    tools: tools(fixture, [probe]),
  });
  try {
    await run.prompt("Ask before going on");
    assert.equal(calls, 1, "the round runs in call order and stops at the question");
    const request = readUserRequests(fixture.sessionId)[0]!;
    answerQuestion(fixture.userId, fixture.sessionId, request.id, { text: "Yes" });
    await signalReply(run, fixture.sessionId);
    await run.harness.resume(run.context);
    assert.equal(calls, 2);
    assert.equal(provider.faux.state.callCount, 2);
  } finally {
    await run.close();
  }
});

test("provider call IDs reused in later rounds create separate requests", async () => {
  const fixture = createSession();
  const provider = fauxHarnessModels();
  provider.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("ask_user_question", { question: "First question?" }, { id: "reused-id" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("ask_user_question", { question: "Second question?" }, { id: "reused-id" }),
      { stopReason: "toolUse" },
    ),
  ]);
  const run = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  try {
    await run.prompt("Ask two questions");
    const first = readUserRequests(fixture.sessionId)[0]!;
    answerQuestion(fixture.userId, fixture.sessionId, first.id, { text: "First answer" });
    await signalReply(run, fixture.sessionId);
    await run.harness.resume(run.context);
    const requests = readUserRequests(fixture.sessionId);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]!.id, requests[1]!.id);
    assert.equal(requests[0]!.delivery, "submitted");
    assert.equal(requests[1]!.status, "pending");
  } finally {
    await run.close();
  }
});

test("a credential answered after a crash before its park was stored still wakes its call", async () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "request-replay-encryption-key";
  const fixture = createSession();
  const provider = fauxHarnessModels();
  let saved!: () => void;
  const persisted = new Promise<void>((resolve) => {
    saved = resolve;
  });
  const crashingTools = tools(fixture).map((tool): ToolRegistration =>
    tool.name !== "request_secret"
      ? tool
      : {
          ...tool,
          async execute(args, api, context) {
            const result = await tool.execute(args, api, context);
            saved();
            await new Promise((_, reject) =>
              context.abortSignal!.addEventListener(
                "abort",
                () => reject(context.abortSignal!.reason),
                { once: true },
              ),
            );
            return result;
          },
        },
  );
  provider.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_secret", { name: "GITHUB_TOKEN", reason: "Authenticate" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Credential ready."),
  ]);
  let run = await openTestHarness(fixture.sessionId, { ...provider, tools: crashingTools });
  try {
    await run.session.conversation.submit(
      { type: "input", content: "Connect GitHub" },
      run.context,
    );
    await persisted;
    await run.close();
    const request = readUserRequests(fixture.sessionId)[0]!;
    answerSecretRequest(fixture.userId, fixture.sessionId, request.id, "private-replay-token");
    run = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
    // Kept although the call is not asleep yet; its rerun parks and wakes at once.
    assert.equal(await signalReply(run, fixture.sessionId), "delivered");
    await run.harness.resume(run.context);
    assert.equal(provider.faux.state.callCount, 2);
    assert.equal(readUserRequests(fixture.sessionId).length, 1);
    assert.equal(readUserRequests(fixture.sessionId)[0]?.delivery, "submitted");
    assert.equal(userMessages(await run.branch()).length, 1);
  } finally {
    await run.close();
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
});

test("secret values never enter provider requests, native entries, streamed details, or promotion receipts", async () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "native-user-request-test-key";
  const fixture = createSession();
  const provider = fauxHarnessModels();
  const secret = "ghp_secret_never_in_the_transcript";
  const events: unknown[] = [];
  const probe: ToolRegistration = {
    name: "probe",
    description: "Read a credential-bearing result",
    parameters: { type: "object", properties: {} },
    async execute(_args, api, context) {
      api.output(secret.slice(0, 12));
      api.output(secret.slice(12));
      await api.details({ echoed: secret }, context);
      return { output: [{ type: "text", text: `token=${secret}` }], details: { echoed: secret } };
    },
  };
  provider.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("request_secret", { name: "GITHUB_TOKEN", reason: "Authenticate GitHub" }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.ok(!JSON.stringify(context).includes(secret));
      return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
    },
    (context) => {
      assert.ok(!JSON.stringify(context).includes(secret));
      const credential = readUserRequests(fixture.sessionId)[0]!.credential!;
      return fauxAssistantMessage(fauxToolCall("promote_secret", { secretRef: credential.id }), {
        stopReason: "toolUse",
      });
    },
    (context) => {
      assert.ok(!JSON.stringify(context).includes(secret));
      return fauxAssistantMessage("GitHub configured for future sessions.");
    },
  ]);
  let run = await openTestHarness(fixture.sessionId, {
    ...provider,
    tools: tools(fixture, [probe]),
  });
  try {
    await run.prompt("Log into GitHub for future sessions");
    assert.equal(provider.faux.state.callCount, 1);
    await run.close();
    const request = readUserRequests(fixture.sessionId)[0]!;
    answerSecretRequest(fixture.userId, fixture.sessionId, request.id, secret);
    run = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture, [probe]) });
    run.observe((event) => {
      events.push(event);
    });
    await signalReply(run, fixture.sessionId);
    await run.harness.resume(run.context);
    assert.equal(provider.faux.state.callCount, 4);
    assert.ok(!JSON.stringify(await run.branch()).includes(secret));
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.equal(readUserRequests(fixture.sessionId)[0]?.credential?.scope, "agent");
    assert.deepEqual(readEnvironmentSecretEnv(agentEnvironmentId(fixture.agentId)), [
      { name: "GITHUB_TOKEN", value: secret },
    ]);
  } finally {
    await run.close();
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
});

test("execution guards wrap tools natively for model calls and Codemode's nested calls", async () => {
  const previous = process.env.CARMEL_SECRET_KEY;
  process.env.CARMEL_SECRET_KEY = "native-guard-test-key";
  const fixture = createSession();
  const secret = "ghp_guarded_secret_value";
  storeSessionSecret(fixture.userId, fixture.sessionId, "GITHUB_TOKEN", secret);
  const agent = {
    ...db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!,
    codemodeEnabled: true,
    permissions: { read: false, write: false, edit: false, bash: false, network: false },
  };
  const execution = createServerExecution(agent, undefined, fixture.userId, fixture.sessionId);
  const probe: ToolRegistration = {
    name: "probe",
    description: "Return a credential-bearing value",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: [{ type: "text", text: `token=${secret}` }] };
    },
  };
  const provider = fauxHarnessModels();
  provider.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(
      fauxToolCall("codemode", {
        code: 'const value = await tools.probe({}); text(value.includes("ghp_") ? "nested-raw" : "nested-guarded");',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Done."),
  ]);
  const tools = execution.resolveTools([probe]);
  const run = await openTestHarness(fixture.sessionId, {
    ...provider,
    tools,
    extensions: [...execution.extensions, execution.guards(tools)],
  });
  try {
    await run.prompt("Use the probe twice");
    const branch = JSON.stringify(await run.branch());
    assert.ok(!branch.includes(secret));
    assert.match(branch, /token=\[redacted:GITHUB_TOKEN\]/);
    assert.match(branch, /nested-guarded/);
  } finally {
    await run.close();
    await execution.cleanup(BACKGROUND_CONTEXT);
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
});
