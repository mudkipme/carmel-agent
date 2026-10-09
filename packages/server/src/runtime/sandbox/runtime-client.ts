import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Podman exposes a Docker-compatible REST API on its socket. We talk to it over
// a raw unix socket with node:http so we do not depend on the podman/docker CLI
// being present inside the carmel-agent container.
const apiVersion = "v1.41";

export function resolveRuntimeSocketPath(): string | undefined {
  const explicit = process.env.CARMEL_PODMAN_SOCKET?.trim();
  if (explicit) return explicit;

  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost?.startsWith("unix://")) return dockerHost.slice("unix://".length);

  const candidates = [
    process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, "podman", "podman.sock")
      : undefined,
    "/run/podman/podman.sock",
    "/var/run/docker.sock",
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path));
}

export function isSandboxConfigured() {
  const socketPath = resolveRuntimeSocketPath();
  return Boolean(socketPath && existsSync(socketPath));
}

export function sandboxUnavailableMessage() {
  return (
    "The bash sandbox is unavailable: no reachable Podman (or Docker) socket was found. " +
    "Start the rootless Podman socket (`systemctl --user enable --now podman.socket`) or set " +
    "CARMEL_PODMAN_SOCKET to its path. Bash is disabled until a socket is reachable."
  );
}

type RequestOptions = {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  apiVersion?: string;
};

function runtimeRequest(options: RequestOptions): Promise<IncomingMessage> {
  const socketPath = resolveRuntimeSocketPath();
  if (!socketPath) return Promise.reject(new Error(sandboxUnavailableMessage()));

  const payload =
    options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: options.method,
        path: `/${options.apiVersion ?? apiVersion}${buildPath(options.path, options.query)}`,
        headers: {
          host: "localhost",
          ...(payload
            ? { "content-type": "application/json", "content-length": String(payload.length) }
            : {}),
        },
        signal: options.signal,
      },
      resolve,
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readBody(res: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function readJson<T = unknown>(res: IncomingMessage): Promise<T | undefined> {
  const text = await readBody(res);
  return text ? (JSON.parse(text) as T) : undefined;
}

async function drain(res: IncomingMessage) {
  for await (const _chunk of res) void _chunk;
}

async function expectStatus(res: IncomingMessage, allowed: number[], context: string) {
  const status = res.statusCode ?? 0;
  if (allowed.includes(status)) return;
  throw new Error(`${context} failed with ${status}: ${(await readBody(res)).slice(0, 500)}`);
}

/** Read daemon metadata, including Podman's native info when requested. */
export async function runtimeInfo<T>(path: "/version" | "/info" | "/libpod/info"): Promise<T> {
  const res = await runtimeRequest({
    method: "GET",
    path,
    signal: AbortSignal.timeout(10000),
    ...(path === "/libpod/info" ? { apiVersion: "v4.0.0" } : {}),
  });
  await expectStatus(res, [200], "Inspecting sandbox runtime");
  const info = await readJson<T>(res);
  if (!info) throw new Error("Sandbox runtime returned empty metadata.");
  return info;
}

// Docker/Podman multiplexes stdout and stderr into a single stream when no TTY
// is attached. Each frame is an 8-byte header [stream, 0, 0, 0, size(uint32 BE)]
// followed by `size` payload bytes. Frames can span chunk boundaries.
export function createStreamDemuxer(
  onPayload: (stream: number, chunk: Buffer) => void,
  maxPayloadBytes = Infinity,
) {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const payloadLength = buffer.readUInt32BE(4);
      if (payloadLength > maxPayloadBytes)
        throw new Error("Container stream frame exceeds its size limit.");
      if (buffer.length < 8 + payloadLength) break;
      onPayload(buffer[0] ?? 0, buffer.subarray(8, 8 + payloadLength));
      buffer = buffer.subarray(8 + payloadLength);
    }
  };
}

