import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test, type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import {
  DEFAULT_IN_PROCESS_TYPES,
  MemoryPool,
  type RunDiagnostics,
} from "@spikedpunch/ripstream-isolation-node";
import {
  CompositeParser,
  LimitExceededError,
  ParseContext,
  RipstreamConfigError,
  UnsupportedFormatError,
  createRipstream,
  loadConfig,
  type Metadata,
  type ParseRecord,
} from "../src/index.ts";
import {
  createInProcessParsers,
  createInProcessRipstream,
  createStandardIsolation,
  type StandardIsolation,
  type StandardIsolationOptions,
} from "../src/isolation.ts";

/**
 * createStandardIsolation end to end: the real standard child, the real full ripstream for routing, and a RESTRICTED
 * ripstream for the requests that stay in this process. Answers are compared with the plain in-process pipeline.
 */

const encoder = new TextEncoder();

/** One pool for every test; each isolator is disposed by its test, the pool is never disposed by them. */
const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 8 });
/** One entry per child run of any isolator made here: the way to tell "parsed in a child" from "parsed here". */
const settled: RunDiagnostics[] = [];

after(() => {
  pool.dispose();
});

async function withStandard(
  overrides: Partial<StandardIsolationOptions>,
  action: (standard: StandardIsolation) => Promise<void>,
): Promise<void> {
  const standard = await createStandardIsolation({
    config: { mode: "strict" },
    pool,
    runner: { onRunSettled: (d) => settled.push(d) },
    ...overrides,
  });
  try {
    await action(standard);
  } finally {
    await standard.isolator.dispose();
  }
}

// ---- fixtures, built by hand (same builders as isolation.test.ts) -------------------------------------------------

