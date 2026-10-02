import test from "node:test";
import assert from "node:assert/strict";
import { BrowserControl } from "./browser-control.ts";

test("takeover drains all agent calls before allowing human input and blocks new calls", async () => {
  const control = new BrowserControl();
  const first = await control.enter();
  const second = await control.enter();
  control.take("alice-tab", "Alice");
  assert.equal(control.state.phase, "pausing");
  assert.equal(control.canInput("alice-tab"), false);
  assert.throws(() => control.resume("alice-tab"), /current tool call/);
  let started = false;
  const pending = control.enter().then((lease) => { started = true; return lease; });
  first.release();
  assert.equal(control.state.phase, "pausing");
  second.release();
  assert.equal(control.state.phase, "human");
  assert.equal(control.canInput("alice-tab"), true);
  await Promise.resolve();
  assert.equal(started, false);
  control.resume("alice-tab");
  const lease = await pending;
  assert.equal(lease.interrupted, true, "queued actions must be reconsidered after human input");
  lease.release();
});

test("shared users have one controller; disconnect leaves a paused browser that can be reclaimed", async () => {
  const control = new BrowserControl();
  control.take("alice", "Alice");
  assert.throws(() => control.take("bob", "Bob"), /already has/);
  assert.throws(() => control.resume("bob"), /Take control/);
  control.detach("bob");
  assert.equal(control.canInput("alice"), true);
  control.detach("alice");
  assert.equal(control.state.phase, "waiting");
  control.take("bob", "Bob");
  assert.equal(control.canInput("alice"), false);
  assert.equal(control.canInput("bob"), true);
  control.resume("bob");
  assert.equal(control.state.phase, "agent");
});

test("assistance survives restoration without resurrecting an input lease", async () => {
  const writes: Array<{ paused: boolean; reason?: string; revision: number }> = [];
  const control = new BrowserControl(undefined, (state) => writes.push(state));
  const abort = new AbortController();
  const waiting = control.requestHelp("Please sign in", abort.signal);
  control.take("alice", "Alice");
  const restored = new BrowserControl(writes.at(-1));
  assert.equal(restored.state.phase, "waiting");
  assert.equal(restored.state.reason, "Please sign in");
  assert.equal(restored.canInput("alice"), false);
  abort.abort();
  await assert.rejects(waiting);
  assert.equal(control.state.phase, "human", "stopping the agent must not steal human control");
  control.resume("alice");
  assert.equal(new BrowserControl(writes.at(-1)).state.phase, "agent");
});

test("cancelling a queued tool releases its waiter without opening the gate", async () => {
  const control = new BrowserControl();
  control.take("alice", "Alice");
  const abort = new AbortController();
  const waiting = control.enter(abort.signal);
  abort.abort(new Error("Stopped"));
  await assert.rejects(waiting, /Stopped/);
  assert.equal(control.state.phase, "human");
  control.resume("alice");
  const lease = await control.enter(); lease.release(); lease.release();
  control.take("bob", "Bob");
  assert.equal(control.state.phase, "human", "release must be idempotent");
});

test("an agent cannot slip into a new takeover while its prior wait is resolving", async () => {
  const control = new BrowserControl();
  control.take("alice", "Alice");
  const abort = new AbortController();
  const waiting = control.enter(abort.signal);
  control.resume("alice");
  control.take("bob", "Bob");
  await Promise.resolve();
  assert.equal(control.state.phase, "human");
  abort.abort();
  await assert.rejects(waiting);
});
