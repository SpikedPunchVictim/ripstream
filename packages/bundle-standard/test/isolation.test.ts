import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import {
  ChildRunner,
  MemoryPool,
  createNodeIsolator,
  type NodeIsolator,
  type NodeIsolatorOptions,
  type RunDiagnostics,
} from "@spikedpunch/ripstream-isolation-node";
import {
  LimitExceededError,
  RipstreamError,
  createRipstream,
  type IsolatedParseRecord,
  type IsolatedParseRequest,
  type IsolatedParseResult,
  type Metadata,
  type ParseRecord,
} from "../src/index.ts";
import { isolationChildPath } from "../src/isolation.ts";

/**
 * End to end: the real ChildRunner spawns the real standard child (src/isolation-child.ts: runChildMain around
 * createRipstream()), and every answer is compared with what the same pipeline gives in-process.
 */

const MIB = 1024 * 1024;
const encoder = new TextEncoder();

const settled: RunDiagnostics[] = [];
const runner = new ChildRunner({
  pool: new MemoryPool({ poolMb: 16_384, overshootMb: 0, maxQueue: 8 }),
  childScript: isolationChildPath(),
  perChildMb: 1024,
  heapMb: 256,
  cpuSecs: 120,
  maxTaskMillis: 60_000,
  maxInputBytes: 16 * MIB,
  maxResultBytes: 16 * MIB,
  rssLimitMb: 1024,
  onRunSettled: (d) => settled.push(d),
});

after(async () => {
  await runner.dispose();
  // A parser that leaked a handle would keep the child alive after its terminal frame until the grace kill.
  assert.deepEqual(
    settled.filter((d) => d.graceKilled).map((d) => d.pid),
    [],
    "a child needed the grace kill: something kept its event loop alive",
  );
});

// ---- fixtures, built by hand so that this package needs no fixture libraries ---------------------------------------

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

function docx(paragraphs: readonly string[], creator = "Ada"): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return storedZip({
    "[Content_Types].xml":
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${OFFICE_RELS}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    "docProps/core.xml":
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Isolation Doc</dc:title><dc:creator>' + creator + '</dc:creator></cp:coreProperties>',
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

const csv = (): Uint8Array => encoder.encode("name,age,city\nAda,36,London\nGrace,45,New York\n\"Smith, J\",50,Paris\n");
const html = (): Uint8Array =>
  encoder.encode("<html><head><title>Isolated page</title></head><body><h1>Heading</h1><p>Hello <b>html</b> world</p></body></html>");

// ---- the in-process reference ---------------------------------------------------------------------------------------

type WireMetadata = Record<string, readonly string[]>;

function wireMetadata(metadata: Metadata): WireMetadata {
  return Object.fromEntries(metadata.names().map((name) => [name, [...metadata.getAll(name)]]));
}

/** Core stamps each record with how long its parse took: the one metadata key that cannot be equal across two runs. */
const TIMING_KEY = "tk:parse-time-millis";

function withoutTiming(record: IsolatedParseRecord): IsolatedParseRecord {
  const { [TIMING_KEY]: _timing, ...metadata } = record.metadata;
  return { ...record, metadata };
}

function wireRecord(record: ParseRecord): IsolatedParseRecord {
  const error = record.exception as { name?: string; message?: string; code?: string } | null;
  return {
    metadata: wireMetadata(record.metadata),
    content: record.content,
    embeddedResourcePath: record.embeddedResourcePath,
    depth: record.depth,
    mediaType: record.mediaType.toString(),
    exception:
      error === null
        ? null
        : { name: String(error.name), message: String(error.message), ...(typeof error.code === "string" ? { code: error.code } : {}) },
  };
}

const inProcess = createRipstream();

interface Limits {
  readonly maxOutputChars?: number;
  readonly maxEmbeddedResources?: number;
}

async function referenceText(bytes: Uint8Array, filename: string, limits: Limits = {}): Promise<{ text: string; metadata: WireMetadata }> {
  const result = await inProcess.parse(bytes, { filename, limits });
  return { text: result.text, metadata: wireMetadata(result.metadata) };
}

async function isolated(request: IsolatedParseRequest): Promise<IsolatedParseResult> {
  return runner.run(request);
}

async function isolatedText(request: IsolatedParseRequest): Promise<{ text: string; metadata: WireMetadata }> {
  const result = await isolated({ ...request, output: "text" });
  assert.equal(result.kind, "text");
  return { text: (result as { text: string }).text, metadata: (result as { metadata: WireMetadata }).metadata };
}

/** The class and code of a failure, or "ok": what must be the same in-process and isolated. */
async function outcomeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "ok";
  } catch (error) {
    return error instanceof RipstreamError ? `${error.constructor.name}/${error.code}` : `non-ripstream: ${String(error)}`;
  }
}

