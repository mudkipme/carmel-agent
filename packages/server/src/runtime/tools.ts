import {
  createFindTool as createPiFindTool,
  createGrepTool as createPiGrepTool,
  createLsTool as createPiLsTool,
  type FindToolInput,
  type GrepToolInput,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import { agents } from "../db/schema.ts";
import { AgentExecutionEnv } from "./execution-env.ts";
import { createGrepOperations, createLsOperations } from "./search-operations.ts";
export { remapContainerPath } from "./execution-env.ts";

type AgentRecord = typeof agents.$inferSelect;
type ServerToolDefinition = AgentHarnessTool<ExecutionToolContext>;

export function createServerExecution(agent: AgentRecord) {
  const env = new AgentExecutionEnv(agent);
  return {
    env,
    toolContext: { env } satisfies ExecutionToolContext,
    tools: createServerToolDefinitions(agent, env),
  };
}

export function createServerToolDefinitions(agent: AgentRecord, env = new AgentExecutionEnv(agent)) {
  const tools: ServerToolDefinition[] = [];

  if (agent.permissions.read) {
    tools.push(
      createReadTool<ExecutionToolContext>(),
      createAuthorizedGrepTool(env),
      createAuthorizedFindTool(env),
      createPiLsTool(env.cwd, { operations: createLsOperations(env) }),
    );
  }
  if (agent.permissions.write) tools.push(createWriteTool<ExecutionToolContext>());
  if (agent.permissions.edit) tools.push(createEditTool<ExecutionToolContext>());
  if (agent.permissions.bash) tools.push(createBashTool<ExecutionToolContext>());
  if (agent.permissions.network) tools.push(...createNetworkToolDefinitions());

  return tools;
}

function createAuthorizedFindTool(env: AgentExecutionEnv): ServerToolDefinition {
  const tool = createPiFindTool(env.cwd);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as FindToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      return tool.execute(toolCallId, { ...args, path }, signal, onUpdate);
    },
  };
}

// GrepOperations protects metadata and context reads, but Pi still passes the
// original search path to its host rg process. Resolve it first so container
// mount aliases are remapped and rg never receives an unauthorized host path.
function createAuthorizedGrepTool(env: AgentExecutionEnv): ServerToolDefinition {
  const tool = createPiGrepTool(env.cwd, { operations: createGrepOperations(env) });
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params as GrepToolInput;
      const path = env.resolveAuthorizedPath(args.path || ".", "read");
      return tool.execute(toolCallId, { ...args, path }, signal, onUpdate);
    },
  };
}

function createNetworkToolDefinitions(): ServerToolDefinition[] {
  return [
    {
      name: "exa_search",
      label: "Exa Search",
      description:
        "Search the web with Exa. Use this when current external information, documentation, sources, or web discovery is needed.",
      parameters: exaSearchSchema as never,
      executionMode: "parallel",
      execute: async (_toolCallId, params, signal) => {
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
        "Fetch a URL as clean markdown/text through Exa Contents when available, or as raw HTML/text with direct fetch.",
      parameters: fetchUrlSchema as never,
      executionMode: "parallel",
      execute: async (_toolCallId, params, signal) => {
        const args = parseRecord(params);
        const url = requireString(args.url, "url");
        const format = args.format === "html" || args.format === "text" ? args.format : "markdown";
        const maxCharacters = clampNumber(args.maxCharacters, 500, 30000, 12000);

        if (format === "markdown") {
          const exaResult = await fetchUrlWithExa(url, maxCharacters, signal);
          if (exaResult) return exaResult;
        }

        const response = await fetch(url, {
          headers: { "user-agent": "CarmelAgent/0.1" },
          signal,
        });
        if (!response.ok) throw new Error(`Fetch failed with ${response.status}: ${await response.text()}`);
        const text = (await response.text()).slice(0, maxCharacters);
        return {
          content: [{ type: "text", text }],
          details: {
            url,
            status: response.status,
            contentType: response.headers.get("content-type"),
            format,
            truncated: text.length >= maxCharacters,
          },
        };
      },
    },
  ];
}

async function fetchUrlWithExa(url: string, maxCharacters: number, signal?: AbortSignal) {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) return undefined;

  const response = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      urls: [url],
      text: { maxCharacters },
    }),
    signal,
  });
  const data = await readJsonResponse(response, "Exa contents failed");
  const result = getResults(data)[0];
  const text = typeof result?.text === "string" ? result.text : "";
  if (!text) return undefined;
  return {
    content: [{ type: "text" as const, text }],
    details: data,
  };
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
      description: "Use markdown for Exa-cleaned text, html/text for direct fetch.",
    },
    maxCharacters: { type: "number", description: "Maximum characters to return. Defaults to 12000." },
  },
  required: ["url"],
  additionalProperties: false,
};
