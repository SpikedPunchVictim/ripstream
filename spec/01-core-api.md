# 01 — Core API Contracts

All public types are `readonly` unless mutation is the point. Public API has no `any`; escape hatches take explicit generics. Every I/O method accepts `AbortSignal` through `ParseContext`.

## 1. Byte streams and sources

```ts
export type ByteStream = AsyncIterable<Uint8Array>;

export type InputSource =
  | ByteStream
  | ReadableStream<Uint8Array>      // Web
  | NodeJS.ReadableStream           // Node, adapter
  | Uint8Array
  | ArrayBuffer
  | Blob
  | { path: string }                // Node only, lazy open
  | { url: string; headers?: HeadersInit }; // explicit opt-in network fetch
```

Design rules:

- Core never accepts a bare `Buffer` alias in public signatures; `Uint8Array` is canonical.
- `Uint8Array`/`ArrayBuffer`/`Blob` inputs MAY be consumed without spooling, but random-access parsers still route through `RipstreamInputStream`.
- `{ url }` is disabled by default (`allowUrlInput: false`) because it turns a parser call into an SSRF primitive. HTTP inputs belong in the pipes layer with allowlists.
- Every source resolves to a single `RipstreamInputStream` via `RipstreamInputStream.from(source, ctx)`.

Adapters exported:

```ts
export function toAsyncIterable(source: InputSource): AsyncIterable<Uint8Array>;
export function toReadableStream(stream: ByteStream, opts?: { highWaterMark?: number }): ReadableStream<Uint8Array>;
export function toNodeReadable(stream: ByteStream): NodeJS.ReadableStream;
export function collect(stream: ByteStream, limit?: number): Promise<Uint8Array>;
```

`collect` is the only whole-file helper and is opt-in. It throws `LimitExceededError` past `limit`.

## 2. MediaType and MimeTypes

```ts
export class MediaType {
  readonly type: string;                    // lowercased
  readonly subtype: string;                // lowercased
  readonly parameters: ReadonlyMap<string, string>;
  readonly charset: string | null;

  static parse(value: string): MediaType;                 // throws MalformedMediaTypeError
  static tryParse(value: string): MediaType | null;
  static readonly OCTET_STREAM: MediaType;
  static readonly TEXT_PLAIN: MediaType;
  static readonly APPLICATION_XML: MediaType;

  withParameters(params: Record<string, string>): MediaType;
  withoutParameters(...names: string[]): MediaType;
  isWildcard(): boolean;                                  // */* or type/*
  isSpecializationOf(other: MediaType): boolean;
  equals(other: MediaType | string): boolean;
  toString(): string;                                     // canonical: type/subtype; a=b; c=d
}

export class MimeType extends MediaType {
  readonly description: string | null;
  readonly extensions: readonly string[];                // ".docx"
  readonly globs: readonly string[];                     // "*.docx"
  readonly supertype: MediaType | null;
  readonly rootXML: { localName: string; namespace: string } | null;
  readonly magic: readonly MagicRule[];                  // compiled matchers
}

export class MimeTypes {
  getMediaType(extOrName: string): MediaType | null;
  getRegisteredMimeType(value: string): MimeType | null;  // params stripped
  getSupertype(type: MediaType): MediaType | null;
  getTypes(): readonly MimeType[];
  getExtensions(): readonly string[];
  getGlobs(): readonly string[];
  forName(name: string): MediaType | null;               // glob match, case-insensitive
  forRootXML(localName: string, namespace: string): MediaType | null;
}
```

`MimeTypes` is immutable and built from the generated registry. Custom registries merge at config time; later definitions override earlier ones.

## 3. Metadata

