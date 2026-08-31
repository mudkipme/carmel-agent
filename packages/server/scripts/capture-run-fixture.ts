import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const baseURL = process.env.CARMEL_FIXTURE_BASE_URL ?? "http://127.0.0.1:8797";
const cookie = process.env.CARMEL_FIXTURE_COOKIE;
const agentId = process.env.CARMEL_FIXTURE_AGENT_ID;
const sessionId = process.env.CARMEL_FIXTURE_SESSION_ID;
const prompt = process.env.CARMEL_FIXTURE_PROMPT;
const output = process.env.CARMEL_FIXTURE_OUTPUT;

if (!cookie || !agentId || !sessionId || !prompt || !output) {
  throw new Error("Set CARMEL_FIXTURE_COOKIE, _AGENT_ID, _SESSION_ID, _PROMPT, and _OUTPUT.");
}

const response = await fetch(`${baseURL}/api/agents/${encodeURIComponent(agentId)}/run`, {
  method: "POST",
  headers: { cookie, "content-type": "application/json", accept: "application/x-ndjson" },
  body: JSON.stringify({ sessionId, promptInput: { text: prompt } }),
});
if (!response.ok || !response.body) throw new Error(`Run failed with HTTP ${response.status}: ${await response.text()}`);

const bytes = new Uint8Array(await new Response(response.body).arrayBuffer());
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, bytes);
console.log(`Captured ${bytes.byteLength} bytes to ${destination}`);
