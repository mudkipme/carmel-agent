import { Readable } from "node:stream";
import { createDeflateRaw } from "node:zlib";

/**
 * Minimal streaming ZIP writer, enough for "download this folder" without
 * pulling in an archive dependency. Entries are deflated as they are read and
 * their sizes land in a trailing data descriptor, so nothing is buffered: a
 * multi-gigabyte workspace streams straight to the browser.
 *
 * Zip64 is not implemented — a single entry or archive above 4 GiB throws, and
 * callers are expected to reject oversized selections before streaming starts.
 */
export type ZipEntry = {
  /** Path inside the archive, always "/"-separated. */
  name: string;
  mtimeMs: number;
  /** Omitted for directory entries. */
  open?: () => AsyncIterable<Uint8Array>;
};

const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_NAMES = 0x0800;
const SIZES_IN_DATA_DESCRIPTOR = 0x0008;
const DEFLATED = 8;
const STORED = 0;
const MAX_UINT32 = 0xffffffff;

type CentralEntry = {
  name: Uint8Array;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  headerOffset: number;
  directory: boolean;
};

export async function* zipArchive(entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  const central: CentralEntry[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const directory = !entry.open;
    const name = encoder.encode(directory ? `${entry.name.replace(/\/+$/, "")}/` : entry.name);
    const { date, time } = dosDateTime(entry.mtimeMs);
    const flags = UTF8_NAMES | (directory ? 0 : SIZES_IN_DATA_DESCRIPTOR);
    const method = directory ? STORED : DEFLATED;
    const headerOffset = offset;

    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, LOCAL_FILE_HEADER, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, flags, true);
    headerView.setUint16(8, method, true);
    headerView.setUint16(10, time, true);
    headerView.setUint16(12, date, true);
    // CRC and both sizes stay zero here; the data descriptor carries them.
    headerView.setUint16(26, name.length, true);
    header.set(name, 30);
    yield header;
    offset += header.length;

    let crc = 0;
    let uncompressedSize = 0;
    let compressedSize = 0;
    if (entry.open) {
      let running = 0xffffffff;
      const counted = async function* () {
        for await (const chunk of entry.open!()) {
          const bytes = toBytes(chunk);
          running = crc32(bytes, running);
          uncompressedSize += bytes.length;
          yield bytes;
        }
      };
      for await (const chunk of Readable.from(counted()).pipe(createDeflateRaw())) {
        const bytes = toBytes(chunk);
        compressedSize += bytes.length;
        yield bytes;
      }
      crc = (running ^ 0xffffffff) >>> 0;
      assertRepresentable(entry.name, uncompressedSize, compressedSize, headerOffset);

      const descriptor = new Uint8Array(16);
      const descriptorView = new DataView(descriptor.buffer);
      descriptorView.setUint32(0, DATA_DESCRIPTOR, true);
      descriptorView.setUint32(4, crc, true);
      descriptorView.setUint32(8, compressedSize, true);
      descriptorView.setUint32(12, uncompressedSize, true);
      yield descriptor;
      offset += compressedSize + descriptor.length;
    }

    central.push({ name, flags, method, time, date, crc, compressedSize, uncompressedSize, headerOffset, directory });
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const entry of central) {
    const record = new Uint8Array(46 + entry.name.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, CENTRAL_FILE_HEADER, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, entry.flags, true);
    view.setUint16(10, entry.method, true);
    view.setUint16(12, entry.time, true);
    view.setUint16(14, entry.date, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.compressedSize, true);
    view.setUint32(24, entry.uncompressedSize, true);
    view.setUint16(28, entry.name.length, true);
    // External attributes carry the MS-DOS directory bit so extractors that
    // ignore the trailing slash still create folders.
    view.setUint32(38, entry.directory ? 0x10 : 0, true);
    view.setUint32(42, entry.headerOffset, true);
    record.set(entry.name, 46);
    yield record;
    directorySize += record.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  endView.setUint16(8, central.length, true);
  endView.setUint16(10, central.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, directoryOffset, true);
  yield end;
}

let crcTable: Uint32Array | undefined;

/** Running CRC-32; seed with `0xffffffff` and finish with `^ 0xffffffff`. */
export function crc32(bytes: Uint8Array, running: number) {
  crcTable ??= buildCrcTable();
  let crc = running;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function toBytes(chunk: Uint8Array | string) {
  return typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function assertRepresentable(name: string, uncompressedSize: number, compressedSize: number, offset: number) {
  if (uncompressedSize > MAX_UINT32 || compressedSize > MAX_UINT32 || offset > MAX_UINT32) {
    throw new Error(`File is too large to archive: ${name}`);
  }
}

function dosDateTime(mtimeMs: number) {
  const stamp = new Date(Number.isFinite(mtimeMs) ? mtimeMs : Date.now());
  // The DOS epoch starts in 1980 and cannot express anything earlier.
  const year = Math.max(stamp.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((stamp.getMonth() + 1) << 5) | stamp.getDate(),
    time: (stamp.getHours() << 11) | (stamp.getMinutes() << 5) | (stamp.getSeconds() >> 1),
  };
}