```ts
export type MetadataValue = string | number | boolean | Date;

export interface Property {
  readonly prefix: string;          // "dc", "xmp", "pdf", "X-TIKA"
  readonly name: string;            // "creator"
  readonly valueType: 'string' | 'integer' | 'long' | 'date' | 'boolean' | 'real';
  readonly key: string;             // canonical serialized key
}

export class Metadata implements Iterable<[string, string]> {
  add(name: string | Property, value: MetadataValue): void;
  set(name: string | Property, value: MetadataValue | null): void;   // null removes
  get(name: string | Property): string | null;                        // first value
  getAll(name: string | Property): string[];
  getFirst(names: readonly (string | Property)[]): string | null;
  has(name: string | Property): boolean;
  remove(name: string | Property): void;
  names(): string[];                                                  // insertion order, stable
  size(): number;
  isEmpty(): boolean;

  getDate(name: string | Property, zone?: string): Date | null;
  setDate(name: string | Property, value: Date, zone?: string): void;
  getInt(name: string | Property): number | null;
  getLong(name: string | Property): bigint | null;
  getBoolean(name: string | Property): boolean | null;

  merge(other: Metadata): void;
  clone(): Metadata;
  toObject(): Record<string, string | string[]>;
}

export const TIKA: {
  CONTENT: Property;               // "tk:content"
  EMBEDDED_RESOURCE_PATH: Property;// "tk:embedded-resource-path"
  EMBEDDED_DEPTH: Property;        // "tk:embedded-depth"
  PARSE_TIME_MS: Property;         // "tk:parse-time-millis"
  EXCEPTION: Property;             // "X-TIKA:EXCEPTION:<class>"
  EXCEPTION_MESSAGE: Property;
  EXCEPTION_STACK: Property;
  DIGEST_MD5: Property;
  DIGEST_SHA256: Property;
  CONTAINER: Property;
  RESOURCE_NAME: Property;
  CONTENT_TYPE: Property;
  CHARSET: Property;
  DETECTED_CONTENT_TYPE: Property;
};
```

Rules:

- Keys are case-preserving and **case-sensitive**, exactly like upstream `HashMap` keys. There is no trim, case folding, or prefix normalization on write or lookup.
- Upstream stores values in a `HashMap<String,String[]>`; key iteration order is unspecified. This implementation uses `Map` insertion order as a convenience, but no caller may depend on it and parity tests compare key sets, not order.
- `add` appends; `set` replaces with a single value; `set(name, null)` removes the key. `get` returns the first value. Values inside `style`/`script` are irrelevant here but reserved `X-TIKA:` writes are guarded upstream and must be too.
- Dates are stored/retrieved in a configurable zone (default UTC) with ISO-8601 fallback parsing. Invalid values return `null`, never throw.
- Metadata never carries binary payloads. Bytes go to `EmbeddedDocumentBytesHandler`.
- Write limits are applied by `MetadataWriter` at output time, not on `add`.

## 4. ContentHandler (SAX-shaped) and Attributes

```ts
export interface Attributes {
  getLength(): number;
  getQName(i: number): string;
  getURI(i: number): string;
  getLocalName(i: number): string;
  getType(i: number): string;                 // "CDATA"
  getValue(i: number): string;
  getValueByQName(qName: string): string | null;
  getValueByURI(uri: string, localName: string): string | null;
  readonly names: ReadonlyArray<{ qName: string; uri: string; localName: string; value: string }>;
}

export interface ContentHandler {
  startDocument(): void | Promise<void>;
  endDocument(): void | Promise<void>;
  startPrefixMapping?(prefix: string, uri: string): void | Promise<void>;
  endPrefixMapping?(prefix: string): void | Promise<void>;
  startElement?(uri: string, localName: string, qName: string, atts: Attributes): void | Promise<void>;
  endElement?(uri: string, localName: string, qName: string): void | Promise<void>;
  characters?(ch: string, start: number, length: number): void | Promise<void>;
  ignorableWhitespace?(ch: string, start: number, length: number): void | Promise<void>;
  processingInstruction?(target: string, data: string): void | Promise<void>;
  skippedEntity?(name: string): void | Promise<void>;
}

export interface ContentHandlerDecorator extends ContentHandler {
  setDelegate(delegate: ContentHandler): void;
  getDelegate(): ContentHandler;
}
```

