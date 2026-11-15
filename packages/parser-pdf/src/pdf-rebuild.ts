import { inflateSync } from "node:zlib";
import { indexObjects, type ObjectIndex, type PdfObject } from "./pdf-objects.ts";
import { repairFontKeys } from "./pdf-keys.ts";
import { dictEntries, parseName, parseReference, referencesIn, type Reference } from "./pdf-syntax.ts";

/**
 * PDFBox-style brute-force recovery for a PDF whose xref, trailer or page tree is lost or wrong: every object is found
 * by scanning for `N G obj` (pdf-objects.ts), and a new file is written from them with a fresh xref and trailer. When
 * the catalog's page tree is missing or broken, a new one is made from the page objects that remain. `diagnosePdf` names
 * what was wrong, for the failure a caller sees when even this yields no text.
 */

/** What a recovery did, as written to `tk:pdf:repair-steps`. */
export type RepairStep =
  | "brute-force-scan"
  | "rebuilt-xref"
  | "synthetic-trailer"
  | "objstm-inlined"
  | "page-tree-rebuilt"
  | "font-repaired"
  | "stream-salvaged";

export interface RebuiltPdf {
  readonly data: Uint8Array;
  readonly steps: readonly RepairStep[];
}

/** Cap on stream data inflated to save the readable part of a stream that is cut off. */
const MAX_SALVAGED_BYTES = 16 * 1024 * 1024;

/** Page objects a rebuilt page tree may hold. */
const MAX_PAGES = 100_000;

const FONT_SUBTYPES = new Set(["Type0", "Type1", "MMType1", "Type3", "TrueType", "CIDFontType0", "CIDFontType2"]);

/** The file's bytes as latin1 text: one char per byte, unlike TextDecoder("latin1"), which is windows-1252. */
export function latin1(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
}

/**
 * A rewritten file holding every object found, or null when there is no `%PDF-` header in the first 1024 bytes, the file
 * is encrypted (its objects would need decrypting first), or no catalog with pages can be found.
 */
