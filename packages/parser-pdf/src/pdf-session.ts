import { blockPdfjsCanvas } from "./block-canvas.ts";
import { importWithoutPdfjsWarnings } from "./pdfjs-import.ts";
import { createRequire } from "node:module";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PageContentScanner, type PageContent } from "./pdf-content.ts";
import { ownerPasswordMatches, streamDecryptor } from "./pdf-decrypt.ts";
import { eofOffsets } from "./pdf-eof.ts";
import { lines, type PdfTextItem } from "./pdf-lines.ts";
import { indexObjects, type ObjectIndex } from "./pdf-objects.ts";
import { preflightPdf, preflightPdfChunks } from "./pdf-preflight.ts";
import { structTreeHasKids } from "./pdf-struct.ts";
import { diagnosePdf, latin1, rebuildPdf, type RebuiltPdf, type RepairStep } from "./pdf-rebuild.ts";
import { isMissingCatalogError, recoverDocumentDetailed } from "./pdf-recover.ts";

// Before pdf.js is imported anywhere: it polyfills rendering objects by loading the native canvas at import time.
blockPdfjsCanvas();

/**
 * One pdf.js document load plus the page requests made against it. It owns no
 * thread or port: the in-thread channel (pdf-channel.ts) drives it with a
 * request/response protocol.
 */

/** What the parser hands to the session. */
export interface PdfSessionInput {
  readonly data?: Uint8Array;
  readonly path?: string;
  readonly sortByPosition?: boolean;
  readonly password?: string | undefined;
  readonly maxPageTextChars?: number;
  readonly maxAttachments?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxTotalAttachmentBytes?: number;
  /** Read the /PageLabels (only when segments were asked for: the labels are not part of the text). */
  readonly pageLabels?: boolean;
}

export interface PdfAttachment {
  readonly name: string;
  readonly filename: string;
  readonly data: Uint8Array;
}

export interface PdfAnnotation {
  readonly name?: string | undefined;
  readonly subtype?: string | undefined;
  readonly title?: string | undefined;
  readonly subject?: string | undefined;
  readonly contents?: string | undefined;
  readonly url?: string | undefined;
  readonly fieldName?: string | undefined;
  readonly fieldValue?: unknown;
  readonly fieldType?: string | undefined;
  /** The annotation's `/IT` intent name, e.g. `FreeTextTypewriter`. */
  readonly it?: string | undefined;
}

export type PdfRequest =
  | { readonly type: "page"; readonly index: number }
  | { readonly type: "close" };

export type PdfResponse =
  | {
      readonly type: "ready";
      readonly info: unknown;
      /** The raw XMP packet, or "" when there is none (or pdf.js could not read it). */
      readonly xmp: string;
      readonly numPages: number;
      readonly attachments: readonly PdfAttachment[];
      /** Outline (bookmark) titles in document order; Tika writes them as text. */
      readonly outline: readonly string[];
      /** Set when the document only loaded after a recovery: what was done, and what was wrong with the file. */
      readonly repair?: PdfRepair;
      /** The /P permission flags the document grants (pdf.js's PermissionFlag values), or null when it is not encrypted. */
      readonly permissions: readonly number[] | null;
      /** The password given opens the file as its owner: every permission, whatever /P says (as in PDFBox). */
      readonly ownerAccess: boolean;
      /** The catalog has a /StructTreeRoot (what Tika reports as pdf:has-marked-content). */
      readonly hasMarkedContent: boolean;
      /** The page labels, one per page (null where a page has none), when they were asked for and the document has them. */
      readonly pageLabels?: readonly (string | null)[];
      /** Where each revision of the file ends (pdf-eof.ts); undefined when the file was too large to scan. */
      readonly eofOffsets?: readonly number[];
    }
  | {
      readonly type: "page";
      readonly index: number;
      readonly lines: string[];
      readonly annotations: readonly PdfAnnotation[];
      /** For a page with no text: what its content streams do, when the file could be scanned. */
      readonly content?: PageContent;
      /** Set on the page whose evidence made the session reopen the document from repaired bytes (tikajs-w4ps). */
      readonly repair?: PdfRepair;
    }
  | {
      readonly type: "page-error";
      readonly index: number;
      readonly name: string;
      readonly message: string;
    }
  | { readonly type: "closed" }
  | {
      readonly type: "error";
      readonly name: string;
      readonly message: string;
      readonly code?: string;
      /** What is wrong with a file no recovery could load. */
      readonly causes?: readonly string[];
    };

