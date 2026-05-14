import {
  AppStorage,
  CustomProvidersStore,
  ProviderKeysStore,
  SessionsStore,
  SettingsStore,
  setAppStorage,
  type StorageBackend,
  type StorageTransaction,
} from "@earendil-works/pi-web-ui";

let ready: Promise<void> | undefined;

export function ensurePiWebUiStorage() {
  ready ??= Promise.resolve().then(() => {
    const settings = new SettingsStore();
    const providerKeys = new ProviderKeysStore();
    const sessions = new SessionsStore();
    const customProviders = new CustomProvidersStore();
    const backend = new MemoryStorageBackend();

    settings.setBackend(backend);
    providerKeys.setBackend(backend);
    sessions.setBackend(backend);
    customProviders.setBackend(backend);
    setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));
  });

  return ready;
}

class MemoryStorageBackend implements StorageBackend {
  private stores = new Map<string, Map<string, unknown>>();

  async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
    return (this.stores.get(storeName)?.get(key) as T | undefined) ?? null;
  }

  async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
    this.store(storeName).set(key, value);
  }

  async delete(storeName: string, key: string): Promise<void> {
    this.stores.get(storeName)?.delete(key);
  }

  async keys(storeName: string, prefix?: string): Promise<string[]> {
    const keys = [...(this.stores.get(storeName)?.keys() ?? [])];
    return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  }

  async getAllFromIndex<T = unknown>(storeName: string): Promise<T[]> {
    return [...(this.stores.get(storeName)?.values() ?? [])] as T[];
  }

  async clear(storeName: string): Promise<void> {
    this.stores.get(storeName)?.clear();
  }

  async has(storeName: string, key: string): Promise<boolean> {
    return this.stores.get(storeName)?.has(key) ?? false;
  }

  async transaction<T>(
    _storeNames: string[],
    _mode: "readonly" | "readwrite",
    operation: (tx: StorageTransaction) => Promise<T>,
  ): Promise<T> {
    return operation({
      get: (storeName, key) => this.get(storeName, key),
      set: (storeName, key, value) => this.set(storeName, key, value),
      delete: (storeName, key) => this.delete(storeName, key),
    });
  }

  async getQuotaInfo() {
    return { usage: 0, quota: Number.POSITIVE_INFINITY, percent: 0 };
  }

  async requestPersistence() {
    return true;
  }

  private store(name: string) {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }
}
