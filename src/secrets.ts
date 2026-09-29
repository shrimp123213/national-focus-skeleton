import type { Config } from './model';

/**
 * Workflow Assistant keeps API credentials out of browser localStorage: they live in the
 * Tavern extension settings (saved by SillyTavern) with an IndexedDB mirror. The rest of the
 * configuration stays where it was, so importing a newer script build does not erase it.
 */
export type SecretEntry = { apiKey: string; authHeaders?: string };
export type SecretsPayload = { version: 1; byPreset: Record<string, SecretEntry> };
export interface SecretStore {
  /** False when no durable secret location exists; callers then keep the legacy behaviour. */
  readonly durable: boolean;
  load(): SecretsPayload | null;
  save(payload: SecretsPayload): void;
  /** Non-secret configuration mirrored to Tavern settings; null when none is stored. */
  loadConfig(): string | null;
  saveConfig(text: string): void;
}

const authLine = /^\s*(?:authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key)\s*:|\bbearer\s/i;

/** Split header text by line, as Workflow Assistant does, so non-secret headers keep their layout. */
export function splitAuthHeaders(headers: string): { publicHeaders: string; authHeaders: string } {
  const lines = String(headers || '').split('\n');
  const auth = lines.filter((line) => authLine.test(line));
  const rest = lines.filter((line) => !authLine.test(line));
  return { publicHeaders: rest.join('\n').trim(), authHeaders: auth.join('\n').trim() };
}
function joinHeaders(publicHeaders: string, authHeaders?: string): string {
  const auth = String(authHeaders || '').trim();
  const pub = String(publicHeaders || '').trim();
  return auth && pub ? `${auth}\n${pub}` : auth || pub;
}

export function hasSecrets(config: Pick<Config, 'apis'>): boolean {
  return config.apis.some((api) => api.apiKey || splitAuthHeaders(api.requestHeaders).authHeaders);
}
export function extractSecrets(config: Pick<Config, 'apis'>): SecretsPayload {
  const byPreset: Record<string, SecretEntry> = {};
  for (const api of config.apis) {
    const { authHeaders } = splitAuthHeaders(api.requestHeaders);
    if (api.apiKey || authHeaders) {
      byPreset[api.name] = { apiKey: api.apiKey, ...(authHeaders ? { authHeaders } : {}) };
    }
  }
  return { version: 1, byPreset };
}
export function stripSecrets<T extends Pick<Config, 'apis'>>(config: T): T {
  const next = structuredClone(config);
  next.apis = next.apis.map((api) => ({
    ...api,
    apiKey: '',
    requestHeaders: splitAuthHeaders(api.requestHeaders).publicHeaders,
  }));
  return next;
}
export function mergeSecrets<T extends Pick<Config, 'apis'>>(config: T, secrets: SecretsPayload | null): T {
  if (!secrets) {
    return config;
  }
  const next = structuredClone(config);
  next.apis = next.apis.map((api) => {
    const entry = secrets.byPreset[api.name];
    if (!entry) {
      return api;
    }
    return {
      ...api,
      apiKey: entry.apiKey || api.apiKey,
      requestHeaders: joinHeaders(splitAuthHeaders(api.requestHeaders).publicHeaders, entry.authHeaders),
    };
  });
  return next;
}
export function parseSecrets(text: unknown): SecretsPayload | null {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  try {
    const value = JSON.parse(text) as SecretsPayload;
    if (value?.version !== 1 || !value.byPreset || typeof value.byPreset !== 'object') {
      return null;
    }
    const byPreset: Record<string, SecretEntry> = {};
    for (const [name, entry] of Object.entries(value.byPreset)) {
      if (entry && typeof entry === 'object') {
        byPreset[name] = {
          apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : '',
          ...(typeof entry.authHeaders === 'string' && entry.authHeaders
            ? { authHeaders: entry.authHeaders }
            : {}),
        };
      }
    }
    return { version: 1, byPreset };
  } catch {
    return null;
  }
}

type SettingsHost = {
  extensionSettings?: Record<string, unknown>;
  saveSettingsDebounced?: () => unknown;
};
const namespace = 'national-focus__api_secrets_v1';
/**
 * The skeleton edition keeps its own task settings (its prompt chain and presets differ), but
 * starts from the v0.11 settings and shares the API credentials (namespace above).
 */
const configNamespace = 'national-focus-skeleton__config_v1';
const legacyConfigNamespace = 'national-focus__config_v1';
const databaseName = 'national_focus_api_secrets_v1';

/** Tavern extension settings, mirrored to IndexedDB. */
export class TavernSecretStore implements SecretStore {
  private mirror: string | null | undefined;
  constructor(
    private readonly host: () => SettingsHost | undefined,
    private readonly idb?: IDBFactory,
  ) {
    void this.preload();
  }
  private bucket(name = namespace): Record<string, string> | null {
    const root = this.host()?.extensionSettings;
    if (!root || typeof root !== 'object') {
      return null;
    }
    const scripts = ((root as Record<string, unknown>).__userscripts ??= {}) as Record<
      string,
      Record<string, string>
    >;
    return (scripts[name] ??= {});
  }
  private persist(): void {
    try {
      void this.host()?.saveSettingsDebounced?.();
    } catch {
      // Tavern persists extension settings on its own schedule when the debounce is unavailable.
    }
  }
  loadConfig(): string | null {
    for (const name of [configNamespace, legacyConfigNamespace]) {
      const text = this.bucket(name)?.config;
      if (typeof text === 'string' && text.trim()) {
        return text;
      }
    }
    return null;
  }
  saveConfig(text: string): void {
    const bucket = this.bucket(configNamespace);
    if (bucket && bucket.config !== text) {
      bucket.config = text;
      this.persist();
    }
  }
  get durable(): boolean {
    return Boolean(this.bucket());
  }
  load(): SecretsPayload | null {
    return parseSecrets(this.bucket()?.secrets) ?? parseSecrets(this.mirror);
  }
  save(payload: SecretsPayload): void {
    const text = JSON.stringify(payload);
    const bucket = this.bucket();
    if (bucket && bucket.secrets !== text) {
      bucket.secrets = text;
      this.persist();
    }
    this.mirror = text;
    void this.write(text);
  }
  private open(): Promise<IDBDatabase | null> {
    const idb = this.idb;
    if (!idb) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      try {
        const request = idb.open(databaseName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('kv');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  private async preload(): Promise<void> {
    const db = await this.open();
    if (!db) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get('secrets');
        request.onsuccess = () => {
          if (this.mirror === undefined) {
            this.mirror = typeof request.result === 'string' ? request.result : null;
          }
          resolve();
        };
        request.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  private async write(text: string): Promise<void> {
    const db = await this.open();
    if (!db) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        const request = db.transaction('kv', 'readwrite').objectStore('kv').put(text, 'secrets');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

/** Offline preview and tests: memory only. */
export class MemorySecretStore implements SecretStore {
  config: string | null = null;
  constructor(
    private payload: SecretsPayload | null = null,
    readonly durable = true,
  ) {}
  loadConfig(): string | null {
    return this.config;
  }
  saveConfig(text: string): void {
    this.config = text;
  }
  load(): SecretsPayload | null {
    return this.payload ? structuredClone(this.payload) : null;
  }
  save(payload: SecretsPayload): void {
    this.payload = structuredClone(payload);
  }
}
