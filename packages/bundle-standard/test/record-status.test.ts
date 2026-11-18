import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { createRipstream } from "../src/index.ts";
import { createStandardIsolation } from "../src/isolation.ts";

/** tikajs-efpm: every `parseRecursive` record says `status` (ok, skipped, failed) and `reason`, in process and through a child. */

const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 4 });
const standard = await createStandardIsolation({ config: { mode: "strict" }, pool });
after(async () => {
  await standard.isolator.dispose();
  pool.dispose();
});

/** A ZIP of stored entries, one per name. */
function zip(entries: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const data = Buffer.from(bytes);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ARCHIVE = zip([
  ["a.txt", bytes("hello")],
  ["b.bin", Uint8Array.from([0, 1, 2, 3, 250, 251, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8])],
  ["c.pdf", bytes("%PDF-1.4 not a pdf")],
]);
const EXPECTED = [
  ["/t.zip", "ok", undefined],
  ["/t.zip/a.txt", "ok", undefined],
  ["/t.zip/b.bin", "skipped", "no-parser"],
  ["/t.zip/c.pdf", "failed", "MALFORMED_DOCUMENT"],
] as const;

for (const [arm, ripstream] of [
  ["in-process", createRipstream()],
  ["child", standard.ripstream],
] as const) {
  test(`${arm}: each record of an archive says ok, skipped (no parser) or failed (the error code)`, async () => {
    const records = await ripstream.parseRecursive(ARCHIVE, { filename: "t.zip" });
    assert.deepEqual(
      records.map((record) => [record.embeddedResourcePath, record.status, record.reason]),
      EXPECTED.map((row) => [...row]),
    );
    assert.equal(records[3]?.exception?.name, "MalformedDocumentError", "the exception is still there");
  });
}
