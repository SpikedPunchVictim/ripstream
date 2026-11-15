import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function samplePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello PDF", { x: 72, y: 700, size: 24, font });
  document.setTitle("Sample");
  document.setAuthor("Ada");
  document.setCreationDate(new Date("2024-01-01T00:00:00Z"));
  return document.save();
}

export function rawPdf(objects: string[]): Uint8Array {
  const body = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`);
  return Buffer.from(
    `%PDF-1.4\n${body.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

export async function helloPdf(useObjectStreams: boolean): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("Recovered text", { x: 72, y: 700, size: 24, font });
  return Buffer.from(await document.save({ useObjectStreams }));
}

/** A PDF with `pageCount` pages, each carrying one line of text. */
export async function manyPagesPdf(pageCount: number): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 1; index <= pageCount; index++) {
    document.addPage().drawText(`Page number ${index}`, { x: 72, y: 700, size: 12, font });
  }
  return document.save();
}

// PDF 32000-1 section 7.6.3.3, the fixed padding applied to passwords.
const PASSWORD_PADDING = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
  "hex",
);

function md5(...parts: Buffer[]): Buffer {
  return createHash("md5").update(Buffer.concat(parts)).digest();
}

function padPassword(password: string): Buffer {
  return Buffer.concat([Buffer.from(password, "latin1"), PASSWORD_PADDING]).subarray(0, 32);
}

/** RC4 in plain JS: OpenSSL 3 does not ship it by default. */
function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i]! + key[i % key.length]!) & 255;
    [state[i], state[j]] = [state[j]!, state[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + state[a]!) & 255;
    [state[a], state[b]] = [state[b]!, state[a]!];
    out[k] = data[k]! ^ state[(state[a]! + state[b]!) & 255]!;
  }
  return out;
}

/**
 * One-page PDF reading "Secret text", encrypted with the standard security
 * handler (V1, R2, 40-bit RC4) so opening it needs `userPassword`.
 */
export function encryptedPdf(userPassword: string, permissionBits = -4, ownerPassword = "owner-secret"): Buffer {
  const fileId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(permissionBits);

  const ownerKey = md5(padPassword(ownerPassword)).subarray(0, 5);
  const owner = rc4(ownerKey, padPassword(userPassword));
  const fileKey = md5(padPassword(userPassword), owner, permissions, fileId).subarray(0, 5);
  const user = rc4(fileKey, PASSWORD_PADDING);

  const contentObject = 4;
  const objectKey = md5(
    fileKey,
    Buffer.from([contentObject & 255, (contentObject >> 8) & 255, 0, 0, 0]),
  ).subarray(0, 10);
  const content = rc4(objectKey, Buffer.from("BT /F1 24 Tf 72 700 Td (Secret text) Tj ET", "latin1"));

  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
        "/Resources << /Font << /F1 5 0 R >> >> >>",
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(
      `<< /Filter /Standard /V 1 /R 2 /P ${permissionBits} /O <${owner.toString("hex")}> /U <${user.toString("hex")}> >>`,
    ),
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const entries = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`);
  const id = fileId.toString("hex");
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries.join("")}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id}> <${id}>] >>\n` +
        `startxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

/**
 * A one-page PDF with an optional Info dictionary body (`<< /Title (x) >>`) and XMP packet, written with a correct xref
 * table so every reader (pdf.js, PDFBox) takes it as is. The text is "Hello" unless `text` says otherwise ("" for a page with none).
 */
export function infoXmpPdf(parts: { readonly info?: string; readonly xmp?: string; readonly text?: string }): Buffer {
  const content = parts.text === "" ? "" : `BT /F1 24 Tf 72 700 Td (${parts.text ?? "Hello"}) Tj ET`;
  const objects: string[] = [
    "",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 3 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let metadataRef = "";
  if (parts.xmp !== undefined) {
    objects.push(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(parts.xmp)} >>\nstream\n${parts.xmp}\nendstream`);
    metadataRef = ` /Metadata ${objects.length} 0 R`;
  }
  let infoRef = "";
  if (parts.info !== undefined) {
    objects.push(parts.info);
    infoRef = ` /Info ${objects.length} 0 R`;
  }
  objects[0] = `<< /Type /Catalog /Pages 2 0 R${metadataRef} >>`;
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** An XMP packet around `body`, with the usual namespaces declared and `x1` a namespace Tika has no mapping for. */
export function xmpPacket(body: string, attributes = ""): string {
  return (
    `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" ` +
    `xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" ` +
    `xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" xmlns:x1="http://example.com/ns/" ${attributes}>${body}</rdf:Description>` +
    `</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`
  );
}

/**
 * A PDF holding `objects` (numbered from 1, the first the catalog) with a correct classic xref table, as latin1 text so
 * a test can damage it. `trailer` adds entries to the trailer dictionary.
 */
export function classicPdf(objects: readonly string[], trailer = ""): string {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailer} >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** A content stream object for `content`, uncompressed. */
export function streamObject(content: string, dictionary = ""): string {
  return `<< /Length ${content.length}${dictionary} >>\nstream\n${content}\nendstream`;
}

/** Objects 1-5 of a one-page document showing `text` in Helvetica: catalog, pages, page, content, font. */
export function onePageObjects(text: string): string[] {
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    streamObject(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
}
