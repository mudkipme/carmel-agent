import {
  AssistantMessage as AssistantMessageElement,
  registerMessageRenderer,
} from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Copy, Pencil, RotateCcw } from "lucide";

export const RETRY_USER_MESSAGE_EVENT = "carmel-retry-user-message";
export const EDIT_USER_MESSAGE_EVENT = "carmel-edit-user-message";

let registered = false;
let assistantRendererPatched = false;
const ASSISTANT_COPY_PATCHED = Symbol.for("carmel.assistant-copy-patched");

export function ensureRetryUserMessageRenderer() {
  if (registered) return;
  registered = true;

  registerMessageRenderer("user", { render: renderEditableUserMessage });
  registerMessageRenderer("user-with-attachments" as AgentMessage["role"], {
    render: renderEditableUserMessage,
  });
  patchAssistantMessageRenderer();
}

function renderEditableUserMessage(message: AgentMessage) {
  const copyText = getMessageMarkdownText(message);
  const skillBlock = parseSkillInvocation(copyText);

  return html`
    <div class="group">
      ${skillBlock ? renderSkillInvocationMessage(skillBlock) : html`<user-message .message=${message}></user-message>`}
      <div class="mx-4 mt-0.5 flex h-5 items-center gap-1">
        ${copyText ? renderCopyButton(message) : ""}
        <button
          type="button"
          class="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          title="Edit message"
          aria-label="Edit message"
          @click=${(event: MouseEvent) => dispatchEdit(event, message)}
        >
          ${icon(Pencil, "xs")}
        </button>
        <button
          type="button"
          class="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
          title="Retry from this message"
          aria-label="Retry from this message"
          @click=${(event: MouseEvent) => dispatchRetry(event, message)}
        >
          ${icon(RotateCcw, "xs")}
        </button>
      </div>
    </div>
  `;
}

function renderSkillInvocationMessage(skill: ParsedSkillInvocation) {
  return html`
    <div class="flex justify-start mx-4">
      <div class="user-message-container py-2 px-4 rounded-xl">
        <details>
          <summary class="cursor-pointer text-sm font-medium">Using skill: ${skill.name}</summary>
          <div class="mt-2 border-l pl-3 text-xs text-muted-foreground">
            <div class="truncate">${skill.location}</div>
            <markdown-block .content=${skill.body}></markdown-block>
          </div>
        </details>
        ${
          skill.prompt
            ? html`<div class="mt-3"><markdown-block .content=${skill.prompt}></markdown-block></div>`
            : ""
        }
      </div>
    </div>
  `;
}

function patchAssistantMessageRenderer() {
  if (assistantRendererPatched) return;
  assistantRendererPatched = true;
  const assistantMessagePrototype = AssistantMessageElement.prototype as AssistantMessageElement &
    Record<symbol, boolean | undefined>;
  if (assistantMessagePrototype[ASSISTANT_COPY_PATCHED]) return;
  assistantMessagePrototype[ASSISTANT_COPY_PATCHED] = true;

  const renderAssistantMessage = assistantMessagePrototype.render;
  assistantMessagePrototype.render = function renderAssistantMessageWithCopyButton() {
    const message = this.message as AssistantMessage;
    const copyText = getMessageMarkdownText(message);
    if (!copyText) return renderAssistantMessage.call(this);

    return html`
      <div class="group">
        ${renderAssistantMessage.call(this)}
        <div class="mx-4 mt-0.5 flex h-5 items-center gap-1">
          ${renderCopyButton(message)}
        </div>
      </div>
    `;
  };
}

function renderCopyButton(message: AgentMessage | AssistantMessage) {
  return html`
    <button
      type="button"
      class="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
      title="Copy message"
      aria-label="Copy message"
      @click=${(event: MouseEvent) => void copyMessage(event, message)}
    >
      ${icon(Copy, "xs")}
    </button>
  `;
}

function dispatchRetry(event: MouseEvent, message: AgentMessage) {
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  target.dispatchEvent(
    new CustomEvent(RETRY_USER_MESSAGE_EVENT, {
      detail: { message },
      bubbles: true,
      composed: true,
    }),
  );
}

async function copyMessage(event: MouseEvent, message: AgentMessage | AssistantMessage) {
  event.preventDefault();
  event.stopPropagation();

  const text = getMessageMarkdownText(message);
  if (!text) return;

  try {
    await writeClipboardText(text);
  } catch (error) {
    console.error("Failed to copy message", error);
  }
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.select();
  document.execCommand("copy");
  textArea.remove();
}

function getMessageMarkdownText(message: AgentMessage | AssistantMessage) {
  if (message.role === "assistant") {
    return message.content
      .filter(isTextContent)
      .map((part) => part.text)
      .join("\n\n")
      .trim();
  }

  if (message.role !== "user" && message.role !== "user-with-attachments") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(isTextContent)
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function isTextContent(content: TextContent | ImageContent | AssistantMessage["content"][number]): content is TextContent {
  return content.type === "text";
}

type ParsedSkillInvocation = {
  name: string;
  location: string;
  body: string;
  prompt?: string;
};

function parseSkillInvocation(text: string): ParsedSkillInvocation | undefined {
  const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
  if (!match) return undefined;
  return {
    name: match[1],
    location: match[2],
    body: match[3],
    prompt: match[4],
  };
}

function dispatchEdit(event: MouseEvent, message: AgentMessage) {
  event.preventDefault();
  event.stopPropagation();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  target.dispatchEvent(
    new CustomEvent(EDIT_USER_MESSAGE_EVENT, {
      detail: { message },
      bubbles: true,
      composed: true,
    }),
  );
}
