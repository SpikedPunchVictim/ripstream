# Migrating from Java Tika

| Java | ripstream |
|---|---|
| `new Ripstream()` | `createRipstream()` |
| `Ripstream.parseToString` | `ripstream.parseToString` |
| `BodyContentHandler` | same concept; text handlers are async |
| `ParseContext` | `ParseContext` (limits, signal, resource tracking) |
| `Detector`/`Parser` SPI | same shape, async `Promise` returns |
| `Metadata` | exact/case-sensitive keys, `get`/`getAll`/`add`/`set` |
| `RecursiveParserWrapper` | same, plus `serializeRmeta` |
| `WriteOutContentHandler` | same prefix-then-throw/truncate behavior |
| Tika server/CLI | `@spikedpunch/ripstream-cli` (`ripstream serve`) and `createRipstreamServer`; the endpoints follow tika-server 4.2.0 (see the parity matrix for what differs) |
| Pipes | `@spikedpunch/ripstream-pipes`; the engine's unit of work is tika-pipes' `FetchEmitTuple`, and Tika's pipes configuration loads (`tikajs-68os.6.2`, see Pipes configuration below) |

Differences: streaming is first-class (`AsyncIterable`, `ReadableStream`); optional dependencies
(pdf.js) are peer/optional; no runtime plugin XML loading (JSON config + registry).

## Metadata keys

ripstream writes Tika 4.x's key names. Tika 4.0 moved every key it asserts about a parse from `X-TIKA:` to the `tk:`
namespace, kebab-cased, and `resourceName` to `tk:resource-name` (tika-core's `metadata-migration-3x-4x.json` is the
table). There is no 3.x spelling and no switch: a client that reads `X-TIKA:content` reads `tk:content`.

| Tika 3.x | ripstream and Tika 4.x |
|---|---|
| `X-TIKA:content` | `tk:content` (with `tk:content-handler-type`, `TEXT` here) |
| `X-TIKA:parse_time_millis` | `tk:parse-time-millis` |
| `X-TIKA:embedded_depth`, `X-TIKA:embedded_resource_path` | `tk:embedded-depth`, `tk:embedded-resource-path` |
| `X-TIKA:EXCEPTION:*` | `tk:exception:container-exception`, `tk:exception:embedded-exception`, ... |
| `resourceName` | `tk:resource-name` |

