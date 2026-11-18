import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AgentConfig, AgentConfigCommand, Environment } from "@carmel-agent/shared";
import type { AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { agents, environmentSecrets, environments, sessions, users } from "../db/schema.ts";
import { now } from "../db/seed.ts";
import { BACKGROUND_CONTEXT, getOrThrow } from "../effectors/pi-durable/index.ts";
import { agentFolderName } from "../paths.ts";
import { AgentExecutionEnv } from "../runtime/execution-env.ts";
import { readEnvironment } from "../services/environments.ts";
import { createActiveAgentRun, finishAgentRun } from "../runtime/run-stream.ts";
import { readEnvironmentSecretEnv, storeSessionSecret } from "../services/environment-secrets.ts";
import { createModelRef, createUser } from "../test-support.ts";
import { createAgentRoutes } from "./agents.ts";
import { createEnvironmentSecretRoutes } from "./environment-secrets.ts";
import { createEnvironmentRoutes } from "./environments.ts";

initialize();
process.env.CARMEL_SECRET_KEY ??= "environment-route-test-key";

function appFor(userId: string) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", async (c, next) => {
    c.set("user", db.select().from(users).where(eq(users.id, userId)).get()!);
    await next();
  });
  app.route("/", createAgentRoutes());
  app.route("/", createEnvironmentRoutes());
  app.route("/", createEnvironmentSecretRoutes());
  return app;
}

