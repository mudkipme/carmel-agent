import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import type { KnowledgeSettings } from "@carmel-agent/shared";
import { knowledgeLock } from "./queue.ts";
import { dataDir } from "../../paths.ts";
import { isAbsolute, relative, resolve } from "node:path";
import {
  attachExecStdio,
  createContainer,
  createStreamDemuxer,
  imageExists,
  isSandboxConfigured,
  listManagedContainers,
  removeContainer,
  startContainer,
} from "../sandbox/runtime-client.ts";
import {
  resolveSandboxIdentity,
  type SandboxIdentity,
} from "../sandbox/runtime-identity.ts";

export type KnowledgeWorkerPlan = {
  agentId: string;
  stateDir: string;
  settings: KnowledgeSettings;
  embeddingModel: string;
  modelCacheDir: string;
  network: boolean;
  sources: Array<{ id: string; hostPath: string; description: string }>;
  model?: { hostPath: string; containerPath: string; revision?: string };
};
const code = readFileSync(new URL("./worker.mjs", import.meta.url), "utf8");
const label = "carmel.knowledge";
const workers = new Map<
  string,
  { signature: string; client: WorkerClient; lastUsed: number }
>();
let reaper: ReturnType<typeof setInterval> | undefined;
const MAX_RESPONSE = 512 * 1024;