export function rebuildPdf(data: Uint8Array, index: ObjectIndex = indexObjects(latin1(data))): RebuiltPdf | null {
  const text = index.text;
  if (index.headerAt === -1 || /\/Encrypt\b/.test(text)) return null;
  const catalog = findCatalog(index);
  if (catalog === null) return null;
  const tree = pageTree(index, catalog);
  const steps: RepairStep[] = ["brute-force-scan", "rebuilt-xref", "synthetic-trailer"];
  if (index.inlined > 0) steps.push("objstm-inlined");

  const bodies = new Map<number, string>();
  let size = 1;
  for (const num of index.objects.keys()) size = Math.max(size, num + 1);
  if (tree.broken !== null) {
    const kids = [...tree.pages];
    const listed = new Set(kids);
    for (const object of byPosition(index)) {
      if (kids.length >= MAX_PAGES) break;
      if (!listed.has(object.num) && object.stream === null && isPage(dictEntries(object.body))) {
        kids.push(object.num);
        listed.add(object.num);
      }
    }
    if (kids.length === 0) return null;
    const root = size++;
    const original = tree.root === null ? undefined : index.objects.get(tree.root);
    const inherited = original === undefined ? new Map<string, string>() : dictEntries(original.body);
    const attributes = ["Resources", "MediaBox", "CropBox", "Rotate"]
      .filter((key) => inherited.has(key))
      .map((key) => ` /${key} ${inherited.get(key)!}`)
      .join("");
    const refs = kids.map((num) => `${num} ${index.objects.get(num)!.gen} R`).join(" ");
    bodies.set(root, `<< /Type /Pages /Kids [${refs}] /Count ${kids.length}${attributes} >>`);
    bodies.set(catalog.num, setEntry(index.objects.get(catalog.num)!.body, "Pages", `${root} 0 R`));
    for (const num of kids) {
      const page = index.objects.get(num)!;
      const parent = parseReference(dictEntries(page.body).get("Parent"));
      const parentObject = parent === null ? undefined : index.objects.get(parent.num);
      // Inherited attributes are read through /Parent: keep a parent that can still be read, and point the rest at the new root.
      if (parentObject === undefined || !parentObject.closed || !dictEntries(parentObject.body).has("Kids")) {
        bodies.set(num, setEntry(page.body, "Parent", `${root} 0 R`));
      }
    }
    steps.push("page-tree-rebuilt");
  }

  let fontsRepaired = false;
  for (const object of index.objects.values()) {
    if (object.stream !== null) continue;
    const original = bodies.get(object.num) ?? object.body;
    // Damaged key names first: a font whose /Type lost its last character is still a font.
    let body = original.includes("<<") ? repairFontKeys(original) : original;
    const entries = dictEntries(body);
    if (parseName(entries.get("Type")) !== "Font") {
      if (body !== original) {
        bodies.set(object.num, body);
        fontsRepaired = true;
      }
      continue;
    }
    if (!FONT_SUBTYPES.has(parseName(entries.get("Subtype")) ?? "")) {
      // PDFBox reads a font with no valid /Subtype as Type 1; pdf.js refuses it ("invalid font Subtype").
      body = setEntry(body, "Subtype", entries.has("DescendantFonts") ? "/Type0" : "/Type1");
    }
    const encoding = parseName(entries.get("Encoding"));
    if (entries.has("DescendantFonts") && encoding !== null && /^Identity(?!-[HV]$)/.test(encoding)) {
      // A damaged Identity CMap name ("Identity-"): pdf.js cannot load it and drops the font's text.
      body = setEntry(body, "Encoding", "/Identity-H");
    }
    if (body === original) continue;
    bodies.set(object.num, body);
    fontsRepaired = true;
  }
  if (fontsRepaired) steps.push("font-repaired");

  const version = /^%PDF-(\d\.\d)/.exec(text.slice(index.headerAt))?.[1] ?? "1.7";
  const chunks: string[] = [`%PDF-${version}\n%âãÏÓ\n`];
  let offset = chunks[0]!.length;
  const offsets = new Map<number, { offset: number; gen: number }>();
  const salvageBudget = { left: MAX_SALVAGED_BYTES };
  let streamsSalvaged = false;
  const write = (num: number, gen: number, object: string): void => {
    offsets.set(num, { offset, gen });
    chunks.push(object);
    offset += object.length;
  };
  for (const object of [...index.objects.values()].sort((a, b) => a.num - b.num)) {
    if (object.stream !== null && /\/Type\s*\/XRef\b/.test(object.body)) continue;
    const body = (bodies.get(object.num) ?? object.body).trim();
    if (object.stream === null) {
      // A cut-off object gets its open dictionaries and arrays closed, so a page cut after its /Contents still reads.
      write(object.num, object.gen, `${object.num} ${object.gen} obj\n${object.closed ? body : closeOpenValues(body)}\nendobj\n`);
      continue;
    }
    let dictionary = body;
    let data = text.slice(object.stream.start, object.stream.end);
    if (!object.stream.complete) {
      const salvaged = salvageFlate(dictionary, data, salvageBudget);
      if (salvaged !== null) {
        dictionary = removeEntry(removeEntry(dictionary, "Filter"), "DecodeParms");
        data = salvaged;
        streamsSalvaged = true;
      }
    }
    dictionary = setEntry(dictionary, "Length", String(data.length));
    write(object.num, object.gen, `${object.num} ${object.gen} obj\n${dictionary}\nstream\n${data}\nendstream\nendobj\n`);
  }
  for (const [num, body] of bodies) {
    if (!index.objects.has(num)) write(num, 0, `${num} 0 obj\n${body}\nendobj\n`);
  }

  // One subsection per run of consecutive object numbers (the free head, entry 0, starts the first): a table with a line
  // for every number up to the largest cost 20 bytes each, 168 MB for a 434-byte file that defines object 8388607.
  // Numbers no object has stay out of the table, which a reader takes as free.
  const xref = ["xref\n"];
  const numbers = [0, ...[...offsets.keys()].sort((a, b) => a - b)];
  for (let first = 0; first < numbers.length; ) {
    let last = first;
    while (last + 1 < numbers.length && numbers[last + 1] === numbers[last]! + 1) last++;
    xref.push(`${numbers[first]!} ${last - first + 1}\n`);
    for (let at = first; at <= last; at++) {
      const num = numbers[at]!;
      const entry = offsets.get(num);
      xref.push(entry === undefined ? "0000000000 65535 f \n" : `${String(entry.offset).padStart(10, "0")} ${String(entry.gen).padStart(5, "0")} n \n`);
    }
    first = last + 1;
  }
  if (streamsSalvaged) steps.push("stream-salvaged");
  const info = findInfo(index);
  chunks.push(
    xref.join(""),
    `trailer\n<< /Size ${size} /Root ${catalog.num} ${catalog.gen} R${info === null ? "" : ` /Info ${info.num} ${info.gen} R`} >>\n`,
    `startxref\n${offset}\n%%EOF\n`,
  );
  return { data: new Uint8Array(Buffer.from(chunks.join(""), "latin1")), steps };
}

