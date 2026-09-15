import test from "node:test";
import assert from "node:assert/strict";
import { agentFilesPath, workspaceFileFromHref } from "./file-links.ts";

test("relative hrefs resolve to workspace files", () => {
  assert.equal(workspaceFileFromHref("post/love-live.md"), "post/love-live.md");
  assert.equal(workspaceFileFromHref("./post/love-live.md"), "post/love-live.md");
  assert.equal(workspaceFileFromHref("post/drafts/../love-live.md"), "post/love-live.md");
  assert.equal(workspaceFileFromHref("post/love%20live.md#intro"), "post/love live.md");
  assert.equal(workspaceFileFromHref("README.md?plain=1"), "README.md");
});

test("other hrefs stay ordinary links", () => {
  for (const href of [
    undefined,
    "",
    "https://example.com/post.md",
    "mailto:someone@example.com",
    "//example.com/post.md",
    "/post/love-live.md",
    "#section",
    "?query",
    "../outside.md",
    "post/../../outside.md",
    "./",
    "bad%E0%A4%A.md",
  ]) {
    assert.equal(workspaceFileFromHref(href), undefined, String(href));
  }
});

test("file page paths encode each segment", () => {
  assert.equal(agentFilesPath("agent_1"), "/agents/agent_1/files");
  assert.equal(agentFilesPath("agent_1", "post/love live#1.md"), "/agents/agent_1/files/post/love%20live%231.md");
});
