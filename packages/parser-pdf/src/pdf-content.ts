import type { StreamDecryptor } from "./pdf-decrypt.ts";
import type { ObjectIndex, PdfObject } from "./pdf-objects.ts";
import { decodeStream, dictEntries, parseName, parseReference, referencesIn, type DecodeBudget } from "./pdf-syntax.ts";

/**
 * What a page's content streams do, read from the brute-force object index rather than through pdf.js: whether they
 * show text and whether they paint an image. pdf.js only says what text it found; this says whether there was any to
 * find, and whether a page with none is a picture.
 */

/** Cap on content-stream bytes decoded per document. */
export const MAX_CONTENT_DECODED_BYTES = 32 * 1024 * 1024;

/** Form XObjects nested deeper than this are not followed. */
const MAX_FORM_DEPTH = 8;

/** /Parent links followed to find inherited resources. */
const MAX_PARENT_HOPS = 32;

export interface PageContent {
  /**
   * `read`: every content stream was found and decoded. `none`: the page names no content (a blank page). `cut-off`: the
   * page object is cut off before it names any content, or a content stream it names is cut off. `missing`: a content stream it names is not in the file.
   * `unreadable`: one did not decode (an unsupported filter, encryption, or the decoding budget ran out).
   */
  readonly contents: "read" | "none" | "cut-off" | "missing" | "unreadable";
  /** A text-showing operator with a non-empty string, on the page or in a form it paints. */
  readonly showsText: boolean;
  /**
   * It paints an image XObject or an inline image, directly or through a form. When the content is not readable, whether
   * its resources hold an image XObject.
   */
  readonly paintsImage: boolean;
  /** Text is shown in a font with no font file (a Type3 font counts as embedded); false when the content was not read. */
  readonly nonEmbeddedFont: boolean;
}

interface Painted {
  showsText: boolean;
  paintsImage: boolean;
  nonEmbeddedFont: boolean;
}

export class PageContentScanner {
  readonly #index: ObjectIndex;
  readonly #decrypt: StreamDecryptor | null;
  readonly #budget: DecodeBudget = { left: MAX_CONTENT_DECODED_BYTES };
  readonly #forms = new Map<number, Painted | null>();

  constructor(index: ObjectIndex, decrypt: StreamDecryptor | null = null) {
    this.#index = index;
    this.#decrypt = decrypt;
  }

  /** The page object `num`'s content, or null when the index has no such object. */
  page(num: number): PageContent | null {
    const page = this.#index.objects.get(num);
    if (page === undefined) return null;
    const entries = dictEntries(page.body);
    const resources = this.#resources(page, entries);
    const contents = entries.get("Contents");
    if (contents === undefined || contents.trim() === "null") {
      return { contents: page.closed ? "none" : "cut-off", showsText: false, paintsImage: false, nonEmbeddedFont: false };
    }
    let refs = referencesIn(contents);
    const direct = parseReference(contents);
    if (direct !== null) {
      // /Contents may name an array object of streams rather than a stream.
      const target = this.#index.objects.get(direct.num);
      if (target !== undefined && target.stream === null && target.body.trim().startsWith("[")) refs = referencesIn(target.body);
    }
    if (refs.length === 0) return { contents: "missing", showsText: false, paintsImage: false, nonEmbeddedFont: false };
    let text = "";
    for (const ref of refs) {
      const stream = this.#index.objects.get(ref.num);
      if (stream === undefined || stream.stream === null) return { contents: "missing", showsText: false, paintsImage: false, nonEmbeddedFont: false };
      // What a cut-off stream would have shown after the cut is unknown.
      if (!stream.stream.complete) return { contents: "cut-off", showsText: false, paintsImage: false, nonEmbeddedFont: false };
      const decoded = this.#decode(stream);
      if (decoded === null) return { contents: "unreadable", showsText: false, paintsImage: this.#holdsImage(resources), nonEmbeddedFont: false };
      // Content streams are concatenated with a separator, as if one stream (ISO 32000-2 7.8.2).
      text += `${decoded}\n`;
    }
    const painted = this.#paint(text, resources, 0, new Set());
    return { contents: "read", ...painted };
  }

  #decode(object: PdfObject): string | null {
    const stream = object.stream!;
    let data = this.#index.text.slice(stream.start, stream.end);
    if (this.#decrypt !== null) {
      const plain = this.#decrypt(object.num, object.gen, data);
      if (plain === null) return null;
      data = plain;
    }
    return decodeStream(dictEntries(object.body), data, this.#budget);
  }

  /** The value an entry names, resolving one reference, as dictionary text. */
  #resolve(value: string | undefined): string | undefined {
    const ref = parseReference(value);
    if (ref === null) return value;
    return this.#index.objects.get(ref.num)?.body;
  }