/** Repairs only the rebuild makes: a file that needs one is opened from the rebuild rather than by pdf.js's own reindex. */
const REBUILD_FIRST_STEPS: ReadonlySet<RepairStep> = new Set(["page-tree-rebuilt", "font-repaired", "stream-salvaged"]);

export interface PdfRepair {
  readonly steps: readonly RepairStep[];
  readonly causes: readonly string[];
}

interface PdfjsAnnotation {
  readonly id?: unknown;
  readonly subtype?: string;
  readonly title?: string;
  readonly titleObj?: { readonly str?: string };
  readonly subject?: string;
  readonly contents?: string;
  readonly contentsObj?: { readonly str?: string };
  readonly url?: string;
  readonly fieldName?: string;
  readonly fieldValue?: unknown;
  readonly fieldType?: string;
  readonly it?: string;
}

interface PdfPage {
  /** The page object's reference. */
  readonly ref?: { readonly num: number; readonly gen: number } | null;
  /** The structure tree for the page, or null when the catalog has no /StructTreeRoot. */
  getStructTree?(): Promise<unknown>;
  streamTextContent(): ReadableStream<{ items: unknown[] }>;
  getAnnotations?(options?: { intent?: string }): Promise<PdfjsAnnotation[]>;
  cleanup(): void;
}

interface PdfMetadata {
  getRaw?(): string;
}

interface PdfDocument {
  readonly numPages: number;
  getMetadata(): Promise<{ info: unknown; metadata?: PdfMetadata }>;
  getPage(index: number): Promise<PdfPage>;
  getAttachments?(): Promise<Record<string, {
    readonly filename?: string;
    readonly content?: Uint8Array;
  }>>;
  getOutline?(): Promise<unknown>;
  getPermissions?(): Promise<number[] | null>;
  getPageLabels?(): Promise<readonly string[] | null>;
  /** Drops what pdf.js keeps per page and per object (the page objects, the object cache). Absent on a stand-in. */
  cleanup?(keepLoadedFonts?: boolean): Promise<void>;
}

export interface RangeTransport {
  readonly length: number;
  onDataRange(begin: number, chunk: Uint8Array): void;
}

export interface RangeTransportConstructor {
  new (length: number, initialData: Uint8Array): RangeTransport;
}

interface LoadingTask {
  readonly promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

interface PdfModule {
  PDFDataRangeTransport: RangeTransportConstructor;
  getDocument(options: Record<string, unknown>): LoadingTask;
}

const PDF_DATA_LIMIT = 8 * 1024 * 1024;

/** Largest file read whole to scan the content of a page with no text (image-only pages); a larger one is not scanned. */
const CONTENT_SCAN_LIMIT = 64 * 1024 * 1024;

/** pdf.js's range size for a file read through the range transport (its default is 65,536). */
const RANGE_CHUNK_BYTES = 1024 * 1024;

/**
 * pdf.js keeps parsed state for every page it has served until the document is destroyed: measured on a 5,000-page,
 * 50 MB text PDF, the heap grew by about 130 KiB per page (13 bytes per extracted character, 680 MiB live at the end)
 * even though the text itself was dropped, so a long PDF ran a child out of its heap long before its output cap
 * (tikajs-m5ng). `document.cleanup()` drops it; every this many pages keeps the live heap near 30 MiB at a cost of
 * re-reading shared objects (fonts) once per interval.
 */
const DOCUMENT_CLEANUP_INTERVAL_PAGES = 100;

interface PdfOutlineItem {
  readonly title?: unknown;
  readonly items?: readonly PdfOutlineItem[];
}

/** A page label is a few characters ("iv", "A-3"); a longer one is cut, as it ends up in a segment's labels. */
const MAX_PAGE_LABEL = 64;

/** The document's page labels (pdf.js builds them from /PageLabels), or undefined when it has none or they cannot be read. */
async function readPageLabels(document: PdfDocument): Promise<(string | null)[] | undefined> {
  try {
    const labels = await document.getPageLabels?.();
    if (labels === null || labels === undefined) return undefined;
    return labels.map((label) => (typeof label === "string" && label.length > 0 ? label.slice(0, MAX_PAGE_LABEL) : null));
  } catch {
    return undefined;
  }
}

/** Flattened outline titles, parents before their children, as Tika writes bookmarks as text. */
function outlineTitles(outline: unknown): string[] {
  const titles: string[] = [];
  const visit = (items: readonly PdfOutlineItem[] | undefined): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item.title === "string" && item.title.length > 0) titles.push(item.title);
      visit(item.items);
    }
  };
  visit(outline as readonly PdfOutlineItem[] | undefined);
  return titles;
}

