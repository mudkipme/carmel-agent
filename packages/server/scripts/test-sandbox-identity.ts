/** Opt-in runtime test: offline package fixtures, private data, no existing containers touched. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { agents } from "../src/db/schema.ts";

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
const { ensureAgentContainer, killAgentContainer, discardAgentContainer, shutdownContainerManager, resolveAgentHomeDirPath, resolveAgentTmpDirPath } = await import("../src/runtime/sandbox/container-manager.ts");
const { execInContainer, attachExecStdio, attachExecTty, createStreamDemuxer } = await import("../src/runtime/sandbox/runtime-client.ts");
const { sandboxEnv } = await import("../src/runtime/sandbox/bash-operations.ts");
const agent = { id: `identity-${Date.now()}`, workingDir: join(directory, "workspace"), workingDirMode: "manual", mounts: [] } as unknown as typeof agents.$inferSelect;
let container: string;
const run = async (cmd: string[]) => {
  let stdout = "", stderr = "";
  const result = await execInContainer(container, { cmd, workingDir: agent.workingDir, env: sandboxEnv() }, {
    onStdout: (chunk) => { stdout += chunk; }, onStderr: (chunk) => { stderr += chunk; }, signal: AbortSignal.timeout(60000),
  });
  assert.equal(result.exitCode, 0, stderr || stdout);
  return stdout.trim();
};
const checkAttach = async (tty: boolean) => {
  const spec = { cmd: ["bash", "-lc", "id -u; id -g; command -v pip; carmel-identity-fixture"], workingDir: agent.workingDir, env: sandboxEnv() };
  const { socket } = tty ? await attachExecTty(container, spec) : await attachExecStdio(container, spec);
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(15000, () => socket.destroy(new Error("Attached command timed out")));
      socket.on("data", tty ? (chunk) => { output += chunk; } : createStreamDemuxer((_stream, chunk) => { output += chunk; }));
      socket.on("error", reject);
      socket.on("end", resolve);
    });
    const lines = output.trim().split(/\r?\n/);
    assert.deepEqual(lines, [process.env.CARMEL_HOST_UID, process.env.CARMEL_HOST_GID, "/home/agent/.venvs/default/bin/pip", "npm-fixture-ok"]);
  } finally { socket.destroy(); }
};
try {
  container = await ensureAgentContainer(agent, { network: false });
  const packageDir = join(agent.workingDir, "npm-fixture");
  await mkdir(packageDir);
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "carmel-identity-fixture", version: "1.0.0", bin: { "carmel-identity-fixture": "cli.js" } }));
  await writeFile(join(packageDir, "cli.js"), '#!/usr/bin/env node\nconsole.log("npm-fixture-ok");\n', { mode: 0o755 });
  // Build a tiny pure-Python wheel with stdlib only, so installs need no registry.
  await run(["python", "-c", `import zipfile
with zipfile.ZipFile('carmel_identity_fixture-1.0-py3-none-any.whl', 'w') as z:
 z.writestr('carmel_identity_fixture.py', 'VALUE = "pip-fixture-ok"\\n')
 z.writestr('carmel_identity_fixture-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: carmel-identity-fixture\\nVersion: 1.0\\n')
 z.writestr('carmel_identity_fixture-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: carmel-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')
 z.writestr('carmel_identity_fixture-1.0.dist-info/RECORD', '')`]);
  await run(["bash", "-lc", "pip install --no-index ./carmel_identity_fixture-1.0-py3-none-any.whl && npm install -g --offline --no-audit --no-fund ./npm-fixture"]);
  await run(["node", "-e", "const fs=require('node:fs');for(const dir of [process.cwd(),process.env.HOME,'/tmp'])fs.writeFileSync(dir+'/identity-file','runner')"]);
  for (const dir of [agent.workingDir, resolveAgentHomeDirPath(agent), resolveAgentTmpDirPath(agent)]) {
    const file = join(dir, "identity-file");
    const owner = await stat(file);
    assert.equal(owner.uid, process.getuid!());
    assert.equal(owner.gid, process.getgid!());
    await writeFile(file, "server");
    await rm(file);
  }
  await run(["bash", "-lc", "test \"$(id -u)\" -ne 0 && test ! -w /usr && test ! -w /etc && ! apt-get install -y ripgrep"]);
  await checkAttach(false);
  await checkAttach(true);
  await killAgentContainer(agent.id);
  container = await ensureAgentContainer(agent, { network: false });
  assert.equal(await run(["python", "-c", "import carmel_identity_fixture; print(carmel_identity_fixture.VALUE)"]), "pip-fixture-ok");
  assert.equal(await run(["carmel-identity-fixture"]), "npm-fixture-ok");
  assert.match(await run(["bash", "-lc", "python -m pip --version"]), /from \/home\/agent\/\.venvs\/default\/lib\/python[\d.]+\/site-packages\/pip/);
  console.log("PASS: non-root identity, host ownership, server edits, offline pip/npm installs, direct/TTY exec, and persistence after recreation.");
} finally {
  await discardAgentContainer(agent.id);
  await shutdownContainerManager();
  await rm(directory, { recursive: true, force: true });
}