export interface PdfDiagnosis {
  /** What is wrong with the file, in words, for a failure message (`missing %%EOF`, `no page tree`, ...). */
  readonly causes: readonly string[];
  /** Objects the xref marks free although the file defines them and live objects refer to them. */
  readonly freedReferenced: readonly number[];
  /** No startxref, or one that points nowhere: pdf.js has to rebuild the xref by scanning. */
  readonly xrefUnusable: boolean;
}

/**
 * Names the damage in a PDF. Without an index it only reads the file's tail and xref (cheap enough for every file); an
 * index adds what the objects show (cut-off objects, bad object streams, the page tree). A free-marked object is checked
 * against the objects only when the xref has one.
 */
export function diagnosePdf(text: string, given?: ObjectIndex): PdfDiagnosis {
  const causes: string[] = [];
  let index = given;
  const headerAt = text.slice(0, 1024).indexOf("%PDF-");
  if (headerAt === -1) causes.push("no %PDF header");
  else if (headerAt > 0) causes.push(`%PDF header at offset ${headerAt}`);
  const base = Math.max(0, headerAt);

  const eof = text.lastIndexOf("%%EOF");
  if (eof === -1) causes.push("missing %%EOF");
  else if (/(?<![0-9])\d{1,7}\s+\d{1,5}\s+obj\b/.test(text.slice(eof))) causes.push("missing %%EOF after the last update");

  let xrefUnusable = false;
  const freed = new Set<number>();
  let wrongOffsets = 0;
  const keyword = text.lastIndexOf("startxref");
  const last = keyword === -1 ? null : /^startxref\s+(\d+)/.exec(text.slice(keyword, keyword + 64));
  if (last === null) {
    causes.push("no startxref");
    xrefUnusable = true;
  } else {
    const offset = Number(last[1]);
    const at = xrefAt(text, offset, base);
    if (offset >= text.length) {
      causes.push(`startxref offset ${offset} out of range (file is ${text.length} bytes)`);
      xrefUnusable = true;
    } else if (at === -1) {
      causes.push(`startxref offset ${offset} points at no xref`);
      xrefUnusable = true;
    } else if (text.startsWith("xref", at)) {
      const table = readXrefTables(text, at, base);
      for (const num of table.free) freed.add(num);
      wrongOffsets = table.wrongOffsets;
    }
  }
  if (wrongOffsets > 0) causes.push(`xref offsets wrong for ${wrongOffsets} object${wrongOffsets === 1 ? "" : "s"}`);

  let freedReferenced: number[] = [];
  if (freed.size > 0) {
    index ??= indexObjects(text);
    const referenced = referencedObjects(index, freed);
    freedReferenced = [...freed].filter((num) => index!.objects.has(num) && referenced.has(num)).sort((a, b) => a - b);
    if (freedReferenced.length > 0) {
      causes.push(`xref marks referenced objects free (${freedReferenced.slice(0, 8).join(", ")}${freedReferenced.length > 8 ? ", ..." : ""})`);
    }
  }

  if (index !== undefined) {
    for (const num of index.badObjectStreams.slice(0, 4)) causes.push(`bad object stream (object ${num})`);
    const cut = [...index.objects.values()].filter((object) => object.container === undefined && (!object.closed || object.stream?.complete === false));
    if (cut.length > 0) causes.push(`${cut.length} object${cut.length === 1 ? "" : "s"} cut off`);
    const catalog = findCatalog(index);
    if (catalog === null) causes.push("no catalog");
    else {
      const tree = pageTree(index, catalog);
      if (tree.broken !== null) causes.push(tree.broken);
    }
  }
  return { causes, freedReferenced, xrefUnusable };
}