function owner() {
  const userId = createUser();
  return { userId, app: appFor(userId), modelRefId: createModelRef({ ownerUserId: userId }) };
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function agentCommand(name: string, modelRefId: string, environmentId?: string) {
  return {
    name,
    description: "",
    environmentId,
    systemPrompt: "",
    promptTemplates: [],
    permissions: { read: true, write: true, edit: true, bash: true, network: false },
    defaultModelRefId: modelRefId,
  } satisfies Partial<AgentConfigCommand>;
}

async function putAgent(app: Hono<{ Variables: AuthVariables }>, id: string, body: unknown) {
  const response = await app.request(`/agents/${id}`, json("PUT", body));
  return { status: response.status, body: (await response.json()) as AgentConfig };
}

function readAgent(agentId: string) {
  return db.select().from(agents).where(eq(agents.id, agentId)).get()!;
}

async function listEnvironments(app: Hono<{ Variables: AuthVariables }>) {
  return (await (await app.request("/environments")).json()) as Environment[];
}

test("a new agent gets its own environment, and a second agent can join it", async () => {
  const { app, modelRefId } = owner();
  const builder = await putAgent(app, crypto.randomUUID(), agentCommand("Builder", modelRefId));
  assert.equal(builder.status, 200);
  const [own] = await listEnvironments(app);
  assert.equal(own!.id, builder.body.environmentId);
  assert.equal(own!.name, "Builder");
  assert.equal(own!.network, false);

  const reviewer = await putAgent(
    app,
    crypto.randomUUID(),
    agentCommand("Reviewer", modelRefId, own!.id),
  );
  assert.equal(reviewer.body.environmentId, own!.id);
  const [shared] = await listEnvironments(app);
  assert.deepEqual(
    shared!.agents.map((agent) => agent.name),
    ["Builder", "Reviewer"],
  );

  await app.request(
    `/environments/${own!.id}/secrets/GITHUB_TOKEN`,
    json("PUT", { value: "ghp_shared" }),
  );
  assert.deepEqual(readEnvironmentSecretEnv(own!.id), [
    { name: "GITHUB_TOKEN", value: "ghp_shared" },
  ]);
});

test("environments are owner-only to attach, read, and change", async () => {
  const alice = owner();
  const bob = owner();
  const agent = await putAgent(
    alice.app,
    crypto.randomUUID(),
    agentCommand("Alice", alice.modelRefId),
  );
  const environmentId = agent.body.environmentId;

  const attached = await putAgent(
    bob.app,
    crypto.randomUUID(),
    agentCommand("Bob", bob.modelRefId, environmentId),
  );
  assert.equal(attached.status, 404);
  assert.deepEqual(await listEnvironments(bob.app), []);
  const update = await bob.app.request(
    `/environments/${environmentId}`,
    json("PUT", { name: "Taken", network: true }),
  );
  assert.equal(update.status, 404);
  assert.equal((await bob.app.request(`/environments/${environmentId}/secrets`)).status, 403);
});

test("regular users cannot mount host paths", async () => {
  const { app } = owner();
  const mounted = await app.request(
    "/environments",
    json("POST", { name: "Host", mounts: [{ source: "/srv" }] }),
  );
  assert.equal(mounted.status, 403);
});

test("an agent works in its own folder or in a folder inside one of the environment's mounts", async () => {
  const { app, userId, modelRefId } = owner();
  db.update(users).set({ role: "admin" }).where(eq(users.id, userId)).run();
  const project = mkdtempSync(join(tmpdir(), "carmel-environment-mount-"));
  mkdirSync(join(project, "docs"));
  try {
    const builder = await putAgent(app, crypto.randomUUID(), agentCommand("Builder", modelRefId));
    const environmentId = builder.body.environmentId;
    assert.equal(builder.body.workingDir, "");
    const mounts = [{ source: project, target: "/srv/project" }];
    await app.request(
      `/environments/${environmentId}`,
      json("PUT", { name: "Builder", mounts, network: false }),
    );

    const writer = await putAgent(app, crypto.randomUUID(), {
      ...agentCommand("Writer", modelRefId, environmentId),
      workingDir: "/srv/project/docs/",
    });
    assert.equal(writer.status, 200);
    assert.equal(writer.body.workingDir, "/srv/project/docs");
    for (const workingDir of ["/srv/elsewhere", "/srv/project/missing"]) {
      const refused = await putAgent(app, crypto.randomUUID(), {
        ...agentCommand("Lost", modelRefId, environmentId),
        workingDir,
      });
      assert.equal(refused.status, 400, workingDir);
    }

    const unmounted = await app.request(
      `/environments/${environmentId}`,
      json("PUT", { name: "Builder", mounts: [], network: false }),
    );
    assert.equal(unmounted.status, 409);
    assert.match(((await unmounted.json()) as { error: string }).error, /Writer/);

    const environment = readEnvironment(environmentId)!;
    const builderEnv = new AgentExecutionEnv(readAgent(builder.body.id), { environment });
    const writerEnv = new AgentExecutionEnv(readAgent(writer.body.id), { environment });
    try {
      assert.equal(builderEnv.cwd, `/workspace/${agentFolderName(builder.body.id)}`);
      assert.equal(writerEnv.hostCwd, join(project, "docs"));
      // Agents in one environment reach each other's folders by path.
      writeFileSync(join(builderEnv.hostCwd, "plan.md"), "from builder");
      assert.equal(
        getOrThrow(await writerEnv.readTextFile(`${builderEnv.cwd}/plan.md`, BACKGROUND_CONTEXT)),
        "from builder",
      );
    } finally {
      await builderEnv.cleanup(BACKGROUND_CONTEXT);
      await writerEnv.cleanup(BACKGROUND_CONTEXT);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("an environment cannot change under any agent's active run", async () => {
  const { app, userId, modelRefId } = owner();
  const builder = await putAgent(app, crypto.randomUUID(), agentCommand("Builder", modelRefId));
  const environmentId = builder.body.environmentId;
  const reviewer = await putAgent(
    app,
    crypto.randomUUID(),
    agentCommand("Reviewer", modelRefId, environmentId),
  );
  const sessionId = crypto.randomUUID();
  const timestamp = now();
  db.insert(sessions)
    .values({
      id: sessionId,
      title: "Run",
      userId,
      agentId: reviewer.body.id,
      modelRefId,
      thinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  const run = createActiveAgentRun({
    runId: crypto.randomUUID(),
    userId,
    sessionId,
    abort: () => {},
  });
  try {
    const blocked = await app.request(
      `/environments/${environmentId}`,
      json("PUT", { name: "Changed", network: true }),
    );
    assert.equal(blocked.status, 409);
  } finally {
    finishAgentRun(run);
  }
  const saved = await app.request(
    `/environments/${environmentId}`,
    json("PUT", { name: "Changed", network: true }),
  );
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as Environment).network, true);
});

test("an environment lasts as long as an agent uses it", async () => {
  const { app, userId, modelRefId } = owner();
  const builderId = crypto.randomUUID();
  const builder = await putAgent(app, builderId, agentCommand("Builder", modelRefId));
  const original = builder.body.environmentId;
  const reviewer = await putAgent(
    app,
    crypto.randomUUID(),
    agentCommand("Reviewer", modelRefId, original),
  );
  assert.equal((await app.request(`/environments/${original}`, { method: "DELETE" })).status, 409);

  // A session credential follows its session when the agent moves.
  const sessionId = crypto.randomUUID();
  const timestamp = now();
  db.insert(sessions)
    .values({
      id: sessionId,
      title: "Credentials",
      userId,
      agentId: builderId,
      modelRefId,
      thinkingLevel: "off",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  storeSessionSecret(userId, sessionId, "SESSION_TOKEN", "session-only");

  const created = (await (
    await app.request("/environments", json("POST", { name: "Fresh" }))
  ).json()) as Environment;
  await putAgent(app, builderId, agentCommand("Builder", modelRefId, created.id));
  assert.deepEqual(readEnvironmentSecretEnv(created.id, sessionId), [
    { name: "SESSION_TOKEN", value: "session-only" },
  ]);
  assert.ok(
    db.select().from(environments).where(eq(environments.id, original)).get(),
    "the reviewer still uses the original environment",
  );

  await app.request(`/agents/${reviewer.body.id}`, { method: "DELETE" });
  assert.equal(
    db.select().from(environments).where(eq(environments.id, original)).get(),
    undefined,
    "deleting its last agent deletes the environment",
  );

  await putAgent(app, builderId, agentCommand("Builder", modelRefId, created.id));
  const third = (await (
    await app.request("/environments", json("POST", { name: "Third" }))
  ).json()) as Environment;
  await putAgent(app, builderId, agentCommand("Builder", modelRefId, third.id));
  assert.equal(
    db.select().from(environments).where(eq(environments.id, created.id)).get(),
    undefined,
    "moving its last agent away deletes the environment",
  );
  assert.equal(
    db.select().from(environmentSecrets).where(eq(environmentSecrets.sessionId, sessionId)).get()
      ?.environmentId,
    third.id,
  );
});
