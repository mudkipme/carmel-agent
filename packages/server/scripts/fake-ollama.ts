import { createServer } from "node:http";

const port = Number(process.env.CARMEL_FAKE_PROVIDER_PORT ?? 11435);
const words = ["Fixture", " reply", " streamed", " token", " by", " token."];

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/tags") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [{ name: "carmel-fixture" }] }));
    return;
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const base = { id: "chatcmpl-carmel-fixture", object: "chat.completion.chunk", created: 0, model: "carmel-fixture" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
    let index = 0;
    const timer = setInterval(() => {
      if (index < words.length) {
        response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: words[index++] }, finish_reason: null }] })}\n\n`);
        return;
      }
      clearInterval(timer);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, 80);
    response.on("close", () => clearInterval(timer));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Fixture endpoint not found." }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Fake Ollama fixture listening on http://127.0.0.1:${port}`);
});
