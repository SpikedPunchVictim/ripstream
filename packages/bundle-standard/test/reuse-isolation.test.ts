import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { MemoryPool, type RunDiagnostics } from "@spikedpunch/ripstream-isolation-node";
import { loadConfig, type Metadata, type ParseOptions, type ParseRecord } from "../src/index.ts";
import { createStandardIsolation, type StandardIsolation } from "../src/isolation.ts";

/**
 * tikajs-dasw: reused ("warm") children with the REAL standard child. A child that parsed one document must answer the
 * next exactly as a fresh child would, and nothing of an earlier document may show in a later answer.
 *
 * The planted-marker check: documents of several formats that carry a unique marker are parsed first on the reused
 * child; then a corpus of repository fixtures (every container, office, archive, database, PDF, mail and RDF parser
 * the child has) is parsed on the SAME child, twice, and every answer must equal a fresh child's answer and never
 * contain the marker. Requests that carry options (emailHeaders, records, segments, output and embedded limits) are
 * checked the same way, each followed by a request without them.
 *
 * `inProcessTypes: []` sends even the text formats to the child. RDF is reached through a custom media type (the
 * registry has no text/turtle), which is how a deployment would reach it.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MARKER = `PLANTED${randomUUID().replaceAll("-", "")}`;
const encoder = new TextEncoder();

/** Core stamps each record with how long its parse took: the one metadata key that cannot be equal across two runs. */
const TIMING_KEY = "tk:parse-time-millis";

const TURTLE_TYPES = `<?xml version="1.0"?><mime-info><mime-type type="text/turtle">
  <sub-class-of type="text/plain"/><glob pattern="*.ttl"/></mime-type></mime-info>`;
const typesDir = mkdtempSync(join(tmpdir(), "ripstream-reuse-types-"));
const typesPath = join(typesDir, "custom-mimetypes.xml");
writeFileSync(typesPath, TURTLE_TYPES);
const ripstreamConfig = loadConfig({ "custom-mimetypes": typesPath });

/** Repository fixtures, one or more per parser family; each parses cleanly (no exception, so the child is kept). */
const CORPUS = [
  "packages/parsers/test/fixtures/segments/files/customers.docx",
  "packages/parsers/test/fixtures/segments/files/vendors.xlsx",
  "packages/parsers/test/fixtures/segments/files/deck.pptx",
  "packages/parsers/test/fixtures/xberg/office/files/doc_floating_picture.doc",
  "packages/parsers/test/fixtures/office-old/testEXCEL_4.xls",
  "packages/parsers/test/fixtures/xberg/office/files/embedded_word_object.ppt",
  "packages/parsers/test/fixtures/office-odf/testODFwithOOo3.odt",
  "packages/parsers/test/fixtures/epub/testEPUB.epub",
  "packages/parsers/test/fixtures/paths/files/bundle-docx.zip",
  "packages/parsers/test/fixtures/paths/files/tar-000.tar",
  "packages/parser-db/test/fixtures/gdal-byte.gpkg",
  "packages/parsers/test/fixtures/misc-data/test-columnar.sas7bdat",
  "packages/parsers/test/fixtures/media/testVORBIS.ogg",
  "packages/parsers/test/fixtures/xberg/html/files/formatting.html",
  "packages/parsers/test/fixtures/xberg/mail/files/fake-email-b64.eml",
  "packages/bundle-standard/test/fixtures/tika/test_recursive_embedded.docx",
].map((path) => join(ROOT, path));

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

const turtle = (literal: string): Uint8Array =>
  encoder.encode(`@prefix ex: <http://example.org/> .\n_:x ex:knows [ ex:name "${literal}" ] .\nex:a ex:list ( "one" "two" ) .\n`);
const email = (subject: string, body: string): Uint8Array =>
  encoder.encode(`From: a@example.com\nTo: b@example.com\nSubject: ${subject}\nDate: Tue, 01 Oct 2024 12:34:56 -0500\n\n${body}\n`);

/** Documents carrying the marker, parsed first on the reused child. */
const PLANTED: readonly (readonly [string, Uint8Array])[] = [
  ["planted.pdf", pdfOfContent(`BT /F1 12 Tf 72 700 Td (${MARKER}) Tj ET`)],
  ["planted.ttl", turtle(MARKER)],
  ["planted.eml", email(MARKER, `${MARKER} body`)],
  ["planted.html", encoder.encode(`<html><head><title>${MARKER}</title></head><body><p>${MARKER}</p></body></html>`)],
];

/** Inline documents of the corpus: a PDF and an RDF document, so pdf.js and n3 run after their planted twins. */
const INLINE: readonly (readonly [string, Uint8Array])[] = [
  ["clean.pdf", pdfOfContent("BT /F1 12 Tf 72 700 Td (An ordinary page) Tj ET")],
  ["clean.ttl", turtle("an ordinary name")],
  ["clean.eml", email("Quarterly numbers", "The numbers are attached.")],
];

const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 8 });
const warmRuns: RunDiagnostics[] = [];
const base = { config: { mode: "strict" }, pool, inProcessTypes: [], ripstreamConfig } as const;
const fresh: StandardIsolation = await createStandardIsolation(base);
const warm: StandardIsolation = await createStandardIsolation({
  ...base,
  reuse: { enabled: true, trustDomain: "tenant-a", maxRequests: 1000, rssSampleEvery: 1000 },
  runner: { onRunSettled: (d) => warmRuns.push(d) },
});
after(async () => {
  await Promise.all([fresh.isolator.dispose(), warm.isolator.dispose()]);
  pool.dispose();
  rmSync(typesDir, { recursive: true, force: true });
});