export class PdfSession {
  readonly #input: PdfSessionInput;
  #loading: LoadingTask | undefined;
  #document: PdfDocument | undefined;
  #disposal: Promise<void> | undefined;
  /** The file's bytes as given (not a recovered copy), when they were read into memory. */
  #bytes: Uint8Array | undefined;
  /** The object index of #bytes, when loading built one. */
  #index: ObjectIndex | undefined;
  #repair: PdfRepair | undefined;
  #eofOffsets: readonly number[] | undefined;
  #ownerAccess = false;
  /** Looks at the objects to say whether a structure tree root holds anything; set by #load when the file is in memory. */
  #structKids: (() => boolean | null) | undefined;
  #failureCauses: readonly string[] | undefined;
  #scanner: PageContentScanner | null | undefined;
  /**
   * Reopens the document from a rebuild that repaired its fonts, for a file pdf.js opened as it stood (intact xref) but
   * whose page shows text pdf.js did not extract. Set by #load when the file is in memory; used at most once.
   */
  #reopenRepaired: (() => Promise<PdfDocument | null>) | undefined;

  constructor(input: PdfSessionInput) {
    this.#input = input;
  }

  /** Loads the document; resolves to `ready` or `error`, never rejects. */
  async open(): Promise<PdfResponse> {
    let document: PdfDocument;
    try {
      document = await this.#load();
    } catch (error) {
      return {
        type: "error",
        ...describe(error),
        ...(this.#failureCauses === undefined || this.#failureCauses.length === 0 ? {} : { causes: this.#failureCauses }),
      };
    }

    try {
      const metadata = await document.getMetadata();
      let xmp = "";
      try {
        const raw = metadata.metadata?.getRaw?.();
        if (typeof raw === "string") xmp = raw;
      } catch {
        xmp = "";
      }
      let attachments: PdfAttachment[] = [];
      try {
        const values = (await document.getAttachments?.()) ?? {};
        attachments = Object.entries(values).map(([name, value]) => ({
          name,
          filename: value.filename ?? name,
          data: value.content ?? new Uint8Array(0),
        }));
      } catch {
        attachments = [];
      }
      // Check sizes here, before the response hands every attachment to the parser.
      this.#checkAttachments(attachments);
      let outline: string[] = [];
      try {
        outline = outlineTitles(await document.getOutline?.());
      } catch {
        outline = [];
      }
      let permissions: number[] | null = null;
      try {
        permissions = (await document.getPermissions?.()) ?? null;
      } catch {
        permissions = null;
      }
      this.#document = document;
      const pageLabels = this.#input.pageLabels === true ? await readPageLabels(document) : undefined;
      return {
        type: "ready",
        info: metadata.info,
        xmp,
        numPages: document.numPages,
        attachments,
        outline,
        permissions,
        ownerAccess: this.#ownerAccess,
        hasMarkedContent: await this.#hasStructTree(document),
        ...(pageLabels === undefined ? {} : { pageLabels }),
        ...(this.#eofOffsets === undefined ? {} : { eofOffsets: this.#eofOffsets }),
        ...(this.#repair === undefined ? {} : { repair: this.#repair }),
      };
    } catch (error) {
      return { type: "error", ...describe(error) };
    }
  }

  /** Whether the catalog has a structure tree: pdf.js answers null for a page when it has none. Best effort. */
  async #hasStructTree(document: PdfDocument): Promise<boolean> {
    if (document.numPages < 1) return false;
    try {
      const page = await document.getPage(1);
      if (((await page.getStructTree?.()) ?? null) === null) return false;
      // pdf.js says there is a root; Tika wants it to hold something, which the object index shows when it can.
      return this.#structKids?.() ?? true;
    } catch {
      return false;
    }
  }

  /** Answers one request made after `ready`; never rejects. */
  async handle(request: PdfRequest): Promise<PdfResponse> {
    if (request.type === "close") {
      await this.dispose();
      return { type: "closed" };
    }
    return this.#extractPage(request.index);
  }

  /**
   * Destroys the pdf.js loading task, which also tears down the document and
   * its fake worker. Safe to call repeatedly and while a request is in flight.
   */
  dispose(): Promise<void> {
    this.#disposal ??= this.#release();
    return this.#disposal;
  }

  async #release(): Promise<void> {
    const loading = this.#loading;
    this.#loading = undefined;
    this.#document = undefined;
    this.#bytes = undefined;
    this.#index = undefined;
    this.#scanner = null;
    this.#reopenRepaired = undefined;
    this.#structKids = undefined;
    try {
      await loading?.destroy();
    } catch {
      // Best effort: the task is unusable afterwards either way.
    }
  }

  async #load(): Promise<PdfDocument> {
    const input = this.#input;
    const pdfjs = (await importWithoutPdfjsWarnings(() => import("pdfjs-dist/legacy/build/pdf.mjs"))) as unknown as PdfModule;
    const options: Record<string, unknown> = {
      isEvalSupported: false,
      useWorkerFetch: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Errors only: pdf.js's warnings go to stdout through console.log, into the output of a command line tool.
      verbosity: 0,
      standardFontDataUrl: pdfjsDataUrl("standard_fonts"),
      // The predefined CMaps (UniGB-UCS2-H, GBK-EUC-H, Adobe-GB1-UCS2, ...): a CJK font with no ToUnicode map reads as nothing without them.
      cMapUrl: pdfjsDataUrl("cmaps"),
      cMapPacked: true,
      password: input.password ?? "",
    };
    if (input.path !== undefined) {
      const length = (await stat(input.path)).size;
      if (length <= PDF_DATA_LIMIT) {
        // Malformed files often have unusable xref offsets, and pdf.js's
        // range loader is stricter than its in-memory recovery path.
        options.data = new Uint8Array(await readFile(input.path));
      } else {
        // The checks that keep pdf.js from spinning or exhausting memory run on every file, not only the ones small
        // enough to read whole: padding a file past the limit must not get it past them.
        if (length <= CONTENT_SCAN_LIMIT) {
          const whole = new Uint8Array(await readFile(input.path));
          preflightPdf(whole);
          this.#eofOffsets = eofOffsets(whole);
        } else await preflightPdfChunks((start, end) => readRange(input.path!, length, start, end), length);
        options.range = createFileRangeTransport(
          pdfjs.PDFDataRangeTransport,
          input.path,
          length,
        );
        // Every range pdf.js lacks restarts its parse from the top, so the number of ranges is the number of restarts:
        // at the default 64 KiB an 8.6 MB file took 31 s (132 ranges), and a quadratic fraction of that is the cost.
        options.rangeChunkSize = RANGE_CHUNK_BYTES;
      }
    } else {
      options.data = input.data ?? new Uint8Array(0);
    }
    if (options.data instanceof Uint8Array) {
      preflightPdf(options.data);
      this.#eofOffsets = eofOffsets(options.data);
    }
    const source = options.data instanceof Uint8Array ? options.data : undefined;
    if (source === undefined) return this.#start(pdfjs, options);

    const text = latin1(source);
    if (text.includes("/Encrypt")) this.#ownerAccess = ownerPasswordMatches(text, input.password ?? "");
    const diagnosis = diagnosePdf(text);
    let sourceIndex: ObjectIndex | undefined;
    const indexed = (): ObjectIndex => (sourceIndex ??= indexObjects(text));
    let rebuilt: RebuiltPdf | null | undefined;
    this.#structKids = () => structTreeHasKids(indexed());
    const rebuild = (): RebuiltPdf | null => (rebuilt === undefined ? (rebuilt = rebuildPdf(source, indexed())) : rebuilt);
    const attempt = async (data: Uint8Array, steps: readonly RepairStep[] | undefined): Promise<PdfDocument> => {
      await this.#loading?.destroy();
      // pdf.js transfers (detaches) the buffer it is given, so keep ours for recovery and for scanning pages.
      options.data = data.slice();
      const document = await this.#start(pdfjs, options);
      if (steps !== undefined) this.#repair = { steps, causes: diagnosePdf(text, indexed()).causes };
      // Pages with no text are checked in the file as given, where a cut-off stream is still cut off (a rebuilt or
      // salvaged copy would read as whole); recovery keeps every page's object number.
      this.#bytes = source;
      this.#index = sourceIndex;
      return document;
    };

    // The evidence for a damaged font arrives with the pages (a page paints text, pdf.js extracts none): then the
    // document is reopened from the rebuild, once, for this document only.
    this.#reopenRepaired = async (): Promise<PdfDocument | null> => {
      const repaired = rebuild();
      if (repaired === null || !repaired.steps.includes("font-repaired")) return null;
      const previous = this.#loading;
      const pages = this.#document?.numPages;
      try {
        const next = await this.#start(pdfjs, { ...options, data: repaired.data.slice() });
        if (next.numPages !== pages) {
          await this.#loading?.destroy();
          this.#loading = previous;
          return null;
        }
        await previous?.destroy();
        this.#repair = { steps: repaired.steps, causes: diagnosePdf(text, indexed()).causes };
        return next;
      } catch {
        this.#loading = previous;
        return null;
      }
    };

