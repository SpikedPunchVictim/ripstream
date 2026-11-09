# Detection differential vs Tika 4.2.0 (test-documents)

Measured 2026-11-09 against the apache/tika:4.2.0 oracle: 1201 files from Tika's own `test-documents` trees (under 20 MB),
detected by name + bytes on both sides (oracle: `PUT /meta`, field `tk:content-type-parser-override`).

| Build | Files | Mismatches |
|---|---:|---:|
| HEAD 1103b89 (before the detection work) | 1201 | 225 |
| After (ZIP containers, magic OR semantics, parameterised supertypes, per-type XML-root refinement, DOCTYPE-tolerant root, text-first name hint) | 1201 | 61 |

No file that matched before differs now. The remaining 61 are formats whose Tika answer comes from a content detector we do not
port (ELF/PE, POIFS-based Works/HWP/SolidWorks/DGN/Quattro/StarOffice-variant, gzip WARC/ARC, mbox, OOXML-protected, ogg-flac,
bplist variants, text-based DXF/graphviz/hprof/matlab/ENVI). Tracked by tikajs-68os.25.

| Tika | Ours | Count | Files |
|---|---|---:|---|
| `application/x-executable` | `application/x-elf` | 8 | testFreeBSD-x86-64, testSolaris-x86-32, testLinux-arm-32le, testLinux-mips-32be, … |
| `application/x-tika-ooxml-protected` | `application/x-tika-ooxml` | 7 | protected_normal_case.docx, protect.xlsx, protectedFile.xlsx, testEXCEL_protected_passtika.xlsx, … |
| `application/sldworks` | `application/x-tika-msoffice` | 6 | testsolidworksAssembly2013SP2.SLDASM, testsolidworksDrawing2013SP2.SLDDRW, testsolidworksDrawing2014SP0.SLDDRW, testsolidworksAssembly2014SP0.SLDASM, … |
| `image/vnd.dxf; format=ascii` | `text/plain` | 3 | testDXF_ascii_win_newlines.dxf, testDXF_ascii_no_header.dxf, testDXF_ascii.dxf |
| `text/vnd.graphviz` | `text/plain` | 3 | testGRAPHVIZdc.dot, testGRAPHVIZg.dot, testGRAPHVIZd.dot |
| `application/x-hwp-v5` | `application/x-tika-msoffice` | 3 | testHWP-v5-dist.hwp, testHWP-v5b.hwp, testHWP_5.0.hwp |
| `application/warc+gz` | `application/gzip` | 3 | gzip_extra_sl.warc.gz, cc.warc.gz, testWARC_multiple.warc.gz |
| `application/x-ms-nls` | `application/octet-stream` | 2 | testNLS1.nls, testNLS2.nls |
| `text/plain` | `application/mbox` | 2 | quoted.mbox, simple.mbox |
| `application/vnd.ms-excel` | `application/msword` | 2 | testEXCEL_embeded.xls, testWPSAttachment.xls |
| `audio/x-aac` | `audio/mpeg` | 1 | testAACid3.aac |
| `application/illustrator+ps` | `application/postscript` | 1 | testAI_PS.ai |
| `audio/x-oggflac` | `audio/ogg` | 1 | testFLAC.oga |
| `application/vnd.java.hprof` | `application/octet-stream` | 1 | testJavaHprofBinary |
| `application/vnd.java.hprof.text` | `text/plain` | 1 | testJavaHprofText |
| `application/x-bplist-memgraph` | `application/x-memgraph` | 1 | testMemgraph.memgraph |
| `application/x-bplist-itunes` | `application/x-bplist` | 1 | testBPList.bplist |
| `application/x-bplist-webarchive` | `application/x-webarchive` | 1 | testWEBARCHIVE.webarchive |
| `video/webm` | `application/x-matroska` | 1 | sample-webm.noext |
| `text/x-matlab` | `text/x-objcsrc` | 1 | testMATLAB_wtsgaus.m |
| `image/vnd.dgn; version=8` | `application/x-tika-msoffice` | 1 | testDGN8.dgn |
| `text/html` | `application/mbox` | 1 | single_mail.mbox |
| `message/x-emlx` | `message/rfc822` | 1 | testEMLX_single_part_html.emlx |
| `application/x-tika-ooxml-protected` | `application/x-tika-msoffice` | 1 | protected_upper_case.docx |
| `application/x-ms-owner` | `application/octet-stream` | 1 | testMSOwnerFile |
| `application/x-tika-ole-drm-encrypted` | `application/msword` | 1 | testWORD_protected_drm.doc |
| `application/x-quattro-pro; version=9` | `application/x-quattro-pro` | 1 | testQUATTRO.qpw |
| `application/x-quattro-pro; version=7-8` | `application/x-quattro-pro` | 1 | testQUATTRO.wb3 |
| `application/x-lzma` | `application/octet-stream` | 1 | testLZMA_oom |
| `application/x-snappy` | `application/x-snappy-framed` | 1 | testSnappy-framed.sz |
| `application/arc+gz` | `application/gzip` | 1 | example.arc.gz |
| `ERR TypeError: Cannot convert argument to a ByteString because t` | `application/xml` | 1 | 中文.xml |
