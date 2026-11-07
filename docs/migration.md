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
| Tika server/CLI | optional `@spikedpunch/ripstream-cli`; server not yet ported |
| Pipes | not yet ported |

Differences: streaming is first-class (`AsyncIterable`, `ReadableStream`); optional dependencies
(pdf.js) are peer/optional; no runtime plugin XML loading (JSON config + registry).
