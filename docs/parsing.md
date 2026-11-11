# Parsing guide

## Detect

```ts
const mediaType = await ripstream.detect(bytes, { filename: "a.pdf" });
```

## Parse

```ts
const { text, metadata } = await ripstream.parse(bytes, { filename: "a.docx" });
```

## Stream

```ts
for await (const chunk of ripstream.parseToStream(bytes)) {
  process.stdout.write(chunk);
}
```
Cancelling the reader aborts the parse.

## Recursive metadata

```ts
const records = await ripstream.parseRecursive(bytes);
const json = serializeRmeta(records, { typedMetadata: true });
```

## Limits and cancellation

```ts
await ripstream.parse(bytes, {
  signal: controller.signal,
  limits: { maxOutputChars: 50_000, maxParseMillis: 10_000 },
});
```

## Configuration

`loadConfig(json)` validates a RipstreamConfig shape and exposes a generation counter for caches. It reads `version`,
`isolation` ([isolation.md](isolation.md)), `parsers`, `detectors`, `parse-context`, `custom-mimetypes` and `server`; any
other Tika section is refused by name.

### The `parsers` section

```ts
const config = loadConfig({
  parsers: [{ "default-parser": { exclude: ["pdf-parser"] } }],
});
const ripstream = createRipstream({ config });
```

The shape and meaning are Tika's (`AbstractSpiComponentLoader`, `ParserLoader`, tika-serialization 4.2.0):

- No section, or `[]`: every default parser.
- `"default-parser"` (or `{ "default-parser": { "exclude": [...] } }`): every parser Tika loads by default, less the
  excluded names and less any parser also listed by name.
- A named entry (`"pdf-parser"`, `{ "ooxml-parser": { "_mime-include": [...] } }`) loads exactly that parser.
- With no `default-parser`, only the named entries load.
- `_mime-include` / `_mime-exclude` narrow what a parser, or the whole default set, may take.
- `pdf-parser` also takes `sortByPosition` and `extractAnnotationText`, the properties of Tika's `PDFParserConfig`
  that ripstream has an option for (`{ "pdf-parser": { "sortByPosition": false } }`). Each is `true` or `false`.

Names are Tika's component names (`pdf-parser`), not Java class names.

How it differs from Tika, because ripstream's parsers are not Tika's parsers:

- It is applied to **media types**. A Tika parser stands for the types it claims; a ripstream parser keeps the types
  some enabled Tika parser claims and is dropped when none is left. Excluding `jpeg-parser` takes `image/jpeg` away
  from `ImageParser` and leaves it `image/gif`. A type no Tika parser claims (`application/json`) follows
  `default-parser`.
- Only parsers the standard Tika 4.2.0 server loads, and that claim types of their own, can be named. An extended or
  opt-in parser (`grib-parser`) cannot, and naming a Tika parser ripstream has no counterpart for (`bpg-parser`) is
  an error. Excluding either is fine: it is already not loaded.
