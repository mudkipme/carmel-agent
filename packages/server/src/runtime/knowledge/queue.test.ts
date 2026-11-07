import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeLock } from "./queue.ts";

test("a canceled queued search rejects before indexing finishes and never runs later", async () => {
  const key = crypto.randomUUID();
  let release!: () => void;
  const indexing = knowledgeLock(
    key,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const reason = new Error("Recall deadline expired");
  let called = false;
  let rejected: unknown;
  const search = knowledgeLock(
    key,
    async () => {
      called = true;
    },
    controller.signal,
  );
  void search.catch((error) => {
    rejected = error;
  });
  try {
    controller.abort(reason);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejected, reason);
    assert.equal(called, false);
  } finally {
    release();
    await Promise.allSettled([indexing, search]);
  }
  await knowledgeLock(key, async () => {});
  assert.equal(called, false);
});

test("canceling active work returns promptly but preserves serialization until it settles", async () => {
  const key = crypto.randomUUID();
  const controller = new AbortController();
  let release!: () => void;
  const active = knowledgeLock(
    key,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    controller.signal,
  );
  let rejected = false;
  void active.catch(() => {
    rejected = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  let nextRan = false;
  const next = knowledgeLock(key, async () => {
    nextRan = true;
  });
  try {
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejected, true);
    assert.equal(nextRan, false);
  } finally {
    release();
    await Promise.allSettled([active, next]);
  }
  assert.equal(nextRan, true);
});
