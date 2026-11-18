import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, initialize } from "../db/index.ts";
import { environmentSecrets } from "../db/schema.ts";
import {
  agentEnvironmentId,
  createAgent,
  createEnvironment,
  createModelRef,
  createUser,
} from "../test-support.ts";
import {
  SecretError,
  deleteEnvironmentSecret,
  environmentWorkspaceDotEnvStatus,
  importEnvironmentWorkspaceDotEnv,
  readEnvironmentSecretEnv,
  readEnvironmentSecrets,
  writeEnvironmentSecret,
} from "./environment-secrets.ts";

initialize();

function fixture() {
  const ownerUserId = createUser();
  return { ownerUserId, environmentId: createEnvironment(ownerUserId) };
}

test("a stored secret is listed by name and never by value", () => {
  const { ownerUserId, environmentId } = fixture();
  const secret = writeEnvironmentSecret(ownerUserId, environmentId, "GITHUB_TOKEN", "ghp_example");
  assert.deepEqual(Object.keys(secret).sort(), ["environmentId", "name", "updatedAt"]);
  assert.deepEqual(
    readEnvironmentSecrets(ownerUserId, environmentId).map((item) => item.name),
    ["GITHUB_TOKEN"],
  );
});

test("writing the same name twice rotates the value instead of duplicating it", () => {
  const { ownerUserId, environmentId } = fixture();
  writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "first");
  writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "second");
  assert.equal(readEnvironmentSecrets(ownerUserId, environmentId).length, 1);
  assert.deepEqual(readEnvironmentSecretEnv(environmentId), [{ name: "TOKEN", value: "second" }]);
});

