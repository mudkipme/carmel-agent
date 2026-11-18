import { rmSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { AgentMount } from "@carmel-agent/shared";
import { db } from "../../db/index.ts";
import { environments } from "../../db/schema.ts";
import { dataDir, ensureDir, resolveDataPath } from "../../paths.ts";
import { resolveEnvironmentWorkingDirPath } from "../resources.ts";
import {
  createContainer,
  execInContainer,
  imageExists,
  isContainerRunning,
  isSandboxConfigured,
  listManagedContainers,
  pullImage,
  removeContainer,
  sandboxUnavailableMessage,
  startContainer,
  type ManagedContainer,
} from "./runtime-client.ts";
import { eq } from "drizzle-orm";
import { errorMessage } from "../../errors.ts";
import { prepareBrowserProfileScript } from "./browser-profile.ts";
import { resolveSandboxIdentity, type SandboxIdentity } from "./runtime-identity.ts";
import { containerHome, prepareRunnerScript, runnerEnvironment } from "./environment.ts";
import { prepareNestedMountpoints } from "./mountpoints.ts";
import { knowledgeShellResources, type KnowledgeShellResources } from "../knowledge/shell.ts";
export { containerHome } from "./environment.ts";

export type EnvironmentRecord = typeof environments.$inferSelect;

const managedLabel = "carmel.managed";
const managedLabelValue = "1";
const environmentLabel = "carmel.environment";
const containerWorkspace = "/workspace";
const reaperIntervalMs = 60_000;

const config = {
  image: process.env.CARMEL_BASH_IMAGE?.trim() || "ghcr.io/mudkipme/carmel-agent-runner:latest",
  memoryBytes: positiveInt(process.env.CARMEL_BASH_MEMORY_MB, 512) * 1024 * 1024,
  nanoCpus: Math.round(positiveFloat(process.env.CARMEL_BASH_CPUS, 1) * 1e9),
  pidsLimit: positiveInt(process.env.CARMEL_BASH_PIDS_LIMIT, 512),
  idleTtlMs: positiveInt(process.env.CARMEL_BASH_IDLE_MINUTES, 15) * 60_000,
  // CDI device ids to attach to runner containers, e.g. "nvidia.com/gpu=all".
  gpuDevices: parseCsv(process.env.CARMEL_BASH_GPU),
  // SELinux relabeling (:z) is required for bind mounts on enforcing hosts.
  selinuxRelabel: process.env.CARMEL_BASH_SELINUX_RELABEL !== "false",
};

type ContainerEntry = {
  containerId: string;
  lastUsedAt: number;
  signature: string;
  tmpPath: string;
};

// Keyed by environment id: every agent attached to an environment shares its runner.
const containers = new Map<string, ContainerEntry>();
// Environments with something attached that the idle reaper must not interrupt
// -- terminals, browser viewers, MCP servers. Counted rather than boolean: two
// browser tabs on the same shell are two holds, and the last one to leave releases it.
const containerHolds = new Map<string, number>();
const pendingStarts = new Map<string, Promise<string>>();
const pendingStops = new Map<string, Promise<void>>();
let imageReady: Promise<void> | undefined;
let reaper: ReturnType<typeof setInterval> | undefined;

export async function ensureEnvironmentContainer(environment: EnvironmentRecord): Promise<string> {
  if (!isSandboxConfigured()) throw new Error(sandboxUnavailableMessage());
  const stopping = pendingStops.get(environment.id);
  if (stopping) await stopping;

  const identity = await resolveSandboxIdentity();
  const knowledge = await knowledgeShellResources();
  const signature = containerSignature(environment, identity, knowledge);
  const existing = containers.get(environment.id);
  if (existing) {
    // Reuse only if the bind configuration still matches; recreate when the
    // workspace dir or extra mounts changed so stale binds are not kept.
    if (existing.signature === signature && (await isContainerRunning(existing.containerId))) {
      // A reaper may have started teardown while the running check waited.
      if (pendingStops.has(environment.id) || containers.get(environment.id) !== existing)
        return ensureEnvironmentContainer(environment);
      existing.lastUsedAt = Date.now();
      return existing.containerId;
    }
    await stopTrackedContainer(environment.id, existing);
  }

  const pending = pendingStarts.get(environment.id);
  if (pending) {
    await pending;
    // The in-flight creation may have used different mounts or identity.
    return ensureEnvironmentContainer(environment);
  }
  const tmpPath = resolveEnvironmentTmpDirPath(environment);
  const starting = createEnvironmentContainer(environment, identity, knowledge)
    .then((containerId) => {
      containers.set(environment.id, {
        containerId,
        lastUsedAt: Date.now(),
        signature,
        tmpPath,
      });
      startReaper();
      return containerId;
    })
    .finally(() => pendingStarts.delete(environment.id));
  pendingStarts.set(environment.id, starting);
  return starting;
}

// Identifies the bind-relevant inputs of a runner container. When this changes
// for an environment (workspace dir, mount path, extra mounts, network), the
// existing container is torn down and recreated on the next command.
export function containerSignature(
  environment: EnvironmentRecord,
  identity?: SandboxIdentity,
  knowledge?: KnowledgeShellResources,
) {
  const workspaceHostPath = toHostPath(resolveEnvironmentWorkingDirPath(environment));
  const tmpHostPath = toHostPath(resolveEnvironmentTmpDirPath(environment));
  const homeHostPath = toHostPath(resolveEnvironmentHomeDirPath(environment));
  const mountPath = resolveContainerWorkspace(environment);
  return JSON.stringify({
    binds: buildBinds(workspaceHostPath, mountPath, tmpHostPath, homeHostPath, environment.mounts),
    network: environment.network,
    identity,
    knowledge,
  });
}

/**
 * Pin an environment's container against the idle reaper.
 *
 * The reaper measures idleness by `lastUsedAt`, which only moves when a command
 * is dispatched. A terminal where someone is reading rather than typing looks
 * exactly like an abandoned container, so it needs to say so explicitly.
 */
export function holdEnvironmentContainer(environmentId: string) {
  containerHolds.set(environmentId, (containerHolds.get(environmentId) ?? 0) + 1);
}

export function releaseEnvironmentContainer(environmentId: string) {
  const held = (containerHolds.get(environmentId) ?? 0) - 1;
  if (held > 0) containerHolds.set(environmentId, held);
  else containerHolds.delete(environmentId);
  // Idleness is counted from the release, not from the last command: a session
  // that just ended should buy the full TTL before the container is reclaimed.
  const entry = containers.get(environmentId);
  if (entry && held <= 0) entry.lastUsedAt = Date.now();
}

export function isEnvironmentContainerHeld(environmentId: string) {
  return (containerHolds.get(environmentId) ?? 0) > 0;
}

// Scratch storage has the same lifetime as the runner, including config
// changes. Only workspace and home data survive recreation.
export async function killEnvironmentContainer(environmentId: string) {
  const starting = pendingStarts.get(environmentId);
  if (starting) await starting.catch(() => {});
  const entry = containers.get(environmentId);
  if (!entry) return;
  await stopTrackedContainer(environmentId, entry);
}

/** Keep the owner tracked and block replacement until removal is confirmed. */
function stopTrackedContainer(environmentId: string, entry: ContainerEntry): Promise<void> {
  const pending = pendingStops.get(environmentId);
  if (pending) return pending;
  const stopping = (async () => {
    await removeContainerConfirmed(entry.containerId);
    if (containers.get(environmentId) === entry) {
      clearTmp(entry.tmpPath);
      containers.delete(environmentId);
    }
  })().finally(() => pendingStops.delete(environmentId));
  pendingStops.set(environmentId, stopping);
  return stopping;
}

// Environment deletion also removes scratch written by file tools without a runner.
export async function discardEnvironmentContainer(environment: EnvironmentRecord) {
  await killEnvironmentContainer(environment.id);
  if (!hasRunner(environment.id)) clearTmp(resolveEnvironmentTmpDirPath(environment));
}

function clearTmp(path: string) {
  rmSync(path, { recursive: true, force: true });
}

// Where the workspace is mounted inside the runner. Manual workspaces keep their
// absolute path so paths line up with the host and the server-side file tools;
// default workspaces use a stable /workspace mount point.
export function resolveContainerWorkspace(environment: EnvironmentRecord) {
  if (environment.workingDirMode === "manual") return resolveEnvironmentWorkingDirPath(environment);
  return containerWorkspace;
}

// Host directory bind-mounted at /tmp in the runner. Backing it on the host
// (rather than the container's ephemeral layer) lets the host-side file tools
// see the same /tmp the sandboxed shell writes to, while keeping it isolated
// from the host's real /tmp. Removed after the runner is confirmed gone.
export function resolveEnvironmentTmpDirPath(environment: EnvironmentRecord) {
  return resolveDataPath(`${environment.storageDir}/tmp`);
}

// Host directory bind-mounted at containerHome. Unlike /tmp this is never
// reclaimed by the reaper: surviving container recreation is the point, so a
// `npm install -g` or a git identity set in one session is still there in the
// next one.
export function resolveEnvironmentHomeDirPath(environment: EnvironmentRecord) {
  return resolveDataPath(`${environment.storageDir}/home`);
}

export function toContainerWorkdir(environment: EnvironmentRecord, cwd: string) {
  const workspaceRoot = resolveEnvironmentWorkingDirPath(environment);
  const mountPath = resolveContainerWorkspace(environment);
  const mappings = [
    { source: workspaceRoot, target: mountPath },
    { source: resolveEnvironmentTmpDirPath(environment), target: "/tmp" },
    { source: resolveEnvironmentHomeDirPath(environment), target: containerHome },
    ...environment.mounts.flatMap((mount) => {
      const source = mount.source?.trim();
      return source
        ? [{ source: resolve(source), target: resolve(mount.target?.trim() || source) }]
        : [];
    }),
  ].sort((left, right) => right.source.length - left.source.length);
  for (const { source, target } of mappings) {
    const rel = relative(resolve(source), resolve(cwd));
    if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
      return containerWorkdir(source, cwd, target);
    }
  }
  return mountPath;
}