/**
 * The object numbers a reader would ask for: the catalog, and what the objects reachable from it refer to. An object the
 * xref marks free is not followed (a page an incremental update deleted still names its annotation, and the annotation the
 * page), so freed objects that only refer to each other are not "referenced". Without a catalog, every object that is not
 * free counts as reachable.
 */
function referencedObjects(index: ObjectIndex, freed: ReadonlySet<number>): Set<number> {
  const referenced = new Set<number>();
  const catalog = findCatalog(index);
  const pending: number[] = catalog === null ? [...index.objects.keys()] : [catalog.num];
  if (catalog !== null) referenced.add(catalog.num);
  const visited = new Set<number>();
  for (let num = pending.pop(); num !== undefined; num = pending.pop()) {
    if (visited.has(num) || freed.has(num)) continue;
    visited.add(num);
    const object = index.objects.get(num);
    if (object === undefined) continue;
    for (const ref of referencesIn(object.body)) {
      if (ref.num === num) continue;
      referenced.add(ref.num);
      pending.push(ref.num);
    }
  }
  return referenced;
}

/** Where the xref that `startxref` names starts (an `xref` table or an xref stream object), or -1. */
function xrefAt(text: string, offset: number, base: number): number {
  for (const candidate of base > 0 ? [offset + base, offset] : [offset]) {
    if (candidate >= text.length) continue;
    const head = text.slice(candidate, candidate + 64);
    const lead = /^\s*/.exec(head)![0].length;
    if (head.startsWith("xref", lead) || /^\d{1,7}\s+\d{1,5}\s+obj\b/.test(head.slice(lead))) return candidate + lead;
  }
  return -1;
}

/**
 * The classic xref tables from `at` back through /Prev: object numbers left free, and offsets that point elsewhere. A
 * hybrid file (/XRefStm) lists its compressed objects as free in the table, so its free entries are not reported.
 */
function readXrefTables(text: string, at: number, base: number): { free: number[]; wrongOffsets: number } {
  const seen = new Set<number>();
  const decided = new Set<number>();
  const free: number[] = [];
  const objectHeader = /^\s*(\d+)\s+\d+\s+obj\b/;
  let hybrid = false;
  let wrongOffsets = 0;
  for (let section = 0; section < 16 && at !== -1 && !seen.has(at) && text.startsWith("xref", at); section++) {
    seen.add(at);
    const trailer = text.indexOf("trailer", at);
    // A table is read up to 2 MB (100,000 entries) whether or not a trailer follows it.
    const table = text.slice(at + 4, Math.min(trailer === -1 ? text.length : trailer, at + 4 + 20 * 100_000));
    // Numbers are at most ten digits (an offset) and not the tail of a longer run: a run of digits is one candidate,
    // not one per starting digit, which backtracked through the rest of the run each time.
    const tokens = /(?<![0-9])(\d{1,10})\s+(\d{1,10})(?:\s+([nf]))?/g;
    let num = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(table)) !== null) {
      if (match[3] === undefined) {
        num = Number(match[1]);
        continue;
      }
      const current = num++;
      if (decided.has(current)) continue;
      decided.add(current);
      if (match[3] === "f") {
        if (current !== 0) free.push(current);
        continue;
      }
      const offset = Number(match[1]) + base;
      if (Number(objectHeader.exec(text.slice(offset, offset + 32))?.[1]) !== current) wrongOffsets++;
    }
    if (trailer === -1) break;
    const entries = dictEntries(text, trailer, Math.min(text.length, trailer + 4096));
    if (entries.has("XRefStm")) hybrid = true;
    const prev = Number(entries.get("Prev"));
    at = Number.isInteger(prev) ? xrefAt(text, prev, base) : -1;
  }
  return { free: hybrid ? [] : free, wrongOffsets };
}

