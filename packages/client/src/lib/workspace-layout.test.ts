import test from "node:test";
import assert from "node:assert/strict";
import { workspaceChatPath, workspaceWidth } from "./workspace-layout.ts";

test("a saved workspace width respects both panes after the sidebar or window resizes", () => {
  assert.equal(workspaceWidth(1000, 0.55), 550);
  assert.equal(workspaceWidth(800, 0.9), 439);
  assert.equal(workspaceWidth(800, 0.1), 360);
  assert.equal(workspaceWidth(721, 0.55), 360);
  assert.equal(workspaceWidth(1000, Number.NaN), 550);
});

test("workspace navigation preserves a diff's area and replaces its companion conversation", () => {
  assert.equal(
    workspaceChatPath("/agents/a/changes/src/main.ts?area=staged&chat=old", "new-session"),
    "/agents/a/changes/src/main.ts?area=staged&chat=new-session",
  );
  assert.equal(
    workspaceChatPath("/agents/a/files/a%20b%23.md"),
    "/agents/a/files/a%20b%23.md?chat=new",
  );
});
