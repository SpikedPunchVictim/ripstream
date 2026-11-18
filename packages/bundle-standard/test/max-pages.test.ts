import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { LimitExceededError, createRipstream } from "../src/index.ts";
import { createStandardIsolation } from "../src/isolation.ts";

/** tikajs-efpm: `limits.maxPages` refuses a PDF with too many pages, and an xlsx or pptx with too many sheets or slides, before any text; a child answers as this process does. */

const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 4 });
const standard = await createStandardIsolation({ config: { mode: "strict" }, pool });
after(async () => {
  await standard.isolator.dispose();
  pool.dispose();
});
const arms = [
  ["in-process", createRipstream()],
  ["child", standard.ripstream],
] as const;

function pdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_, i) => `${6 + i * 2} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< >>", "<< >>"]; // objects 4 and 5 are unused fillers
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 24 Tf 72 700 Td (page ${i + 1}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${7 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
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
  return new TextEncoder().encode(out);
}

/** A ZIP with every entry stored. */
function zip(entries: Readonly<Record<string, string>>): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0021, 12);
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

const TYPES = (main: string, part: string): string =>
  `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="${part}" ContentType="${main}"/></Types>`;
const RELS = (part: string): string =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`;

function xlsx(sheets: number): Uint8Array {
  const entries: Record<string, string> = {
    "[Content_Types].xml": TYPES("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", "/xl/workbook.xml"),
    "_rels/.rels": RELS("xl/workbook.xml"),
    "xl/workbook.xml": `<workbook xmlns="x"><sheets>${Array.from({ length: sheets }, (_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}"/>`).join("")}</sheets></workbook>`,
  };
  for (let i = 1; i <= sheets; i++) entries[`xl/worksheets/sheet${i}.xml`] = `<worksheet xmlns="x"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>cell${i}</t></is></c></row></sheetData></worksheet>`;
  return zip(entries);
}

function pptx(slides: number): Uint8Array {
  const entries: Record<string, string> = {
    "[Content_Types].xml": TYPES("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml", "/ppt/presentation.xml"),
    "_rels/.rels": RELS("ppt/presentation.xml"),
    "ppt/presentation.xml": '<p:presentation xmlns:p="x"/>',
  };
  for (let i = 1; i <= slides; i++) entries[`ppt/slides/slide${i}.xml`] = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>slide${i}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return zip(entries);
}

function odf(kind: "ods" | "odp", count: number): Uint8Array {
  const mime = kind === "ods" ? "application/vnd.oasis.opendocument.spreadsheet" : "application/vnd.oasis.opendocument.presentation";
  const body =
    kind === "ods"
      ? `<office:spreadsheet>${Array.from({ length: count }, (_, i) => `<table:table table:name="S${i + 1}"><table:table-row><table:table-cell><text:p>cell${i + 1}</text:p></table:table-cell></table:table-row></table:table>`).join("")}</office:spreadsheet>`
      : `<office:presentation>${Array.from({ length: count }, (_, i) => `<draw:page draw:name="P${i + 1}"><draw:frame><draw:text-box><text:p>slide${i + 1}</text:p></draw:text-box></draw:frame></draw:page>`).join("")}</office:presentation>`;
  return zip({
    mimetype: mime,
    "content.xml": `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${body}</office:body></office:document-content>`,
  });
}

async function outcome(arm: (typeof arms)[number][1], bytes: Uint8Array, filename: string, maxPages?: number): Promise<{ text: string } | LimitExceededError> {
  try {
    return await arm.parse(bytes, { filename, ...(maxPages === undefined ? {} : { limits: { maxPages } }) });
  } catch (error) {
    assert.ok(error instanceof LimitExceededError, String(error));
    return error;
  }
}

for (const [name, make, filename, unit] of [
  ["pdf", pdf, "p.pdf", "pages"],
  ["xlsx", xlsx, "s.xlsx", "sheets"],
  ["pptx", pptx, "s.pptx", "slides"],
  ["ods", (n: number) => odf("ods", n), "s.ods", "sheets"],
  ["odp", (n: number) => odf("odp", n), "s.odp", "slides"],
] as const) {
  for (const [arm, ripstream] of arms) {
    test(`${arm}: maxPages refuses a ${name} of 3 ${unit} at 2, names the limit, and reads it whole at 3`, async () => {
      const refused = await outcome(ripstream, make(3), filename, 2);
      assert.ok(refused instanceof LimitExceededError, "refused");
      assert.equal(refused.limit, "pages");
      assert.deepEqual([refused.observed, refused.max], [3, 2]);
      const read = await outcome(ripstream, make(3), filename, 3);
      assert.ok(!(read instanceof LimitExceededError), String(read));
      assert.match(read.text, /3/);
    });
  }
}

test("a child and this process refuse with the same message, and a request names maxPages like any limit", async () => {
  const [local, child] = await Promise.all(arms.map(([, ripstream]) => outcome(ripstream, pdf(3), "p.pdf", 1)));
  assert.ok(local instanceof LimitExceededError && child instanceof LimitExceededError);
  assert.equal(child.message, local.message);
  await assert.rejects(standard.ripstream.parse(pdf(1), { filename: "p.pdf", limits: { maxPages: -1 } }), RangeError);
});