function byPosition(index: ObjectIndex): PdfObject[] {
  return [...index.objects.values()].sort((a, b) => a.at - b.at);
}

function isPage(entries: ReadonlyMap<string, string>): boolean {
  return parseName(entries.get("Type")) === "Page";
}

/** The catalog: the one a trailer names when it is there, else the last `/Type /Catalog` object in the file. */
function findCatalog(index: ObjectIndex): Reference | null {
  const text = index.text;
  const named: Reference[] = [];
  for (const match of text.matchAll(/trailer\s*<</g)) {
    const root = parseReference(dictEntries(text, match.index, Math.min(text.length, match.index + 4096)).get("Root"));
    if (root !== null) named.push(root);
  }
  for (const object of index.objects.values()) {
    if (object.stream !== null && /\/Type\s*\/XRef\b/.test(object.body)) {
      const root = parseReference(dictEntries(object.body).get("Root"));
      if (root !== null) named.push(root);
    }
  }
  for (const ref of named.reverse()) {
    const object = index.objects.get(ref.num);
    if (object !== undefined && parseName(dictEntries(object.body).get("Type")) === "Catalog") return { num: ref.num, gen: object.gen };
  }
  let found: PdfObject | null = null;
  for (const object of byPosition(index)) {
    if (object.stream === null && parseName(dictEntries(object.body).get("Type")) === "Catalog") found = object;
  }
  return found === null ? null : { num: found.num, gen: found.gen };
}

/** The Info dictionary: the one a trailer names, else the last untyped dictionary with a producer, creator or date. */
function findInfo(index: ObjectIndex): Reference | null {
  const text = index.text;
  let named: Reference | null = null;
  for (const match of text.matchAll(/trailer\s*<</g)) {
    const info = parseReference(dictEntries(text, match.index, Math.min(text.length, match.index + 4096)).get("Info"));
    if (info !== null && index.objects.has(info.num)) named = { num: info.num, gen: index.objects.get(info.num)!.gen };
  }
  if (named !== null) return named;
  let found: PdfObject | null = null;
  for (const object of byPosition(index)) {
    if (object.stream !== null || !object.closed) continue;
    const entries = dictEntries(object.body);
    if (entries.has("Type")) continue;
    if (["Producer", "Creator", "CreationDate", "ModDate"].some((key) => entries.has(key))) found = object;
  }
  return found === null ? null : { num: found.num, gen: found.gen };
}

interface PageTree {
  /** The page tree root the catalog names, or null when it names none. */
  readonly root: number | null;
  /** The page objects reachable from the root, in order. */
  readonly pages: readonly number[];
  /** What is wrong with the tree, or null when every node and page it names is there. */
  readonly broken: string | null;
}

function pageTree(index: ObjectIndex, catalog: Reference): PageTree {
  const rootRef = parseReference(dictEntries(index.objects.get(catalog.num)!.body).get("Pages"));
  if (rootRef === null) return { root: null, pages: [], broken: "no page tree" };
  const pages: number[] = [];
  let broken: string | null = null;
  const note = (problem: string): void => {
    broken ??= problem;
  };
  const visited = new Set<number>();
  const stack: Array<{ num: number; depth: number }> = [{ num: rootRef.num, depth: 0 }];
  while (stack.length > 0 && pages.length < MAX_PAGES) {
    const { num, depth } = stack.pop()!;
    if (visited.has(num)) {
      note(`page tree object ${num} is reached twice`);
      continue;
    }
    visited.add(num);
    const node = index.objects.get(num);
    if (node === undefined) {
      note(num === rootRef.num ? `no page tree (object ${num} is missing)` : `page tree object ${num} is missing`);
      continue;
    }
    if (!node.closed) note(`page tree object ${num} is cut off`);
    const entries = dictEntries(node.body);
    const kids = entries.get("Kids");
    if (kids !== undefined && !isPage(entries)) {
      if (depth >= 64) {
        note("page tree is too deep");
        continue;
      }
      const refs = referencesIn(kids);
      for (let i = refs.length - 1; i >= 0; i--) stack.push({ num: refs[i]!.num, depth: depth + 1 });
      continue;
    }
    if (isPage(entries) || entries.has("Contents") || entries.has("MediaBox")) pages.push(num);
    else note(num === rootRef.num ? `no page tree (object ${num} is not one)` : `page tree object ${num} is not a page`);
  }
  if (broken === null && pages.length === 0) note("page tree has no pages");
  return { root: rootRef.num, pages, broken };
}

