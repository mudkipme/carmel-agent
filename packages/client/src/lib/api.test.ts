import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { api, ApiError, apiFetch } from "./api.ts";

test("API requests preserve every HeadersInit form and include credentials", async (t) => {
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push(init);
    return Response.json({ ok: true });
  });

  for (const headers of [
    { "x-request-id": "request-1" },
    new Headers({ "x-request-id": "request-1" }),
    [["x-request-id", "request-1"]] as [string, string][],
  ]) {
    await apiFetch("/api/example", { headers });
  }
  await apiFetch("/api/example", { headers: new Headers({ "Content-Type": "text/plain" }) });

  for (const request of requests.slice(0, 3)) {
    const headers = new Headers(request.headers);
    assert.equal(headers.get("x-request-id"), "request-1");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(request.credentials, "include");
  }
  assert.equal(new Headers(requests[3].headers).get("content-type"), "text/plain");
});

test("a malformed successful upload response rejects instead of leaving the upload pending", async (t) => {
  const xhr = mockUpload(t);
  const upload = api.uploadAgentFile("agent-1", "example.txt", new Blob(["content"]));
  const rejected = assert.rejects(upload, SyntaxError);
  xhr.responseText = "invalid json";
  xhr.dispatchEvent(new Event("load"));
  xhr.dispatchEvent(new Event("loadend"));
  await rejected;
});

test("an already cancelled upload never sends its file", async (t) => {
  const xhr = mockUpload(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    api.uploadAgentFile("agent-1", "example.txt", new Blob(["content"]), {
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof ApiError && error.message === "Upload cancelled",
  );
  assert.equal(xhr.sent, false);
});

test("finishing an upload releases its cancellation listener", async (t) => {
  const xhr = mockUpload(t);
  const controller = new AbortController();
  const upload = api.uploadAgentFile("agent-1", "example.txt", new Blob(["content"]), {
    signal: controller.signal,
  });
  xhr.responseText = JSON.stringify({ path: "example.txt", type: "file" });
  xhr.dispatchEvent(new Event("load"));
  xhr.dispatchEvent(new Event("loadend"));
  assert.equal((await upload).path, "example.txt");
  controller.abort();
  assert.equal(xhr.aborted, false);
});

function mockUpload(t: TestContext) {
  const xhr = new UploadTransport();
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class {
    constructor() {
      return xhr;
    }
  } as unknown as typeof XMLHttpRequest;
  t.after(() => {
    if (original) globalThis.XMLHttpRequest = original;
    else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  });
  return xhr;
}

class UploadTransport extends EventTarget {
  upload = new EventTarget();
  status = 200;
  responseText = "";
  sent = false;
  aborted = false;
  open() {}
  setRequestHeader() {}
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
    this.dispatchEvent(new Event("loadend"));
  }
}
