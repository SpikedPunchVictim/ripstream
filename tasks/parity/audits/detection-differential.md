# Detection differential vs Tika 4.2.0 (test-documents)

Measured 2026-11-09 against the apache/tika:4.2.0 oracle: 1201 files from Tika's own `test-documents` trees (under 20 MB),
detected by name + bytes on both sides (oracle: `PUT /meta`, field `tk:content-type-parser-override`).

| Build | Files | Mismatches |
|---|---:|---:|
| HEAD 1103b89 (before the detection work) | 1201 | 225 |
| ff1deaf (ZIP containers, OR-semantics magic, parameterised supertypes, per-type XML-root refinement, DOCTYPE-tolerant root, text-first name hint) | 1201 | 61 |
| 7d6a5fa (Tika magic ordering and regex semantics, Ogg/Matroska/gzip/bplist/compressor/OLE2/OPC detectors) | 1201 | 0 |

No file that matched at an earlier build differs now.

After that measurement two detection rules were added from source and not measured against the oracle: the Unix dump header
(`application/x-tika-unix-dump`, `tikajs-68os.20`) and the Info-ZIP Unicode Path field `0x7075` for a member whose bit 11 is clear
(`tikajs-68os.26`). Both are commons-compress behaviour, which is not in the Tika tree; the rules are from memory of that library.