  /** The page's /Resources, inherited from its ancestors when it has none. */
  #resources(page: PdfObject, entries: ReadonlyMap<string, string>): string | undefined {
    let current = entries;
    const seen = new Set<number>([page.num]);
    for (let hop = 0; hop <= MAX_PARENT_HOPS; hop++) {
      const own = current.get("Resources");
      if (own !== undefined) return this.#resolve(own);
      const parent = parseReference(current.get("Parent"));
      if (parent === null || seen.has(parent.num)) return undefined;
      seen.add(parent.num);
      const body = this.#index.objects.get(parent.num)?.body;
      if (body === undefined) return undefined;
      current = dictEntries(body);
    }
    return undefined;
  }

  #xobjects(resources: string | undefined): Map<string, string> {
    if (resources === undefined) return new Map();
    const xobject = this.#resolve(dictEntries(resources).get("XObject"));
    return xobject === undefined ? new Map() : dictEntries(xobject);
  }

  /** Whether any of the named page fonts has no font file. A font the resources do not hold is not counted. */
  #shownNonEmbedded(names: ReadonlySet<string>, resources: string | undefined): boolean {
    if (names.size === 0 || resources === undefined) return false;
    const fonts = this.#resolve(dictEntries(resources).get("Font"));
    if (fonts === undefined) return false;
    const entries = dictEntries(fonts);
    for (const name of names) {
      const font = this.#resolve(entries.get(name));
      if (font !== undefined && !this.#embedded(font, 0)) return true;
    }
    return false;
  }

  /** Whether a font dictionary has a font program, as PDFBox's isEmbedded asks: its descriptor's /FontFile, /FontFile2 or /FontFile3. */
  #embedded(font: string, depth: number): boolean {
    const entries = dictEntries(font);
    const subtype = parseName(entries.get("Subtype"));
    if (subtype === "Type3") return true;
    if (subtype === "Type0" && depth === 0) {
      const descendant = referencesIn(this.#resolve(entries.get("DescendantFonts"))).at(0) ?? referencesIn(entries.get("DescendantFonts")).at(0);
      const body = descendant === undefined ? undefined : this.#index.objects.get(descendant.num)?.body;
      return body === undefined || this.#embedded(body, 1);
    }
    const descriptor = this.#resolve(entries.get("FontDescriptor"));
    if (descriptor === undefined) return false;
    const keys = dictEntries(descriptor);
    return keys.has("FontFile") || keys.has("FontFile2") || keys.has("FontFile3");
  }

  #holdsImage(resources: string | undefined): boolean {
    for (const value of this.#xobjects(resources).values()) {
      const ref = parseReference(value);
      const target = ref === null ? undefined : this.#index.objects.get(ref.num);
      if (target !== undefined && parseName(dictEntries(target.body).get("Subtype")) === "Image") return true;
    }
    return false;
  }

  #paint(content: string, resources: string | undefined, depth: number, forms: Set<number>): Painted {
    const scan = scanContent(content);
    const result: Painted = {
      showsText: scan.showsText,
      paintsImage: scan.inlineImage,
      nonEmbeddedFont: this.#shownNonEmbedded(scan.fonts, resources),
    };
    if (scan.painted.size === 0) return result;
    const xobjects = this.#xobjects(resources);
    for (const name of scan.painted) {
      const ref = parseReference(xobjects.get(name));
      const target = ref === null ? undefined : this.#index.objects.get(ref.num);
      if (target === undefined) continue;
      const targetEntries = dictEntries(target.body);
      const subtype = parseName(targetEntries.get("Subtype"));
      if (subtype === "Image") result.paintsImage = true;
      if (subtype !== "Form" || target.stream === null || depth >= MAX_FORM_DEPTH || forms.has(target.num)) continue;
      let form = this.#forms.get(target.num);
      if (form === undefined) {
        const decoded = this.#decode(target);
        forms.add(target.num);
        form =
          decoded === null
            ? null
            : this.#paint(decoded, this.#resolve(targetEntries.get("Resources")) ?? resources, depth + 1, forms);
        forms.delete(target.num);
        this.#forms.set(target.num, form);
      }
      if (form !== null) {
        result.showsText ||= form.showsText;
        result.paintsImage ||= form.paintsImage;
        result.nonEmbeddedFont ||= form.nonEmbeddedFont;
      }
    }
    return result;
  }
}

