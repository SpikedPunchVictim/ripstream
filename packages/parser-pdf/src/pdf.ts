import { stat } from "node:fs/promises";
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
  tikaDateMetadataString,
  XHTMLContentHandler,
  type ContentHandler,
  type ParseContext,
  type Parser,
  RipstreamInputStream,
} from "@spikedpunch/ripstream-core";
import { InlineChannel } from "./pdf-channel.ts";
import { extractXmp } from "./xmp.ts";
import type { PageContent } from "./pdf-content.ts";
import {
  PdfSession,
  type PdfAnnotation,
  type PdfRepair,
  type PdfSessionInput,
} from "./pdf-session.ts";

const MAX_PAGES = 10_000;

/** Pages named one by one in `tk:exception:warn` before the rest are counted. */
const MAX_PAGE_WARNINGS = 10;
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

      // The pages are read one by one up to a cap, and a document over it is refused, as every other limit is: reading
      // the first MAX_PAGES and saying nothing about the rest hid whatever was on them.
      if (ready.numPages > MAX_PAGES) {
        throw new LimitExceededError(`PDF has ${ready.numPages} pages, exceeding the ${MAX_PAGES} page limit`);
      }

      // Tika reads the XMP packet first, then the Info dictionary, which fills what the packet left empty.
      applyXmp(metadata, ready.xmp);
      applyInfo(metadata, ready.info);
      metadata.set("xmpTPg:NPages", ready.numPages);
      applyPermissions(metadata, ready.permissions, ready.ownerAccess);
      metadata.set("pdf:has-marked-content", ready.hasMarkedContent ? "true" : "false");
      if (ready.eofOffsets !== undefined) {
        for (const offset of ready.eofOffsets) metadata.add("pdf:eof-offsets", String(offset));
        metadata.set("pdf:incremental-update-count", String(Math.max(0, ready.eofOffsets.length - 1)));
      }
      let repair = ready.repair;
      if (repair !== undefined) recordRepair(metadata, repair);

      const xhtml = new XHTMLContentHandler(handler, metadata);
      await xhtml.startDocument();

      // Tika's markdown output starts with the document title and the outline titles; the text handler sees the
      // body only, so write them into it.
      const documentTitle = metadata.get("dc:title");
      if (documentTitle !== null && documentTitle.trim().length > 0) await xhtml.element("p", documentTitle);
      for (const title of ready.outline) await xhtml.element("p", title);

      const annotationTypes = new Set<string>();
      const annotationSubtypes = new Set<string>();
      let hasAcroForm = false;
      let threeDAnnotations = 0;
      const pages = ready.numPages;
      const imageOnlyPages: number[] = [];
      const emptiness = new EmptyDocumentEvidence();
      for (let index = 1; index <= pages; index++) {
        ctx.throwIfAborted();
        channel.post({ type: "page", index });
        const message = await channel.next(this.#pageTimeoutMs);
        if (message.type === "error") throw mapSessionError(message);
        if (message.type === "page-error") {
          if (message.name === "LimitExceededError") throw mapSessionError(message);
          // Upstream PDFBox recovers individual pages; keep the pages that
          // did parse instead of failing the whole document. The page is not silently gone: a warning names it, and
          // pdf:chars-per-page keeps one value per page.
          emptiness.pageFailed(index, message.message);
          metadata.add("pdf:chars-per-page", "0");
          continue;
        }
        if (message.type !== "page") {
          throw new MalformedDocumentError("Unexpected PDF session response");
        }
        // A document pdf.js opened as it stood can be reopened from repaired bytes when a page proves lost text.
        if (message.repair !== undefined && repair === undefined) {
          repair = message.repair;
          recordRepair(metadata, repair);
        }
        await xhtml.startElement("div", "class", "page");
        let characters = 0;
        for (const line of message.lines) {
          characters += line.length;
          await xhtml.startElement("p");
          if (line.length > 0) await xhtml.characters(line);
          await xhtml.endElement("p");
        }
        metadata.add("pdf:chars-per-page", String(characters));
        const hasText = message.lines.some((line) => line.trim().length > 0);
        emptiness.page(index, hasText, message.content);
        if (!hasText && message.content?.paintsImage === true) imageOnlyPages.push(index);
        for (const annotation of message.annotations) if (annotation.subtype === "3D") threeDAnnotations++;
        if (this.#extractAnnotationText) {
          let fieldIndex = 0;
          for (const annotation of message.annotations) {
            recordAnnotation(annotation, annotationTypes, annotationSubtypes);
            if (annotation.fieldName !== undefined) hasAcroForm = true;
            await renderAnnotation(annotation, xhtml, annotation.fieldName === undefined ? 0 : ++fieldIndex);
          }
        }
        await xhtml.endElement("div");
        if (index < pages && this.#pageSeparator.length > 0) {
          await xhtml.characters(this.#pageSeparator);
        }
      }

      for (const warning of emptiness.warnings()) metadata.add("tk:exception:warn", `${MalformedDocumentError.name}: ${warning}`);
      // Pages that could not be read, and not one with text: nothing was read of this document, whatever the xref said.
      if (repair === undefined && emptiness.unreadable()) {
        throw new MalformedDocumentError(`PDF pages could not be read (${emptiness.failures()})`);
      }

      // A PDF cut off before its %%EOF, or with padding after it, that yields no text is an empty document, as in Tika 4.2.0:
      // PDFBox answers 200 with empty text for such files (oracle: a text-less PDF cut at 20-60% of its length, or padded with 3 KB after %%EOF; bughunt B32).
      // That holds after a recovery only when every page is shown to be text-less (tikajs-4hfu); otherwise the damage is the answer.
      if (repair !== undefined) {
        const unproven = emptiness.unproven(pages, repair.steps.includes("page-tree-rebuilt"));
        if (unproven.length > 0) {
          throw new MalformedDocumentError(
            `PDF is damaged and no text could be recovered (${[...repair.causes, ...unproven].join("; ")})`,
          );
        }
      }
      if (imageOnlyPages.length > 0) {
        metadata.set("tk:pdf:image-only-page-count", String(imageOnlyPages.length));
        for (const page of imageOnlyPages) metadata.add("tk:pdf:image-only-pages", String(page));
      }

      metadata.set("pdf:num-3d-annotations", String(threeDAnnotations));
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

/** Tika's access-permission:* keys, from the /P bits as PDFBox's AccessPermission reads them; everything is allowed to an owner. */
const PERMISSION_KEYS: ReadonlyArray<readonly [string, number]> = [
  ["can-print", 4],
  ["can-modify", 8],
  ["extract-content", 16],
  ["modify-annotations", 32],
  ["fill-in-form", 256],
  ["extract-for-accessibility", 512],
  ["assemble-document", 1024],
  ["can-print-faithful", 2048],
];

function applyPermissions(metadata: Metadata, flags: readonly number[] | null, owner: boolean): void {
  for (const [name, bit] of PERMISSION_KEYS) {
    metadata.set(`access-permission:${name}`, flags === null || owner || flags.includes(bit) ? "true" : "false");
  }
}

function recordRepair(metadata: Metadata, repair: PdfRepair): void {
  metadata.set("tk:pdf:repaired", "true");
  for (const step of repair.steps) metadata.add("tk:pdf:repair-steps", step);
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
  readonly causes?: readonly string[];
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
  const causes = message.causes ?? [];
  return new MalformedDocumentError(causes.length === 0 ? "Unable to read PDF" : `Unable to read PDF (${causes.join("; ")})`, {
    cause: new Error(message.message),
  });
}

/**
 * Whether a recovered document that gave no text is text-less by design (a scan, an empty page) rather than damaged
 * past reading: every page loaded, and each one's content streams were found and decoded and show no text.
 */
class EmptyDocumentEvidence {
  #text = false;
  #failed = 0;
  #contentRead = false;
  #unlisted = 0;
  readonly #problems: string[] = [];

  /** Warnings written to `tk:exception:warn`: what was lost, by page; the first few, then a count. */
  readonly #warnings: string[] = [];
  #unwarned = 0;
  readonly #failures: string[] = [];

  pageFailed(index: number, message: string): void {
    this.#failed++;
    this.#warn(`page ${index} could not be read: ${message}`);
    if (this.#failures.length < 4) this.#failures.push(`page ${index}: ${message}`);
  }

  #warn(warning: string): void {
    if (this.#warnings.length < MAX_PAGE_WARNINGS) this.#warnings.push(warning);
    else this.#unwarned++;
  }

  warnings(): string[] {
    return this.#unwarned === 0 ? [...this.#warnings] : [...this.#warnings, `${this.#unwarned} more pages with a problem`];
  }

  /** True when pages failed to load and none had text. */
  unreadable(): boolean {
    return this.#failed > 0 && !this.#text;
  }

  failures(): string {
    const more = this.#failed - this.#failures.length;
    return [...this.#failures, ...(more > 0 ? [`${more} more`] : [])].join("; ");
  }

  page(index: number, hasText: boolean, content: PageContent | undefined): void {
    if (hasText) {
      this.#text = true;
      return;
    }
    let problem: string | null = null;
    if (content === undefined) problem = `page ${index} content could not be checked`;
    else if (content.contents === "cut-off") problem = `page ${index} is cut off`;
    else if (content.contents === "missing") problem = `page ${index} content is missing`;
    else if (content.contents === "unreadable") problem = `page ${index} content could not be decoded`;
    else if (content.showsText) problem = `page ${index} shows text that could not be extracted`;
    if (content?.contents === "read") this.#contentRead = true;
    if (problem === null) return;
    // Content that is cut off, missing or unreadable, or that shows text pdf.js did not extract, is lost text. That the
    // content could not be checked at all is no finding about the document.
    if (content !== undefined) this.#warn(problem);
    // The message names the first few; the rest are counted, so a document of many pages does not read as four.
    if (this.#problems.length < 4) this.#problems.push(problem);
    else this.#unlisted++;
  }

  /** Why an empty result is not shown to be text-less; empty when it is, or when there was text. */
  unproven(pages: number, pageTreeRebuilt: boolean): string[] {
    if (this.#text) return [];
    const problems = [...this.#problems];
    if (this.#unlisted > 0) problems.push(`${this.#unlisted} more page${this.#unlisted === 1 ? "" : "s"} with a problem`);
    if (pages === 0) problems.push("no pages");
    if (this.#failed > 0) problems.push(`${this.#failed} page${this.#failed === 1 ? "" : "s"} could not be read`);
    // Pages found by scanning that name no content prove nothing about the document they came from.
    if (pageTreeRebuilt && !this.#contentRead && problems.length === 0) problems.push("no page content found");
    return problems;
  }
}

function recordAnnotation(
  annotation: PdfAnnotation,
  types: Set<string>,
  subtypes: Set<string>,
): void {
  // Tika writes the annotation's /NM, and "null" when it has none, which is nearly always (oracle, Tika 4.2.0).
  if (types.size < 100) types.add(annotation.name ?? "null");
  if (subtypes.size < 100 && annotation.subtype !== undefined && annotation.subtype !== "") subtypes.add(annotation.subtype);
}

async function renderAnnotation(
  annotation: PdfAnnotation,
  xhtml: XHTMLContentHandler,
  fieldIndex: number,
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
    const field = `${annotation.fieldName}: ${String(annotation.fieldValue ?? "")}`.trim();
    await xhtml.characters(fieldIndex > 0 ? `${fieldIndex}. ${field}` : field);
    await xhtml.endElement("div");
    await xhtml.endElement("div");
  }

  // pdf.js does not expose /Subj; Acrobat writes these subjects for the two standard annotation kinds.
  const subject =
    annotation.subject ??
    (annotation.it === "FreeTextTypewriter" ? "Typewritten Text" : annotation.subtype === "Text" ? "Sticky Note" : undefined);
  if (
    annotation.title !== undefined ||
    subject !== undefined ||
    annotation.contents !== undefined
  ) {
    await xhtml.startElement("div", "class", "annotation");
    if (annotation.title !== undefined) {
      await xhtml.startElement("div", "class", "annotationTitle");
      await xhtml.characters(annotation.title);
      await xhtml.endElement("div");
    }
    if (subject !== undefined) {
      await xhtml.startElement("div", "class", "annotationSubject");
      await xhtml.characters(subject);
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

/**
 * The Info dictionary as Tika 4.2.0's PDMetadataExtractor writes it (checked against a running server): every entry under
 * `pdf:docinfo:*`, and the canonical keys from it only where the XMP packet has not already set them. The dates are the
 * exception, the Info dictionary's replacing the packet's. Keywords and subject are added to dc:subject, which has no
 * description.
 */
function applyInfo(metadata: Metadata, info: unknown): void {
  if (typeof info !== "object" || info === null) return;
  const values = info as Record<string, unknown>;
  const text = (value: unknown): string | undefined => {
    const raw = typeof value === "object" && value !== null && "name" in value ? (value as { name: unknown }).name : value;
    return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
  };
  const title = text(values.Title);
  const author = text(values.Author);
  const keywords = text(values.Keywords);
  const subject = text(values.Subject);
  const creator = text(values.Creator);
  const producer = text(values.Producer);
  const trapped = text(values.Trapped);
  // A date that is not one is dropped, from the canonical key and from pdf:docinfo alike.
  const created = text(values.CreationDate) === undefined ? undefined : pdfDate(text(values.CreationDate)!);
  const modified = text(values.ModDate) === undefined ? undefined : pdfDate(text(values.ModDate)!);

  const ifAbsent = (key: string, value: string | undefined): void => {
    if (value !== undefined && metadata.get(key) === null) metadata.set(key, value);
  };
  ifAbsent("dc:title", title);
  ifAbsent("dc:creator", author);
  ifAbsent("xmp:CreatorTool", creator);
  ifAbsent("pdf:producer", producer);
  ifAbsent("pdf:trapped", trapped);
  if (keywords !== undefined) metadata.add("dc:subject", keywords);
  if (subject !== undefined) metadata.add("dc:subject", subject);
  if (created !== undefined) metadata.set("dcterms:created", created);
  if (modified !== undefined) metadata.set("dcterms:modified", modified);

  const docinfo = (name: string, value: string | undefined): void => {
    if (value !== undefined) metadata.set(`pdf:docinfo:${name}`, value);
  };
  docinfo("title", title);
  docinfo("creator", author);
  docinfo("keywords", keywords);
  docinfo("subject", subject);
  docinfo("creator-tool", creator);
  docinfo("producer", producer);
  docinfo("trapped", trapped);
  docinfo("created", created);
  docinfo("modified", modified);
  const custom = values.Custom;
  if (typeof custom === "object" && custom !== null) {
    for (const [name, value] of Object.entries(custom as Record<string, unknown>)) {
      const entry = text(value);
      if (entry !== undefined) metadata.set(`pdf:docinfo:custom:${name}`, entry);
    }
  }

  const version = text(values.PDFFormatVersion);
  if (version !== undefined) {
    metadata.set("pdf:pdf-version", version);
    metadata.set("dc:format", `application/pdf; version=${version}`);
  }
  metadata.set("pdf:encrypted", values.Encrypted === true ? "true" : "false");
  metadata.set("pdf:has-xfa", values.IsXFAPresent === true ? "true" : "false");
  metadata.set("pdf:has-collection", values.IsCollectionPresent === true ? "true" : "false");
}

/** The XMP packet, when there is one. A packet that is not well-formed XML is noted and contributes nothing, as in Tika. */
function applyXmp(metadata: Metadata, xmp: string): void {
  if (xmp.length === 0) {
    metadata.set("pdf:has-xmp", "false");
    return;
  }
  metadata.set("pdf:has-xmp", "true");
  const failure = extractXmp(xmp, metadata);
  if (failure !== undefined) metadata.add("tk:exception:warn", `${MalformedDocumentError.name}: ${failure.message}`);
}

const PDF_DATE =
  /^\s*(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?\s*(?:[Zz]|([+-])(\d{2})(?:'?(\d{2})'?)?)?\s*$/;

/**
 * Converts a PDF date string (D:YYYYMMDDHHmmSSOHH'mm') to ISO 8601 in UTC with whole seconds, which is what Tika writes.
 * Checked against Tika 4.2.0: the D: prefix is optional, an ISO 8601 string is taken too, a date that does not exist
 * (February 30th, hour 24, month 13, year 0) or has text after it is no date at all, and then Tika writes no key.
 */
export function pdfDate(value: string): string | undefined {
  const match = PDF_DATE.exec(value);
  if (match === null) return tikaDateMetadataString(value) ?? undefined;
  const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes] = match;
  const parts = [Number(year), Number(month ?? "1"), Number(day ?? "1"), Number(hour ?? "0"), Number(minute ?? "0"), Number(second ?? "0")] as const;
  const [y, mo, d, h, mi, s] = parts;
  // Date.UTC reads the years 0-99 as 1900-1999, so the year is set apart.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  let time = date.getTime();
  if (sign === "+" || sign === "-") {
    const offset = (Number(offsetHours ?? "0") * 60 + Number(offsetMinutes ?? "0")) * 60_000;
    time += sign === "+" ? -offset : offset;
  }
  return new Date(time).toISOString().replace(".000Z", "Z");
}