Async return values are permitted because output must apply backpressure. Parser helper `ElementWriter` wraps this with terse methods:

```ts
const xh = new XHTMLContentHandler(sink);
xh.startDocument();
await xh.element('h1', null, 'Title');
await xh.element('p', { class: 'lead' }, text);
await xh.element('img', { src: 'embedded:image0.png', alt: '' });
xh.endDocument();
```

Every `await` returns a resolved promise in the synchronous case, so text-heavy parsers batch at least 4 KiB of characters per event.

## 5. RipstreamInputStream

```ts
export class RipstreamInputStream implements AsyncIterable<Uint8Array>, AsyncDisposable {
  static from(source: InputSource, ctx: ParseContext): Promise<RipstreamInputStream>;

  readonly hasFile: boolean;              // spooled to disk
  readonly length: number | null;         // known only after full read
  readonly position: number;              // bytes consumed from the logical start

  read(): Promise<Uint8Array | null>;      // pull one chunk
  readFully(maxBytes: number): Promise<Uint8Array>;
  peek(n: number): Promise<Uint8Array>;   // non-consuming, memoized prefix
  mark(limit?: number): void;
  reset(): Promise<void>;
  seek(offset: number, whence?: 'start' | 'current' | 'end'): Promise<number>;
  getFile(): Promise<{ path: string; handle: FileHandleLike }>; // throws if not spooled
  getPath(): string | null;

  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

Semantics:

- Lazy spooling: bytes stay in a ring buffer until `spoolThreshold` (default 1 MiB) is exceeded, then transfer to a temp file. `mark/reset` and `seek` force spooling if the target precedes the buffer.
- `length` is `null` until EOF unless the source declared `Content-Length` or is a file.
- Browser runtime: spooling uses OPFS when available, else throws `RandomAccessUnavailableError` for parsers that require seeking; `peek` and sequential parsers still work.
- Registered with `ctx.temporaryResources`; closed on parse completion, abort, or error.
- Reuse: `AutoDetectParser` consumes the prefix for detection, then rewinds; parsers never see a consumed stream.

## 6. ParseContext and limits

```ts
export type ParseContextKey<T> = { readonly id: string; readonly __type?: T };

export class ParseContext implements AsyncDisposable {
  get<T>(key: ParseContextKey<T>): T | undefined;
  set<T>(key: ParseContextKey<T>, value: T): void;
  has<T>(key: ParseContextKey<T>): boolean;
  remove<T>(key: ParseContextKey<T>): void;

  readonly signal: AbortSignal;
  throwIfAborted(): void;

  readonly limits: ParseLimits;
  readonly temporaryResources: TemporaryResources;
  readonly runtime: Runtime;
  readonly config: ResolvedConfig;

  createChild(overrides?: Partial<ParseContextOptions>): ParseContext; // inherits + shares resources
}

