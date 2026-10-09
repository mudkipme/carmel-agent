import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import type { ApiKey, ApiKeyCreated } from "@carmel-agent/shared";
import { requireAuth, type AuthVariables } from "../auth.ts";
import { db, initialize } from "../db/index.ts";
import { modelRefs, users } from "../db/schema.ts";
import { id, now } from "../db/seed.ts";
import { createApiKey } from "../services/api-keys.ts";
import { createUser } from "../test-support.ts";
import { createApiKeyRoutes } from "./api-keys.ts";
import { createAuthRoutes } from "./auth.ts";
import { createOpenAIRoutes } from "./openai.ts";
import { hashPassword } from "../auth.ts";
import { eq } from "drizzle-orm";

/**
 * The `/v1` endpoint end to end: key auth, model visibility, and a real pi-ai
 * request to a provider on localhost that records what it was sent. The
 * provider's view is the point -- it must see pi, with the caller's tools, and
 * none of the caller's own headers.
 */

initialize();

type Upstream = { headers: IncomingHttpHeaders; body: Record<string, any> };
type ProviderMode = "text" | "tool" | "reject";
const provider = await startFakeProvider();
after(() => provider.close());

const app = new Hono<{ Variables: AuthVariables }>();
app.use("/api/*", requireAuth);
app.route("/api/auth", createAuthRoutes());
app.route("/api", createApiKeyRoutes());
app.route("/v1", createOpenAIRoutes());

const json = { "content-type": "application/json" };
const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Look up the weather.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

test("requests without a valid key are refused in OpenAI's error shape", async () => {
  for (const authorization of [undefined, "Bearer nope", "Bearer carmel-not-a-real-key"]) {
    const response = await app.request("/v1/models", {
      headers: authorization ? { authorization } : {},
    });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_api_key");
  }
});

test("keys are created once, listed without the secret, and revoked by their owner only", async () => {
  const owner = await createLoginUser();
  const other = await createLoginUser();

  const created = await app.request("/api/api-keys", {
    method: "POST",
    headers: { ...json, cookie: owner.cookie },
    body: JSON.stringify({ name: "laptop" }),
  });
  assert.equal(created.status, 201);
  const key = (await created.json()) as ApiKeyCreated;
  assert.match(key.key, /^carmel-/);
  assert.ok(key.key.startsWith(key.prefix));

  const listed = (await (
    await app.request("/api/api-keys", { headers: { cookie: owner.cookie } })
  ).json()) as ApiKey[];
  assert.deepEqual(
    listed.map((item) => item.id),
    [key.id],
  );
  assert.equal("key" in listed[0]!, false);
  assert.deepEqual(
    await (await app.request("/api/api-keys", { headers: { cookie: other.cookie } })).json(),
    [],
  );

  const models = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  assert.equal(models.status, 200);

  const foreignDelete = await app.request(`/api/api-keys/${key.id}`, {
    method: "DELETE",
    headers: { cookie: other.cookie },
  });
  assert.equal(foreignDelete.status, 404);
  const deleted = await app.request(`/api/api-keys/${key.id}`, {
    method: "DELETE",
    headers: { cookie: owner.cookie },
  });
  assert.equal(deleted.status, 200);
  const revoked = await app.request("/v1/models", {
    headers: { authorization: `Bearer ${key.key}` },
  });
  assert.equal(revoked.status, 401);
});

