import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { indexObjects } from "../src/pdf-objects.ts";
import { diagnosePdf, latin1, rebuildPdf } from "../src/pdf-rebuild.ts";
import { decodeStream } from "../src/pdf-syntax.ts";
import { classicPdf, onePageObjects, streamObject } from "./fixtures.ts";

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));

test("rebuildPdf rewrites the xref and trailer for a file cut before its trailer", () => {
  const source = classicPdf(onePageObjects("Hello"));
  const rebuilt = rebuildPdf(bytes(source.slice(0, source.indexOf("xref\n"))));
  assert.notEqual(rebuilt, null);
  const text = latin1(rebuilt!.data);
  assert.match(text, /xref\n0 6\n/);
  assert.match(text, /trailer\n<< \/Size 6 \/Root 1 0 R >>/);
  assert.match(text, /startxref\n\d+\n%%EOF\n$/);
  assert.deepEqual(rebuilt!.steps, ["brute-force-scan", "rebuilt-xref", "synthetic-trailer"]);
});

test("rebuildPdf writes xref offsets that point at each object", () => {
  const rebuilt = latin1(rebuildPdf(bytes(classicPdf(onePageObjects("Hello")).replace(/startxref\n\d+/, "startxref\n9")))!.data);
  const table = /xref\n0 6\n0000000000 65535 f \n((?:\d{10} \d{5} n \n){5})/.exec(rebuilt);
  assert.notEqual(table, null);
  table![1]!.trim().split("\n").forEach((line, index) => {
    assert.ok(rebuilt.startsWith(`${index + 1} 0 obj`, Number(line.slice(0, 10))), `object ${index + 1}`);
  });
});

test("rebuildPdf refuses an encrypted document and one with no catalog", () => {
  assert.equal(rebuildPdf(bytes("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n")), null);
  assert.equal(rebuildPdf(bytes("%PDF-1.4\n1 0 obj\n<< /Type /Font >>\nendobj\n")), null);
});

test("rebuildPdf refuses a file without a %PDF header and one with no page anywhere", () => {
  assert.equal(rebuildPdf(bytes(classicPdf(onePageObjects("Hello")).replace("%PDF-1.4", "%XYZ-1.4"))), null);
  assert.equal(rebuildPdf(bytes("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")), null);
});

test("rebuildPdf builds a page tree from orphan pages when the tree root is missing", () => {
  const objects = onePageObjects("First");
  objects[1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"; // the page tree root is gone
  objects.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    streamObject("BT /F1 24 Tf 72 700 Td (Second) Tj ET"),
  );
  const rebuilt = rebuildPdf(bytes(classicPdf(objects)));
  assert.notEqual(rebuilt, null);
  const text = latin1(rebuilt!.data);
  assert.match(text, /8 0 obj\n<< \/Type \/Pages \/Kids \[3 0 R 6 0 R\] \/Count 2 >>/);
  assert.match(text, /1 0 obj\n<< \/Type \/Catalog \/Pages 8 0 R >>/);
  assert.match(text, /3 0 obj\n<< \/Type \/Page \/Parent 8 0 R /);
  assert.ok(rebuilt!.steps.includes("page-tree-rebuilt"));
});

test("rebuildPdf keeps the readable parents of pages it puts in a new tree", () => {
  const objects = onePageObjects("Kept");
  objects[1] = "<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>";
  const rebuilt = latin1(rebuildPdf(bytes(classicPdf(objects)))!.data);
  // Page 9 is missing, so the tree is rebuilt, but page 3's parent still reads: it keeps it for inherited attributes.
  assert.match(rebuilt, /6 0 obj\n<< \/Type \/Pages \/Kids \[3 0 R\] \/Count 1 \/Resources << \/Font << \/F1 5 0 R >> >> >>/);
  assert.match(rebuilt, /3 0 obj\n<< \/Type \/Page \/Parent 2 0 R /);
});

