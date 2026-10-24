import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agentSecrets, agents } from "../db/schema.ts";
import { createAgent, createModelRef, createUser } from "../test-support.ts";
import {
  AgentSecretError,
  agentWorkspaceDotEnvStatus,
  deleteAgentSecret,
  deleteAgentSecretsForAgent,
  importAgentWorkspaceDotEnv,
  readAgentSecretEnv,
  readAgentSecrets,
  writeAgentSecret,
} from "./agent-secrets.ts";

initialize();

function fixture() {
  const ownerUserId = createUser();
  const defaultModelRefId = createModelRef({ ownerUserId });
  return { ownerUserId, agentId: createAgent({ ownerUserId, defaultModelRefId }) };
}

test("a stored secret is listed by name and never by value", () => {
  const { ownerUserId, agentId } = fixture();
  const secret = writeAgentSecret(ownerUserId, agentId, "GITHUB_TOKEN", "ghp_example");
  assert.deepEqual(Object.keys(secret).sort(), ["agentId", "name", "updatedAt"]);
  assert.deepEqual(
    readAgentSecrets(ownerUserId, agentId).map((item) => item.name),
    ["GITHUB_TOKEN"],
  );
});

test("writing the same name twice rotates the value instead of duplicating it", () => {
  const { ownerUserId, agentId } = fixture();
  writeAgentSecret(ownerUserId, agentId, "TOKEN", "first");
  writeAgentSecret(ownerUserId, agentId, "TOKEN", "second");
  assert.equal(readAgentSecrets(ownerUserId, agentId).length, 1);
  assert.deepEqual(readAgentSecretEnv(agentId), [{ name: "TOKEN", value: "second" }]);
});

test("workspace .env import adds valid secrets without replacing stored values", () => {
  const { ownerUserId, agentId } = fixture();
  const directory = mkdtempSync(join(tmpdir(), "carmel-secret-import-"));
  try {
    db.update(agents).set({ workingDir: directory }).where(eq(agents.id, agentId)).run();
    writeFileSync(
      join(directory, ".env"),
      "EXISTING=from-file\nNEW_TOKEN=from-file\nEMPTY=\nPATH=/invalid\n",
    );
    writeAgentSecret(ownerUserId, agentId, "EXISTING", "stored-value");

    assert.deepEqual(agentWorkspaceDotEnvStatus(ownerUserId, agentId), { available: true });
    assert.deepEqual(importAgentWorkspaceDotEnv(ownerUserId, agentId), {
      imported: 1,
      skippedExisting: 1,
      skippedInvalid: 2,
    });
    assert.deepEqual(readAgentSecretEnv(agentId), [
      { name: "EXISTING", value: "stored-value" },
      { name: "NEW_TOKEN", value: "from-file" },
    ]);
    assert.deepEqual(importAgentWorkspaceDotEnv(ownerUserId, agentId), {
      imported: 0,
      skippedExisting: 2,
      skippedInvalid: 2,
    });
    assert.throws(
      () => importAgentWorkspaceDotEnv(createUser(), agentId),
      (error: unknown) => error instanceof AgentSecretError && error.status === 403,
    );

    rmSync(join(directory, ".env"));
    writeFileSync(join(directory, "outside.env"), "HOST_SECRET=leaked\n");
    symlinkSync(join(directory, "outside.env"), join(directory, ".env"));
    assert.deepEqual(agentWorkspaceDotEnvStatus(ownerUserId, agentId), { available: false });
    assert.throws(
      () => importAgentWorkspaceDotEnv(ownerUserId, agentId),
      (error: unknown) => error instanceof AgentSecretError && error.status === 404,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secrets are owner-only, not visible to other users of a shared agent", () => {
  const ownerUserId = createUser();
  const defaultModelRefId = createModelRef({ ownerUserId });
  const agentId = createAgent({ ownerUserId, defaultModelRefId, shared: true });
  writeAgentSecret(ownerUserId, agentId, "TOKEN", "value");

  const otherUserId = createUser();
  assert.throws(
    () => readAgentSecrets(otherUserId, agentId),
    (error: unknown) => error instanceof AgentSecretError && error.status === 403,
  );
  // The value still reaches the sandbox: a shared agent carries its owner's
  // secrets to whoever runs it, exactly as its mounts do.
  assert.deepEqual(readAgentSecretEnv(agentId), [{ name: "TOKEN", value: "value" }]);
});

test("names that are not shell identifiers are rejected", () => {
  const { ownerUserId, agentId } = fixture();
  for (const name of ["", "2FA_TOKEN", "my-token", "TOKEN=X", "TOKEN ONE"]) {
    assert.throws(
      () => writeAgentSecret(ownerUserId, agentId, name, "value"),
      (error: unknown) => error instanceof AgentSecretError && error.status === 400,
      `expected ${JSON.stringify(name)} to be rejected`,
    );
  }
});

test("names the sandbox controls cannot be claimed by a secret", () => {
  const { ownerUserId, agentId } = fixture();
  for (const name of ["PATH", "HOME", "LD_PRELOAD", "BASH_ENV"]) {
    assert.throws(
      () => writeAgentSecret(ownerUserId, agentId, name, "value"),
      (error: unknown) => error instanceof AgentSecretError && error.status === 400,
      `expected ${name} to be rejected`,
    );
  }
});

test("a reserved name written straight to the database is still filtered out of the exec env", () => {
  const { ownerUserId, agentId } = fixture();
  writeAgentSecret(ownerUserId, agentId, "TOKEN", "value");
  // Simulates a row that predates a name becoming reserved.
  db.insert(agentSecrets)
    .values({ agentId, name: "PATH", value: "/evil", createdAt: 1, updatedAt: 1 })
    .run();
  assert.deepEqual(readAgentSecretEnv(agentId), [{ name: "TOKEN", value: "value" }]);
});

test("deleting a secret removes it, and a missing one is a 404", () => {
  const { ownerUserId, agentId } = fixture();
  writeAgentSecret(ownerUserId, agentId, "TOKEN", "value");
  deleteAgentSecret(ownerUserId, agentId, "TOKEN");
  assert.deepEqual(readAgentSecrets(ownerUserId, agentId), []);
  assert.throws(
    () => deleteAgentSecret(ownerUserId, agentId, "TOKEN"),
    (error: unknown) => error instanceof AgentSecretError && error.status === 404,
  );
});

test("deleting an agent takes its secrets with it", () => {
  const { ownerUserId, agentId } = fixture();
  writeAgentSecret(ownerUserId, agentId, "TOKEN", "value");
  deleteAgentSecretsForAgent(agentId);
  assert.deepEqual(readAgentSecretEnv(agentId), []);
});