// Maps a host-side absolute working directory onto the workspace mount point
// inside the container. Anything outside the workspace falls back to its root.
export function containerWorkdir(workspaceRoot: string, cwd: string, mountPath: string) {
  const rel = relative(resolve(workspaceRoot), resolve(cwd));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return mountPath;
  return posix.join(mountPath, rel.split(/[\\/]/).join("/"));
}

// Builds the runner bind list: the workspace, a private /tmp, a private $HOME,
// plus any extra environment mounts. Extra mount sources are host paths as the
// Podman daemon sees them.
export function buildBinds(
  workspaceHostPath: string,
  mountPath: string,
  tmpHostPath: string,
  homeHostPath: string,
  mounts: AgentMount[],
) {
  const relabel = config.selinuxRelabel ? ",z" : "";
  const binds = [
    `${workspaceHostPath}:${mountPath}:rw${relabel}`,
    `${tmpHostPath}:/tmp:rw${relabel}`,
    `${homeHostPath}:${containerHome}:rw${relabel}`,
  ];
  for (const mount of mounts) {
    const source = mount.source?.trim();
    if (!source) continue;
    const target = mount.target?.trim() || source;
    const mode = mount.readOnly ? "ro" : "rw";
    binds.push(`${source}:${target}:${mode}${relabel}`);
  }
  return binds;
}

