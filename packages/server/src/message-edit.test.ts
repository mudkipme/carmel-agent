import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { updateUserMessageContent } from "@carmel-agent/shared";

function userWithImages(): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "image", data: "BBB", mimeType: "image/jpeg" },
    ],
    timestamp: 1,
  } as unknown as AgentMessage;
}

test("updateUserMessageContent preserves images when no removals are given", () => {
  const edited = updateUserMessageContent(userWithImages(), "updated") as unknown as {
    content: Array<{ type: string; text?: string; data?: string }>;
  };
  assert.equal(edited.content[0].text, "updated");
  assert.deepEqual(
    edited.content.filter((part) => part.type === "image").map((part) => part.data),
    ["AAA", "BBB"],
  );
});

test("updateUserMessageContent drops the image at the given index (positioned among image parts)", () => {
  const edited = updateUserMessageContent(userWithImages(), "updated", {
    removedImageIndexes: [0],
  }) as unknown as { content: Array<{ type: string; text?: string; data?: string }> };

  assert.equal(edited.content[0].text, "updated");
  const images = edited.content.filter((part) => part.type === "image");
  assert.deepEqual(images.map((part) => part.data), ["BBB"]);
});

test("updateUserMessageContent can drop every image, leaving only text", () => {
  const edited = updateUserMessageContent(userWithImages(), "updated", {
    removedImageIndexes: [0, 1],
  }) as unknown as { content: Array<{ type: string }> };

  assert.equal(edited.content.length, 1);
  assert.equal(edited.content[0].type, "text");
});

test("updateUserMessageContent prunes legacy attachments by id", () => {
  const message = {
    role: "user-with-attachments",
    content: [{ type: "text", text: "hi" }],
    attachments: [
      { id: "a", type: "image", fileName: "a.png", mimeType: "image/png", size: 1 },
      { id: "b", type: "image", fileName: "b.png", mimeType: "image/png", size: 1 },
    ],
    timestamp: 1,
  } as unknown as AgentMessage;

  const edited = updateUserMessageContent(message, "hi", { removedAttachmentIds: ["a"] }) as unknown as {
    attachments: Array<{ id: string }>;
  };
  assert.deepEqual(edited.attachments.map((attachment) => attachment.id), ["b"]);
});

test("updateUserMessageContent ignores removals on non-user messages", () => {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "reply" }],
    timestamp: 1,
  } as unknown as AgentMessage;
  assert.strictEqual(updateUserMessageContent(assistant, "changed", { removedImageIndexes: [0] }), assistant);
});
