import { existsSync } from "node:fs";
import { resolveRuntimeSocketPath, runtimeInfo } from "./runtime-client.ts";

export type HostIdentity = { uid: number; gid: number };
export type RuntimeVersion = { Os?: string; Components?: Array<{ Name: string }> };
export type RuntimeInfo = { SecurityOptions?: string[] };
type IdMap = Array<{ container_id: number; host_id: number; size: number }>;
export type PodmanInfo = {
  host?: { security?: { rootless?: boolean }; idMappings?: { uidmap?: IdMap; gidmap?: IdMap } };
};
export type SandboxIdentity = HostIdentity & {
  runtime: "podman" | "docker";
  user: string;
  usernsMode: "keep-id" | "host";
  socket: string;
};

export function resolveHostIdentity(options: {
  env: NodeJS.ProcessEnv;
  uid: number | undefined;
  gid: number | undefined;
  containerized: boolean;
}): HostIdentity {
  const { env, containerized } = options;
  const explicit = env.CARMEL_HOST_UID !== undefined || env.CARMEL_HOST_GID !== undefined;
  if (
    (explicit || containerized) &&
    (!env.CARMEL_HOST_UID?.trim() || !env.CARMEL_HOST_GID?.trim())
  ) {
    throw new Error(
      "Set both CARMEL_HOST_UID and CARMEL_HOST_GID to the host user's id -u / id -g when Carmel runs in a container.",
    );
  }
  const uid = explicit ? parseId(env.CARMEL_HOST_UID!, "CARMEL_HOST_UID") : options.uid;
  const gid = explicit ? parseId(env.CARMEL_HOST_GID!, "CARMEL_HOST_GID") : options.gid;
  if (!validId(uid) || !validId(gid))
    throw new Error(
      "The sandbox requires a non-root host UID and GID. Run Carmel as your normal user.",
    );
  if (options.uid !== uid || options.gid !== gid) {
    throw new Error(
      `Run the Carmel server as ${uid}:${gid} too, so server-created files retain host ownership. With rootless Podman use --userns=keep-id --user ${uid}:${gid}.`,
    );
  }
  return { uid, gid };
}

export function isPodman(version: RuntimeVersion) {
  return version.Components?.some((component) => component.Name === "Podman Engine") ?? false;
}

export function planSandboxIdentity(
  host: HostIdentity,
  version: RuntimeVersion,
  info: RuntimeInfo,
  podman?: PodmanInfo,
) {
  if (version.Os !== "linux" || !Array.isArray(info.SecurityOptions)) {
    throw new Error("Cannot establish the sandbox runtime's Linux user namespace configuration.");
  }
  const security = new Set(
    info.SecurityOptions.map((option) => option.split(",")[0]?.replace(/^name=/, "")),
  );
  const runtime = isPodman(version) ? "podman" : "docker";
  if (
    runtime === "docker" &&
    !version.Components?.some((component) => component.Name === "Engine")
  ) {
    throw new Error("Unsupported sandbox runtime: use Podman or Docker Engine.");
  }
  if (runtime === "docker" && (security.has("rootless") || security.has("userns"))) {
    throw new Error(
      "Rootless Docker and Docker with userns-remap are not supported: they cannot preserve host file ownership with this non-root sandbox. Use rootless Podman or rootful Docker without userns-remap.",
    );
  }
  let rootless = false;
  if (runtime === "podman") {
    if (typeof podman?.host?.security?.rootless !== "boolean")
      throw new Error("Cannot determine whether the Podman daemon is rootless.");
    rootless = podman.host.security.rootless;
    if (rootless) {
      const owner = (map?: IdMap) =>
        map?.find((entry) => entry.container_id === 0 && entry.size === 1)?.host_id;
      if (
        owner(podman.host.idMappings?.uidmap) !== host.uid ||
        owner(podman.host.idMappings?.gidmap) !== host.gid
      ) {
        throw new Error(
          "The rootless Podman daemon must run as CARMEL_HOST_UID:CARMEL_HOST_GID; keep-id preserves the daemon owner's identity.",
        );
      }
    }
  }
  return {
    ...host,
    runtime,
    user: `${host.uid}:${host.gid}`,
    usernsMode: rootless ? "keep-id" : "host",
  } as const;
}

export async function resolveSandboxIdentity(): Promise<SandboxIdentity> {
  const host = resolveHostIdentity({
    env: process.env,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    containerized: Boolean(
      process.env.CARMEL_HOST_DATA_DIR ||
      process.env.CARMEL_CONTAINERIZED === "1" ||
      existsSync("/.dockerenv") ||
      existsSync("/run/.containerenv"),
    ),
  });
  const [version, info] = await Promise.all([
    runtimeInfo<RuntimeVersion>("/version"),
    runtimeInfo<RuntimeInfo>("/info"),
  ]);
  const podman = isPodman(version) ? await runtimeInfo<PodmanInfo>("/libpod/info") : undefined;
  return {
    ...planSandboxIdentity(host, version, info, podman),
    socket: resolveRuntimeSocketPath()!,
  };
}

function validId(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 4294967295;
}

function parseId(value: string, name: string) {
  if (!/^\d+$/.test(value.trim()) || !validId(Number(value)))
    throw new Error(`${name} must be a nonzero numeric Linux ID.`);
  return Number(value);
}
