import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("recorded run fixtures are consecutive and finish only with run_finished, carrying a result", async () => {
  const directory = new URL("../fixtures/run-streams/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".ndjson"));
  assert.deepEqual(files.sort(), ["abort.ndjson", "compaction.ndjson", "error.ndjson", "text-only.ndjson", "thinking-heavy.ndjson", "tool-heavy.ndjson"]);
  for (const file of files) {
    const lines = (await readFile(new URL(file, directory), "utf8")).trim().split("\n");
    const envelopes = lines.map((line) => JSON.parse(line) as { sequence: number; event: { type: string; result?: { outcome: string } } });
    assert.deepEqual(envelopes.map((item) => item.sequence), envelopes.map((_, index) => index + 1), file);
    assert.equal(envelopes.at(-1)?.event.type, "run_finished", file);
    assert.ok(envelopes.at(-1)?.event.result?.outcome, file);
    assert.equal(envelopes.slice(0, -1).some((item) => item.event.type === "run_finished"), false, file);
  }
});
