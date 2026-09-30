import type { AgentHarnessTool, ExecutionToolContext } from "@earendil-works/pi-agent-core";
import type { ProvidedTool, ToolProvider } from "../../effectors/contracts/tool-provider.ts";
import { extractArticleMarkdown, looksLikeHtml } from "./web-markdown.ts";

type ServerToolDefinition = AgentHarnessTool<ExecutionToolContext>;

/** Identifies us without tripping the servers that 403 unfamiliar agents. */
const USER_AGENT = "Mozilla/5.0 (compatible; CarmelAgent/0.1)";

/**
 * Web search and fetch.
 *
 * `fetch_url` is self-contained: it makes one HTTP request and extracts the
 * readable content locally, so it works the same with or without any API key.
 * `exa_search` is the one built-in that talks to a third party, which is why it
 * is the one whose absence is a configuration answer (`EXA_API_KEY`) rather
 * than a bug.
 */
export const networkToolProvider: ToolProvider = {
  id: "carmel.network",
  label: "Web search and fetch",
  provide(): ProvidedTool[] {
    return createNetworkToolDefinitions().map((tool) => ({
      providerId: networkToolProvider.id,
      requires: "network",
      tool,
    }));
  },
};

function createNetworkToolDefinitions(): ServerToolDefinition[] {
  return [
    {
      name: "exa_search",
      label: "Exa Search",
      description:
        "Search the web with Exa. Use this when current external information, documentation, sources, or web discovery is needed.",
      parameters: exaSearchSchema as never,
      executionMode: "parallel",
      execute: async (_toolCallId, params, _onUpdate, _toolContext, _invocation, context) => {
        const signal = context.abortSignal;
        const args = parseRecord(params);
        const query = requireString(args.query, "query");
        const numResults = clampNumber(args.numResults, 1, 10, 5);
        const includeText = args.includeText === true;
        const maxCharacters = clampNumber(args.maxCharacters, 500, 12000, 3000);
        const apiKey = getExaApiKey();

        const response = await fetch("https://api.exa.ai/search", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            query,
            numResults,
            contents: includeText
              ? { text: { maxCharacters }, highlights: true }
              : { highlights: true },
          }),
          signal,
        });
        const data = await readJsonResponse(response, "Exa search failed");
        return {
          content: [{ type: "text", text: formatExaSearchResults(data) }],
          details: data,
        };
      },
    },
    {
      name: "fetch_url",
      label: "Fetch URL",
      description:
        "Fetch a URL. The default markdown format strips navigation, ads, and boilerplate and returns the page's main content; html/text return the response body as sent.",
      parameters: fetchUrlSchema as never,
      executionMode: "parallel",
      execute: async (_toolCallId, params, _onUpdate, _toolContext, _invocation, context) => {
        const signal = context.abortSignal;
        const args = parseRecord(params);
        const url = requireString(args.url, "url");
        const format = args.format === "html" || args.format === "text" ? args.format : "markdown";
        const maxCharacters = clampNumber(args.maxCharacters, 500, 30000, 12000);

        const response = await fetch(url, {
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal,
        });
        if (!response.ok) throw new Error(`Fetch failed with ${response.status}: ${await response.text()}`);

        const contentType = response.headers.get("content-type");
        const body = await response.text();
        const details = {
          url: response.url || url,
          status: response.status,
          contentType,
          format,
        };

        if (format === "markdown" && looksLikeHtml(contentType, body)) {
          // An empty extraction means the page had no article-shaped content
          // (a search page, an app shell). Returning the raw body beats
          // returning nothing, so fall through rather than fail.
          const article = await extractArticleMarkdown(body, details.url, signal);
          if (article) {
            const { text, truncated } = truncate(article.markdown, maxCharacters);
            return {
              content: [{ type: "text", text }],
              details: {
                ...details,
                extracted: true,
                title: article.title,
                author: article.author,
                published: article.published,
                site: article.site,
                wordCount: article.wordCount,
                extractorType: article.extractorType,
                truncated,
              },
            };
          }
        }

        const { text, truncated } = truncate(body, maxCharacters);
        return {
          content: [{ type: "text", text }],
          details: { ...details, extracted: false, truncated },
        };
      },
    },
  ];
}

function truncate(text: string, maxCharacters: number) {
  return text.length > maxCharacters
    ? { text: text.slice(0, maxCharacters), truncated: true }
    : { text, truncated: false };
}

function getExaApiKey() {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    throw new Error("EXA_API_KEY is required for exa_search.");
  }
  return apiKey;
}

async function readJsonResponse(response: Response, fallbackMessage: string) {
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "error" in data && typeof data.error === "string"
        ? data.error
        : text || fallbackMessage;
    throw new Error(`${fallbackMessage}: ${message}`);
  }
  return data;
}

function formatExaSearchResults(data: unknown) {
  const results = getResults(data);
  if (results.length === 0) return "No search results.";
  return results
    .map((result, index) => {
      const title = stringify(result.title) || "Untitled";
      const url = stringify(result.url);
      const publishedDate = stringify(result.publishedDate);
      const author = stringify(result.author);
      const highlights = Array.isArray(result.highlights)
        ? result.highlights.map(stringify).filter(Boolean)
        : [];
      const text = stringify(result.text);
      return [
        `${index + 1}. ${title}`,
        url ? `URL: ${url}` : "",
        publishedDate ? `Published: ${publishedDate}` : "",
        author ? `Author: ${author}` : "",
        highlights.length > 0 ? `Highlights:\n${highlights.map((highlight) => `- ${highlight}`).join("\n")}` : "",
        text ? `Text:\n${text}` : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function getResults(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object" || !("results" in data) || !Array.isArray(data.results)) return [];
  return data.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function requireString(value: unknown, name: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function stringify(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

const exaSearchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query." },
    numResults: { type: "number", description: "Number of results to return. Defaults to 5, maximum 10." },
    includeText: { type: "boolean", description: "Whether to include page text snippets in addition to highlights." },
    maxCharacters: { type: "number", description: "Maximum text characters per result when includeText is true." },
  },
  required: ["query"],
  additionalProperties: false,
};

const fetchUrlSchema = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch." },
    format: {
      type: "string",
      enum: ["markdown", "html", "text"],
      description:
        "markdown (default) extracts the page's main content; html/text return the raw response body.",
    },
    maxCharacters: { type: "number", description: "Maximum characters to return. Defaults to 12000." },
  },
  required: ["url"],
  additionalProperties: false,
};
