import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHAT_FILE_SIZE, uploadChatFile } from "./chat-attachments.ts";
import { insertInlineReference } from "./composer-references.ts";

test("document uploads preserve bytes and put only a workspace path in the prompt", async () => {
  for (const name of ["notes.txt", "guide.md", "report.csv", "paper.pdf", "document.docx"]) {
    const bytes = new Uint8Array([0xff, 0x00, 0x61]);
    const file = new File([bytes], name);
    const reference = await uploadChatFile(file, async (path, uploaded) => {
      assert.equal(uploaded, file);
      assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), bytes);
      assert.match(path, /^uploads\/[0-9a-f-]+\//);
      assert.ok(path.endsWith(`/${name}`));
      return { path };
    });
    const prompt = insertInlineReference("Summarize", { start: 9, end: 9 }, reference).text;
    assert.equal(prompt, `Summarize @${reference.path} `);
  }
});

test("same-named uploads have distinct paths and spaced names use the existing mention convention", async () => {
  const file = new File(["contents are not in the prompt"], "report notes.md");
  const upload = async (path: string) => ({ path });
  const first = await uploadChatFile(file, upload);
  const second = await uploadChatFile(file, upload);
  assert.notEqual(first.path, second.path);
  assert.equal(
    insertInlineReference("", { start: 0, end: 0 }, first).text,
    `@${JSON.stringify(first.path)} `,
  );
});

test("invalid names and oversized files do not upload, and failed uploads do not return references", async () => {
  let uploads = 0;
  const upload = async (path: string) => {
    uploads++;
    return { path };
  };
  for (const name of ["", ".", "..", "../escape.txt", "folder\\file.txt", "bad\0.txt"]) {
    await assert.rejects(uploadChatFile(new File(["text"], name), upload), /filenames/);
  }
  await assert.rejects(
    uploadChatFile(new File([new Uint8Array(MAX_CHAT_FILE_SIZE + 1)], "large.txt"), upload),
    /20MB/,
  );
  assert.equal(uploads, 0);
  await assert.rejects(
    uploadChatFile(new File(["text"], "notes.md"), async () => {
      throw new Error("Upload failed");
    }),
    /Upload failed/,
  );
});
