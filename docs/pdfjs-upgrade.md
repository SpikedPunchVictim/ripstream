# pdfjs-dist upgrade evaluation

Status: **evaluated 2026-11-19, upgrade deferred** (bead `tikajs-0io5`). Written so a later decision does not have to repeat the measurements.

`parser-pdf` and `cli` declare `pdfjs-dist` as an optional peer dependency, `^4.10.38`. The question: what do 5.4.x and 6.x buy, and what do they cost? Everything below was measured on a scratch copy of the repository at `8d0a61e`; nothing was changed in the repository. The per-file results are in [data/pdfjs-upgrade-per-file.tsv](data/pdfjs-upgrade-per-file.tsv) (483 unique files, 4.10.38 against 5.4.624 against 6.5.438: text length, status, exception, repaired flag, milliseconds, text-diff class, Tika token comparison).

## Why it was looked at

`bug1978317.pdf` (a pdf.js regression fixture, 1.5 MB) does not open in pdf.js 4.10.38 (`Invalid Root reference`). Its xref stream stores the index of an object inside an object stream in a 2-byte field, and the object stream has 65,542 members, so six entries (the catalog among them) were written modulo 65,536. pdf.js 4.10.38 reads the wrong member as the catalog. Ripstream's repair (rebuilt xref, synthetic trailer, objstm inlined) opens it, and PDFBox (Tika 4.2.0) opens it unrepaired. pdf.js **5.4.54 and later** fix it; 5.0.375, 5.2.133 and 5.3.93 do not. See `tikajs-ig49`.

## Verdict

- **Not an efficiency win.** Neutral on big text-heavy files, slower on typical files, faster only on `bug1978317`.
- **5.4.x if ever; not 6.x yet.** 5.4.624 changes the text of 4 of 483 files; 6.5.438 changes about 50.
- **One silent regression class.** pdf.js 5.x passes `setTextMatrix` a `Float32Array`; without a change our glyph-gap word spacing stops applying and no unit test notices.
- Reasons to upgrade anyway: it removes the repair for the damaged-xref class, and 4.x is an old line.

## Source changes the upgrade needs

| File | Change | Lines | 5.4.624 | 6.5.438 |
|---|---|---|---|---|
| `packages/parser-pdf/src/block-canvas.ts` | `DOMMatrix` stub class and `installDomMatrixStub()`: 5.x does `new DOMMatrix()` at module top level, so the import throws "DOMMatrix is not defined" | +25 | yes | yes |
| `packages/parser-pdf/src/pdf-session.ts` | call `installDomMatrixStub()` after `blockPdfjsCanvas()` | +2 | yes | yes |
| `packages/parser-pdf/src/pdf-glyph-gaps.ts` | the `setTextMatrix` operand is `[Float32Array(6)]` | +3/-1 | yes | yes |
| `packages/parser-pdf/src/pdfjs-import.ts` | filter `console.warn` as well as `console.log` (5.x warns through it) | +10 | yes | yes |
| `packages/parser-pdf/src/pdf-session.ts` | `getAttachments()` returns a Map and the content comes from `getAttachmentContent`; `getPermissions()` returns a Set | ~12 | no | yes |
| `packages/parser-pdf/src/pdf.ts` | Info `Custom` is a Map | ~2 | no | yes |
| `packages/parser-pdf/test/pdf-struct-walk.test.ts` | `destroy()` is gone from `PDFDocumentProxy` | 1 | no | yes |
| `package.json` of `parser-pdf` and `cli` | the optional peer range `^4.10.38` | | yes | yes |

Still working unchanged in both: the `OPS` names, `fontExtraProperties`, `maxImageSize: 1`, the `getTextContent` item shape, the fake worker and the private `page._renderPageChunk` hook. `isEvalSupported: false` is ignored in 6.x. The legacy build still exists.

**Check before any bump:** the `setTextMatrix` change fails silently (the glyph-gap code gives up inside the `try` in `#spaced` and falls back to pdf.js spacing). The unit tests passed; it was found only by diffing word spacing over the corpus. Add a word-spacing fixture that fails when the interpreter does not run (the repro `packages/parsers/test/fixtures/repros/pdf-glyph-gaps.json` pins spacing, so check that it is not satisfied by the fallback).

## Output (483 unique files: 354 corpus PDFs plus 129 damaged variants)

| | 5.4.624 | 6.5.438 |
|---|---|---|
| Identical text | 479 | 433 |
| Word spacing only | 3 | 24 |
| Line structure only | 1 | 20 |
| Content changes | 0 | 6 |
| Against Tika (bag-of-token F1) | 1 closer, 1 farther of the 4 changed | 19 closer, 5 farther of the 50 changed |
| Newly failing files | 0 | 0 |

14 corpus files fail identically in all three versions (status and exception message unchanged). In 6.x `hasEOL` is attached to the last item of a line, not to a separate empty item. `tk:pdf:repaired` goes from 34 to 33 files on the corpus (only `bug1978317` stops needing repair) and stays at 59 on the damaged variants.

Test suites on the scratch copies: parser-pdf 213 pass on 4.10.38, 212 pass and 1 fail on both candidates (the test "a repaired file with no text that cannot be shown text-less fails": the message changed from "1 page could not be read" to "page 1 content could not be decoded", a wording change). `fixtures.test.ts` has the same one failure on all three (`sqlite3-tika`, a `.db` missing from a `git archive`).