function hostPath(path: string) {
  const rel = relative(dataDir, path);
  return process.env.CARMEL_HOST_DATA_DIR &&
    !rel.startsWith("..") &&
    !isAbsolute(rel)
    ? resolve(process.env.CARMEL_HOST_DATA_DIR, rel)
    : path;
}
export function knowledgeContainerSpec(
  plan: KnowledgeWorkerPlan,
  identity: SandboxIdentity,
) {
  const gpu = (
    process.env.CARMEL_KNOWLEDGE_GPU ??
    process.env.CARMEL_BASH_GPU ??
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const backend =
    plan.settings.acceleration === "cpu" ? "false" : plan.settings.acceleration;
  const relabel =
    process.env.CARMEL_BASH_SELINUX_RELABEL !== "false" ? ",z" : "";
  const binds = [
    `${hostPath(plan.stateDir)}:/state:rw${relabel}`,
    `${hostPath(plan.modelCacheDir)}:/models/cache:${plan.network ? "rw" : "ro"}${relabel}`,
    ...plan.sources.map(
      (s) => `${hostPath(s.hostPath)}:/sources/${s.id}:ro${relabel}`,
    ),
    ...(plan.model
      ? [
          `${hostPath(plan.model.hostPath)}:${plan.model.containerPath}:ro${relabel}`,
        ]
      : []),
  ];
  if (binds.some((bind) => bind.split(":").length !== 3))
    throw new Error("Knowledge mount paths cannot contain colons.");
  return {
    Image:
      process.env.CARMEL_KNOWLEDGE_IMAGE ||
      process.env.CARMEL_BASH_IMAGE ||
      "ghcr.io/mudkipme/carmel-agent-runner:latest",
    User: identity.user,
    Entrypoint: [],
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/state",
    Labels: { [label]: "1", "carmel.knowledge.agent": plan.agentId },
    Env: [
      "HOME=/state/home",
      "XDG_CACHE_HOME=/state/cache",
      "XDG_CONFIG_HOME=/state/config",
      `QMD_LLAMA_GPU=${backend}`,
      `NODE_LLAMA_CPP_GPU=${backend}`,
    ],
    HostConfig: {
      Init: true,
      UsernsMode: identity.usernsMode,
      Binds: binds,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m" },
      Memory:
        positive(process.env.CARMEL_KNOWLEDGE_MEMORY_MB, 4096) * 1024 * 1024,
      NanoCpus: positive(process.env.CARMEL_KNOWLEDGE_CPUS, 2) * 1e9,
      PidsLimit: 128,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ...(plan.network ? {} : { NetworkMode: "none" }),
      ...(gpu.length && backend !== "false"
        ? { DeviceRequests: [{ Driver: "cdi", DeviceIDs: gpu }] }
        : {}),
    },
  };
}
function positive(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Caller holds the per-agent lock for the entire request. There is no host execution path. */
export async function callKnowledgeWorker(
  plan: KnowledgeWorkerPlan,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  // Lock before starting a setup worker, so queued downloads do not hold a
  // writable cache mount or allow the waiting worker to be idle-reaped.
  const run = () => callWorker(plan, request, signal);
  return plan.network ? knowledgeLock("$model-downloads", run) : run();
}

async function callWorker(
  plan: KnowledgeWorkerPlan,
  request: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!isSandboxConfigured())
    throw new Error(
      "Knowledge runner unavailable. Configure a Podman or Docker socket.",
    );
  signal?.throwIfAborted();
  const signature = createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
  let entry = workers.get(plan.agentId);
  if (entry && (entry.signature !== signature || entry.client.closed)) {
    await stopKnowledgeWorker(plan.agentId);
    entry = undefined;
  }
  if (!entry) {
    const identity = await resolveSandboxIdentity();
    const spec = knowledgeContainerSpec(plan, identity);
    if (!(await imageExists(spec.Image)))
      throw new Error(
        `Knowledge runner image is unavailable: ${spec.Image}. Pull it before enabling knowledge.`,
      );
    const containerId = await createContainer(
      `carmel-knowledge-${randomUUID()}`,
      spec,
    );
    try {
      await startContainer(containerId);
      const attaching = new AbortController();
      const attachTimer = setTimeout(() => attaching.abort(), 30_000);
      // --input-type=module breaks node-llama-cpp's forked native-binding probes.
      const entrypoint = `import(${JSON.stringify(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)}).catch(error => { console.error(error.message); process.exitCode = 1; })`;
      const { socket } = await attachExecStdio(
        containerId,
        { cmd: ["node", "-e", entrypoint], workingDir: "/state", env: [] },
        attaching.signal,
      ).finally(() => clearTimeout(attachTimer));
      const client = new WorkerClient(containerId, socket);
      entry = { signature, client, lastUsed: Date.now() };
      workers.set(plan.agentId, entry);
      const collections = Object.fromEntries(
        plan.sources.map((s) => [
          s.id,
          {
            path: `/sources/${s.id}`,
            pattern: "**/*.md",
            context: { "": s.description },
          },
        ]),
      );
      // Source/model changes get a new derived index; a failed build preserves old generations.
      const config = {
        collections,
        models: {
          embed: plan.model?.containerPath || plan.embeddingModel || undefined,
        },
      };
      const generation = createHash("sha256")
        .update(JSON.stringify({ config, model: plan.model }))
        .digest("hex")
        .slice(0, 24);
      await client.request(
        {
          op: "init",
          config,
          generation,
          acceleration: plan.settings.acceleration,
          allowDownloads: plan.network,
        },
        30_000,
        signal,
      );
      if (!reaper) {
        reaper = setInterval(() => {
          for (const [id, worker] of workers)
            if (
              !worker.client.busy &&
              Date.now() - worker.lastUsed > 5 * 60_000
            )
              void stopKnowledgeWorker(id).catch((error) =>
                console.error("Knowledge runner cleanup failed", error),
              );
        }, 60_000);
        reaper.unref();
      }
    } catch (error) {
      entry?.client.close();
      if (await removeContainer(containerId)) {
        if (workers.get(plan.agentId) === entry) workers.delete(plan.agentId);
      }
      throw error;
    }
  }
  entry.lastUsed = Date.now();
  try {
    return await entry.client.request(
      request,
      ["embed", "prepare"].includes(String(request.op))
        ? 15 * 60_000
        : request.op === "update"
          ? 120_000
          : 60_000,
      signal,
    );
  } catch (error) {
    if (entry.client.closed) await stopKnowledgeWorker(plan.agentId);
    throw error;
  } finally {
    entry.lastUsed = Date.now();
  }
}

export async function stopKnowledgeWorker(agentId: string) {
  const entry = workers.get(agentId);
  if (!entry) return;
  entry.client.close();
  if (!(await removeContainer(entry.client.containerId)))
    throw new Error("Unable to stop knowledge runner.");
  // An idle cleanup and a new request can both be stopping the same old worker.
  if (workers.get(agentId) === entry) workers.delete(agentId);
}
export async function shutdownKnowledgeWorkers() {
  if (reaper) clearInterval(reaper);
  reaper = undefined;
  await Promise.allSettled([...workers.keys()].map(stopKnowledgeWorker));
}
export async function reapKnowledgeWorkers() {
  if (!isSandboxConfigured()) return;
  for (const worker of await listManagedContainers(`${label}=1`)) {
    if (!(await removeContainer(worker.Id)))
      throw new Error("Unable to remove an old knowledge runner.");
  }
}

export class WorkerClient {
  closed = false;
  get busy() {
    return Boolean(this.pending);
  }
  private pending?: {
    id: string;
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  };
  private stderr = "";
  constructor(
    readonly containerId: string,
    private socket: Duplex,
  ) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    const demux = createStreamDemuxer((stream, chunk) => {
      if (stream === 2) {
        this.stderr = (this.stderr + chunk.toString()).slice(-1500);
        return;
      }
      if (stream !== 1) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_RESPONSE)
        throw new Error("Knowledge runner response exceeded its limit.");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!this.pending || message.id !== this.pending.id)
          throw new Error("Unexpected knowledge runner response.");
        const pending = this.pending;
        this.pending = undefined;
        if (typeof message.error === "string")
          pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
    }, MAX_RESPONSE);
    socket.on("data", (chunk) => {
      try {
        demux(chunk);
      } catch {
        this.close(new Error("Invalid knowledge runner response."));
      }
    });
    socket.on("error", () =>
      this.close(new Error("Knowledge runner connection failed.")),
    );
    socket.on("close", () =>
      this.close(new Error(`Knowledge runner stopped. ${this.stderr}`)),
    );
  }
  async request(
    payload: Record<string, unknown>,
    timeout: number,
    signal?: AbortSignal,
  ) {
    if (this.closed || this.pending)
      throw new Error("Knowledge runner is unavailable or busy.");
    signal?.throwIfAborted();
    const abort = () =>
      this.close(new Error("Knowledge runner operation cancelled."));
    const timer = setTimeout(
      () => this.close(new Error("Knowledge runner operation timed out.")),
      timeout,
    );
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const id = randomUUID();
        this.pending = { id, resolve, reject };
        this.socket.write(
          `${JSON.stringify({ ...payload, id })}\n`,
          (error) => {
            if (error) this.close(error);
          },
        );
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  close(error = new Error("Knowledge runner closed.")) {
    this.closed = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
    this.socket.destroy();
  }
}