export interface ParseLimits {
  maxOutputChars: number;             // default 100_000 (upstream WriteOutContentHandler)
  maxEmbeddedResources: number;       // default 10_000
  maxEmbeddedResourceBytes: number;   // per embedded document
  maxTotalEmbeddedBytes: number;      // per top-level parse
  maxDecompressionRatio: number;      // default 100
  maxNodeDepth: number;               // default 100
  maxParseMillis: number;             // wall clock per document
  maxTaskMillis: number;              // per parser task; cooperative + worker kill
  maxMetadataValueChars: number;      // default 1_000_000
  maxZipEntries: number;              // default 10_000
  maxXmlEntityExpansions: number;     // default 0 (DTDs disabled)
}
```

Standard context keys (typed constants exported):

| Key | Type | Purpose |
|---|---|---|
| `PARSER` | `Parser` | recursive auto-detection |
| `DETECTOR` | `Detector` | |
| `PASSWORD_PROVIDER` | `PasswordProvider` | encrypted PDF/Office |
| `EMBEDDED_DOCUMENT_EXTRACTOR` | `EmbeddedDocumentExtractor` | |
| `EMBEDDED_DOCUMENT_BYTES_HANDLER` | `EmbeddedDocumentBytesHandler` | raw bytes |
| `EMBEDDED_RESOURCE_HANDLER` | `EmbeddedResourceHandler` | images/etc. in-place |
| `RESOURCE_TRACKER` | `ResourceTracker` | cleanup |
| `PARSING_INTENT` | `'DEFAULT' \| 'RANDOM_ACCESS' \| 'OCR' \| 'METADATA_ONLY'` | |
| `LOCALE` | `string` | message/date locale |
| `CONTENT_TYPE` | `MediaType` | detected type |
| `CONTAINER` | `RipstreamInputStream` | current container |
| `EMBEDDED_RELATIONSHIP_ID` | `string` | |
| `EMBEDDED_DEPTH` | `number` | |
| `EXCEPTION_HANDLER` | `(e, ctx) => void` | parser-local recoverable errors |
| `MAX_EMBEDDED_RESOURCES` | `number` | override |
| `OCR_CONFIG` | `OcrConfig` | |
| `PDF_CONFIG` | `PdfConfig` | |
| `HTTP_HEADERS` | `Headers` | server-compat, untrusted by default |

`ParseContext` is not shared across concurrent documents. Child contexts share `TemporaryResources` and the abort signal.

## 7. Parser SPI

```ts
export interface Parser {
  readonly name: string;

  /** Types this parser fully or partially handles. */
  getSupportedTypes(ctx: ParseContext): Promise<ReadonlySet<MediaType>> | ReadonlySet<MediaType>;

  parse(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext
  ): Promise<void>;

  /** Hints consumed by the framework, not by callers. */
  readonly capabilities?: ParserCapabilities;
}

export interface ParserCapabilities {
  requiresRandomAccess?: boolean;      // framework spools
  metadataOnly?: boolean;              // no text emission promised
  rendering?: boolean;                 // can render pages/images (OCR input)
  stateful?: boolean;                  // must be reset per document
  unsafe?: boolean;                    // run in worker when available
  embeddedBytes?: 'stream' | 'buffer';
  maxConcurrency?: number;
}

export interface PasswordProvider {
  getPassword(mediaType: MediaType, metadata: Metadata): Promise<string | null>;
}

export interface StatefulParser extends Parser {
  reset(): void;
}
```

Framework classes:

```ts
class CompositeParser implements Parser {
  // Selects all parsers whose supported type set contains the exact type,
  // then those declaring a wildcard supertype; runs in registration order.
  // A parser may decline by throwing ParserDeclinedError.
}
class DefaultParser extends CompositeParser {}
class AutoDetectParser implements Parser {
  constructor(opts: { detector?: Detector; parser?: Parser });
}
class FallbackParser implements Parser {}        // emits plain text for unknown text/*
class EmptyParser implements Parser {}           // emits nothing, success
class ErrorParser implements Parser {}           // always throws UnsupportedFormatError
class DelegatingParser implements Parser {}
class ParserDecorator implements Parser { setDelegate(p: Parser): void; }
class MimeFilteringDecorator extends ParserDecorator {}
```

Selection and error rules:

- Exact-type match beats wildcard; multiple matches all run, output concatenated in registration order.
- `ParserDeclinedError` (internal) moves to the next candidate. Any other parser error propagates unless `ctx.get(EXCEPTION_HANDLER)` swallows it.
- Unsupported type with no parser: `UnsupportedFormatError` carrying the media type. Empty input: `AutoDetectParser` throws `ZeroByteFileError` (a `MalformedDocumentError`, Tika's `ZeroByteFileException`) once the type is recorded; `EmptyDocumentError` is not thrown by any parser. `ParseOptions.onDocumentFailure: "record"` (`parse`, `parseRecursive`) turns a malformed, encrypted or empty document into an answer carrying `tk:exception:container-exception` and a format no parser takes into an empty document named for the EmptyParser, as Tika does; timeouts, limits, aborts and parser faults still throw. Default `"throw"`.
- `getSupportedTypes` results are cached per `(parser, configGeneration)`.

## 8. Detector SPI

```ts
export interface Detector {
  detect(
    stream: RipstreamInputStream | null,
    metadata: Metadata,
    ctx: ParseContext
  ): Promise<MediaType>;
}

