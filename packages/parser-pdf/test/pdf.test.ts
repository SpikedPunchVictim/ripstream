import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AbortError,
  BodyContentHandler,
  CONTEXT_KEYS,
  EncryptedDocumentError,
  LimitExceededError,
  EmbeddedDocumentBytesHandler,
  MalformedDocumentError,
  Metadata,
  ParseContext,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { PdfParser } from "../src/index.ts";
import { pdfDate } from "../src/pdf.ts";
import { recoverDocument } from "../src/pdf-recover.ts";
import { encryptedPdf, helloPdf, rawPdf, samplePdf } from "./fixtures.ts";

test("extracts PDF text and metadata", async () => {
  const bytes = await samplePdf();
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new PdfParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();

  assert.match(handler.toString(), /Hello PDF/);
  assert.equal(metadata.get("dc:title"), "Sample");
  assert.equal(metadata.get("dc:creator"), "Ada");
  assert.equal(metadata.get("pdf:PageCount"), "1");
  assert.match(metadata.get("pdf:charsPerPage") ?? "", /^\d+$/);
  assert.match(metadata.get("dcterms:created") ?? "", /^2024-01-01/);
});

test("converts PDF date strings", () => {
  assert.equal(pdfDate("D:20240101123045Z"), "2024-01-01T12:30:45.000Z");
  assert.equal(pdfDate("D:20240101123045+02'00'"), "2024-01-01T10:30:45.000Z");
  assert.equal(pdfDate("not a date"), undefined);
});

test("reports malformed input without crashing the caller", async () => {
  const stream = await RipstreamInputStream.from(
    new TextEncoder().encode("not a pdf at all"),
  );
  await assert.rejects(
    new PdfParser().parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      new ParseContext(),
    ),
    MalformedDocumentError,
  );
  await stream.close();
});

test("honours cancellation before reading the input", async () => {
  const stream = await RipstreamInputStream.from(new Uint8Array([1, 2, 3]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new PdfParser().parse(
      stream,
      new BodyContentHandler(),
      new Metadata(),
      new ParseContext({ signal: controller.signal }),
    ),
    AbortError,
  );
  await stream.close();
});

test("extracts annotation text, links and annotation metadata", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Annotated", { x: 72, y: 700, size: 12, font });

  const link = document.context.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [72, 600, 220, 620],
    A: { S: "URI", URI: PDFString.of("https://example.com/docs") },
  });
  const note = document.context.obj({
    Type: "Annot",
    Subtype: "Text",
    Rect: [72, 560, 92, 580],
    T: PDFString.of("Ada"),
    Subj: PDFString.of("Review"),
    Contents: PDFString.of("Please check this section"),
  });
  const references = [link, note].map((annotation) =>
    document.context.register(annotation),
  );
  page.node.set(PDFName.of("Annots"), document.context.obj(references));

  const stream = await RipstreamInputStream.from(await document.save());
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new PdfParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();

  assert.match(handler.toString(), /https:\/\/example\.com\/docs/);
  assert.match(handler.toString(), /Please check this section/);
  assert.match(handler.toString(), /Ada/);
  assert.deepEqual(metadata.getAll("pdf:annotation-subtypes").sort(), [
    "Link",
    "Text",
  ]);
});

test("sorts text by position and honours page separators", async () => {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage();
  first.drawText("Bottom line", { x: 72, y: 600, size: 12, font });
  first.drawText("Top line", { x: 72, y: 700, size: 12, font });
  const second = document.addPage();
  second.drawText("Page two", { x: 72, y: 700, size: 12, font });

  const stream = await RipstreamInputStream.from(await document.save());
  const handler = new BodyContentHandler();
  await new PdfParser({ pageSeparator: "---PAGE---" }).parse(
    stream,
    handler,
    new Metadata(),
    new ParseContext(),
  );
  await stream.close();
  const text = handler.toString();
  assert.ok(text.indexOf("Top line") < text.indexOf("Bottom line"));
  assert.match(text, /---PAGE---/);
  assert.match(text, /Page two/);
});

test("extracts AcroForm field names and values", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const form = document.getForm();
  const field = form.createTextField("customer");
  field.setText("Ada Lovelace");
  field.addToPage(page, { x: 72, y: 600, width: 200, height: 20 });

  const stream = await RipstreamInputStream.from(await document.save());
  const handler = new BodyContentHandler();
  const metadata = new Metadata();
  await new PdfParser().parse(stream, handler, metadata, new ParseContext());
  await stream.close();

  assert.match(handler.toString(), /customer/);
  assert.match(handler.toString(), /Ada Lovelace/);
  assert.equal(metadata.get("pdf:has-acro-form-fields"), "true");
});

test("extracts PDF attachments", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(new TextEncoder().encode("attached text"), "note.txt", {
    mimeType: "text/plain",
  });
  const stream = await RipstreamInputStream.from(await document.save());
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  const handler = new BodyContentHandler();
  await new PdfParser().parse(stream, handler, new Metadata(), context);
  await stream.close();
  assert.match(handler.toString(), /note\.txt/);
  assert.equal(resources.resources.length, 1);
  assert.equal(
    new TextDecoder().decode(resources.resources[0]?.bytes),
    "attached text",
  );
});

