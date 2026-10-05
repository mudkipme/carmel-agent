import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "../effectors/pi-durable/index.ts";
import { eq } from "drizzle-orm";
import { db, initialize } from "../db/index.ts";
import { agents } from "../db/schema.ts";
import { createAgent, createModelRef, createUser } from "../test-support.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import {
  normalizeRepoPath,
  parsePorcelainV2,
  readGitFileDiff,
  readGitStatus,
  setGitExecutorForTests,
} from "./git-workspace.ts";

initialize();

/**
 * The parser is checked against what git actually prints, from a throwaway
 * repository with each kind of change -- including a rename and a name with
 * spaces, the two records whose shape differs.
 */
test("porcelain v2 from a real repository parses into one change per area", () => {
  const repo = mkdtempSync(join(tmpdir(), "carmel-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      encoding: "utf8",
    });
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "kept.txt"), "one\n");
    writeFileSync(join(repo, "old name.txt"), "rename me\n");
    writeFileSync(join(repo, "gone.txt"), "bye\n");
    git("add", ".");
    git("commit", "-q", "-m", "initial");

    writeFileSync(join(repo, "kept.txt"), "one\ntwo\n");
    git("add", "kept.txt");
    writeFileSync(join(repo, "kept.txt"), "one\ntwo\nthree\n");
    renameSync(join(repo, "old name.txt"), join(repo, "new name.txt"));
    git("add", "-A", "old name.txt", "new name.txt");
    rmSync(join(repo, "gone.txt"));
    writeFileSync(join(repo, "fresh file.md"), "new\n");

    const listing = git("-c", "core.quotePath=false", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all");
    const { branch, changes } = parsePorcelainV2(listing);

    assert.equal(branch.branch, "main");
    assert.match(branch.head ?? "", /^[0-9a-f]{40}$/);
    const byKey = Object.fromEntries(changes.map((change) => [`${change.area}:${change.path}`, change]));
    assert.equal(byKey["staged:kept.txt"]?.kind, "modified");
    assert.equal(byKey["unstaged:kept.txt"]?.kind, "modified", "a file changed in both areas is listed in both");
    assert.deepEqual(byKey["staged:new name.txt"], {
      path: "new name.txt",
      originalPath: "old name.txt",
      area: "staged",
      kind: "renamed",
    });
    assert.equal(byKey["unstaged:gone.txt"]?.kind, "deleted");
    assert.equal(byKey["untracked:fresh file.md"]?.kind, "untracked");
    assert.equal(changes.length, 5);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a repository before its first commit has a branch but no HEAD", () => {
  const { branch } = parsePorcelainV2("# branch.oid (initial)\0# branch.head main\0");
  assert.deepEqual(branch, { branch: "main" });
});

test("a detached HEAD has no branch, and ahead/behind is read when there is an upstream", () => {
  const { branch } = parsePorcelainV2(`# branch.oid ${"a".repeat(40)}\0# branch.head (detached)\0# branch.ab +2 -3\0`);
  assert.deepEqual(branch, { head: "a".repeat(40), ahead: 2, behind: 3 });
});

test("a truncated listing drops its last, possibly partial, record", () => {
  const { changes } = parsePorcelainV2("? one.txt\0? two.txt\0? thr", { truncated: true });
  assert.deepEqual(changes.map((change) => change.path), ["one.txt", "two.txt"]);
});

test("paths from the client stay inside the repository and out of revision syntax", () => {
  assert.equal(normalizeRepoPath("src/./a.ts"), "src/a.ts");
  for (const bad of ["", "/etc/passwd", "../outside", "src/../../outside", ".", "a\0b", "a\\b"]) {
    assert.throws(() => normalizeRepoPath(bad), /Invalid path/, bad);
  }
});

/**
 * The real scripts, run by local bash against a throwaway repository instead
 * of the sandbox: a test must not start containers on a runtime other things
 * share. Everything past the executor -- status parsing, blob reads, the
 * working-tree read through the agent's file authority -- is the real path.
 */
test("status and every kind of diff side come back from a real repository", async () => {
  const repo = mkdtempSync(join(tmpdir(), "carmel-git-e2e-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
  setGitExecutorForTests(localBash);
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    git("add", ".");
    git("commit", "-q", "-m", "initial");
    writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");
    git("add", "app.ts");
    writeFileSync(join(repo, "app.ts"), "export const a = 3;\n");
    writeFileSync(join(repo, "notes.md"), "# new\n");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x02]));

    const agent = repoAgent(repo);
    const status = await readGitStatus(agent);
    assert.ok(status.repository);
    assert.equal(status.branch, "main");
    const keys = status.changes.map((change) => `${change.area}:${change.workspacePath}`).sort();
    assert.deepEqual(keys, ["staged:app.ts", "unstaged:app.ts", "unstaged:logo.bin", "untracked:notes.md"]);

    const env = new AgentExecutionEnv(agent);
    try {
      const staged = await readGitFileDiff(agent, env, { path: "app.ts", area: "staged" });
      assert.deepEqual([staged.original, staged.modified], [
        { kind: "text", text: "export const a = 1;\n" },
        { kind: "text", text: "export const a = 2;\n" },
      ]);
      const unstaged = await readGitFileDiff(agent, env, { path: "app.ts", area: "unstaged" });
      assert.deepEqual([unstaged.original, unstaged.modified], [
        { kind: "text", text: "export const a = 2;\n" },
        { kind: "text", text: "export const a = 3;\n" },
      ]);
      const untracked = await readGitFileDiff(agent, env, { path: "notes.md", area: "untracked" });
      assert.deepEqual([untracked.original, untracked.modified], [{ kind: "absent" }, { kind: "text", text: "# new\n" }]);
      const binary = await readGitFileDiff(agent, env, { path: "logo.bin", area: "unstaged" });
      assert.deepEqual([binary.original.kind, binary.modified.kind], ["binary", "binary"]);
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  } finally {
    setGitExecutorForTests(undefined);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a workspace that is not a repository says so rather than failing", async () => {
  const plain = mkdtempSync(join(tmpdir(), "carmel-git-none-"));
  setGitExecutorForTests(localBash);
  try {
    // GIT_CEILING_DIRECTORIES keeps git from finding a repository above the temp dir.
    assert.deepEqual(await readGitStatus(repoAgent(plain)), { repository: false });
  } finally {
    setGitExecutorForTests(undefined);
    rmSync(plain, { recursive: true, force: true });
  }
});

function repoAgent(workingDir: string) {
  const owner = createUser();
  const agentId = createAgent({ ownerUserId: owner, defaultModelRefId: createModelRef({ ownerUserId: owner }) });
  db.update(agents).set({ workingDir, permissions: { read: true, write: false, edit: false, bash: false, network: false } }).where(eq(agents.id, agentId)).run();
  return db.select().from(agents).where(eq(agents.id, agentId)).get()!;
}

const localBash: Parameters<typeof setGitExecutorForTests>[0] = async (_agent, script, cwd, options) => {
  const child = spawn("bash", ["-c", script], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CEILING_DIRECTORIES: tmpdir(), ...options.env },
  });
  child.stdout.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
  const exitCode = await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 1)));
  return { exitCode };
};