class CompositeDetector implements Detector {}   // first confident result wins; configurable "overrides"
class DefaultDetector implements Detector {}      // Name → Container → Magic → Text
class OverridingTypeDetector implements Detector {}
class NameDetector implements Detector {}
class MagicDetector implements Detector {}
class TextDetector implements Detector {}
class ContainerAwareDetector implements Detector {}
class ZipContainerDetector implements Detector {}
class Ole2ContainerDetector implements Detector {}
class XMLRootExtractor implements Detector {}
class CustomDetector implements Detector {}       // user-supplied predicate
```

Detection contract: `stream` may be `null` when only name/metadata is available. A detector that consumes bytes must rewind or leave a memoized prefix. `Metadata` input carries `resourceName` and `Content-Type`; `Content-Type` is treated as a hint, never trusted without `trustContentTypeHeader` config.

Full pipeline in `02-detection-metadata.md`.

## 9. Output handlers

All build on `WriteOutContentHandler`. Upstream behavior: default limit 100,000 chars; forward the prefix up to the limit, then throw `WriteLimitReachedException` by default; with `throwOnWriteLimitReached=false`, silently drop the remainder and flag the `ParseRecord`. We model that as `onLimit: 'throw' | 'truncate'`, defaulting to `'throw'` for upstream parity; the server may opt into `'truncate'`.

| Handler | Contract |
|---|---|
| `TextContentHandler` | **Raw character passthrough**, exactly upstream `ToTextContentHandler`: no element-to-whitespace mapping. The only element logic is suppressing characters inside `style`/`script` (qName-based depth). All newlines/tabs come from `XHTMLContentHandler`'s ENDLINE/INDENT behavior. Flushes on `endDocument`. |
| `XHTMLContentHandler` | Upstream port: XHTML namespace, lazy `html`/`head`/`body`, metadata head, ENDLINE/INDENT/AUTO/HEAD/TRIMMED_INLINE tag sets, held-whitespace logic for inline formatting, invalid-character replacement via `SafeContentHandler`. Upstream does **not** validate or auto-close mismatched nesting; do not add repair behavior beyond the upstream AUTO/head/frameset rules. |
| `ToXMLContentHandler` | Raw XML with declaration and configured encoding. No wrapper. |
| `ToHTMLContentHandler` | XHTML serialized as HTML5-ish (`<br>`, void elements); used by `/tika/html`. |
| `MarkdownContentHandler` | **Tika 4 default.** Streaming event stream → CommonMark/GFM: headings, emphasis, lists, tables, fenced code, blockquotes, links, images, page breaks as `\n---\n`. No DOM; incremental writer keeps a bounded stack of open blocks. |
| `JSONContentHandler` | Emits a JSON document with `content` plus metadata map; server wrapper adds `tk:content`. |
| `BodyContentHandler` | Captures body text only, with optional inner handler; upstream-compatible constructor semantics. |
| `LinkExtractor` | Collects `href`/`src`; exposes `links: string[]`. |
| `XHTMLBalancingHandler` | Repairs mismatched tags from sloppy parsers. |
| `XMPContentHandler` | XMP packet serialization for metadata-only output. |
| `TeeContentHandler` | Fan-out to N handlers; honors per-handler limits independently. |
| `AbstractRecursiveParserWrapperHandler` | Emits `ParseRecord` objects, not text; base for rmeta/JSONL. |

Streaming output contract:

```ts
ripstream.parseToStream(source, { handler: 'markdown' })
// ReadableStream<Uint8Array>, yields as parser emits; memory bounded by
// output high-water mark, not document size.
```

- `parseToStream` starts parsing lazily on first pull; `cancel()` aborts the parse.
- Errors surface as stream errors after any already-yielded bytes.
- `parseToString` is a convenience that collects with a hard limit; documented as non-streaming.

## 10. Recursive parsing / embedded documents

```ts
export interface ParseRecord {
  metadata: Metadata;
  content: string;                    // "tk:content"
  embeddedResourcePath: string;       // "/document.docx/word/media/image1.png"
  depth: number;
  mediaType: MediaType;
  exception: RipstreamError | null;
  children?: ParseRecord[];
}