test("rebuildPdf repairs a font with a damaged /Subtype or Identity CMap name", () => {
  const objects = onePageObjects("Hello");
  objects[4] = "<< /Type /Font /Subtyp /Type1 /BaseFont /Helvetica >>";
  objects.push("<< /Type /Font /Subtype /Type /BaseFont /ArialMT /Encoding /Identity- /DescendantFonts [7 0 R] >>");
  objects.push("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialMT >>");
  const rebuilt = rebuildPdf(bytes(classicPdf(objects)));
  const text = latin1(rebuilt!.data);
  // The damaged key is put right in place (pdf-keys.ts), not shadowed by a second /Subtype.
  assert.match(text, /5 0 obj\n<< \/Type \/Font \/Subtype \/Type1 \/BaseFont \/Helvetica >>/);
  assert.doesNotMatch(text, /\/Subtyp\s/);
  assert.match(text, /6 0 obj\n<< \/Type \/Font \/Subtype \/Type0 \/BaseFont \/ArialMT \/Encoding \/Identity-H /);
  assert.match(text, /7 0 obj\n<< \/Type \/Font \/Subtype \/CIDFontType2 /);
  assert.ok(rebuilt!.steps.includes("font-repaired"));
});

test("rebuildPdf leaves sound fonts alone", () => {
  assert.ok(!rebuildPdf(bytes(classicPdf(onePageObjects("Hello"))))!.steps.includes("font-repaired"));
});

test("rebuildPdf keeps the part of a Flate stream that inflates before the file is cut", () => {
  const words = Array.from({ length: 400 }, (_, i) => `w${(i * 7919) % 10007}`).join(" ");
  const content = `BT /F1 24 Tf 72 700 Td (${words}) Tj ET`;
  const compressed = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
  const objects = onePageObjects("unused");
  objects[3] = `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed}\nendstream`;
  const whole = classicPdf(objects);
  const streamAt = whole.indexOf("stream\n") + "stream\n".length;
  const rebuilt = rebuildPdf(bytes(whole.slice(0, streamAt + Math.floor(compressed.length / 2))));
  const text = latin1(rebuilt!.data);
  const object = /4 0 obj\n(<<[^]*?>>)\nstream\n([^]*?)\nendstream/.exec(text);
  assert.notEqual(object, null);
  assert.doesNotMatch(object![1]!, /\/Filter/);
  assert.ok(object![2]!.length > 100 && content.startsWith(object![2]!), object![2]!.slice(0, 80));
  assert.match(object![1]!, new RegExp(`/Length ${object![2]!.length}\\b`));
  assert.ok(rebuilt!.steps.includes("stream-salvaged"));
});

test("rebuildPdf writes the trailer's Info, else the last untyped dictionary with a producer", () => {
  const objects = [...onePageObjects("Hello"), "<< /Producer (A) >>", "<< /Producer (B) >>"];
  const named = classicPdf(objects, " /Info 6 0 R");
  assert.match(latin1(rebuildPdf(bytes(named))!.data), /trailer\n<< \/Size 8 \/Root 1 0 R \/Info 6 0 R >>/);
  const cut = named.slice(0, named.indexOf("xref\n"));
  assert.match(latin1(rebuildPdf(bytes(cut))!.data), /trailer\n<< \/Size 8 \/Root 1 0 R \/Info 7 0 R >>/);
});

test("rebuildPdf drops xref streams and takes the catalog an xref stream names", () => {
  const objects = [
    "<< /Type /Catalog /Pages 9 0 R >>", // an older catalog nothing names
    ...onePageObjects("Hello").slice(1),
    "<< /Type /Catalog /Pages 2 0 R >>",
    streamObject("", " /Type /XRef /Root 6 0 R /Size 7"),
  ];
  const rebuilt = latin1(rebuildPdf(bytes(classicPdf(objects).replace(/trailer\n<<[^>]*>>/, "trailer\n<< >>")))!.data);
  assert.match(rebuilt, /\/Root 6 0 R/);
  assert.doesNotMatch(rebuilt, /\/Type \/XRef/);
});

