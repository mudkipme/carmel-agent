import { i18n } from "@lingui/core";
import { apiRoutes, type ApiOperations } from "@carmel-agent/shared/api";
import type {
  AgentConfig,
  ModelCatalog,
  ModelRef,
  ProviderConfig,
  Session,
  SessionMetadata,
  User,
  UserMessageEditOptions,
} from "@carmel-agent/shared";
import { updateConnection } from "../update-connection.ts";

export type EditSessionMessageOptions = UserMessageEditOptions & {
  truncate?: boolean;
  thinkingLevel?: Session["thinkingLevel"];
};

export type BootstrapPayload = {
  users: User[];
  agents: AgentConfig[];
  providerConfigs: ProviderConfig[];
  modelRefs: ModelRef[];
  modelCatalog: ModelCatalog;
  sessions: SessionMetadata[];
};

export type UploadOptions = {
  overwrite?: boolean;
  signal?: AbortSignal;
  /** Fraction of the file sent so far, 0 to 1. */
  onProgress?: (fraction: number) => void;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The one place credentials are attached. Returns the raw `Response` without
 * throwing, for run admission requests that must inspect status codes
 * themselves; everything else should go through `request`.
 */
export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });
}

export function readErrorMessage(body: string) {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : body;
  } catch {
    return body;
  }
}

/** Build the `ApiError` for a failed response, unwrapping the server's `{error}` body. */
export async function apiError(
  response: Response,
  fallback = i18n._("Request failed: {status}", { status: response.status }),
) {
  const body = await response.text().catch(() => "");
  return new ApiError(readErrorMessage(body) || fallback, response.status);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) throw await apiError(response);
  const result = (await response.json()) as T;
  // A command response can arrive after a newer socket notification.
  if (init?.method && !["GET", "HEAD"].includes(init.method))
    queueMicrotask(() => updateConnection.refreshState(["sessions"]));
  return result;
}

type Operation = keyof ApiOperations;
type Query = Record<string, string | number | boolean | readonly string[] | undefined>;
type Fields<O extends Operation> = ([ApiOperations[O]["path"]] extends [never]
  ? unknown
  : { path: ApiOperations[O]["path"] }) &
  ([ApiOperations[O]["query"]] extends [never]
    ? unknown
    : object extends ApiOperations[O]["query"]
      ? { query?: ApiOperations[O]["query"] }
      : { query: ApiOperations[O]["query"] }) &
  ([ApiOperations[O]["body"]] extends [never] ? unknown : { body: ApiOperations[O]["body"] });
type CallOptions<O extends Operation> = Fields<O> & Omit<RequestInit, "body" | "method">;

/** The URL of an operation, with its path parameters encoded and its query appended. */
export function apiUrl(path: string, params: Record<string, string> = {}, query: Query = {}) {
  const url = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(params[name]!));
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) search.append(name, item);
    else search.append(name, String(value));
  }
  return search.size ? `${url}?${search}` : url;
}

/** Call an operation of the generated API contract; its path, query, body, and result are typed. */
export function call<O extends Operation>(
  operation: O,
  ...[options]: object extends Fields<O> ? [CallOptions<O>?] : [CallOptions<O>]
): Promise<ApiOperations[O]["response"]> {
  const { path, query, body, ...init } = (options ?? {}) as {
    path?: Record<string, string>;
    query?: Query;
    body?: unknown;
  } & RequestInit;
  const route = apiRoutes[operation];
  return request(apiUrl(route.path, path, query), {
    ...init,
    method: route.method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
