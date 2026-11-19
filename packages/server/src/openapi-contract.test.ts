import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv/dist/ajv.js";
import { parse } from "yaml";
import type { SessionSearchResult } from "@carmel-agent/shared";
import { createApiRoutes } from "./routes/index.ts";
import { createApiDocument, renderApiDocument } from "./openapi/document.ts";
import { renderApiTypes } from "./openapi/typescript.ts";

type OpenAPIDocument = {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Record<string, unknown>> };
};

const methods = new Set(["get", "post", "put", "patch", "delete"]);
const specPath = new URL("../../shared/openapi.yaml", import.meta.url);

async function loadSpec() {
  return parse(await readFile(specPath, "utf8")) as OpenAPIDocument;
}

function normalizeRoutePath(path: string) {
  return `/api${path === "/" ? "" : path}`.replace(/:([^/]+)/g, "{$1}");
}

test("the committed OpenAPI document and client types are generated from the route definitions", async () => {
  assert.equal(
    await readFile(specPath, "utf8"),
    renderApiDocument(),
    "openapi.yaml is stale: run `pnpm openapi`",
  );
  assert.equal(
    await readFile(new URL("../../shared/src/api.ts", import.meta.url), "utf8"),
    renderApiTypes(createApiDocument()),
    "shared/src/api.ts is stale: run `pnpm openapi`",
  );
});

test("every registered API route is documented", async () => {
  const spec = await loadSpec();
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => methods.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    ),
  );
  const registered = new Set(
    createApiRoutes()
      .routes.filter(({ method }) => methods.has(method.toLowerCase()))
      .map(({ method, path }) => `${method.toUpperCase()} ${normalizeRoutePath(path)}`),
  );

  assert.deepEqual([...documented].sort(), [...registered].sort());
});

/** OpenAPI 3.0 adds null to a reference with `{ nullable: true }` beside it; Ajv wants JSON Schema. */
function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  const nullOnly = (part: unknown) =>
    !!part && typeof part === "object" && Object.keys(part).join() === "nullable";
  const allOf = object.allOf as unknown[] | undefined;
  if (allOf?.some(nullOnly)) {
    const { allOf: _, ...rest } = object;
    const parts = allOf.filter((part) => !nullOnly(part)).map(jsonSchema);
    return { ...rest, anyOf: [parts.length === 1 ? parts[0] : { allOf: parts }, { type: "null" }] };
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      key === "anyOf" || key === "oneOf"
        ? (child as unknown[]).map((part) => (nullOnly(part) ? { type: "null" } : jsonSchema(part)))
        : jsonSchema(child),
    ]),
  );
}