    // pdf.js reads an object the xref marks free as missing, even when the file holds it and the page tree needs it;
    // PDFBox's lenient parser finds such objects by scanning, and the rebuild does the same. pdf.js also reads a broken
    // page tree as it stands (a damaged root is a page with no content), drops the text of a font whose /Subtype or
    // Identity CMap name is damaged, and fails a page whose content stream is cut off, all of which the rebuild repairs:
    // when the xref has to be rebuilt anyway, a rebuild that repaired more than the xref goes first.
    let rebuildTried = false;
    if (diagnosis.freedReferenced.length > 0 || diagnosis.xrefUnusable) {
      const first = rebuild();
      const repairs = first !== null && first.steps.some((step) => REBUILD_FIRST_STEPS.has(step));
      if (first !== null && (diagnosis.freedReferenced.length > 0 || repairs)) {
        rebuildTried = true;
        try {
          return await attempt(first.data, first.steps);
        } catch {
          // Fall back to the file as it is.
        }
      }
    }
    try {
      // With no usable startxref pdf.js indexes every object itself: a recovery all the same.
      return await attempt(source, diagnosis.xrefUnusable ? ["rebuilt-xref"] : undefined);
    } catch (error) {
      if (error instanceof Error && error.name === "PasswordException") throw error;
      const message = error instanceof Error ? error.message : "";
      // A file cut before its trailer can still hold every object. The append-a-trailer recovery goes first when pdf.js
      // found no catalog; the brute-force rebuild (new xref, trailer and, if need be, page tree) follows.
      const candidates: Array<() => { data: Uint8Array; steps: readonly RepairStep[] } | null> = [];
      if (isMissingCatalogError(message)) {
        candidates.push(() => {
          const recovered = recoverDocumentDetailed(source);
          if (recovered === null) return null;
          const steps: RepairStep[] = ["rebuilt-xref", "synthetic-trailer"];
          if (recovered.inlined) steps.push("objstm-inlined");
          return { data: recovered.data, steps };
        });
      }
      if (!rebuildTried) candidates.push(rebuild);
      let lastError: unknown = error;
      for (const make of candidates) {
        const candidate = make();
        if (candidate === null) continue;
        try {
          return await attempt(candidate.data, candidate.steps);
        } catch (retryError) {
          lastError = retryError;
        }
      }
      this.#failureCauses = diagnosePdf(text, indexed()).causes;
      throw lastError;
    }
  }

  /** Starts a loading task that dispose() will destroy. */
  #start(pdfjs: PdfModule, options: Record<string, unknown>): Promise<PdfDocument> {
    if (this.#disposal !== undefined) throw new Error("PDF session was disposed");
    const loading = pdfjs.getDocument(options);
    this.#loading = loading;
    return loading.promise;
  }

  /** Best effort: a failed cleanup costs memory, never the parse. */
  async #releaseDocumentCaches(document: PdfDocument, index: number): Promise<void> {
    if (index % DOCUMENT_CLEANUP_INTERVAL_PAGES !== 0) return;
    try {
      await document.cleanup?.(true);
    } catch {
      // The next interval tries again.
    }
  }

  async #extractPage(index: number): Promise<PdfResponse> {
    let document = this.#document;
    if (document === undefined) {
      return { type: "page-error", index, name: "Error", message: "PDF document is not open" };
    }
    let page: PdfPage | undefined;
    try {
      page = await document.getPage(index);
      let items = await this.#readTextItems(page);
      let pageLines = lines(items as PdfTextItem[], this.#input.sortByPosition ?? false);
      let content = pageLines.some((line) => line.trim().length > 0) ? undefined : await this.#pageContent(page);
      let repair: PdfRepair | undefined;
      if (content?.showsText === true && this.#repair === undefined && this.#reopenRepaired !== undefined) {
        const reopen = this.#reopenRepaired;
        this.#reopenRepaired = undefined;
        const reopened = await reopen();
        if (reopened !== null) {
          page.cleanup();
          document = reopened;
          this.#document = reopened;
          repair = this.#repair;
          page = await document.getPage(index);
          items = await this.#readTextItems(page);
          pageLines = lines(items as PdfTextItem[], this.#input.sortByPosition ?? false);
          content = pageLines.some((line) => line.trim().length > 0) ? undefined : await this.#pageContent(page);
        }
      }
      let annotations: PdfAnnotation[] = [];
      try {
        const values = (await page.getAnnotations?.({ intent: "display" })) ?? [];
        annotations = values.map((annotation) => ({
          // pdf.js has no /NM (the annotation's name) and its `id` is the object reference ("7R"), which is not a name.
          name: undefined,
          subtype: annotation.subtype,
          title: annotation.titleObj?.str ?? annotation.title,
          subject: annotation.subject,
          contents: annotation.contentsObj?.str ?? annotation.contents,
          url: annotation.url,
          fieldName: annotation.fieldName,
          fieldValue: annotation.fieldValue,
          fieldType: annotation.fieldType,
          it: typeof annotation.it === "string" ? annotation.it : undefined,
        }));
      } catch {
        annotations = [];
      }
      return {
        type: "page",
        index,
        lines: pageLines,
        annotations,
        ...(content === undefined ? {} : { content }),
        ...(repair === undefined ? {} : { repair }),
      };
    } catch (error) {
      return { type: "page-error", index, ...describe(error) };
    } finally {
      page?.cleanup();
      await this.#releaseDocumentCaches(document, index);
    }
  }

  /** What a page with no text paints, read from the file's objects; undefined when the file cannot be scanned. */
  async #pageContent(page: PdfPage): Promise<PageContent | undefined> {
    const ref = page.ref;
    if (ref === undefined || ref === null) return undefined;
    try {
      return (await this.#contentScanner())?.page(ref.num) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async #contentScanner(): Promise<PageContentScanner | null> {
    if (this.#scanner !== undefined) return this.#scanner;
    let bytes = this.#bytes;
    const path = this.#input.path;
    if (bytes === undefined && path !== undefined && (await stat(path)).size <= CONTENT_SCAN_LIMIT) {
      bytes = new Uint8Array(await readFile(path));
    }
    if (bytes === undefined) return (this.#scanner = null);
    const index = this.#index ?? indexObjects(latin1(bytes));
    const decrypt = /\/Encrypt\b/.test(index.text) ? streamDecryptor(index.text, this.#input.password ?? "") : null;
    this.#scanner = new PageContentScanner(index, decrypt);
    return this.#scanner;
  }

  /**
   * pdf.js can emit text without bound (for example mutually recursive form
   * XObjects), so stream the page and stop once the character cap is hit.
   */
  async #readTextItems(page: PdfPage): Promise<unknown[]> {
    const maxChars = this.#input.maxPageTextChars ?? Number.MAX_SAFE_INTEGER;
    const reader = page.streamTextContent().getReader();
    const items: unknown[] = [];
    let chars = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return items;
      for (const item of value.items) {
        chars += (item as { str?: string }).str?.length ?? 0;
        items.push(item);
      }
      if (chars > maxChars) {
        // No reader.cancel(): pdf.js throws from the cancelled stream. The
        // caller stops the session on this error, which destroys the document.
        throw new LimitError(`Page text exceeds ${maxChars} characters`);
      }
    }
  }

  #checkAttachments(attachments: readonly PdfAttachment[]): void {
    const maxCount = this.#input.maxAttachments ?? Number.MAX_SAFE_INTEGER;
    const maxBytes = this.#input.maxAttachmentBytes ?? Number.MAX_SAFE_INTEGER;
    const maxTotal = this.#input.maxTotalAttachmentBytes ?? Number.MAX_SAFE_INTEGER;
    if (attachments.length > maxCount) {
      throw new LimitError(`PDF has ${attachments.length} attachments, limit ${maxCount}`);
    }
    let total = 0;
    for (const attachment of attachments) {
      total += attachment.data.byteLength;
      if (attachment.data.byteLength > maxBytes) {
        throw new LimitError(
          `Attachment ${attachment.filename} is ${attachment.data.byteLength} bytes, limit ${maxBytes}`,
        );
      }
      if (total > maxTotal) {
        throw new LimitError(`PDF attachments exceed ${maxTotal} bytes in total`);
      }
    }
  }
}

class LimitError extends Error {
  override readonly name = "LimitExceededError";
}

/** The range transport pdf.js reads a file larger than PDF_DATA_LIMIT through. Exported for its tests. */
export function createFileRangeTransport(
  Base: RangeTransportConstructor,
  path: string,
  length: number,
): RangeTransport {
  const transport = new Base(length, new Uint8Array(0));
  const deliver = transport.onDataRange.bind(transport);
  // pdf.js calls abort() when it tears the document down. A read still in flight then has nowhere to deliver to:
  // pdf.js has dropped its range reader, and delivering throws, which in a detached promise is an unhandled rejection
  // that ends the process.
  let closed = false;
  const abort = (transport as unknown as { abort?: () => void }).abort?.bind(transport);
  (transport as unknown as { abort: () => void }).abort = (): void => {
    closed = true;
    abort?.();
  };
  (transport as unknown as {
    requestDataRange: (start: number, end: number) => void;
  }).requestDataRange = (start: number, end: number): void => {
    if (closed) return;
    void readRange(path, length, start, end).then(
      (chunk) => {
        if (closed) return;
        try {
          deliver(start, chunk);
        } catch {
          // The transport was torn down between the read and the delivery.
        }
      },
      () => {
        // The file is gone or unreadable. pdf.js has no way to be told, so the page timeout ends the wait.
      },
    );
  };
  return transport;
}

async function readRange(path: string, length: number, start: number, end: number): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const size = Math.max(0, Math.min(end - start, length - start));
    const chunk = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(chunk, offset, size - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return chunk.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** A data directory of the pdfjs-dist package (its standard fonts, its CMaps), as the URL form pdf.js takes. */
function pdfjsDataUrl(directory: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("pdfjs-dist/package.json");
    return `${join(dirname(packageJson), directory)}/`;
  } catch {
    return undefined;
  }
}

function describe(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}