export interface EmbeddedDocumentExtractor {
  shouldParseEmbedded(metadata: Metadata): boolean;
  parseEmbedded(
    stream: RipstreamInputStream,
    handler: ContentHandler,
    metadata: Metadata,
    ctx: ParseContext
  ): Promise<void>;
}

export interface EmbeddedDocumentBytesHandler {
  handle(
    bytes: ByteStream,
    metadata: Metadata,
    ctx: ParseContext
  ): Promise<void>;
}

export interface EmbeddedResourceHandler {   // images inside XHTML output
  handle(mediaType: MediaType, name: string, bytes: ByteStream, ctx: ParseContext): Promise<string>;
  // returns the URI written into src/href
}
```

Rules:

- `RecursiveParserWrapper` enforces depth, count, byte, and time limits before recursing.
- Embedded paths use `/` separators and include the container name and entry path; parity-tested.
- Default embedded strategy: parse text-bearing entries, extract metadata for media, optionally stream bytes to `EmbeddedDocumentBytesHandler`.
- Decompression bombs: stop at `maxDecompressionRatio` per entry and `maxTotalEmbeddedBytes` overall; emit `X-TIKA:EXCEPTION:LimitExceededError` on the record.

## 11. Facade

```ts
export class Ripstream {
  constructor(config?: RipstreamConfig | ResolvedConfig);

  detect(source: InputSource | null, opts?: DetectOptions): Promise<MediaType>;
  parse(source: InputSource, opts?: ParseOptions): Promise<{ metadata: Metadata; text: string }>;
  parseToString(source: InputSource, opts?: ParseOptions): Promise<string>;
  parseToStream(source: InputSource, opts?: ParseOptions): ReadableStream<Uint8Array>;
  parseToHandler(source: InputSource, handler: ContentHandler, ctx?: ParseContext): Promise<Metadata>;
  parseRecursive(source: InputSource, opts?: RecursiveParseOptions): Promise<ParseRecord[]>;
  getParser(): Parser;
  getDetector(): Detector;
  getMimeTypes(): MimeTypes;
}

export interface ParseOptions {
  filename?: string;
  contentType?: string;             // hint
  handler?: 'text' | 'html' | 'xhtml' | 'xml' | 'markdown' | 'json' | ContentHandler;
  limits?: Partial<ParseLimits>;
  password?: string | PasswordProvider;
  ocr?: Partial<OcrConfig>;
  pdf?: Partial<PdfConfig>;
  signal?: AbortSignal;
  embedded?: 'none' | 'text' | 'all';
}
```

## 12. Errors

```ts
export class RipstreamError extends Error {
  readonly code: string;            // stable machine code
  readonly mediaType?: MediaType;
  readonly cause?: unknown;
  readonly recoverable: boolean;
}
export class UnsupportedFormatError extends RipstreamError {}     // server 415
export class EncryptedDocumentError extends RipstreamError {}     // 422
export class MalformedDocumentError extends RipstreamError {}     // 422
export class WriteLimitReachedError extends RipstreamError {}     // partial content, 200
export class ParseTimeoutError extends RipstreamError {}          // 408
export class RequestTooLargeError extends RipstreamError {}       // 413
export class LimitExceededError extends RipstreamError {}         // 422
export class MissingDependencyError extends RipstreamError {}     // 500 at startup, not request
export class RandomAccessUnavailableError extends RipstreamError {}
export class ParserDeclinedError extends RipstreamError {}        // internal, never escapes facade
export class EmptyDocumentError extends RipstreamError {}
export class AbortError extends RipstreamError {}
```

Error policy:

- Parser-internal, per-embedded-document failures are recorded in that record's metadata and do not fail the top-level parse (upstream `RecursiveParserWrapper` behavior).
- Top-level parse failures throw. Server maps `code` → HTTP status.
- Never swallow an exception without recording it in `X-TIKA:EXCEPTION:*` or an emitted event.

## 13. Config and plugins

```ts
export interface RipstreamConfig {
  parsers?: ComponentConfig[];
  detectors?: ComponentConfig[];
  mimeTypes?: { path?: string; inline?: string };
  limits?: Partial<ParseLimits>;
  ocr?: OcrConfig;
  pdf?: PdfConfig;
  pipes?: PipesConfig;
  server?: ServerConfig;
  plugins?: { paths: string[]; enabled: boolean };
}

