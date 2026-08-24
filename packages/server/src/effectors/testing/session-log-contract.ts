import assert from "node:assert/strict";
import type { SessionLog } from "../contracts/session-log.ts";
import { reconcileSessionState } from "../contracts/session-log.ts";
import type { SessionMessage } from "../contracts/messages.ts";

/**
 * The behaviour every `SessionLog` must have, independent of what implements it.
 *
 * This is the artefact the whole decomposition exists to produce. When the v2
 * adapter is written, it is not reviewed into correctness -- it is pointed at
 * this suite, and the suite either passes or names the operation that changed
 * meaning. Cases assert on branch arithmetic and change detection because those
 * are what the run body depends on and what 0.84's renames put at risk.
 */

export type SessionLogFactory = {
  readonly name: string;
  /** A fresh, empty log. Disposal is the caller's. */
  create(): Promise<SessionLog> | SessionLog;
  dispose?(log: SessionLog): Promise<void> | void;
};

type Case = { readonly name: string; run(log: SessionLog): Promise<void> };

export async function runSessionLogContract(factory: SessionLogFactory, register: RegisterCase) {
  for (const testCase of cases) {
    register(`${factory.name}: ${testCase.name}`, async () => {
      const log = await factory.create();
      try {
        await testCase.run(log);
      } finally {
        await factory.dispose?.(log);
      }
    });
  }
}

export type RegisterCase = (name: string, run: () => Promise<void>) => void;

const cases: readonly Case[] = [
  {
    name: "an appended message becomes the branch leaf",
    async run(log) {
      const id = await log.appendMessage(user("first"));
      const branch = await log.readBranch();
      assert.equal(branch.length, 1);
      assert.equal(branch.at(-1)?.id, id);
      assert.equal(branch.at(-1)?.parentId, null);
    },
  },
  {
    name: "appends chain, so the branch reads oldest to newest",
    async run(log) {
      await log.appendMessage(user("first"));
      await log.appendMessage(user("second"));
      const branch = await log.readBranch();
      assert.deepEqual(branch.map(text), ["first", "second"]);
      assert.equal(branch[1]?.parentId, branch[0]?.id);
    },
  },
  {
    name: "moveTo the parent rewinds the branch without destroying the entry",
    // The retry path does exactly this and then restores, so a rewind that
    // dropped the abandoned entry would lose the user's only copy of it.
    async run(log) {
      const first = await log.appendMessage(user("first"));
      const second = await log.appendMessage(user("second"));
      await log.moveTo(first);
      assert.deepEqual((await log.readBranch()).map(text), ["first"]);
      await log.moveTo(second);
      assert.deepEqual((await log.readBranch()).map(text), ["first", "second"]);
    },
  },
  {
    name: "moveTo(null) empties the branch",
    async run(log) {
      await log.appendMessage(user("first"));
      await log.moveTo(null);
      assert.deepEqual(await log.readBranch(), []);
    },
  },
  {
    name: "appending after a rewind forks rather than overwrites",
    async run(log) {
      const first = await log.appendMessage(user("first"));
      await log.appendMessage(user("abandoned"));
      await log.moveTo(first);
      await log.appendMessage(user("replacement"));
      assert.deepEqual((await log.readBranch()).map(text), ["first", "replacement"]);
    },
  },
  {
    name: "state starts at the defaults and reads back what was appended",
    async run(log) {
      // `thinkingLevel` starts at "off" rather than unset: a session always has
      // an effective level, and reporting "unset" would make the first
      // reconcile of every new session write a redundant change entry.
      assert.deepEqual(await log.readState(), { model: null, thinkingLevel: "off", activeToolNames: null });
      await log.appendModelChange("anthropic", "claude-opus-5");
      await log.appendThinkingLevelChange("medium");
      await log.appendActiveToolsChange(["read", "bash"]);
      const state = await log.readState();
      assert.deepEqual(state.model, { provider: "anthropic", modelId: "claude-opus-5" });
      assert.equal(state.thinkingLevel, "medium");
      assert.deepEqual([...(state.activeToolNames ?? [])], ["read", "bash"]);
    },
  },
  {
    name: "reconcile writes nothing when the state already matches",
    async run(log) {
      const desired = {
        model: { provider: "anthropic", modelId: "claude-opus-5" },
        thinkingLevel: "medium" as const,
        activeToolNames: ["read", "bash"],
      };
      await reconcileSessionState(log, desired);
      const afterFirst = (await log.readBranch()).length;
      await reconcileSessionState(log, desired);
      assert.equal((await log.readBranch()).length, afterFirst, "second reconcile must be a no-op");
    },
  },
  {
    name: "reconcile treats tool order as significant",
    // Order is part of the cached prompt prefix, so a reorder is a real change.
    async run(log) {
      const base = { model: { provider: "anthropic", modelId: "m" }, thinkingLevel: "off" as const };
      await reconcileSessionState(log, { ...base, activeToolNames: ["read", "bash"] });
      await reconcileSessionState(log, { ...base, activeToolNames: ["bash", "read"] });
      assert.deepEqual([...((await log.readState()).activeToolNames ?? [])], ["bash", "read"]);
    },
  },
  {
    name: "close is idempotent",
    // finalizeRun closes on paths where an earlier step already failed.
    async run(log) {
      await log.close();
      await log.close();
    },
  },
];

function user(text: string): SessionMessage {
  return { role: "user", content: text } as SessionMessage;
}

function text(entry: { type: string; message?: SessionMessage }) {
  if (entry.type !== "message" || !entry.message) return undefined;
  const content = (entry.message as { content: unknown }).content;
  return typeof content === "string" ? content : undefined;
}
