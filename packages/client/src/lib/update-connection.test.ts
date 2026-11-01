import test from "node:test";
import assert from "node:assert/strict";
import type { UpdateClientMessage, UpdateServerMessage } from "@carmel-agent/shared";
import { UpdateConnection } from "./update-connection.ts";

class FakeSocket {
  readyState = 1;
  sent: UpdateClientMessage[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  receive(message: UpdateServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function fixture() {
  const sockets: FakeSocket[] = [];
  const connection = new UpdateConnection(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return {
    connection,
    sockets,
    ready: (index = sockets.length - 1, revision = 0) =>
      sockets[index]!.receive({ type: "ready", epoch: `epoch-${index}`, revision }),
  };
}

test("all resource and run subscriptions share one socket and sequence gaps refresh every topic", () => {
  const f = fixture();
  let sessions = 0;
  let tasks = 0;
  const offSessions = f.connection.subscribe(["sessions"], () => sessions++);
  const offTasks = f.connection.subscribe(["tasks"], () => tasks++);
  try {
    assert.equal(f.sockets.length, 1);
    f.ready();
    assert.deepEqual([sessions, tasks], [1, 1]);
    f.sockets[0]!.receive({ type: "state_changed", revision: 1, topics: ["sessions"] });
    f.sockets[0]!.receive({ type: "state_changed", revision: 1, topics: ["sessions"] });
    assert.deepEqual([sessions, tasks], [2, 1]);
    f.sockets[0]!.receive({ type: "state_changed", revision: 3, topics: ["sessions"] });
    assert.deepEqual([sessions, tasks], [3, 2]);
    offSessions();
    assert.equal(f.sockets[0]!.readyState, 1);
  } finally {
    offTasks();
  }
  assert.equal(f.sockets[0]!.readyState, 3);
});

test("run readers receive only their events and detaching one leaves the shared connection open", async () => {
  const f = fixture();
  const a = new AbortController();
  const b = new AbortController();
  const first = f.connection.openRunStream("run-a", 7, a.signal);
  const second = f.connection.openRunStream("run-b", 0, b.signal);
  f.ready();
  const socket = f.sockets[0]!;
  assert.deepEqual(socket.sent, [
    { type: "watch_run", id: "1", runId: "run-a", after: 7 },
    { type: "watch_run", id: "2", runId: "run-b", after: 0 },
  ]);
  socket.receive({ type: "run_open", id: "1", status: 200 });
  socket.receive({ type: "run_open", id: "2", status: 200 });
  const firstStream = await first;
  const secondStream = await second;
  assert.ok(firstStream.status === 200 && secondStream.status === 200);
  const firstReader = firstStream.events.getReader();
  const secondReader = secondStream.events.getReader();
  socket.receive({
    type: "run_event",
    id: "1",
    envelope: { sequence: 8, event: { type: "turn_end" } },
  });
  assert.equal((await firstReader.read()).value?.sequence, 8);
  a.abort(new Error("detached"));
  await assert.rejects(firstReader.read(), /detached/);
  assert.equal(socket.readyState, 1);
  socket.receive({
    type: "run_event",
    id: "2",
    envelope: { sequence: 1, event: { type: "agent_end" } },
  });
  socket.receive({ type: "run_close", id: "2" });
  assert.equal((await secondReader.read()).value?.event.type, "agent_end");
  assert.equal((await secondReader.read()).done, true);
  assert.equal(socket.readyState, 3);
  assert.ok(socket.sent.some((m) => m.type === "unwatch_run" && m.id === "1"));
});

test("reconnection refreshes snapshots even when the server revision resets", async () => {
  const f = fixture();
  let refreshes = 0;
  const off = f.connection.subscribe(["sessions"], () => refreshes++);
  try {
    f.ready(0, 100);
    const signal = new AbortController().signal;
    const response = f.connection.openRunStream("run", 4, signal);
    f.sockets[0]!.receive({ type: "run_open", id: "1", status: 200 });
    const stream = await response;
    assert.ok(stream.status === 200);
    const reader = stream.events.getReader();
    f.sockets[0]!.close();
    await assert.rejects(reader.read(), /connection lost/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(f.sockets.length, 2);
    f.ready(1, 0);
    assert.equal(refreshes, 3);
    const resumed = f.connection.openRunStream("run", 4, signal);
    f.sockets[1]!.receive({ type: "run_open", id: "2", status: 409 });
    assert.equal((await resumed).status, 409);
    assert.deepEqual(f.sockets[1]!.sent[0], { type: "watch_run", id: "2", runId: "run", after: 4 });
  } finally {
    off();
  }
});
