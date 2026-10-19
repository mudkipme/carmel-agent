import assert from "node:assert/strict";
import test from "node:test";
import {
  hasInlineReference,
  inlineReferenceToken,
  insertInlineReference,
} from "./composer-references.ts";

test("a file mention replaces the trigger in the middle of a draft and leaves the caret before its suffix", () => {
  assert.deepEqual(
    insertInlineReference(
      "Compare @ with yesterday.",
      { start: 8, end: 9 },
      { kind: "file", path: "docs/guide.md" },
    ),
    {
      text: "Compare @docs/guide.md with yesterday.",
      cursor: "Compare @docs/guide.md ".length,
    },
  );
});

test("a toolbar folder mention replaces the selected text and separates subsequent typing", () => {
  assert.deepEqual(
    insertInlineReference(
      "Inspect placeholder before editing.",
      { start: 8, end: 19 },
      { kind: "folder", path: "docs" },
    ),
    {
      text: "Inspect @docs/ before editing.",
      cursor: "Inspect @docs/ ".length,
    },
  );
  assert.deepEqual(
    insertInlineReference("Review ", { start: 7, end: 7 }, { kind: "folder", path: "." }),
    {
      text: "Review @./ ",
      cursor: "Review @./ ".length,
    },
  );
});

test("quoted paths remain complete references and caret offsets include their quotes", () => {
  const reference = { kind: "file" as const, path: 'docs/a "quoted" file.md' };
  const inserted = insertInlineReference("Review @", { start: 7, end: 8 }, reference);
  assert.equal(inserted.text, 'Review @"docs/a \\"quoted\\" file.md" ');
  assert.equal(inserted.cursor, inserted.text.length);
  assert.equal(hasInlineReference(inserted.text, reference), true);
  assert.equal(inlineReferenceToken({ kind: "folder", path: "my docs" }), '@"my docs/"');
});

test("reference removal distinguishes exact mentions from longer paths and keeps repeated mentions", () => {
  const reference = { kind: "file" as const, path: "docs/guide.md" };
  assert.equal(hasInlineReference("Review @docs/guide.md ", reference), true);
  assert.equal(hasInlineReference("Review @docs/guide.md.bak", reference), false);
  assert.equal(hasInlineReference("email@docs/guide.md", reference), false);
  assert.equal(hasInlineReference("@docs/guide.md.bak and @docs/guide.md", reference), true);
  assert.equal(hasInlineReference("Review docs/guide.md", reference), false);
  assert.equal(hasInlineReference("@docs/file.md", { kind: "folder", path: "docs" }), false);
});
