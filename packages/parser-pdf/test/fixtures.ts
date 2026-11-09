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
export function encryptedPdf(userPassword: string): Buffer {
  const fileId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);

  const ownerKey = md5(padPassword("owner-secret")).subarray(0, 5);
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
      `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> >>`,
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
