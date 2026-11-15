import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { pdfDate } from "../src/pdf.ts";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { PdfParser } from "../src/index.ts";
import { preflightPdf, preflightPdfChunks } from "../src/pdf-preflight.ts";
import { MAX_RECOVERED_BYTES, recoverDocument } from "../src/pdf-recover.ts";
import { createFileRangeTransport, type RangeTransportConstructor } from "../src/pdf-session.ts";

const encoder = new TextEncoder();

test("preflight reads a file of many unterminated objects in linear time (tikajs-bepl)", () => {
  const objects = 20_000;
  const text = "%PDF-1.7\n" + Array.from({ length: objects }, (_, index) => `${index + 1} 0 obj\n<< /Subtype /Form /X ${"y".repeat(20)} `).join("");
  const started = performance.now();
  preflightPdf(encoder.encode(text));
  assert.ok(performance.now() - started < 3000, "preflight took too long");
});

test("preflight reads many forms with no endstream in linear time (tikajs-bepl)", () => {
  const forms = 20_000;
  const text =
    "%PDF-1.7\n" +
    Array.from({ length: forms }, (_, index) => `${index + 1} 0 obj\n<< /Subtype /Form /Resources << /XObject << /X ${index + 2} 0 R >> >> >>\nstream\nq Q\n`).join("");
  const started = performance.now();
  preflightPdf(encoder.encode(text));
  assert.ok(performance.now() - started < 3000, "preflight took too long");
});

test("preflight still finds a form that paints itself, and reads an unterminated object only as far as the next one (tikajs-bepl)", () => {
  const cycle =
    "1 0 obj\n<< /Subtype /Form /Resources << /XObject << /X 2 0 R >> >> /Length 5 >>\nstream\n/X Do\nendstream\nendobj\n" +
    "2 0 obj\n<< /Subtype /Form /Resources << /XObject << /X 1 0 R >> >> /Length 5 >>\nstream\n/X Do\nendstream\nendobj\n";
  assert.throws(() => preflightPdf(encoder.encode(cycle)), /paints itself/);
  const unterminatedFirst =
    "1 0 obj\n<< /Subtype /Form /Resources << /XObject << /X 2 0 R >> >> \n" +
    "2 0 obj\n<< /Subtype /Form /Resources << /XObject << /X 3 0 R >> >> /Length 5 >>\nstream\n/X Do\nendstream\nendobj\n";
  preflightPdf(encoder.encode(unterminatedFirst));
});

class FakeTransport {
  readonly delivered: Array<{ begin: number; length: number }> = [];
  readonly length: number;
  constructor(length: number, _initial: Uint8Array) {
    this.length = length;
  }
  abort(): void {}
  onDataRange(begin: number, chunk: Uint8Array): void {
    if (this.torn) throw new Error("_onReceiveData - no PDFDataTransportStreamRangeReader instance found");
    this.delivered.push({ begin, length: chunk.byteLength });
  }
  torn = false;
}

