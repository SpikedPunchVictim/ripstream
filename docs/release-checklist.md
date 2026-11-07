# 1.0 release checklist

- [x] Core parser/detector/handler contracts and streaming facade
- [x] MIME registry generated from Ripstream; detection goldens
- [x] P0/P1 format slice: text/web/mail, archives, PDF, OOXML/ODF/EPUB, legacy Office, media metadata
- [x] Recursive/rmeta JSON, metadata serialization, CLI, HTTP server, pipes core
- [x] Archive/SSRF/limits/worker/temp-file security controls
- [x] API report, type tests, license/SBOM/provenance gates, CI
- [x] Parity report + feature matrix
- [ ] Full corpus differential run with Tika 4.2 for all P0/P1
- [ ] Optional heavy backends: RAR/7z entry extraction, PST stores, OCR/VLM, gRPC/eval, cloud pipes
- [ ] Node/Bun/Deno and browser matrix green
- [ ] Final semver/publish review and 1.0 tag

Generated docs: `pnpm parity:report`, `pnpm api:report`, `pnpm sbom`, `pnpm provenance`.
