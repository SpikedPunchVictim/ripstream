import { open, stat } from "node:fs/promises";
import {
  AbortError,
  EncryptedDocumentError,
  LimitExceededError,
  MalformedDocumentError,
  MediaType,
  Metadata,
  CONTEXT_KEYS,
  MissingDependencyError,
  ParseTimeoutError,
  TIKA_KEYS,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { InlineChannel } from "./pdf-channel.ts";
import {
  PdfSession,
  type PdfAnnotation,
  type PdfSessionInput,
} from "./pdf-session.ts";

const MAX_PAGES = 10_000;
const MIB = 1024 * 1024;

/**
 * PDF text and metadata extraction on top of pdf.js, loaded lazily as an
 * optional peer dependency.
 *
 * pdf.js runs on the calling thread. This parser does not contain a hostile
 * document: there is no memory cap, and a synchronous pdf.js loop cannot be
 * interrupted (see `pageTimeoutMs`). Callers that parse untrusted PDFs must run
 * the parser inside the process-isolation layer (see docs/isolation.md).
 */
export interface PdfParserOptions {
  /** Port of PDFParserConfig.extractAnnotationText (default true). */
  readonly extractAnnotationText?: boolean;
  /** Port of PDFParserConfig.sortByPosition (default true). */
  readonly sortByPosition?: boolean;
  /** Written between pages; empty disables it (default "\n"). */
  readonly pageSeparator?: string;
  /**
   * Maximum time to load the document or extract one page (default 30000 ms).
   * It ends an asynchronous stall with a ParseTimeoutError, but it cannot
   * interrupt a synchronous loop inside pdf.js: pdf.js runs on the calling
   * thread, so the timer cannot fire while the thread is busy. Bounding a
   * runaway parse is the job of the process-isolation layer
   * (see docs/isolation.md).
   */
  readonly pageTimeoutMs?: number;
  /** Static password or provider; empty password is attempted by default. */
  readonly password?: string | import("@spikedpunch/ripstream-core").PasswordProvider;
  /** Reject PDFs larger than this before pdf.js sees them (default 512 MiB). */
  readonly maxInputBytes?: number;
  /** Per-page cap on extracted text characters (default 32 Mi). */
  readonly maxPageTextChars?: number;
}

export class PdfParser implements Parser {
  readonly name = "PDFParser";
  readonly capabilities = { requiresRandomAccess: true, unsafe: true };
  readonly #extractAnnotationText: boolean;
  readonly #sortByPosition: boolean;
  readonly #pageSeparator: string;
  readonly #pageTimeoutMs: number;
  readonly #password: PdfParserOptions["password"];
  readonly #maxInputBytes: number;
  readonly #maxPageTextChars: number;

  constructor(options: PdfParserOptions = {}) {
    this.#extractAnnotationText = options.extractAnnotationText ?? true;
    this.#sortByPosition = options.sortByPosition ?? true;
    this.#pageSeparator = options.pageSeparator ?? "\n";
    this.#pageTimeoutMs = options.pageTimeoutMs ?? 30_000;
    this.#password = options.password;
    this.#maxInputBytes = options.maxInputBytes ?? 512 * MIB;
    this.#maxPageTextChars = options.maxPageTextChars ?? 32 * MIB;
  }

  getSupportedTypes(): ReadonlySet<MediaType> {
    return new Set([MediaType.parse("application/pdf")!]);
  }

  async parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext,
  ): Promise<void> {
    ctx.throwIfAborted();
    // Bound the spill: the stream's length is unknown until EOF, so pass the cap
    // into getFile() rather than writing an oversized input to disk first.
    const path = await stream.getFile(this.#maxInputBytes);
    const { size } = await stat(path);
    if (size > this.#maxInputBytes) {
      throw new LimitExceededError(
        `PDF is ${size} bytes, exceeding the ${this.#maxInputBytes} byte limit`,
      );
    }

    const limits = ctx.limits;
    const input: PdfSessionInput = {
      path,
      sortByPosition: this.#sortByPosition,
      password: resolvePassword(this.#password),
      maxPageTextChars: this.#maxPageTextChars,
      maxAttachments: limits.maxEmbeddedResources,
      maxAttachmentBytes: limits.maxEmbeddedResourceBytes,
      maxTotalAttachmentBytes: limits.maxTotalEmbeddedBytes,
    };
    const channel = new InlineChannel(new PdfSession(input));
    const onAbort = (): void => {
      void channel.stop();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const ready = await channel.next(this.#pageTimeoutMs);
      if (ready.type === "error") throw mapSessionError(ready);
      if (ready.type !== "ready") {
        throw new MalformedDocumentError("PDF session returned no document");
      }

      applyInfo(metadata, ready.info);
      applyXmp(metadata, ready.xmp);
      metadata.set("xmpTPg:NPages", ready.numPages);

      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();

      const annotationTypes = new Set<string>();
      const annotationSubtypes = new Set<string>();
      let hasAcroForm = false;
      const pages = Math.min(ready.numPages, MAX_PAGES);
      let totalText = 0;
      for (let index = 1; index <= pages; index++) {
        ctx.throwIfAborted();
        channel.post({ type: "page", index });
        const message = await channel.next(this.#pageTimeoutMs);
        if (message.type === "error") throw mapSessionError(message);
        if (message.type === "page-error") {
          if (message.name === "LimitExceededError") throw mapSessionError(message);
          // Upstream PDFBox recovers individual pages; keep the pages that
          // did parse instead of failing the whole document.
          continue;
        }
        if (message.type !== "page") {
          throw new MalformedDocumentError("Unexpected PDF session response");
        }
        await xhtml.startElement("div", "class", "page");
        let characters = 0;
        for (const line of message.lines) {
          characters += line.length;
          await xhtml.startElement("p");
          if (line.length > 0) await xhtml.characters(line);
          await xhtml.endElement("p");
        }
        totalText += characters;
        metadata.add("pdf:charsPerPage", String(characters));
        if (this.#extractAnnotationText) {
          for (const annotation of message.annotations) {
            recordAnnotation(annotation, annotationTypes, annotationSubtypes);
            if (annotation.fieldName !== undefined) hasAcroForm = true;
            await renderAnnotation(annotation, xhtml);
          }
        }
        await xhtml.endElement("div");
        if (index < pages && this.#pageSeparator.length > 0) {
          await xhtml.characters(this.#pageSeparator);
        }
      }

      // A PDF cut off before its %%EOF that yields no usable text is truncated, not an empty document: Tika's
      // PDFBox reports the damage, and a clean empty result would hide it.
      if (totalText === 0 && !(await hasEofMarker(path))) {
        throw new MalformedDocumentError("PDF is truncated: missing %%EOF");
      }

      if (hasAcroForm) metadata.set("pdf:has-acro-form-fields", "true");

      for (const name of annotationTypes) {
        metadata.add("pdf:annotation-types", name);
      }
      for (const subtype of annotationSubtypes) {
        metadata.add("pdf:annotation-subtypes", subtype);
      }

      for (const attachment of ready.attachments) {
        await xhtml.startElement("div", "class", "attachment");
        await xhtml.element("h1", attachment.filename);
        const embeddedMetadata = new Metadata();
        embeddedMetadata.set("tk:resource-name", attachment.filename);
        embeddedMetadata.set("Content-Type", "application/octet-stream");
        // Tika's AbstractPDF2XHTML types a PDF's embedded file ATTACHMENT.
        embeddedMetadata.set(TIKA_KEYS.EMBEDDED_RESOURCE_TYPE, "ATTACHMENT");
        const extractor = ctx.get(
          CONTEXT_KEYS.EMBEDDED_DOCUMENT_EXTRACTOR,
        ) as
          | {
              parseEmbedded(
                stream: RipstreamInputStream,
                handler: XHTMLContentHandler,
                metadata: Metadata,
                context: ParseContext,
              ): Promise<void>;
            }
          | undefined;
        if (extractor !== undefined) {
          const attachmentStream = await RipstreamInputStream.from(attachment.data, {
            context: ctx,
          });
          try {
            await extractor.parseEmbedded(
              attachmentStream,
              xhtml,
              embeddedMetadata,
              ctx,
            );
          } catch (error) {
            // A limit, timeout or abort ends the parse; any other failure is that attachment's: it is listed by name and
            // the exception goes on the PDF's metadata, as Tika's CompositeParser records each failed child.
            if (
              error instanceof LimitExceededError ||
              error instanceof ParseTimeoutError ||
              error instanceof AbortError ||
              ctx.signal.aborted
            ) {
              throw error;
            }
            metadata.add(
              TIKA_KEYS.EMBEDDED_EXCEPTION,
              error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            );
          } finally {
            await attachmentStream.close();
          }
        }
        await xhtml.endElement("div");
      }

      channel.post({ type: "close" });
      await channel.next(this.#pageTimeoutMs);
      await xhtml.endDocument();
    } catch (error) {
      ctx.throwIfAborted();
      throw error;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      await channel.stop();
    }
  }
}

function resolvePassword(
  password: PdfParserOptions["password"],
): string | undefined {
  if (password === undefined) return undefined;
  if (typeof password === "string") return password;
  return password.getPassword() ?? undefined;
}

function mapSessionError(message: {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}): Error {
  if (message.code === "ERR_MODULE_NOT_FOUND") {
    return new MissingDependencyError("pdfjs-dist", "PDF parsing");
  }
  if (message.name === "LimitExceededError") {
    return new LimitExceededError(message.message);
  }
  if (message.name === "PasswordException") {
    return new EncryptedDocumentError("PDF is encrypted", {
      cause: new Error(message.message),
    });
  }
  return new MalformedDocumentError("Unable to read PDF", {
    cause: new Error(message.message),
  });
}

function recordAnnotation(
  annotation: PdfAnnotation,
  types: Set<string>,
  subtypes: Set<string>,
): void {
  if (types.size < 100) types.add(annotation.name ?? "");
  if (subtypes.size < 100) subtypes.add(annotation.subtype ?? "");
}

async function renderAnnotation(
  annotation: PdfAnnotation,
  xhtml: XHTMLContentHandler,
): Promise<void> {
  if (annotation.url !== undefined && annotation.url.length > 0) {
    await xhtml.startElement("div", "class", "annotation");
    await xhtml.startElement("a", "href", annotation.url);
    await xhtml.characters(annotation.url);
    await xhtml.endElement("a");
    await xhtml.endElement("div");
  }

  if (annotation.fieldName !== undefined) {
    await xhtml.startElement("div", "class", "annotation");
    await xhtml.startElement("div", "class", "annotationField");
    await xhtml.characters(
      `${annotation.fieldName}: ${String(annotation.fieldValue ?? "")}`.trim(),
    );
    await xhtml.endElement("div");
    await xhtml.endElement("div");
  }

  if (
    annotation.title !== undefined ||
    annotation.subject !== undefined ||
    annotation.contents !== undefined
  ) {
    await xhtml.startElement("div", "class", "annotation");
    if (annotation.title !== undefined) {
      await xhtml.startElement("div", "class", "annotationTitle");
      await xhtml.characters(annotation.title);
      await xhtml.endElement("div");
    }
    if (annotation.subject !== undefined) {
      await xhtml.startElement("div", "class", "annotationSubject");
      await xhtml.characters(annotation.subject);
      await xhtml.endElement("div");
    }
    if (annotation.contents !== undefined) {
      await xhtml.startElement("div", "class", "annotationContents");
      await xhtml.characters(annotation.contents);
      await xhtml.endElement("div");
    }
    await xhtml.endElement("div");
  }
}

/** Whether the last 1 KiB of the file carries the %%EOF trailer every complete PDF ends with. */
async function hasEofMarker(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(1024, size);
    const buffer = new Uint8Array(length);
    await handle.read(buffer, 0, length, size - length);
    return new TextDecoder("latin1").decode(buffer).includes("%%EOF");
  } finally {
    await handle.close();
  }
}

function applyInfo(metadata: Metadata, info: unknown): void {
  if (typeof info !== "object" || info === null) return;
  const values = info as Record<string, unknown>;
  assign(metadata, "dc:title", values.Title);
  assign(metadata, "dc:creator", values.Author);
  assign(metadata, "dc:description", values.Subject);
  assign(metadata, "pdf:Keywords", values.Keywords);
  assign(metadata, "xmp:CreatorTool", values.Creator);
  assign(metadata, "pdf:Producer", values.Producer);
  assignDate(metadata, "dcterms:created", values.CreationDate);
  assignDate(metadata, "dcterms:modified", values.ModDate);
  assign(metadata, "pdf:PDFVersion", values.PDFFormatVersion);
  assign(metadata, "pdf:Trapped", values.Trapped);
  if (values.Encrypted === true) metadata.set("pdf:encrypted", "true");
}

function applyXmp(metadata: Metadata, xmp: Record<string, unknown>): void {
  if (xmp === null || typeof xmp !== "object") return;
  for (const [rawKey, rawValue] of Object.entries(xmp)) {
    const key = rawKey.trim();
    if (key.length === 0) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      const mapped = XMP_KEYS[key];
      if (mapped === undefined) {
        metadata.add(key, value);
      } else if (mapped.endsWith("Date")) {
        metadata.set(mapped, pdfDate(value) ?? value);
      } else {
        metadata.add(mapped, value);
      }
    }
  }
}

const XMP_KEYS: Record<string, string> = {
  "dc:title": "dc:title",
  "dc:creator": "dc:creator",
  "dc:description": "dc:description",
  "dc:language": "dc:language",
  "dc:subject": "dc:subject",
  "pdf:Keywords": "pdf:Keywords",
  "pdf:Producer": "pdf:Producer",
  "xmp:CreatorTool": "xmp:CreatorTool",
  "xmp:CreateDate": "dcterms:created",
  "xmp:ModifyDate": "dcterms:modified",
  "xmp:MetadataDate": "xmp:MetadataDate",
  "xmp:Label": "xmp:Label",
};

function assignDate(metadata: Metadata, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    metadata.set(key, pdfDate(value) ?? value);
  }
}

/** Converts a PDF date string (D:YYYYMMDDHHmmSSOHH'mm') to ISO 8601. */
export function pdfDate(value: string): string | undefined {
  const match =
    /^\s*D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:([Zz+\-])(\d{2})'?(\d{2})?)?/.exec(
      value,
    );
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] =
    match;
  const utc = Date.UTC(
    Number(year),
    Number(month ?? "1") - 1,
    Number(day ?? "1"),
    Number(hour ?? "0"),
    Number(minute ?? "0"),
    Number(second ?? "0"),
  );
  if (!Number.isFinite(utc)) return undefined;
  if (sign === "+" || sign === "-") {
    const offset =
      (Number(offsetHours ?? "0") * 60 + Number(offsetMinutes ?? "0")) * 60_000;
    return new Date(utc + (sign === "+" ? -offset : offset)).toISOString();
  }
  if (sign === "Z" || sign === "z") return new Date(utc).toISOString();
  return new Date(utc).toISOString();
}

function assign(metadata: Metadata, key: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) metadata.set(key, value);
}
