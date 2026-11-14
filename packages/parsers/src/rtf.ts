import {
  MalformedDocumentError,
  MediaType,
  Metadata,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  type RipstreamInputStream,
} from "@spikedpunch/ripstream-core";

interface Frame {
  skip: boolean;
  destination: string;
  unicodeFallback: number;
  uc: number;
  /** The font selected by \fN in this group or an enclosing one (and, in the font table, the entry being defined); null before any. */
  font: number | null;
}

interface InfoValues {
  [key: string]: string;
}

const SKIP_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "pict",
  "object",
  "objdata",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
  "xmlnstbl",
  "filetbl",
  "revtbl",
  "fldinst",
  "headerxml",
  "bkmkstart",
  "bkmkend",
  "xe",
  "tc",
  "nonshppict",
  "shppict",
  "mmathPr",
  "wgrffmtfilter",
  "panose",
  "falt",
  "fname",
  "oldcprops",
  "oldpprops",
  "oldsprops",
  "oldtprops",
]);

const TEXT_DESTINATIONS = new Set([
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "footnote",
  "annotation",
]);

/** RTF tokenizer and text extractor. */
export class RtfParser implements Parser {
  readonly name = "RTFParser";

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set(
      ["application/rtf", "text/rtf"].map((type) => MediaType.parse(type)!),
    );
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    // The input is read up to the embedded-resource byte limit and no further: a stream longer than that is refused
    // after maxEmbeddedResourceBytes + 1 bytes, not after being buffered whole (tikajs-kpkn).
    const data = await stream.readFully(ctx.limits.maxEmbeddedResourceBytes);

    // A UTF-8 byte-order mark in front of the opening brace is not part of the document (tikajs-12kd). The bytes are
    // read as latin1 below, so it shows as these three characters.
    const decoded = new TextDecoder("latin1").decode(data);
    const source = decoded.startsWith("\u00ef\u00bb\u00bf") ? decoded.slice(3) : decoded;
    if (!source.trimStart().startsWith("{\\rtf")) {
      throw new MalformedDocumentError("Not an RTF document");
    }
    // The XHTML head is written with the first paragraph and holds every \info value, and \info can come after the
    // body. A first pass reads the metadata alone, so the second can write each paragraph as it is tokenized and an
    // output cap or an error stops it there (tikajs-68os.73).
    applyInfo(metadata, scanInfo(source));

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    // A paragraph is a line of the text. The tail is the unfinished last line, held until its newline arrives.
    let tail: string[] = [];
    const writeParagraph = async (line: string): Promise<void> => {
      const value = line.trimEnd();
      if (value.length === 0) return;
      await xhtml.startElement("p");
      await xhtml.characters(value);
      await xhtml.endElement("p");
    };
    for (const piece of tokenize(source)) {
      const lastNewline = piece.lastIndexOf("\n");
      if (lastNewline < 0) {
        tail.push(piece);
        continue;
      }
      const lines = (tail.join("") + piece.slice(0, lastNewline)).split("\n");
      tail = [piece.slice(lastNewline + 1)];
      for (const line of lines) await writeParagraph(line);
    }
    await writeParagraph(tail.join(""));
    await xhtml.endDocument();
  }
}

const HEX_ESCAPE = /^[0-9a-fA-F]{2}$/;
/** The characters the tokenizer handles itself; every other character is text. */
const DELIMITER = /[{}\\\r\n]/g;
const MAX_GROUP_DEPTH = 1_000;

