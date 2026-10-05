import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { withAbortSignal } from "../../effectors/pi-durable/index.ts";
import { TEST_CONTEXT } from "../../effectors/testing/pi-harness.ts";
import { networkToolProvider } from "./network.ts";
import { extractArticleMarkdown, looksLikeHtml } from "./web-markdown.ts";

const ARTICLE_HTML = `<!doctype html>
<html><head>
  <title>Use the saw</title>
  <meta name="author" content="Steph Ango">
</head><body>
  <nav><a href="/">Home</a> <a href="/archive">Archive</a></nav>
  <article>
    <h1>Use the saw</h1>
    <p>Powerful tools can do powerful things, and the machine wants to cut fingers,
       which is why the first lesson is always about where the hands go.</p>
    <h2>On limbs</h2>
    <p>Your desire to have limbs and your desire to have furniture are not at odds
       if you take the time to learn how to use the tools safely.</p>
    <p>There are table saws that will stop at the touch of a finger, but there is no
       chainsaw that will refuse an arm, and there is a limit to how safe a tool can
       be made before its function is crippled beyond the point of being useful. We
       should not stop making powerful tools because they are dangerous; we should
       instead give people what they need to use powerful tools safely.</p>
  </article>
  <footer>Copyright 2026 — subscribe to the newsletter</footer>
</body></html>`;

test("extractArticleMarkdown converts the main content and drops the chrome", async () => {
  const article = await extractArticleMarkdown(ARTICLE_HTML, "https://example.com/saw");

  assert.ok(article);
  assert.equal(article.title, "Use the saw");
  assert.equal(article.author, "Steph Ango");
  assert.match(article.markdown, /## On limbs/);
  assert.match(article.markdown, /the machine wants to cut fingers/);
  assert.doesNotMatch(article.markdown, /Archive/);
  assert.doesNotMatch(article.markdown, /subscribe to the newsletter/);
});

test("extractArticleMarkdown returns undefined when there is no content to extract", async () => {
  const empty = await extractArticleMarkdown(
    "<!doctype html><html><head><title>Nothing</title></head><body></body></html>",
    "https://example.com/empty",
  );

  assert.equal(empty, undefined);
});

test("looksLikeHtml trusts the content type, and sniffs the body when there is none", () => {
  assert.equal(looksLikeHtml("text/html; charset=utf-8", ""), true);
  assert.equal(looksLikeHtml("application/xhtml+xml", ""), true);
  assert.equal(looksLikeHtml("application/json", "<!doctype html><html>"), false);
  assert.equal(looksLikeHtml("text/plain", "<html>"), false);
  assert.equal(looksLikeHtml(null, "  <!DOCTYPE html>\n<html>"), true);
  assert.equal(looksLikeHtml(null, "# A markdown file\n"), false);
});

test("fetch_url extracts markdown from HTML without any API key", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(ARTICLE_HTML);
    },
    async (baseUrl) => {
      const result = await runFetchUrl({ url: baseUrl });

      assert.match(result.text, /## On limbs/);
      assert.doesNotMatch(result.text, /subscribe to the newsletter/);
      assert.equal(result.details.extracted, true);
      assert.equal(result.details.title, "Use the saw");
      assert.equal(result.details.truncated, false);
    },
  );
});

test("fetch_url returns the raw body for non-HTML responses", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    },
    async (baseUrl) => {
      const result = await runFetchUrl({ url: baseUrl });

      assert.equal(result.text, '{"ok":true}');
      assert.equal(result.details.extracted, false);
    },
  );
});

test("fetch_url returns the raw body when html or text is asked for", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(ARTICLE_HTML);
    },
    async (baseUrl) => {
      const result = await runFetchUrl({ url: baseUrl, format: "html" });

      assert.match(result.text, /<nav>/);
      assert.equal(result.details.extracted, false);
    },
  );
});

test("fetch_url truncates extracted markdown to maxCharacters", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(ARTICLE_HTML);
    },
    async (baseUrl) => {
      const result = await runFetchUrl({ url: baseUrl, maxCharacters: 500 });

      assert.equal(result.text.length, 500);
      assert.equal(result.details.truncated, true);
    },
  );
});

test("fetch_url surfaces a failing status as an error", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("upstream is down");
    },
    async (baseUrl) => {
      await assert.rejects(() => runFetchUrl({ url: baseUrl }), /Fetch failed with 503/);
    },
  );
});

async function runFetchUrl(params: Record<string, unknown>) {
  const tool = networkToolProvider
    .provide(undefined as never)
    .map((provided) => provided.tool)
    .find((candidate) => candidate.name === "fetch_url");
  assert.ok(tool);

  const context = withAbortSignal(new AbortController().signal, TEST_CONTEXT);
  const result = (await (tool.execute as (...args: unknown[]) => unknown)(
    "call_1",
    params,
    () => {},
    undefined,
    { invocationId: "inv_1", operationId: "op_1", turnId: "turn_1" },
    context,
  )) as { content: Array<{ text: string }>; details: Record<string, unknown> };

  return { text: result.content[0]!.text, details: result.details };
}

async function withServer(
  handler: Parameters<typeof createServer>[1],
  run: (baseUrl: string) => Promise<void>,
) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}/article`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
