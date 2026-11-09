# External corpus validation

Date: 2026-11-05

This run exercised detection and parsing against real, malformed, adversarial,
and conformance PDF corpora plus a mixed-format preservation corpus. Corpus
files are untrusted input: they were fetched into `/tmp/ripstream-corpora`, read
only, and never executed, previewed, or opened in a viewer.

Nothing from these corpora is vendored into the repository. Every source is
external and fetched separately; each has its own license.

## Sources

| Source | Revision | Files used | Why |
|---|---|---|---|
| [mozilla/pdf.js test/pdfs](https://github.com/mozilla/pdf.js/tree/master/test/pdfs) | `1c3fdc2` | 1,077 PDFs | Malformed, fuzzed, encrypted, adversarial PDFs |
| [veraPDF-corpus](https://github.com/veraPDF/veraPDF-corpus) | `bb75f4f` | 2,906 PDFs | PDF/A conformance structure |
| [bfosupport/pdfa-testsuite](https://github.com/bfosupport/pdfa-testsuite) | `c22d802` | 33 PDFs | PDF/A pass/fail cases |
| [iText 7 crypto tests](https://github.com/itext/itext7/tree/develop/kernel/src/test/resources/com/itextpdf/kernel/crypto) | `068ecc6` | 145 PDFs | Encrypted and certificate-protected PDFs |
| [dwillis/nicar25-pdfs](https://github.com/dwillis/nicar25-pdfs) | `148b543` | 8 PDFs | "Worst PDFs on the planet" |
| [openpreserve/format-corpus](https://github.com/openpreserve/format-corpus) | `366f068` | 64 PDFs + 249 mixed files | GovDocs1 error PDFs, JHOVE errors, ebooks, office, archives |
| [pdf-association/pdf-corpora](https://github.com/pdf-association/pdf-corpora) | index | reference | Index used to select the sources above |

The PDF Association index also lists SafeDocs, GovDocs1, and Common Crawl.
Those were not downloaded: they are terabyte-scale, registration-gated, or
known to contain malicious files. The sampled sources above already include
GovDocs1 error files and pdf.js/poppler fuzz cases.

## Harnesses

Both scripts are read-only corpus runners. They record one JSON object per
file, including detection result, status, error class, timing, and text size.

```bash
# PDF-specific pipeline
pnpm corpus:pdf -- /path/to/pdfs --timeout 30000 --concurrency 4 \
  --out artifacts/corpus/results.jsonl \
  --summary artifacts/corpus/summary.json

# Full default Tika pipeline (detection + all parsers)
pnpm corpus:scan -- /path/to/corpus --timeout 30000 --concurrency 4 \
  --out artifacts/corpus/scan.jsonl \
  --summary artifacts/corpus/scan-summary.json
```

`corpus:pdf` reports timeouts as `ParseTimeoutError`; `corpus:scan` also
applies the default 100,000-character output limit, so long documents report
`LimitExceededError` rather than producing unbounded output.

## Results

### PDF

| Corpus | Tested | Success | Encrypted (expected) | Timeout | Malformed |
|---|---:|---:|---:|---:|---:|
| pdf.js | 1,077 | 1,053 | 14 | 3 | 7 |
| veraPDF | 2,906 | 2,906 | 0 | 0 | 0 |
| BFO PDF/A | 33 | 33 | 0 | 0 | 0 |
| iText crypto | 145 | 16 | 95 | 0 | 34 |
| NICAR worst PDFs | 8 | 8 | 0 | 0 | 0 |
| format-corpus GovDocs1/JHOVE/ebooks | 104 | 99 | 3 | 0 | 2 |
| **Total** | **4,273** | **4,115** | **112** | **3** | **43** |

- All 4,273 files were detected as `application/pdf`; no detection
  regressions appeared.
- The 112 encrypted documents produced `EncryptedDocumentError`, the expected
  behavior without a password provider.
- The 34 iText crypto failures are certificate-encrypted fixtures. A sample of
  six was checked against Tika 4.2/PDFBox; Tika also failed them.
- One JHOVE failure (`mattgib_1.pdf`) is a zero-byte placeholder in the
  repository; the other is a 213-byte corrupt PDF.
- PDF.js throughput improved from 825 s to 335 s total (p50 303 ms to 151 ms)
  after the fixes below.

### Mixed formats

`format-corpus` scan, 249 checked-out files:

- 139 parsed successfully, including PDF, ZIP, Markdown, PNG, XML, RTF,
  EPUB, FictionBook, DOCX, JPEG, and ARJ.
- 76 `UnsupportedFormatError`: mostly empty path-trial files, plus
  MOBI/AZW3/LIT/LRF/SNB ebooks, Ruby, shell/INI/log text subtypes, and
  AppleDouble.
- 30 `LimitExceededError`: expected default 100,000-character output cap on
  large ZIP/PDF documents.
- 3 `EncryptedDocumentError` and 1 `MalformedDocumentError`.
- Zero crashes, zero hangs, and zero unbounded allocations.

> **Historical.** The PDF worker thread and its memory watchdog described in this run were removed
> (`tikajs-zgg2.7`). Untrusted PDFs are now contained by process isolation (see
> [isolation.md](isolation.md)), and the figures below describe the run that preceded the removal.

## Fixes made from this run

1. **Removed per-page `getOperatorList()` image counting.** It was not an
   upstream metadata field and hung on several malformed pages. This fixed
   five pdf.js files that previously timed out.
2. **Read small PDFs in memory instead of through the range transport.**
   pdf.js's range loader is stricter with broken xref offsets. The worker now
   uses `data` up to 8 MiB and range above it. This fixed the sole veraPDF
   timeout, improved malformed recovery in the sampled 12-file set from 0 to 6
   successes, and cut p50 parse time.
3. **Skip individual page failures instead of failing the document.**
   `page-error` messages now keep pages that parsed, matching PDFBox's
   per-page recovery on files such as `Pages-tree-refs.pdf`.
4. **Added `PdfParserOptions.pageTimeoutMs` (default 30 s).** A worker that
   stalls now raises `ParseTimeoutError` and is terminated instead of hanging
   the caller indefinitely.

## Residual gaps

- Pathological extraction (`tikajs-wh3x`). Re-verified in Docker (node:24-slim,
  `--network none`, 1 GiB, repo read-only): `bomb_giant.pdf` and
  `issue_cmap12.pdf` fail with `LimitExceededError` from the 256 MiB worker
  memory watchdog in 0.2 s and 0.6 s; `bug1980958.pdf` (object number 2^31-1)
  and `issue19800.pdf` (form XObject cycle) fail with `MalformedDocumentError`
  from the preflight in under 0.1 s. No container kill and no timeouts occur
  anywhere in the 1,077-file pdf.js run (slowest file 2.6 s). The 30 s
  `pageTimeoutMs` default is kept: it is now only a backstop for hangs the
  preflight and watchdog do not recognise, and legitimate large pages on slow
  hardware take several seconds, so a lower default would risk false
  timeouts; callers who want less can set `pageTimeoutMs`. Residual gap versus
  PDFBox: PDFBox returns text for these four files, while this parser rejects
  them by design. `issue_cmap12.pdf` is not recoverable under a cap (worker
  memory grows past 420 MiB at a 384 MiB budget and past 900 MiB at 768 MiB),
  and the preflight only sees uncompressed objects, so the same patterns inside
  object streams are bounded only by the watchdog and timeout. The watchdog
  counts `external_memory`, which also includes lazily committed buffers, so
  `issue3928.pdf` (a font with a bogus multi-terabyte `/Length1`; text extracted
  before) is now rejected with `LimitExceededError`.
- Recovery (`tikajs-v284`). A fallback in `pdf-recover.ts` runs only when
  pdf.js reports `Invalid Root reference` or `Invalid PDF structure`: it
  appends a synthetic trailer pointing at the last uncompressed `/Type
  /Catalog` object and re-emits Flate object-stream members as plain objects
  (16 MiB inflate cap, skipped for encrypted files). This recovers
  `bug1978317` and `issue22370` (lost xref stream, catalog and page tree in
  object streams). Remaining per-file causes, all needing a real repair
  engine or filter support:
  - `Brotli-Prototype-FileA`: PDF 2.0 `/Filter /BrotliDecode` on every stream
    including the xref and object streams; pdf.js has no Brotli filter.
  - `bug1020226`: 184-byte truncated file with no catalog object at all.
  - `REDHAT-1531897-0`: 871-byte fuzzed file with stale xref offsets and no
    catalog object.
  - `poppler-395-0-fuzzed`: catalog present, but the page tree object is
    missing (object 3 is defined twice, object 2 never).
  - `issue_cmap12`: not a structure problem; see the memory note above.
  Docker re-run of all 1,077 pdf.js files (2 GiB, `--network none`, no
  container kills, no timeouts): 1,054 successes against a 1,051 baseline; the
  new successes are `bug1978317`, `issue22370`, `freeculture` and `pdkids`.
  The only file that succeeded at baseline and fails now is `issue3928` (the
  watchdog case above). The form-cycle preflight was narrowed to cycles the
  content actually paints, which restored `bug1020858` (it lists itself in
  resources but never draws itself). The 24 pdfCabinetOfHorrors PDFs: 23 parse,
  `encryption_openpassword` raises `EncryptedDocumentError` as expected.
- Unregistered `text/*` subtypes (`text/x-log`, `text/x-ini`, `text/x-sh`,
  `text/x-ruby`) report `UnsupportedFormatError`. Tracked in `tikajs-4fxb`.
- MOBI, AZW3, LIT, LRF, PDB, SNB, RB, DBTextWorks, and AppleDouble remain
  unsupported or metadata-only; these are documented format gaps rather than
  regressions.