The shape follows Tika's `/rmeta` too: one object per document, the container first; a key with one value is a string
and a key with several is an array. The container has no `tk:embedded-resource-path`; an embedded document's is below
the container (`/inner.txt`), with `tk:embedded-id` and `tk:embedded-id-path` (`/1/2`) and, once the whole file is read,
`tk:final-embedded-resource-path`. `tk:content` is present only when it is not blank. `tk:parsed-by` names the parser
that handled the document (ripstream's parser names, not Java class names) and `tk:parsed-by-full-set` on the
container lists every parser used. `Content-Length` is the size of the input once it has been read in full.

Not the same: the per-format keys a parser writes (`img:*`, `exif:*`, page counts) follow `tikajs-68os.10.5`; content is
plain text by default where Tika 4's default handler is Markdown (see *Content shapes and routes*); `tk:embedded-resource-type`,
`tk:internal-path` and `tk:embedded-relationship-id` are not written. A failure is noted as `Name: message`, where
Tika writes a stack trace. Read from Tika source and its saved responses, not checked against a live Tika.

## Digests

A `parse-context` digester factory makes the digests Tika makes, under Tika's keys (`tikajs-68os.9.1`). Before this a
configuration with `commons-digester-factory` or `bouncy-castle-digester-factory` did nothing, and no `tk:digest:*` key was
written.

```json
{ "parse-context": { "commons-digester-factory": {
    "digests": [ { "algorithm": "MD5" }, { "algorithm": "SHA256", "encoding": "BASE32" } ],
    "skipContainerDocumentDigest": false } } }
```

- **The settings are Tika's.** `algorithm` is `MD2`, `MD5`, `SHA1`, `SHA256`, `SHA384`, `SHA512` or, with
  `bouncy-castle-digester-factory` only, `SHA3_256`, `SHA3_384` or `SHA3_512`. `encoding` is `HEX` (the default), `BASE32` or
  `BASE64`, in the RFC 4648 padded form. A factory with no `digests` is MD5 in hex. A name is read in any case and an unknown
  setting is refused (Tika's mapper is set to do both), and the two factories together are refused, because a parse has
  one. The configuration fails with exit code 2 and says which setting.
  - *When SHA3 under the Commons factory is refused:* `CommonsDigester` has no SHA3 and throws
    (`UnsupportedOperationException`) on the first parse that builds it; ripstream refuses the configuration when it is
    loaded, and the message names `bouncy-castle-digester-factory`.
  - *Where Jackson is more lenient than this:* it reads the string `"true"` or the number `1` as a boolean, which
    `skipContainerDocumentDigest` refuses here, and it takes `"encoding": null` (which fails with a `NullPointerException` when Tika
    builds the digester), which is HEX here. A name is upper-cased to match, so a few non-ASCII letters that fold to ASCII
    (`ſha256`) are read as the name they fold to; nothing depends on it.
  - *Tika's example configurations are not accepted whole.* The ones that go with these settings
    (`tika-config-digests.json` and the others in `tika-parsers-standard-integration-tests`) also carry an
    `"auto-detect-parser": {"throwOnZeroBytes": false}` section. That section is not read (`CFG-014`; its deferred
    non-goal is `tikajs-68os.8.13`) and the configuration is refused for it: drop it, and keep `parse-context`. The tests here use
    the `parse-context` part of those files.
- **The key carries the algorithm and the encoding:** `tk:digest:MD5` for hex, `tk:digest:SHA-256:BASE32` for the others,
  the algorithm spelled as Java's `MessageDigest` spells it (`SHA-1`, `SHA3-512`).
- **Every document is digested, the container and each embedded one,** before its type is detected, over all of its bytes
  whatever the parser reads; `Content-Length` is set from that length only where nothing has set it. With
  `skipContainerDocumentDigest` the container (depth 0) is left alone and what is embedded in it is digested. This holds in
  the library, `ripstream -r`, `serve` (`/meta` and `/rmeta`), `pipes` in every mode and in an isolation child, which is handed
  the settings with the request; each has a test that runs it (`packages/cli/test/digest.test.ts`, `packages/pipes/test/modes.test.ts`,
  `packages/bundle-standard/test/standard-isolation.test.ts`). A plain `parse` returns the container's metadata and not
  an embedded document's, so it digests only the container (the embedded digest would be made and thrown away);
  `parseRecursive`, `-r`, `/rmeta` and the `RMETA` and `UNPACK` modes digest each document. A `PipesEngine` made from
  settings digests with the ripstream it builds from them; a `ripstream` passed in digests as it was built.
- **`pipes` `NO_PARSE` digests and detects.** Its metadata is `tk:resource-name` and `Content-Length` (what Tika's fetcher stage
  sets before anything runs, and so with no digester factory too), the digests, `Content-Type` and
  `tk:content-type-parser-override`, as Tika's `ParseHandler` makes it; with `skipContainerDocumentDigest` it has no digest.
- **Checked against Tika's own test.** `packages/bundle-standard/test/digest-tika.test.ts` runs Tika's
  `test_recursive_embedded.docx` (vendored unmodified, see `NOTICE`) through the configurations of Tika's `DigestConfigTest`
  and gets the digests that test hard-codes: MD2, MD5, SHA1, SHA256, SHA384, SHA512, SHA3-512 and SHA1 in BASE32.
- **MD2 is ripstream's own** (RFC 1319): OpenSSL 3, which Node uses, no longer has it. It runs at about 5 MiB/s where MD5
  runs at about 600 and SHA-256 at about 2,400 (measured on one machine), so a large document takes its time with MD2.
  A document is digested again at every level it is embedded at, so an archive nested 30 deep in 5 MB pieces costs MD2 about
  45 s and MD5 about 1 s (measured by the adversarial review of this work, one machine); `maxNodeDepth`, `maxEmbeddedBytes`
  and `maxParseMillis` bound it. The other algorithms are `node:crypto`'s, and SHA3 needs no BouncyCastle.
- **A digest is a metadata value like any other.** `maxMetadataValueChars` (1,000,000 by default; a digest is at most 128
  characters) cuts it to length if a caller sets that below the digest's, as Tika's `StandardMetadataLimiter` cuts a field longer than its
  `maxFieldSize`; the cut value is no longer the digest. Settings built by hand and given to `new Ripstream({ digest })` or
  `createRipstream({ digest })` are checked when it is made (an unknown algorithm or encoding is a `RangeError`).
- **In `pipes`, a digest that fails fails the document.** Tika's pipes server logs a digest I/O error and goes on to parse;
  here the failure is the document's, a failed parse like any other.

Not the same, and read from Tika's source (there is no Java here to run it and compare): Tika re-writes an embedded OLE2 or
`oleObject` document through POI (`MSEmbeddedStreamTranslator`) before it digests it, so the digest of such a document in
Tika is of other bytes than the ones ripstream has; ripstream digests the document it extracts. For an email in a PST Tika
digests nothing and writes no `Content-Length`: `PSTEmailStreamTranslator` claims the stream and writes no bytes, and
`DigestHelper` publishes only what a translator wrote (its own `DigestHelperTest` asserts the digest and the length are
absent). Ripstream gives that email the digest of the bytes it extracted, and a `Content-Length`, so it has a digest where
Tika's has none (`dig-embedded-translators` in `tasks/parity/audits/filters-inventory.json`). Tika's test asserts only that
an embedded document has a digest, not what it is. Tika's `DigestSink`, which digests an embedded stream as a parser writes it
to save a second read, is not built: the values are the same.

## Metadata filters

The `metadata-filters` section of a Tika configuration is read and run (`tikajs-68os.9.2`). Before this a configuration with
it was refused (`CFG-014`), and the library's one filter, `IncludeExcludeFilter`, matched globs and ignored case.

```json
{ "metadata-filters": [
    { "remove-by-mime-metadata-filter": { "mimes": ["image/png"] } },
    { "exclude-field-metadata-filter": { "exclude": ["X-TIKA:parse_time_millis"] } },
    "no-op-filter" ] }
```

- **An entry is a filter's name or an object with that one name as its key,** and the order is the order they run in, each on
  what the one before left. The filters are Tika's: `include-field-metadata-filter` (`include`), `exclude-field-metadata-filter`
  (`exclude`), `field-name-mapping-filter` (`mappings`, `excludeUnmapped`, true by default, so an unmapped key is dropped),
  `capture-group-metadata-filter` (`regex`, `sourceField`, `targetField`), `clear-by-attachment-type-metadata-filter`
  (`types`), `remove-by-mime-metadata-filter` (`mimes`), `date-normalizing-metadata-filter` (`defaultTimeZone`, UTC by default),
  `geo-point-metadata-filter` (`geoPointFieldName`), `legacy-key-migration-filter` (`direction`, V4_TO_V3 by default) and
  `no-op-filter`. Names are exact and field names are exact and case-sensitive, with no globs, as in Tika.
- **There is no default filter,** as in Tika's loader: no section, or an empty list, runs nothing, and a server, the CLI or
  `pipes` then answers as it did before.
- **A filter sees the list as it is written:** every document, the container first, with `tk:content` (the text, if it is not
  blank), `tk:embedded-depth`, the embedded paths and `tk:parsed-by-full-set` already in it, and may drop keys, change them,
  add them and take a document out of the list. Values are text to a filter; with typed metadata they are typed afterwards.
- **Where it runs, as Tika's `EmitHandler` picks the chain:** the `parse-context` section's `metadata-filters`, if it has any,
  replace the top-level ones; for `CONTENT_ONLY` the top-level chain is not consulted and only the content and the container
  exception are kept; otherwise it is the top-level chain.
  - *Library:* `rmetaObjects` and `serializeRmeta` take `metadataFilter`; `metadataFiltersOf(config)` gives the two chains of
    a configuration and `emitMetadataFilter(filters, contentOnly)` picks one. A parse is not filtered by itself: the filters run
    where the output is made, because the content, the depth and the handler are only keys of the list there.
  - *`pipes`:* every parse mode, on what is emitted (`NO_PARSE` and `UNPACK` as well). In `UNPACK` each embedded document's
    bytes stay with the document they came from, whatever a filter does to the ids or the list.
  - *CLI:* `ripstream --recursive` (JSON and JSONL) runs the top-level chain, and nothing else of the CLI does, as Tika's
    `TikaCLI` filters only the recursive JSON it writes.
  - *Server (`ripstream serve`):* `/rmeta`, `/meta` and `/meta/{field}` (a field a filter took out is 404), `/unpack` (its
    `rmeta.json`, and the manifest describes that file), `/tika/json` and `?handler=meta` and `?handler=json` run the
    configured chain; `/tika` and its text routes run the `parse-context` chain alone, so a configured chain never changes the
    text. `/pipes` and `/async` run the filters of their settings. `createRipstreamServer` takes them as `metadataFilters`.
- **A configuration is checked when it loads,** and every problem is reported at once: an unknown filter or setting, a setting of
  the wrong type (a number for a string, a string for the boolean), a missing required setting and what a filter itself refuses
  (an unknown attachment type, a zone that is not one, a `mimes` entry that could never match). Tika finds some of these on
  the first document, or never.
- **`charsoup-metadata-filter` detects the language of `tk:content`** with Tika's CharSoup model and writes
  `tk:detected-language`, `tk:detected-language-confidence` (`HIGH`, `MEDIUM`, `LOW` or `NONE`) and
  `tk:detected-language-confidence-raw` (the score, written as Java's `Double.toString` does: `0.8999999761581421`, and `0.0`
  for `NONE`), each replacing what the document had. A document with no `tk:content`, or an empty one, is left alone; one that
  is only whitespace is detected, and is `NONE`. Its one setting, `maxLength` (1 to 2147483647), is the number of characters
  read; Tika reads 100,000 unless told otherwise, and so does this. A `maxLength` below 1 is refused when the configuration
  loads: Tika accepts it and writes `NONE` for every document. Core has no detector, so a chain built from a configuration needs
  one handed in (`createMetadataFilter(entries, { languageIdentifier })`, `metadataFilterServices` on the pipes options and on
  `createRipstreamServer`); `ripstream --recursive`, `pipes` and `serve` hand in CharSoup, and a chain that names the filter
  without one fails when it is built, a server when it starts. A parse that runs no chain does not read the 6.7 MB model.
- **Three filters Tika has are refused by name:** `optimaize-metadata-filter`, `open-nlp-metadata-filter` and
  `tika-eval-metadata-filter` (proposed as non-goals in `tikajs-68os.24`).

Not the same, read from Tika's source (there is no Java here to run it and compare):

- A request cannot name filters of its own (the per-request JSON, `NG-5`).
- A filter that throws fails the input. Tika's emit logs a warning (`failed to filter metadata list`) and goes on with the list as the filter left it.
- A text route (`/tika`) answers 422 for a container that failed by the parse's own exception, not by what the filters left.
- `capture-group-metadata-filter` refuses a regex with no capture group when the config loads, where Tika accepts it and fails on
  the first document it matches; `(?i)` folds case by Unicode, where Java's is ASCII unless `(?u)`.
- `date-normalizing-metadata-filter` leaves a value that is not a date as it is without the warning Tika logs, and a region
  zone id (`America/Los_Angeles`) has the rules of the runtime's time zone data, not the JDK's.
- `legacy-key-migration-filter`'s `table` names a classpath resource in Tika; here only Tika's own default is accepted, and the
  library takes a table as `rows`.
- Enum values (`direction`) are exact-case and the types are strict (`NG-6`).
- The camelCase `metadataFilters` key is still refused, now as an unknown key; the name is `metadata-filters`. `IncludeExcludeFilter` and
  `IncludeExcludeOptions` are gone: `IncludeFieldMetadataFilter` and `ExcludeFieldMetadataFilter` match exact names.
- `clear-by-attachment-type-metadata-filter` matches on `tk:embedded-resource-type`, which no ripstream parser writes yet
  (`tikajs-68os.35`), so on ripstream's own output it clears nothing.
- Typed `/rmeta` output now types `tk:embedded-depth` as a number, as it types every other integer key (it was a string).

## Language detection

`@spikedpunch/ripstream-language` has Tika 4.2.0's detector, `CharSoupLanguageDetector`: Tika's own model
(`langdetect-20260320.bin`, 204 languages, 6,687,361 bytes, in the package's `data/`, Apache 2.0, in the package's `NOTICE`)
and Tika's pipeline (strip URLs and addresses, NFC, character n-grams of two to four letters, script counts, word bigrams,
confusable languages scored as a group). It is what the `charsoup-metadata-filter`, `PUT /language` and `ripstream language`
use. The model is read when a text is first detected, not when the package is loaded; the first call takes 5 ms, and a text of
100 characters 0.14 ms, of 100,000 characters 4.1 ms (one core, measured).

- `identify(text, { maxLength })` is Tika's `detect`: `language` as ISO 639-3 (or `be-x-old`, `cdo-x-rom`, `hak-x-rom`, as
  Tika's labels are), or `""`; `confidence` `HIGH` (raw score above 0.9), `MEDIUM` (above 0.7 and an entropy under 2 bits),
  `LOW` (above 0.5, or above 0.7 with an entropy of 2 bits or more) or `NONE`; `rawScore`, a 32-bit float. `detect(text)` is the `LanguageDetector` answer.
- `ripstream language` prints the ISO 639-3 code (`und` when there is none) and, with `--json`, `{ language, confidence,
  isReasonablyCertain }`, as before; `confidence` is now the raw score.
- `FrancLanguageDetector` and `Cld3LanguageDetector` stay exported for a caller who wants them; nothing in ripstream uses them.

Not the same, and not checked against Tika. There is no JDK here, and the probe of a running Tika was declined, so the answers
for the same text have never been compared with Tika's. What the port is checked against is Tika's own tests, ported: the 20
sentences of `LangIdRegressionTest` (each its language, with a raw score of at least 0.5), the URL and address stripping against
the regular expressions it replaced (on Tika's cases and 5,000 random ones), the feature extractor's n-grams, scripts and
hashing against an independent hash, and a mutation check of ten changes to the pipeline, none of which survives. Where it can differ:

- The letter, mark and script tables are Node's, Unicode 17 on Node 24; Java 17's are Unicode 13, and a Tika on a later JDK
  has that JDK's. A character assigned since can be a letter here and not there, which changes the features of a text that has
  it. The script of a character is the category the model's script features use (`ScriptCategory`), by Unicode script.
- Java's `float` is kept 32-bit with `Math.fround` where Java rounds. The weighted sums Tika keeps in a `long` are kept in a
  `Float64`, which holds them exactly: they stay far below 2^53.
- The raw score is written as Java's `Double.toString` of the `float`: the shortest digits that read back (JDK 19 and later).
  JDK 17 gives a few doubles one digit more; which scores that touches, if any, has not been checked (there is no JDK here).
- Script gating, which Tika's detector leaves a no-op (`applyScriptGate` returns its input), is left out, and so is the rest of
  the detector's API beyond `detect`: `detectAll`, `setPriors`, `hasEnoughText`, `getDistributionEntropy` and the
  charset-comparison helpers `compareLanguageSignal`, `topShortTextLanguages` and `junkRatio`, which only Tika's own
  `SjisLangSignalTest` calls from outside the detector.
- A `maxLength` below 1 is an error where Tika reads no characters and answers `NONE` (see the filter above).
- A short text is detected, and its answer is a guess: `Hello world` is `ita` (0.63, `LOW`), `plain text here` is `yor` (0.65,
  `LOW`) and `ok` is `diq` (0.78, `LOW`). That is the model's answer, and Tika's `/language` gives it; use `confidence` to
  tell a verdict from a guess.

## A document that cannot be read

Tika's server does not fail a request over one unreadable document, and neither does `createRipstreamServer`. For a
malformed, encrypted or empty document `/rmeta`, `/meta` and the JSON form of `/tika` answer 200 with
`tk:exception:container-exception` in the metadata; the text routes answer 422 with the text extracted before the
failure (and `X-Ripstream-Error`, which Tika lacks). A format no parser takes is an empty 200 (`tk:parsed-by` is
`EmptyParser`), as with Tika's fallback parser. Timeouts, limits, bad requests and a full queue are still errors.

The library keeps `parse` and `parseRecursive` throwing, so a caller never mistakes a failure for a result. Pass
`onDocumentFailure: "record"` to get Tika's behaviour: the failure is on the metadata and on `ParseResult.exception` /
`ParseRecord.exception`, and the call resolves. An empty input is refused with `ZeroByteFileError`, as Tika's
`ZeroByteFileException`. Read from Tika source and its saved responses, not checked against a live Tika.

## The output limit

Tika's server answers with the text up to its write limit and flags the document (`tk:exception:write-limit-reached` =
`true`); it does not fail the request. `createRipstreamServer` does the same at `maxOutputChars` (100,000 unless you
change it; Tika's server has no limit): the JSON routes carry the flag in the metadata, `/tika` text answers 200 with
`X-Ripstream-Write-Limit-Reached: true`. Any other limit, an embedded count for one, is still a 422. A configuration
file that sets `parse-context` `output-limits.throwOnWriteLimit: true` makes `serve` fail at the limit (422) instead, and
`createRipstreamServer({ onOutputLimit: "throw" })` does the same for a library caller.

The library keeps `parse` and `parseRecursive` throwing `LimitExceededError`. Pass `onOutputLimit: "truncate"` to get
Tika's behaviour; the text so far is the result and the flag is on the metadata. `parseToString`, `parseToHandler` and
`parseToStream` always throw. The limit is one total for the container and everything embedded in it, where Tika's
applies to each document. Read from Tika source and its saved responses, not checked against a live Tika.

## Command line

The ripstream CLI is its own interface (`parse`, `detect`, `metadata`, `language`, `serve`), not tika-app's, and it
takes no tika-app aliases. Several tika-app flags mean something else here (`-r` is recursive, `-h` is help), so
aliases would break one group of users. The nearest equivalents:

| tika-app | ripstream |
|---|---|
| `-t`, `--text` (the default) | `ripstream parse FILE` |
| `-m`, `--metadata` | `ripstream metadata FILE` |
| `-j`, `--json` | `-j`, `--json` |
| `-J`, `--jsonRecursive` | `-r`, `--recursive` |
| `--config=FILE` | `--config=FILE` or `-c FILE` |
| `-V`, `--version` | `-V`, `--version` |
| `-x`, `-h`, `-y`, `-T`, `-A`, `--md`, `-r` (pretty-print), `--encoding`, `--list-*`, `-v`, `-g` | none |
| pipes mode (`-i`, `-o`, `--fileList` ...) | `ripstream pipes --config=FILE`, the server's `/pipes` and `/async` routes (Tika's tuples, with `pipes.settings`), or the `PipesClient` API |

Output shapes are ripstream's, not tika-app's.

## Content shapes and routes

Tika writes a document's content through a handler it picks by name: `text`, `body`, `html`, `xml`, `markdown` or `ignore`
(`BasicContentHandlerFactory`; `txt` and `md` spell `text` and `markdown`, in any case). `parse` and `parseRecursive` take
`handlerType` for the same choice, `createOutputHandler(type)` gives the handler, and `tk:content-handler-type` names the
one that wrote each document's content (`TEXT`, `BODY`, `HTML`, `XML`, `MARKDOWN`; `IGNORE` writes no content, so no key).
A name Tika does not know is a 400 with Tika's message: `Unrecognized handler type 'x'. Valid types: text, txt, html, xml,
body, markdown, md, ignore`.

| Route | Answers |
|---|---|
| `PUT /tika` | the text of the body; `?handler=` or a preset's `handler` picks another shape (`meta` is the metadata alone) |
| `PUT /tika/text`, `/tika/html`, `/tika/xml`, `/tika/md` | the body's text; the XHTML with the metadata in its head; the same as XML; Markdown |
| `PUT /tika/json[/{handler}]` | one object: the metadata, `tk:content` (only when not blank) and `tk:content-handler-type` |
| `PUT /rmeta[/{handler}]` | one object per document, each with its content in that shape |
| `PUT /meta`, `PUT /meta/{field}` | the metadata, as JSON or, by `Accept: text/csv`, CSV; one field as JSON, CSV or plain text (404 when the document has none) |
| `POST /meta/form`, `POST /rmeta/form[/{handler}]` | the same, for a multipart form upload |
| `GET /`, `GET /tika` | a welcome page, and Tika's greeting, both naming ripstream |
| `GET /mime-types[/{type}/{subtype}]` | the media types: HTML by default, JSON or (the list) text by `Accept`; one type as HTML or JSON |
| `PUT /language`, `POST /language` | the language as its ISO 639-1 code, as `text/plain` with no newline (`en`); an empty answer when the text is blank. By `Accept: application/json`, the detector's whole answer (`{ language, confidence, isReasonablyCertain }`, with the ISO 639-3 code, the raw score as the confidence, and `und` for a blank text) |

A trailing slash names the same route; a path with a `.` or `..` segment is a 404 and one that starts with `//` a 400, and
the dots are not folded into another route. `HEAD` is the headers of a `GET` route's answer, `OPTIONS` is a 200 with
Tika's `Allow` list on any path, and `PUT /` is a 405. `/mime-types` comes from a registry the caller gives: `ripstream serve` passes the
standard one with the configuration's `custom-mimetypes` merged in, and `createRipstreamServer` answers 404 until it is
given `mimeTypes`. Tika's `mime` and `mime-types` endpoint names both enable it.

Not the same:

- `/tika` and `?handler=` default to text, where Tika's default is Markdown; `/tika/md` and `?handler=md` give Markdown.
  ripstream's Markdown is best effort (blocks, headings, lists, emphasis, links, tables), not Tika's byte for byte.
- `/tika/text` is the body's characters (Tika's `BODY`). `parse` with `handlerType: "text"` is also the body's, and
  `parseRecursive` with it writes every character of the container and the body of each embedded document. Tika's `TEXT`
  writes every character of every document; `html`, `xml` and `markdown` count every character the parsers write toward
  `maxOutputChars`, as Tika's do.
