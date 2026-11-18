import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { MemoryPool, type RunDiagnostics } from "@spikedpunch/ripstream-isolation-node";
import { LimitExceededError, createRipstream, type LimitReason, type ParseLimits, type ParseRecord } from "../src/index.ts";
import { createStandardIsolation } from "../src/isolation.ts";

/**
 * tikajs-segq: every ParseLimits member but maxTaskMillis crosses the isolation boundary per request. Each bomb below
 * is stopped by its own limit in a child, with the answer an in-process parse gives, and no RangeError.
 */

const encoder = new TextEncoder();
const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 4 });
const settled: RunDiagnostics[] = [];
const inProcess = createRipstream();
const standard = await createStandardIsolation({ config: { mode: "strict" }, pool, runner: { onRunSettled: (d) => settled.push(d) } });
after(async () => {
  await standard.isolator.dispose();
  pool.dispose();
});

/** A ZIP of the given entries, each stored or deflated. */
function zip(entries: Readonly<Record<string, Uint8Array>>, deflate = false): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of Object.entries(entries)) {
    const data = Buffer.from(deflate ? deflateRawSync(raw) : raw);
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

const text = (count: number, label = "x"): Uint8Array => encoder.encode(`${label} `.repeat(count));
const names = (count: number, size: number): Record<string, Uint8Array> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i}.txt`, text(size, `n${i}`)]));

/** The thrown error of one arm, or the records it answered. */
async function run(arm: "in-process" | "child", bytes: Uint8Array, limits: Partial<ParseLimits>): Promise<ParseRecord[] | Error> {
  const ripstream = arm === "child" ? standard.ripstream : inProcess;
  try {
    return [...(await ripstream.parseRecursive(bytes, { filename: "bomb.zip", limits }))];
  } catch (error) {
    return error as Error;
  }
}

function comparable(records: readonly ParseRecord[]): unknown {
  return records.map((record) => [record.embeddedResourcePath, record.content, record.exception?.message ?? null]);
}

/**
 * Both arms refuse alike: the same typed error, the same message, the same `limit`, `observed` and `max` (tikajs-mz56),
 * and the child really ran.
 */
async function bothRefuse(bytes: Uint8Array, limits: Partial<ParseLimits>, message: RegExp, reason: LimitReason): Promise<void> {
  const before = settled.length;
  const [local, child] = [await run("in-process", bytes, limits), await run("child", bytes, limits)];
  assert.ok(local instanceof LimitExceededError, `in-process: ${String(local)}`);
  assert.ok(child instanceof LimitExceededError, `child: ${String(child)}`);
  assert.match(local.message, message);
  assert.equal(child.message, local.message);
  assert.equal(local.limit, reason, "in-process limit");
  assert.equal(child.limit, reason, "child limit");
  assert.equal(child.observed, local.observed, "observed");
  assert.equal(child.max, local.max, "max");
  assert.equal(settled.length - before, 1, "the child ran");
}

/**
 * Both arms answer alike with the limit's breach recorded on the embedded documents, not thrown (an embedded failure is
 * a record's own `exception`, as in process).
 */
async function bothRecord(bytes: Uint8Array, limits: Partial<ParseLimits>, message: RegExp): Promise<void> {
  const before = settled.length;
  const local = await run("in-process", bytes, limits);
  const child = await run("child", bytes, limits);
  assert.ok(Array.isArray(local), String(local));
  assert.ok(Array.isArray(child), String(child));
  assert.ok(local.some((record) => message.test(record.exception?.message ?? "")), "in-process records the breach");
  assert.deepEqual(comparable(child), comparable(local));
  assert.equal(settled.length - before, 1, "the child ran");
}

/** Both arms answer alike under a limit that is not reached. */
async function bothAnswer(bytes: Uint8Array, limits: Partial<ParseLimits>): Promise<void> {
  const local = await run("in-process", bytes, limits);
  const child = await run("child", bytes, limits);
  assert.ok(Array.isArray(local), String(local));
  assert.ok(Array.isArray(child), String(child));
  assert.deepEqual(comparable(child as ParseRecord[]), comparable(local as ParseRecord[]));
}

test("maxZipEntries stops a many-entry zip in a child as it does in process", async () => {
  const bytes = zip(names(40, 4));
  await bothRefuse(bytes, { maxZipEntries: 10 }, /ZIP entries exceed 10/, "zipEntries");
  await bothAnswer(bytes, { maxZipEntries: 40 });
});

test("maxDecompressionRatio stops a deflate bomb in a child as it does in process", async () => {
  const bytes = zip({ "zeros.txt": text(600_000, "a") }, true);
  await bothRefuse(bytes, { maxDecompressionRatio: 10, maxOutputChars: 2_000_000 }, /ratio/i, "ratio");
  await bothAnswer(bytes, { maxDecompressionRatio: 100_000, maxOutputChars: 2_000_000 });
});

test("maxEmbeddedResourceBytes stops an oversized entry in a child as it does in process", async () => {
  const bytes = zip({ "big.txt": text(2000) });
  await bothRefuse(bytes, { maxEmbeddedResourceBytes: 1000 }, /per-entry limit/, "entryBytes");
  await bothAnswer(bytes, { maxEmbeddedResourceBytes: 100_000 });
});

test("maxTotalEmbeddedBytes stops a zip whose entries add up too far in a child as it does in process", async () => {
  const bytes = zip(names(5, 100));
  await bothRefuse(bytes, { maxTotalEmbeddedBytes: 1000 }, /embedded byte limit/, "totalBytes");
  await bothAnswer(bytes, { maxTotalEmbeddedBytes: 1_000_000 });
});

test("maxOutputChars stops a long document in a child as it does in process, and says which limit", async () => {
  const bytes = zip({ "long.txt": text(5000) });
  await bothRefuse(bytes, { maxOutputChars: 100 }, /output exceeds 100 characters/i, "outputChars");
});

test("maxDocumentOutputChars stops one long document in a child as it does in process", async () => {
  const bytes = zip({ "long.txt": text(5000) });
  await bothRecord(bytes, { maxDocumentOutputChars: 100 }, /Document output exceeds 100 characters/);
  await bothAnswer(bytes, { maxDocumentOutputChars: 1_000_000, maxOutputChars: 1_000_000 });
});

test("the metadata and XML limits cross: a value cap shortens, a total cap above the child's frame is refused by the parent", async () => {
  const bytes = zip(names(3, 4));
  await bothAnswer(bytes, { maxMetadataValueChars: 50, maxMetadataTotalChars: 100_000, maxXmlEntityExpansions: 0 });
  await assert.rejects(standard.ripstream.parseRecursive(bytes, { limits: { maxMetadataTotalChars: 2_000_001 } }), RangeError);
});

test("maxInputBytes refuses an oversized input in the parent, with no child spawned, and with the in-process answer (tikajs-is31)", async () => {
  const bytes = zip(names(5, 100));
  const limits = { maxInputBytes: 1000 };
  assert.ok(bytes.length > 1000);
  const before = settled.length;
  const local = await run("in-process", bytes, limits);
  const child = await run("child", bytes, limits);
  assert.ok(local instanceof LimitExceededError, String(local));
  assert.ok(child instanceof LimitExceededError, String(child));
  assert.equal(local.limit, "inputBytes");
  assert.equal(child.limit, "inputBytes");
  assert.equal(child.message, local.message);
  assert.deepEqual([child.observed, child.max], [bytes.length, 1000]);
  assert.deepEqual([local.observed, local.max], [bytes.length, 1000]);
  assert.equal(settled.length, before, "no child ran");
  await bothAnswer(bytes, { maxInputBytes: bytes.length });
});

test("maxTaskMillis is the isolation's own budget and is refused with a pointer to it", async () => {
  await assert.rejects(standard.ripstream.parse(new Uint8Array(1), { limits: { maxTaskMillis: 1000 } }), /IsolationConfig\.maxTaskMillis/);
});

test("every limit that crosses reaches a child at once: no RangeError for any ParseLimits member but maxTaskMillis", async () => {
  const bytes = zip(names(2, 4));
  const every: Partial<ParseLimits> = {
    maxOutputChars: 50_000,
    maxDocumentOutputChars: 50_000,
    maxEmbeddedResources: 100,
    maxEmbeddedResourceBytes: 1_000_000,
    maxTotalEmbeddedBytes: 10_000_000,
    maxDecompressionRatio: 500,
    maxNodeDepth: 10,
    maxParseMillis: 20_000,
    maxMetadataValueChars: 10_000,
    maxMetadataTotalChars: 100_000,
    maxZipEntries: 100,
    maxXmlEntityExpansions: 0,
    maxInputBytes: 1_000_000,
    maxPages: 1000,
  };
  await bothAnswer(bytes, every);
});
