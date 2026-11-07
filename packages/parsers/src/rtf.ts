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
    _ctx: ParseContext,
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const source = new TextDecoder("latin1").decode(data);
    if (!source.trimStart().startsWith("{\\rtf")) {
      throw new MalformedDocumentError("Not an RTF document");
    }
    const result = tokenize(source);
    applyInfo(metadata, result.info);

    const xhtml = new XHTMLContentHandler(handler, metadata);
    await xhtml.startDocument();
    for (const paragraph of result.text.split("\n")) {
      const value = paragraph.trimEnd();
      if (value.length === 0) continue;
      await xhtml.startElement("p");
      await xhtml.characters(value);
      await xhtml.endElement("p");
    }
    await xhtml.endDocument();
  }
}

const HEX_ESCAPE = /^[0-9a-fA-F]{2}$/;
const MAX_GROUP_DEPTH = 1_000;

interface TokenizeResult {
  readonly text: string;
  readonly info: InfoValues;
}

function tokenize(rtf: string): TokenizeResult {
  const stack: Frame[] = [
    { skip: false, destination: "body", unicodeFallback: 0, uc: 1 },
  ];
  let output = "";
  let codepage = 1252;
  let infoField = "";
  let infoDate: string | null = null;
  const info: InfoValues = {};
  const dateParts: Record<string, number> = {};
  let position = 0;

  const top = (): Frame => stack[stack.length - 1]!;
  const append = (value: string): void => {
    const frame = top();
    if (frame.unicodeFallback > 0) {
      frame.unicodeFallback = Math.max(0, frame.unicodeFallback - value.length);
      return;
    }
    if (frame.skip) return;
    if (frame.destination === "info") {
      if (infoDate !== null) {
        if (infoField.length > 0) info[infoField] = (info[infoField] ?? "") + value;
      } else if (infoField.length > 0) {
        info[infoField] = (info[infoField] ?? "") + value;
      }
      return;
    }
    output += value;
  };

  while (position < rtf.length) {
    const char = rtf[position]!;
    if (char === "{") {
      if (stack.length >= MAX_GROUP_DEPTH) {
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
        if (rtf[end] === "\\" && rtf[end + 1] === "'") cursor = end + 1;
        else break;
      }
      position = end;
      if (run.length === 0) continue;
      // \ucN fallback bytes belong to a preceding \uN and are dropped.
      const frame = top();
      const dropped = Math.min(frame.unicodeFallback, run.length);
      frame.unicodeFallback -= dropped;
      const kept = run.slice(dropped);
      if (kept.length > 0) append(decodeAnsi(new Uint8Array(kept), codepage));
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
    if (!/[a-zA-Z]/.test(next)) {
      position++;
      continue;
    }

    const start = position;
    while (position < rtf.length && /[a-zA-Z]/.test(rtf[position]!)) position++;
    const word = rtf.slice(start, position);
    let parameter: number | null = null;
    const numberStart = position;
    if (rtf[position] === "-") position++;
    while (position < rtf.length && /[0-9]/.test(rtf[position]!)) position++;
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

    switch (word) {
      case "ansicpg":
        if (parameter !== null) codepage = parameter;
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
  return { text: output, info };

  function finalizeInfoDate(): void {
    if (infoDate === null) return;
    const year = dateParts[`${infoDate}:yr`];
    const month = dateParts[`${infoDate}:mo`];
    const day = dateParts[`${infoDate}:dy`];
    if (year === undefined || month === undefined || day === undefined) return;
    const hour = dateParts[`${infoDate}:hr`] ?? 0;
    const minute = dateParts[`${infoDate}:min`] ?? 0;
    info[infoDate] = new Date(
      Date.UTC(year, month - 1, day, hour, minute),
    ).toISOString();
  }
}

function decodeAnsi(bytes: Uint8Array, codepage: number): string {
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
