import { createRequire } from "node:module";
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { lines, type PdfTextItem } from "./pdf-lines.ts";
import { preflightPdf } from "./pdf-preflight.ts";
import { isMissingCatalogError, recoverDocument } from "./pdf-recover.ts";

interface PdfAnnotation {
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
}

interface PdfPage {
  streamTextContent(): ReadableStream<{ items: unknown[] }>;
  getAnnotations?(options?: { intent?: string }): Promise<PdfAnnotation[]>;
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
  destroy(): Promise<void>;
}

interface RangeTransport {
  readonly length: number;
  onDataRange(begin: number, chunk: Uint8Array): void;
}

interface RangeTransportConstructor {
  new (length: number, initialData: Uint8Array): RangeTransport;
}

interface PdfModule {
  PDFDataRangeTransport: RangeTransportConstructor;
  getDocument(options: Record<string, unknown>): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
}

interface PageRequest {
  readonly type: "page";
  readonly index: number;
}

interface CloseRequest {
  readonly type: "close";
}

type Request = PageRequest | CloseRequest;

const PDF_DATA_LIMIT = 8 * 1024 * 1024;

const port = parentPort;
const input = workerData as {
  readonly data?: Uint8Array;
  readonly path?: string;
  readonly sortByPosition?: boolean;
  readonly password?: string;
  readonly maxPageTextChars?: number;
  readonly maxAttachments?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxTotalAttachmentBytes?: number;
};

if (port !== null) {
  void run(port);
}

async function run(target: NonNullable<typeof parentPort>): Promise<void> {
  let document: PdfDocument | undefined;
  try {
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
    let loading: ReturnType<PdfModule["getDocument"]> | undefined;
    const source = options.data instanceof Uint8Array ? options.data : undefined;
    try {
      // pdf.js transfers (detaches) the buffer it is given, so keep ours for recovery.
      if (source !== undefined) options.data = source.slice();
      loading = pdfjs.getDocument(options);
      document = await loading.promise;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const recovered =
        source !== undefined && isMissingCatalogError(message)
          ? recoverDocument(source)
          : null;
      if (recovered === null) throw error;
      await loading?.destroy();
      options.data = recovered;
      document = await pdfjs.getDocument(options).promise;
    }
  } catch (error) {
    target.postMessage({ type: "error", ...describe(error) });
    return;
  }

  try {
    const metadata = await document.getMetadata();
    let xmp: Record<string, unknown> = {};
    try {
      xmp = metadata.metadata?.getAll?.() ?? {};
    } catch {
      xmp = {};
    }
    let attachments: Array<{ name: string; filename: string; data: Uint8Array }> = [];
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
    // Check sizes here: postMessage would structured-clone every attachment.
    checkAttachments(attachments);
    target.postMessage({
      type: "ready",
      info: metadata.info,
      xmp,
      numPages: document.numPages,
      attachments,
    });
  } catch (error) {
    target.postMessage({ type: "error", ...describe(error) });
    return;
  }

  target.on("message", (message: Request) => {
    void handle(message);
  });

  async function handle(message: Request): Promise<void> {
    if (document === undefined) return;
    if (message.type === "page") {
      try {
        const page = await document.getPage(message.index);
        const items = await readTextItems(page);
        const pageLines = lines(
          items as PdfTextItem[],
          input.sortByPosition ?? false,
        );
        let annotations: unknown[] = [];
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
          }));
        } catch {
          annotations = [];
        }
        page.cleanup();
        target.postMessage({
          type: "page",
          index: message.index,
          lines: pageLines,
          annotations,
        });
      } catch (error) {
        target.postMessage({
          type: "page-error",
          index: message.index,
          ...describe(error),
        });
      }
      return;
    }

    try {
      await document.destroy();
    } finally {
      target.postMessage({ type: "closed" });
      target.close();
    }
  }
}

/**
 * pdf.js can emit text without bound (for example mutually recursive form
 * XObjects), so stream the page and cancel once the character cap is hit.
 */
async function readTextItems(page: PdfPage): Promise<unknown[]> {
  const maxChars = input.maxPageTextChars ?? Number.MAX_SAFE_INTEGER;
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
      // No reader.cancel(): pdf.js throws from the cancelled stream. The caller
      // terminates the worker on this error instead.
      throw new LimitError(`Page text exceeds ${maxChars} characters`);
    }
  }
}

function checkAttachments(
  attachments: ReadonlyArray<{ readonly filename: string; readonly data: Uint8Array }>,
): void {
  const maxCount = input.maxAttachments ?? Number.MAX_SAFE_INTEGER;
  const maxBytes = input.maxAttachmentBytes ?? Number.MAX_SAFE_INTEGER;
  const maxTotal = input.maxTotalAttachmentBytes ?? Number.MAX_SAFE_INTEGER;
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