function isAsciiLetter(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
const OUTPUT_PIECE = 8192;
/** An \info value is metadata; one longer than the default metadata value cap is cut there anyway. */
const MAX_INFO_VALUE_CHARS = 1_000_000;

/** Control words that stand for one character in the text. */
const SYMBOL_WORDS: ReadonlyMap<string, string> = new Map([
  ["lquote", "\u2018"],
  ["rquote", "\u2019"],
  ["ldblquote", "\u201c"],
  ["rdblquote", "\u201d"],
  ["emdash", "\u2014"],
  ["endash", "\u2013"],
  ["bullet", "\u2022"],
  // A table cell and row end separate the text of the cells; without them neighbouring cells run together.
  ["cell", "\t"],
  ["nestcell", "\t"],
  ["row", "\n"],
  ["nestrow", "\n"],
]);

/** The \info values of the document, read without collecting its text. Stops at the nesting limit, where the text pass fails. */
function scanInfo(rtf: string): InfoValues {
  const scan = tokenize(rtf, false).next();
  return scan.value as InfoValues;
}

/**
 * Yields the document text in pieces of up to OUTPUT_PIECE appended values and returns the \info values. With
 * `collectText` false it yields nothing and, at the nesting limit, returns what it has instead of throwing: the text
 * pass reaches the same point, having written what came before it.
 */
function* tokenize(rtf: string, collectText = true): Generator<string, InfoValues, undefined> {
  const stack: Frame[] = [
    { skip: false, destination: "body", unicodeFallback: 0, uc: 1, font: null },
  ];
  // The text is collected 8192 values at a time, each piece joined to a flat string. `output += char` for each of
  // 20M characters builds a rope of 20M nodes (975 MB for a 20 MB document, tikajs-kpkn) that is flattened only at the end.
  let pending: string[] = [];
  let codepage = 1252;
  // The code page of each font the font table gives an \fcharset (tikajs-ekue), and the font text is in before any \fN.
  const fontCodepages = new Map<number, number>();
  let defaultFont: number | null = null;
  let infoField = "";
  let infoDate: string | null = null;
  const info: InfoValues = {};
  const dateParts: Record<string, number> = {};
  let position = 0;

  const top = (): Frame => stack[stack.length - 1]!;
  /** The code page of the active font's charset when it has one, else the document's \ansicpg. */
  const activeCodepage = (): number => {
    const font = top().font ?? defaultFont;
    return (font === null ? undefined : fontCodepages.get(font)) ?? codepage;
  };
  const append = (value: string): void => {
    const frame = top();
    if (frame.unicodeFallback > 0) {
      frame.unicodeFallback = Math.max(0, frame.unicodeFallback - value.length);
      return;
    }
    if (frame.skip) return;
    if (frame.destination === "info") {
      if (infoField.length > 0) {
        const previous = info[infoField] ?? "";
        info[infoField] = previous + value.slice(0, Math.max(0, MAX_INFO_VALUE_CHARS - previous.length));
      }
      return;
    }
    if (collectText) pending.push(value);
  };

  while (position < rtf.length) {
    if (pending.length >= OUTPUT_PIECE) {
      yield pending.join("");
      pending = [];
    }
    const char = rtf[position]!;
    if (char === "{") {
      if (stack.length >= MAX_GROUP_DEPTH) {
        if (!collectText) return info;
        throw new MalformedDocumentError(
          `RTF group nesting exceeds ${MAX_GROUP_DEPTH}`,
        );
      }
      stack.push({ ...top() });
      position++;
      continue;
    }
    if (char === "}") {
      if (stack.length > 1) stack.pop();
      position++;
      if (top().destination === "info") {
        finalizeInfoDate();
        infoField = "";
        infoDate = null;
      }
      continue;
    }
    if (char === "\r" || char === "\n") {
      position++;
      continue;
    }
    if (char !== "\\") {
      const frame = top();
      if (frame.unicodeFallback === 0) {
        // A run of plain characters is appended whole, or dropped in a skipped group, as `append` would for each one.
        DELIMITER.lastIndex = position;
        const end = DELIMITER.test(rtf) ? DELIMITER.lastIndex - 1 : rtf.length;
        if (frame.destination === "info") append(rtf.slice(position, end));
        else if (collectText && !frame.skip) pending.push(rtf.slice(position, end));
        position = end;
        continue;
      }
      append(char);
      position++;
      continue;
    }

    position++;
    if (position >= rtf.length) break;
    const next = rtf[position]!;

    if (next === "*") {
      top().skip = true;
      position++;
      continue;
    }
    if (next === "'") {
      // Collect the whole run of consecutive \'xx escapes so double-byte code
      // pages (932/936/949/950) are decoded across byte boundaries.
      const run: number[] = [];
      let cursor = position; // points at the "'" of the next candidate escape
      let end = position + 3; // malformed escapes are skipped, as before
      while (HEX_ESCAPE.test(rtf.slice(cursor + 1, cursor + 3))) {
        run.push(Number.parseInt(rtf.slice(cursor + 1, cursor + 3), 16));
        end = cursor + 3;
        // A line break between two escapes is not text (RTF ignores CR and LF), so a double-byte character that a writer
        // wrapped across lines is still one run (tikajs-ig3h).
        let next = end;
        while (rtf[next] === "\r" || rtf[next] === "\n") next++;
        if (rtf[next] === "\\" && rtf[next + 1] === "'") cursor = next + 1;
        else break;
      }
      position = end;
      if (run.length === 0) continue;
      // \ucN fallback bytes belong to a preceding \uN and are dropped.
      const frame = top();
      const dropped = Math.min(frame.unicodeFallback, run.length);
      frame.unicodeFallback -= dropped;
      const kept = run.slice(dropped);
      if (kept.length > 0) append(decodeAnsi(new Uint8Array(kept), activeCodepage()));
      continue;
    }
    if (next === "\\" || next === "{" || next === "}") {
      append(next);
      position++;
      continue;
    }
    if (next === "~") {
      append(" ");
      position++;
      continue;
    }
    if (next === "-" || next === "_") {
      append(next === "-" ? "­" : "‑");
      position++;
      continue;
    }
    if (next === "\n" || next === "\r") {
      position++;
      continue;
    }
    if (!isAsciiLetter(next.charCodeAt(0))) {
      position++;
      continue;
    }

    const start = position;
    while (position < rtf.length && isAsciiLetter(rtf.charCodeAt(position))) position++;
    const word = rtf.slice(start, position);
    let parameter: number | null = null;
    const numberStart = position;
    if (rtf[position] === "-") position++;
    while (position < rtf.length && isAsciiDigit(rtf.charCodeAt(position))) position++;
    if (position > numberStart) {
      parameter = Number.parseInt(rtf.slice(numberStart, position), 10);
    }
    if (rtf[position] === " ") position++;

    if (SKIP_DESTINATIONS.has(word)) {
      top().skip = true;
      top().destination = word;
      continue;
    }
    if (TEXT_DESTINATIONS.has(word)) {
      top().destination = word;
      continue;
    }
    if (word === "info") {
      top().destination = "info";
      continue;
    }

    const symbol = SYMBOL_WORDS.get(word);
    if (symbol !== undefined) {
      append(symbol);
      continue;
    }

    switch (word) {
      case "ansicpg":
        if (parameter !== null) codepage = parameter;
        break;
      case "deff":
        if (parameter !== null) defaultFont = parameter;
        break;
      case "f":
        // In the font table this names the entry being defined, in the text the font that follows.
        if (parameter !== null) top().font = parameter;
        break;
      case "fcharset": {
        const font = top().font;
        const charsetCodepage = parameter === null ? undefined : FCHARSET_CODEPAGES.get(parameter);
        if (font !== null && charsetCodepage !== undefined) fontCodepages.set(font, charsetCodepage);
        break;
      }
      case "shptxt":
        // Text-box text sits inside {\*\shpinst ...}, an ignorable destination that would otherwise drop it (tikajs-k49h).
        top().skip = false;
        break;
      case "uc":
        if (parameter !== null) top().uc = Math.max(0, parameter);
        break;
      case "u": {
        if (parameter === null) break;
        const code = parameter < 0 ? parameter + 65536 : parameter;
        const frame = top();
        frame.unicodeFallback = 0;
        append(String.fromCharCode(code));
        frame.unicodeFallback = frame.uc;
        break;
      }
      case "par":
      case "line":
      case "page":
      case "sect":
        append("\n");
        break;
      case "tab":
        append("\t");
        break;
      case "bin":
        if (parameter !== null && parameter > 0) position += parameter;
        break;
      case "title":
      case "author":
      case "subject":
      case "keywords":
      case "comment":
      case "doccomm":
      case "company":
      case "manager":
      case "category":
      case "operator":
        if (top().destination === "info") {
          infoField = word;
          infoDate = null;
        }
        break;
      case "creatim":
      case "revtim":
        if (top().destination === "info") {
          infoDate = word;
          infoField = "";
          dateParts[word] = 0;
        }
        break;
      case "yr":
      case "mo":
      case "dy":
      case "hr":
      case "min":
        if (infoDate !== null && parameter !== null) {
          dateParts[`${infoDate}:${word}`] = parameter;
        }
        break;
      default:
        break;
    }

  }

  finalizeInfoDate();
  if (pending.length > 0) yield pending.join("");
  return info;

  function finalizeInfoDate(): void {
    if (infoDate === null) return;
    const year = dateParts[`${infoDate}:yr`];
    const month = dateParts[`${infoDate}:mo`];
    const day = dateParts[`${infoDate}:dy`];
    if (year === undefined || month === undefined || day === undefined) return;
    const hour = dateParts[`${infoDate}:hr`] ?? 0;
    const minute = dateParts[`${infoDate}:min`] ?? 0;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    // A part far out of range (\yr300000) makes an invalid date, and toISOString would throw on it.
    if (Number.isNaN(date.getTime())) return;
    info[infoDate] = date.toISOString();
  }
}

/**
 * The code page of an \fcharset value (the RTF specification's table, as Tika 4.2.0 reads it; measured with a document whose
 * \ansicpg is 1251). 0 (ANSI) is windows-1252 for a font that says so, whatever the document's \ansicpg; 1 (default) and 2
 * (symbol) leave the document's. 78 is read as Shift-JIS, 254 as code page 437 and 255 (OEM) as 850. 130 (Johab, code page
 * 1361) is not decoded here: Tika reads it, TextDecoder cannot.
 */
const FCHARSET_CODEPAGES: ReadonlyMap<number, number> = new Map([
  [0, 1252], [77, 10000], [78, 932], [254, 437], [255, 850], [128, 932], [129, 949], [130, 1361], [134, 936], [136, 950], [161, 1253], [162, 1254], [163, 1258],
  [177, 1255], [178, 1256], [186, 1257], [204, 1251], [222, 874], [238, 1250],
]);

/** The characters of bytes 0x80 to 0xff in the two OEM code pages Tika reads and TextDecoder does not know. */
const OEM_CODEPAGES: ReadonlyMap<number, string> = new Map([
  [437, "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "],
  [850, "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ "],
]);

function decodeAnsi(bytes: Uint8Array, codepage: number): string {
  const oem = OEM_CODEPAGES.get(codepage);
  if (oem !== undefined) return Array.from(bytes, (byte) => (byte < 0x80 ? String.fromCharCode(byte) : oem[byte - 0x80]!)).join("");
  try {
    return new TextDecoder(encodingFor(codepage)).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function encodingFor(codepage: number): string {
  if (codepage === 65001) return "utf-8";
  if (codepage === 932) return "shift_jis";
  if (codepage === 936) return "gbk";
  if (codepage === 949) return "euc-kr";
  if (codepage === 950) return "big5";
  if (codepage === 874) return "windows-874";
  if (codepage === 866) return "ibm866";
  if (codepage === 20866) return "koi8-r";
  if (codepage === 21866) return "koi8-u";
  if (codepage === 10000) return "macintosh";
  if (codepage === 54936) return "gb18030";
  return codepage >= 1250 && codepage <= 1258
    ? `windows-${codepage}`
    : "windows-1252";
}

function applyInfo(metadata: Metadata, info: InfoValues): void {
  set(metadata, "dc:title", info.title);
  set(metadata, "dc:creator", info.author);
  set(metadata, "dc:description", info.subject ?? info.comment ?? info.doccomm);
  set(metadata, "pdf:Keywords", info.keywords);
  set(metadata, "extended-properties:Company", info.company);
  set(metadata, "extended-properties:Manager", info.manager);
  set(metadata, "cp:category", info.category);
  set(metadata, "dcterms:created", info.creatim);
  set(metadata, "dcterms:modified", info.revtim);
}

function set(metadata: Metadata, key: string, value: string | undefined): void {
  if (value !== undefined && value.trim().length > 0) {
    metadata.set(key, value.trim());
  }
}
