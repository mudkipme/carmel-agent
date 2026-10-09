import type BetterSqlite3 from "better-sqlite3";
import {
  isModelType,
  type AnyModel,
  type Api,
  type Model,
  type ModelsStore,
  type ModelsStoreEntry,
} from "@earendil-works/pi-ai";
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
    const row = this.database
      .prepare(`
      SELECT models, checked_at AS checkedAt, last_modified AS lastModified, etag
      FROM model_catalogs WHERE provider_id = ?
    `)
      .get(providerId) as StoredCatalogRow | undefined;
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
      models: models as AnyModel[],
      checkedAt: row.checkedAt ?? undefined,
      lastModified: row.lastModified ?? undefined,
      etag: row.etag ?? undefined,
    };
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.database
      .prepare(`
      INSERT INTO model_catalogs (provider_id, models, checked_at, last_modified, etag)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        models = excluded.models,
        checked_at = excluded.checked_at,
        last_modified = excluded.last_modified,
        etag = excluded.etag
    `)
      .run(
        providerId,
        JSON.stringify(entry.models),
        entry.checkedAt ?? null,
        entry.lastModified ?? null,
        entry.etag ?? null,
      );
    catalogCache.delete(providerId);
  }

  async delete(providerId: string): Promise<void> {
    this.database.prepare("DELETE FROM model_catalogs WHERE provider_id = ?").run(providerId);
    catalogCache.delete(providerId);
  }
}

export const modelCatalogStore = new SqliteModelsStore();

/**
 * Parsed catalogs keyed by provider. Populated lazily and dropped whenever that
 * provider's row is rewritten, so a refresh is picked up on the next read.
 */
const catalogCache = new Map<string, Map<string, Model<Api>>>();

function readCachedCatalog(providerId: string, database: BetterSqlite3.Database = sqlite) {
  const cached = catalogCache.get(providerId);
  if (cached) return cached;
  const row = database
    .prepare("SELECT models FROM model_catalogs WHERE provider_id = ?")
    .get(providerId) as { models: string } | undefined;
  const models = new Map<string, Model<Api>>();
  if (row) {
    try {
      const parsed = JSON.parse(row.models) as unknown;
      if (Array.isArray(parsed)) {
        for (const model of parsed as AnyModel[]) {
          if (model?.id && isModelType(model, "chat")) models.set(model.id, model);
        }
      }
    } catch {
      // A corrupt row is treated as an empty catalog; SqliteModelsStore.read
      // deletes it on the next async read.
    }
  }
  catalogCache.set(providerId, models);
  return models;
}

/**
 * Synchronous catalog lookup for the serializers, which run outside async
 * request paths and have no `ModelRuntime`. Without this a stored model entry
 * only ever sees the bundled catalog, which declares no `thinkingLevelMap`, so
 * every model's thinking selector falls back to the generic off..high range.
 */
export function getCachedCatalogModel(
  providerId: string,
  modelId: string,
  database?: BetterSqlite3.Database,
): Model<Api> | undefined {
  return readCachedCatalog(providerId, database).get(modelId);
}

/** Drops memoized catalogs so the next lookup re-reads SQLite. */
export function resetCatalogCache() {
  catalogCache.clear();
}