test("representative response fixtures satisfy every response component", async () => {
  const spec = await loadSpec();
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = (name: string) => ({
    $ref: `#/components/schemas/${name}`,
    components: jsonSchema(spec.components),
  });
  const user = {
    id: "u1",
    username: "admin",
    name: "Admin",
    email: "a@example.test",
    role: "admin",
  };
  const model = {
    id: "m1",
    ownerUserId: "u1",
    shared: false,
    label: "Local",
    provider: "ollama",
    modelId: "qwen",
  };
  const provider = {
    id: "p1",
    userId: "u1",
    label: "Local",
    provider: "ollama",
    hasApiKey: false,
    hasOAuth: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const permissions = { read: true, write: true, edit: true, bash: false, network: false };
  const agent = {
    id: "a1",
    ownerUserId: "u1",
    shared: false,
    name: "Agent",
    description: "",
    environmentId: "e1",
    workingDir: "",
    systemPrompt: "",
    promptTemplates: [],
    permissions,
    defaultModelRefId: "m1",
    defaultThinkingLevel: "off",
    createdAt: 1,
    updatedAt: 1,
  };
  const metadata = {
    id: "s1",
    title: "Chat",
    userId: "u1",
    agentId: "a1",
    modelRefId: "m1",
    thinkingLevel: "off",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const session = { ...metadata, messages: [], messageEntryIds: [] };
  const file = {
    name: "README.md",
    path: "README.md",
    type: "file",
    size: 12,
    updatedAt: 1,
    hidden: false,
  };
  const task = {
    id: "t1",
    agentId: "a1",
    userId: "u1",
    name: "Check",
    prompt: "Check",
    scheduleKind: "interval",
    scheduleValue: "3600",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  };
  const issue = {
    id: "i1",
    agentId: "a1",
    userId: "u1",
    title: "Fix it",
    description: "It is broken",
    status: "todo",
    criteria: [],
    priority: "normal",
    running: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const attempt = {
    id: "r1",
    issueId: "i1",
    sessionId: null,
    instructions: "",
    brief: "Fix",
    outcome: "failed",
    summary: "No model",
    evidence: null,
    createdAt: 1,
    finishedAt: 2,
  };
  const note = { id: "n1", issueId: "i1", kind: "note", body: "Context", createdAt: 1 };
  const fixtures: Record<string, unknown> = {
    HomeMemory: {
      id: "memory1",
      content: "Prefer minimal labels",
      title: "",
      scope: "Carmel UI",
      kind: "preference",
      revision: 1,
      pinned: false,
      placement: "topic",
      aliases: [],
      origin: "manual",
      contributorId: "u1",
      expiresAt: null,
      sourceEventId: null,
      sourceEntryId: null,
      sourceQuote: null,
      createdAt: 1,
      updatedAt: 1,
    },
    HomeMemoryRevision: {
      revision: 1,
      content: "Prefer minimal labels",
      title: "",
      scope: "Carmel UI",
      kind: "preference",
      expiresAt: null,
      createdAt: 1,
    },
    HomeMemoryOverview: {
      mode: "manual",
      retrieval: { enabled: false, acceleration: "auto" },
      indexStatus: {
        state: "disabled",
        lastUpdatedAt: null,
        documents: 0,
        needsEmbedding: 0,
        error: null,
        backend: null,
        devices: [],
      },
      embeddingModel: "model",
      memories: [],
      total: 0,
      coreIds: [],
      coreLines: 0,
      coreBytes: 0,
      coreMaxLines: 200,
      coreMaxBytes: 24000,
      lastCaptureAt: null,
      lastCapture: null,
      error: null,
    },
    SessionSecret: { id: "secret1", name: "GITHUB_TOKEN", scope: "session", updatedAt: 1 },
    UserRequest: {
      id: "request1",
      sessionId: session.id,
      kind: "question",
      status: "pending",
      delivery: null,
      createdAt: 1,
      expiresAt: 2,
      question: { question: "Which branch?", options: [], multiple: false, allowFreeText: true },
    },
    IssueDetail: { ...issue, attempts: [attempt], notes: [note] },
    IssueAttempt: attempt,
    IssueNote: note,
    Error: { error: "Nope" },
    OK: { ok: true },
    SetupStatus: { needsSetup: false, passwordLogin: true, oidc: { providerName: "Pocket ID" } },
    ThinkingLevel: "off",
    User: user,
    ModelRef: model,
    ProviderConfig: provider,
    ProviderModel: { id: "qwen", name: "Qwen" },
    OAuthFlow: {
      id: "o1",
      providerConfigId: "p1",
      provider: "openai",
      providerName: "OpenAI",
      status: "pending",
    },
    AgentConfig: agent,
    SessionMetadata: metadata,
    SessionSearchResult: {
      sessionId: "s1",
      agentId: "a1",
      title: "Chat",
      entryId: "durable:1",
      excerpt: "A matching message",
      link: "/agents/a1/sessions/s1?entry=durable%3A1",
    } satisfies SessionSearchResult,
    Session: session,
    SessionConnection: {
      session,
      activeRun: { runId: "r1", sessionId: "s1", eventCursor: 4 },
      runProgress: {
        live: {
          run: { taskId: 2, inputs: [1], turns: 0 },
          generation: { attempt: 1, message: { role: "assistant", content: [] } },
          tools: [{ callId: "c1", name: "read", status: "running", taskId: 3 }],
          nestedTools: [],
        },
        contextPressure: { level: "warning", message: "Compacted" },
      },
      pendingWork: false,
    },
    FileEntry: file,
    FileList: { path: "", entries: [file] },
    FileContent: { path: "README.md", content: "hello", updatedAt: 1 },
    FileBatchResult: { completed: ["a.txt"], failed: [{ path: "b.txt", error: "Nope" }] },
    AgentTask: task,
    Issue: {
      id: "i1",
      agentId: "a1",
      userId: "u1",
      sessionId: "s1",
      title: "Fix it",
      description: "It is broken",
      status: "in_progress",
      criteria: [],
      priority: "normal",
      running: true,
      createdAt: 1,
      updatedAt: 1,
    },
    EnvironmentSecret: { environmentId: "e1", name: "GITHUB_TOKEN", updatedAt: 1 },
    Environment: {
      id: "e1",
      ownerUserId: "u1",
      name: "Workspace",
      mounts: [{ source: "/srv/refs", readOnly: true }],
      network: false,
      agents: [{ id: "a1", name: "Agent" }],
      createdAt: 1,
      updatedAt: 1,
    },
    ImIntegration: {
      id: "im1",
      agentId: "a1",
      platform: "telegram",
      botId: "123",
      botName: "Bot",
      enabled: true,
      proactive: true,
      notificationDefault: false,
      status: "connected",
      senderId: "456",
      updatedAt: 1,
    },
    ImSetup: {
      id: "setup1",
      platform: "feishu",
      status: "pairing",
      expiresAt: 1,
      pairCommand: "/pair example",
    },
    ImDelivery: { id: "delivery1", platform: "lark", status: "pending", createdAt: 1 },
    ApiKey: { id: "k1", name: "laptop", prefix: "carmel-abc123", createdAt: 1 },
    ApiKeyCreated: {
      id: "k1",
      name: "laptop",
      prefix: "carmel-abc123",
      createdAt: 1,
      key: "carmel-abc123secret",
    },
    BootstrapPayload: {
      users: [user],
      agents: [agent],
      providerConfigs: [provider],
      modelRefs: [model],
      modelCatalog: {},
      sessions: [metadata],
    },
  };

  fixtures.HomeMemorySearchHit = {
    ...(fixtures.HomeMemory as object),
    match: { start: 0, end: 21 },
  };
  for (const [name, fixture] of Object.entries(fixtures)) {
    const validate = ajv.compile(schema(name));
    assert.equal(validate(fixture), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  }
});