export interface ComponentConfig {
  id: string;                        // registry ID, e.g. "pdf-parser"
  class?: string;                    // dynamic import specifier
  params?: Record<string, unknown>;
  exclusions?: string[];
}

export class ConfigReader {
  static fromJson(input: string | object): ResolvedConfig;
  static fromXml(input: string): ResolvedConfig;      // 3.x compatibility
  static fromFile(path: string): Promise<ResolvedConfig>;
}
```

Lifecycle mirrors upstream:

```ts
interface Initializable { initialize(config: ResolvedComponentConfig): Promise<void> | void; }
interface SelfConfiguring { configure(params: Record<string, unknown>): void; }
```

- Config is immutable after `initialize`. `configGeneration` invalidates parser/type caches.
- Unknown component IDs fail fast unless `config.loadErrorHandler = 'ignore'`.
- Plugins are explicit dynamic imports; a plugin default-exports `{ parsers, detectors, fetchers, emitters, iterators, reporters }`. No code is loaded from the document being parsed.
- XML config supports upstream `<properties><parsers><parser class="..."><params>...` shape for migration; JSON is the native format.

## 14. Runtime abstraction

```ts
export interface Runtime {
  readonly kind: 'node' | 'bun' | 'deno' | 'browser' | 'worker';
  readonly supportsRandomAccessFiles: boolean;
  readonly supportsWorkers: boolean;

  createTempFile(prefix: string): Promise<TempFile>;
  createWorker(module: string, opts: WorkerOptions): Promise<WorkerHandle>;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  digest(algo: 'md5' | 'sha256', data: ByteStream): Promise<Uint8Array>;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
```

Browser runtime: no temp files (OPFS optional), no worker parser isolation for heavy native deps, no `fetch`-by-default in parsers. Unsupported operations throw `RandomAccessUnavailableError` or `UnsupportedRuntimeError` at call time, never at import time.

## 15. Observability

```ts
export interface RipstreamEvents {
  parseStart: { sourceName: string | null; mediaType: MediaType };
  parseEnd: { mediaType: MediaType; millis: number; embeddedCount: number };
  embeddedStart: { path: string; depth: number; mediaType: MediaType };
  embeddedEnd: { path: string; depth: number; millis: number; error?: RipstreamError };
  detect: { mediaType: MediaType; detector: string };
  warning: { code: string; message: string; context?: Record<string, unknown> };
  limit: { name: keyof ParseLimits; limit: number; actual: number };
}

export interface EventSink {
  emit<K extends keyof RipstreamEvents>(event: K, payload: RipstreamEvents[K]): void;
}
```

- Events are synchronous and must never throw; exceptions are swallowed and reported once.
- No logging by default. `ConsoleEventSink` is opt-in.
- Metrics counters exposed via `TikaStats` snapshot: documents, bytes, per-parser counts, limit hits, timeouts.

## 16. Public API stability

- `core` exports are semver-stable. Parser packages may add capabilities in minors.
- Deprecations carry `@deprecated` plus a removal major version.
- Generated registry files carry the upstream Tika version in a header and are excluded from hand edits.
- API surface checked by `@microsoft/api-extractor`; any report change requires an intentional update.
