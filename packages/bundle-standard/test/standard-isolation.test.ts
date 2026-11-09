import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import {
  DEFAULT_IN_PROCESS_TYPES,
  MemoryPool,
  type RunDiagnostics,
} from "@spikedpunch/ripstream-isolation-node";
import {
  CompositeParser,
  ParseContext,
  UnsupportedFormatError,
  createRipstream,
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
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
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
const TIMING_KEY = "X-TIKA:parse_time_millis";

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