test("diagnosePdf finds nothing wrong with a sound file", () => {
  const text = classicPdf(onePageObjects("Hello"));
  assert.deepEqual(diagnosePdf(text, indexObjects(text)), { causes: [], freedReferenced: [], xrefUnusable: false });
});

test("diagnosePdf names a file cut short", () => {
  const whole = classicPdf(onePageObjects("Hello"));
  const text = whole.slice(0, whole.indexOf("BT /F1"));
  const diagnosis = diagnosePdf(text, indexObjects(text));
  assert.deepEqual(diagnosis.causes, ["missing %%EOF", "no startxref", "1 object cut off"]);
  assert.equal(diagnosis.xrefUnusable, true);
});

test("diagnosePdf names a startxref that points nowhere", () => {
  const text = classicPdf(onePageObjects("Hello"));
  const far = text.replace(/startxref\n\d+/, "startxref\n99999");
  assert.deepEqual(diagnosePdf(far).causes, [`startxref offset 99999 out of range (file is ${far.length} bytes)`]);
  const inside = diagnosePdf(text.replace(/startxref\n\d+/, "startxref\n12"));
  assert.deepEqual(inside.causes, ["startxref offset 12 points at no xref"]);
  assert.equal(inside.xrefUnusable, true);
});

test("diagnosePdf counts xref entries whose offsets are wrong", () => {
  const text = classicPdf(onePageObjects("Hello")).replace(/(xref\n0 6\n0000000000 65535 f \n)\d{10}/, "$10000000001");
  const diagnosis = diagnosePdf(text);
  assert.deepEqual(diagnosis.causes, ["xref offsets wrong for 1 object"]);
  assert.equal(diagnosis.xrefUnusable, false);
});

test("diagnosePdf reports objects the xref marks free although the page tree needs them", () => {
  const lines = classicPdf(onePageObjects("Hello")).split("\n");
  const entry = lines.indexOf("xref") + 2 + 4; // the entry for object 4
  lines[entry] = lines[entry]!.replace(" n ", " f ");
  const text = lines.join("\n");
  const diagnosis = diagnosePdf(text);
  assert.deepEqual(diagnosis.freedReferenced, [4]);
  assert.deepEqual(diagnosis.causes, ["xref marks referenced objects free (4)"]);
});

test("diagnosePdf names the page tree problem and a missing catalog when given the objects", () => {
  const objects = onePageObjects("Hello");
  objects[2] = "<< /Typ /Page >>";
  const broken = classicPdf(objects);
  assert.deepEqual(diagnosePdf(broken, indexObjects(broken)).causes, ["page tree object 3 is not a page"]);
  const none = "%PDF-1.4\n1 0 obj\n<< /Type /Font >>\nendobj\n%%EOF\n";
  assert.deepEqual(diagnosePdf(none, indexObjects(none)).causes, ["no startxref", "no catalog"]);
});

test("indexObjects keeps the last definition of an object and marks one that is cut off", () => {
  const text = "%PDF-1.4\n1 0 obj\n<< /A 1 >>\nendobj\n1 0 obj\n<< /A 2 >>\nendobj\n2 0 obj\n<< /B 1";
  const index = indexObjects(text);
  assert.match(index.objects.get(1)!.body, /\/A 2/);
  assert.equal(index.objects.get(1)!.closed, true);
  assert.equal(index.objects.get(2)!.closed, false);
});

test("indexObjects finds a stream's end by endstream when /Length is wrong, and runs a cut stream to the next object", () => {
  const text = "%PDF-1.4\n1 0 obj\n<< /Length 3 >>\nstream\nhello world\nendstream\nendobj\n2 0 obj\n<< /Length 50 >>\nstream\ncut\n3 0 obj\n<< >>\nendobj\n";
  const index = indexObjects(text);
  const first = index.objects.get(1)!;
  assert.equal(text.slice(first.stream!.start, first.stream!.end), "hello world\n");
  const second = index.objects.get(2)!;
  assert.deepEqual([second.stream!.complete, second.closed, text.slice(second.stream!.start, second.stream!.end)], [false, false, "cut\n"]);
  assert.equal(index.objects.get(3)!.closed, true);
});

