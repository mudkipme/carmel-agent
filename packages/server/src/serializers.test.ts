import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { modelRefRequestSchema, providerConfigRequestSchema } from "./validation.ts";
import { db, migrate } from "./db/index.ts";
import { modelRefs, providerConfigs } from "./db/schema.ts";
import { serializeModelRef, serializeProviderConfig } from "./serializers.ts";
import { createModelRef, createProviderConfig, createUser } from "./test-support.ts";

migrate();

// Clients echo a serialized resource back on save, so anything the serializer
// emits has to survive the strict command schema. Storage-only columns leaking
// out of a row spread made "share this model" fail on the round trip.
test("a serialized model ref round-trips through the strict command schema", () => {
  const userId = createUser();
  const modelRefId = createModelRef({ ownerUserId: userId });
  const row = db.select().from(modelRefs).where(eq(modelRefs.id, modelRefId)).get()!;

  const serialized = serializeModelRef(row);
  assert.equal("createdAt" in serialized, false);
  assert.equal("updatedAt" in serialized, false);

  const { id: _id, ownerUserId: _ownerUserId, ...command } = serialized;
  const parsed = modelRefRequestSchema.safeParse({ ...command, shared: true });
  assert.equal(parsed.success, true, parsed.error?.message);
});

test("a serialized provider config withholds stored credentials", () => {
  const userId = createUser();
  const configId = createProviderConfig(userId);
  db.update(providerConfigs)
    .set({ apiKey: "sk-secret", oauthCredential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 } })
    .where(eq(providerConfigs.id, configId))
    .run();
  const row = db.select().from(providerConfigs).where(eq(providerConfigs.id, configId)).get()!;

  const serialized = serializeProviderConfig(row);
  assert.equal("oauthCredential" in serialized, false);
  assert.equal(serialized.apiKey, undefined);
  assert.equal(serialized.hasApiKey, true);
  assert.equal(serialized.hasOAuth, true);
  assert.equal(JSON.stringify(serialized).includes("refresh-token"), false);

  const parsed = providerConfigRequestSchema.safeParse({
    label: serialized.label,
    provider: serialized.provider,
    authType: serialized.authType,
    baseUrl: serialized.baseUrl,
  });
  assert.equal(parsed.success, true, parsed.error?.message);
});
