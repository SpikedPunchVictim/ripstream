import {
  EncryptedDocumentError,
  MalformedDocumentError,
  MediaType,
  XHTMLContentHandler,
  type ContentHandler,
  type Metadata,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

/** "\xffWPC", the file id of every WordPerfect document. */
const FILE_ID = "\u00ffWPC";
const WP5_MAJOR = 0;
const WP6_MAJOR = 2;

/** Fixed-length function sizes, counted from the function's first byte (MS WordPerfect 5.x/6.x function codes). */
const WP5_FIXED = new Map<number, number>([[192, 4], [193, 9], [194, 11], [195, 3], [196, 3], [197, 5], [198, 6], [199, 7], [200, 4], [201, 5], [202, 6], [203, 6], [204, 8], [205, 10], [206, 10], [207, 12]]);
const WP6_FIXED = new Map<number, number>([[240, 4], [241, 5], [242, 3], [243, 3], [244, 3], [245, 3], [246, 4], [247, 4], [248, 4], [249, 5], [250, 5], [251, 6], [252, 6], [253, 8], [254, 8]]);

/** WP6Charsets.DEFAULT_EXTENDED_INTL_CHARS: bytes 1 to 32. */
const DEFAULT_EXTENDED = ["\\0", "å", "Å", "æ", "Æ", "ä", "Ä", "á", "à", "â", "ã", "Ã", "ç", "Ç", "ë", "é", "É", "è", "ê", "í", "ñ", "Ñ", "ø", "Ø", "õ", "Õ", "ö", "Ö", "ü", "Ü", "ú", "ù", "ß"];

/** WP Charset 0: the printable ASCII set plus a non-breaking space, indexed by the character value. */
const WP_CHARSET_0 = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u00a0";

/** WP Charset 1: the multinational set (WP6Charsets.EXTENDED_CHARSETS[1]). */
const WP_CHARSET_1 = [..."\u0300\u00b7\u0303\u0302\u0335\u0338\u0301\u0308\u0304\u0313\u0315\u02bc\u0326\u0315\u00b0\u0307\u030b\u0327\u0328\u030c\u0337\u0305\u0306\u00df\u0138j\u00c1\u00e1\u00c2\u00e2\u00c4\u00e4\u00c0\u00e0\u00c5\u00e5\u00c6\u00e6\u00c7\u00e7\u00c9\u00e9\u00ca\u00ea\u00cb\u00eb\u00c8\u00e8\u00cd\u00ed\u00ce\u00ee\u00cf\u00ef\u00cc\u00ec\u00d1\u00f1\u00d3\u00f3\u00d4\u00f4\u00d6\u00f6\u00d2\u00f2\u00da\u00fa\u00db\u00fb\u00dc\u00fc\u00d9\u00f9\u0178\u00ff\u00c3\u00e3\u0110\u0111\u00d8\u00f8\u00d5\u00f5\u00dd\u00fd\u00d0\u00f0\u00de\u00fe\u0102\u0103\u0100\u0101\u0104\u0105\u0106\u0107\u010c\u010d\u0108\u0109\u010a\u010b\u010e\u010f\u011a\u011b\u0116\u0117\u0112\u0113\u0118\u0119\u01f4\u01f5\u011e\u011f\u01e6\u01e7\u0122\u0123\u011c\u011d\u0120\u0121\u0124\u0125\u0126\u0127\u0130i\u012a\u012b\u012e\u012f\u0128\u0129\u0132\u0133\u0134\u0135\u0136\u0137\u0139\u013a\u013d\u013e\u013b\u013c\u013f\u0140\u0141\u0142\u0143\u0144\u0000\u0149\u0147\u0148\u0145\u0146\u0150\u0151\u014c\u014d\u0152\u0153\u0154\u0155\u0158\u0159\u0156\u0157\u015a\u015b\u0160\u0161\u015e\u015f\u015c\u015d\u0164\u0165\u0162\u0163\u0166\u0167\u016c\u016d\u0170\u0171\u016a\u016b\u0172\u0173\u016e\u016f\u0168\u0169\u0174\u0175\u0176\u0177\u0179\u017a\u017d\u017e\u017b\u017c\u014a\u014b\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u1ef2\u1ef3\u010e\u010f\u01a0\u01a1\u01af\u01b0\u0114\u0115\u012c\u012dI\u0131\u014e\u014f"];

/**
 * WordPerfect 5.x/6.x text from the document area. The prefix area gives the version and the document-area pointer;
 * the text then runs through function codes, which this reads for their embedded text and skips otherwise.
 */
export class WordPerfectParser implements Parser {
  readonly name = "WordPerfectParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      [
        "application/vnd.wordperfect",
        "application/vnd.wordperfect; version=5.0",
        "application/vnd.wordperfect; version=5.1",
        "application/vnd.wordperfect; version=6.x",
        "application/wordperfect5.1",
      ].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (data.byteLength < 16 || new TextDecoder("latin1").decode(data.subarray(0, 4)) !== FILE_ID) {
      throw new MalformedDocumentError("Not a WordPerfect document");
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const docAreaPointer = view.getUint32(4, true);
    const majorVersion = data[10]!;
    const encrypted = view.getUint16(12, true) !== 0;
    if (encrypted) throw new EncryptedDocumentError("WordPerfect document is encrypted");
    if (majorVersion !== WP5_MAJOR && majorVersion !== WP6_MAJOR) {
      throw new MalformedDocumentError(`Unrecognized WordPerfect major version: ${majorVersion}`);
    }
    const text = majorVersion === WP6_MAJOR ? extractWp6(data, docAreaPointer) : extractWp5(data, docAreaPointer);
    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const paragraph of text.split("\n")) {
      if (paragraph.length > 0) await xhtml.element("p", paragraph);
    }
    await xhtml.endDocument();
  }
}