// ---- text parity -----------------------------------------------------------------------------------------------------

const TEXT_CASES: readonly (readonly [name: string, filename: string, bytes: () => Uint8Array, expected: RegExp])[] = [
  ["docx", "report.docx", () => docx(["Hello isolated DOCX", "Second paragraph"]), /Hello isolated DOCX/],
  ["pdf", "paper.pdf", () => pdf("Hello isolated PDF"), /Hello isolated PDF/],
  ["csv", "table.csv", csv, /Grace/],
  ["html", "page.html", html, /Hello/],
];

for (const [name, filename, bytes, expected] of TEXT_CASES) {
  test(`text parity: ${name} gives the same text and metadata isolated as in-process`, async () => {
    const input = bytes();
    const reference = await referenceText(input, filename);
    assert.match(reference.text, expected, "the fixture itself must parse");
    const answer = await isolatedText({ input, filename });
    assert.equal(answer.text, reference.text);
    assert.deepEqual(answer.metadata, reference.metadata);
  });
}

test("a { path } input is parsed the same as the bytes (core reads the file inside the child)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isolation-e2e-"));
  try {
    const input = docx(["From a file path"]);
    const file = join(dir, "from-path.docx");
    await writeFile(file, input);
    const reference = await referenceText(input, "from-path.docx");
    const answer = await isolatedText({ input: { path: file }, filename: "from-path.docx" });
    assert.match(answer.text, /From a file path/);
    assert.equal(answer.text, reference.text);
    assert.deepEqual(answer.metadata, reference.metadata);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- records parity: every embedded document, one child -------------------------------------------------------------

test("records parity: a container with embedded documents gives the same records, from ONE child", async () => {
  const container = storedZip({
    "notes.txt": "Plain notes inside the archive",
    "table.csv": csv(),
    "page.html": html(),
    "inner/report.docx": docx(["Embedded DOCX paragraph"]),
  });
  const reference = (await inProcess.parseRecursive(container, { filename: "bundle.zip" })).map(wireRecord);
  assert.ok(reference.length >= 5, `expected the container and its 4 parts, got ${reference.length}`);

  const spawnsBefore = settled.length;
  const result = await isolated({ input: container, filename: "bundle.zip", output: "records" });
  assert.equal(result.kind, "records");
  const records = (result as { records: readonly IsolatedParseRecord[] }).records;

  assert.equal(settled.length - spawnsBefore, 1, "one run, one child, for the container and all of its embedded documents");
  assert.deepEqual(
    records.map((r) => [r.embeddedResourcePath, r.depth, r.mediaType]),
    reference.map((r) => [r.embeddedResourcePath, r.depth, r.mediaType]),
  );
  for (const record of records) assert.match(String(record.metadata[TIMING_KEY]?.[0]), /^\d+$/, `${record.embeddedResourcePath} has a timing`);
  assert.deepEqual(records.map(withoutTiming), reference.map(withoutTiming));
  assert.ok(records.some((r) => /Embedded DOCX paragraph/.test(r.content)), "the nested document's text is in its record");
});

// ---- output cap parity and streaming ---------------------------------------------------------------------------------

test("output cap: the same LimitExceededError isolated as in-process, with the same message", async () => {
  const input = encoder.encode("word ".repeat(5000));
  const limits = { maxOutputChars: 100 };
  const reference = await inProcess.parse(input, { filename: "long.txt", limits }).then(
    () => assert.fail("in-process should exceed the cap"),
    (e: unknown) => e,
  );
  assert.ok(reference instanceof LimitExceededError);
  const answer = await isolated({ input, filename: "long.txt", ...limits }).then(
    () => assert.fail("isolated should exceed the cap"),
    (e: unknown) => e,
  );
  assert.ok(answer instanceof LimitExceededError, String(answer));
  assert.equal(answer.constructor, reference.constructor);
  assert.equal(answer.code, reference.code);
  assert.equal(answer.message, reference.message);
});

test("streaming: a small cap on a large input stops the parse early (no full text is built, no memory kill)", async () => {
  const input = encoder.encode("lorem ipsum dolor sit amet\n".repeat(200_000)); // ~5.3 MB
  const before = settled.length;
  const error = await isolated({ input, filename: "big.txt", maxOutputChars: 1000 }).then(
    () => assert.fail("should exceed the cap"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof LimitExceededError, String(error));
  assert.match(error.message, /Output exceeds 1000/, "stopped by the output cap, not by a memory limit");
  const d = settled[settled.length - 1];
  assert.equal(settled.length - before, 1);
  assert.ok(d !== undefined && d.killReason === null, "the child answered by itself");
  assert.ok(d.fd3Bytes < 64 * 1024, `the answer was ${d.fd3Bytes} bytes: nothing of the document should have been sent`);
});

test("streaming: a large result under the cap comes back as many bounded frames, intact", async () => {
  const input = encoder.encode("lorem ipsum dolor sit amet\n".repeat(150_000)); // ~4 MB
  const limits = { maxOutputChars: 10_000_000 };
  const reference = await referenceText(input, "big.txt", limits);
  const answer = await isolatedText({ input, filename: "big.txt", ...limits });
  assert.equal(answer.text.length, reference.text.length);
  assert.equal(answer.text, reference.text);
  const d = settled[settled.length - 1];
  assert.ok(d !== undefined && d.frameCount > 40, `${d?.frameCount} frames for a ${reference.text.length}-char text: it should arrive in 64 KiB pieces`);
});

// ---- failures: the same class and code as in-process ---------------------------------------------------------------

const MALFORMED = "MalformedDocumentError/MALFORMED_DOCUMENT";
const UNSUPPORTED = "UnsupportedFormatError/UNSUPPORTED_FORMAT";

/** What an error of the in-process class arrives as across the boundary: a subclass crosses as the class of its code. */
const ZERO_BYTE = "ZeroByteFileError/MALFORMED_DOCUMENT";
const CROSSES_AS: Readonly<Record<string, string>> = { [ZERO_BYTE]: MALFORMED };

const FAILURE_CASES: readonly (readonly [name: string, filename: string, bytes: () => Uint8Array, expected: string])[] = [
  ["PDF header with garbage", "garbage.pdf", () => encoder.encode("%PDF-1.7\nthis is not a pdf at all\n"), MALFORMED],
  ["DOCX that is not a zip", "fake.docx", () => encoder.encode("PK\u0003\u0004 definitely not a zip file"), MALFORMED],
  ["empty input", "empty.bin", () => new Uint8Array(0), ZERO_BYTE],
  ["binary noise", "noise.bin", () => Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 17) & 0xff), UNSUPPORTED],
];

