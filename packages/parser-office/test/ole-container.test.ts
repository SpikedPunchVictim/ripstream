import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { OleContainerParser } from "../src/index.ts";
import { buildCompound, summaryInformation } from "./ole-builder.ts";

/*
 * What OfficeParser.java does with the types its SUPPORTED_TYPES hold that this port had no parser for: it reads the
 * SummaryInformation and DocumentSummaryInformation streams into the metadata first, then switches on the type. For the
 * generic container, the embedded-object container, and the SolidWorks types the switch writes no text (`default` and
 * `case SOLIDWORKS_*: break`), unless the root holds an EncryptedPackage entry, which throws EncryptedDocumentException; the
 * DRM type throws; the ooxml-protected type decrypts with Velvet Sweatshop or the PasswordProvider's password and parses the
 * package, which this port cannot do, so it refuses. Read from Tika's source, not run against a Tika.
 */

const SUMMARY = "\u0005SummaryInformation";
const OTHER = "Other";

const MSOFFICE = "application/x-tika-msoffice";
const OLE10_NATIVE = "application/x-tika-msoffice-embedded; format=ole10_native";
const COMP_OBJ = "application/x-tika-msoffice-embedded; format=comp_obj";
const DRM = "application/x-tika-ole-drm-encrypted";
const PROTECTED = "application/x-tika-ooxml-protected";
const SOLIDWORKS = "application/sldworks";

const other = new Uint8Array([1, 2, 3, 4]);

function container(...extra: { name: string; data: Uint8Array }[]): Uint8Array {
  return buildCompound([{ name: SUMMARY, data: summaryInformation("Hello") }, { name: OTHER, data: other }, ...extra]);
}

async function run(data: Uint8Array, type: string | undefined, context = new ParseContext()) {
  const stream = await RipstreamInputStream.from(data);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  if (type !== undefined) metadata.set("Content-Type", type);
  try {
    await new OleContainerParser().parse(stream, handler, metadata, context);
  } finally {
    await stream.close();
  }
  return { text: handler.toString(), metadata };
}

test("claims the types OfficeParser claims that nothing else here did", () => {
  const claimed = [...new OleContainerParser().getSupportedTypes()].map((type) => type.toString()).sort();
  assert.deepEqual(claimed, [SOLIDWORKS, MSOFFICE, DRM, PROTECTED, OLE10_NATIVE].sort());
});

for (const type of [MSOFFICE, OLE10_NATIVE, COMP_OBJ, SOLIDWORKS]) {
  test(`${type}: the summary streams become metadata and no text is written`, async () => {
    const result = await run(container(), type);
    assert.equal(result.metadata.get("dc:title"), "Hello");
    assert.equal(result.metadata.get("Content-Type"), type);
    assert.equal(result.text.trim(), "");
  });
}

test("a container with no summary streams is metadata-less and not an error", async () => {
  const result = await run(buildCompound([{ name: OTHER, data: other }]), MSOFFICE);
  assert.equal(result.metadata.get("dc:title"), null);
});

test("the DRM type throws EncryptedDocumentError, after the summaries are in the metadata", async () => {
  const metadata = new Metadata();
  metadata.set("Content-Type", DRM);
  const stream = await RipstreamInputStream.from(container());
  await assert.rejects(
    new OleContainerParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext()),
    EncryptedDocumentError,
  );
  await stream.close();
  assert.equal(metadata.get("dc:title"), "Hello");
});

test("the ooxml-protected type is refused as encrypted, saying decryption is what is missing", async () => {
  await assert.rejects(run(container(), PROTECTED), (error: unknown) => {
    assert.ok(error instanceof EncryptedDocumentError);
    assert.match(error.message, /not supported/);
    return true;
  });
});

test("an EncryptedPackage entry in a container of any other claimed type is refused as encrypted", async () => {
  for (const type of [MSOFFICE, OLE10_NATIVE, SOLIDWORKS]) {
    await assert.rejects(run(container({ name: "EncryptedPackage", data: other }), type), EncryptedDocumentError, type);
  }
});

test("without a type the container is read as the generic one", async () => {
  const result = await run(container(), undefined);
  assert.equal(result.metadata.get("dc:title"), "Hello");
});

test("a damaged summary stream does not fail the container", async () => {
  const damaged = buildCompound([{ name: SUMMARY, data: new Uint8Array(4096).fill(0x7f) }, { name: OTHER, data: other }]);
  const result = await run(damaged, MSOFFICE);
  assert.equal(result.metadata.get("dc:title"), null);
});

test("data that is not an OLE2 file is malformed", async () => {
  await assert.rejects(run(new Uint8Array(0), MSOFFICE), MalformedDocumentError);
  await assert.rejects(run(new Uint8Array(2048), MSOFFICE), MalformedDocumentError);
});

test("every prefix of a valid container parses or is refused as malformed", async () => {
  const data = container();
  for (let length = 0; length <= data.byteLength; length++) {
    const prefix = data.subarray(0, length);
    try {
      await run(prefix, MSOFFICE);
    } catch (error) {
      assert.ok(error instanceof MalformedDocumentError, `prefix of ${length} bytes threw ${String(error)}`);
    }
  }
  await run(data, MSOFFICE);
});

test("a header that declares an absurd number of FAT sectors is not allocated by that number", async () => {
  const data = container().slice();
  new DataView(data.buffer).setUint32(44, 0xffffffff, true);
  try {
    await run(data, MSOFFICE);
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError || error instanceof LimitExceededError, String(error));
  }
});

test("a summary stream that declares a size far past the file is not allocated by that size", async () => {
  const data = container().slice();
  // The directory is the second sector after the header's FAT sector; entry 1 is the SummaryInformation stream, whose size is at +120.
  new DataView(data.buffer).setUint32(2 * 512 + 128 + 120, 0xfffffff0, true);
  try {
    await run(data, MSOFFICE);
  } catch (error) {
    assert.ok(error instanceof MalformedDocumentError || error instanceof LimitExceededError, String(error));
  }
});
