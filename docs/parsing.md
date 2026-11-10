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
`isolation` ([isolation.md](isolation.md)) and `parsers`; any other Tika section is refused by name.

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
  other than the media type filters and `exclude`, a non-string `exclude` item, an `image/ocr-*` type.
- It is applied in this process. The CLI refuses `--config` with `parsers` unless isolation is off (`--isolation
  off`), because the isolation child cannot yet receive it (`tikajs-68os.8.7`).
- The semantics were read from Tika's source; they were not checked against a running Tika 4.2.0.

## Handlers

`BodyContentHandler`, `XHTMLContentHandler`, `MarkdownContentHandler`, `ToXMLContentHandler`,
`JsonContentHandler`, `TeeContentHandler`, `XmpContentHandler`.
