/**
 * A minimal repair for structurally truncated PDFs: recover the complete indirect objects still present, rewrite the
 * cross-reference table and trailer, and hand pdf.js a readable file. PDFBox recovers such files by scanning objects;
 * pdf.js refuses them when the xref or trailer is gone, so this replaces that scan for the common uncompressed case.
 * Compressed object streams (`/ObjStm`) are not expanded; a file whose catalog lives in one is left unrepaired.
 */
export function repairPdf(data: Uint8Array): Uint8Array | null {
  const text = new TextDecoder("latin1").decode(data);
  const objects = new Map<number, string>();
  const header = /^%PDF-\d+\.\d+/.exec(text)?.[0];
  if (header === undefined) return null;
  // Encrypted documents are refused, never repaired around the encryption.
  if (/\/Encrypt\b/.test(text)) return null;
  const pattern = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  for (const match of text.matchAll(pattern)) {
    const number = Number(match[1]);
    const start = match.index! + match[0].length;
    const end = text.indexOf("endobj", start);
    if (end < 0) continue;
    if (objects.has(number)) continue;
    objects.set(number, text.slice(start, end));
  }
  if (objects.size === 0) return null;
  let catalog: number | null = null;
  for (const [number, body] of objects) {
    if (/\/Type\s*\/Catalog\b/.test(body)) {
      catalog = number;
      break;
    }
  }
  if (catalog === null) return null;
  const numbers = [...objects.keys()].sort((left, right) => left - right);
  const size = numbers[numbers.length - 1]! + 1;

  let out = `${header}\n%âãÏÓ\n`;
  const offsets = new Map<number, number>();
  for (const number of numbers) {
    offsets.set(number, out.length);
    out += `${number} 0 obj${objects.get(number)!}endobj\n`;
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  let expected = 1;
  for (const number of numbers) {
    if (number !== expected) out += `${number} 1\n`;
    const offset = String(offsets.get(number)!).padStart(10, "0");
    out += `${offset} 00000 n \n`;
    expected = number + 1;
  }
  out += `trailer\n<< /Size ${size} /Root ${catalog} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(out, (char) => char.charCodeAt(0) & 0xff);
}
