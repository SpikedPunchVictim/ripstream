# Legacy module mapping

| Tika module | ripstream |
|---|---|
| tika-core | `@spikedpunch/ripstream-core`, `@spikedpunch/ripstream-mime` |
| tika-parsers-standard | `@spikedpunch/ripstream-parsers`, `@spikedpunch/ripstream-parser-*` |
| tika-app | `@spikedpunch/ripstream-bundle-standard`, `@spikedpunch/ripstream-cli` |
| tika-server | `@spikedpunch/ripstream-server` |
| tika-pipes | `@spikedpunch/ripstream-pipes` |
| tika-bundle-standard | `@spikedpunch/ripstream-bundle-standard` |
| tika-example | `examples/quickstart.ts` |
| tika-integration-tests | cross-format suites in `packages/*/test` + parity goldens |
| tika-handlers | `@spikedpunch/ripstream-core` handlers |
| tika-xmp | XMP metadata utilities + handler |
| tika-serialization | metadata CSV/XML/XMP + rmeta |
| tika-plugins-core | plugin registry/loader |
| tika-encoding-detectors | `@spikedpunch/ripstream-mime` encoding detection |