export function parseImageRef(image: string): { name: string; tag: string } {
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  // A colon before the last slash is a registry port (e.g. localhost:5000/x), not a tag.
  if (lastColon > lastSlash)
    return { name: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  return { name: image, tag: "latest" };
}

export async function imageExists(image: string) {
  const res = await runtimeRequest({
    method: "GET",
    path: `/images/${encodeURIComponent(image)}/json`,
  });
  const status = res.statusCode ?? 0;
  await drain(res);
  return status === 200;
}

export async function pullImage(image: string) {
  const { name, tag } = parseImageRef(image);
  const res = await runtimeRequest({
    method: "POST",
    path: "/images/create",
    query: { fromImage: name, tag },
  });
  await expectStatus(res, [200], `Pulling image ${image}`);
  // The pull progress is streamed as the response body; consume it to completion.
  await drain(res);
}

export type CreateContainerSpec = Record<string, unknown>;

export async function createContainer(name: string, spec: CreateContainerSpec) {
  const res = await runtimeRequest({
    method: "POST",
    path: "/containers/create",
    query: { name },
    body: spec,
  });
  await expectStatus(res, [201], "Creating container");
  const data = await readJson<{ Id: string }>(res);
  if (!data?.Id) throw new Error("Container create response did not include an id.");
  return data.Id;
}

export async function startContainer(containerId: string) {
  const res = await runtimeRequest({ method: "POST", path: `/containers/${containerId}/start` });
  await expectStatus(res, [204, 304], "Starting container");
  await drain(res);
}

export async function isContainerRunning(containerId: string) {
  const res = await runtimeRequest({ method: "GET", path: `/containers/${containerId}/json` });
  if (res.statusCode === 404) {
    await drain(res);
    return false;
  }
  const data = await readJson<{ State?: { Running?: boolean } }>(res);
  return Boolean(data?.State?.Running);
}

// Returns true only when the container is confirmed gone (deleted, or already
// absent). A transient failure (socket error, 409/500) returns false so callers
// can keep tracking it and retry instead of silently leaking an orphan.
export async function removeContainer(containerId: string): Promise<boolean> {
  try {
    const stopRes = await runtimeRequest({
      method: "POST",
      path: `/containers/${containerId}/stop`,
      query: { t: 2 },
    });
    await drain(stopRes);
  } catch {
    // Already stopped or gone.
  }
  try {
    const rmRes = await runtimeRequest({
      method: "DELETE",
      path: `/containers/${containerId}`,
      query: { force: true, v: true },
    });
    const status = rmRes.statusCode ?? 0;
    await drain(rmRes);
    // 204 = removed, 404 = already gone. Anything else (e.g. 409 conflict, 500)
    // means the container may still be running, so removal is not confirmed.
    return status === 204 || status === 404;
  } catch {
    // Socket/network error — removal could not be confirmed.
    return false;
  }
}

// `Created` is a unix timestamp in seconds (Docker/Podman compatible).
export type ManagedContainer = { Id: string; Created: number };

export async function listManagedContainers(label: string): Promise<ManagedContainer[]> {
  const res = await runtimeRequest({
    method: "GET",
    path: "/containers/json",
    query: { all: true, filters: JSON.stringify({ label: [label] }) },
  });
  await expectStatus(res, [200], "Listing managed containers");
  return (await readJson<ManagedContainer[]>(res)) ?? [];
}

export type ContainerExecResult = { exitCode: number | null };

export async function execInContainer(
  containerId: string,
  spec: { cmd: string[]; workingDir: string; env: string[] },
  options: {
    onStdout: (chunk: Buffer) => void;
    onStderr: (chunk: Buffer) => void;
    signal?: AbortSignal;
  },
): Promise<ContainerExecResult> {
  const createRes = await runtimeRequest({
    method: "POST",
    path: `/containers/${containerId}/exec`,
    body: {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: spec.cmd,
      WorkingDir: spec.workingDir,
      Env: spec.env,
    },
  });
  await expectStatus(createRes, [201], "Creating exec");
  const exec = await readJson<{ Id: string }>(createRes);
  if (!exec?.Id) throw new Error("Exec create response did not include an id.");

  const startRes = await runtimeRequest({
    method: "POST",
    path: `/exec/${exec.Id}/start`,
    body: { Detach: false, Tty: false },
    signal: options.signal,
  });
  await expectStatus(startRes, [200], "Starting exec");

  const demux = createStreamDemuxer((stream, chunk) => {
    if (stream === 2) options.onStderr(chunk);
    else if (stream === 1) options.onStdout(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      startRes.on("data", (chunk: Buffer) => {
        try {
          demux(chunk);
        } catch (error) {
          reject(error);
        }
      });
      startRes.on("end", resolve);
      startRes.on("error", reject);
    });
  } catch (error) {
    if (options.signal?.aborted) return { exitCode: null };
    throw error;
  }

  const inspect = await readJson<{ ExitCode?: number | null }>(
    await runtimeRequest({ method: "GET", path: `/exec/${exec.Id}/json` }),
  );
  return { exitCode: typeof inspect?.ExitCode === "number" ? inspect.ExitCode : null };
}

/**
 * Attach an interactive TTY exec and hand back the raw duplex socket.
 *
 * Docker's API "hijacks" the connection for an interactive attach: the server
 * answers the start request with `101 Upgrade` and from then on the socket
 * carries raw terminal bytes in both directions rather than HTTP. With `Tty`
 * set there is no 8-byte stream framing either -- stdout and stderr are merged
 * onto one stream, which is exactly what a terminal emulator wants.
 */
export async function attachExecTty(
  containerId: string,
  spec: { cmd: string[]; workingDir: string; env: string[] },
): Promise<{ execId: string; socket: Duplex }> {
  return attachExec(containerId, spec, true);
}

/** Duplex stdin/stdout attach for sandboxed MCP servers; stderr stays separate. */
export async function attachExecStdio(
  containerId: string,
  spec: { cmd: string[]; workingDir: string; env: string[] },
  signal?: AbortSignal,
): Promise<{ execId: string; socket: Duplex }> {
  return attachExec(containerId, spec, false, signal);
}

async function attachExec(
  containerId: string,
  spec: { cmd: string[]; workingDir: string; env: string[] },
  tty: boolean,
  signal?: AbortSignal,
): Promise<{ execId: string; socket: Duplex }> {
  const createRes = await runtimeRequest({
    method: "POST",
    path: `/containers/${containerId}/exec`,
    body: {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      Cmd: spec.cmd,
      WorkingDir: spec.workingDir,
      Env: spec.env,
    },
    signal,
  });
  await expectStatus(createRes, [201], "Creating terminal exec");
  const exec = await readJson<{ Id: string }>(createRes);
  if (!exec?.Id) throw new Error("Terminal exec create response did not include an id.");

  const socketPath = resolveRuntimeSocketPath();
  if (!socketPath) throw new Error(sandboxUnavailableMessage());

  const socket = await new Promise<Duplex>((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      method: "POST",
      path: `/${apiVersion}/exec/${exec.Id}/start`,
      headers: {
        host: "localhost",
        "content-type": "application/json",
        // Without these the daemon answers with a normal buffered response and
        // stdin is never connected, which looks like a terminal that accepts no
        // input rather than an error.
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
      signal,
    });
    req.on("upgrade", (_res, upgraded, head) => {
      if (head.length) upgraded.unshift(head);
      resolve(upgraded);
    });
    req.on("response", async (res) => {
      reject(
        new Error(
          `Terminal exec was not upgraded (${res.statusCode}): ${(await readBody(res)).slice(0, 300)}`,
        ),
      );
    });
    req.on("error", reject);
    req.end(JSON.stringify({ Detach: false, Tty: tty }));
  });

  return { execId: exec.Id, socket };
}

/**
 * Resize a live exec's pseudo-terminal.
 *
 * Only valid once the exec is running: called before the attach it answers 500,
 * and called after it has exited it answers 500 as well. Both are non-fatal, so
 * failures here are swallowed by the caller rather than tearing down a session
 * that is otherwise fine.
 */
export async function resizeExec(execId: string, rows: number, cols: number) {
  const res = await runtimeRequest({
    method: "POST",
    path: `/exec/${execId}/resize`,
    query: { h: Math.max(1, Math.floor(rows)), w: Math.max(1, Math.floor(cols)) },
  });
  const status = res.statusCode ?? 0;
  await drain(res);
  return status === 200 || status === 201;
}

function buildPath(path: string, query?: RequestOptions["query"]) {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}
