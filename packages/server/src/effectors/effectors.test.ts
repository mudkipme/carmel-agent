import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { initialize } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { attachTestHarness, fauxHarnessModels } from "./testing/pi-harness.ts";
import { AgentDoc, type AgentState } from "@earendil-works/pi-durable";
import { FakeSessionLog } from "./testing/fake-session-log.ts";
import { runSessionLogContract } from "./testing/session-log-contract.ts";
import { dispatchPrompt } from "./dispatch-prompt.ts";
import type { PromptDispatch } from "./dispatch-prompt.ts";

initialize();

// Both implementations answer to the same suite. That equivalence is what lets
// tests above the port use the fake, and what will decide whether a v2 adapter
// is finished.
const piHarnessOptions = fauxHarnessModels();
const piModel = piHarnessOptions.model;

await runSessionLogContract(
  { name: "FakeSessionLog", create: () => new FakeSessionLog() },
  (name, run) => test(name, run),
);

await runSessionLogContract(
  {
    name: "PiSessionLog",
    async create() {
      const { sessionId } = createSession();
      const pi = await attachTestHarness(await openPiSession(sessionId), piHarnessOptions);
      return pi.log;
    },
    dispose: (log) => log.close(),
  },
  (name, run) => test(name, run),
);

test("native configuration is atomic, preserves tool order, and makes identical updates a no-op", async () => {
  const { sessionId } = createSession();
  const tools = ["read", "bash"].map((name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { output: [] };
    },
  }));
  const pi = await attachTestHarness(await openPiSession(sessionId), {
    ...piHarnessOptions,
    tools,
  });
  const nativeTools = pi.session.registry.snapshot().extension("carmel")!.tools!;
  const updates: AgentState[] = [];
  const unsubscribe = pi.session.native.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (change.type === "document" && change.record.kind === "pi.agent" && change.value)
        updates.push(structuredClone(change.value) as AgentState);
  });
  const configuration = {
    model: { provider: piModel.provider, modelId: piModel.id },
    thinkingLevel: "medium" as const,
    tools: nativeTools,
  };
  try {
    await pi.lane.configure(configuration, pi.context);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      model: configuration.model,
      thinkingLevel: "medium",
      tools: ["read", "bash"],
    });
    await pi.lane.configure(configuration, pi.context);
    assert.equal(updates.length, 1, "identical native configuration writes nothing");
    await pi.lane.configure({ tools: [...nativeTools].reverse() }, pi.context);
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1]!.tools, ["bash", "read"]);
    assert.deepEqual(
      await pi.session.native.snapshot(AgentDoc, pi.session.conversation.id, pi.context),
      updates[1],
    );
  } finally {
    unsubscribe();
    await pi.close();
  }
});

test("plain text goes straight to prompt", async () => {
  const { driver, calls } = recordingDriver();
  await dispatchPrompt(driver, "hello");
  assert.deepEqual(calls, [["prompt", "hello", undefined]]);
});

test("skill instructions and attachments use the ordinary native input path", async () => {
  const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
  const { driver, calls } = recordingDriver({
    skills: [
      { name: "pdf", description: "PDF", content: "Read PDFs", filePath: "/skills/pdf/SKILL.md" },
    ],
  });
  await dispatchPrompt(driver, "/skill:pdf   summarise it  ", images);
  assert.match(calls[0]![1] as string, /<skill.*Read PDFs.*<\/skill>\n\nsummarise it/s);
  assert.equal(calls[0]![2], images);
  await dispatchPrompt(driver, "/skill:pdf");
  assert.match(calls[1]![1] as string, /<\/skill>$/);
});

test("templates retain quoted argument, fallback, and skill-name precedence", async () => {
  const { driver, calls } = recordingDriver({
    promptTemplates: [
      { name: "review", content: "$1 | ${2:-default} | $ARGUMENTS" },
      { name: "skill:pdf", content: "$1" },
    ],
  });
  await dispatchPrompt(driver, '/review "some file"');
  await dispatchPrompt(driver, "/skill:pdf go");
  assert.deepEqual(calls, [
    ["prompt", "some file | default | some file", undefined],
    ["prompt", "go", undefined],
  ]);
});

test("unknown commands preserve their original composer text", async () => {
  const { driver, calls } = recordingDriver();
  await dispatchPrompt(driver, "/nope do a thing");
  assert.deepEqual(calls, [["prompt", "/nope do a thing", undefined]]);
});

function recordingDriver(resources: PromptDispatch["resources"] = {}) {
  const calls: unknown[][] = [];
  const driver: PromptDispatch = {
    resources,
    async prompt(text, images) {
      calls.push(["prompt", text, images]);
    },
  };
  return { driver, calls };
}

test("a new run selects only its current extensions and refreshes models on an existing storage lease", async () => {
  const { sessionId } = createSession();
  const firstModels = fauxHarnessModels();
  const session = await openPiSession(sessionId);
  const first = await attachTestHarness(session, {
    ...firstModels,
    extensions: [{ name: "previous-run", sections: [] }],
  });
  assert.ok(
    (await session.conversation.agent(first.context)).extensions.some(
      (extension) => extension.name === "previous-run",
    ),
  );
  await first.harness.close();
  const secondModels = fauxHarnessModels();
  secondModels.faux.setResponses([() => fauxAssistantMessage("Fresh model.")]);
  const second = await attachTestHarness(session, secondModels);
  try {
    assert.deepEqual(
      (await session.conversation.agent(second.context)).extensions.map(
        (extension) => extension.name,
      ),
      ["carmel"],
    );
    await session.conversation.configure(
      { model: { provider: secondModels.model.provider, modelId: secondModels.model.id } },
      second.context,
    );
    await second.prompt("Use the new model");
    assert.equal(firstModels.faux.state.callCount, 0);
    assert.equal(secondModels.faux.state.callCount, 1);
    assert.match(JSON.stringify((await second.branch()).at(-1)), /Fresh model/);
  } finally {
    await second.close();
  }
});