test("an agent's .env import adds valid secrets without replacing stored values", () => {
  const ownerUserId = createUser();
  const directory = mkdtempSync(join(tmpdir(), "carmel-secret-import-"));
  const agentId = createAgent({
    ownerUserId,
    defaultModelRefId: createModelRef({ ownerUserId }),
    workingDir: directory,
  });
  const environmentId = agentEnvironmentId(agentId);
  try {
    writeFileSync(
      join(directory, ".env"),
      "EXISTING=from-file\nNEW_TOKEN=from-file\nEMPTY=\nPATH=/invalid\n",
    );
    writeEnvironmentSecret(ownerUserId, environmentId, "EXISTING", "stored-value");

    assert.deepEqual(environmentWorkspaceDotEnvStatus(ownerUserId, environmentId, agentId), {
      available: true,
    });
    assert.deepEqual(importEnvironmentWorkspaceDotEnv(ownerUserId, environmentId, agentId), {
      imported: 1,
      skippedExisting: 1,
      skippedInvalid: 2,
    });
    assert.deepEqual(readEnvironmentSecretEnv(environmentId), [
      { name: "EXISTING", value: "stored-value" },
      { name: "NEW_TOKEN", value: "from-file" },
    ]);
    assert.deepEqual(importEnvironmentWorkspaceDotEnv(ownerUserId, environmentId, agentId), {
      imported: 0,
      skippedExisting: 2,
      skippedInvalid: 2,
    });
    assert.throws(
      () => importEnvironmentWorkspaceDotEnv(createUser(), environmentId, agentId),
      (error: unknown) => error instanceof SecretError && error.status === 403,
    );

    rmSync(join(directory, ".env"));
    writeFileSync(join(directory, "outside.env"), "HOST_SECRET=leaked\n");
    symlinkSync(join(directory, "outside.env"), join(directory, ".env"));
    assert.deepEqual(environmentWorkspaceDotEnvStatus(ownerUserId, environmentId, agentId), {
      available: false,
    });
    assert.throws(
      () => importEnvironmentWorkspaceDotEnv(ownerUserId, environmentId, agentId),
      (error: unknown) => error instanceof SecretError && error.status === 404,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("secrets are owner-only, not visible to other users of a shared agent", () => {
  const { ownerUserId, environmentId } = fixture();
  const defaultModelRefId = createModelRef({ ownerUserId });
  createAgent({ ownerUserId, defaultModelRefId, shared: true, environmentId });
  writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "value");

  const otherUserId = createUser();
  assert.throws(
    () => readEnvironmentSecrets(otherUserId, environmentId),
    (error: unknown) => error instanceof SecretError && error.status === 403,
  );
  // The value still reaches the sandbox: a shared agent carries its owner's
  // secrets to whoever runs it, exactly as its mounts do.
  assert.deepEqual(readEnvironmentSecretEnv(environmentId), [{ name: "TOKEN", value: "value" }]);
});

test("agents sharing an environment receive the same secrets", () => {
  const { ownerUserId, environmentId } = fixture();
  const defaultModelRefId = createModelRef({ ownerUserId });
  createAgent({ ownerUserId, defaultModelRefId, environmentId });
  createAgent({ ownerUserId, defaultModelRefId, environmentId });
  writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "rotated once");
  assert.deepEqual(readEnvironmentSecretEnv(environmentId), [
    { name: "TOKEN", value: "rotated once" },
  ]);
  assert.deepEqual(readEnvironmentSecretEnv(createEnvironment(ownerUserId)), []);
});

test("names that are not shell identifiers are rejected", () => {
  const { ownerUserId, environmentId } = fixture();
  for (const name of ["", "2FA_TOKEN", "my-token", "TOKEN=X", "TOKEN ONE"]) {
    assert.throws(
      () => writeEnvironmentSecret(ownerUserId, environmentId, name, "value"),
      (error: unknown) => error instanceof SecretError && error.status === 400,
      `expected ${JSON.stringify(name)} to be rejected`,
    );
  }
});

test("names the sandbox controls cannot be claimed by a secret", () => {
  const { ownerUserId, environmentId } = fixture();
  for (const name of ["PATH", "HOME", "LD_PRELOAD", "BASH_ENV"]) {
    assert.throws(
      () => writeEnvironmentSecret(ownerUserId, environmentId, name, "value"),
      (error: unknown) => error instanceof SecretError && error.status === 400,
      `expected ${name} to be rejected`,
    );
  }
});

test("a reserved name written straight to the database is still filtered out of the exec env", () => {
  const { ownerUserId, environmentId } = fixture();
  writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "value");
  // Simulates a row that predates a name becoming reserved.
  db.insert(environmentSecrets)
    .values({ environmentId, name: "PATH", value: "/evil", createdAt: 1, updatedAt: 1 })
    .run();
  assert.deepEqual(readEnvironmentSecretEnv(environmentId), [{ name: "TOKEN", value: "value" }]);
});

test("deleting a secret removes it, and a missing one is a 404", () => {
  const { ownerUserId, environmentId } = fixture();
  writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "value");
  deleteEnvironmentSecret(ownerUserId, environmentId, "TOKEN");
  assert.deepEqual(readEnvironmentSecrets(ownerUserId, environmentId), []);
  assert.throws(
    () => deleteEnvironmentSecret(ownerUserId, environmentId, "TOKEN"),
    (error: unknown) => error instanceof SecretError && error.status === 404,
  );
});

test("writeEnvironmentSecret rejects NUL bytes and maps missing CARMEL_SECRET_KEY to 503", () => {
  const { ownerUserId, environmentId } = fixture();
  assert.throws(
    () => writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "abc\0def"),
    (error: unknown) => error instanceof SecretError && error.status === 400,
  );
  const previous = process.env.CARMEL_SECRET_KEY;
  delete process.env.CARMEL_SECRET_KEY;
  try {
    assert.throws(
      () => writeEnvironmentSecret(ownerUserId, environmentId, "TOKEN", "enc:v1:forged"),
      (error: unknown) => error instanceof SecretError && error.status === 503,
    );
  } finally {
    if (previous !== undefined) process.env.CARMEL_SECRET_KEY = previous;
  }
});