/** A ZIP with every entry stored (method 0). */
function storedZip(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(typeof value === "string" ? encoder.encode(value) : value);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0021, 12); // 1980-01-01
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
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function docx(paragraphs: readonly string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return storedZip({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "docProps/core.xml":
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Standard Isolation Doc</dc:title><dc:creator>Ada</dc:creator></cp:coreProperties>',
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

/** A one-page PDF with standard Helvetica text (ASCII only, so string length is byte length). */
function pdf(text: string): Uint8Array {
  return pdfOfContent(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`);
}

function pdfOfContent(content: string): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
}

// ---- the in-process reference ---------------------------------------------------------------------------------------

type WireMetadata = Record<string, readonly string[]>;

function wireMetadata(metadata: Metadata): WireMetadata {
  return Object.fromEntries(metadata.names().map((name) => [name, [...metadata.getAll(name)]]));
}

/** Core stamps each record with how long its parse took: the one metadata key that cannot be equal across two runs. */
const TIMING_KEY = "tk:parse-time-millis";

/** A record in a shape two runs (in-process, and across the isolation boundary) can be compared in. */
function comparable(record: ParseRecord): unknown {
  const { [TIMING_KEY]: _timing, ...metadata } = wireMetadata(record.metadata);
  return {
    metadata,
    content: record.content,
    embeddedResourcePath: record.embeddedResourcePath,
    depth: record.depth,
    mediaType: record.mediaType.toString(),
    exception: record.exception === null ? null : { name: record.exception.name, message: record.exception.message },
  };
}

const reference = createRipstream();

async function referenceText(bytes: Uint8Array, filename: string): Promise<{ text: string; metadata: WireMetadata }> {
  const result = await reference.parse(bytes, { filename });
  return { text: result.text, metadata: wireMetadata(result.metadata) };
}

// ---- 1. routing: text stays here, containers and PDFs go to a child --------------------------------------------------

test("text/plain is parsed in this process; a DOCX, a zip and a PDF each get a child; the text is the in-process text", async () => {
  await withStandard({}, async ({ ripstream }) => {
    const plain = encoder.encode("plain text, parsed here");
    const before = settled.length;
    const answer = await ripstream.parse(plain, { filename: "a.txt" });
    assert.equal(settled.length - before, 0, "no child ran for text/plain");
    const expected = await referenceText(plain, "a.txt");
    assert.equal(answer.text, expected.text);
    assert.deepEqual(wireMetadata(answer.metadata), expected.metadata);

    const containers = [
      ["a.docx", docx(["Isolated DOCX paragraph"])],
      ["a.zip", storedZip({ "x.txt": "inside the archive" })],
      ["a.pdf", pdf("Isolated PDF text")],
    ] as const;
    for (const [filename, input] of containers) {
      const childrenBefore = settled.length;
      const viaChild = await ripstream.parse(input, { filename });
      assert.equal(settled.length - childrenBefore, 1, `${filename} went to its own child`);
      const inProcess = await referenceText(input, filename);
      assert.ok(inProcess.text.trim().length > 0, `${filename}: the fixture itself must parse`);
      assert.equal(viaChild.text, inProcess.text, filename);
    }
  });
});

test("detect() answers in this process, with the full ripstream's verdict", async () => {
  await withStandard({}, async ({ ripstream }) => {
    const before = settled.length;
    assert.equal((await ripstream.detect(pdf("detect me"), { filename: "a.pdf" })).toString(), "application/pdf");
    assert.equal((await ripstream.detect(docx(["x"]))).getBaseType().subtype, "vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(settled.length - before, 0, "detect never spawns a child");
  });
});

// ---- 2. records: every embedded document, one child ----------------------------------------------------------------

test("parseRecursive over a zip with embedded documents gives the in-process records, from ONE child", async () => {
  const container = storedZip({
    "notes.txt": "Plain notes inside the archive",
    "page.html": "<html><head><title>Embedded page</title></head><body><p>Hello <b>html</b> world</p></body></html>",
    "inner/report.docx": docx(["Embedded DOCX paragraph"]),
  });
  const expected = (await reference.parseRecursive(container, { filename: "bundle.zip" })).map(comparable);
  assert.ok(expected.length >= 4, `expected the container and its 3 parts, got ${expected.length}`);

  await withStandard({}, async ({ ripstream }) => {
    const before = settled.length;
    const records = await ripstream.parseRecursive(container, { filename: "bundle.zip" });
    assert.equal(settled.length - before, 1, "one child for the container and all of its embedded documents");
    assert.deepEqual(records.map(comparable), expected);
    assert.ok(
      records.some((r) => /Embedded DOCX paragraph/.test(r.content)),
      "the nested document's text is in its record",
    );
  });
});

test("parseRecursive with unpackBytes brings back each embedded document's bytes through the child, as in-process", async () => {
  // Past 192 KiB, so the bytes cross in more than one frame; the parts are not text a parser would reshape.
  const big = Uint8Array.from({ length: 500 * 1024 }, (_unused, index) => (index * 31 + (index >> 8)) % 251);
  const container = storedZip({
    "notes.txt": "Plain notes inside the archive",
    "data/blob.bin": big,
    "empty.txt": "",
    "inner/report.docx": docx(["Embedded DOCX paragraph"]),
  });
  const bytesOf = (records: readonly ParseRecord[]): Array<string | null> =>
    records.map((r) => (r.bytes === undefined ? null : `${r.bytes.length}:${Buffer.from(r.bytes).toString("base64").slice(0, 64)}`));
  const expected = await reference.parseRecursive(container, { filename: "bundle.zip", unpackBytes: 4 * 1024 * 1024 });
  assert.equal(expected[0]?.bytes, undefined, "the container itself carries none");
  assert.ok(expected.slice(1).every((r) => r.bytes !== undefined), "every part of the zip kept its bytes in-process");

  await withStandard({}, async ({ ripstream }) => {
    const before = settled.length;
    const records = await ripstream.parseRecursive(container, { filename: "bundle.zip", unpackBytes: 4 * 1024 * 1024 });
    assert.equal(settled.length - before, 1, "one child");
    assert.deepEqual(bytesOf(records), bytesOf(expected));
    const blob = records.find((r) => r.metadata.get("tk:resource-name")?.endsWith("blob.bin"));
    assert.equal(Buffer.compare(Buffer.from(blob?.bytes ?? []), Buffer.from(big)), 0, "the large document arrives whole");
  });
});

test("parseRecursive with an unpackBytes budget leaves out the documents that would pass it, in the child as in-process", async () => {
  const container = storedZip({ "a.txt": "a".repeat(300), "b.txt": "b".repeat(300), "c.txt": "c".repeat(100) });
  const budget = 450;
  const expected = await reference.parseRecursive(container, { filename: "t.zip", unpackBytes: budget });
  const sizes = (records: readonly ParseRecord[]): Array<number | null> => records.map((r) => r.bytes?.length ?? null);
  assert.deepEqual(sizes(expected), [null, 300, null, 100], "the second would take the total to 600");
  await withStandard({}, async ({ ripstream }) => {
    assert.deepEqual(sizes(await ripstream.parseRecursive(container, { filename: "t.zip", unpackBytes: budget })), sizes(expected));
  });
});

test("parseRecursive without unpackBytes brings back no bytes", async () => {
  const container = storedZip({ "a.txt": "hello" });
  await withStandard({}, async ({ ripstream }) => {
    const records = await ripstream.parseRecursive(container, { filename: "t.zip" });
    assert.ok(records.every((r) => r.bytes === undefined));
  });
});

// ---- 3. the restricted in-process ripstream covers exactly the allowlist ---------------------------------------------

/**
 * One sample per DEFAULT_IN_PROCESS_TYPES entry: [allowlisted type, what the detector says about the sample, filename,
 * body]. The detector cannot produce two of the twelve: the Tika registry has no application/ld+json (a .jsonld file is
 * text/plain) and text/xml is an alias that it normalizes to application/xml. Routing therefore never sees those two
 * names; the samples below are what such files look like to it, and the restricted parsers still claim both names.
 */
const XML = '<?xml version="1.0"?><note><to>Ada</to><body>hello xml</body></note>';
const TYPE_CASES: readonly (readonly [allowlisted: string, detected: string, filename: string, body: string])[] = [
  ["text/plain", "text/plain", "a.txt", "hello plain text"],
  ["text/csv", "text/csv", "a.csv", "name,age\nAda,36\nGrace,45\n"],
  ["text/tab-separated-values", "text/tab-separated-values", "a.tsv", "name\tage\nAda\t36\nGrace\t45\n"],
  ["text/html", "text/html", "a.html", "<html><head><title>T</title></head><body><p>hello html</p></body></html>"],
  [
    "application/xhtml+xml",
    "application/xhtml+xml",
    "a.xhtml",
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>T</title></head><body><p>hello xhtml</p></body></html>',
  ],
  ["text/markdown", "text/markdown", "a.md", "# Title\n\nhello *markdown*\n"],
  ["application/json", "application/json", "a.json", '{"greeting":"hello json"}'],
  ["application/ld+json", "text/plain", "a.jsonld", '{"@context":"https://schema.org","@type":"Person","name":"Ada"}'],
  ["application/manifest+json", "application/manifest+json", "a.webmanifest", '{"name":"My App","start_url":"/"}'],
  ["text/x-yaml", "text/x-yaml", "a.yaml", "greeting: hello yaml\nitems:\n  - one\n"],
  ["text/xml", "application/xml", "noname", XML],
  ["application/xml", "application/xml", "a.xml", XML],
];

test("the restricted parsers claim every media type on the in-process allowlist, and the samples cover all of them", async () => {
  assert.deepEqual(new Set(TYPE_CASES.map(([allowlisted]) => allowlisted)), DEFAULT_IN_PROCESS_TYPES);
  const claimed = new Set(
    [...(await new CompositeParser({ parsers: createInProcessParsers() }).getSupportedTypes(new ParseContext()))].map((t) => t.toString()),
  );
  const unclaimed = [...DEFAULT_IN_PROCESS_TYPES].filter((type) => !claimed.has(type));
  assert.deepEqual(unclaimed, [], "every allowlisted type needs a parser in the restricted list");
});

const restricted = createInProcessRipstream();

for (const [allowlisted, detected, filename, body] of TYPE_CASES) {
  test(`restricted ripstream: ${allowlisted} (${filename}) gives the full ripstream's text and metadata`, async () => {
    const bytes = encoder.encode(body);
    assert.equal((await reference.detect(bytes, { filename })).toString(), detected, "what the detector says about the sample");
    const expected = await referenceText(bytes, filename);
    assert.ok(expected.text.trim().length > 0, "the fixture itself must parse");
    const answer = await restricted.parse(bytes, { filename });
    assert.equal(answer.text, expected.text);
    assert.deepEqual(wireMetadata(answer.metadata), expected.metadata);
  });
}

test("all twelve samples are routed to this process by the standard isolation, with no child", async () => {
  await withStandard({}, async ({ ripstream }) => {
    const before = settled.length;
    for (const [allowlisted, , filename, body] of TYPE_CASES) {
      const bytes = encoder.encode(body);
      const answer = await ripstream.parse(bytes, { filename });
      assert.equal(answer.text, (await referenceText(bytes, filename)).text, allowlisted);
    }
    assert.equal(settled.length - before, 0, "no child ran for any allowlisted type");
  });
});

// ---- 4. polyglot: the in-process ripstream cannot be talked into a container parser -----------------------------------

const ZIP_MARKER = "notes-inside-the-zip.txt";

/** Entries a ripstream produced for the zip's members: embedded records, or the marker file's name anywhere in a path. */
function zipEntryRecords(records: readonly ParseRecord[]): ParseRecord[] {
  return records.filter((r) => r.depth > 0 || r.embeddedResourcePath.includes(ZIP_MARKER));
}

test("polyglot: >64 KiB of text followed by a zip never has its entries produced by an in-process parse", async (t: TestContext) => {
  const zip = storedZip({ [ZIP_MARKER]: "hidden inside the zip", "second.txt": "second member" });
  const prefix = Buffer.from("lorem ipsum dolor sit amet\n".repeat(3000)); // 81,000 bytes of ASCII
  const polyglot = Buffer.concat([prefix, zip]);
  assert.ok(prefix.length > 64 * 1024, "the text part must be longer than the routing prefix");
  assert.deepEqual(Buffer.from(polyglot.subarray(polyglot.length - zip.length)), Buffer.from(zip), "the zip is the file's tail");
  assert.ok(
    zipEntryRecords(await reference.parseRecursive(zip, { filename: "bundle.zip" })).length >= 2,
    "the zip alone does expand into entry records, so their absence below means something",
  );

  const detected = (await reference.detect(polyglot, { filename: "poly.txt" })).getBaseType();
  await withStandard({}, async ({ ripstream }) => {
    const before = settled.length;
    let records: readonly ParseRecord[] = [];
    let outcome = "records";
    try {
      records = await ripstream.parseRecursive(polyglot, { filename: "poly.txt" });
    } catch (error) {
      // Allowed only for an in-process parse that refused the file; a child's failure is not one (see below).
      assert.ok(error instanceof UnsupportedFormatError, `unexpected failure: ${String(error)}`);
      outcome = "UnsupportedFormatError";
    }
    const children = settled.length - before;
    t.diagnostic(
      `full detector on the whole file: ${detected.type}/${detected.subtype}; children run: ${children}; outcome: ${outcome}; ` +
        `records: ${records.map((r) => `${r.embeddedResourcePath} ${r.mediaType.toString()}`).join(", ")}`,
    );
    if (children === 0) {
      assert.deepEqual(zipEntryRecords(records), [], "parsed in this process, so the zip must not have been opened");
    } else {
      assert.equal(children, 1, "routed to a child: exactly one");
      assert.equal(outcome, "records", "a child parsed the zip");
    }
  });
});

test("polyglot: even an allowlist widened to application/zip cannot open a zip in this process (no zip parser is in the restricted set)", async () => {
  const zip = storedZip({ [ZIP_MARKER]: "hidden inside the zip" });
  await withStandard({ inProcessTypes: new Set([...DEFAULT_IN_PROCESS_TYPES, "application/zip"]) }, async ({ ripstream }) => {
    const before = settled.length;
    await assert.rejects(ripstream.parseRecursive(zip, { filename: "bundle.zip" }), (error: unknown) => {
      assert.ok(error instanceof UnsupportedFormatError, String(error));
      assert.match(error.message, /application\/zip/);
      return true;
    });
    assert.equal(settled.length - before, 0, "the request really was routed in-process, not to a child");
  });
});

// ---- 5. the mode in force decides what the in-process ripstream may be ------------------------------------------------

test('mode "off": everything is parsed in this process, binary formats included, and nothing is spawned', async () => {
  await withStandard({ config: { mode: "off" } }, async ({ isolator, ripstream }) => {
    assert.equal(isolator.status().mode, "off");
    const before = settled.length;
    for (const [filename, input] of [
      ["a.txt", encoder.encode("plain text")],
      ["a.docx", docx(["In-process DOCX paragraph"])],
      ["a.pdf", pdf("In-process PDF text")],
    ] as const) {
      const answer = await ripstream.parse(input, { filename });
      assert.equal(answer.text, (await referenceText(input, filename)).text, filename);
    }
    assert.equal(settled.length - before, 0, "nothing was spawned");
  });
});

test("a lenient isolator that found isolation unavailable parses everything in this process, as its warning says", async () => {
  const warnings: string[] = [];
  await withStandard(
    {
      config: { mode: "lenient" },
      probe: async () => ({ available: false, reason: "test: no isolation here" }),
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    },
    async ({ isolator, ripstream }) => {
      assert.equal(isolator.status().degraded, true);
      assert.equal(isolator.status().mode, "off");
      assert.equal(warnings.length, 1);
      const input = docx(["Degraded DOCX paragraph"]);
      const answer = await ripstream.parse(input, { filename: "a.docx" });
      assert.match(answer.text, /Degraded DOCX paragraph/);
      assert.equal(answer.text, (await referenceText(input, "a.docx")).text);
    },
  );
});

// ---- 6. the child's disk (L6) ----------------------------------------------------------------------------------------

test("a zip whose stored PDF entry makes the child spool past the disk budget is a LimitExceededError that names it, and leaves no temp directory", async () => {
  // An entry the child spools to disk (RipstreamInputStream writes anything above 1 MiB to TMPDIR) before a parser
  // looks at it. The directory is the test's own, so "nothing left behind" is checked on it and never on os.tmpdir().
  const tempDir = mkdtempSync(join(tmpdir(), "ripstream-standard-disk-"));
  try {
    const entry = Buffer.alloc(40 * 1024 * 1024, 0x41);
    entry.write("%PDF-1.4\n");
    const input = storedZip({ "evil.pdf": entry });
    await withStandard(
      { config: { mode: "strict", maxDiskMb: 20 }, tempDir, runner: { onRunSettled: (d) => settled.push(d), diskPollMs: 20 } },
      async ({ ripstream }) => {
        const before = settled.length;
        await assert.rejects(ripstream.parse(input, { filename: "evil.zip" }), (error: unknown) => {
          assert.ok(error instanceof LimitExceededError, String(error));
          assert.match(error.message, /temporary disk budget of 20 MiB exceeded/);
          return true;
        });
        assert.equal(settled.length - before, 1, "one child ran");
        assert.equal(settled.at(-1)?.killReason, "disk");
      },
    );
    assert.deepEqual(readdirSync(tempDir), [], "the call directory is removed once the child is gone");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- 5. a configuration crosses the boundary --------------------------------------------------------------------------

/** What a parse comes to, so that a refusal can be compared with a refusal: the text and type, or the name of the error. */
async function outcomeOf(
  run: () => Promise<{ readonly text: string; readonly metadata: Metadata }>,
): Promise<{ text: string; type: string | null } | { error: string }> {
  try {
    const { text, metadata } = await run();
    return { text, type: metadata.get("Content-Type") ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.name : String(error) };
  }
}

const NO_ZIP = loadConfig({ parsers: [{ "default-parser": { exclude: ["zip-parser"] } }] });
const NO_ZIP_CONTAINER = loadConfig({ detectors: [{ "default-detector": { exclude: ["default-zip-container-detector"] } }] });
const NO_MARKDOWN = loadConfig({ parsers: [{ "default-parser": { exclude: ["markdown-parser"] } }] });

test("a parsers section reaches the child: a zip parses as the in-process pipeline parses it under the same section", async () => {
  const archive = storedZip({ "x.txt": "inside the archive" });
  assert.match((await referenceText(archive, "a.zip")).text, /inside the archive/, "without the section the entry is read");
  const configured = createRipstream({ config: NO_ZIP });
  const expected = await outcomeOf(() => configured.parse(archive, { filename: "a.zip" }));
  assert.ok(!("text" in expected) || !/inside the archive/.test(expected.text), "the section changes the in-process answer");

  await withStandard({ ripstreamConfig: NO_ZIP }, async ({ ripstream }) => {
    const before = settled.length;
    assert.deepEqual(await outcomeOf(() => ripstream.parse(archive, { filename: "a.zip" })), expected);
    assert.equal(settled.length - before, 1, "it was the child that parsed it");
  });
});

test("a detectors section reaches the router, detect() and the child", async () => {
  // No filename: the zip container detector is what tells a DOCX from any other zip.
  const input = docx(["Isolated DOCX paragraph"]);
  const configured = createRipstream({ config: NO_ZIP_CONTAINER });
  const expectedType = (await configured.detect(input)).toString();
  const defaultType = (await reference.detect(input)).toString();
  assert.notEqual(expectedType, defaultType, "the section changes what the detector says");
  const expected = await outcomeOf(() => configured.parse(input));
  assert.notDeepEqual(expected, await outcomeOf(() => reference.parse(input)), "and the type the parse reports");

  await withStandard({ ripstreamConfig: NO_ZIP_CONTAINER }, async ({ ripstream }) => {
    assert.equal((await ripstream.detect(input)).toString(), expectedType);
    const before = settled.length;
    assert.deepEqual(await outcomeOf(() => ripstream.parse(input)), expected);
    assert.equal(settled.length - before, 1);
  });
});

test("the in-process parsers honour a parsers section: with markdown turned off, markdown is read as the pipeline reads it then", async () => {
  const markdown = encoder.encode("# Title\n\nhello *markdown*\n");
  const rendered = await outcomeOf(() => reference.parse(markdown, { filename: "a.md" }));
  const expected = await outcomeOf(() => createRipstream({ config: NO_MARKDOWN }).parse(markdown, { filename: "a.md" }));
  assert.notDeepEqual(expected, rendered, "the section changes the answer: the markup is no longer rendered");

  await withStandard({ ripstreamConfig: NO_MARKDOWN }, async ({ ripstream }) => {
    const before = settled.length;
    assert.deepEqual(await outcomeOf(() => ripstream.parse(markdown, { filename: "a.md" })), expected);
    assert.equal(settled.length - before, 0, "markdown stays in this process");
    // Text is still parsed here: only what the section names is off.
    assert.match((await ripstream.parse(encoder.encode("plain"), { filename: "a.txt" })).text, /plain/);
  });
});

test("the restriction survives a configuration: the in-process parsers still never own a container", async () => {
  // default-parser with nothing excluded is the whole default set, which must not widen what runs here.
  const config = loadConfig({ parsers: [{ "default-parser": {} }] });
  const archive = storedZip({ "x.txt": "inside the archive" });
  await withStandard({ ripstreamConfig: config }, async ({ ripstream }) => {
    const before = settled.length;
    assert.match((await ripstream.parse(archive, { filename: "a.zip" })).text, /inside the archive/);
    assert.equal(settled.length - before, 1, "a zip still goes to a child");
  });
});

test("limits are the defaults of every parse: a nested zip is refused at maxNodeDepth, and parses one level deeper", async () => {
  const nested = storedZip({ "inner.zip": storedZip({ "deep.txt": "deepest text" }) });
  await withStandard({ limits: { maxNodeDepth: 1 } }, async ({ ripstream }) => {
    await assert.rejects(ripstream.parse(nested, { filename: "outer.zip" }), (error: unknown) => error instanceof LimitExceededError && /depth/i.test(error.message));
    // A limit the call names itself wins over the default.
    assert.match((await ripstream.parse(nested, { filename: "outer.zip", limits: { maxNodeDepth: 3 } })).text, /deepest text/);
  });
  await withStandard({ limits: { maxNodeDepth: 3 } }, async ({ ripstream }) => {
    assert.match((await ripstream.parse(nested, { filename: "outer.zip" })).text, /deepest text/);
  });
});

test("a configured parse timer below the isolation's own crosses; one above it is refused when the isolation is built", async () => {
  await withStandard({ limits: { maxParseMillis: 5000 } }, async ({ ripstream }) => {
    assert.match((await ripstream.parse(storedZip({ "x.txt": "inside" }), { filename: "a.zip" })).text, /inside/);
  });
  await assert.rejects(
    createStandardIsolation({ config: { mode: "strict", maxTaskMillis: 10_000 }, pool, limits: { maxParseMillis: 10_000 } }),
    (error: unknown) => error instanceof RangeError && /maxTaskMillis/.test(error.message),
  );
});

test("limits that cannot be isolated are refused when the isolation is built, not at the first parse", async () => {
  await assert.rejects(
    createStandardIsolation({ config: { mode: "strict" }, pool, limits: { maxOutputChars: -1 } }),
    (error: unknown) => error instanceof RangeError && /maxOutputChars -1 \(unlimited\) cannot be isolated/.test(error.message),
  );
  await assert.rejects(createStandardIsolation({ config: { mode: "strict" }, pool, limits: { maxZipEntries: 5 } }), /maxZipEntries/);
  // With isolation off there is no child to size, so the same limits are fine.
  const off = await createStandardIsolation({ config: { mode: "off" }, pool, limits: { maxOutputChars: -1 } });
  await off.isolator.dispose();
});

const ACME_PACK = `<?xml version="1.0"?><mime-info><mime-type type="application/x-acme-pack">
  <sub-class-of type="application/zip"/><glob pattern="*.acmepack"/></mime-type></mime-info>`;

function customMimeTypesFile(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ripstream-custom-mimetypes-"));
  const path = join(directory, "custom-mimetypes.xml");
  writeFileSync(path, text);
  return path;
}

test("custom media types reach the router, detect() and the child, which is handed the text and never reads the file", async () => {
  const path = customMimeTypesFile(ACME_PACK);
  const config = loadConfig({ "custom-mimetypes": path });
  const archive = storedZip({ "x.txt": "inside the archive" });
  const configured = createRipstream({ config });
  const expected = await outcomeOf(() => configured.parse(archive, { filename: "a.acmepack" }));
  assert.deepEqual(expected, { text: (await referenceText(archive, "a.zip")).text, type: "application/x-acme-pack" });
  assert.notDeepEqual(await outcomeOf(() => reference.parse(archive, { filename: "a.acmepack" })), expected, "the file changes the answer");

  await withStandard({ ripstreamConfig: config }, async ({ ripstream }) => {
    // The child is given the text: take the file away and nothing it needs is gone.
    rmSync(join(path, ".."), { recursive: true });
    assert.equal((await ripstream.detect(archive, { filename: "a.acmepack" })).toString(), "application/x-acme-pack");
    const before = settled.length;
    assert.deepEqual(await outcomeOf(() => ripstream.parse(archive, { filename: "a.acmepack" })), expected);
    assert.equal(settled.length - before, 1, "it was the child that parsed it, as an application/x-acme-pack");
  });
});

test("a pdf-parser setting reaches the child: the same PDF reads in the order the configuration asks for", async () => {
  // Drawn bottom line first: the text reads Top first with sortByPosition (ripstream's default), Bottom first without.
  const bytes = pdfOfContent("BT /F1 12 Tf 72 600 Td (Bottom line) Tj ET\nBT /F1 12 Tf 72 700 Td (Top line) Tj ET");
  const order = (text: string): string => (text.indexOf("Top line") < text.indexOf("Bottom line") ? "top first" : "bottom first");
  const config = loadConfig({ parsers: [{ "pdf-parser": { sortByPosition: false } }] });
  assert.equal(order((await createRipstream({ config }).parse(bytes, { filename: "a.pdf" })).text), "bottom first");
  assert.equal(order((await reference.parse(bytes, { filename: "a.pdf" })).text), "top first");

  await withStandard({ ripstreamConfig: config }, async ({ ripstream }) => {
    const before = settled.length;
    assert.equal(order((await ripstream.parse(bytes, { filename: "a.pdf" })).text), "bottom first");
    assert.equal(settled.length - before, 1, "it was the child that parsed it");
  });
  await withStandard({}, async ({ ripstream }) => {
    assert.equal(order((await ripstream.parse(bytes, { filename: "a.pdf" })).text), "top first");
  });
});

test("a parsers section that names a parser only the child has is applied here too, not refused", async () => {
  // Only pdf-parser is on: text is not parsed by the full ripstream, so the in-process one must not parse it either.
  const config = loadConfig({ parsers: [{ "pdf-parser": {} }] });
  const text = encoder.encode("plain words");
  const expected = await outcomeOf(() => createRipstream({ config }).parse(text, { filename: "a.txt" }));
  assert.ok("error" in expected, "the section turns text off");
  await withStandard({ ripstreamConfig: config }, async ({ ripstream }) => {
    assert.deepEqual(await outcomeOf(() => ripstream.parse(text, { filename: "a.txt" })), expected);
    assert.match((await ripstream.parse(pdf("Hello PDF"), { filename: "a.pdf" })).text, /Hello PDF/);
  });
});

test("a missing or malformed custom-mimetypes file fails when the isolation is built, naming the file", async () => {
  await assert.rejects(
    createStandardIsolation({ config: { mode: "strict" }, pool, ripstreamConfig: loadConfig({ "custom-mimetypes": "/nonexistent/types.xml" }) }),
    (error) => error instanceof RipstreamConfigError && /does not exist/.test(error.message) && error.message.includes("/nonexistent/types.xml"),
  );
  const bad = customMimeTypesFile(`<mime-info><mime-type type="application/x-bad"><glop/></mime-type></mime-info>`);
  await assert.rejects(
    createStandardIsolation({ config: { mode: "strict" }, pool, ripstreamConfig: loadConfig({ "custom-mimetypes": bad }) }),
    (error) => error instanceof RipstreamConfigError && /<glop> is not a <mime-type> child/.test(error.message),
  );
});

test("custom media types too large for the request header are refused when the isolation is built", async () => {
  const types = Array.from({ length: 400 }, (_, index) => `<mime-type type="application/x-t${index}"><glob pattern="*.t${index}"/></mime-type>`);
  const path = customMimeTypesFile(`<mime-info>${types.join("")}</mime-info>`);
  await assert.rejects(
    createStandardIsolation({ config: { mode: "strict" }, pool, ripstreamConfig: loadConfig({ "custom-mimetypes": path }) }),
    /components are \d+ bytes as JSON.*custom-mimetypes file/,
  );
  // Without isolation there is no header: the same file is read and used.
  await withStandard({ config: { mode: "off" }, ripstreamConfig: loadConfig({ "custom-mimetypes": path }) }, async ({ ripstream }) => {
    assert.equal((await ripstream.detect(new Uint8Array([0, 1, 2]), { filename: "a.t399" })).toString(), "application/x-t399");
  });
});

// ---- digests (tikajs-68os.9.1) --------------------------------------------------------------------------------------

const DIGESTS = loadConfig({ "parse-context": { "commons-digester-factory": { digests: [{ algorithm: "MD5" }, { algorithm: "SHA256", encoding: "BASE32" }] } } });
const DIGESTS_SKIP_CONTAINER = loadConfig({
  "parse-context": { "commons-digester-factory": { digests: [{ algorithm: "MD5" }], skipContainerDocumentDigest: true } },
});
const TIKA_DOCX = readFileSync(fileURLToPath(new URL("./fixtures/tika/test_recursive_embedded.docx", import.meta.url)));
// Apache Tika's DigestConfigTest: the MD5 of that document.
const TIKA_DOCX_MD5 = "59f626e09a8c16ab6dbc2800c685f772";

test("the digests of a configuration cross the boundary: a child gives a zip's records the digests the pipeline gives in-process", async () => {
  const archive = storedZip({ "a.txt": "first entry", "b.txt": "second entry" });
  const expected = (await createRipstream({ config: DIGESTS }).parseRecursive(archive, { filename: "a.zip" })).map(comparable);
  await withStandard({ ripstreamConfig: DIGESTS }, async ({ ripstream }) => {
    const before = settled.length;
    const records = await ripstream.parseRecursive(archive, { filename: "a.zip" });
    assert.equal(settled.length - before, 1, "it was a child that parsed it");
    assert.deepEqual(records.map(comparable), expected);
    assert.equal(records.length, 3);
    for (const record of records) {
      assert.match(record.metadata.get("tk:digest:MD5") ?? "", /^[0-9a-f]{32}$/, record.embeddedResourcePath || "container");
      assert.match(record.metadata.get("tk:digest:SHA-256:BASE32") ?? "", /^[A-Z2-7]{52}=*$/, record.embeddedResourcePath || "container");
    }
  });
});

test("each embedded document's digest is the digest of its own bytes: a nested archive and an empty entry too, in a child and not", async () => {
  const deep = "the deepest entry";
  const inner = storedZip({ "deep.txt": deep });
  const archive = storedZip({ "a.txt": "first entry", "empty.txt": "", "inner.zip": inner });
  const md5 = (bytes: string | Uint8Array): string => createHash("md5").update(bytes).digest("hex");
  const expected = new Map<string, string>([
    ["/a.zip", md5(archive)],
    ["/a.zip/a.txt", md5("first entry")],
    ["/a.zip/empty.txt", md5("")],
    ["/a.zip/inner.zip", md5(inner)],
    ["/a.zip/inner.zip/deep.txt", md5(deep)],
  ]);
  const digests = (records: readonly ParseRecord[]): Map<string, string | null> =>
    new Map(records.map((record) => [record.embeddedResourcePath, record.metadata.get("tk:digest:MD5")]));
  assert.deepEqual(digests(await createRipstream({ config: DIGESTS }).parseRecursive(archive, { filename: "a.zip" })), expected, "in this process");
  await withStandard({ ripstreamConfig: DIGESTS }, async ({ ripstream }) => {
    const before = settled.length;
    const records = await ripstream.parseRecursive(archive, { filename: "a.zip" });
    assert.equal(settled.length - before, 1, "it was a child that parsed it");
    assert.deepEqual(digests(records), expected, "in a child");
  });
});

test("a child digests Tika's own test document to Tika's MD5, and parse() carries it too", async () => {
  await withStandard({ ripstreamConfig: DIGESTS }, async ({ ripstream }) => {
    const before = settled.length;
    const { metadata } = await ripstream.parse(TIKA_DOCX, { filename: "test_recursive_embedded.docx" });
    assert.equal(settled.length - before, 1, "an office document is a child's");
    assert.equal(metadata.get("tk:digest:MD5"), TIKA_DOCX_MD5);
  });
});

test("skipContainerDocumentDigest crosses the boundary: the container has no digest and what is embedded has", async () => {
  const archive = storedZip({ "a.txt": "first entry" });
  await withStandard({ ripstreamConfig: DIGESTS_SKIP_CONTAINER }, async ({ ripstream }) => {
    const [container, entry] = await ripstream.parseRecursive(archive, { filename: "a.zip" });
    assert.equal(container?.metadata.get("tk:digest:MD5"), null);
    assert.match(entry?.metadata.get("tk:digest:MD5") ?? "", /^[0-9a-f]{32}$/);
  });
});

test("what stays in this process is digested too: text gets the digests the pipeline gives", async () => {
  const text = encoder.encode("plain words");
  const expected = await createRipstream({ config: DIGESTS }).parse(text, { filename: "a.txt" });
  await withStandard({ ripstreamConfig: DIGESTS }, async ({ ripstream }) => {
    const before = settled.length;
    const answer = await ripstream.parse(text, { filename: "a.txt" });
    assert.equal(settled.length - before, 0, "no child ran for text/plain");
    assert.equal(answer.metadata.get("tk:digest:MD5"), expected.metadata.get("tk:digest:MD5"));
    assert.match(answer.metadata.get("tk:digest:MD5") ?? "", /^[0-9a-f]{32}$/);
  });
});

test("with isolation off the full pipeline digests, and without a digester factory nothing is written", async () => {
  await withStandard({ config: { mode: "off" }, ripstreamConfig: DIGESTS }, async ({ ripstream }) => {
    assert.equal((await ripstream.parse(TIKA_DOCX, { filename: "t.docx" })).metadata.get("tk:digest:MD5"), TIKA_DOCX_MD5);
  });
  await withStandard({}, async ({ ripstream }) => {
    const { metadata } = await ripstream.parse(storedZip({ "a.txt": "x" }), { filename: "a.zip" });
    assert.deepEqual(metadata.names().filter((name) => name.startsWith("tk:digest:")), []);
  });
});