- Refused where Tika is silent: an entry with more than one key (Tika uses the first and drops the rest), a setting
  other than the media type filters, `exclude` and the two `pdf-parser` properties (every other `PDFParserConfig`
  property, and every setting of another parser, names no ripstream option), a `pdf-parser` setting that is not `true`
  or `false` (Tika's loader would coerce `"false"` or `1`), a non-string `exclude` item, an `image/ocr-*` type.
- `sortByPosition` defaults to `true` in ripstream's PDF parser and to `false` in Tika's `PDFParserConfig`: a
  configuration that names the setting gets what it names, and one that does not gets ripstream's default.
- It is applied by `createRipstream({ config })` and by the CLI. With isolation on, `createStandardIsolation({ ripstreamConfig })`
  builds the child's parsers from it (the child gets the section in the header of each request), and narrows the
  parsers that stay in this process by it too: the section switches parsers off, it never adds one, so the in-process set
  stays as restricted as it was (`tikajs-68os.8.7`).
- The semantics were read from Tika's source; they were not checked against a running Tika 4.2.0.

### The `detectors` section

```ts
const config = loadConfig({
  detectors: [{ "default-detector": { exclude: ["poifs-container-detector"] } }],
});
const ripstream = createRipstream({ config });
```

The same shape as `parsers` (`DetectorLoader`, tika-serialization 4.2.0), with Tika's detector names:

| Name | What it detects |
| --- | --- |
| `mime-types` | file name and magic bytes, XML root element, text versus binary |
| `default-zip-container-detector` | ZIP packages (OOXML, ODF, EPUB, ...) by their entries, and compressed streams by signature |
| `poifs-container-detector` | OLE2 Office files (`.doc`, `.xls`, `.ppt`, ...) |
| `misc-ole-detector` | OLE2 Hangul, Quattro Pro and Corel files |
| `bp-list-detector` | binary property lists |
| `gzip-specialization-detector` | gzip that holds a WARC |
| `matroska-detector`, `ogg-detector` | Matroska/WebM and Ogg streams |
| `no-op-detector` | nothing: it never answers |

Each detector answers in turn, and an answer replaces the running one only when it is a more specific type
(Tika's `CompositeDetector`). Without `default-detector` only the named detectors run:
`["default-zip-container-detector"]` detects zip packages and answers `application/octet-stream` for a text file,
because `mime-types` is not on. `mime-types` is always part of `default-detector` and cannot be excluded.

How it differs from Tika:

- Naming a detector ripstream has no counterpart for (`magika-detector`, `siegfried-detector`, `raw-tiff-detector`,
  `empty-detector`, `file-command-detector`, `magic-detector`, `pkcs-7-detector`) is an error. Excluding one is fine:
  it is already not loaded.
- A detector takes no settings and no `_mime-include` / `_mime-exclude`; Tika drops those on a named detector without
  a word, so ripstream refuses them.
- Like `parsers`, it is applied by `createRipstream({ config })` and by the CLI, and with isolation on the routing
  detector, `detect()` and the child's detector are all built from it, so they agree on a document's type
  (`tikajs-68os.8.7`). `ripstream detect` never isolates, so it applies the section whatever the isolation settings are.
- Read from Tika's source, not checked against a running Tika 4.2.0.

### The `parse-context` section

```ts
const config = loadConfig({
  "parse-context": {
    "embedded-limits": { maxDepth: 5, throwOnMaxDepth: true, maxCount: 100, throwOnMaxCount: true },
    "output-limits": { writeLimit: 200000, throwOnWriteLimit: true },
    "timeout-limits": { totalTaskTimeoutMillis: 30000, throwOnDeadline: true },
  },
});
const ripstream = createRipstream({ config }); // these are the defaults of every parse
```

Tika's `parse-context` carries the limits of a parse in three blocks (`EmbeddedLimits`, `OutputLimits`,
`TimeoutLimits`, tika-core 4.2.0). Ripstream applies the keys whose limit means the same here, and `config.limits`
holds what they set. A limit a call names itself (`parse(..., { limits })`) wins over the configuration's.

| Tika key | Ripstream limit | Boundary |
| --- | --- | --- |
| `embedded-limits.maxDepth` | `maxNodeDepth` | a document nested deeper than N is refused (the container is depth 0) |
| `embedded-limits.maxCount` | `maxEmbeddedResources` | N embedded documents are parsed, the N+1st is refused |
| `output-limits.writeLimit` | `maxOutputChars` | total characters across the container and what it embeds; `-1` is unlimited |
| `timeout-limits.totalTaskTimeoutMillis` | `maxParseMillis` | wall-clock time of the whole parse |

How it differs from Tika:

- **What happens at the limit.** Tika's default is to stop quietly and set a flag (`throwOnMaxDepth`, `throwOnMaxCount`,
  `throwOnWriteLimit` and `throwOnDeadline` are false by default). Ripstream fails the parse with a `LimitExceededError`
  (CLI exit 3, HTTP 422), which is what Tika does with the flag true. So a limit is accepted only beside its flag set to
  `true`, and `loadConfig` refuses `"maxCount": 1000` alone, saying what to set. Accepting it would turn Tika's truncated
  result into a failure without a word. A flag with no limit beside it is accepted: `false` is Tika's default and
  `true` is ripstream's behaviour. `writeLimit: -1` sets no limit and needs no flag.
- **No unlimited depth or count.** `maxDepth: -1` and `maxCount: -1` are refused: ripstream always bounds them.
- **Keys with no counterpart are refused by name**, with the reason: `maxXmlDepth` (ripstream has no limit on XML
  element nesting among its parse limits), `maxPackageEntryDepth` (deprecated in Tika), `zipBombThreshold` and
  `zipBombRatio` (Tika compares output characters with input bytes once a character threshold is passed; ripstream's
  `maxDecompressionRatio` compares decompressed with compressed bytes per archive entry, which is another check) and
  `progressTimeoutMillis` (no stall detector). A block other than the three, an unknown setting, and a value that is
  not an integer in range are refused too; Tika's loader would coerce a string or a fraction.
- **The defaults are ripstream's, not Tika's.** A limit the section does not set keeps ripstream's default (for
  instance 10000 embedded documents where Tika has none, and 100000 output characters where Tika has none).