test("a key sees its user's own and shared models, not another user's private ones", async () => {
  const alice = createUser();
  const bob = createUser();
  const alicePrivate = insertModel(alice, { shared: false });
  const aliceShared = insertModel(alice, { shared: true });
  const bobPrivate = insertModel(bob, { shared: false });
  const bobKey = createApiKey(bob, "test").key;

  const listed = (await (
    await app.request("/v1/models", { headers: { authorization: `Bearer ${bobKey}` } })
  ).json()) as {
    data: Array<{ id: string }>;
  };
  const ids = listed.data.map((item) => item.id);
  assert.ok(ids.includes(`ollama/${bobPrivate}`));
  assert.ok(ids.includes(`ollama/${aliceShared}`));
  assert.ok(!ids.includes(`ollama/${alicePrivate}`));

  const denied = await chat(bobKey, {
    model: `ollama/${alicePrivate}`,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(denied.status, 404);
});

test("a completion goes out as pi, not as the caller", async () => {
  provider.mode = "text";
  const { key, modelId } = setupUserWithModel();

  const response = await chat(
    key,
    {
      model: `ollama/${modelId}`,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hello" },
      ],
      tools: [weatherTool],
    },
    {
      "user-agent": "OpenAI/Python 1.99.0",
      "x-stainless-lang": "python",
      "x-custom-client": "leak-me",
    },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hi there.");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(body.usage.prompt_tokens, 12);

  const upstream = provider.last!;
  assert.match(upstream.headers["user-agent"] ?? "", /^pi \(/);
  assert.equal(upstream.headers["x-stainless-lang"] === "python", false);
  assert.equal(upstream.headers["x-custom-client"], undefined);
  assert.notEqual(
    upstream.headers.authorization,
    `Bearer ${key}`,
    "the Carmel key must never reach the provider",
  );

  // The caller's tool definition is what the provider sees.
  assert.equal(upstream.body.tools[0].function.name, "get_weather");
  assert.deepEqual(upstream.body.tools[0].function.parameters, weatherTool.function.parameters);
  assert.equal(upstream.body.messages[0].content, "Be brief.");
});

test("tool calls stream back to the caller, and its tool results go upstream", async () => {
  provider.mode = "tool";
  const { key, modelId } = setupUserWithModel();

  const response = await chat(key, {
    model: `ollama/${modelId}`,
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "Weather in Paris?" }],
    tools: [weatherTool],
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const chunks = parseSse(await response.text());
  assert.equal(chunks.at(-1), "[DONE]");
  const events = chunks.slice(0, -1).map((chunk) => JSON.parse(chunk));
  const toolDeltas = events.flatMap((event: any) => event.choices[0]?.delta?.tool_calls ?? []);
  assert.equal(toolDeltas[0].id, "call_weather_1");
  assert.equal(toolDeltas[0].function.name, "get_weather");
  const argumentsText = toolDeltas.map((delta: any) => delta.function?.arguments ?? "").join("");
  assert.deepEqual(JSON.parse(argumentsText), { city: "Paris" });
  assert.ok(events.some((event: any) => event.choices[0]?.finish_reason === "tool_calls"));
  assert.ok(
    events.some((event: any) => event.usage?.total_tokens > 0),
    "include_usage adds a usage chunk",
  );

  // Carmel did not run the tool: the next turn is the caller's.
  provider.mode = "text";
  const followUp = await chat(key, {
    model: `ollama/${modelId}`,
    messages: [
      { role: "user", content: "Weather in Paris?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_weather_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_weather_1", content: "Sunny, 21C" },
    ],
    tools: [weatherTool],
  });
  assert.equal(followUp.status, 200);
  const upstreamMessages = provider.last!.body.messages as any[];
  const assistant = upstreamMessages.find((message) => message.role === "assistant");
  assert.equal(assistant.tool_calls[0].function.name, "get_weather");
  const toolResult = upstreamMessages.find((message) => message.role === "tool");
  assert.equal(toolResult.tool_call_id, assistant.tool_calls[0].id);
  assert.equal(toolResult.content, "Sunny, 21C");
});

test("a provider rejection is an HTTP error, not a 200 stream", async () => {
  provider.mode = "reject";
  const { key, modelId } = setupUserWithModel();
  const response = await chat(key, {
    model: `ollama/${modelId}`,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(response.status, 502);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /API key|401/i);
});

test("unsupported request shapes are rejected up front", async () => {
  const { key, modelId } = setupUserWithModel();
  const remoteImage = await chat(key, {
    model: `ollama/${modelId}`,
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "http://169.254.169.254/latest" } }],
      },
    ],
  });
  assert.equal(remoteImage.status, 400);
  const multiple = await chat(key, {
    model: `ollama/${modelId}`,
    n: 2,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(multiple.status, 400);
});

function chat(key: string, body: object, headers: Record<string, string> = {}) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { ...json, ...headers, authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

function setupUserWithModel() {
  const userId = createUser();
  const modelId = insertModel(userId, { shared: false });
  return { userId, modelId, key: createApiKey(userId, "test").key };
}

function insertModel(ownerUserId: string, options: { shared: boolean }) {
  const modelId = id("model");
  const timestamp = now();
  db.insert(modelRefs)
    .values({
      id: id("model_ref"),
      ownerUserId,
      shared: options.shared,
      label: "Fake",
      provider: "ollama",
      // Bound to no provider config would make it visible to everyone; the
      // visibility test needs an owner-scoped entry, so bind it to a dummy one.
      providerConfigId: "provider_config_test",
      modelId,
      api: "openai-completions",
      baseUrl: `${provider.url}/v1`,
      input: ["text"],
      reasoning: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return modelId;
}

async function createLoginUser() {
  const userId = createUser();
  const username = `user_${userId}`;
  db.update(users)
    .set({ username, passwordHash: await hashPassword("password123") })
    .where(eq(users.id, userId))
    .run();
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ username, password: "password123" }),
  });
  assert.equal(login.status, 200);
  return { userId, cookie: (login.headers.get("set-cookie") ?? "").split(";")[0]! };
}

function parseSse(text: string) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

async function startFakeProvider() {
  const state: { mode: ProviderMode; last?: Upstream } = { mode: "text" };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    state.last = { headers: request.headers, body: JSON.parse(raw) };

    if (state.mode === "reject") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Incorrect API key provided.", type: "invalid_request_error" },
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "chatcmpl-up", object: "chat.completion.chunk", created: 0, model: "fake" };
    const write = (delta: object, finishReason: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      );
    if (state.mode === "tool") {
      write({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_weather_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      });
      write({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] });
      write({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] });
      write({}, "tool_calls");
    } else {
      write({ role: "assistant", content: "Hi " });
      write({ content: "there." });
      write({}, "stop");
    }
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get last() {
      return state.last;
    },
    set mode(mode: ProviderMode) {
      state.mode = mode;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
