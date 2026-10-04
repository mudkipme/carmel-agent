import test from "node:test";
import assert from "node:assert/strict";
import { planSandboxIdentity, resolveHostIdentity, type PodmanInfo } from "./runtime-identity.ts";

const host = { uid: 1234, gid: 2345 };
const docker = { Os: "linux", Components: [{ Name: "Engine" }] };
const podman = { Os: "linux", Components: [{ Name: "Podman Engine" }] };
const info = { SecurityOptions: ["name=seccomp,profile=builtin"] };
const rootlessPodman: PodmanInfo = { host: {
  security: { rootless: true },
  idMappings: {
    uidmap: [{ container_id: 0, host_id: host.uid, size: 1 }],
    gidmap: [{ container_id: 0, host_id: host.gid, size: 1 }],
  },
} };

test("rootful Docker and Podman run as the host user without remapping", () => {
  for (const version of [docker, podman]) {
    const policy = planSandboxIdentity(host, version, info, { host: { security: { rootless: false } } });
    assert.equal(policy.user, "1234:2345");
    assert.equal(policy.usernsMode, "host");
  }
});

test("rootless Podman preserves the daemon owner's UID and GID with keep-id", () => {
  const policy = planSandboxIdentity(host, podman, info, rootlessPodman);
  assert.equal(policy.user, "1234:2345");
  assert.equal(policy.usernsMode, "keep-id");
  assert.throws(() => planSandboxIdentity({ uid: 1000, gid: 1000 }, podman, info, rootlessPodman), /daemon must run as/);
  assert.throws(() => planSandboxIdentity(host, podman, info), /Cannot determine/);
  assert.throws(() => planSandboxIdentity(host, podman, info, { host: { security: { rootless: true } } }), /daemon must run as/);
});

test("unsupported and unknown runtime mappings fail closed", () => {
  for (const option of ["name=rootless", "name=userns", "rootless", "userns"]) {
    assert.throws(() => planSandboxIdentity(host, docker, { SecurityOptions: [option] }), /not supported/);
  }
  assert.throws(() => planSandboxIdentity(host, docker, {}), /Cannot establish/);
  assert.throws(() => planSandboxIdentity(host, {}, info), /Cannot establish/);
  assert.throws(() => planSandboxIdentity(host, { Os: "linux" }, info), /Unsupported sandbox runtime/);
});

test("host mode can infer IDs; containerized servers must supply both", () => {
  assert.deepEqual(resolveHostIdentity({ env: {}, ...host, containerized: false }), host);
  assert.throws(() => resolveHostIdentity({ env: {}, ...host, containerized: true }), /Set both/);
  assert.throws(() => resolveHostIdentity({ env: { CARMEL_HOST_UID: "1234" }, ...host, containerized: false }), /Set both/);
  assert.deepEqual(resolveHostIdentity({ env: { CARMEL_HOST_UID: "1234", CARMEL_HOST_GID: "2345" }, ...host, containerized: true }), host);
});

test("reject root, malformed IDs, and mismatched server identities", () => {
  for (const value of ["0", "-1", "12oops", "1.5", "4294967295"]) {
    assert.throws(() => resolveHostIdentity({ env: { CARMEL_HOST_UID: value, CARMEL_HOST_GID: "2345" }, ...host, containerized: false }), /nonzero numeric/);
  }
  assert.throws(() => resolveHostIdentity({ env: {}, uid: 0, gid: 0, containerized: false }), /non-root/);
  assert.throws(() => resolveHostIdentity({ env: { CARMEL_HOST_UID: "1234", CARMEL_HOST_GID: "2345" }, uid: 0, gid: 0, containerized: true }), /server as 1234:2345/);
});