- **Where it applies.** `createRipstream({ config })` and the CLI's `parse`, `metadata` and `serve`, in this process or
  with isolation on. In `serve`, `writeLimit` and `maxCount` are the limits of a request that names none (and of `/async`,
  which cannot name any): a request's own `maxOutputChars` or `maxEmbeddedResources` wins, and the server's ceiling
  (`--max-output-chars`, `RIPSTREAM_MAX_OUTPUT_CHARS`) wins over both. A `writeLimit` above the ceiling, or `-1`, is a
  usage error: it would be clamped without a word.
- **With isolation on** the limits are the defaults of every isolated parse (`createStandardIsolation({ ripstreamConfig,
  limits })`; a limit a call names wins). `maxDepth`, `maxCount` and `writeLimit` cross to the child as the request's
  `maxNodeDepth`, `maxEmbeddedResources` and `maxOutputChars`. `totalTaskTimeoutMillis` becomes the child's parse
  timer, and the isolation refuses one above what it allows a task: its `maxTaskMillis` less the margin the parent keeps
  (2 s, or a tenth of it when that is less), so a `totalTaskTimeoutMillis` of 9500 under a `maxTaskMillis` of 10000 is
  a usage error that names `maxTaskMillis`. `writeLimit: -1` (unlimited) is refused too: a child's memory is sized from
  the output cap. With isolation off neither applies.