for (const [name, filename, bytes, expected] of FAILURE_CASES) {
  test(`failure parity: ${name} fails the same way isolated as in-process`, async () => {
    const input = bytes();
    const reference = await outcomeOf(() => inProcess.parse(input, { filename }));
    assert.equal(reference, expected, "the in-process outcome this case is meant to pin");
    const answer = await outcomeOf(() => isolated({ input, filename }));
    assert.equal(answer, CROSSES_AS[reference] ?? reference);
  });
}

// ---- recording a failure instead of throwing: the same answer in-process and from a child -------------------------------

for (const [name, filename, bytes] of FAILURE_CASES.filter(([, , , expected]) => expected !== UNSUPPORTED)) {
  test(`recorded failure parity: ${name} gives the same text and failure isolated as in-process`, async () => {
    const input = bytes();
    const reference = await inProcess.parse(input, { filename, onDocumentFailure: "record" });
    assert.ok(reference.exception !== undefined, "the in-process parse records the failure");
    const answer = await isolated({ input, filename, output: "text", recordFailures: true });
    assert.equal(answer.kind, "text");
    const text = answer as Extract<IsolatedParseResult, { kind: "text" }>;
    assert.equal(text.text, reference.text);
    assert.equal(text.exception?.name, reference.exception.name);
    assert.equal(text.exception?.message, reference.exception.message);
    assert.equal(text.exception?.code, "MALFORMED_DOCUMENT");
    assert.deepEqual(text.metadata["tk:exception:container-exception"], [`${reference.exception.name}: ${reference.exception.message}`]);
  });
}

