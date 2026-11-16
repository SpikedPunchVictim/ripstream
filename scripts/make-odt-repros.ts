/*
 * Writes the small OpenDocument text files of the repro fixtures in packages/parsers/test/fixtures/repros (tikajs-uay4):
 *   node scripts/make-odt-repros.ts [out-dir]
 * Each is a stored zip of a mimetype and a content.xml (and a styles.xml for the header and footer one) of a few hundred bytes of
 * synthetic text. The expected texts in the fixtures were read off Apache Tika 4.2.0.
 */
import { crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A zip that stores each entry uncompressed, in the order given (the mimetype first, as ODF wants). */
function zip(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 10);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    parts.push(header, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';

/** A text document with `body` in office:text and, when given, `masterStyles` in the master styles of styles.xml. */
function odt(body: string, masterStyles?: string): Buffer {
  const entries: [string, string][] = [
    ["mimetype", "application/vnd.oasis.opendocument.text"],
    [
      "content.xml",
      `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NAMESPACES} office:version="1.2"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
    ],
  ];
  if (masterStyles !== undefined) {
    entries.push([
      "styles.xml",
      `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${NAMESPACES} office:version="1.2"><office:master-styles>${masterStyles}</office:master-styles></office:document-styles>`,
    ]);
  }
  return zip(entries);
}

const note = (kind: string, citation: string, ...paragraphs: string[]): string =>
  `<text:note text:note-class="${kind}"><text:note-citation>${citation}</text:note-citation><text:note-body>${paragraphs
    .map((text) => `<text:p>${text}</text:p>`)
    .join("")}</text:note-body></text:note>`;

const FILES: Record<string, Buffer> = {
  // A footnote and an endnote with their citations, one with two paragraphs, and a note with no citation.
  "odt-notes.odt": odt(
    `<text:p>Some text${note("footnote", "1", "Footnote text")} with a footnote.</text:p>` +
      `<text:p>Two${note("endnote", "i", "P1", "P2")}paragraphs.</text:p>` +
      `<text:p>None<text:note><text:note-body><text:p>N</text:p></text:note-body></text:note>.</text:p>`,
  ),
  // A list inside a list, written with the line breaks and indent of a pretty-printed file, and an empty item.
  "odt-nested-list.odt": odt(
    "<text:list>\n  <text:list-item>\n    <text:p>one</text:p>\n    <text:list>\n      <text:list-item><text:p>one.one</text:p></text:list-item>\n    </text:list>\n  </text:list-item>\n" +
      "  <text:list-item><text:p>two</text:p></text:list-item>\n  <text:list-item>\n  </text:list-item>\n</text:list>",
  ),
  // The header, footer and left header of a master page, in that order, with page-number and page-count fields.
  "odt-header-footer.odt": odt(
    "<text:p>Body</text:p>",
    '<style:master-page style:name="Standard"><style:header><text:p>Head</text:p></style:header>' +
      "<style:footer><text:p>Page <text:page-number>1</text:page-number> of <text:page-count>9</text:page-count> </text:p></style:footer>" +
      "<style:header-left><text:p>Left</text:p></style:header-left></style:master-page>",
  ),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../packages/parsers/test/fixtures/repros");
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(out, name), bytes);
}
