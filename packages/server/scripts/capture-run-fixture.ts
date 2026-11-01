import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WebSocket } from "ws";
import type { UpdateServerMessage } from "@carmel-agent/shared";

const baseURL = process.env.CARMEL_FIXTURE_BASE_URL ?? "http://127.0.0.1:8797";
const cookie = process.env.CARMEL_FIXTURE_COOKIE;
const agentId = process.env.CARMEL_FIXTURE_AGENT_ID;
const sessionId = process.env.CARMEL_FIXTURE_SESSION_ID;
const prompt = process.env.CARMEL_FIXTURE_PROMPT;
const output = process.env.CARMEL_FIXTURE_OUTPUT;

if (!cookie || !agentId || !sessionId || !prompt || !output) {
  throw new Error("Set CARMEL_FIXTURE_COOKIE, _AGENT_ID, _SESSION_ID, _PROMPT, and _OUTPUT.");
}

const url = new URL("/api/updates", baseURL);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(url, { headers: { cookie, origin: new URL(baseURL).origin } });
const envelopes: string[] = [];
let finished = false;
const startRun = async () => {
  const response = await fetch(`${baseURL}/api/agents/${encodeURIComponent(agentId)}/run`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ sessionId, promptInput: { text: prompt } }),
  });
  if (!response.ok)
    throw new Error(`Run failed with HTTP ${response.status}: ${await response.text()}`);
  const admitted = (await response.json()) as { runId?: string };
  if (!admitted.runId) throw new Error("Run response did not identify its server run.");
  socket.send(
    JSON.stringify({ type: "watch_run", id: "capture", runId: admitted.runId, after: 0 }),
  );
};
try {
  await new Promise<void>((accept, reject) => {
    socket.on("error", reject);
    socket.on("close", () => {
      if (!finished) reject(new Error("Update connection closed before the run finished."));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as UpdateServerMessage;
      if (message.type === "ready") void startRun().catch(reject);
      else if (message.type === "run_open" && message.status !== 200)
        reject(new Error(`Run subscription failed with status ${message.status}.`));
      else if (message.type === "run_event") envelopes.push(JSON.stringify(message.envelope));
      else if (message.type === "run_close") {
        finished = true;
        accept();
      }
    });
  });
} finally {
  socket.close();
}
const bytes = new TextEncoder().encode(envelopes.join("\n") + "\n");
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, bytes);
console.log(`Captured ${bytes.byteLength} bytes to ${destination}`);
