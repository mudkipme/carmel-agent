import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { zipArchive } from "./zip.ts";

test("zipArchive round-trips file contents and directory entries", async () => {
  const large = "x".repeat(100_000);
  const archive = await collect(
    zipArchive([
      { name: "docs/", mtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6) },
      {
        name: "docs/readme.md",
        mtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6),
        open: () => chunks("# hello", "\nworld"),
      },
      { name: "big.txt", mtimeMs: Date.now(), open: () => chunks(large) },
    ]),
  );

  const files = readArchive(archive);
  assert.deepEqual([...files.keys()], ["docs/", "docs/readme.md", "big.txt"]);
  assert.equal(files.get("docs/"), "");
  assert.equal(files.get("docs/readme.md"), "# hello\nworld");
  assert.equal(files.get("big.txt"), large);
});

test("zipArchive writes an empty but valid archive", async () => {
  const archive = await collect(zipArchive([]));

  assert.equal(archive.length, 22);
  assert.equal(readArchive(archive).size, 0);
});

async function collect(source: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const chunk of source) parts.push(chunk);
  return Buffer.concat(parts);
}

async function* chunks(...values: string[]) {
  for (const value of values) yield new TextEncoder().encode(value);
}

/**
 * Reads the archive the way an extractor does — through the central directory
 * — so the test fails if the offsets or sizes recorded there drift from the
 * streamed local headers.
 */
function readArchive(archive: Buffer) {
  const endOffset = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(endOffset, -1, "missing end of central directory");
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);

  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const headerOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    assert.equal(archive.readUInt32LE(headerOffset), 0x04034b50);
    const localNameLength = archive.readUInt16LE(headerOffset + 26);
    const localExtraLength = archive.readUInt16LE(headerOffset + 28);
    const dataStart = headerOffset + 30 + localNameLength + localExtraLength;
    const stored = archive.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? stored : inflateRawSync(stored);
    assert.equal(content.length, uncompressedSize, `${name}: size mismatch`);
    assert.equal(crc32Of(content), crc, `${name}: crc mismatch`);

    files.set(name, content.toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function crc32Of(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
