# Bundle budget

`bundle-budget.json` caps the `dist` bytes of every package (and their total); `pnpm run bundle:check` fails when one is
over, and CI runs it after `pnpm build` (tikajs-qrky).

The first budgets were set with the initial port and were never adjusted as parsers were completed, so at HEAD every
larger package was over by 10-35%. They were raised to the measured size plus roughly ten percent, not removed: the
check still catches a package that doubles. The total cap is the sum of the per-package caps.

When a package outgrows its cap for a real feature, raise that cap and the total in the same commit as the feature, and
say why in the commit message. If a package needs much more than the headroom, consider splitting it (for example
`parser-media` into audio/video and image, or `parsers` into registry and individual format modules) rather than raising
the cap. Never raise a cap just to pass CI without a feature that explains it.

The CLI's split bundle (`pnpm build:bundle`, [cli-startup.md](cli-startup.md)) is a second copy of code that `dist`
already counts, so it has its own `cli-bundle` line, in KiB of `packages/cli/bundle/dist`, and is not part of `total`. It
is checked when the bundle has been built; CI builds it first. Its cap is the measured size (4,414 KiB) plus about ten
percent; raise it with the feature that grows it, as for a package.

## Cap raises

Each raise names the features that grew the package. Measured sizes are `dist` bytes at the raise; caps are the
measured size plus about five percent (KiB).

| package | measured | cap | what grew it |
|---|---|---|---|
| parsers | 1,112,011 | 1100 (was 1000) | a hand-written CommonMark/GFM block and inline parser for Markdown (tikajs-8uhs, no new dependency); RTF `\pict` embedded documents (tikajs-3b5g); Tika-exact email body text (tikajs-w12u); the HTML body start (tikajs-x1cd); XML UTF-16 detection (tikajs-dmp7); unversioned WordPerfect as empty (tikajs-mic4). Per-feature bytes not measured |
| parser-office | 733,235 | 725 (was 710) | `.msg` body selection and compressed RTF (tikajs-8vzf); ODT notes, lists, headers and footers (tikajs-uay4); xlsb and ods segment fidelity (tikajs-bwjq); OLE2 property-set keys (tikajs-nb4y). Per-feature bytes not measured |
| core | 1,604,924 | 1650 (was 1500) | segments, labels, location, `pathParts`, `leafSegments` and the segment allowance; `onEmbeddedLimit`; email header block; `handlerType` validation |
| parser-office | 692,687 | 710 (was 650) | segment hints for office formats; email headers; RDF blank-node labels |
| parser-pdf | 364,581 | 375 (was 345, 150 before recovery) | brute-force damaged-file recovery (xref and page-tree rebuild, font repair, Flate salvage), image-only page keys, key repair, pdf.js import filter (roughly doubled by design); then repair of intact-xref font damage (tikajs-w4ps), Tika-4 metadata keys: access permissions, marked content, EOF offsets, incremental updates (tikajs-p1qx), page labels and AcroForm field segments (tikajs-ex78) |
| server | 205,970 | 212 (was 200) | opt-in `?segments=` on `/rmeta` and `/unpack` (tikajs-5wd0) |
| cli | 120,674 | 125 (was 100) | split bundle stub, `--segments`, `--workers`, `--isolation-reuse*` |
| pipes | 649,129 | 665 (was 550) | the parse worker pool and its codec, segments in the emit surface |
| isolation-node | 692,882 | 710 (was 550) | opt-in child reuse (serve-mode protocol, leases, retire reasons, CPU and RSS checks), segment frames, admission refusal |
| total | 7,301,192 | 7500 (was 7000) | the sum of the above |