- `/meta` writes no content, as Tika's does (the `ignore` handler), so `maxOutputChars` cannot be reached there and the
  write-limit flag is never set. `/rmeta/ignore` and `/tika/json/ignore` are the same.
- `Accept: application/rdf+xml` on `/meta` is a 406: Tika answers with XMP through Adobe's XMPCore, which ripstream has
  no equivalent of.
- `/tika/preset/...` and `/tika/config/...` are not served: ripstream's presets are `?preset=`, and Tika answers 403 for
  per-request configuration unless it is switched on.
- A route writes one type, and an `Accept` that does not name it is a 406 with no body, before the document is read, as
  in Tika: `/tika` and `/tika/text` and `/tika/md` write `text/plain`, `/tika/html` `text/html`, `/tika/xml` `text/xml`,
  `/tika/json` and `/rmeta` `application/json`, `/detect` and `GET /version` and `GET /tika` `text/plain`. The older
  `{ "text", "metadata" }` object of `Accept: application/json` on `/tika` is gone: `?handler=json` still gives it, and
  `/tika/json` is Tika's shape. `Accept: application/json` on `/language` is ripstream's own, where Tika answers 406.
- `/unpack` answers Tika's data package, a zip of `datapackage.json`, `rmeta.json` (what `/rmeta` answers) and
  `unpacked/<id><extension>` for every embedded document, as `/unpack/all[/{handler}]` does with the request's own bytes
  added as `unpacked/0`; `POST` takes a multipart form, and the package is named after the file in it (or the
  `filename` of the request). It answered the `/rmeta` JSON before, so a client that read records from it reads
  `rmeta.json` now. It takes `Accept: application/zip` (`*/*`) only, and a raw `POST` is a 415. A document that cannot
  be opened is a 422 with the failure as the body; one inside it that cannot be read stays in `rmeta.json`. The bytes
  kept are held to `maxUnpackBytes` (100 MiB; a document past it is not in the zip). Differences from Tika: the
  extension of a text or HTML document is its type's (`.txt`, `.html`) where Tika's, finding a charset in the
  `Content-Type`, is `.bin` (`tikajs-68os.29`); an entry named `../x` or `/x` in a zip is skipped by the archive
  parser, not unpacked under its id; a truncated zip is not salvaged; `/unpack/preset/{name}` and the config routes
  are not served; the response is not gzipped.
