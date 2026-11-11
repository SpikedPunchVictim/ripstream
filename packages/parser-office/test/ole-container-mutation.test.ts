import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BodyContentHandler,
  EncryptedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { OleContainerParser } from "../src/index.ts";
import { buildCompound, documentSummaryInformation, summaryInformation } from "./ole-builder.ts";

/*
 * Pins found by mutation testing OleContainerParser (tikajs-68os.19): both summary streams are read, the encrypted kinds
 * are refused by their base type whatever parameters follow it, and each refusal says why. Tika's OfficeParser does the
 * same in the same order (SummaryExtractor.parseSummaries first, then the switch on the type).
 */

const SUMMARY = "\u0005SummaryInformation";
const DOCUMENT_SUMMARY = "\u0005DocumentSummaryInformation";
const MSOFFICE = "application/x-tika-msoffice";

async function run(data: Uint8Array, type: string): Promise<Metadata> {
  const stream = await RipstreamInputStream.from(data);
  const metadata = new Metadata();
  metadata.set("Content-Type", type);
  try {
    await new OleContainerParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
  } finally {
    await stream.close();
  }
  return metadata;
}

async function refusal(data: Uint8Array, type: string): Promise<EncryptedDocumentError> {
  try {
    await run(data, type);
  } catch (error) {
    assert.ok(error instanceof EncryptedDocumentError, String(error));
    return error;
  }
  assert.fail(`${type} was not refused`);
}

test("the parser names itself as Tika's OfficeParser and declares itself metadata-only with random access", () => {
  const parser = new OleContainerParser();
  assert.equal(parser.name, "OfficeParser");
  assert.equal(parser.capabilities.metadataOnly, true);
  assert.equal(parser.capabilities.requiresRandomAccess, true);
});

test("the DocumentSummaryInformation stream is read as well as the SummaryInformation stream", async () => {
  const both = await run(
    buildCompound([
      { name: SUMMARY, data: summaryInformation("Title") },
      { name: DOCUMENT_SUMMARY, data: documentSummaryInformation("Acme") },
    ]),
    MSOFFICE,
  );
  assert.equal(both.get("dc:title"), "Title");
  assert.equal(both.get("extended-properties:Company"), "Acme");
});

test("each summary stream is read without the other", async () => {
  const onlyDocument = await run(buildCompound([{ name: DOCUMENT_SUMMARY, data: documentSummaryInformation("Acme") }]), MSOFFICE);
  assert.equal(onlyDocument.get("extended-properties:Company"), "Acme");
  assert.equal(onlyDocument.get("dc:title"), null);
  const onlySummary = await run(buildCompound([{ name: SUMMARY, data: summaryInformation("Title") }]), MSOFFICE);
  assert.equal(onlySummary.get("dc:title"), "Title");
  assert.equal(onlySummary.get("extended-properties:Company"), null);
});

test("a container with no streams at all is read, and leaves the metadata as it was", async () => {
  const metadata = await run(buildCompound([]), MSOFFICE);
  assert.deepEqual(metadata.names(), ["Content-Type"]);
});

test("the type is matched by its base type: parameters after it do not hide an encrypted kind", async () => {
  await refusal(buildCompound([]), "application/x-tika-ole-drm-encrypted; charset=UTF-8");
  await refusal(buildCompound([]), "application/x-tika-ooxml-protected; charset=UTF-8");
});

test("each refusal says what is wrong, and a type that only starts like an encrypted one is read", async () => {
  assert.match((await refusal(buildCompound([]), "application/x-tika-ole-drm-encrypted")).message, /DRM encrypted/);
  assert.match((await refusal(buildCompound([]), "application/x-tika-ooxml-protected")).message, /OOXML/);
  const entry = buildCompound([{ name: "EncryptedPackage", data: new Uint8Array(8) }]);
  assert.match((await refusal(entry, MSOFFICE)).message, /EncryptedPackage/);
  await run(buildCompound([]), "application/x-tika-ole-drm-encrypted-not");
  await run(buildCompound([]), "application/x-tika-ooxml-protected-not");
});

test("an entry that is called something like EncryptedPackage is not that entry", async () => {
  await run(buildCompound([{ name: "EncryptedPackages", data: new Uint8Array(8) }]), MSOFFICE);
  await run(buildCompound([{ name: "encryptedpackage", data: new Uint8Array(8) }]), MSOFFICE);
});

test("data without the OLE2 signature is refused as not an OLE2 file, before any parse of it", async () => {
  await assert.rejects(run(new Uint8Array(2048), MSOFFICE), /Not an OLE2 compound file/);
});
