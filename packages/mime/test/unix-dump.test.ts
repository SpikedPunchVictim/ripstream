import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamInputStream, loadConfig } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";

/*
 * `application/x-tika-unix-dump` (tikajs-68os.20). Tika gives it to a stream commons-compress's archive check names
 * "dump" (PackageConstants.java:31 and :50), and DefaultZipContainerDetector runs that check on the first 1024 bytes
 * before the compressor check (DefaultZipContainerDetector.java:190 and :212). The type has no magic and no glob in
 * Tika's registry (tika-mimetypes.xml:383), so only the container detector can name it. The dump rule itself is
 * commons-compress's, which is not in the Tika tree: a little-endian 32-bit NFS_MAGIC (60012) at offset 24 of at least
 * 32 bytes. These tests pin ripstream's reading of that rule; they were not measured against Tika.
 */

const NFS_MAGIC = 60012;
const UNIX_DUMP = "application/x-tika-unix-dump";

function dumpBytes(length: number, littleEndian = true): Uint8Array {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(24, NFS_MAGIC, littleEndian);
  return bytes;
}

async function detect(bytes: Uint8Array, filename = "x.bin", detector = new DefaultDetector()): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 32 });
  try {
    const metadata = new Metadata();
    metadata.set("tk:resource-name", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

test("a dump header (NFS_MAGIC at offset 24) is a Unix dump", async () => {
  assert.equal(await detect(dumpBytes(1024)), UNIX_DUMP);
});

test("32 bytes are enough to see the magic, 31 are not", async () => {
  assert.equal(await detect(dumpBytes(32)), UNIX_DUMP);
  assert.notEqual(await detect(dumpBytes(31)), UNIX_DUMP);
});

test("the magic is little-endian and sits at offset 24", async () => {
  assert.notEqual(await detect(dumpBytes(1024, false)), UNIX_DUMP);
  const shifted = new Uint8Array(1024);
  new DataView(shifted.buffer).setUint32(28, NFS_MAGIC, true);
  assert.notEqual(await detect(shifted), UNIX_DUMP);
});

test("only the first 1024 bytes are looked at, and a name does not make a dump", async () => {
  assert.notEqual(await detect(dumpBytes(1024), "x.bin", new DefaultDetector({ prefixLength: 16 })), UNIX_DUMP);
  assert.notEqual(await detect(new Uint8Array(64), "x.dump"), UNIX_DUMP);
});

test("the archive check comes before the compressor check", async () => {
  // A bzip2 signature and a dump magic: DefaultZipContainerDetector.detect returns the archive type first.
  const bytes = dumpBytes(1024);
  bytes.set([0x42, 0x5a, 0x68], 0);
  assert.equal(await detect(bytes), UNIX_DUMP);
});

test("the dump check belongs to the ZIP container detector and goes with it", async () => {
  const withoutContainer = new DefaultDetector({
    config: loadConfig({ detectors: [{ "default-detector": { exclude: ["default-zip-container-detector"] } }] }),
  });
  assert.notEqual(await detect(dumpBytes(1024), "x.bin", withoutContainer), UNIX_DUMP);
  const onlyContainer = new DefaultDetector({ config: loadConfig({ detectors: ["default-zip-container-detector"] }) });
  assert.equal(await detect(dumpBytes(1024), "x.bin", onlyContainer), UNIX_DUMP);
});
