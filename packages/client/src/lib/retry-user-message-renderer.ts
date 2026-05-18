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

  return html`
    <div class="group">
      <user-message .message=${message}></user-message>
      <div class="mx-4 mt-0.5 flex h-5 items-center gap-1">
        <button
          type="button"
          class="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30 group-hover:opacity-100"
          title="Copy message"
          aria-label="Copy message"
          ?disabled=${!copyText}
          @click=${(event: MouseEvent) => void copyMessage(event, message)}
        >
          ${icon(Copy, "xs")}
        </button>
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

    return html`
      <div class="group">
        ${renderAssistantMessage.call(this)}
        <div class="mx-4 mt-0.5 flex h-5 items-center gap-1">
          <button
            type="button"
            class="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-30 group-hover:opacity-100"
            title="Copy message"
            aria-label="Copy message"
            ?disabled=${!copyText}
            @click=${(event: MouseEvent) => void copyMessage(event, message)}
          >
            ${icon(Copy, "xs")}
          </button>
        </div>
      </div>
    `;
  };
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
