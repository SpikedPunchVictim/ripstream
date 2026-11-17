import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { BodyContentHandler, LimitExceededError, createRipstream, type ParseRecord } from "../src/index.ts";
import { createStandardIsolation } from "../src/isolation.ts";

/**
 * tikajs-1fz4: `onEmbeddedLimit: "truncate"` keeps the first entries of an archive that has more than maxZipEntries
 * (zip, tar) or maxEmbeddedResources, in archive order, and says so on the container's metadata. The default stays a
 * thrown LimitExceededError. In-process and isolated answers agree.
 */

const FLAG = "tk:exception:embedded-resource-limit-reached";
const LIMIT = "tk:exception:embedded-resource-limit";
const LIMIT_MAX = "tk:exception:embedded-resource-limit-max";
const SEEN = "tk:exception:embedded-resource-limit-seen";
const READ = "tk:exception:embedded-resource-limit-read";

/** The recursive output cap counts the text of every record: 10,000 entries of text do not fit the 100,000 default. */
const OUT = 1_000_000;
const encoder = new TextEncoder();
const name = (i: number): string => `e${String(i).padStart(5, "0")}.txt`;
const body = (i: number): string => `n${i}`;

/** A ZIP of `count` stored entries named e00001.txt ... each holding "nN". */
function bigZip(count: number, nameOf: (i: number) => string = name): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (let i = 1; i <= count; i += 1) {
    const data = Buffer.from(encoder.encode(body(i)));
    const nameBytes = Buffer.from(nameOf(i));
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
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

/** A ustar archive of `count` entries named like the zip's. */
function bigTar(count: number, nameOf: (i: number) => string = name): Uint8Array {
  const blocks: Buffer[] = [];
  for (let i = 1; i <= count; i += 1) {
    const data = Buffer.from(encoder.encode(body(i)));
    const header = Buffer.alloc(512);
    header.write(nameOf(i), 0, "utf8");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("00000000000\0", 136, "latin1");
    header.write("        ", 148, "latin1");
    header.write("0", 156, "latin1");
    header.write("ustar\0", 257, "latin1");
    header.write("00", 263, "latin1");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(header, padded);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 4 });
const inProcess = createRipstream();
const standard = await createStandardIsolation({ config: { mode: "strict" }, pool });
after(async () => {
  await standard.isolator.dispose();
  await pool.dispose();
});

const arms = [
  ["in-process", inProcess],
  ["isolated", standard.ripstream],
] as const;

function contents(records: readonly ParseRecord[]): string[] {
  return records.slice(1).map((r) => r.content.trim());
}

for (const [arm, ripstream] of arms) {
  test(`${arm}: a 50,000-entry zip throws at the default limit`, { timeout: 120_000 }, async () => {
    await assert.rejects(ripstream.parseRecursive(bigZip(50_000), { filename: "big.zip" }), (e: unknown) => {
      assert.ok(e instanceof LimitExceededError, String(e));
      assert.match((e as Error).message, /ZIP entries exceed 10000/);
      return true;
    });
  });

  test(`${arm}: onEmbeddedLimit truncate keeps the first 10,000 zip entries in archive order and flags the container`, { timeout: 120_000 }, async () => {
    const records = await ripstream.parseRecursive(bigZip(50_000), { filename: "big.zip", onEmbeddedLimit: "truncate", limits: { maxOutputChars: OUT } });
    assert.equal(records.length, 10_001);
    const text = contents(records);
    assert.equal(text[0], body(1));
    assert.equal(text[9_999], body(10_000));
    assert.deepEqual(text, Array.from({ length: 10_000 }, (_, i) => body(i + 1)));
    const meta = records[0]!.metadata;
    assert.equal(meta.get(FLAG), "true");
    assert.equal(meta.get(LIMIT), "maxZipEntries");
    assert.equal(meta.get(LIMIT_MAX), "10000");
    assert.equal(meta.get(SEEN), "50000");
    assert.equal(meta.get(READ), "10000");
    for (const record of records.slice(1)) assert.equal(record.metadata.get(FLAG), null);
  });

  test(`${arm}: text parse of a truncated zip carries the flag too`, { timeout: 120_000 }, async () => {
    const result = await ripstream.parse(bigZip(10_300), {
      filename: "big.zip",
      onEmbeddedLimit: "truncate",
      limits: { maxOutputChars: OUT },
    });
    assert.equal(result.metadata.get(FLAG), "true");
    assert.equal(result.metadata.get(LIMIT), "maxZipEntries");
    assert.equal(result.metadata.get(SEEN), "10300");
    assert.equal(result.metadata.get(READ), "10000");
    assert.match(result.text, new RegExp(body(10_000)));
    assert.doesNotMatch(result.text, new RegExp(body(10_001)));
  });

  test(`${arm}: tar with the limit raised above its entries reads all of them and sets no flag`, { timeout: 60_000 }, async () => {
    const records = await ripstream.parseRecursive(bigTar(3_000), {
      filename: "big.tar",
      onEmbeddedLimit: "truncate",
      limits: { maxEmbeddedResources: 5_000, maxOutputChars: OUT },
    });
    assert.equal(records.length, 3_001);
    assert.equal(records[0]!.metadata.get(FLAG), null);
    assert.equal(records[0]!.metadata.get(SEEN), null);
  });

  test(`${arm}: tar at maxEmbeddedResources 1000 throws by default`, { timeout: 60_000 }, async () => {
    await assert.rejects(
      ripstream.parseRecursive(bigTar(3_000), { filename: "big.tar", limits: { maxEmbeddedResources: 1000 } }),
      (e: unknown) => {
        assert.ok(e instanceof LimitExceededError, String(e));
        assert.match((e as Error).message, /Embedded count 1001 exceeds 1000/);
        // In process and across the boundary alike (tikajs-mz56).
        assert.equal((e as LimitExceededError).limit, "embeddedResources");
        assert.equal((e as LimitExceededError).observed, 1001);
        assert.equal((e as LimitExceededError).max, 1000);
        return true;
      },
    );
  });

  test(`${arm}: tar at maxEmbeddedResources 1000 under truncate keeps the first 1,000 entries and flags the container`, { timeout: 60_000 }, async () => {
    const records = await ripstream.parseRecursive(bigTar(3_000), {
      filename: "big.tar",
      onEmbeddedLimit: "truncate",
      limits: { maxEmbeddedResources: 1000, maxOutputChars: OUT },
    });
    assert.equal(records.length, 1001);
    assert.deepEqual(contents(records), Array.from({ length: 1000 }, (_, i) => body(i + 1)));
    const meta = records[0]!.metadata;
    assert.equal(meta.get(FLAG), "true");
    assert.equal(meta.get(LIMIT), "maxEmbeddedResources");
    assert.equal(meta.get(LIMIT_MAX), "1000");
    assert.equal(meta.get(SEEN), "1001");
    assert.equal(meta.get(READ), "1000");
  });

  test(`${arm}: a nested archive is cut at its own entry limit, flagged on that archive's record`, { timeout: 120_000 }, async () => {
    const records = await ripstream.parseRecursive(wrapEntry("inner.zip", bigZip(10_300)), {
      filename: "outer.zip",
      onEmbeddedLimit: "truncate",
      limits: { maxEmbeddedResources: 50_000, maxOutputChars: OUT },
    });
    assert.equal(records.length, 10_002);
    assert.equal(records[0]!.metadata.get(FLAG), null);
    assert.equal(records[1]!.metadata.get(FLAG), "true");
    assert.equal(records[1]!.metadata.get(SEEN), "10300");
    assert.equal(records[2]!.content.trim(), body(1));
  });
}

// maxZipEntries and the expansion limits cross the boundary per request (tikajs-segq): both arms answer alike.
for (const [arm, ripstream] of arms) {
  test(`${arm}: a lowered maxZipEntries cuts a zip and a tar at that many entries`, async () => {
    for (const [filename, bytes] of [
      ["big.zip", bigZip(300)],
      ["big.tar", bigTar(300)],
    ] as const) {
      const records = await ripstream.parseRecursive(bytes, { filename, onEmbeddedLimit: "truncate", limits: { maxZipEntries: 100 } });
      assert.equal(records.length, 101, filename);
      assert.equal(records[0]!.metadata.get(LIMIT), "maxZipEntries", filename);
      assert.equal(records[0]!.metadata.get(SEEN), "300", filename);
      assert.equal(records[0]!.metadata.get(READ), "100", filename);
      assert.equal(records[100]!.content.trim(), body(100), filename);
    }
  });

  test(`${arm}: a raised maxZipEntries reads every zip entry and sets no flag`, async () => {
    const records = await ripstream.parseRecursive(bigZip(12_000), {
      filename: "big.zip",
      onEmbeddedLimit: "truncate",
      limits: { maxZipEntries: 20_000, maxEmbeddedResources: 20_000, maxOutputChars: OUT },
    });
    assert.equal(records.length, 12_001);
    assert.equal(records[0]!.metadata.get(FLAG), null);
  });

  test(`${arm}: the expansion limit still throws under truncate`, async () => {
    await assert.rejects(
      ripstream.parseRecursive(bigZip(50), { filename: "big.zip", onEmbeddedLimit: "truncate", limits: { maxTotalEmbeddedBytes: 100 } }),
      LimitExceededError,
    );
  });
}

/** A one-entry stored zip around `data`. */
function wrapEntry(entryName: string, data: Uint8Array): Uint8Array {
  const nameBytes = Buffer.from(entryName);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0021, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  const offset = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(entry.length + nameBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([local, nameBytes, data, entry, nameBytes, end]);
}

/**
 * tikajs-6ghz (F5): the three `parseTo*` methods always throw (the doc on `ParseOptions.onEmbeddedLimit`): a cut archive
 * is not a result they can flag, so `truncate` is ignored there. (The isolated ripstream has no such methods.)
 */
const truncating = { filename: "five.zip", onEmbeddedLimit: "truncate", limits: { maxEmbeddedResources: 3 } } as const;

test("in-process: parseToString ignores onEmbeddedLimit truncate and throws", async () => {
  await assert.rejects(inProcess.parseToString(bigZip(5), truncating), /Embedded count 4 exceeds 3/);
});

test("in-process: parseToHandler and parseToStream throw under onEmbeddedLimit truncate too", async () => {
  await assert.rejects(inProcess.parseToHandler(bigZip(5), new BodyContentHandler(), truncating), LimitExceededError);
  const reader = inProcess.parseToStream(bigZip(5), truncating).getReader();
  await assert.rejects(async () => {
    for (;;) if ((await reader.read()).done) return;
  }, LimitExceededError);
});

/** tikajs-6ghz (F8): the embedded-count error is a LimitExceededError by name, here and across the isolation boundary. */
for (const [arm, ripstream] of arms) {
  test(`${arm}: the embedded-count limit error is named LimitExceededError`, async () => {
    await assert.rejects(ripstream.parse(bigZip(5), { filename: "five.zip", limits: { maxEmbeddedResources: 3 } }), (e: unknown) => {
      assert.ok(e instanceof LimitExceededError, String(e));
      assert.equal((e as Error).name, "LimitExceededError");
      return true;
    });
  });
}