test("recorded failure parity: records of an empty input carry the failure on the container, as in-process", async () => {
  const input = new Uint8Array(0);
  const [reference] = await inProcess.parseRecursive(input, { filename: "empty.bin", onDocumentFailure: "record" });
  const answer = await isolated({ input, filename: "empty.bin", output: "records", recordFailures: true });
  assert.equal(answer.kind, "records");
  const [record] = (answer as Extract<IsolatedParseResult, { kind: "records" }>).records;
  assert.equal(record?.exception?.name, reference?.exception?.name);
  assert.equal(record?.exception?.name, "ZeroByteFileError");
});

// ---- truncating at the output limit: the same answer in-process and from a child ----------------------------------------

test("truncation parity: text cut at the output limit is the same isolated as in-process, flagged the same way", async () => {
  const input = encoder.encode("The quick brown fox jumps over the lazy dog. ".repeat(40));
  const reference = await inProcess.parse(input, { filename: "long.txt", limits: { maxOutputChars: 100 }, onOutputLimit: "truncate" });
  assert.equal(reference.text.length, 100);
  assert.equal(reference.metadata.get("tk:exception:write-limit-reached"), "true");
  const answer = await isolated({ input, filename: "long.txt", output: "text", maxOutputChars: 100, truncateOutput: true });
  assert.equal(answer.kind, "text");
  const text = answer as Extract<IsolatedParseResult, { kind: "text" }>;
  assert.equal(text.text, reference.text);
  assert.deepEqual(text.metadata["tk:exception:write-limit-reached"], ["true"]);
});

test("truncation parity: without truncate the same input is a LimitExceededError from the child", async () => {
  const input = encoder.encode("The quick brown fox jumps over the lazy dog. ".repeat(40));
  assert.equal(await outcomeOf(() => isolated({ input, filename: "long.txt", output: "text", maxOutputChars: 100 })), "LimitExceededError/LIMIT_EXCEEDED");
});

test("truncation parity: records cut at the output limit are the records so far, as in-process", async () => {
  const input = encoder.encode("The quick brown fox jumps over the lazy dog. ".repeat(40));
  const [reference] = await inProcess.parseRecursive(input, { filename: "long.txt", limits: { maxOutputChars: 100 }, onOutputLimit: "truncate" });
  const answer = await isolated({ input, filename: "long.txt", output: "records", maxOutputChars: 100, truncateOutput: true });
  assert.equal(answer.kind, "records");
  const [record] = (answer as Extract<IsolatedParseResult, { kind: "records" }>).records;
  assert.equal(record?.content, reference?.content);
  assert.deepEqual(record?.metadata["tk:exception:write-limit-reached"], ["true"]);
  assert.equal(record?.exception, null);
});

// ---- the facade (createNodeIsolator) around the same child ----------------------------------------------------------

/** One pool for every facade test; each isolator is disposed by its test, the pool is never disposed by them. */
const facadePool = new MemoryPool({ poolMb: 16_384, maxQueue: 8 });
/** Diagnostics of the runs of the facades' own runners. */
const facadeSettled: RunDiagnostics[] = [];

async function withIsolator(
  overrides: Partial<NodeIsolatorOptions>,
  action: (isolator: NodeIsolator) => Promise<void>,
): Promise<void> {
  const isolator = await createNodeIsolator({
    config: { mode: "strict" },
    ripstream: inProcess,
    childModule: isolationChildPath(),
    pool: facadePool,
    runner: { onRunSettled: (d) => facadeSettled.push(d) },
    ...overrides,
  });
  try {
    await action(isolator);
  } finally {
    await isolator.dispose();
  }
}

test("facade: text with more than 1 MiB of metadata is isolated like it is in-process", async () => {
  // A 300,000-character CJK title is stored under two metadata keys: about 1.8 MB of JSON in the one meta frame.
  const input = encoder.encode(`<html><head><title>${"漢".repeat(300_000)}</title></head><body><p>body text</p></body></html>`);
  const limits = { maxOutputChars: 1_000_000 };
  const reference = await referenceText(input, "big-title.html", limits);
  assert.ok(Buffer.byteLength(JSON.stringify(reference.metadata)) > MIB, "the fixture must carry more than 1 MiB of metadata");
  await withIsolator({ inProcessTypes: new Set() }, async (isolator) => {
    const before = facadeSettled.length;
    const answer = await isolator.isolate({ input, filename: "big-title.html", ...limits });
    assert.equal(facadeSettled.length - before, 1, "it really went through a child");
    assert.equal(answer.kind, "text");
    assert.equal((answer as { text: string }).text, reference.text);
    assert.deepEqual((answer as { metadata: WireMetadata }).metadata, reference.metadata);
  });
});