export async function reapManagedContainers() {
  if (!isSandboxConfigured()) return;
  const stale = await listManagedContainers(`${managedLabel}=${managedLabelValue}`);
  await removeUntrackedRunners(stale, stale);
  // Startup also clears scratch left by a crash after the runtime removed its
  // container, or by older versions which kept /tmp across server restarts.
  for (const environment of db.select().from(environments).all()) {
    if (!hasRunner(environment.id)) clearTmp(resolveEnvironmentTmpDirPath(environment));
  }
}

function hasRunner(environmentId: string) {
  return (
    containers.has(environmentId) ||
    pendingStarts.has(environmentId) ||
    pendingStops.has(environmentId)
  );
}

/** Clear scratch only when every known runner for that environment was removed. */
async function removeUntrackedRunners(managed: ManagedContainer[], stale: ManagedContainer[]) {
  const removed = new Set<string>();
  const results = await Promise.allSettled(
    stale.map(async (container) => {
      await removeContainerConfirmed(container.Id);
      removed.add(container.Id);
    }),
  );
  const environmentIds = new Set(
    stale
      .map((container) => container.Labels?.[environmentLabel])
      .filter((id): id is string => Boolean(id)),
  );
  for (const environmentId of environmentIds) {
    const environment = db
      .select()
      .from(environments)
      .where(eq(environments.id, environmentId))
      .get();
    if (
      environment &&
      !hasRunner(environmentId) &&
      managed.every(
        (container) =>
          container.Labels?.[environmentLabel] !== environmentId || removed.has(container.Id),
      )
    )
      clearTmp(resolveEnvironmentTmpDirPath(environment));
  }
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function removeContainerConfirmed(containerId: string) {
  if (!(await removeContainer(containerId)))
    throw new Error(
      `Could not remove sandbox ${containerId}; refusing to reuse its browser profile.`,
    );
}

export async function shutdownContainerManager() {
  if (reaper) {
    clearInterval(reaper);
    reaper = undefined;
  }
  await Promise.all(
    [...containers].map(([environmentId, entry]) => stopTrackedContainer(environmentId, entry)),
  );
}

async function createEnvironmentContainer(
  environment: EnvironmentRecord,
  identity: SandboxIdentity,
  knowledge: KnowledgeShellResources,
) {
  await ensureImage();

  const workspacePath = resolveEnvironmentWorkingDirPath(environment);
  const tmpPath = resolveEnvironmentTmpDirPath(environment);
  const homePath = resolveEnvironmentHomeDirPath(environment);
  ensureDir(workspacePath);
  ensureDir(tmpPath);
  ensureDir(homePath);
  const mountPath = resolveContainerWorkspace(environment);
  const workspaceHostPath = toHostPath(workspacePath);
  const tmpHostPath = toHostPath(tmpPath);
  const homeHostPath = toHostPath(homePath);
  const knowledgeMounts = knowledge.mounts.map((mount) => ({
    ...mount,
    source: toHostPath(mount.source),
  }));
  // Reject overlapping mounts instead of silently shadowing an operator mount.
  for (const mount of environment.mounts) {
    const target = resolve(mount.target?.trim() || mount.source);
    if (
      knowledgeMounts.some(
        (shared) =>
          target === shared.target ||
          shared.target.startsWith(`${target}/`) ||
          target.startsWith(`${shared.target}/`),
      )
    ) {
      throw new Error(`Environment mount overlaps the shared qmd model mount: ${target}`);
    }
  }

  prepareNestedMountpoints([
    { source: workspacePath, target: mountPath },
    { source: tmpPath, target: "/tmp" },
    { source: homePath, target: containerHome },
    ...environment.mounts
      .filter((mount) => mount.source?.trim())
      .map((mount) => ({
        source: toServerPath(mount.source.trim()),
        target: mount.target?.trim() || mount.source.trim(),
        readOnly: mount.readOnly,
      })),
    ...knowledge.mounts,
  ]);

  const name = `carmel-bash-${sanitizeName(environment.id)}-${Date.now().toString(36)}`;
  const containerId = await createContainer(name, {
    Image: config.image,
    User: identity.user,
    Entrypoint: [],
    Cmd: ["sleep", "infinity"],
    WorkingDir: mountPath,
    Labels: { [managedLabel]: managedLabelValue, [environmentLabel]: environment.id },
    Env: Object.entries({ ...runnerEnvironment, ...knowledge.env }).map(
      ([key, value]) => `${key}=${value}`,
    ),
    HostConfig: {
      // Reap Chromium descendants when a launch fails or its parent exits.
      Init: true,
      UsernsMode: identity.usernsMode,
      Binds: buildBinds(workspaceHostPath, mountPath, tmpHostPath, homeHostPath, [
        ...environment.mounts,
        ...knowledgeMounts,
      ]),
      Memory: config.memoryBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: config.pidsLimit,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      // No network unless the environment allows it. When allowed we leave
      // NetworkMode unset so rootless Podman uses its default network.
      ...(environment.network ? {} : { NetworkMode: "none" }),
      // Attach CDI devices (e.g. NVIDIA GPUs) when CARMEL_BASH_GPU is set.
      ...(config.gpuDevices.length > 0
        ? { DeviceRequests: [{ Driver: "cdi", DeviceIDs: config.gpuDevices }] }
        : {}),
    },
  });
  try {
    await startContainer(containerId);
    let setupError = "";
    const initialized = await execInContainer(
      containerId,
      {
        cmd: [
          "node",
          "-e",
          prepareRunnerScript,
          String(identity.uid),
          String(identity.gid),
          mountPath,
        ],
        workingDir: mountPath,
        env: [],
      },
      {
        onStdout: () => {},
        onStderr: (chunk) => {
          setupError = (setupError + chunk.toString()).slice(-4000);
        },
        signal: AbortSignal.timeout(60000),
      },
    );
    if (initialized.exitCode !== 0)
      throw new Error(
        `Unable to initialize the non-root sandbox: ${setupError || "check runner image, host ownership, and UID/GID configuration"}`,
      );
    // This runs inside the sandbox, never against agent-controlled host paths.
    // No browser can have started in this fresh container through Carmel yet.
    const prepared = await execInContainer(
      containerId,
      {
        cmd: ["node", "-e", prepareBrowserProfileScript, `${containerHome}/.agent-browser/profile`],
        workingDir: mountPath,
        env: [],
      },
      { onStdout: () => {}, onStderr: () => {}, signal: AbortSignal.timeout(10000) },
    );
    if (prepared.exitCode !== 0)
      throw new Error(
        "Unable to prepare the sandbox browser profile; saved profile data was retained.",
      );
    return containerId;
  } catch (error) {
    if (await removeContainer(containerId)) clearTmp(tmpPath);
    throw error;
  }
}

function ensureImage() {
  if (!imageReady) {
    imageReady = (async () => {
      if (await imageExists(config.image)) return;
      // A local-only image cannot be pulled; point the
      // operator at the build step rather than failing with a registry error.
      if (config.image.startsWith("localhost/")) {
        throw new Error(
          `The bash sandbox image "${config.image}" is not built. Build it with ` +
            `\`podman build -f Dockerfile.runner -t carmel-agent-runner:latest .\` or set ` +
            `CARMEL_BASH_IMAGE to a pullable image.`,
        );
      }
      await pullImage(config.image);
    })().catch((error) => {
      imageReady = undefined;
      throw error;
    });
  }
  return imageReady;
}

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => void reapIdleContainers(), reaperIntervalMs);
  reaper.unref?.();
}

