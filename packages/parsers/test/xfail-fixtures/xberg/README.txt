Fixtures adopted from xberg (see ../../fixtures/xberg/README.txt) that fail today. They sit outside packages/parsers/test/fixtures so
fixtures.test.ts does not walk them. When a bead is fixed, move its files into fixtures/xberg/<area>/ (the '[xfail <bead>]' description prefix
can be dropped).

To re-check them, copy a file into a scratch dir and run it with loadFixtures/runFixture from test/fixture-runner.ts (nothing is left in this directory).

tikajs-v517  FIXED - moved to fixtures/repros/xberg-odt-*.json (ODF text order around inline spans/links)
tikajs-2ec1  FIXED - moved to fixtures/repros/xberg-ansicpg*-codepage-table.json
tikajs-ekue  FIXED - moved to fixtures/repros/xberg-deff-alone-selects-font.json, xberg-fcharset-*.json
tikajs-ig3h  FIXED - moved to fixtures/repros/xberg-hex-escape-run-split-by-newline.json
tikajs-k49h  FIXED - moved to fixtures/repros/xberg-shptxt-inside-ignorable-shape.json
tikajs-12kd  FIXED - moved to fixtures/repros/xberg-utf8-bom-rtf.json
tikajs-reyp  FIXED - moved to fixtures/repros/xberg-chapter-declared-*, xberg-chapter-utf16*.json
tikajs-ibvq  FIXED (Fixer E, 2026-11-14, Tika 4.2.0 oracle) - moved to fixtures/repros/xberg-epub-one-chapter-not-well-formed.json and
             xberg-epub-entity-and-stylesheet-before-empty-title.json. Tika records a bad chapter as a TIKA-237 container exception, keeps
             its text up to the error and reads the other chapters; ripstream does the same. The entity fixture was rewritten: Tika
             drops the text after the entity ('ENTITY-CHAPTER-ONE').
tikajs-y2cl  FIXED - moved to fixtures/repros/xberg-xlsx-*.json
tikajs-u03v  Partly decided against the Tika 4.2.0 oracle (Fixer D, 2026-11-14):
             html/declared-charset-* (3) and html/valid-utf8-with-contradicting-declaration  FIXED - moved to fixtures/repros/xberg-html-*.json
             mail/plain-*-labelled-base64-keeps-words (2)  Tika base64-decodes such a part too (the words are gone); replaced by
               fixtures/repros/xberg-mail-plain-text-labelled-base64-is-decoded.json
             rtf/hidden-text-and-unicode-fallback-scopes  Tika writes hidden (\\v) text; rewritten to Tika's behaviour in
               fixtures/repros/xberg-rtf-hidden-text-kept-and-unicode-fallback-scopes.json
             Decided by Fixer E (Tika 4.2.0 oracle), all moved to fixtures/repros/:
             xberg-docx-content-control-placeholder-* (2)  Tika writes the prompt text; expectations rewritten
             xberg-docx-tracked-move-text-once  ripstream fixed: moveFrom and delText are not written
             xberg-odt-comment-text  ripstream fixed: office:annotation is written as a block (with Tika's literal '&#32;')
             xberg-epub-spine-media-type-labels  ripstream already matched; text/xml and application/xml items are not read by Tika either
             xberg-epub-nested-30000-deep-spans  ripstream fixed: LEAD kept, container exception recorded, TAIL not read (as Tika)
