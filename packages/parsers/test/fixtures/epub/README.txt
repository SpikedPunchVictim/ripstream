The files testEPUB.epub, testEPUB_multi-metadata-vals.epub and testEPUB_xml_ext.epub are test documents of Apache Tika 4.2.0,
which is licensed under the Apache License 2.0. They are not modified. Sizes in bytes, all in
tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-miscoffice-module/src/test/resources/test-documents/:

  testEPUB.epub                      30,552
  testEPUB_multi-metadata-vals.epub  571,926
  testEPUB_xml_ext.epub                  7,823

Tika's EpubParserTest asserts on them. epub.test.ts in the directory above carries what that test asserts about the Dublin Core
metadata and the embedded cover (tikajs-68os.51); the assertions were read from the Tika source, none was run against a Tika.