function comparableMetadata(metadata: Metadata): Record<string, readonly string[]> {
  return Object.fromEntries(
    [...metadata.names()]
      .filter((name) => name !== TIMING_KEY)
      .sort()
      .map((name) => [name, [...metadata.getAll(name)]]),
  );
}

interface Comparable {
  readonly text: string;
  readonly metadata: Record<string, readonly string[]>;
}

async function parseOn(isolation: StandardIsolation, source: Uint8Array | { path: string }, options: ParseOptions): Promise<Comparable> {
  const result = await isolation.ripstream.parse(source, options);
  return { text: result.text, metadata: comparableMetadata(result.metadata) };
}

function comparableRecords(records: readonly ParseRecord[]): unknown[] {
  return records.map((record) => ({
    content: record.content,
    path: record.embeddedResourcePath,
    depth: record.depth,
    type: String(record.mediaType),
    metadata: comparableMetadata(record.metadata),
    exception: record.exception === null ? null : record.exception.message,
    segments: record.segments?.map(({ start, end, labels, location }) => ({ start, end, labels, location })),
  }));
}

/** Parses on both arms and checks the warm answer is the fresh one and carries no marker. */
async function same(source: Uint8Array | { path: string }, options: ParseOptions): Promise<Comparable> {
  const expected = await parseOn(fresh, source, options);
  const actual = await parseOn(warm, source, options);
  const label = options.filename ?? JSON.stringify(source instanceof Uint8Array ? "bytes" : source);
  assert.deepEqual(actual, expected, label);
  assert.ok(!JSON.stringify(actual).includes(MARKER), `${label}: the marker of an earlier document shows`);
  return actual;
}

const pidsSince = (start: number): Set<number | undefined> => new Set(warmRuns.slice(start).map((run) => run.pid));

test("planted marker: after documents carrying a marker, every format answers on the same child as on a fresh one", { timeout: 300_000 }, async () => {
  const start = warmRuns.length;
  for (const [filename, bytes] of PLANTED) {
    const planted = await parseOn(warm, bytes, { filename });
    assert.ok(JSON.stringify(planted).includes(MARKER), `${filename} carries the marker`);
  }
  for (let pass = 0; pass < 2; pass += 1) {
    for (const path of CORPUS) {
      // Once as bytes, once as a path the child opens itself.
      await same(pass === 0 ? readFileSync(path) : { path }, { filename: path.split("/").pop()! });
    }
    for (const [filename, bytes] of INLINE) await same(bytes, { filename });
  }
  assert.equal(pidsSince(start).size, 1, "one child answered every request");
  const reuse = warm.isolator.status().reuse;
  assert.ok(reuse !== undefined && reuse.reused >= PLANTED.length + 2 * (CORPUS.length + INLINE.length) - 1, JSON.stringify(reuse));
});

test("RDF: the blank-node labels of a document do not depend on the documents a reused child parsed before", { timeout: 120_000 }, async () => {
  const first = await same(turtle("x"), { filename: "a.ttl" });
  assert.match(first.text, /b0_x/);
  assert.match(first.text, /n3-0/);
  await same(turtle("y"), { filename: "b.ttl" });
  assert.deepEqual(await parseOn(warm, turtle("x"), { filename: "a.ttl" }), first);
});

test("emailHeaders on a reused child, then a request without it", { timeout: 120_000 }, async () => {
  const eml = email("Quarterly numbers", "The numbers are attached.");
  const plain = await same(eml, { filename: "q.eml" });
  const headed = await same(eml, { filename: "q.eml", emailHeaders: true });
  assert.ok(headed.text.startsWith("Subject: Quarterly numbers\n"), JSON.stringify(headed.text));
  assert.deepEqual(await same(eml, { filename: "q.eml" }), plain);
});

test("records with segments on a reused child, then a text request", { timeout: 120_000 }, async () => {
  const docx = readFileSync(CORPUS.at(-1)!);
  const expected = comparableRecords(await fresh.ripstream.parseRecursive(docx, { filename: "r.docx", segments: true }));
  const actual = comparableRecords(await warm.ripstream.parseRecursive(docx, { filename: "r.docx", segments: true }));
  assert.deepEqual(actual, expected);
  assert.ok(expected.length > 1, "the document has embedded documents");
  assert.ok((expected[0] as { segments?: unknown[] }).segments !== undefined, "segments crossed");
  await same(docx, { filename: "r.docx" });
});

test("onOutputLimit and onEmbeddedLimit truncate on a reused child, then requests without them", { timeout: 120_000 }, async () => {
  const docx = readFileSync(CORPUS.at(-1)!);
  const truncated = await same(docx, { filename: "r.docx", limits: { maxOutputChars: 40 }, onOutputLimit: "truncate" });
  assert.ok(truncated.text.length <= 40, String(truncated.text.length));
  const full = await same(docx, { filename: "r.docx" });
  assert.ok(full.text.length > 40);

  const options: ParseOptions = { filename: "r.docx", limits: { maxEmbeddedResources: 1 }, onEmbeddedLimit: "truncate" };
  const expected = comparableRecords(await fresh.ripstream.parseRecursive(docx, options));
  assert.deepEqual(comparableRecords(await warm.ripstream.parseRecursive(docx, options)), expected);
  const all = comparableRecords(await warm.ripstream.parseRecursive(docx, { filename: "r.docx" }));
  assert.deepEqual(all, comparableRecords(await fresh.ripstream.parseRecursive(docx, { filename: "r.docx" })));
  assert.ok(all.length > expected.length, `${all.length} records without the limit, ${expected.length} with it`);
});
