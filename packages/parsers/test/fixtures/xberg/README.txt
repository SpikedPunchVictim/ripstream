Fixtures derived from xberg (https://github.com/xberg-io/xberg, MIT License, Copyright (c) 2025-2026 Kreuzberg, Inc.) and from vendored
permissive subsets of its test-document corpus (unstructured: Apache-2.0, docling: MIT). Tracked by bead tikajs-qw7f.

- Most fixtures are inputs synthesised by this repository's authors (inline text, base64 or zip built from XML) for cases described in
  xberg's Rust regression tests; each description says which test file it adapts. They contain no xberg bytes.
- Files under <area>/files/ are copied unmodified from xberg or its vendored corpus; each area's README.txt gives source, licence, size and sha256.
- xberg's binary corpus lives in a storage bucket that was not reachable, so only git-committed inputs were used. Not adopted: the
  WordPerfect CVE files (MPL-2.0), notebooks (ripstream has no notebook parser; they detect as text/plain), the UTF-16 e-mail files
  (detect as text/plain here), factbook-utf-16.xml (UTF-16 BOM with a UTF-8 declaration is rejected, which Xerces also does), the MS Kanji CSV
  (70 bytes, encoding detection is ambiguous) and the doc_numbering_2857 .doc files (they test xberg's list-label rendering).
- Assertions are text and metadata only. xberg's structure assertions (tables, annotations, document trees) were not carried over.
- Failing cases live in ../../xfail-fixtures/xberg (outside the walked fixtures root), see the README there.
- Suggested NOTICE entry: 'Test inputs adapted from xberg (MIT, Copyright (c) 2025-2026 Kreuzberg, Inc.), unstructured (Apache-2.0) and
  docling (MIT, Copyright (c) 2024 IBM).' This file does not change NOTICE.
