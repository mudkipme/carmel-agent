import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv/dist/ajv.js";
import { parse } from "yaml";
import { createApiRoutes } from "./routes/index.ts";

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

test("OpenAPI operations exactly cover the registered API router", async () => {
  const spec = await loadSpec();
  const documented = new Set(
    Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => methods.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    ),
  );
  const registered = new Set(
    createApiRoutes().routes.filter(({ method }) => methods.has(method.toLowerCase())).map(
      ({ method, path }) => `${method.toUpperCase()} ${normalizeRoutePath(path)}`,
    ),
  );

  assert.deepEqual([...documented].sort(), [...registered].sort());
});

test("representative response fixtures satisfy every response component", async () => {
  const spec = await loadSpec();
  const ajv = new Ajv({ strict: false, allErrors: true });
  const schema = (name: string) => ({
    $ref: `#/components/schemas/${name}`,
    components: spec.components,
  });
  const user = { id: "u1", username: "admin", name: "Admin", email: "a@example.test", role: "admin" };
  const model = { id: "m1", ownerUserId: "u1", shared: false, label: "Local", provider: "ollama", modelId: "qwen" };
  const provider = { id: "p1", userId: "u1", label: "Local", provider: "ollama", hasApiKey: false, hasOAuth: false, createdAt: 1, updatedAt: 1 };
  const permissions = { read: true, write: true, edit: true, bash: false, network: false };
  const agent = { id: "a1", ownerUserId: "u1", shared: false, name: "Agent", description: "", workingDirMode: "default", workingDir: "/work", mounts: [], systemPrompt: "", promptTemplates: [], permissions, defaultModelRefId: "m1", defaultThinkingLevel: "off", createdAt: 1, updatedAt: 1 };
  const metadata = { id: "s1", title: "Chat", userId: "u1", agentId: "a1", modelRefId: "m1", thinkingLevel: "off", revision: 1, createdAt: 1, updatedAt: 1 };
  const session = { ...metadata, messages: [], messageEntryIds: [] };
  const file = { name: "README.md", path: "README.md", type: "file", size: 12, updatedAt: 1, hidden: false };
  const task = { id: "t1", agentId: "a1", userId: "u1", name: "Check", prompt: "Check", scheduleKind: "interval", scheduleValue: "3600", status: "active", createdAt: 1, updatedAt: 1 };
  const issue = { id: "i1", agentId: "a1", userId: "u1", title: "Fix it", description: "It is broken", status: "todo", criteria: [], priority: "normal", running: false, createdAt: 1, updatedAt: 1 };
  const attempt = { id: "r1", issueId: "i1", sessionId: null, instructions: "", brief: "Fix", outcome: "failed", summary: "No model", evidence: null, createdAt: 1, finishedAt: 2 };
  const note = { id: "n1", issueId: "i1", kind: "note", body: "Context", createdAt: 1 };
  const fixtures: Record<string, unknown> = {
    IssueDetail: { ...issue, attempts: [attempt], notes: [note] },
    IssueAttempt: attempt,
    IssueNote: note,
    ActivityItem: { id: 1, agentId: "a1", agentName: "Agent", sessionId: "s1", issueId: null, taskId: null, title: "Reply ready", summary: "A new reply", kind: "completed", createdAt: 1, readAt: null },
    ActivityPage: { items: [], unreadCount: 0, nextCursor: null },
    Error: { error: "Nope" },
    OK: { ok: true },
    SetupStatus: { needsSetup: false, passwordLogin: true, oidc: { providerName: "Pocket ID" } },
    ThinkingLevel: "off",
    User: user,
    ModelRef: model,
    ProviderConfig: provider,
    ProviderModel: { id: "qwen", name: "Qwen" },
    OAuthFlow: { id: "o1", providerConfigId: "p1", provider: "openai", providerName: "OpenAI", status: "pending" },
    AgentConfig: agent,
    SessionMetadata: metadata,
    Session: session,
    SessionConnection: { session, activeRun: null },
    FileEntry: file,
    FileList: { path: "", entries: [file] },
    FileContent: { path: "README.md", content: "hello", updatedAt: 1 },
    FileBatchResult: { completed: ["a.txt"], failed: [{ path: "b.txt", error: "Nope" }] },
    AgentTask: task,
    Issue: { id: "i1", agentId: "a1", userId: "u1", sessionId: "s1", title: "Fix it", description: "It is broken", status: "in_progress", criteria: [], priority: "normal", running: true, createdAt: 1, updatedAt: 1 },
    AgentSecret: { agentId: "a1", name: "GITHUB_TOKEN", updatedAt: 1 },
    ApiKey: { id: "k1", name: "laptop", prefix: "carmel-abc123", createdAt: 1 },
    ApiKeyCreated: { id: "k1", name: "laptop", prefix: "carmel-abc123", createdAt: 1, key: "carmel-abc123secret" },
    BootstrapPayload: { users: [user], agents: [agent], providerConfigs: [provider], modelRefs: [model], modelCatalog: {}, sessions: [metadata] },
  };

  for (const [name, fixture] of Object.entries(fixtures)) {
    const validate = ajv.compile(schema(name));
    assert.equal(validate(fixture), true, `${name}: ${ajv.errorsText(validate.errors)}`);
  }
});
