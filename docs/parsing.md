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

`loadConfig(json)` validates a RipstreamConfig shape and exposes a generation counter for caches.

## Handlers

`BodyContentHandler`, `XHTMLContentHandler`, `MarkdownContentHandler`, `ToXMLContentHandler`,
`JsonContentHandler`, `TeeContentHandler`, `XmpContentHandler`.
