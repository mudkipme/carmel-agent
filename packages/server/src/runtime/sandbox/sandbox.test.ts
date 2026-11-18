import test from "node:test";
import assert from "node:assert/strict";
import type { environments } from "../../db/schema.ts";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxEnv } from "./bash-operations.ts";
import { readWorkspaceDotEnv } from "../workspace-dotenv.ts";
import { createStreamDemuxer, parseImageRef } from "./runtime-client.ts";
import {
  buildBinds,
  containerSignature,
  containerWorkdir,
  holdEnvironmentContainer,
  isEnvironmentContainerHeld,
  releaseEnvironmentContainer,
  resolveEnvironmentHomeDirPath,
  resolveEnvironmentTmpDirPath,
  resolveContainerWorkspace,
  toContainerWorkdir,
} from "./container-manager.ts";

type EnvironmentRecord = typeof environments.$inferSelect;

function manualEnvironment(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env_test",
    storageDir: "environments/env_test",
    workingDirMode: "manual",
    workingDir: "/srv/projects/app",
    mounts: [],
    network: false,
    ...overrides,
  } as EnvironmentRecord;
}

test("demuxer reassembles multiplexed docker frames split across chunks", () => {
  const chunks: Array<{ stream: number; payload: Buffer }> = [];
  const demux = createStreamDemuxer((stream, payload) =>
    chunks.push({ stream, payload: Buffer.from(payload) }),
  );

  const frame = (stream: number, text: string) => {
    const payload = Buffer.from(text, "utf-8");
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  const stream = Buffer.concat([frame(1, "hello "), frame(2, "world"), frame(1, "!")]);
  // Feed one byte at a time to exercise frames spanning chunk boundaries.
  for (const byte of stream) demux(Buffer.from([byte]));

  assert.deepEqual(
    chunks.map(({ stream, payload }) => ({ stream, text: payload.toString("utf8") })),
    [
      { stream: 1, text: "hello " },
      { stream: 2, text: "world" },
      { stream: 1, text: "!" },
    ],
  );
});

test("demuxer leaves an incomplete trailing frame buffered", () => {
  const chunks: Buffer[] = [];
  const demux = createStreamDemuxer((_stream, payload) => chunks.push(Buffer.from(payload)));
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(5, 4);

  demux(Buffer.concat([header, Buffer.from("abc")]));
  assert.equal(chunks.length, 0);
  demux(Buffer.from("de"));
  assert.equal(Buffer.concat(chunks).toString("utf-8"), "abcde");
});

test("parseImageRef splits tags but not registry ports", () => {
  assert.deepEqual(parseImageRef("docker.io/library/debian:stable-slim"), {
    name: "docker.io/library/debian",
    tag: "stable-slim",
  });
  assert.deepEqual(parseImageRef("alpine"), { name: "alpine", tag: "latest" });
  assert.deepEqual(parseImageRef("localhost:5000/tools"), {
    name: "localhost:5000/tools",
    tag: "latest",
  });
  assert.deepEqual(parseImageRef("localhost:5000/tools:dev"), {
    name: "localhost:5000/tools",
    tag: "dev",
  });
});

test("containerWorkdir maps host paths onto the workspace mount", () => {
  assert.equal(
    containerWorkdir("/data/agents/a/workspace", "/data/agents/a/workspace", "/workspace"),
    "/workspace",
  );
  assert.equal(
    containerWorkdir("/data/agents/a/workspace", "/data/agents/a/workspace/src/lib", "/workspace"),
    "/workspace/src/lib",
  );
});

test("containerWorkdir falls back to the mount root for outside paths", () => {
  assert.equal(containerWorkdir("/data/agents/a/workspace", "/etc", "/workspace"), "/workspace");
  assert.equal(
    containerWorkdir("/data/agents/a/workspace", "/data/agents/b/workspace", "/workspace"),
    "/workspace",
  );
});

test("containerWorkdir preserves an absolute mount path for manual workspaces", () => {
  assert.equal(
    containerWorkdir("/srv/projects/app", "/srv/projects/app/src", "/srv/projects/app"),
    "/srv/projects/app/src",
  );
});

test("shell working directories follow workspace, tmp, home, and extra mount paths", () => {
  const environment = manualEnvironment({
    workingDirMode: "default",
    workingDir: "/data/agents/a/workspace",
    mounts: [{ source: "/srv/shared", target: "/refs" }],
  });
  const workdir = (path: string) => toContainerWorkdir(environment, path);
  assert.equal(workdir(environment.workingDir), "/workspace");
  assert.equal(workdir(join(environment.workingDir, "src")), "/workspace/src");
  assert.equal(workdir(join(resolveEnvironmentTmpDirPath(environment), "output")), "/tmp/output");
  assert.equal(workdir(join(resolveEnvironmentHomeDirPath(environment), "bin")), "/home/agent/bin");
  assert.equal(workdir("/srv/shared/docs"), "/refs/docs");
  assert.equal(workdir("/srv/shared-other"), "/workspace");
});

test("resolveContainerWorkspace keeps the absolute path for manual workspaces", () => {
  assert.equal(
    resolveContainerWorkspace({
      workingDirMode: "manual",
      workingDir: "/srv/projects/app",
    } as EnvironmentRecord),
    "/srv/projects/app",
  );
  assert.equal(
    resolveContainerWorkspace({
      workingDirMode: "default",
      workingDir: "agents/a/workspace",
    } as EnvironmentRecord),
    "/workspace",
  );
});

test("containerSignature changes when the workspace dir, mounts, or network change", () => {
  const base = containerSignature(manualEnvironment());
  assert.equal(base, containerSignature(manualEnvironment()), "stable for identical config");
  assert.notEqual(
    base,
    containerSignature(manualEnvironment({ workingDir: "/srv/projects/other" })),
  );
  assert.notEqual(
    base,
    containerSignature(manualEnvironment({ mounts: [{ source: "/srv/shared" }] })),
  );
  assert.notEqual(base, containerSignature(manualEnvironment({ network: true })));
  const identity = {
    runtime: "podman",
    uid: 1000,
    gid: 1000,
    user: "1000:1000",
    usernsMode: "keep-id",
    socket: "/run/podman.sock",
  } as const;
  const withIdentity = containerSignature(manualEnvironment(), identity);
  assert.notEqual(
    withIdentity,
    containerSignature(manualEnvironment(), { ...identity, usernsMode: "host" }),
  );
  assert.notEqual(
    withIdentity,
    containerSignature(manualEnvironment(), { ...identity, uid: 2000, user: "2000:1000" }),
  );
  assert.notEqual(
    withIdentity,
    containerSignature(manualEnvironment(), { ...identity, socket: "/other.sock" }),
  );
});

test("buildBinds adds the workspace, /tmp, $HOME, and extra mounts with SELinux relabel", () => {
  const binds = buildBinds(
    "/host/data/agents/a/workspace",
    "/workspace",
    "/host/data/agents/a/tmp",
    "/host/data/agents/a/home",
    [
      { source: "/srv/shared", target: "/refs", readOnly: true },
      { source: "/srv/cache" },
      { source: "  " },
    ],
  );
  assert.deepEqual(binds, [
    "/host/data/agents/a/workspace:/workspace:rw,z",
    "/host/data/agents/a/tmp:/tmp:rw,z",
    "/host/data/agents/a/home:/home/agent:rw,z",
    "/srv/shared:/refs:ro,z",
    "/srv/cache:/srv/cache:rw,z",
  ]);
});

test("the runner home bind is per-environment and independent of the workspace", () => {
  const home = (environment: EnvironmentRecord) => resolveEnvironmentHomeDirPath(environment);
  assert.notEqual(
    home(manualEnvironment({ storageDir: "environments/a" })),
    home(manualEnvironment({ storageDir: "environments/b" })),
  );
  // A manual workspace move must not drag $HOME along with it.
  assert.equal(
    home(manualEnvironment({ workingDir: "/srv/projects/app" })),
    home(manualEnvironment({ workingDir: "/srv/projects/other" })),
  );
  // Environments migrated from agents keep their original directory.
  assert.match(
    home(manualEnvironment({ storageDir: "agents/agent_a" })),
    /[/\\]agents[/\\]agent_a[/\\]home$/,
  );
});

test("sandbox env starts from a fixed base and never inherits the server environment", () => {
  const env = sandboxEnv();
  assert.deepEqual(env.map((entry) => entry.split("=")[0]).sort(), [
    "AGENT_BROWSER_SESSION",
    "HOME",
    "LANG",
    "NPM_CONFIG_PREFIX",
    "PATH",
    "TERM",
    "VIRTUAL_ENV",
  ]);
  assert.ok(env.includes("VIRTUAL_ENV=/home/agent/.venvs/default"));
  assert.ok(
    env.some((entry) =>
      entry.startsWith("PATH=/home/agent/.venvs/default/bin:/home/agent/.npm-global/bin:"),
    ),
  );
});

test("agent secrets are exported into the exec environment", () => {
  const env = sandboxEnv(undefined, [{ name: "GITHUB_TOKEN", value: "ghp_example" }]);
  assert.ok(env.includes("GITHUB_TOKEN=ghp_example"));
});

test("a secret wins over a caller-supplied variable of the same name", () => {
  // Otherwise the model's own `env` argument could shadow a configured
  // credential with a value of its choosing.
  const env = sandboxEnv({ TOKEN: "from-caller" }, [{ name: "TOKEN", value: "from-secret" }]);
  assert.ok(env.includes("TOKEN=from-secret"));
  assert.ok(!env.includes("TOKEN=from-caller"));
});

test("a malformed secret name is dropped rather than emitted as a broken entry", () => {
  const env = sandboxEnv(undefined, [
    { name: "not a name", value: "x" },
    { name: "GOOD", value: "y" },
  ]);
  assert.deepEqual(
    env.filter((entry) => entry.startsWith("GOOD") || entry.includes("not a name")),
    ["GOOD=y"],
  );
});

function withTempDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "carmel-dotenv-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the workspace .env is parsed into exec variables", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, ".env"),
      '# comment\nPLAIN=one\nexport QUOTED="two words"\nMULTI="a\nb"\n',
    );
    assert.deepEqual(readWorkspaceDotEnv(dir), {
      PLAIN: "one",
      QUOTED: "two words",
      MULTI: "a\nb",
    });
  });
});