- A response of text, JSON or XML of 32 bytes or more is gzipped for a client that sends `Accept-Encoding: gzip`
  (`Content-Encoding`, `Vary: Accept-Encoding`), as Tika's is; a request body sent with `Content-Encoding: gzip` is
  inflated before it is read, and what it inflates to is held to the body limit (413 past it, 400 for bytes that are
  not gzip). Other encodings are not decoded.
- `POST` is accepted on `/tika`, `/rmeta`, `/meta` and `/detect` with a raw body, where Tika answers 405 there (it takes
  `POST` on `/rmeta/form`, `/meta/form`, `/unpack` and `/language`).
- `/language` detects with Tika's own CharSoup model, as Tika's does, ported (see below), and gives the answer Tika's `toIso1`
  gives: the two-letter code, or the three-letter one for a language that has none (`ceb`, `yue`). A short text gets the
  detector's best guess however low its confidence, as Tika's does: `Bonjour` is `fr` (raw score 0.75, `LOW`), where
  ripstream before this answered with franc, and said nothing below 10 characters.
- `/pipes` runs a batch and answers `200` when the run finished, with `count`, `stats` (`byStatus` counts every input by
  Tika's result status) and `failures`: the inputs whose status is not in Tika's SUCCESS category, up to 1000, with
  `failuresOmitted` for the rest. A document that cannot be read is not a failure there, as in Tika: it is emitted with
  its exception (`EMIT_SUCCESS_PARSE_EXCEPTION`) or, with `onParseException: "SKIP"`, left out (`PARSE_EXCEPTION_NO_EMIT`).
  Tika's endpoint takes one `FetchEmitTuple` and answers its status: ripstream's does too, when the server is given
  `pipes.settings` and the body has no `source` (`tikajs-68os.6.5`, see Pipes configuration below).
- The statuses ripstream's pipes engine produces are `EMIT_SUCCESS`, `EMIT_SUCCESS_PARSE_EXCEPTION`,
  `PARSE_EXCEPTION_NO_EMIT`, `EMPTY_OUTPUT`, `FETCH_EXCEPTION`, `EMIT_EXCEPTION`, `FETCHER_NOT_FOUND`,
  `EMITTER_NOT_FOUND`, `TIMEOUT`, `UNSPECIFIED_CRASH`, `CLIENT_UNAVAILABLE_WITHIN_MS` and `PAYLOAD_LIMIT_EXCEEDED`. The last is the nearest status for a document over a
  limit (Tika's is a frame too large to send to its forked client), and a child that ran out of memory is reported as
  that too: `OOM` is in the table but never produced.
- `?handler=` on a route that names its handler in the path (`/tika/text`, `/tika/json`) is a 400.

Read from Tika source and its saved responses, not checked against a live Tika.

## Pipes configuration

The engine takes `FetchEmitTuple`s (`{ id, fetcher, fetchKey, emitter?, emitKey?, onParseException? }`, plain data) from an
iterator and reads each one's bytes inside the worker that takes it, through fetchers and emitters registered by id.
Reading in the worker is what lets a fetcher that waits on a network run concurrently: at 20 ms per fetch and 16 workers the
measured rate was 653 files/s against 43 files/s when the iterator read the bytes itself, and the queue holds tuples
instead of every file's bytes (`tasks/parity/audits/pipes-model-spike.md`).

```ts
import { loadConfig } from "@spikedpunch/ripstream-core";
import { createEngineFromSettings } from "@spikedpunch/ripstream-pipes";

const engine = createEngineFromSettings(loadConfig(tikaJson).pipes!); // throws if the configuration has no pipes sections
await engine.run();
```

- **Tika's sections load.** `fetchers` and `emitters` are `{ id: { type: settings } }`, `pipes-iterator` and
  `pipes-reporters` are `{ type: settings }`, and `pipes` takes `parseMode` (RMETA when absent, as Tika's),
  `onParseException` (EMIT), `numClients` (the number of inputs parsed at once) and `queueSize`. Component ids are
  `[A-Za-z0-9._-]+` and an id that starts with `__` is kept for the engine. What ripstream has: `file-system-fetcher`
  (`basePath`, `allowAbsolutePaths`), `http-fetcher`, `file-system-emitter` (`basePath`, `allowAbsolutePaths`,
  `fileExtension`, `onExists`, `atomicWrites`, `compression`, `prettyPrint`),
  `file-system-pipes-iterator` (`basePath`, `fetcherId`, `emitterId`) and `file-system-jsonl-reporter` (`path`,
  `includes` or `excludes`, `onExists`, `maxMessageLength`).
- **Accepted, and `loadConfig(...).notices` says each changes nothing:** `plugin-roots`, the JVM process settings
  (`forkedJvmArgs`, `javaPath`, `useSharedServer`, `socketTimeoutMillis`, `startupTimeoutMillis`,
  `heartbeatIntervalMillis`), the emit batching (`emitStrategy` EMIT_ALL or DYNAMIC, `emitWithinMillis`, `numEmitters`,
  `emitMaxEstimatedBytes`, `emitIntermediateResults` false), `countTotal` and `extractFileSystemMetadata` false. Ripstream's
  components are built in and there is no forked JVM, so nothing they set could change what is emitted.
- **Refused by name, with why:** a component type ripstream lacks (the cloud, database and search ones are tracked in
  `tikajs-68os.6.6`), `emitStrategy` PASSBACK_ALL, `emitIntermediateResults` true, `extractFileSystemMetadata` true,
  `maxFilesProcessedPerProcess`, `configStore*`, any `http-fetcher` setting, and every key ripstream does not know. `content-handler-factory` and `auto-detect-parser` change
  output, so a configuration that has them is refused too (`CFG-014`); `metadata-filters` is read (see Metadata filters). Every issue is reported at once and nothing loads.
- **Tika's `file-system-fetcher` confinement holds.** A key that leaves `basePath`, one with a NUL byte, and (with
  `confineSymlinks`, the default) a symbolic link that resolves outside `basePath` are refused.
- **Tika's `file-system-emitter` is Tika's** (`tikajs-68os.6.3`). The output is `basePath/emitKey` with the directories
  made, so a run over a tree writes a tree (a key that leaves `basePath` is refused, `path traversal?!`). `onExists` is
  `EXCEPTION` by default: a file that is already there is a result for that input, `EMIT_EXCEPTION`, and the file is left as
  it was, so running into the same output twice does not overwrite it; `SKIP` leaves it and `REPLACE` overwrites it. A
  write goes to `<file>.<uuid>.tmp` beside it and is published in one step (`atomicWrites`, default true), so a reader never
  sees half a file. `compression: "GZIP"` adds `.gz`, `fileExtension` adds `.<ext>`, `prettyPrint` writes Jackson's layout.
  What is written follows the mode: RMETA, CONCATENATE and NO_PARSE a JSON list, CONTENT_ONLY the raw content, and the bytes
  of an UNPACK file as they are, with neither extension nor compression.
- **The parse modes are Tika's, per input** (`tikajs-68os.6.3`). RMETA emits the document and what is embedded in it.
  CONCATENATE emits one document per input, its content the text of all of it (it used to join the whole run into one
  `concatenated` document; join the output files if that is what you want). CONTENT_ONLY is the same for an emitter that
  writes only the content. NO_PARSE detects the type and emits that (`Content-Type` and `tk:content-type-parser-override`, with
  `tk:resource-name` and `Content-Length`) and, when a digester factory is configured, the digests (see *Digests*), with no
  content and no copy of the input (it used to copy the bytes). UNPACK is described in the next item.
- **S3, Elasticsearch and OpenSearch components, with no cloud or search SDK** (`tikajs-68os.6.6`). The Tika settings
  `s3-fetcher`, `s3-emitter`, `s3-pipes-iterator`, `es-emitter` and `opensearch-emitter` are read and run. S3 is SigV4 over
  `fetch` and `node:crypto` (the signer reproduces the three examples AWS publishes), Elasticsearch and OpenSearch are the
  `_bulk` requests of Tika's own plain-HTTP clients. Nothing here ran against AWS, an S3-compatible service, Elasticsearch
  or OpenSearch: the requests are checked against fakes that recompute the S3 signature from what arrived and record the
  `_bulk` bodies, which are the ones the Java source writes.
  - **S3.** `region`, `bucket`, `credentialsProvider`, `endpointConfigurationService` (MinIO and the like),
    `pathStyleAccessEnabled` and the component's own `prefix`, `maxLength`, `fileExtension`, `fileNamePattern` are applied.
    `credentialsProvider` is `key_secret`, `profile` (the `~/.aws/credentials` and `config` files, `AWS_SHARED_CREDENTIALS_FILE`
    and `AWS_CONFIG_FILE`) or `instance` (IMDSv2, refreshed five minutes before expiry); a profile that needs `role_arn`,
    `sso` or `credential_process` is refused by name. Where Tika's output is odd, so is ripstream's: the fetcher puts its
    `prefix` in front of the key with no slash, the emitter joins its own with `/`, and the emitter appends `fileExtension`
    (`json` unless set, blank for none) to bytes as well, so UNPACK's `REGULAR` output is `<emitKey>-embed/<id>.json`; the
    iterator lists whole keys, so a fetcher prefix and an iterator prefix double (`in/in/x`). Not applied:
    `extractUserMetadata` (default true in Tika) adds no `s3:*` fields, since ripstream's fetchers return bytes only;
    `throttleSeconds` is refused, give the run `--retry-attempts` (an S3 error carries its status, so 5xx and 429 are retried
    and 403 and 404 are not); `spoolToTemp`, `maxConnections` and `countTotal` change nothing and the configuration says so.
  - **Elasticsearch and OpenSearch.** `esUrl`/`openSearchUrl` is the index's URL; `/_bulk` is added. `updateStrategy`
    `OVERWRITE` is an `index` action and `UPSERT` an `update` with `doc_as_upsert` and `retry_on_conflict: 3`; Tika's missing
    `updateStrategy` is `UPSERT`, so that is the default. `attachmentStrategy` `PARENT_CHILD` routes by the container's key and
    writes `relation_type`, `SEPARATE_DOCUMENTS` writes `parent`, and without one an embedded document has no link to its
    container (Tika's). An embedded document's id is `<emitKey>-<uuid>`, drawn anew each time, so an emit that is retried
    after a partial failure indexes those documents again. Basic authentication and, for Elasticsearch, `apiKey` (sent as
    `Authorization: ApiKey`, and winning over a user name) are applied. `socketTimeoutMillis` bounds a whole request. Refused
    by name: `chunkStrategy: DOCUMENTS` (ripstream produces no `tk:chunks` to split), a proxy, `verifySsl: false` (trust the
    server's CA with `NODE_EXTRA_CA_CERTS`) and any `authScheme` but basic. These emitters index metadata: the bytes of an
    unpacked file and `CONTENT_ONLY` are errors. A whole request that is rejected (429, 5xx) is retried; `errors: true` in a
    200 answer is an error with the answer and is not.
  - **Not built, and tracked or declared.** GCS (`tikajs-68os.31`) and Azure Blob (`tikajs-68os.32`) are the same shape as
    S3 and are next; Solr over `solrUrls` is `tikajs-68os.33` and the Elasticsearch and OpenSearch reporters
    `tikajs-68os.34`. The JDBC emitter, iterator and reporter are a proposed non-goal, awaiting the owner: Node has no
    generic JDBC, so each database is its own client dependency. Kafka and the other connector components were already
    proposed non-goals (`tikajs-68os.24`). A configuration that names one of these is refused with what ripstream has.
- **UNPACK emits Tika's Frictionless package by default** (`tikajs-68os.6.7`). One zip per input at
  `<emitKey>-frictionless.zip` (not at the emit key, and with no `fileExtension` or compression added): `datapackage.json`,
  `rmeta.json` and `unpacked/<id>`, the package `PUT /unpack` answers, built by the same code. It replaces the metadata
  document at `<emitKey>`: the metadata list is `rmeta.json`. An input with nothing embedded still gets a package. Before
  this, UNPACK wrote the RMETA list at the emit key and each embedded document at `<emitKey>-embed/<id>`; that is
  `outputFormat: "REGULAR"`, and what the shorthand config (`source`/`sink`) still does. Tika's `UnpackConfig` is given as
  a `parse-context` component, `unpack-config`, and ripstream reads twelve of its settings: `outputFormat`
  (`FRICTIONLESS`/`REGULAR`), `outputMode` (`ZIPPED`/`DIRECTORY`; `DIRECTORY` emits the package's files one by one under
  `packageRoot`), `suffixStrategy` (`NONE` default, `EXISTING`, `DETECTED`), `zeroPadName`, `embeddedIdPrefix`,
  `keyBaseStrategy`, `emitKeyBase`, `includeOriginal`, `includeMetadata`, `packageRoot`, `packageName` and
  `maxUnpackBytes`. `emitter`, `zipEmbeddedFiles`, `emptyPackage` and the two deprecated metadata flags are refused by name,
  and so is `maxUnpackBytes: -1`. `unpackBytes` is still ripstream's 100 MiB where Tika's is 10 GiB; a document past it is in
  `rmeta.json` and has no file. The package is built in memory. `DETECTED` takes a file's extension from the media type
  registry, `.bin` for a type without one. `ripstream pipes`, `/pipes` and `/async` use the registry the server does, custom
  media types included (`custom-mimetypes`).
- **A run can be stopped and started again, and a transient failure tried again** (`tikajs-68os.6.4`). Both are engine
  options, off unless given: `ripstream pipes --checkpoint FILE --retry-attempts N` and `createEngineFromSettings(settings,
  { checkpoint, retry })` pass them; the server's `/pipes` and `/async` do not (`/pipes` builds an engine for each
  request, so there is nothing to resume, and `/async` builds its engine without them).
  - `checkpoint: await CheckpointStore.open("run.checkpoint")` leaves out of a run the inputs an earlier run finished
    (not fetched, parsed or emitted; `stats.resumed` counts them), however that run ended: an error, a signal, `kill -9`. An
    input is recorded once it succeeded (a SUCCESS result: emitted, or a parse exception that was skipped on purpose) and its
    result was reported, so one that failed is done again by the next run. The file is a journal, one JSON string a line,
    appended as inputs finish: 0.06 ms an id whether there are a thousand or a hundred thousand, and a kill leaves at worst a
    cut last line, which is dropped on the next open. A file the earlier array format wrote is refused by name; delete it,
    which only means the first run after the upgrade does everything again.
  - **A run that is killed between emitting a document and recording it emits that input again.** Point it at an emitter that
    takes a second write: a file-system emitter with `onExists` `REPLACE` or `SKIP`. With Tika's default, `EXCEPTION`, that
    one input is `EMIT_EXCEPTION` on the resumed run (its first file is left whole) and is tried again by the next. Reporters
    hear an input again too: a repeat, never a gap.
  - `retry: { attempts, baseDelayMs, maxDelayMs, retryIf }` tries a fetch or an emit again, with a doubling wait (half to
    all of it, so workers do not come back together) that an abort ends at once. Only failures that may not happen again
    are tried again, `isTransientError`: a reset, refused or timed-out connection, a name server that did not answer, a busy
    file, an HTTP 408, 425, 429, 500, 502, 503 or 504 (`HttpFetcher` now throws `HttpStatusError`, same message, with
    `status`). A missing file, a path that is not allowed, a file that is there and an SSRF refusal are not. `retryIf` says
    otherwise. Each document of an input is emitted on its own try; a document of a `source` has no fetch to try again.
- **`ripstream pipes --config=FILE` runs the sections** (`tikajs-68os.6.5`). The `pipes-iterator` lists the tuples, the
  fetchers read them, each document is parsed and the emitters write it, and the reporters hear every result. A failed
  input does not stop the run: up to 100 are named on stderr (the reporters have all of them) and the exit code is 3 when
  there was one, 2 for a configuration without the pipes sections or a checkpoint file that cannot be used, 0 otherwise.
  `-j` or `-o json` prints the run's counts as one JSON line. Isolation is off unless `--isolation` is given, as for
  `parse`; `serve` is the command that defaults to strict. With `--checkpoint` and an emitter whose `onExists` is `EXCEPTION`
  (Tika's default) the command warns that a resumed run fails the one input that was emitted just before the kill.
- **`POST /pipes` and `POST /async` take Tika's tuples** (`tikajs-68os.6.5`), when the server is built with
  `pipes: { settings, authenticate, ... }` (`loadConfig(...).pipes`). Tika's form of each is off otherwise, and
  `authenticate` is required (see `docs/security.md`). The old raw-document `/async` job is still not behind that gate. `ripstream serve` does not turn them on: there is no flag for authentication, only
  code, and an unauthenticated `/pipes` reads and writes through the operator's fetchers and emitters. The batch shape
  (`{ source, sink, ... }`, under `sourceRoot`) still works beside it: a `/pipes` body with a `source` is a batch, one without
  is a tuple, and a `/async` body that is a JSON object with a `tuples` key is Tika's while any other body is still a
  document for the old job (`202 {id}`).
  - `/pipes` takes one tuple and answers when it is done: `{ status, message? }` with Tika's HTTP status for it. `200` is
    every success category (a parse exception that was recorded is one), `400` is a fetcher, emitter or preset that is not
    there, `413` a document over a limit, `429` with `Retry-After: 60` a full client pool, `500` a fetch or emit that failed
    or any other result, and `503` with `Retry-After: 5` a timeout or a crash. The settings'
    reporters are not run for it: the answer is the report.
  - `/async` takes `{ "tuples": [...] }`, checks all of them (a fetcher or emitter that is not configured is a 400, as
    Tika's `can't find fetcher for X`), and queues them for a background run that reports to the settings' reporters and
    writes to their emitters: `200 {status: "ok", added}`. The queue is `pipes.queueSize` (10 000, Tika's); when it stays
    full the request is answered `429 {status: "throttled", message, capacity}` with a `Retry-After`, and a batch bigger
    than the queue is a 400. `server.close()` finishes every tuple that was accepted before it returns.
  - **Where ripstream differs from Tika:** the wait for room in the `/async` queue is 5 s by default (`asyncMaxWaitMs`; Tika's
    is 60 s, which would meet the server's own 60 s `requestTimeoutMs`); a tuple that carries `parseContext`, `preset`,
    `metadata` or a byte range is a 400 that names it, because ripstream does not act on them and a client may not choose
    parser settings; an id that starts with `__` is a 400, as Tika's `rejectReservedComponentIds`; `PASSBACK_ALL` is not
    offered (Tika refuses it on `/pipes` as well; a library user collects results with a reporter or a `MemoryEmitter`).
- **The `{ mode, concurrency, source, sink }` config still works** as a shorthand over the same engine (`createEngine`,
  `PipesClient`). Its `sink` is `FlatFileEmitter`, the layout it always had (one flat directory, `.txt` or `.bin`, a later
  write to a name overwrites): its ids are CSV rows and URLs, not paths. `FileSystemEmitter` is now Tika's, with an options
  object (`new FileSystemEmitter({ basePath, ... })`) in place of a directory. Its `followSymlinks: true` still reads through a link that leaves the root, which is
  `confineSymlinks: false`; a non-regular file in the tree (a FIFO) is now a `FETCH_EXCEPTION` for that input instead of
  being passed over, as in Tika.

Library changes (breaking): `Fetcher` is now `fetch(key, { signal }) -> bytes`, registered by id. The old iterator of
documents is `DocumentSource` and is given as the engine option `source` (the engine bridges it with an `__inline` fetcher);
`PipesEngineOptions.fetcher` is gone in favour of `iterator` or `source`, `fetchers` and `emitters`. `CsvFetcher` and
`JsonFetcher` are `CsvSource` and `JsonSource`. `ModuleFetcher` loads the module's `createFetcher` once and gives it keys.
`Reporter.report(result, tuple?)` is given the tuple. `JsonlReporter` takes `{ onExists, maxMessageLength }` and prepares
its file when it is made.
