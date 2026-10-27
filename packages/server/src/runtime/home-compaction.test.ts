import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { CompactionEntry, LiveDoc } from "@earendil-works/pi-durable";
import { initialize } from "../db/index.ts";
import { createSession, userMessage } from "../test-support.ts";
import {
  compactionSettingsForWindow,
  homeCompactionExtension,
} from "../effectors/compaction-policy.ts";
import { openTestHarness } from "../effectors/testing/pi-harness.ts";
import {
  closePiSession,
  openPiSession,
  replacePiSessionMessages,
  retainPiSessionCompactions,
} from "../services/pi-session-storage.ts";
import { readSessionExcerpt, searchSessions } from "../services/session-search.ts";
import { buildHomeInstructions, configureHomeCompaction } from "./home-tools.ts";
import { createCarmelCodemode } from "./codemode-tool.ts";

initialize();

test(
  "Home summaries finish after the reply releases its lease and retain searchable history",
  { timeout: 10_000 },
  async (t) => {
    const fixture = createSession();
    await replacePiSessionMessages(fixture.sessionId, [
      userMessage("Preserve cedar-lantern as the issue reference; ask before publishing."),
      ...Array.from({ length: 30 }, (_, index) => [
        userMessage(`Discuss topic ${index}`),
        fauxAssistantMessage("Earlier discussion material. ".repeat(250)),
      ]).flat(),
    ]);

    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    const policy = compactionSettingsForWindow(model.contextWindow, "home");
    let release!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let summaries = 0;
    let summaryAborted = false;
    const respond: FauxResponseFactory = async (context, options) => {
      if (JSON.stringify(context.messages[0]).includes("context summarization assistant")) {
        summaries++;
        assert.match(JSON.stringify(context.messages), /cedar-lantern/);
        options?.signal?.addEventListener(
          "abort",
          () => {
            summaryAborted = true;
          },
          { once: true },
        );
        await summaryGate;
        return fauxAssistantMessage(
          "Issue reference: cedar-lantern. Ask before publishing. The latest request remains open.",
        );
      }
      return fauxAssistantMessage("A quick foreground answer.");
    };
    faux.setResponses(Array.from({ length: 8 }, () => respond));
    let pi = await openTestHarness(fixture.sessionId, {
      models,
      model,
      compaction: policy,
      extensions: [homeCompactionExtension(model.contextWindow)],
      systemPrompt: buildHomeInstructions(fixture.agentId),
    });
    t.after(async () => {
      release();
      await pi.close();
    });
    await configureHomeCompaction(pi.session, model.contextWindow, pi.context);

    await pi.prompt("Keep the latest request open while answering this question.");
    assert.equal(summaries, 1);
    const pending = (await pi.session.native.snapshot(
      LiveDoc,
      pi.session.conversation.id,
      pi.context,
    ))!.compactions!;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.blocking, false);
    await retainPiSessionCompactions(pi.session);
    await pi.close();
    assert.equal(summaryAborted, false, "ending a quick reply must not cancel its summary");

    const held = await openPiSession(fixture.sessionId);
    try {
      release();
      const task = await held.native.waitForTask(pending[0]!.taskId, pi.context);
      assert.equal(task.state.outcome.status, "completed");
      const submissionId = task.state.outcome.result?.submissionId;
      assert.ok(submissionId);
      await (await held.native.submission(submissionId, pi.context))!.wait(pi.context);
    } finally {
      await closePiSession(held);
    }

    pi = await openTestHarness(fixture.sessionId, {
      models,
      model,
      compaction: policy,
      extensions: [homeCompactionExtension(model.contextWindow)],
      systemPrompt: buildHomeInstructions(fixture.agentId),
    });
    await configureHomeCompaction(pi.session, model.contextWindow, pi.context);
    const compacted = await pi.session.conversation.context(pi.context);
    assert.equal(compacted.head?.kind, CompactionEntry.kind);
    assert.match(JSON.stringify(compacted.messages), /cedar-lantern/);
    assert.match(JSON.stringify(compacted.messages), /Keep the latest request open/);
    const tokens = compacted.messages.reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    );
    const threshold = model.contextWindow - policy.reserveTokens - policy.backgroundTokens;
    assert.ok(tokens < threshold - 8_000, `post-compaction context: ${tokens} tokens`);
    await pi.prompt("Follow up without another compaction.");
    assert.equal(summaries, 1);
    const usage = await pi.session.native.usage(pi.context);
    const messages = (await pi.branch()).flatMap((entry) =>
      entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
    );
    assert.ok(
      usage.models[`${model.provider}/${model.id}`]!.totalTokens >
        messages.reduce((total, message) => total + message.usage.totalTokens, 0),
    );

    const matches = await searchSessions(fixture.userId, fixture.agentId, "cedar-lantern");
    const original = matches.find((match) => match.excerpt.includes("Preserve cedar-lantern"));
    assert.ok(original);
    const excerpt = await readSessionExcerpt(
      fixture.userId,
      fixture.agentId,
      fixture.sessionId,
      original.entryId,
    );
    assert.ok(excerpt.messages.some((message) => message.text.includes("ask before publishing")));
  },
);