async function reapIdleContainers() {
  const now = Date.now();
  const stale: Array<[string, ContainerEntry]> = [];
  for (const [environmentId, entry] of containers) {
    if (containerHolds.has(environmentId)) continue;
    if (now - entry.lastUsedAt < config.idleTtlMs) continue;
    stale.push([environmentId, entry]);
  }
  await Promise.all(
    stale.map(async ([environmentId, entry]) => {
      try {
        await stopTrackedContainer(environmentId, entry);
      } catch (error) {
        console.warn("Failed to reap sandbox container:", errorMessage(error));
      }
    }),
  );
  await reapUntrackedContainers();
}

// Safety net for orphaned runners. A teardown that lost its tracking entry
// without actually removing the container (a swallowed/transient podman failure)
// would otherwise leak the container until the next restart, since the idle
// reaper only ever inspects the in-memory map. Periodically reconcile against
// real podman state and remove any managed runner no live entry points at.
// A grace period keeps us from killing a container that is still being created
// (tracked only in pendingStarts, not yet in the map).
async function reapUntrackedContainers() {
  let managed: Awaited<ReturnType<typeof listManagedContainers>>;
  try {
    managed = await listManagedContainers(`${managedLabel}=${managedLabelValue}`);
  } catch (error) {
    console.warn("Failed to list sandbox containers:", errorMessage(error));
    return;
  }
  const tracked = new Set<string>();
  for (const entry of containers.values()) tracked.add(entry.containerId);
  const minAgeSeconds = (Date.now() - config.idleTtlMs) / 1000;
  const stale = managed.filter(
    (container) => !tracked.has(container.Id) && container.Created < minAgeSeconds,
  );
  try {
    await removeUntrackedRunners(managed, stale);
  } catch (error) {
    console.warn("Failed to reap untracked sandbox containers:", errorMessage(error));
  }
}

// When carmel-agent itself runs inside a container, a bind mount source is
// interpreted by the host Podman daemon, not by carmel's filesystem. Set
// CARMEL_HOST_DATA_DIR to the host path that backs CARMEL_AGENT_DATA_DIR so the
// workspace mount resolves correctly. When unset we assume carmel runs on the host.
function toHostPath(absolutePath: string) {
  const hostDataDir = process.env.CARMEL_HOST_DATA_DIR?.trim();
  if (!hostDataDir) return absolutePath;
  const rel = relative(dataDir, absolutePath);
  if (rel.startsWith("..") || isAbsolute(rel)) return absolutePath;
  return posix.join(hostDataDir.replace(/\/+$/, ""), rel.split(/[\\/]/).join("/"));
}

function toServerPath(hostPath: string) {
  const hostDataDir = process.env.CARMEL_HOST_DATA_DIR?.trim();
  if (!hostDataDir) return hostPath;
  const rel = relative(hostDataDir, hostPath);
  return rel === ".." || rel.startsWith(`..${posix.sep}`) || isAbsolute(rel)
    ? hostPath
    : resolve(dataDir, rel);
}

function sanitizeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveFloat(value: string | undefined, fallback: number) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