## Efficiency

Measured in Docker (`--network none -m 4g --cpus 1`), alternating versions, a fresh process each, 3 rounds, on a **shared host at load average 7 to 54**. Single-round spread was often 20% or more and some runs were 2 to 3x outliers. Treat a ratio within about ±15% as noise. Medians:

| Test | 4.10.38 | 5.4.624 | ratio | 6.5.438 | ratio | Read |
|---|---|---|---|---|---|---|
| 9.4 MB text-heavy, in process | 8754 ms | 8131 | 0.93 | 9448 | 1.08 | noise |
| 23 MB text-heavy, in process | 22187 | 24206 | 1.09 | 27972 | 1.26 | noise to slightly slower |
| 9.4 MB, isolated child | 12853 | 12128 | 0.94 | 12698 | 0.99 | noise |
| 23 MB, isolated child | 23014 | 30495 | 1.33 | 35180 | 1.53 | probably slower, high load |
| `bug1978317.pdf` | 5065 | 4267 | 0.84 | 5583 | 1.10 | 5.4.624 faster (no repair) |
| `freeculture.pdf` | 2969 | 4910 | 1.65 | 4281 | 1.44 | real: every round slower |
| tiny PDF, first parse | 146.6 | 190.5 | 1.30 | 304.9 | 2.08 | 6.x slower in all rounds |

The 354-file corpus, sequential, 3 rounds: sum of per-file medians 42.2 s (4.10.38), 51.1 s (5.4.624, x1.21), 55.0 s (6.5.438, x1.30). Excluding `bug1978317`: 33.7, 46.6 (x1.39), 49.6 s (x1.47). Median per-file ratio over the 313 files above 5 ms: x1.33 and x1.48; 54 files more than 10% faster and 214 more than 10% slower on 5.4.624. The ten biggest movers for each version are in the TSV.

**The one result that does not depend on load: `getAnnotations`.** It is 48 times slower on `freeculture.pdf` (18 ms to 865 ms on 5.4.624, 733 ms on 6.5.438) and 5.6 times slower on `bug1978317.pdf` (174 to 977 ms). pdf.js 5.x extracts the text under annotations that overlay text (highlight, underline, squiggly, strikeout and link types) through a new `Intersector`; 4.10.38 has no `overlaysTextContent`. Ripstream calls `getAnnotations` for every page and needs only link data. No pdf.js option skips the extraction.

**Memory** (median of 3, MB): text-heavy files are within ±5% (10 MB file, isolated child cgroup 447 / 438 / 419). `bug1978317.pdf` heap rises from 181 to 297 (5.4.624) and 307 (6.5.438), x1.6 to x1.7, and `freeculture.pdf` RSS from 326 to 371 and 380. Nothing here justifies changing `perChildMb` or `overshootMb`.

**Phase split.** The profile of the 10 MB text-heavy file is unchanged by the upgrade: `pdf.worker.mjs` about 53%, our `pdf-glyph-gaps.js` 15 to 19% (`show` alone 9 to 14%: 876 ms self on 4.10.38, 1137 ms on 5.4.624, 1987 ms on 6.5.438), native and GC about 15%. pdf.js has **no new option** that returns glyph positions without a second `getOperatorList` pass, so the second pass stays. The next efficiency target is our own interpreter (`tikajs-yzet`), not the pdf.js version. The phase split of the first test ran at load 22 to 54 and is not a trustworthy ratio.

**Not measured:** a large tagged PDF (the corpus's two tagged files are 1 page, so `getStructTree` costs 0 to 3 ms everywhere; the 5.4.394 and 6.5 release notes claim a faster struct-tree build, which could not be tested), and small-file ratios on a quiet host (load below about 3).

## Other facts

- **Security:** no advisories on 4.10.38, 5.4.624 or 6.5.438. CVE-2026-16633 affects only 5.6.83 up to 6.2.108 (viewer `enableScripting`, not used here).
- **Node:** engines are `>=20` (4.10.38), `>=20.16 or >=22.3` (5.4.624), `>=22.13 or >=24` (6.5.438). All fit the repository's `>=22.18`.
- **Licence:** Apache-2.0, the licence closure does not change.
- **Bundle budget:** unchanged. `pdfjs-dist` is `external` in `scripts/build-cli-bundle.ts`, so it is in neither `dist` nor `bundle-budget.json`. Installed size 37.5 MB, 38.2 MB, 38.4 MB (+2%).
- **What stays whatever the version:** the second `getOperatorList` pass, the object-stream index repair (33 of 354 corpus files and 59 of 129 damaged variants still need repair), the struct-tree shortcut (`structTreeHasKids`) and `block-canvas.ts`.

## When to revisit

- A caller needs files with the damaged-xref class and the repair cost (about 4 s on `bug1978317.pdf`) matters.
- pdf.js ships an option to skip annotation text extraction, or a way to get glyph positions without the second pass.
- A quiet-host re-run (load below about 3) of the small-file ratios, and one on a large tagged PDF.
- 4.x stops getting fixes that matter.

If upgrading, take 5.4.624 (or the latest 5.4.x), apply the four changes above, add the word-spacing fixture first, update the one test expectation, and re-run the corpus word-spacing diff.