test(
  "large fixed Home instructions do not trigger low-yield background summaries",
  { timeout: 10_000 },
  async (t) => {
    const { sessionId } = createSession();
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel();
    let summaries = 0;
    const respond: FauxResponseFactory = (context) => {
      if (JSON.stringify(context.messages[0]).includes("context summarization assistant")) {
        summaries++;
        return fauxAssistantMessage("A summary of the previous discussion.");
      }
      return fauxAssistantMessage("A short reply.");
    };
    faux.setResponses(Array.from({ length: 20 }, () => respond));
    const pi = await openTestHarness(sessionId, {
      models,
      model,
      systemPrompt: "Fixed project and tool instructions. ".repeat(5_000),
      compaction: compactionSettingsForWindow(model.contextWindow, "home"),
      extensions: [homeCompactionExtension(model.contextWindow)],
    });
    t.after(() => pi.close());
    await configureHomeCompaction(pi.session, model.contextWindow, pi.context);
    for (let index = 0; index < 3; index++) {
      await pi.prompt(`Short question ${index}`);
      const pending =
        (await pi.session.native.snapshot(LiveDoc, pi.session.conversation.id, pi.context))
          ?.compactions ?? [];
      for (const { taskId } of pending) await pi.session.native.waitForTask(taskId, pi.context);
    }
    assert.equal(summaries, 0);
    const explicit = await pi.session.conversation.compact(undefined, pi.context);
    await pi.session.native.waitForTask(explicit, pi.context);
    assert.equal(summaries, 1, "manual compaction still bypasses the background savings check");
  },
);

test("Home budgets rendered system text, skill maps, MCP schemas and Codemode before the first user message", async () => {
  const faux = fauxProvider({ models: [{ id: "home-budget", contextWindow: 200_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const fixed: number[] = [];
  for (const mode of ["base", "mcp", "codemode"]) {
    const { sessionId } = createSession();
    const tools =
      mode === "base"
        ? []
        : [
            {
              name: "mcp_documents_search",
              description: "Search connected documents. ".repeat(500),
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Document search query. ".repeat(500) },
                },
              },
              async execute() {
                return { output: [{ type: "text" as const, text: "Found a document." }] };
              },
            },
          ];
    const pi = await openTestHarness(sessionId, {
      models,
      model,
      promptSections: {
        system: "x".repeat(112_000),
        skills: "A skill name, location and description.\n".repeat(200),
      },
      tools,
      extensions: mode === "codemode" ? [createCarmelCodemode()] : [],
    });
    try {
      await configureHomeCompaction(pi.session, model.contextWindow, pi.context);
      const policy = pi.session.settings.compaction!;
      const baseline =
        model.contextWindow - policy.reserveTokens! - policy.backgroundTokens! - 48_000;
      fixed.push(baseline);
      assert.ok(baseline > 32_000, "the skill map adds overhead above the 32k system prompt");
      assert.equal(faux.state.callCount, 0, "budgeting must happen before model inference");
      assert.equal(
        (await pi.branch()).length,
        0,
        "budgeting must not add synthetic conversation history",
      );

      await configureHomeCompaction(pi.session, 64_000, pi.context);
      const small = pi.session.settings.compaction!;
      const available = Math.max(0, 64_000 - small.reserveTokens! - baseline);
      assert.equal(small.keepRecentTokens, Math.floor(available / 5));
      assert.ok(small.backgroundTokens! <= available / 2 + 1);
      assert.equal(small.reserveTokens, compactionSettingsForWindow(64_000).reserveTokens);
    } finally {
      await pi.close();
    }
  }
  assert.ok(fixed[1]! > fixed[0]! + 5_000, "MCP declaration schemas contribute to fixed overhead");
  assert.ok(fixed[2]! > fixed[1]!, "the rendered Codemode catalog also contributes");
});
