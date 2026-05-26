import { registerToolRenderer, renderCollapsibleHeader, type ToolRenderer, type ToolRenderResult } from "@earendil-works/pi-web-ui";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code } from "lucide";

const SUMMARY_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
  "exa_search",
  "fetch_url",
  "javascript_repl",
  "extract_document",
];
const MAX_SUMMARY_CHARS = 2_000;

let registered = false;

export function ensureToolSummaryRenderer() {
  if (registered) return;
  registered = true;
  for (const toolName of SUMMARY_TOOL_NAMES) {
    registerToolRenderer(toolName, new SummaryToolRenderer(toolName));
  }
}

class SummaryToolRenderer implements ToolRenderer {
  constructor(private readonly toolName: string) {}

  render(params: unknown, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
    const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
    const contentRef = createRef<HTMLElement>();
    const chevronRef = createRef<HTMLElement>();

    return {
      content: html`
        <div class="space-y-2">
          ${renderCollapsibleHeader(state, Code, `Tool Call: ${this.toolName}`, contentRef, chevronRef, false)}
          <div class="max-h-0 overflow-hidden transition-all duration-200" ${ref(contentRef)}>
            <div class="space-y-3">
              <div>
                <div class="mb-1 text-xs font-medium text-muted-foreground">Input</div>
                <code-block .code=${formatSummary(params)} language="json"></code-block>
              </div>
              <div>
                <div class="mb-1 text-xs font-medium text-muted-foreground">Output</div>
                ${
                  result
                    ? html`<code-block
                        .code=${formatToolResult(result)}
                        language=${resultOutputLanguage(result)}
                      ></code-block>`
                    : html`<div class="text-xs text-muted-foreground">(no result)</div>`
                }
              </div>
            </div>
          </div>
        </div>
      `,
      isCustom: false,
    };
  }
}

function formatToolResult(result: ToolResultMessage) {
  const text = result.content
    ?.map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image") return `[Image output: ${part.mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return summarizeString(text || "(no output)");
}

function resultOutputLanguage(result: ToolResultMessage) {
  const text = result.content?.find((part) => part.type === "text")?.text;
  if (!text) return "text";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "text";
  }
}

function formatSummary(value: unknown) {
  if (typeof value === "undefined") return "{}";
  try {
    return summarizeString(JSON.stringify(value, null, 2));
  } catch {
    return summarizeString(String(value));
  }
}

function summarizeString(text: string) {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS)}\n\n[Truncated ${text.length - MAX_SUMMARY_CHARS} characters for display]`;
}