test("indexObjects reads the members of an object stream, and a later definition wins over a member", () => {
  const members = "<< /Type /Catalog >> << /M 2 >>";
  const data = deflateSync(Buffer.from(`1 0 2 21 ${members}`)).toString("latin1");
  const text =
    `%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 2 /First 9 /Filter /FlateDecode /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n` +
    "2 0 obj\n<< /Later true >>\nendobj\n";
  const index = indexObjects(text);
  assert.equal(index.objects.get(1)!.body.trim(), "<< /Type /Catalog >>");
  assert.equal(index.objects.get(1)!.container, 5);
  assert.match(index.objects.get(2)!.body, /\/Later/);
  assert.equal(index.inlined, 1);
});

test("indexObjects lists an object stream that does not decode", () => {
  const text = "%PDF-1.5\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 4 >>\nstream\njunk\nendstream\nendobj\n";
  assert.deepEqual(indexObjects(text).badObjectStreams, [5]);
});

test("rebuildPdf closes the dictionaries and arrays of an object that is cut off", () => {
  const page = "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Annots [ 9 0 R % note";
  const whole = classicPdf(["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", page]);
  const rebuilt = latin1(rebuildPdf(bytes(whole.slice(0, whole.indexOf(" % note") + " % note".length)))!.data);
  assert.match(rebuilt, /3 0 obj\n<< \/Type \/Page \/Parent 2 0 R \/Resources << \/Font << \/F1 4 0 R >> >> \/Annots \[ 9 0 R \] >>\nendobj/);
});

test("indexObjects reads the stream keyword after the dictionary, not the word inside a name or a string (tikajs-8c0w)", () => {
  const text =
    "1 0 obj\n<< /BaseFont /BitstreamVeraSans /Title (a stream of text) >>\nendobj\n" +
    "2 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n" +
    "3 0 obj\n<< /Type /Page >>\nendobj\n";
  const index = indexObjects(text);
  assert.equal(index.objects.get(1)!.stream, null);
  assert.ok(index.objects.get(1)!.closed);
  assert.match(index.objects.get(1)!.body, /BitstreamVeraSans/);
  const data = index.objects.get(2)!.stream!;
  assert.equal(text.slice(data.start, data.end), "hello");
  assert.ok(index.objects.has(3), "the object after a font named with the word is still indexed");
});

test("indexObjects still finds the stream of an object whose dictionary is cut off before it", () => {
  const text = "1 0 obj\n<< /Length 5 /Filter /X \nstream\nhello\nendstream\nendobj\n2 0 obj\n<< >>\nendobj\n";
  const index = indexObjects(text);
  const data = index.objects.get(1)!.stream!;
  assert.equal(text.slice(data.start, data.end), "hello");
  assert.ok(index.objects.has(2));
});

test("indexObjects takes time linear in the objects when the word stream is rare", () => {
  const text = "1 0 obj\n<< /Length 5 >>\nstream\nhello\nendstream\nendobj\n" + "9 0 obj\nendobj\n".repeat(300_000);
  const started = performance.now();
  const index = indexObjects(text);
  assert.ok(index.objects.has(1));
  // Quadratic (a scan to the end of the text from every object) takes minutes here; linear takes well under a second.
  assert.ok(performance.now() - started < 20_000, "indexing took too long");
});

