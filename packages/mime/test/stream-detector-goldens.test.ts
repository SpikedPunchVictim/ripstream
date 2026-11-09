import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";

interface Golden {
  readonly id: string;
  readonly filename: string;
  readonly bytes: string;
  /** Tika 4.2.0's answer for exactly these bytes and this name. */
  readonly tika: string;
}

const goldens = JSON.parse(readFileSync(new URL("./stream-detector-goldens.json", import.meta.url), "utf8")) as {
  tikaVersion: string;
  cases: readonly Golden[];
};

const detector = new DefaultDetector();

async function detect(bytes: Uint8Array, filename: string): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("resourceName", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

test("Ogg, Matroska, gzip, binary plist and magic detection match Tika 4.2.0 on every measured fixture", async () => {
  assert.equal(goldens.tikaVersion, "4.2.0");
  const failures: string[] = [];
  for (const golden of goldens.cases) {
    const actual = await detect(new Uint8Array(Buffer.from(golden.bytes, "base64")), golden.filename);
    if (actual !== golden.tika) failures.push(`${golden.id}: expected ${golden.tika}, got ${actual}`);
  }
  assert.deepEqual(failures, []);
});

test("the goldens cover each stream detector", () => {
  const prefixes = new Set(goldens.cases.map((golden) => golden.id.split(":")[0]));
  for (const prefix of ["real", "ogg", "mkv", "gzip", "bplist", "magic"]) {
    assert.ok(prefixes.has(prefix), `missing ${prefix}`);
  }
});

test("a truncated binary plist is read as a plain bplist, not an error (Tika throws)", async () => {
  // The root dictionary names a memory graph, but the file ends before its offset table and trailer.
  const truncated = new Uint8Array(Buffer.from(
    goldens.cases.find((golden) => golden.id === "bplist:memgraph")!.bytes,
    "base64",
  ).subarray(0, 40));
  assert.equal(await detect(truncated, "x.bin"), "application/x-bplist");
});

test("a gzip member is judged on its first 1024 compressed bytes, never inflated past a marker's length", async () => {
  // 64 MiB of zeros deflates to ~64 KiB; only the first 1 KiB is judged and only 16 bytes of it inflated.
  const { gzipSync } = await import("node:zlib");
  const bomb = gzipSync(Buffer.alloc(1024 * 1024 * 64));
  const started = performance.now();
  assert.equal(await detect(new Uint8Array(bomb), "x.bin"), "application/gzip");
  assert.ok(performance.now() - started < 2000);
});

test("a binary plist whose trailer and counts lie reads as a plain bplist without reading or allocating by them", async () => {
  const body = Buffer.from("bplist00\xdf\x13\xff\xff\xff\xff\x08", "latin1");
  const trailer = (objectCount: bigint, top: bigint, table: bigint): Buffer => {
    const bytes = Buffer.alloc(32);
    bytes[6] = 2;
    bytes[7] = 1;
    bytes.writeBigUInt64BE(objectCount, 8);
    bytes.writeBigUInt64BE(top, 16);
    bytes.writeBigUInt64BE(table, 24);
    return bytes;
  };
  const lies = [
    trailer(2n ** 63n, 0n, 8n),
    trailer(1n, 0n, 2n ** 62n),
    trailer(1n, 5n, 8n),
    // A real table entry pointing at a root dictionary that claims 4 billion keys.
    Buffer.concat([Buffer.from([0, 8]), trailer(1n, 0n, BigInt(body.length))]),
  ];
  for (const lie of lies) {
    const bytes = new Uint8Array(Buffer.concat([body, lie]));
    assert.equal(await detect(bytes, "x.bin"), "application/x-bplist");
  }
});