- The CLI flags `--maxEmbeddedDepth` and `--maxEmbeddedCount` (tika-app's names) set `maxNodeDepth` and
  `maxEmbeddedResources` for one `parse` or `metadata`, and win over the configuration. They fail the parse at the
  limit, like the section.
- Read from Tika's source, not checked against a running Tika 4.2.0.

### The `server` section

```json
{
  "server": {
    "port": 9998,
    "host": "*",
    "endpoints": ["detect", "tika", "status"],
    "maxRequestSizeBytes": 104857600,
    "requestLogLevel": "info"
  }
}
```

`ripstream serve --config file.json` reads Tika's `server` section (`TikaServerConfig`, tika-server 4.2.0). Applied:

| Key | Effect |
| --- | --- |
| `port`, `host` | Where to listen (default 9998 and `127.0.0.1`; Tika's default host is `localhost`). `*` is every interface. `--port`/`-p` and `--host`/`-h` win over the file. |
| `endpoints` | Exactly the endpoints served, by Tika's names: `tika rmeta meta unpack detect language mime-types version status async` (`mime` is Tika's other name for `mime-types` and is taken as it). Naming one does not add it to a default. An empty list is the default. `/health` is always served. `/status/<job>` belongs to `async`. A disabled endpoint answers 404. |
| `cors` | `Access-Control-Allow-Origin` (`createRipstreamServer({ corsOrigin })`). |
| `maxRequestSizeBytes` | The request body limit (413 over it). Default 100 MiB, where Tika's is 1 GiB. Positive: ripstream always bounds a body, where Tika lets a negative value lift the limit. A body up to 16 MiB over the limit is read and thrown away, so the 413 comes on a connection that carries the next request; a body announced as larger than that is refused unread, with `Connection: close`. |
| `maxUnpackBytes` | Ripstream's own, not a Tika key, so Tika's loader refuses a file that has it. The most embedded-document bytes `/unpack` keeps for one request (default 100 MiB, at most 2 GiB, and with isolation at most `unpackCeiling`, see [isolation.md](isolation.md)). Whole bytes, 0 or more. A value over either bound stops `serve` with exit 2. |
| `requestLogLevel` | `debug` or `info`: each request's method and URI go to stderr. The server's own info lines (the concurrency gate) are shown with them. |
| `maxRequestReadMillis` | How long receiving a whole request may take (408 after); negative: no deadline; not zero. Node's `requestTimeout`. |
| `idleTimeoutMillis` | Closes a connection with no bytes moving for this long. A request whose body is in and whose response has not begun is waiting on its parse and is not closed (as in Jetty's idle timeout). |

Without `endpoints`, `serve` answers Tika's default set less what ripstream lacks (`tika rmeta meta unpack detect language
mime-types version`): **`/status` and `/async` are off unless listed**, as in Tika. The programmatic `createRipstreamServer` serves every
endpoint unless `endpoints` is passed.

Refused, naming the setting and the reason: `maxQueuePauseMillis` (ripstream answers 503 at once when its queue is full),
`maxResponseWriteMillis`, `maxInFlightRequestBytes` (requests are bounded by number, not bytes in flight), `id`, `tlsConfig`
(terminate TLS in front), `metricsPort`, and, when `true`, `allowPipes` (`/pipes` needs an `authenticate` function and path
roots that only code can give), `allowPerRequestConfig` and `allowHttp2`; `false` is accepted, as it is what ripstream does.
An endpoint Tika has and ripstream does not serve (`detectors`, `parsers`, `pipes`) and any other name are
refused in `endpoints`, as Tika refuses an unrecognized one. An unknown setting is refused with the list of the applied ones.

The CLI's flags follow Tika's for `serve`: `-h <host>` and `-p <port>`. Everywhere else `-h` is help and `-p` the password;
`-?` and `--help` print help in every command. Only `serve` reads the section; `createRipstream` and the other commands
ignore it.

### Environment references

In the `--config` file a string value may name an environment variable as `${env:NAME}`, alone or inside a longer string, in
every section, as Tika 4.2.0 does when it loads its configuration (`EnvInterpolator`). Only that form, with an ASCII name, is
replaced: `${NAME}`, `$NAME`, `${env:}` and keys stay as written. It is one pass: a value that holds `${env:OTHER}` is not
expanded again. There is no escape. A variable that is not set stops the command with exit 2 and a message that names the
variable and the JSON path, never a value; one set to an empty string counts as set. The value is always a string, so a numeric
setting such as `server.port` cannot be set from a variable.

`loadConfig(source, { env })` does the same for a library caller. Without `env` nothing is replaced: the library never reads
`process.env` itself. Load only a configuration the operator wrote this way: a reference reads the server's environment, and
a request is never interpolated. Read from Tika source, not run against a Tika.

Read from Tika's source, not checked against a running Tika 4.2.0.

### The `custom-mimetypes` key

```ts
const config = loadConfig({ "custom-mimetypes": "config/custom-mimetypes.xml" });
const ripstream = createRipstream({ config });
```

Tika adds media types at startup from a file named by the system property `tika.custom-mimetypes`
(`MimeTypesFactory`, tika-core 4.2.0), read after its own `tika-mimetypes.xml`. Ripstream reads the same file in the
same format, so a file written for Tika works unchanged. The path is relative to the working directory, as Tika's is.

```xml
<mime-info>
  <mime-type type="application/x-acme-report">
    <_comment>Acme report</_comment>
    <alias type="application/x-acme"/>
    <sub-class-of type="application/xml"/>
    <glob pattern="*.acme"/>
    <glob pattern="report-\d{4}\.rpt" isregex="true"/>
    <root-XML localName="acme-report" namespaceURI="urn:acme"/>
    <magic priority="60"><match value="ACMERPT" type="string" offset="0"/></magic>
  </mime-type>
</mime-info>
```

- **Merged, not replaced.** A type the registry already has (named directly or by an alias) gains the file's globs,
  aliases, root elements and magic, and takes its `sub-class-of` and comment; any other type is added.
- **A glob two types claim.** The more general type keeps it when one is a specialization of the other; two unrelated
  types are a conflict and the file is refused (`Conflicting extension pattern: .pdf`), as Tika refuses it. That rule
  applies to the patterns the file names; Tika's own registry keeps the order it always had.
- **`isregex="true"`** is a Java regular expression that must match the whole file name. It is run as a JavaScript one,
  so Java-only syntax (a possessive quantifier, `\p{Alpha}`) can fail to compile, which is refused, or mean something
  else in JavaScript, which is not detected. A pattern runs against caller-supplied file names, so keep it free of
  nested quantifiers.
- **Stricter than Tika.** Tika ignores a misspelled element, a `<glob>` without a `pattern`, and an unknown attribute
  value, and a `<match>` of an unknown `type` fails only the first time a document is detected. Ripstream refuses each by
  name, with the line, all of them in one error. The descriptive elements of Tika's own file (`_comment`, `comment`,
  `acronym`, `expanded-acronym`, `tika:link`, `tika:uti`) are read and have no effect.
- **A missing file** is a configuration error naming the path (Tika: `Specified custom mimetypes file not found`).
- **Where it applies.** `createRipstream({ config })` and the CLI's `detect`, `parse`, `metadata` and `serve`. With
  isolation on the parent reads the file once and the text crosses in the request header to the child, which never
  reads the path; the routing detector, `detect()` and the in-process parsers use the same text. The header leaves
  16 KiB for the `parsers` and `detectors` sections and this text together, and a larger file is refused when the
  isolation starts.
- In code: `new DefaultDetector({ customMimeTypes: xmlText })` or `createRipstream({ customMimeTypes })` take the text
  directly, and `DefaultDetectorOptions.custom` takes definitions as objects.
- Read from Tika's source, not checked against a running Tika 4.2.0.

## Handlers

`BodyContentHandler`, `XHTMLContentHandler`, `MarkdownContentHandler`, `ToXMLContentHandler`,
`JsonContentHandler`, `TeeContentHandler`, `XmpContentHandler`.
