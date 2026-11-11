import assert from "node:assert/strict";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { test } from "node:test";
import { pack } from "tar-stream";
import { createRipstream } from "../src/index.ts";

const encoder = new TextEncoder();
const ripstream = createRipstream();

function zip(entries: Array<{ name: string; data: string }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.data);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(centralOffset + centralSize + 22);
  let cursor = 0;
  for (const part of [...locals, ...centrals]) {
    result.set(part, cursor);
    cursor += part.length;
  }
  const end = new DataView(result.buffer, cursor, 22);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);
  return result;
}

test("extracts text from zip entries", async () => {
  const archive = zip([
    { name: "a.txt", data: "hello zip" },
    { name: "b.txt", data: "second entry" },
  ]);
  const text = await ripstream.parseToString(archive, { filename: "archive.zip" });
  assert.match(text, /hello zip/);
  assert.match(text, /second entry/);
});

test("extracts text from gzip", async () => {
  const compressed = new Uint8Array(gzipSync(encoder.encode("hello gzip")));
  const text = await ripstream.parseToString(compressed, { filename: "hello.txt.gz" });
  assert.match(text, /hello gzip/);
});

async function makeTar(entries: Array<{ name: string; data: string }>): Promise<Uint8Array> {
  const archive = pack();
  for (const entry of entries) {
    archive.entry({ name: entry.name }, encoder.encode(entry.data));
  }
  archive.finalize();

  const chunks: Uint8Array[] = [];
  for await (const chunk of archive as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

test("extracts text from tar", async () => {
  const archive = await makeTar([{ name: "a.txt", data: "hello tar" }]);
  const text = await ripstream.parseToString(archive, { filename: "archive.tar" });
  assert.match(text, /hello tar/);
});

test("records recursive embedded resources", async () => {
  const archive = zip([{ name: "a.txt", data: "hello recursive" }]);
  const records = await ripstream.parseRecursive(archive, { filename: "archive.zip" });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.embeddedResourcePath, "/archive.zip");
  assert.equal(records[1]?.embeddedResourcePath, "/archive.zip/a.txt");
  assert.match(records[1]?.content ?? "", /hello recursive/);
});

test("an embedded text document's record keeps the bare type while its metadata carries the charset", async () => {
  const records = await ripstream.parseRecursive(zip([{ name: "a.txt", data: "hello" }]), { filename: "archive.zip" });
  assert.equal(records[1]?.mediaType.toString(), "text/plain");
  assert.equal(records[1]?.metadata.get("Content-Type"), "text/plain; charset=windows-1252");
});

test("extracts bzip2 and brotli", async () => {
  const bzip2 = new Uint8Array(
    Buffer.from(
      "QlpoOTFBWSZTWVVaRPcAAAIZgEAAEAASZMAQIAAiKPU9T8aEAMHNXDMCi7kinChIKq0ie4A=",
      "base64",
    ),
  );
  assert.match(
    await ripstream.parseToString(bzip2, { filename: "hello.txt.bz2" }),
    /hello bzip2/,
  );

  const brotli = new Uint8Array(
    brotliCompressSync(encoder.encode("hello brotli")),
  );
  assert.match(
    await ripstream.parseToString(brotli, { filename: "hello.txt.br" }),
    /hello brotli/,
  );
});