test("a PDF attachment is an ATTACHMENT (Tika's AbstractPDF2XHTML)", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(new TextEncoder().encode("attached text"), "note.txt", { mimeType: "text/plain" });
  const stream = await RipstreamInputStream.from(await document.save());
  const resources = new EmbeddedDocumentBytesHandler();
  const context = new ParseContext();
  context.set(CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR, resources);
  await new PdfParser().parse(stream, new BodyContentHandler(), new Metadata(), context);
  await stream.close();
  assert.deepEqual(
    resources.resources.map((resource) => resource.metadata.get("tk:embedded-resource-type")),
    ["ATTACHMENT"],
  );
});

test("accepts password providers for encrypted inputs", async () => {
  const { EmptyPasswordProvider } = await import("@spikedpunch/ripstream-core");
  const stream = await RipstreamInputStream.from(await samplePdf());
  const handler = new BodyContentHandler();
  await new PdfParser({ password: new EmptyPasswordProvider() }).parse(
    stream,
    handler,
    new Metadata(),
    new ParseContext(),
  );
  await stream.close();
  assert.match(handler.toString(), /Hello PDF/);
});

test("rejects an encrypted PDF when no password is supplied", async () => {
  await assert.rejects(
    parseWith(encryptedPdf("user-pw"), new PdfParser()),
    EncryptedDocumentError,
  );
});

test("rejects an encrypted PDF when the password is wrong", async () => {
  await assert.rejects(
    parseWith(encryptedPdf("user-pw"), new PdfParser({ password: "wrong" })),
    EncryptedDocumentError,
  );
});

test("opens an encrypted PDF with the right password", async () => {
  const text = await parseWith(encryptedPdf("user-pw"), new PdfParser({ password: "user-pw" }));
  assert.match(text, /Secret text/);
});

test("opens an encrypted PDF with a password provider", async () => {
  const parser = new PdfParser({ password: { getPassword: () => "user-pw" } });
  assert.match(await parseWith(encryptedPdf("user-pw"), parser), /Secret text/);
});

test("recovers a PDF with a broken xref table", async () => {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 24 Tf 72 700 Td (Recovered) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  for (const object of objects) body += object;
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    objects.map(() => "0000000000 00000 n \n").join("");
  const pdf = `${body}${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`;
  const stream = await RipstreamInputStream.from(new TextEncoder().encode(pdf));
  const handler = new BodyContentHandler();
  await new PdfParser().parse(stream, handler, new Metadata(), new ParseContext());
  await stream.close();
  assert.match(handler.toString(), /Recovered/);
});

async function parseWith(
  bytes: Uint8Array,
  parser: PdfParser,
  context = new ParseContext(),
): Promise<string> {
  const stream = await RipstreamInputStream.from(bytes);
  const handler = new BodyContentHandler();
  try {
    await parser.parse(stream, handler, new Metadata(), context);
    return handler.toString();
  } finally {
    await stream.close();
  }
}

test("rejects an object number beyond the PDF limit instead of spinning", async () => {
  const bytes = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj <</Type /Catalog /Pages 2 0 R>>\nendobj\n" +
      "2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n" +
      "3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]>>\nendobj\n" +
      "2147483647 0 obj <</Root 1 0 R>>\nendobj\n",
  );
  await assert.rejects(parseWith(bytes, new PdfParser()), MalformedDocumentError);
});

test("rejects a font program /Length1 beyond the cap instead of allocating it", async () => {
  const bytes = rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] >>",
    "<< /Length 4 /Length1 274877906944 >>\nstream\nabcd\nendstream",
  ]);
  await assert.rejects(parseWith(bytes, new PdfParser()), MalformedDocumentError);
});

test("rejects form XObjects that paint each other", async () => {
  const form = (name: string, target: number): string =>
    `<< /Subtype /Form /BBox [0 0 9 9] /Resources << /XObject << /${name} ${target} 0 R >> >> /Length 8 >>\n` +
    "stream\n/X Do   \nendstream";
  const bytes = rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>",
    "<< /Length 5 >>\nstream\n/X Do\nendstream",
    form("X", 6),
    form("X", 5),
  ]);
  await assert.rejects(parseWith(bytes, new PdfParser()), MalformedDocumentError);
});

test("accepts a form XObject that lists itself in resources but never paints itself", async () => {
  const bytes = rawPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 9 9] /Contents 4 0 R /Resources << /XObject << /X 5 0 R >> >> >>",
    "<< /Length 5 >>\nstream\n/X Do\nendstream",
    "<< /Subtype /Form /BBox [0 0 9 9] /Resources << /XObject << /Y 5 0 R >> >> /Length 3 >>\nstream\nq Q\nendstream",
  ]);
  await parseWith(bytes, new PdfParser());
});

test("rejects input larger than maxInputBytes", async () => {
  await assert.rejects(
    parseWith(await samplePdf(), new PdfParser({ maxInputBytes: 100 })),
    LimitExceededError,
  );
});

