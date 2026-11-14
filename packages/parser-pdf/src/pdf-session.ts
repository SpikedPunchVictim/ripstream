import { createRequire } from "node:module";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lines, type PdfTextItem } from "./pdf-lines.ts";
import { preflightPdf } from "./pdf-preflight.ts";
import { isMissingCatalogError, recoverDocument } from "./pdf-recover.ts";

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
      readonly xmp: Record<string, unknown>;
      readonly numPages: number;
      readonly attachments: readonly PdfAttachment[];
      /** Outline (bookmark) titles in document order; Tika writes them as text. */
      readonly outline: readonly string[];
    }
  | {
      readonly type: "page";
      readonly index: number;
      readonly lines: string[];
      readonly annotations: readonly PdfAnnotation[];
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
    };

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
  streamTextContent(): ReadableStream<{ items: unknown[] }>;
  getAnnotations?(options?: { intent?: string }): Promise<PdfjsAnnotation[]>;
  cleanup(): void;
}

interface PdfMetadata {
  getAll?(): Record<string, unknown>;
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
}

interface RangeTransport {
  readonly length: number;
  onDataRange(begin: number, chunk: Uint8Array): void;
}

interface RangeTransportConstructor {
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

interface PdfOutlineItem {
  readonly title?: unknown;
  readonly items?: readonly PdfOutlineItem[];
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

  constructor(input: PdfSessionInput) {
    this.#input = input;
  }

  /** Loads the document; resolves to `ready` or `error`, never rejects. */
  async open(): Promise<PdfResponse> {
    let document: PdfDocument;
    try {
      document = await this.#load();
    } catch (error) {
      return { type: "error", ...describe(error) };
    }

    try {
      const metadata = await document.getMetadata();
      let xmp: Record<string, unknown> = {};
      try {
        xmp = metadata.metadata?.getAll?.() ?? {};
      } catch {
        xmp = {};
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
      this.#document = document;
      return {
        type: "ready",
        info: metadata.info,
        xmp,
        numPages: document.numPages,
        attachments,
        outline,
      };
    } catch (error) {
      return { type: "error", ...describe(error) };
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
    try {
      await loading?.destroy();
    } catch {
      // Best effort: the task is unusable afterwards either way.
    }
  }

  async #load(): Promise<PdfDocument> {
    const input = this.#input;
    const pdfjs = (await import(
      "pdfjs-dist/legacy/build/pdf.mjs"
    )) as unknown as PdfModule;
    const options: Record<string, unknown> = {
      isEvalSupported: false,
      useWorkerFetch: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: standardFontsUrl(),
      password: input.password ?? "",
    };
    if (input.path !== undefined) {
      const length = (await stat(input.path)).size;
      if (length <= PDF_DATA_LIMIT) {
        // Malformed files often have unusable xref offsets, and pdf.js's
        // range loader is stricter than its in-memory recovery path.
        options.data = new Uint8Array(await readFile(input.path));
      } else {
        options.range = createFileRangeTransport(
          pdfjs.PDFDataRangeTransport,
          input.path,
          length,
        );
      }
    } else {
      options.data = input.data ?? new Uint8Array(0);
    }
    if (options.data instanceof Uint8Array) preflightPdf(options.data);
    const source = options.data instanceof Uint8Array ? options.data : undefined;
    try {
      // pdf.js transfers (detaches) the buffer it is given, so keep ours for recovery.
      if (source !== undefined) options.data = source.slice();
      return await this.#start(pdfjs, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const recovered =
        source !== undefined && isMissingCatalogError(message)
          ? recoverDocument(source)
          : null;
      if (recovered === null) throw error;
      await this.#loading?.destroy();
      options.data = recovered;
      return await this.#start(pdfjs, options);
    }
  }

  /** Starts a loading task that dispose() will destroy. */
  #start(pdfjs: PdfModule, options: Record<string, unknown>): Promise<PdfDocument> {
    if (this.#disposal !== undefined) throw new Error("PDF session was disposed");
    const loading = pdfjs.getDocument(options);
    this.#loading = loading;
    return loading.promise;
  }

  async #extractPage(index: number): Promise<PdfResponse> {
    const document = this.#document;
    if (document === undefined) {
      return { type: "page-error", index, name: "Error", message: "PDF document is not open" };
    }
    let page: PdfPage | undefined;
    try {
      page = await document.getPage(index);
      const items = await this.#readTextItems(page);
      const pageLines = lines(items as PdfTextItem[], this.#input.sortByPosition ?? false);
      let annotations: PdfAnnotation[] = [];
      try {
        const values = (await page.getAnnotations?.({ intent: "display" })) ?? [];
        annotations = values.map((annotation) => ({
          name: typeof annotation.id === "string" ? annotation.id : undefined,
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
      return { type: "page", index, lines: pageLines, annotations };
    } catch (error) {
      return { type: "page-error", index, ...describe(error) };
    } finally {
      page?.cleanup();
    }
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

function createFileRangeTransport(
  Base: RangeTransportConstructor,
  path: string,
  length: number,
): RangeTransport {
  const transport = new Base(length, new Uint8Array(0));
  const deliver = transport.onDataRange.bind(transport);
  (transport as unknown as {
    requestDataRange: (start: number, end: number) => void;
  }).requestDataRange = (start: number, end: number): void => {
    void (async () => {
      const handle = await open(path, "r");
      try {
        const size = Math.max(0, Math.min(end - start, length - start));
        const chunk = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(
            chunk,
            offset,
            size - offset,
            start + offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        deliver(start, chunk.subarray(0, offset));
      } finally {
        await handle.close();
      }
    })();
  };
  return transport;
}

function standardFontsUrl(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("pdfjs-dist/package.json");
    return `${join(dirname(packageJson), "standard_fonts")}/`;
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
