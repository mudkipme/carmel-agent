import { AuthStorage, type AuthCredential, type AuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { providerConfigs } from "../db/schema.ts";
import { protectJsonSecret, protectSecret, revealJsonSecret, revealSecret } from "../security.ts";

type LockResult<T> = {
  result: T;
  next?: string;
};

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;

export function createProviderConfigAuthStorage(providerConfig: ProviderConfigRecord, provider: string) {
  return AuthStorage.fromStorage(new ProviderConfigAuthStorageBackend(providerConfig.id, provider));
}

class ProviderConfigAuthStorageBackend implements AuthStorageBackend {
  constructor(
    private readonly providerConfigId: string,
    private readonly provider: string,
  ) {}

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const current = this.read();
    const { result, next } = fn(current);
    if (next !== undefined) this.write(next);
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    sqlite.prepare("BEGIN IMMEDIATE").run();
    try {
      const current = this.read();
      const { result, next } = await fn(current);
      if (next !== undefined) this.write(next);
      sqlite.prepare("COMMIT").run();
      return result;
    } catch (error) {
      sqlite.prepare("ROLLBACK").run();
      throw error;
    }
  }

  private read() {
    const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, this.providerConfigId)).get();
    const oauthCredential = revealJsonSecret(providerConfig?.oauthCredential);
    const apiKey = revealSecret(providerConfig?.apiKey);
    const credential: AuthCredential | undefined =
      providerConfig?.authType === "oauth" && oauthCredential
        ? oauthCredential
        : apiKey
          ? { type: "api_key", key: apiKey }
          : undefined;
    return JSON.stringify(credential ? { [this.provider]: credential } : {});
  }

  private write(next: string) {
    const parsed = JSON.parse(next) as Record<string, AuthCredential | undefined>;
    const credential = parsed[this.provider];
    const patch =
      credential?.type === "oauth"
        ? {
            authType: "oauth" as const,
            apiKey: null,
            oauthCredential: protectJsonSecret(credential),
          }
        : credential?.type === "api_key"
          ? {
              authType: "api_key" as const,
              apiKey: protectSecret(credential.key),
              oauthCredential: null,
            }
          : {
              apiKey: null,
              oauthCredential: null,
            };
    db.update(providerConfigs)
      .set({
        ...patch,
        updatedAt: now(),
      })
      .where(eq(providerConfigs.id, this.providerConfigId))
      .run();
  }
}
