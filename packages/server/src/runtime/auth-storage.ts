import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { now } from "../db/seed.ts";
import { providerConfigs } from "../db/schema.ts";
import { protectJsonSecret, protectSecret, revealJsonSecret, revealSecret } from "../security.ts";

type ProviderConfigRecord = typeof providerConfigs.$inferSelect;

export function createProviderConfigCredentialStore(providerConfig: ProviderConfigRecord, provider: string) {
  return new ProviderConfigCredentialStore(providerConfig.id, provider);
}

class ProviderConfigCredentialStore implements CredentialStore {
  constructor(
    private readonly providerConfigId: string,
    private readonly provider: string,
  ) {}

  async read(providerId: string) {
    return providerId === this.provider ? this.readCredential() : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credential = this.readCredential();
    return credential ? [{ providerId: this.provider, type: credential.type }] : [];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    if (providerId !== this.provider) return undefined;
    sqlite.prepare("BEGIN IMMEDIATE").run();
    try {
      const current = this.readCredential();
      const next = await fn(current);
      if (next !== undefined) this.writeCredential(next);
      sqlite.prepare("COMMIT").run();
      return next ?? current;
    } catch (error) {
      sqlite.prepare("ROLLBACK").run();
      throw error;
    }
  }

  async delete(providerId: string) {
    if (providerId !== this.provider) return;
    sqlite.prepare("BEGIN IMMEDIATE").run();
    try {
      this.writeCredential(undefined);
      sqlite.prepare("COMMIT").run();
    } catch (error) {
      sqlite.prepare("ROLLBACK").run();
      throw error;
    }
  }

  private readCredential(): Credential | undefined {
    const providerConfig = db.select().from(providerConfigs).where(eq(providerConfigs.id, this.providerConfigId)).get();
    const oauthCredential = revealJsonSecret(providerConfig?.oauthCredential);
    const apiKey = revealSecret(providerConfig?.apiKey);
    return (
      providerConfig?.authType === "oauth" && oauthCredential
        ? oauthCredential
        : apiKey
          ? { type: "api_key", key: apiKey }
          : undefined
    );
  }

  private writeCredential(credential: Credential | undefined) {
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
