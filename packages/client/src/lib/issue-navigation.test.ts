import assert from "node:assert/strict";
import { test } from "node:test";
import { issueListSearch, readIssueFilter } from "./issue-navigation.ts";

test("issue links carry only valid list context and safely encode the search", () => {
  const params = new URLSearchParams({
    filter: "attention",
    q: "tools & docs",
    unrelated: "secret",
  });
  assert.equal(issueListSearch(params), "?filter=attention&q=tools+%26+docs");
  assert.equal(readIssueFilter(new URLSearchParams("filter=invalid")), "queue");
  assert.equal(issueListSearch(new URLSearchParams("filter=invalid")), "");
});
