# ripstream

TypeScript port of Apache Tika: detect, parse and extract text/metadata from documents, library-first.

```sh
pnpm add @spikedpunch/ripstream-parsers @spikedpunch/ripstream-core
```

```ts
import { createRipstream } from "@spikedpunch/ripstream-parsers";

const ripstream = createRipstream();
const result = await ripstream.parse(bytes, { filename: "report.docx" });
console.log(result.metadata.get("Content-Type"), result.text);
```

## Packages

| Package | Purpose |
|---|---|
| `@spikedpunch/ripstream-core` | Contracts, handlers, metadata, streaming, security utilities |
| `@spikedpunch/ripstream-mime` | Generated MIME registry, magic detection, containers, encodings |
| `@spikedpunch/ripstream-parsers` | Default parser registry and text/web/mail parsers |
| `@spikedpunch/ripstream-parser-office` | OOXML, ODF, EPUB, RTF, OLE2, legacy DOC/XLS/PPT/MSG |
| `@spikedpunch/ripstream-parser-archive` | ZIP, TAR, GZIP, BZIP2, Brotli, XZ, LZ4, Snappy, .Z, plist |
| `@spikedpunch/ripstream-parser-pdf` | pdf.js parser in an isolated worker |
| `@spikedpunch/ripstream-parser-media` | Images, audio, MP4 metadata |
| `@spikedpunch/ripstream-language` | franc language detection |
| `@spikedpunch/ripstream-cli` | `ripstream` command |
| `@spikedpunch/ripstream-parity`, `@spikedpunch/ripstream-test-corpus` | Tika differential harness and corpus |

## Safety defaults

SSRF-blocking URL fetch, archive traversal/symlink rejection, compression ratio and size caps,
output/time/embedded limits, 0600 temp files, worker isolation, secret redaction. See
[docs/security.md](docs/security.md).

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm test:collect   # CBD coverage map
pnpm corpus:pdf -- /path/to/pdfs   # external PDF corpus run
pnpm corpus:scan -- /path/to/files # detection + all-parser run
```

Requires Node >= 22.18. Recent external corpus results and known gaps are in
[docs/corpus-validation.md](docs/corpus-validation.md).
