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
| pipes mode (`-i`, `-o`, `--fileList` ...) | the server's `/pipes` route or the `PipesClient` API |

Output shapes are ripstream's, not tika-app's.