async function withFile<T>(body: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "ripstream-range-"));
  try {
    const path = join(directory, "a.pdf");
    await writeFile(path, new Uint8Array(1000).fill(0x41));
    return await body(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Resolves with every unhandled rejection seen while `action` runs and the loop settles. */
async function unhandledRejectionsDuring(action: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return seen;
}

test("a range read that finishes after pdf.js tore the transport down is not an unhandled rejection (tikajs-bepl)", async () => {
  await withFile(async (path) => {
    const transport = createFileRangeTransport(FakeTransport as unknown as RangeTransportConstructor, path, 1000);
    const seen = await unhandledRejectionsDuring(async () => {
      (transport as unknown as { requestDataRange(start: number, end: number): void }).requestDataRange(0, 500);
      // pdf.js has dropped its range reader, so delivering would throw.
      (transport as unknown as FakeTransport).torn = true;
    });
    assert.deepEqual(seen, []);
  });
});

test("an aborted transport delivers nothing and starts no read (tikajs-bepl)", async () => {
  await withFile(async (path) => {
    const transport = createFileRangeTransport(FakeTransport as unknown as RangeTransportConstructor, path, 1000);
    const fake = transport as unknown as FakeTransport & { requestDataRange(start: number, end: number): void };
    const seen = await unhandledRejectionsDuring(async () => {
      fake.requestDataRange(0, 500);
      fake.abort();
      fake.requestDataRange(500, 1000);
    });
    assert.deepEqual(seen, []);
    assert.deepEqual(fake.delivered, []);
  });
});

test("a range read of a file that is gone is not an unhandled rejection (tikajs-bepl)", async () => {
  const transport = createFileRangeTransport(FakeTransport as unknown as RangeTransportConstructor, join(tmpdir(), "ripstream-no-such-file.pdf"), 1000);
  const seen = await unhandledRejectionsDuring(async () => {
    (transport as unknown as { requestDataRange(start: number, end: number): void }).requestDataRange(0, 500);
  });
  assert.deepEqual(seen, []);
});

test("a range read delivers the bytes asked for (tikajs-bepl)", async () => {
  await withFile(async (path) => {
    const transport = createFileRangeTransport(FakeTransport as unknown as RangeTransportConstructor, path, 1000);
    (transport as unknown as { requestDataRange(start: number, end: number): void }).requestDataRange(100, 300);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual((transport as unknown as FakeTransport).delivered, [{ begin: 100, length: 200 }]);
  });
});

test("object-stream recovery charges what it writes, not only what it inflates (tikajs-bepl)", () => {
  // 200 members whose offsets alternate 0 and 1 MiB, so every other member is the whole 1 MiB stream: 100 MiB of output
  // from a few KB of file.
  const members = 200;
  const bodySize = 1024 * 1024;
  const pairs: string[] = [];
  for (let index = 0; index < members; index++) pairs.push(`${1000 + index} ${index % 2 === 0 ? 0 : bodySize}`);
  const header = pairs.join(" ") + "\n";
  const decoded = Buffer.concat([Buffer.from(header, "latin1"), Buffer.alloc(bodySize + 16, 0x78)]);
  const compressed = deflateSync(decoded);
  const text =
    "%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
    `9 0 obj\n<< /Type /ObjStm /N ${members} /First ${header.length} /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`;
  const data = Buffer.concat([Buffer.from(text, "latin1"), compressed, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  const recovered = recoverDocument(new Uint8Array(data));
  assert.notEqual(recovered, null);
  assert.ok(recovered!.byteLength - data.byteLength <= MAX_RECOVERED_BYTES + 64 * 1024, `recovered ${recovered!.byteLength} bytes`);
});

test("object-stream recovery of many unterminated objects is linear (tikajs-bepl)", () => {
  const text = "%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" + Array.from({ length: 20_000 }, (_, index) => `${index + 10} 0 obj\n<< /K ${"v".repeat(20)} `).join("");
  const started = performance.now();
  recoverDocument(encoder.encode(text));
  assert.ok(performance.now() - started < 3000, "recovery took too long");
});

// Oracle (Tika 4.2.0 /rmeta, dcterms:created of a PDF whose Info /CreationDate is the string): "2010-05-04T08:43:54+02:00"
// gives 2010-05-04T06:43:54Z (Tika reads an ISO 8601 date too, so the earlier "undefined" here was wrong); "D:20101304000000Z",
// "D:20100230120000Z", "D:20100504240000Z" and "D:20100504084354Z extra" give no key at all; "D:00991231235959Z" gives a
// year-0099 date (Java's Julian/Gregorian shift moves its day by two, which is not reproduced); every date has whole seconds.
test("pdfDate reads an ISO 8601 date, and drops a date that does not exist rather than inventing one (tikajs-gz44)", () => {
  assert.equal(pdfDate("2010-05-04T08:43:54+02:00"), "2010-05-04T06:43:54Z");
  assert.equal(pdfDate("D:20101304000000Z"), undefined);
  assert.equal(pdfDate("D:20100230120000Z"), undefined);
  assert.equal(pdfDate("D:20100504240000Z"), undefined);
  assert.equal(pdfDate("D:20100504084354Z extra"), undefined);
  assert.equal(pdfDate("D:00991231235959Z"), "0099-12-31T23:59:59Z");
  assert.equal(pdfDate("D:20100504084354.123+05'30"), "2010-05-04T03:13:54Z");
  assert.equal(pdfDate("20100504084354Z"), "2010-05-04T08:43:54Z");
  assert.equal(pdfDate("D:20100504084354+02'00'"), "2010-05-04T06:43:54Z");
  assert.equal(pdfDate("D:2010"), "2010-01-01T00:00:00Z");
});

test("preflightPdfChunks sees an object number across a chunk edge and a huge font length, in constant memory (tikajs-a8iv)", async () => {
  const filler = "%" + "x".repeat(98) + "\n"; // 100 bytes
  const read = (text: string) => async (start: number, end: number): Promise<Uint8Array> => encoder.encode(text.slice(start, end));
  const lead = filler.repeat(49) + "%" + "x".repeat(88) + "\n"; // 4,990 bytes
  const big = lead + "2147483647 0 obj\n<< >>\nendobj\n" + filler.repeat(50);
  // The object header starts at 4,990; chunks of 4,996 bytes put the edge inside it (only the overlap sees it whole).
  await assert.rejects(preflightPdfChunks(read(big), big.length, 4996, 64), /exceeds the 8388607 limit/);
  const font = lead + "5 0 obj\n<< /Length1 4000000000 >>\nendobj\n" + filler.repeat(50);
  await assert.rejects(preflightPdfChunks(read(font), font.length, 4996, 64), /font program/);
  const fine = filler.repeat(100) + "7 0 obj\n<< >>\nendobj\n";
  await preflightPdfChunks(read(fine), fine.length, 4996, 64);
  // The overlap is what finds it: with none, the edge splits the number and neither chunk holds it.
  await preflightPdfChunks(read(big), big.length, 4996, 0);
});

test("a PDF over 8 MiB is preflighted too: padding does not get an object number past the check (tikajs-a8iv)", async () => {
  const pad = ("%" + "x".repeat(1022) + "\n").repeat(9 * 1024);
  const body =
    "1 0 obj <</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n" +
    "3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 10 10]>>\nendobj\n2147483647 0 obj <</Root 1 0 R>>\nendobj\n";
  const stream = await RipstreamInputStream.from(encoder.encode("%PDF-1.7\n" + pad + body));
  const started = performance.now();
  try {
    await assert.rejects(new PdfParser({ pageTimeoutMs: 2000 }).parse(stream, new BodyContentHandler(), new Metadata(), new ParseContext()), /exceeds the 8388607 limit|Unable to read PDF/);
  } finally {
    await stream.close();
  }
  // Unpadded it is refused in milliseconds; unchecked it spun for over a minute.
  assert.ok(performance.now() - started < 20_000, "the padded file was not refused quickly");
});