test("diagnosePdf does not call a deleted page damage: freed objects that only name each other are not referenced (tikajs-8c0w)", () => {
  const page = (contents: number, extra = ""): string =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R${extra} >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    page(4),
    streamObject("q Q"),
    "<< /Type /Font >>",
    page(7, " /Annots [8 0 R]"),
    streamObject("q Q"),
    "<< /Type /Annot /P 6 0 R >>",
  ];
  const update = (kids: string): string => {
    let text = classicPdf(objects);
    const previous = Number(/startxref\n(\d+)/.exec(text)![1]);
    const at = text.length;
    text += `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count 1 >>\nendobj\n`;
    const xref = text.length;
    const entry = (offset: number): string => `${String(offset).padStart(10, "0")} 00000 n \n`;
    return `${text}xref\n0 1\n0000000006 65535 f \n2 1\n${entry(at)}6 3\n0000000007 00001 f \n0000000008 00001 f \n0000000000 00001 f \ntrailer\n<< /Size 9 /Root 1 0 R /Prev ${previous} >>\nstartxref\n${xref}\n%%EOF\n`;
  };
  assert.deepEqual(diagnosePdf(update("3 0 R")).freedReferenced, []);
  // A live page tree that still names the freed page is damage.
  assert.deepEqual(diagnosePdf(update("3 0 R 6 0 R")).freedReferenced, [6]);
});

test("diagnosePdf reads an xref table that is one long run of digits in linear time (tikajs-zi5a)", () => {
  const head = "%PDF-1.4\n" + onePageObjects("Hello").map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`).join("");
  for (const trailer of ["\ntrailer\n<< /Root 1 0 R >>\n", ""]) {
    const text = `${head}xref\n${"1".repeat(400_000)}${trailer}startxref\n${head.length}\n%%EOF\n`;
    const started = performance.now();
    diagnosePdf(text);
    // Backtracking from every digit is quadratic: 80 KB took 3 s and each doubling costs four times as much.
    assert.ok(performance.now() - started < 5000, "reading the table took too long");
  }
});

test("rebuildPdf writes one xref subsection per run of object numbers, so a high object number costs a line, not a table (tikajs-gf8w)", () => {
  const objects = onePageObjects("Hello");
  const text = "%PDF-1.4\n" + objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`).join("") + "8388607 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n";
  const rebuilt = rebuildPdf(bytes(text));
  assert.notEqual(rebuilt, null);
  // The dense table was one 20-byte line for each of the 8,388,607 numbers: about 168 MB for this 434-byte file.
  assert.ok(rebuilt!.data.length < 10_000, `rebuilt file is ${rebuilt!.data.length} bytes`);
  const out = latin1(rebuilt!.data);
  assert.match(out, /xref\n0 6\n0000000000 65535 f \n(?:\d{10} \d{5} n \n){5}8388607 1\n\d{10} 00000 n \ntrailer\n<< \/Size 8388608 /);
  const entry = /8388607 1\n(\d{10}) /.exec(out)!;
  assert.ok(out.startsWith("8388607 0 obj", Number(entry[1])));
});

test("ASCII85 data that would decode past the budget is refused without first being decoded in memory (tikajs-8cx1)", () => {
  const z = "z".repeat(7 * 1024 * 1024);
  const entries = new Map([["Filter", "/ASCII85Decode"]]);
  const heapBefore = process.memoryUsage().heapUsed;
  const budget = { left: 1000 };
  assert.equal(decodeStream(entries, z, budget), null);
  // The decode held every output byte as a number in an array: 28 million of them for this input, hundreds of MB.
  assert.ok(process.memoryUsage().heapUsed - heapBefore < 100 * 1024 * 1024, "the decode held the whole output");
});

test("ASCII85 decoding is unchanged within the budget: groups, z, a short last group, and the <~ ~> markers", () => {
  const entries = new Map([["Filter", "/ASCII85Decode"]]);
  assert.equal(decodeStream(entries, "<~87cURD]i,\"Ebo7~>", { left: 100 }), "Hello World");
  assert.equal(decodeStream(entries, "zz", { left: 100 }), "\0".repeat(8));
  assert.equal(decodeStream(entries, "87cURD]i,\"Ebo7", { left: 11 }), "Hello World");
  assert.equal(decodeStream(entries, "87cURD]i,\"Ebo7", { left: 10 }), null);
});
