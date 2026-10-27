/** Isolated browser-test fixture. Never starts the production bootstrap or schedulers. */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = await mkdtemp(join(tmpdir(), "carmel-browser-tests-"));
const workspaceDir = join(stateDir, "workspace");
await mkdir(workspaceDir);
await writeFile(
  join(workspaceDir, "workspace-review.md"),
  "# Workspace review\n\nUpdated draft.\n",
);
await mkdir(join(workspaceDir, "docs"));
await writeFile(
  join(workspaceDir, "docs", "guide.md"),
  [
    "# Preview guide",
    "",
    "A **formatted** document.",
    "",
    "| Feature | Status |",
    "| --- | --- |",
    "| Preview | Ready |",
    "",
    "```ts",
    "const ready = true;",
    "```",
    "",
    "[Related notes](notes.markdown)",
    "",
    "![A local diagram](diagram.svg)",
    "",
    "<script>window.markdownPreviewExecuted = true</script>",
    "",
  ].join("\n"),
);
await writeFile(
  join(workspaceDir, "docs", "notes.markdown"),
  "# Related notes\n\nThis is a second Markdown file.\n",
);
await writeFile(join(workspaceDir, "docs", "plain.txt"), "Plain text stays editable.\n");
await writeFile(
  join(workspaceDir, "docs", "diagram.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="48"><rect width="120" height="48" fill="#557755"/></svg>',
);
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_AGENT_DATA_DIR = stateDir;
process.env.CARMEL_PODMAN_SOCKET = join(stateDir, "no-container-socket");
process.env.CLIENT_DIST_DIR = new URL("../../client/dist/", import.meta.url).pathname;
process.env.CARMEL_SECRET_KEY = "isolated-browser-fixture-key";

const { serve } = await import("@hono/node-server");
const { eq } = await import("drizzle-orm");
const { createApp } = await import("../src/app.ts");
const { db, initialize } = await import("../src/db/index.ts");
const { agents, agentTasks, agentTaskRuns, issues, issueAttempts, modelRefs, sessions, users } =
  await import("../src/db/schema.ts");
const { createAgent, createSession } = await import("../src/test-support.ts");
const { hashPassword } = await import("../src/auth.ts");
const { attachBrowserSocket } = await import("../src/browser-socket.ts");
const { browserControl } = await import("../src/runtime/browser-control.ts");
const { createIssue, stopIssueQueue } = await import("../src/services/issues.ts");
stopIssueQueue();
initialize();
const fixture = createSession();
// Exercise the complete composer toolbar, including long model names.
db.update(modelRefs)
  .set({
    modelId: "deepseek/deepseek-v4-a-deliberately-long-model-name",
    input: ["text", "image"],
    reasoning: true,
  })
  .where(eq(modelRefs.id, fixture.modelRefId))
  .run();
const secondAgentId = createAgent({
  ownerUserId: fixture.userId,
  defaultModelRefId: fixture.modelRefId,
});
db.update(users)
  .set({
    username: "browser-test",
    passwordHash: await hashPassword("browser-test-password"),
    email: "browser@example.test",
    role: "admin",
  })
  .where(eq(users.id, fixture.userId))
  .run();
db.update(agents)
  .set({
    name: "Browser test agent",
    workingDir: workspaceDir,
    permissions: { read: true, write: true, edit: true, bash: true, network: false },
  })
  .where(eq(agents.id, fixture.agentId))
  .run();
db.update(agents)
  .set({ name: "Second agent", workingDir: stateDir })
  .where(eq(agents.id, secondAgentId))
  .run();
const timestamp = Date.now();
const { imBindings, imCredentials, imIntegrations, imSetups } =
  await import("../src/db/im-schema.ts");
const { encryptIm } = await import("../src/services/im-integrations.ts");
const QRCode = (await import("qrcode")).default;
const fixtureIntegrationId = "browser-telegram-integration";
db.insert(imIntegrations)
  .values({
    id: fixtureIntegrationId,
    agentId: fixture.agentId,
    userId: fixture.userId,
    platform: "telegram",
    botId: "browser-fixture-bot",
    botName: "Carmel test bot",
    status: "connected",
    updatedAt: timestamp,
  })
  .run();
db.insert(imCredentials)
  .values({
    integrationId: fixtureIntegrationId,
    value: encryptIm({ token: "fixture_never_used" }),
  })
  .run();
db.insert(imBindings)
  .values({
    integrationId: fixtureIntegrationId,
    senderId: "paired-browser-user",
    chatId: "private-browser-chat",
  })
  .run();
db.insert(imSetups)
  .values({
    id: "browser-feishu-setup",
    agentId: fixture.agentId,
    userId: fixture.userId,
    platform: "feishu",
    status: "authorizing",
    expiresAt: timestamp + 600_000,
    createdAt: timestamp,
    nextPollAt: timestamp + 5000,
    state: encryptIm({
      deviceCode: "fixture_device_code",
      verificationUrl: "https://accounts.feishu.cn/fixture",
      qrDataUrl: await QRCode.toDataURL("https://accounts.feishu.cn/fixture"),
    }),
  })
  .run();
// A real persisted checkpoint, closed as it would be on a server restart.
const pendingSessionId = "browser-pending-session";
db.insert(sessions)
  .values({
    ...db.select().from(sessions).where(eq(sessions.id, fixture.sessionId)).get()!,
    id: pendingSessionId,
    title: "Interrupted lookup",
  })
  .run();
const { fauxHarnessModels, openTestHarness } =
  await import("../src/effectors/testing/pi-harness.ts");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { faux, ...pendingModels } = fauxHarnessModels();
faux.setResponses([fauxAssistantMessage([fauxToolCall("lookup", {})], { stopReason: "toolUse" })]);
let entered!: () => void;
const started = new Promise<void>((resolve) => {
  entered = resolve;
});
const checkpoint = await openTestHarness(pendingSessionId, {
  ...pendingModels,
  tools: [
    {
      name: "lookup",
      label: "Lookup",
      description: "Pending lookup",
      replay: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_id, _args, _update, _tools, _invocation, context) {
        entered();
        await new Promise((_, reject) =>
          context.abortSignal!.addEventListener(
            "abort",
            () => reject(context.abortSignal!.reason),
            { once: true },
          ),
        );
        return { content: [] };
      },
    },
  ],
});
await checkpoint.session.conversation.submit(
  { type: "input", content: "Look up a record", whenBusy: "reject" },
  checkpoint.context,
);
await started;
await checkpoint.close();
const previousSessionId = "browser-previous-session";
db.insert(sessions)
  .values({
    id: previousSessionId,
    title: "Previous issue conversation",
    userId: fixture.userId,
    agentId: fixture.agentId,
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
const reviewIssue = createIssue(fixture.userId, fixture.agentId, {
  title: "Review the deployment guide",
  description: "Check the setup instructions.",
  criteria: [],
  priority: "normal",
});
const backlogIssue = createIssue(fixture.userId, fixture.agentId, {
  title: "Explain backups",
  description: "For later.",
  criteria: [],
  priority: "normal",
});
db.update(issues)
  .set({ sessionId: fixture.sessionId, status: "in_review" })
  .where(eq(issues.id, reviewIssue.id))
  .run();
db.update(sessions)
  .set({ issueId: reviewIssue.id })
  .where(eq(sessions.id, fixture.sessionId))
  .run();
db.update(sessions)
  .set({ issueId: reviewIssue.id })
  .where(eq(sessions.id, previousSessionId))
  .run();
for (const [id, sessionId, createdAt] of [
  ["browser-current-attempt", fixture.sessionId, timestamp],
  ["browser-previous-attempt", previousSessionId, timestamp - 10_000],
] as const) {
  db.insert(issueAttempts)
    .values({
      id,
      issueId: reviewIssue.id,
      sessionId,
      instructions: "",
      brief: "Check the guide.",
      outcome: "succeeded",
      summary: "Ready for review.",
      createdAt,
      finishedAt: createdAt + 1_000,
    })
    .run();
}
const taskName =
  "Review the deployment guide and keep this deliberately long task title and all its controls usable on a narrow mobile screen";
db.insert(agentTasks)
  .values({
    id: "browser-task",
    agentId: fixture.agentId,
    userId: fixture.userId,
    name: taskName,
    prompt: "Review the guide.",
    scheduleKind: "interval",
    scheduleValue: "86400000",
    status: "paused",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
const taskSessionId = "browser-task-session";
db.insert(sessions)
  .values({
    id: taskSessionId,
    title: taskName,
    userId: fixture.userId,
    agentId: fixture.agentId,
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    taskId: "browser-task",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
db.insert(agentTaskRuns)
  .values({
    id: "browser-task-run",
    taskId: "browser-task",
    scheduledFor: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp + 1_000,
    outcome: "succeeded",
    sessionId: taskSessionId,
  })
  .run();
// A persisted tool-heavy conversation for transcript and disclosure regressions.
const chatSessionId = "browser-chat-session";
db.insert(sessions)
  .values({
    id: chatSessionId,
    title: "Make the deployment guide easier to follow",
    userId: fixture.userId,
    agentId: fixture.agentId,
    modelRefId: fixture.modelRefId,
    thinkingLevel: "off",
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .run();
const { replacePiSessionMessages } = await import("../src/services/pi-session-storage.ts");
const chatCalls = [
  fauxToolCall("read", { path: "docs/deployment.md" }, { id: "preview-read" }),
  fauxToolCall("bash", { command: "pnpm check" }, { id: "preview-bash" }),
  fauxToolCall("mcp__docs__search", { query: "deployment checklist" }, { id: "preview-search" }),
];
await replacePiSessionMessages(chatSessionId, [
  {
    role: "user",
    content: "Review the deployment guide and make the setup instructions easier to follow.",
    timestamp,
  },
  fauxAssistantMessage(
    [
      {
        type: "thinking",
        thinking:
          "I’ll check the guide against the project configuration, then verify the commands.",
      },
      { type: "text", text: "I’ll read the current guide and check the setup steps." },
      ...chatCalls,
    ],
    { stopReason: "toolUse" },
  ),
  ...chatCalls.map((call, index) => ({
    role: "toolResult" as const,
    toolCallId: call.id,
    toolName: call.name,
    content: [
      {
        type: "text" as const,
        text: [
          "# Deployment\n\nInstall dependencies and configure your environment.",
          "All checks passed.\n<script>This is plain tool output, not markup.</script>",
          "Search service unavailable. The local guide is still available.",
        ][index]!,
      },
    ],
    isError: index === 2,
    timestamp,
  })),
  fauxAssistantMessage(
    "## A clearer path to deployment\n\nThe guide now separates **initial setup** from **everyday updates**, with a short checklist for each.\n\n- Start with the required environment variables.\n- Install dependencies and run the checks.\n- Build the app, then start the server.\n\n```bash\npnpm install --frozen-lockfile\npnpm check\npnpm build\n```\n\nThe local checks passed. The documentation search was unavailable, so I used the repository’s guide.",
  ),
]);
const { ensureHome } = await import("../src/services/agent-homes.ts");
const homeIssue = createIssue(fixture.userId, secondAgentId, {
  title: "Check k3s cluster health",
  description: "Run a read-only health check.",
  criteria: [],
  priority: "normal",
});
const homeReviewIssue = createIssue(fixture.userId, secondAgentId, {
  title: "Review the cluster configuration",
  description: "Review the configuration.",
  criteria: [],
  priority: "normal",
});
db.update(issues).set({ status: "needs_input" }).where(eq(issues.id, homeIssue.id)).run();
db.update(issues).set({ status: "in_review" }).where(eq(issues.id, homeReviewIssue.id)).run();
db.insert(issueAttempts)
  .values({
    id: "browser-home-issue-attempt",
    issueId: homeIssue.id,
    instructions: "",
    brief: "Check cluster health.",
    outcome: "succeeded",
    summary: "A read-only kubeconfig is needed.",
    evidence:
      "Client scan: kubectl is missing. KUBECONFIG is unset. Checks and artifacts remain on this page.",
    createdAt: timestamp,
    finishedAt: timestamp + 1000,
  })
  .run();
const issueHome = ensureHome(fixture.userId, secondAgentId);
await replacePiSessionMessages(issueHome.sessionId, [
  { role: "user", content: "Check the cluster and review its configuration.", timestamp },
  fauxAssistantMessage(
    `I've queued [a read-only cluster check](/agents/${secondAgentId}/issues/${homeIssue.id}). You can keep chatting while it runs.`,
  ),
  {
    role: "homeNotice",
    text: `[${homeIssue.title}](/agents/${secondAgentId}/issues/${homeIssue.id}?from=home) — needs_input\n\nA read-only kubeconfig is needed.\n\nClient scan: kubectl is missing. KUBECONFIG is unset. Checks and artifacts remain on this page.`,
    timestamp: timestamp + 1,
  },
  fauxAssistantMessage(
    "The health check needs a read-only kubeconfig. Add it securely, then tell me which path to use.",
  ),
  {
    role: "homeNotice",
    text: "Configuration review delivered.",
    issue: {
      id: homeReviewIssue.id,
      agentId: secondAgentId,
      title: homeReviewIssue.title,
      status: "in_review",
      lastRunOutcome: "succeeded",
    },
    timestamp: timestamp + 2,
  },
]);
const { openPiSession, closePiSession, messageDraft } =
  await import("../src/services/pi-session-storage.ts");
const { Helpers } = await import("../src/runtime/helpers.ts");
const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const taskSession = await openPiSession(fixture.sessionId);
const subtaskId = await taskSession.conversation.commit(async (tx) => {
  const state = await tx.doc(Helpers);
  const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await tx.appendEntry(
    child.id,
    messageDraft({ role: "user", content: "Verify the database connections.", timestamp }),
  );
  await tx.appendEntry(
    child.id,
    messageDraft(
      fauxAssistantMessage("Verified database connections. All eleven applications were checked."),
    ),
  );
  state.items[String(child.id)] = {
    userId: fixture.userId,
    agentId: fixture.agentId,
    callId: 0,
    id: child.id,
    parentId: taskSession.conversation.id,
    name: "Database verification",
    task: "Verify the database connections.",
    background: true,
    createdAt: timestamp,
    wakeAt: timestamp,
    deadline: timestamp + 300_000,
    status: "done",
    answer: "Verified database connections. All eleven applications were checked.",
  };
  return child.id;
}, BACKGROUND_CONTEXT);
await closePiSession(taskSession);
const app = createApp();
const { withPiSession } = await import("../src/services/pi-session-storage.ts");
const { createUserRequest, answerSecretRequest, pendingUserReply, markUserReplySubmitted } =
  await import("../src/services/user-requests.ts");
const { questionInputSchema, secretRequestInputSchema } = await import("@carmel-agent/shared");
const questionSessionId = "browser-question-session";
const multipleQuestionSessionId = "browser-multiple-question-session";
const secretSessionId = "browser-secret-session";
const declineSessionId = "browser-decline-session";
const receiptSessionId = "browser-receipt-session";
for (const [sessionId, title] of [
  [questionSessionId, "Choose a branch"],
  [multipleQuestionSessionId, "Choose environments"],
  [secretSessionId, "Connect GitHub"],
  [declineSessionId, "Optional question"],
  [receiptSessionId, "Credential receipts"],
]) {
  db.insert(sessions)
    .values({
      id: sessionId!,
      title: title!,
      userId: fixture.userId,
      agentId: fixture.agentId,
      modelRefId: fixture.modelRefId,
      thinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  await withPiSession(sessionId!, async (pi) => {
    const context = {
      sessionId: sessionId!,
      conversationId: String(pi.conversation.id),
      callId: "fixture-request",
    };
    if (sessionId === receiptSessionId) {
      const request = createUserRequest(
        context,
        "secret",
        secretRequestInputSchema.parse({ name: "GH_TOKEN", reason: "Connect GitHub" }),
      );
      answerSecretRequest(fixture.userId, sessionId, request.id, "fixture-only-credential");
      const reply = pendingUserReply(sessionId)!;
      // An already-saved raw host response upgrades when read back from native history.
      const { appendPiMessage } = await import("../src/services/pi-session-storage.ts");
      await appendPiMessage(pi, { role: "user", content: reply.text, timestamp });
      markUserReplySubmitted(request.id);
      await pi.conversation.commit(
        (tx) =>
          tx.appendEntry(pi.conversation.id, {
            kind: "carmel.user-request-response",
            data: {
              carmelUserRequestReceipt: {
                requestId: "fixture-question",
                kind: "question",
                status: "answered",
                question: "Which branch?",
                answer: "Main",
              },
            },
            model: [
              { role: "user", content: "Internal question response", timestamp: timestamp + 1 },
            ],
          }),
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
      );
    } else if (sessionId === secretSessionId)
      createUserRequest(
        context,
        "secret",
        secretRequestInputSchema.parse({
          name: "GITHUB_TOKEN",
          reason: "Authenticate GitHub to create a pull request.",
        }),
      );
    else
      createUserRequest(
        context,
        "question",
        questionInputSchema.parse(
          sessionId === multipleQuestionSessionId
            ? {
                question: "Which environments should be deployed?",
                options: [
                  { id: "dev", label: "Development" },
                  { id: "staging", label: "Staging" },
                ],
                multiple: true,
                allowFreeText: false,
              }
            : {
                question: "Which branch should I use?",
                options: [
                  { id: "main", label: "Main" },
                  { id: "develop", label: "Develop" },
                ],
              },
        ),
      );
    if (sessionId === questionSessionId) {
      await pi.conversation.commit(
        async (tx) => {
          for (let index = 0; index < 30; index++) {
            await tx.appendEntry(pi.conversation.id, {
              kind: "pi.user",
              model: [
                {
                  role: "user",
                  content: `Earlier question ${index + 1}`,
                  timestamp: timestamp + index,
                },
              ],
            });
            await tx.appendEntry(pi.conversation.id, {
              kind: "pi.assistant",
              model: [
                fauxAssistantMessage(
                  `Earlier progress ${index + 1}.\n\nThe agent reviewed the project and is waiting for your answer before continuing.`,
                ),
              ],
            });
          }
        },
        (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT,
      );
    }
  });
}
let delayFirstChatConnection = true;
const server = serve(
  {
    fetch: async (request, env) => {
      if (
        delayFirstChatConnection &&
        new URL(request.url).pathname === `/api/sessions/${chatSessionId}/connection`
      ) {
        delayFirstChatConnection = false;
        // The shell is ready before the composer mounts. Keep that gap observable
        // on fast machines too, so tests must wait for the control they interact with.
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return app.fetch(request, env);
    },
    port: 0,
    hostname: "127.0.0.1",
  },
  (address) => {
    console.log(
      JSON.stringify({
        url: `http://127.0.0.1:${address.port}`,
        agentId: fixture.agentId,
        secondAgentId,
        homeIssueId: homeIssue.id,
        homeReviewIssueId: homeReviewIssue.id,
        reviewIssueId: reviewIssue.id,
        subtaskId,
        subtaskSessionId: fixture.sessionId,
        backlogIssueId: backlogIssue.id,
        previousSessionId,
        pendingSessionId,
        taskSessionId,
        taskName,
        chatSessionId,
        questionSessionId,
        multipleQuestionSessionId,
        secretSessionId,
        declineSessionId,
        receiptSessionId,
      }),
    );
  },
);
// A deterministic stream fixture exercises the real gateway and handoff state without a container.
const browserSockets = attachBrowserSocket(
  server as unknown as import("node:http").Server,
  async (_agent, onMessage) => {
    let clipboardText = "Copied from the remote page";
    const frame = (seq: number) =>
      onMessage({
        type: "frame",
        seq,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
        metadata: { deviceWidth: 1280, deviceHeight: 720 },
      });
    let acknowledged = 0;
    queueMicrotask(() => {
      onMessage({ type: "ready" });
      onMessage({ type: "url", url: "https://example.test/login" });
      frame(1);
    });
    return {
      send: (message) => {
        const command = message as {
          type: string;
          id: number;
          args: string[];
          seq: number;
          requestId: string;
          operation: string;
          text?: string;
        };
        if (command.type === "clipboard") {
          if (command.operation === "paste") clipboardText = command.text ?? "";
          onMessage({
            type: "clipboard_result",
            requestId: command.requestId,
            ...(command.operation === "copy" ? { text: clipboardText } : {}),
          });
        }
        if (command.type === "ack" && command.seq > acknowledged) {
          acknowledged = command.seq;
          if (acknowledged === 1) frame(2); // Identical pixels still require a new acknowledgement.
          if (acknowledged === 2)
            onMessage({ type: "url", url: "https://example.test/login?stream=live" });
        }
        if (command.type === "command") {
          if (command.args[0] === "open") onMessage({ type: "url", url: command.args[1]! });
          onMessage({ type: "command_done", id: command.id });
        }
      },
      close: () => {},
    };
  },
);
void browserControl(fixture.agentId).requestHelp("Please sign in to the billing portal.");
const stop = () => {
  for (const client of browserSockets.clients) client.terminate();
  browserSockets.close();
  server.close(
    () => void rm(stateDir, { recursive: true, force: true }).finally(() => process.exit(0)),
  );
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