test("bounds the spill instead of writing an oversized stream to disk first", async () => {
  const chunkSize = 64 * 1024;
  const totalChunks = 4096; // 256 MiB if fully drained
  let produced = 0;
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < totalChunks; i++) {
      produced += chunkSize;
      yield new Uint8Array(chunkSize);
    }
  }
  const stream = await RipstreamInputStream.from(source());
  try {
    await assert.rejects(
      new PdfParser({ maxInputBytes: 1024 * 1024 }).parse(
        stream,
        new BodyContentHandler(),
        new Metadata(),
        new ParseContext(),
      ),
      LimitExceededError,
    );
  } finally {
    await stream.close();
  }
  assert.ok(produced <= 2 * 1024 * 1024, `pulled ${produced} bytes from the source`);
});

test("caps page text characters", async () => {
  await assert.rejects(
    parseWith(await samplePdf(), new PdfParser({ maxPageTextChars: 3 })),
    LimitExceededError,
  );
});

test("rejects more attachments than the embedded resource limit", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(new TextEncoder().encode("one"), "one.txt", {
    mimeType: "text/plain",
  });
  const bytes = await document.save();
  await assert.rejects(
    parseWith(
      bytes,
      new PdfParser(),
      new ParseContext({ limits: { maxEmbeddedResources: 0 } }),
    ),
    LimitExceededError,
  );
});

test("rejects an attachment larger than the embedded byte limit", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  await document.attach(new Uint8Array(1000), "big.bin", {
    mimeType: "application/octet-stream",
  });
  const bytes = await document.save();
  await assert.rejects(
    parseWith(
      bytes,
      new PdfParser(),
      new ParseContext({ limits: { maxEmbeddedResourceBytes: 100 } }),
    ),
    LimitExceededError,
  );
});

test("recovers a PDF whose xref and trailer are missing", async () => {
  const bytes = await helloPdf(false);
  const truncated = bytes.subarray(0, bytes.indexOf("xref\n"));
  assert.match(await parseWith(truncated, new PdfParser()), /Recovered text/);
});

test("recovers a catalog stored in an object stream when the xref stream is lost", async () => {
  const bytes = await helloPdf(true);
  const xrefObject = bytes.lastIndexOf("/Type /XRef");
  const truncated = bytes.subarray(0, bytes.lastIndexOf("obj", xrefObject) - 8);
  assert.match(await parseWith(truncated, new PdfParser()), /Recovered text/);
});

test("still rejects a PDF with no catalog anywhere", async () => {
  const bytes = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Pages 2 0 R >>\nendobj\n");
  await assert.rejects(parseWith(bytes, new PdfParser()), MalformedDocumentError);
});

test("does not attempt to recover encrypted documents", () => {
  const bytes = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "9 0 obj\n<< /Filter /Standard >>\nendobj\ntrailer\n<< /Encrypt 9 0 R >>\n",
  );
  assert.equal(recoverDocument(bytes), null);
});

// Deliberately broken PDFs must fail fast with a typed error, never crash or hang.
// They model corpus files that no repair can recover (see docs/corpus-validation.md).
const unrecoverable: Array<[string, string]> = [
  ["truncated before any catalog", "%PDF-1.4\n1 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nend"],
  [
    "stale xref offsets and no catalog",
    "%PDF-1.4\n1 0 obj\n<< /Foo 1 >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000999 00000 n \n" +
      "trailer\n<< /Size 2 /Root 7 0 R >>\nstartxref\n40\n%%EOF\n",
  ],
  [
    "catalog without a page tree",
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page >>\nendobj\n3 0 obj\n<< /Type /Page >>\nendobj\n" +
      "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  ],
];
for (const [name, source] of unrecoverable) {
  test(`reports unrecoverable PDF (${name}) with MalformedDocumentError`, async () => {
    const started = Date.now();
    await assert.rejects(
      parseWith(new TextEncoder().encode(source), new PdfParser()),
      MalformedDocumentError,
    );
    assert.ok(Date.now() - started < 10_000, "must fail fast");
  });
}

// pdf.js regression corpus files, matched by SHA-256 and skipped when absent.
// Set RIPSTREAM_PDFJS_CORPUS to a checkout of mozilla/pdf.js test/pdfs.
const corpusFixtures = [
  {
    name: "bug1978317.pdf",
    sha256: "2da2307afefe14c163f0f57a794c5199e9302eec3fdc154896a05976e08c2727",
    text: /Hello World/,
  },
  {
    name: "issue22370.pdf",
    sha256: "3b06fbbc5b6ddc0f64773628cb55829318ff4dacbe93b9beec88d6ee53d5290f",
    text: /^\s*$/,
  },
];
for (const fixture of corpusFixtures) {
  const path = join(process.env["RIPSTREAM_PDFJS_CORPUS"] ?? "", fixture.name);
  const bytes = existsSync(path) ? readFileSync(path) : undefined;
  const present =
    bytes !== undefined && createHash("sha256").update(bytes).digest("hex") === fixture.sha256;
  test(`recovers pdf.js corpus file ${fixture.name}`, { skip: !present }, async () => {
    assert.match(await parseWith(bytes!, new PdfParser()), fixture.text);
  });
}