/** The dictionary text with `/key value` set: the existing entry's value replaced, or the entry added after `<<`. */
function setEntry(dictionary: string, key: string, value: string): string {
  const entry = new RegExp(`/${key}(?![^\\s()<>\\[\\]{}/%])\\s*(?:\\d+\\s+\\d+\\s+R|/[^\\s()<>\\[\\]{}/%]*|\\d+)?`);
  const open = dictionary.indexOf("<<");
  const match = entry.exec(dictionary);
  if (match !== null && match.index > open) {
    return `${dictionary.slice(0, match.index)}/${key} ${value}${dictionary.slice(match.index + match[0].length)}`;
  }
  if (open === -1) return `<< /${key} ${value} >>`;
  return `${dictionary.slice(0, open + 2)} /${key} ${value}${dictionary.slice(open + 2)}`;
}

function removeEntry(dictionary: string, key: string): string {
  return dictionary.replace(new RegExp(`/${key}(?![^\\s()<>\\[\\]{}/%])\\s*(?:/[^\\s()<>\\[\\]{}/%]*|\\[[^\\]]*\\]|<<[^>]*>>|null)`), "");
}

/** The text of a value that is cut off, with its open dictionaries and arrays closed; a string cut part way is dropped. */
function closeOpenValues(body: string): string {
  const open: string[] = [];
  let complete = 0;
  for (let at = 0; at < body.length; at++) {
    const char = body[at]!;
    if (char === "(") {
      let depth = 0;
      let end = -1;
      for (let i = at; i < body.length; i++) {
        if (body[i] === "\\") i++;
        else if (body[i] === "(") depth++;
        else if (body[i] === ")" && --depth === 0) {
          end = i;
          break;
        }
      }
      if (end === -1) break;
      at = end;
    } else if (char === "<" && body[at + 1] === "<") {
      if (open.length >= 64) break;
      open.push(">>");
      at++;
    } else if (char === ">" && body[at + 1] === ">") {
      open.pop();
      at++;
    } else if (char === "<") {
      const end = body.indexOf(">", at);
      if (end === -1) break;
      at = end;
    } else if (char === "[") {
      if (open.length >= 64) break;
      open.push("]");
    } else if (char === "]") open.pop();
    else if (char === "%") {
      // A comment is not a value; one that runs to the cut would swallow the closers.
      while (at < body.length && body[at] !== "\n" && body[at] !== "\r") at++;
      if (at >= body.length) break;
      continue;
    }
    if (!/\s/.test(char)) complete = at + 1;
  }
  if (open.length === 0) return body;
  return `${body.slice(0, complete)} ${open.reverse().join(" ")}`;
}

/** The readable start of a cut-off stream with one Flate filter, inflated; null otherwise. */
function salvageFlate(dictionary: string, data: string, budget: { left: number }): string | null {
  const entries = dictEntries(dictionary);
  const filter = entries.get("Filter")?.replace(/[[\]\s]/g, "");
  if (filter !== "/FlateDecode" || entries.has("DecodeParms") || budget.left <= 0) return null;
  try {
    const inflated = inflateSync(Buffer.from(data, "latin1"), { maxOutputLength: budget.left, finishFlush: 2 }).toString("latin1");
    budget.left -= inflated.length;
    return inflated;
  } catch {
    return null;
  }
}
