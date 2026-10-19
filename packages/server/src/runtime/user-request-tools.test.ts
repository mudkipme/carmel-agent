import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { fauxHarnessModels, openTestHarness } from "../effectors/testing/pi-harness.ts";
import {
  answerQuestion,
  answerSecretRequest,
  markUserReplySubmitted,
  pendingUserReply,
  readUserRequests,
} from "../services/user-requests.ts";
import { readAgentSecretEnv } from "../services/agent-secrets.ts";
import { storeSessionSecret } from "../services/agent-secrets.ts";
import { createBashTool, type ExecutionEnv } from "../effectors/pi-durable/index.ts";
import { createUserRequestTools, guardUserRequests } from "./user-request-tools.ts";

initialize();
function tools(fixture: ReturnType<typeof createSession>, extra: ToolRegistration[] = []) {
  return [...createUserRequestTools({ ...fixture, bash: true }), ...extra].map((tool) =>
    guardUserRequests(tool, fixture.sessionId, fixture.agentId),
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

test("a question ends the run; a persisted answer resumes once across reopen and duplicate delivery", async () => {
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
  assert.equal(await first.harness.hasPending(first.context), false);
  const request = readUserRequests(fixture.sessionId)[0]!;
  assert.equal(request.status, "pending");
  await first.close();
  answerQuestion(fixture.userId, fixture.sessionId, request.id, { selected: ["main"] });
  const receipt = pendingUserReply(fixture.sessionId)!;
  const second = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  // Simulate a crash window: native submission completes but host receipt is not acknowledged.
  await second.harness.prompt(receipt.text, undefined, second.context, undefined, {
    requestId: receipt.requestId,
    onSubmitted() {},
  });
  assert.equal(provider.faux.state.callCount, 2);
  await second.close();
  const third = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
  try {
    await third.harness.prompt(receipt.text, undefined, third.context, undefined, {
      requestId: receipt.requestId,
      onSubmitted: () => markUserReplySubmitted(receipt.id),
    });
    assert.equal(provider.faux.state.callCount, 2, "duplicate delivery must not call the model");
    assert.equal(
      (await third.branch()).filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length,
      2,
    );
    assert.equal(pendingUserReply(fixture.sessionId), undefined);
  } finally {
    await third.close();
  }
});

test("other tools in a question round are skipped, including tools appearing before the question", async () => {
  const fixture = createSession();
  const provider = fauxHarnessModels();
  let calls = 0;
  const probe: ToolRegistration = {
    name: "probe",
    description: "Side effect",
    parameters: { type: "object", properties: {} },
    executionMode: "sequential",
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
    fauxAssistantMessage(fauxToolCall("ask_user_question", { question: "Proceed?" }), {
      stopReason: "toolUse",
    }),
  ]);
  const run = await openTestHarness(fixture.sessionId, {
    ...provider,
    tools: tools(fixture, [probe]),
  });
  try {
    await run.prompt("Ask before doing anything");
    assert.equal(calls, 0);
    assert.equal(provider.faux.state.callCount, 2);
    assert.equal(readUserRequests(fixture.sessionId).length, 1);
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
    const receipt = pendingUserReply(fixture.sessionId)!;
    await run.harness.prompt(receipt.text, undefined, run.context, undefined, {
      requestId: receipt.requestId,
      onSubmitted: () => markUserReplySubmitted(receipt.id),
    });
    const requests = readUserRequests(fixture.sessionId);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]!.id, requests[1]!.id);
    assert.equal(requests[0]!.delivery, "submitted");
    assert.equal(requests[1]!.status, "pending");
  } finally {
    await run.close();
  }
});

test("a credential answered after a crash still settles its original tool before continuing", async () => {
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
    const receipt = pendingUserReply(fixture.sessionId)!;
    run = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture) });
    await run.harness.prompt(receipt.text, undefined, run.context, undefined, {
      requestId: receipt.requestId,
      onSubmitted: () => markUserReplySubmitted(receipt.id),
    });
    assert.equal(
      provider.faux.state.callCount,
      2,
      "replaying the old tool must end its run before admitting the receipt",
    );
    assert.equal(readUserRequests(fixture.sessionId).length, 1);
    assert.equal(readUserRequests(fixture.sessionId)[0]?.delivery, "submitted");
    assert.equal(
      (await run.branch()).filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length,
      2,
    );
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
    const receipt = pendingUserReply(fixture.sessionId)!;
    run = await openTestHarness(fixture.sessionId, { ...provider, tools: tools(fixture, [probe]) });
    run.observe((event) => {
      events.push(event);
    });
    await run.harness.prompt(receipt.text, undefined, run.context, undefined, {
      requestId: receipt.requestId,
      onSubmitted: () => markUserReplySubmitted(receipt.id),
    });
    assert.equal(provider.faux.state.callCount, 4);
    assert.ok(!JSON.stringify(await run.branch()).includes(secret));
    assert.ok(!JSON.stringify(events).includes(secret));
    assert.equal(readUserRequests(fixture.sessionId)[0]?.credential?.scope, "agent");
    assert.deepEqual(readAgentSecretEnv(fixture.agentId), [
      { name: "GITHUB_TOKEN", value: secret },
    ]);
  } finally {
    await run.close();
    if (previous === undefined) delete process.env.CARMEL_SECRET_KEY;
    else process.env.CARMEL_SECRET_KEY = previous;
  }
});