test("facade: records give the same records as in-process, from one child", async () => {
  const container = storedZip({
    "notes.txt": "Plain notes inside the archive",
    "page.html": html(),
    "inner/report.docx": docx(["Embedded DOCX paragraph"]),
  });
  const reference = (await inProcess.parseRecursive(container, { filename: "bundle.zip" })).map(wireRecord);
  await withIsolator({}, async (isolator) => {
    const before = facadeSettled.length;
    const answer = await isolator.isolate({ input: container, filename: "bundle.zip", output: "records" });
    assert.equal(facadeSettled.length - before, 1, "one child for the container and all of its embedded documents");
    assert.equal(answer.kind, "records");
    const records = (answer as { records: readonly IsolatedParseRecord[] }).records;
    assert.deepEqual(records.map(withoutTiming), reference.map(withoutTiming));
    assert.equal(isolator.status().unreapedChildren, 0);
  });
});

test("facade: records with a tiny embedded-resource cap still carry over 1 MiB of top-level metadata", async () => {
  // The records allowance used to scale with maxEmbeddedResources alone (1 MiB floor), so this parsed in-process
  // but was refused when isolated. A document property is metadata only, so a small maxOutputChars does not grow
  // the result cap to cover it.
  const input = docx(["body text"], "漢".repeat(400_000));
  const limits = { maxOutputChars: 1000, maxEmbeddedResources: 0 };
  const reference = (await inProcess.parseRecursive(input, { filename: "big-creator.docx", limits })).map(wireRecord);
  assert.ok(Buffer.byteLength(JSON.stringify(reference)) > MIB, "the fixture must carry more than 1 MiB of metadata");
  await withIsolator({ inProcessTypes: new Set() }, async (isolator) => {
    const before = facadeSettled.length;
    const answer = await isolator.isolate({ input, filename: "big-creator.docx", output: "records", ...limits });
    assert.equal(facadeSettled.length - before, 1, "it really went through a child");
    assert.equal(answer.kind, "records");
    const records = (answer as { records: readonly IsolatedParseRecord[] }).records;
    assert.deepEqual(records.map(withoutTiming), reference.map(withoutTiming));
  });
});

test("facade: routing keeps allowlisted text in-process and sends containers and PDFs to a child", async () => {
  let inProcessParses = 0;
  const counting = {
    detect: inProcess.detect.bind(inProcess),
    parse: (...args: Parameters<typeof inProcess.parse>) => {
      inProcessParses++;
      return inProcess.parse(...args);
    },
    parseRecursive: (...args: Parameters<typeof inProcess.parseRecursive>) => {
      inProcessParses++;
      return inProcess.parseRecursive(...args);
    },
  };
  await withIsolator({ inProcessRipstream: counting }, async (isolator) => {
    const plain = await isolator.isolate({ input: encoder.encode("plain text, parsed here"), filename: "a.txt" });
    assert.equal(plain.kind, "text");
    assert.equal(inProcessParses, 1, "text/plain stays in this process");

    const before = facadeSettled.length;
    for (const [input, filename] of [
      [pdf("Isolated PDF"), "a.pdf"],
      [docx(["Isolated DOCX"]), "a.docx"],
      [storedZip({ "x.txt": "inside" }), "a.zip"],
    ] as const) {
      const answer = await isolator.isolate({ input, filename });
      assert.equal(answer.kind, "text", filename);
    }
    assert.equal(inProcessParses, 1, "none of the three reached the in-process pipeline");
    assert.equal(facadeSettled.length - before, 3, "each went to its own child");
  });
});

test("facade: the derived limits reach the child (a result over the derived cap is a LimitExceededError, as in-process)", async () => {
  const input = encoder.encode(`<p>${"word ".repeat(2000)}</p>`);
  const inProcessOutcome = await outcomeOf(() => inProcess.parse(input, { filename: "long.html", limits: { maxOutputChars: 50 } }));
  await withIsolator({ inProcessTypes: new Set() }, async (isolator) => {
    const before = facadeSettled.length;
    const isolatedOutcome = await outcomeOf(() => isolator.isolate({ input, filename: "long.html", maxOutputChars: 50 }));
    assert.equal(facadeSettled.length - before, 1, "the limit was enforced by a child, not by the in-process fallback");
    assert.equal(isolatedOutcome, inProcessOutcome);
    assert.match(isolatedOutcome, /LimitExceededError/);
  });
});
