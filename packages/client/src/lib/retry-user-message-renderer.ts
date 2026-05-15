import { registerMessageRenderer } from "@earendil-works/pi-web-ui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Pencil, RotateCcw } from "lucide";

export const RETRY_USER_MESSAGE_EVENT = "carmel-retry-user-message";
export const EDIT_USER_MESSAGE_EVENT = "carmel-edit-user-message";

let registered = false;

export function ensureRetryUserMessageRenderer() {
  if (registered) return;
  registered = true;

  registerMessageRenderer("user", { render: renderEditableUserMessage });
  registerMessageRenderer("user-with-attachments" as AgentMessage["role"], {
    render: renderEditableUserMessage,
  });
}

function renderEditableUserMessage(message: AgentMessage) {
  return html`
    <div class="group">
      <user-message .message=${message}></user-message>
      <div class="mx-4 mt-0.5 flex h-5 items-center gap-1">
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
