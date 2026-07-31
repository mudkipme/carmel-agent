import type BetterSqlite3 from "better-sqlite3";
import type { Api, Model, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { sqlite } from "../db/index.ts";

type StoredCatalogRow = {
  models: string;
  checkedAt: number | null;
  lastModified: number | null;
  etag: string | null;
};

/** Pi ModelsStore persisted in Carmel's metadata database. */
export class SqliteModelsStore implements ModelsStore {
  constructor(private readonly database: BetterSqlite3.Database = sqlite) {}

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const row = this.database.prepare(`
      SELECT models, checked_at AS checkedAt, last_modified AS lastModified, etag
      FROM model_catalogs WHERE provider_id = ?
    `).get(providerId) as StoredCatalogRow | undefined;
    if (!row) return undefined;
    let models: unknown;
    try {
      models = JSON.parse(row.models) as unknown;
    } catch {
      await this.delete(providerId);
      return undefined;
    }
    if (!Array.isArray(models)) {
      await this.delete(providerId);
      return undefined;
    }
    return {
      models: models as Array<Model<Api>>,
      checkedAt: row.checkedAt ?? undefined,
      lastModified: row.lastModified ?? undefined,
      etag: row.etag ?? undefined,
    };
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.database.prepare(`
      INSERT INTO model_catalogs (provider_id, models, checked_at, last_modified, etag)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        models = excluded.models,
        checked_at = excluded.checked_at,
        last_modified = excluded.last_modified,
        etag = excluded.etag
    `).run(
      providerId,
      JSON.stringify(entry.models),
      entry.checkedAt ?? null,
      entry.lastModified ?? null,
      entry.etag ?? null,
    );
  }

  async delete(providerId: string): Promise<void> {
    this.database.prepare("DELETE FROM model_catalogs WHERE provider_id = ?").run(providerId);
  }
}

export const modelCatalogStore = new SqliteModelsStore();
