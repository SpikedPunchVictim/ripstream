# Publishing strategy

- ESM-first packages; export maps include `types`, `import`, `require` and `default`. Node >= 22.18
  loads the ESM build through `require(esm)`; no separate CJS artifact.
- Optional parsers expose heavy dependencies as optional peers:
  `pdfjs-dist` is an optional peer of `@spikedpunch/ripstream-parser-pdf`; install it to enable PDF parsing.
- Publish in dependency order: core, mime, parser-*, parsers, language, cli, parity/test-corpus as
  dev-only if published.
- API surface is frozen by `api-report.json` (`pnpm api:check`); semver policy in `docs/api.md`.
- Supply chain: `pnpm license:check`, `pnpm sbom`, `pnpm provenance`; CI uploads SBOM/provenance.
- Provenance uses SLSA-style in-toto statements with dist hashes and git revision.
