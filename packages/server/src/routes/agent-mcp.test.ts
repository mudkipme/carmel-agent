import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { agentMcpServerSchema, agentConfigRequestSchema } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db, migrate } from "../db/index.ts";
import { agents, users } from "../db/schema.ts";
import { createSession, createUser } from "../test-support.ts";
import { startMcpTestServer } from "../test-mcp-server.ts";
import { createAgentRoutes } from "./agents.ts";
import { serializeAgentSettings, serializePublicAgent } from "../serializers.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";

migrate();
function appFor(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  app.route("/", createAgentRoutes());
  return app;
}
function request(server: unknown) {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(server) };
}

test("MCP settings save and round-trip only through the owner's settings endpoint", async () => {
  const fixture = createSession();
  const app = appFor(fixture.userId);
  const row = db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!;
  const server = agentMcpServerSchema.parse({ id: "docs", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${TOKEN}" } });
  const { id: _id, ownerUserId: _ownerUserId, createdAt: _createdAt, updatedAt: _updatedAt, ...settings } = serializeAgentSettings(row);
  const input = agentConfigRequestSchema.parse({ ...settings, workingDirMode: "default", defaultWorkingDir: undefined, mcpServers: [server], codemodeEnabled: true });
  const response = await app.request(`/agents/${fixture.agentId}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).mcpServers, []);
  const saved = db.select().from(agents).where(eq(agents.id, fixture.agentId)).get()!;
  assert.deepEqual(saved.mcpServers, [server]);
  assert.equal(saved.codemodeEnabled, true);
  assert.deepEqual(serializePublicAgent(saved).mcpServers, []);
  const ownerResponse = await app.request(`/agents/${fixture.agentId}/settings`);
  const ownerSettings = await ownerResponse.json();
  assert.deepEqual(ownerSettings.mcpServers, [server]);
  assert.equal(ownerSettings.codemodeEnabled, true);
  const otherResponse = await appFor(createUser()).request(`/agents/${fixture.agentId}/settings`);
  assert.equal(otherResponse.status, 403);
});

test("only the owner can test MCP, and the persisted transport permission is enforced", async () => {
  const fixture = createSession();
  const server = { id: "remote", transport: "http", url: "http://unused.test" };
  assert.equal((await appFor(createUser()).request(`/agents/${fixture.agentId}/mcp/test`, request(server))).status, 403);
  const denied = await appFor(fixture.userId).request(`/agents/${fixture.agentId}/mcp/test`, request(server));
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /network/);
  const stdioDenied = await appFor(fixture.userId).request(`/agents/${fixture.agentId}/mcp/test`, request({ id: "local", transport: "stdio", command: "npx" }));
  assert.equal(stdioDenied.status, 403);
  assert.match((await stdioDenied.json()).error, /bash/);
});

test("MCP tests reject active-run conflicts and invalid server configuration", async () => {
  const fixture = createSession();
  const app = appFor(fixture.userId);
  const run = createActiveAgentRun({ runId: crypto.randomUUID(), userId: fixture.userId, sessionId: fixture.sessionId, abort: () => {} });
  try {
    const response = await app.request(`/agents/${fixture.agentId}/mcp/test`, request({ id: "remote", transport: "http", url: "https://unused.test" }));
    assert.equal(response.status, 409);
  } finally { finishAgentRun(run); }
  const invalid = await app.request(`/agents/${fixture.agentId}/mcp/test`, request({ id: "remote", transport: "http", url: "file:///tmp" }));
  assert.equal(invalid.status, 400);
});

test("connection tests discover real HTTP tools and close the temporary MCP session", async () => {
  const fixture = createSession();
  db.update(agents).set({ permissions: { read: false, write: false, edit: false, bash: false, network: true } }).where(eq(agents.id, fixture.agentId)).run();
  const server = await startMcpTestServer();
  try {
    const response = await appFor(fixture.userId).request(`/agents/${fixture.agentId}/mcp/test`, request({ id: "remote", transport: "http", url: server.url }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.tools.length, 1);
    assert.match(result.tools[0].label, /echo/);
    assert.equal(server.requests.filter((entry) => entry.method === "DELETE").length, 1);
  } finally { await server.close(); }
});