test("a missing workspace .env contributes nothing", () => {
  withTempDir((dir) => assert.deepEqual(readWorkspaceDotEnv(dir), {}));
});

test("a workspace .env symlink is not followed out to a host file", () => {
  // The agent can write its own working directory; following the link would
  // hand it whatever host file it pointed at, the server's own .env included.
  withTempDir((dir) => {
    const hostFile = join(dir, "host.env");
    writeFileSync(hostFile, "HOST_SECRET=leaked\n");
    symlinkSync(hostFile, join(dir, ".env"));
    assert.deepEqual(readWorkspaceDotEnv(dir), {});
  });
});

test("a caller variable wins over .env, and a secret wins over both", () => {
  const dotEnv = { A: "dotenv", B: "dotenv", C: "dotenv" };
  const callerEnv = { B: "caller", C: "caller" };
  const env = sandboxEnv({ ...dotEnv, ...callerEnv }, [{ name: "C", value: "secret" }]);
  assert.ok(env.includes("A=dotenv"));
  assert.ok(env.includes("B=caller"));
  assert.ok(env.includes("C=secret"));
});

test("a held container is exempt from the idle reaper until every hold is released", () => {
  // An open terminal is idle by `lastUsedAt` the whole time someone is reading
  // it, so the hold is the only thing standing between them and a reaped shell.
  const environmentId = "env_hold_test";
  assert.equal(isEnvironmentContainerHeld(environmentId), false);
  holdEnvironmentContainer(environmentId);
  holdEnvironmentContainer(environmentId);
  assert.equal(isEnvironmentContainerHeld(environmentId), true);
  releaseEnvironmentContainer(environmentId);
  assert.equal(
    isEnvironmentContainerHeld(environmentId),
    true,
    "one tab closing must not release another tab's hold",
  );
  releaseEnvironmentContainer(environmentId);
  assert.equal(isEnvironmentContainerHeld(environmentId), false);
});

test("releasing a hold that was never taken does not wrap around", () => {
  const environmentId = "env_unbalanced_release";
  releaseEnvironmentContainer(environmentId);
  assert.equal(isEnvironmentContainerHeld(environmentId), false);
});
