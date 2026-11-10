import assert from "node:assert/strict";
import { test } from "node:test";
import { Metadata, ParseContext, RipstreamConfigError, RipstreamInputStream, loadConfig } from "@spikedpunch/ripstream-core";
import { DefaultDetector } from "../src/index.ts";
import { ole2 } from "./ole2-fixture.ts";
import { zip } from "./zip-fixture.ts";

/*
 * A `detectors` section is Tika's: `default-detector` is every detector Tika loads by default, its `exclude` names the
 * ones to leave out, a named entry brings in exactly that detector, and without the marker only the named entries run
 * (AbstractSpiComponentLoader and DetectorLoader, tika-serialization 4.2.0). Entries are combined as Tika's
 * CompositeDetector does: each answers in turn, and an answer replaces the running one only when it specialises it.
 * `mime-types` is the name and magic detector, and it is always part of `default-detector`.
 */

const encoder = new TextEncoder();
// An OOXML package is a plain zip to magic; only the container detector reads [Content_Types].xml to say it is a docx.
const CONTENT_TYPES =
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const RELS =
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCX = zip([
  { name: "[Content_Types].xml", data: CONTENT_TYPES },
  { name: "_rels/.rels", data: RELS },
  { name: "word/document.xml" },
]);
const DOC = ole2([{ name: "WordDocument" }]);
const HWP = ole2([{ name: "\u0005HwpSummaryInformation" }]);
const TEXT = encoder.encode("just some words");

const detectorFor = (detectors: unknown): DefaultDetector => new DefaultDetector({ config: loadConfig({ detectors }) });

async function detect(detector: DefaultDetector, bytes: Uint8Array, filename?: string): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes, { spoolThreshold: 128 });
  try {
    const metadata = new Metadata();
    if (filename !== undefined) metadata.set("tk:resource-name", filename);
    return (await detector.detect(stream, metadata, new ParseContext())).toString();
  } finally {
    await stream.close();
  }
}

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** What magic alone makes of a docx: it sees only that it is an OOXML package. */
const MAGIC_ONLY = "application/x-tika-ooxml";
const HWP_TYPE = "application/x-hwp-v5";

test("the default detects what the tests below take away", async () => {
  const detector = new DefaultDetector();
  assert.equal(await detect(detector, DOCX), DOCX_TYPE);
  assert.equal(await detect(detector, DOC), "application/msword");
  assert.equal(await detect(detector, HWP), HWP_TYPE);
  assert.equal(await detect(detector, TEXT, "a.txt"), "text/plain");
});

test("no section, an empty one, and a bare default-detector change nothing", async () => {
  for (const detector of [new DefaultDetector({ config: loadConfig({}) }), detectorFor([]), detectorFor(["default-detector"]), detectorFor([{ "default-detector": {} }])]) {
    assert.equal(await detect(detector, DOCX), DOCX_TYPE);
    assert.equal(await detect(detector, DOC), "application/msword");
    assert.equal(await detect(detector, TEXT, "a.txt"), "text/plain");
  }
});

test("default-detector with exclude takes the named detector out", async () => {
  const noZip = detectorFor([{ "default-detector": { exclude: ["default-zip-container-detector"] } }]);
    assert.equal(await detect(noZip, DOCX), MAGIC_ONLY);
  assert.equal(await detect(noZip, DOC), "application/msword");
});

test("the two OLE2 detectors are separate: excluding one leaves the other", async () => {
  const noPoifs = detectorFor([{ "default-detector": { exclude: ["poifs-container-detector"] } }]);
  assert.equal(await detect(noPoifs, DOC), "application/x-tika-msoffice");
  assert.equal(await detect(noPoifs, HWP), HWP_TYPE);
  const noMisc = detectorFor([{ "default-detector": { exclude: ["misc-ole-detector"] } }]);
  assert.equal(await detect(noMisc, DOC), "application/msword");
  assert.equal(await detect(noMisc, HWP), "application/x-tika-msoffice");
});

test("without the marker only the named detectors run, so a missing mime-types means no name or magic detection", async () => {
  const onlyZip = detectorFor(["default-zip-container-detector"]);
  assert.equal(await detect(onlyZip, DOCX), DOCX_TYPE);
  assert.equal(await detect(onlyZip, DOC), "application/octet-stream");
  assert.equal(await detect(onlyZip, TEXT, "a.txt"), "application/octet-stream");

  const onlyMime = detectorFor(["mime-types"]);
  assert.equal(await detect(onlyMime, DOCX), MAGIC_ONLY);
  assert.equal(await detect(onlyMime, DOC), "application/x-tika-msoffice");
  assert.equal(await detect(onlyMime, TEXT, "a.txt"), "text/plain");

  const onlyOle = detectorFor(["poifs-container-detector"]);
  assert.equal(await detect(onlyOle, DOC), "application/msword");
  assert.equal(await detect(onlyOle, DOCX), "application/octet-stream");
});

test("entries combine as Tika's CompositeDetector does, in either order", async () => {
  for (const order of [["default-zip-container-detector", "mime-types"], ["mime-types", "default-zip-container-detector"]]) {
    const detector = detectorFor(order);
    assert.equal(await detect(detector, DOCX), DOCX_TYPE, order.join(","));
    assert.equal(await detect(detector, DOC), "application/x-tika-msoffice", order.join(","));
  }
});

test("a named detector beside the marker leaves the default set and is run on its own", async () => {
  const detector = detectorFor([{ "default-detector": {} }, "default-zip-container-detector"]);
  assert.equal(await detect(detector, DOCX), DOCX_TYPE);
  assert.equal(await detect(detector, DOC), "application/msword");
  // The marker's own exclude still applies to the rest of the default set.
  const noOle = detectorFor([{ "default-detector": { exclude: ["poifs-container-detector"] } }, "default-zip-container-detector"]);
  assert.equal(await detect(noOle, DOCX), DOCX_TYPE);
  assert.equal(await detect(noOle, DOC), "application/x-tika-msoffice");
});

test("the no-op detector is a detector that never answers", async () => {
  const detector = detectorFor(["mime-types", "no-op-detector"]);
  assert.equal(await detect(detector, TEXT, "a.txt"), "text/plain");
  assert.equal(await detect(detectorFor(["no-op-detector"]), TEXT, "a.txt"), "application/octet-stream");
});

test("naming a detector ripstream does not implement is an error, and every one is reported", () => {
  const names = ["magika-detector", "siegfried-detector", "raw-tiff-detector", "empty-detector", "file-command-detector", "magic-detector", "pkcs-7-detector"];
  for (const name of names) {
    assert.throws(
      () => detectorFor([name]),
      (error: unknown) => error instanceof RipstreamConfigError && error.message.includes(`detector "${name}" is not implemented`),
      name,
    );
  }
  assert.throws(
    () => detectorFor(names),
    (error: unknown) => error instanceof RipstreamConfigError && error.issues.length === names.length,
  );
});

test("excluding a detector ripstream does not implement is fine: it is already not loaded", async () => {
  const detector = detectorFor([{ "default-detector": { exclude: ["magika-detector", "siegfried-detector", "raw-tiff-detector"] } }]);
  assert.equal(await detect(detector, DOCX), DOCX_TYPE);
});

test("mime-types cannot be excluded from default-detector: Tika runs it whatever the list says", () => {
  assert.throws(
    () => detectorFor([{ "default-detector": { exclude: ["mime-types"] } }]),
    (error: unknown) => error instanceof RipstreamConfigError && /mime-types.*cannot be excluded/.test(error.message),
  );
});
