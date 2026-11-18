/** Opt-in runtime test: offline package fixtures, private data, no existing containers touched. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { environments } from "../src/db/schema.ts";

const image = process.env.CARMEL_SANDBOX_TEST_IMAGE;
if (!image) throw new Error("Set CARMEL_SANDBOX_TEST_IMAGE to a locally built runner image.");
const directory = await mkdtemp(join(tmpdir(), "carmel-sandbox-identity-"));
process.env.DATABASE_URL = ":memory:";
process.env.CARMEL_AGENT_DATA_DIR = directory;
process.env.CARMEL_HOST_DATA_DIR = directory;
process.env.CARMEL_HOST_UID ??= String(process.getuid!());
process.env.CARMEL_HOST_GID ??= String(process.getgid!());
process.env.CARMEL_BASH_IMAGE = image;
process.env.CARMEL_BASH_GPU = "";
const {
  ensureEnvironmentContainer,
  killEnvironmentContainer,
  discardEnvironmentContainer,
  shutdownContainerManager,
  resolveEnvironmentHomeDirPath,
  resolveEnvironmentTmpDirPath,
} = await import("../src/runtime/sandbox/container-manager.ts");
const { initialize } = await import("../src/db/index.ts");
initialize();
const { execInContainer, attachExecStdio, attachExecTty, createStreamDemuxer } =
  await import("../src/runtime/sandbox/runtime-client.ts");
const { execSandboxCommand, sandboxEnv } =
  await import("../src/runtime/sandbox/bash-operations.ts");
const environment = {
  id: `identity-${Date.now()}`,
  storageDir: "environments/identity",
  workingDir: join(directory, "workspace"),
  workingDirMode: "manual",
  mounts: [],
  network: false,
} as unknown as typeof environments.$inferSelect;
let container: string;
const run = async (cmd: string[]) => {
  let stdout = "",
    stderr = "";
  const result = await execInContainer(
    container,
    { cmd, workingDir: environment.workingDir, env: sandboxEnv() },
    {
      onStdout: (chunk) => {
        stdout += chunk;
      },
      onStderr: (chunk) => {
        stderr += chunk;
      },
      signal: AbortSignal.timeout(60000),
    },
  );
  assert.equal(result.exitCode, 0, stderr || stdout);
  return stdout.trim();
};
const checkAttach = async (tty: boolean) => {
  const spec = {
    cmd: ["bash", "-lc", "id -u; id -g; command -v pip; carmel-identity-fixture"],
    workingDir: environment.workingDir,
    env: sandboxEnv(),
  };
  const { socket } = tty
    ? await attachExecTty(container, spec)
    : await attachExecStdio(container, spec);
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(15000, () => socket.destroy(new Error("Attached command timed out")));
      socket.on(
        "data",
        tty
          ? (chunk) => {
              output += chunk;
            }
          : createStreamDemuxer((_stream, chunk) => {
              output += chunk;
            }),
      );
      socket.on("error", reject);
      socket.on("end", resolve);
    });
    const lines = output.trim().split(/\r?\n/);
    assert.deepEqual(lines, [
      process.env.CARMEL_HOST_UID,
      process.env.CARMEL_HOST_GID,
      "/home/agent/.venvs/default/bin/pip",
      "npm-fixture-ok",
    ]);
  } finally {
    socket.destroy();
  }
};
try {
  container = await ensureEnvironmentContainer(environment);
  const packageDir = join(environment.workingDir, "npm-fixture");
  await mkdir(packageDir);
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "carmel-identity-fixture",
      version: "1.0.0",
      bin: { "carmel-identity-fixture": "cli.js" },
    }),
  );
  await writeFile(
    join(packageDir, "cli.js"),
    '#!/usr/bin/env node\nconsole.log("npm-fixture-ok");\n',
    { mode: 0o755 },
  );
  // Build a tiny pure-Python wheel with stdlib only, so installs need no registry.
  await run([
    "python",
    "-c",
    `import zipfile
with zipfile.ZipFile('carmel_identity_fixture-1.0-py3-none-any.whl', 'w') as z:
 z.writestr('carmel_identity_fixture.py', 'VALUE = "pip-fixture-ok"\\n')
 z.writestr('carmel_identity_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: carmel-identity-fixture\\nVersion: 1.0\\n')
 z.writestr('carmel_identity_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: carmel-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
 z.writestr('carmel_identity_fixture-1.0.dist-info/RECORD', '')`,
  ]);
  await run([
    "bash",
    "-lc",
    "pip install --no-index ./carmel_identity_fixture-1.0-py3-none-any.whl && npm install -g --offline --no-audit --no-fund ./npm-fixture",
  ]);
  await run([
    "node",
    "-e",
    "const fs=require('node:fs');for(const dir of [process.cwd(),process.env.HOME,'/tmp'])fs.writeFileSync(dir+'/identity-file','runner')",
  ]);
  for (const dir of [
    environment.workingDir,
    resolveEnvironmentHomeDirPath(environment),
    resolveEnvironmentTmpDirPath(environment),
  ]) {
    const file = join(dir, "identity-file");
    const owner = await stat(file);
    assert.equal(owner.uid, process.getuid!());
    assert.equal(owner.gid, process.getgid!());
    await writeFile(file, "server");
    await rm(file);
  }
  await run([
    "bash",
    "-lc",
    'test "$(id -u)" -ne 0 && test ! -w /usr && test ! -w /etc && ! apt-get install -y ripgrep',
  ]);
  await checkAttach(false);
  await checkAttach(true);

  // Stopping one command, background children included, must leave another
  // agent's command in the shared runner alone.
  const siblingOutput: string[] = [];
  const sibling = execSandboxCommand(
    environment,
    "sleep 3 && echo sibling-survived",
    environment.workingDir,
    { onStdout: (chunk) => siblingOutput.push(chunk) },
  );
  const controller = new AbortController();
  let aborted = "";
  const stopped = execSandboxCommand(
    environment,
    "(sleep 60 &) ; nohup sleep 60 >/dev/null 2>&1 & echo started; sleep 60",
    environment.workingDir,
    {
      signal: controller.signal,
      onStdout: (chunk) => {
        aborted += chunk;
        if (aborted.includes("started")) controller.abort();
      },
    },
  ).catch(() => undefined);
  await stopped;
  // The stop is signalled on abort, not awaited by it.
  let survivors = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    survivors = await run(["sh", "-c", "pgrep -fc '^sleep 60$' || true"]);
    if (survivors === "0") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(survivors, "0", "the stopped command and its background children are gone");
  assert.equal((await sibling).exitCode, 0);
  assert.match(siblingOutput.join(""), /sibling-survived/);
  assert.equal(await ensureEnvironmentContainer(environment), container, "the runner is reused");
  await run([
    "node",
    "-e",
    "const fs=require('node:fs');for(const dir of [process.cwd(),process.env.HOME,'/tmp'])fs.writeFileSync(dir+'/container-lifetime','fixture')",
  ]);
  await killEnvironmentContainer(environment.id);
  await assert.rejects(stat(resolveEnvironmentTmpDirPath(environment)), { code: "ENOENT" });
  await stat(join(environment.workingDir, "container-lifetime"));
  await stat(join(resolveEnvironmentHomeDirPath(environment), "container-lifetime"));
  container = await ensureEnvironmentContainer(environment);
  assert.equal(
    await run([
      "node",
      "-e",
      "console.log(require('node:fs').existsSync('/tmp/container-lifetime'))",
    ]),
    "false",
  );
  assert.equal(
    await run([
      "python",
      "-c",
      "import carmel_identity_fixture; print(carmel_identity_fixture.VALUE)",
    ]),
    "pip-fixture-ok",
  );
  assert.equal(await run(["carmel-identity-fixture"]), "npm-fixture-ok");
  assert.match(
    await run(["bash", "-lc", "python -m pip --version"]),
    /from \/home\/agent\/\.venvs\/default\/lib\/python[\d.]+\/site-packages\/pip/,
  );
  console.log(
    "PASS: non-root identity, host ownership, server edits, offline pip/npm installs, direct/TTY exec, per-command stop in a shared runner, and persistent workspace/home with fresh tmp after recreation.",
  );
} finally {
  await discardEnvironmentContainer(environment);
  await shutdownContainerManager();
  await rm(directory, { recursive: true, force: true });
}