/** A cursor over the document area; reads are bounds-checked so a short file ends the text rather than throwing. */
class Cursor {
  readonly #data: Uint8Array;
  position: number;

  constructor(data: Uint8Array, position: number) {
    this.#data = data;
    this.position = position;
  }

  read(): number {
    return this.position < this.#data.byteLength ? this.#data[this.position++]! : -1;
  }

  skip(count: number): void {
    this.position = Math.min(this.#data.byteLength, this.position + count);
  }

  skipUntil(target: number): void {
    while (true) {
      const value = this.read();
      if (value === -1 || value === target) return;
    }
  }
}

function extractWp6(data: Uint8Array, pointer: number): string {
  const cursor = new Cursor(data, pointer);
  let text = "";
  for (;;) {
    const value = cursor.read();
    if (value === -1) break;
    if (value === 241) {
      cursor.read(); // undo/insert marker
      cursor.skip(3);
    } else if (value >= 1 && value <= 32) {
      text += DEFAULT_EXTENDED[value] ?? "";
    } else if (value >= 33 && value <= 126) {
      text += String.fromCharCode(value);
    } else if (value === 128) {
      text += " ";
    } else if (value === 129) {
      text += "\u00a0";
    } else if (value === 132) {
      text += "-";
    } else if (value === 135 || value === 137) {
      text += "\n";
    } else if (value === 138) {
      cursor.skipUntil(139);
    } else if (value === 198) {
      text += "\t";
    } else if (value >= 180 && value <= 207) {
      text += "\n";
    } else if (value >= 208 && value <= 239) {
      const subgroup = cursor.read();
      const functionSize = cursor.read() | (cursor.read() << 8);
      cursor.skip(functionSize - 4);
      if (value === 208) {
        if (subgroup >= 1 && subgroup <= 3) text += " ";
        else if (subgroup === 10) text += "\t";
        else if ((subgroup >= 4 && subgroup <= 19) || (subgroup >= 23 && subgroup <= 28)) text += "\n";
        else if (subgroup >= 20 && subgroup <= 22) text += " ";
      } else if (value === 213) {
        text += " ";
      } else if (value === 224) {
        text += "\t";
      }
    } else if (value === 240) {
      const charValue = cursor.read();
      const charset = cursor.read();
      cursor.read(); // closing character
      text += extendedChar(charset, charValue);
    } else if (value >= 241 && value <= 254) {
      cursor.skip((WP6_FIXED.get(value) ?? 1) - 1);
    } else if (value === 255) {
      cursor.skipUntil(255);
    }
  }
  return text;
}

function extractWp5(data: Uint8Array, pointer: number): string {
  const cursor = new Cursor(data, pointer);
  let text = "";
  for (;;) {
    const value = cursor.read();
    if (value === -1) break;
    if (value === 10 || value === 12) {
      text += "\n";
    } else if (value === 11 || value === 13) {
      text += " ";
    } else if (value >= 32 && value <= 126) {
      text += String.fromCharCode(value);
    } else if (value === 140 || value === 153) {
      text += "\n";
    } else if (value >= 144 && value <= 149) {
      text += " ";
    } else if (value === 160) {
      text += "\u00a0";
    } else if (value >= 169 && value <= 171) {
      text += "-";
    } else if (value === 192) {
      const charValue = cursor.read();
      const charset = cursor.read();
      cursor.read();
      text += extendedChar(charset, charValue);
    } else if (value >= 193 && value <= 207) {
      cursor.skip((WP5_FIXED.get(value) ?? 1) - 1);
    } else if (value >= 208 && value <= 255) {
      cursor.read(); // subgroup
      const size = cursor.read() | (cursor.read() << 8);
      cursor.skip(size > 0 ? size : 0);
    }
  }
  return text;
}

function extendedChar(charset: number, charValue: number): string {
  if (charValue < 0) return "";
  if (charset === 0) return charValue < WP_CHARSET_0.length ? WP_CHARSET_0[charValue]! : " ";
  if (charset === 1) return WP_CHARSET_1[charValue] ?? " ";
  return " ";
}
