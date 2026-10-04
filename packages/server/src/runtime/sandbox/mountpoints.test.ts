import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNestedMountpoints } from "./mountpoints.ts";

test("nested workspace and file mountpoints are created with server ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "mountpoints-"));
  try {
    const tmp = join(directory, "tmp"), workspace = join(directory, "workspace"), file = join(directory, "source.txt");
    mkdirSync(tmp); mkdirSync(workspace); writeFileSync(file, "source");
    const mounts = [{ source: tmp, target: "/tmp" }, { source: workspace, target: "/tmp/project" }, { source: file, target: "/tmp/project/config/file.txt" }];
    prepareNestedMountpoints(mounts);
    assert.equal(statSync(join(tmp, "project")).uid, process.getuid!());
    assert.equal(statSync(join(workspace, "config/file.txt")).uid, process.getuid!());
    writeFileSync(join(workspace, "config/file.txt"), "keep existing data");
    prepareNestedMountpoints(mounts);
    assert.equal(readFileSync(join(workspace, "config/file.txt"), "utf8"), "keep existing data");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("mountpoint preparation refuses symlink traversal", () => {
  const directory = mkdtempSync(join(tmpdir(), "mountpoints-"));
  try {
    const parent = join(directory, "parent"), outside = join(directory, "outside");
    mkdirSync(parent); mkdirSync(outside); symlinkSync(outside, join(parent, "escape"));
    assert.throws(() => prepareNestedMountpoints([{ source: parent, target: "/tmp" }, { source: outside, target: "/tmp/escape/new" }]), /Cannot prepare nested/);
    assert.equal(existsSync(join(outside, "new")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("read-only parent mounts require existing targets and are never modified", () => {
  const directory = mkdtempSync(join(tmpdir(), "mountpoints-"));
  try {
    const parent = join(directory, "parent"), source = join(directory, "source");
    mkdirSync(parent); mkdirSync(source);
    const mounts = [{ source: parent, target: "/refs", readOnly: true }, { source, target: "/refs/child" }];
    assert.throws(() => prepareNestedMountpoints(mounts), /Cannot prepare nested/);
    assert.equal(existsSync(join(parent, "child")), false);
    mkdirSync(join(parent, "child"));
    prepareNestedMountpoints(mounts);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
