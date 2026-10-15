import assert from "node:assert/strict";
import test from "node:test";
import { createImTransport, larkIncoming, splitImText, telegramIncoming } from "./platform.ts";

test("Telegram accepts only human private messages and selects the best photo rendition", () => {
  const update = {
    update_id: 20,
    message: {
      message_id: 4,
      chat: { id: 123, type: "private" },
      from: { id: 123, is_bot: false },
      caption: "Inspect this",
      photo: [{ file_id: "small" }, { file_id: "large" }],
    },
  };
  assert.deepEqual(telegramIncoming(update), {
    eventId: "20",
    senderId: "123",
    chatId: "123",
    text: "Inspect this",
    imageKeys: ["large"],
    messageId: "4",
  });
  assert.equal(
    telegramIncoming({
      ...update,
      message: { ...update.message, chat: { id: -1, type: "group" } },
    }),
    undefined,
  );
  assert.equal(
    telegramIncoming({ ...update, message: { ...update.message, from: { id: 9, is_bot: true } } }),
    undefined,
  );
});
test("Feishu/Lark trusts event sender IDs only for p2p user messages and leaves image retrieval until authorization", () => {
  const data = {
    sender: { sender_type: "user", sender_id: { open_id: "human" } },
    message: {
      message_id: "message",
      chat_id: "chat",
      chat_type: "p2p",
      message_type: "image",
      content: JSON.stringify({ image_key: "image" }),
    },
  };
  assert.deepEqual(larkIncoming(data), {
    eventId: "message",
    senderId: "human",
    chatId: "chat",
    text: "",
    imageKeys: ["image"],
    messageId: "message",
  });
  assert.equal(
    larkIncoming({ ...data, sender: { ...data.sender, sender_type: "app" } }),
    undefined,
  );
  assert.equal(
    larkIncoming({ ...data, message: { ...data.message, chat_type: "group" } }),
    undefined,
  );
  assert.equal(
    larkIncoming({ ...data, message: { ...data.message, content: "not json" } }),
    undefined,
  );
});
test("reply chunking preserves Unicode characters and all content", () => {
  const text = "a😀中文\n".repeat(2000);
  const parts = splitImText(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => Array.from(part).length <= 3500));
  assert.ok(parts.every((part) => part.length <= 3500));
  assert.ok(parts.every((part) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)));
});

test("Telegram commits its offset only after durable input admission and uses it for the next poll", async (t) => {
  const order: string[] = [];
  let polls = 0;
  let transport: ReturnType<typeof createImTransport>;
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    polls++;
    if (polls === 1) {
      assert.equal(body.offset, 0);
      return Response.json({
        ok: true,
        result: [
          {
            update_id: 5,
            message: {
              message_id: 1,
              chat: { id: 123, type: "private" },
              from: { id: 123 },
              text: "Hello",
            },
          },
        ],
      });
    }
    assert.equal(body.offset, 6);
    order.push("next-poll");
    transport.stop();
    return Response.json({ ok: true, result: [] });
  });
  transport = createImTransport({
    platform: "telegram",
    credential: { token: "123:unused" },
    offset: 0,
    async receive() {
      order.push("persisted");
    },
    checkpoint(offset) {
      assert.equal(offset, 6);
      order.push("checkpoint");
    },
    health() {},
  });
  await transport.start();
  assert.deepEqual(order, ["persisted", "checkpoint", "next-poll"]);
});

test("Feishu falls back to plain text after explicit card rejection, can edit it after restart, and hashes distinct chunk keys", async (t) => {
  const requests: Array<{ method: string; body: Record<string, any> }> = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("tenant_access_token/internal"))
      return Response.json({ code: 0, tenant_access_token: "private_token", expire: 7200 });
    const body = JSON.parse(String(init?.body));
    requests.push({ method: init?.method ?? "GET", body });
    if (body.msg_type === "interactive") return Response.json({ code: 230099 });
    return Response.json({ code: 0, data: { message_id: "message-1" } });
  });
  const create = () =>
    createImTransport({
      platform: "feishu",
      credential: { appId: "app", appSecret: "secret" },
      offset: 0,
      async receive() {},
      checkpoint() {},
      health() {},
    });
  const first = create();
  const second = create();
  try {
    const key = "im_delivery_12345678-1234-1234-1234-123456789012";
    const sent = await first.send("chat", "Text", `${key}:1`);
    assert.equal(sent, "text:message-1");
    await second.send("chat", "Updated text", `${key}:1`, sent);
    assert.equal(requests.at(-1)!.method, "PUT");
    assert.equal(JSON.parse(requests.at(-1)!.body.content).text, "Updated text");
    await first.send("chat", "Another chunk", `${key}:10`);
    assert.notEqual(requests[0].body.uuid, requests.at(-1)!.body.uuid);
  } finally {
    first.stop();
    second.stop();
  }
});
