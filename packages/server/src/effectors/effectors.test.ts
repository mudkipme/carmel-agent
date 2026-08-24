import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { createPi083SessionLog } from "./pi-0-83/session-log.ts";
import { FakeSessionLog } from "./testing/fake-session-log.ts";
import { runSessionLogContract } from "./testing/session-log-contract.ts";
import { dispatchPrompt } from "./dispatch-prompt.ts";
import type { AgentDriver, DriverResources } from "./contracts/agent-driver.ts";
import type { CompactionOutcome } from "./compaction-policy.ts";

migrate();

// Both implementations answer to the same suite. That equivalence is what lets
// tests above the port use the fake, and what will decide whether a v2 adapter
// is finished.
await runSessionLogContract({ name: "FakeSessionLog", create: () => new FakeSessionLog() }, (name, run) =>
  test(name, run),
);

await runSessionLogContract(
  {
    name: "Pi083SessionLog",
    async create() {
      const { sessionId } = createSession();
      return createPi083SessionLog(await openPiSession(sessionId));
    },
    dispose: (log) => log.close(),
  },
  (name, run) => test(name, run),
);

test("plain text goes straight to prompt", async () => {
  const { driver, calls } = recordingDriver();
  await dispatchPrompt(driver, "hello");
  assert.deepEqual(calls, [["prompt", "hello", undefined]]);
});

test("a namespaced skill command invokes the skill with trimmed arguments", async () => {
  const { driver, calls } = recordingDriver({ skills: [{ name: "pdf" }], promptTemplates: [] });
  await dispatchPrompt(driver, "/skill:pdf   summarise it  ");
  assert.deepEqual(calls, [["invokeSkill", "pdf", "summarise it", undefined]]);
});

test("a skill command with no arguments passes undefined, not an empty string", async () => {
  const { driver, calls } = recordingDriver({ skills: [{ name: "pdf" }], promptTemplates: [] });
  await dispatchPrompt(driver, "/skill:pdf");
  assert.deepEqual(calls, [["invokeSkill", "pdf", undefined, undefined]]);
});

test("a template command keeps its arguments untrimmed for the driver to parse", async () => {
  const { driver, calls } = recordingDriver({ skills: [], promptTemplates: [{ name: "review" }] });
  await dispatchPrompt(driver, "/review a=1 b=2");
  assert.deepEqual(calls, [["invokeTemplate", "review", "a=1 b=2", undefined]]);
});

test("a skill: token matching no skill falls through to a template of that exact name", async () => {
  const { driver, calls } = recordingDriver({ skills: [], promptTemplates: [{ name: "skill:pdf" }] });
  await dispatchPrompt(driver, "/skill:pdf go");
  assert.deepEqual(calls, [["invokeTemplate", "skill:pdf", "go", undefined]]);
});

test("an unknown command is sent as ordinary text, slash and all", async () => {
  const { driver, calls } = recordingDriver();
  await dispatchPrompt(driver, "/nope do a thing");
  assert.deepEqual(calls, [["prompt", "/nope do a thing", undefined]]);
});

test("images ride along with a named invocation rather than forcing plain text", async () => {
  // The inlining workaround belongs to the driver; dispatch must not pre-empt it.
  const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
  const { driver, calls } = recordingDriver({ skills: [{ name: "pdf" }], promptTemplates: [] });
  await dispatchPrompt(driver, "/skill:pdf look", images);
  assert.deepEqual(calls, [["invokeSkill", "pdf", "look", images]]);
});

function recordingDriver(resources: DriverResources = { skills: [], promptTemplates: [] }) {
  const calls: unknown[][] = [];
  const driver: AgentDriver = {
    listResources: () => resources,
    async prompt(text, images) {
      calls.push(["prompt", text, images]);
    },
    async invokeSkill(name, instructions, images) {
      calls.push(["invokeSkill", name, instructions, images]);
    },
    async invokeTemplate(name, args, images) {
      calls.push(["invokeTemplate", name, args, images]);
    },
    observe: () => () => {},
    abort: async () => {},
    relieveContextPressure: async (): Promise<CompactionOutcome> => ({ status: "not_needed", tokens: 0, headroom: 1 }),
  };
  return { driver, calls };
}