interface ContentScan {
  readonly showsText: boolean;
  readonly inlineImage: boolean;
  /** Names painted with `Do`. */
  readonly painted: ReadonlySet<string>;
  /** Names of the fonts text is shown in, by the font selected with `Tf` as `q` and `Q` leave it. */
  readonly fonts: ReadonlySet<string>;
}

const TEXT_OPERATORS = new Set(["Tj", "TJ", "'", '"']);

/** One linear pass over a content stream's tokens. */
export function scanContent(content: string): ContentScan {
  const painted = new Set<string>();
  const fonts = new Set<string>();
  const saved: (string | null)[] = [];
  let font: string | null = null;
  let showsText = false;
  let inlineImage = false;
  let pendingString = false;
  let arrayDepth = 0;
  let arrayHasString = false;
  let lastName: string | null = null;
  const end = content.length;
  let at = 0;
  while (at < end) {
    const char = content[at]!;
    const code = char.charCodeAt(0);
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00) {
      at++;
      continue;
    }
    if (char === "%") {
      while (at < end && content[at] !== "\n" && content[at] !== "\r") at++;
      continue;
    }
    if (char === "(" || (char === "<" && content[at + 1] !== "<")) {
      let close: number;
      let nonEmpty: boolean;
      if (char === "(") {
        close = literalEnd(content, at);
        nonEmpty = close - at > 2;
      } else {
        const gt = content.indexOf(">", at + 1);
        close = gt === -1 ? end : gt + 1;
        nonEmpty = /[0-9A-Fa-f]/.test(content.slice(at + 1, close - 1));
      }
      if (arrayDepth > 0) arrayHasString ||= nonEmpty;
      else pendingString = nonEmpty;
      lastName = null;
      at = close;
      continue;
    }
    if (char === "<" || char === ">") {
      at += content[at + 1] === char ? 2 : 1;
      continue;
    }
    if (char === "[") {
      if (arrayDepth++ === 0) arrayHasString = false;
      at++;
      continue;
    }
    if (char === "]") {
      if (arrayDepth > 0 && --arrayDepth === 0) pendingString = arrayHasString;
      at++;
      continue;
    }
    if (char === "/") {
      let stop = at + 1;
      while (stop < end && !isTokenEnd(content, stop)) stop++;
      lastName = content.slice(at + 1, stop);
      at = stop;
      continue;
    }
    if (char === ")" || char === "{" || char === "}") {
      at++;
      continue;
    }
    let stop = at + 1;
    while (stop < end && !isTokenEnd(content, stop)) stop++;
    const token = content.slice(at, stop);
    at = stop;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token)) continue;
    if (TEXT_OPERATORS.has(token) && pendingString) {
      showsText = true;
      if (font !== null) fonts.add(font);
    } else if (token === "Tf") font = lastName;
    else if (token === "q") saved.push(font);
    else if (token === "Q") font = saved.pop() ?? font;
    else if (token === "Do" && lastName !== null) painted.add(lastName);
    else if (token === "BI") {
      inlineImage = true;
      at = inlineImageEnd(content, at);
    }
    pendingString = false;
    lastName = null;
  }
  return { showsText, inlineImage, painted, fonts };
}

function isTokenEnd(content: string, at: number): boolean {
  const code = content.charCodeAt(at);
  if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00) return true;
  return "()<>[]{}/%".includes(content[at]!);
}

function literalEnd(content: string, at: number): number {
  let depth = 0;
  for (let i = at; i < content.length; i++) {
    const char = content[i];
    if (char === "\\") i++;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
  }
  return content.length;
}

/** Past an inline image's `ID <data> EI`; its data is binary, so it is skipped rather than tokenised. */
function inlineImageEnd(content: string, from: number): number {
  const id = /\sID[\s]/g;
  id.lastIndex = from - 1;
  const start = id.exec(content);
  if (start === null) return content.length;
  const ei = /\sEI(?=[\s]|$)/g;
  ei.lastIndex = start.index + start[0].length;
  const stop = ei.exec(content);
  return stop === null ? content.length : stop.index + stop[0].length;
}
