The .tsd and .TSD files are Time Stamped Data envelopes (RFC 5544) that are test documents of Apache Tika 4.2.0, which is
licensed under the Apache License 2.0 (tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-crypto-
module/src/test/resources/test-documents/ in the 4.2.0 source release). They are not modified. Sizes in bytes:

  MANIFEST.XML.TSD          14,683
  Test1.txt.tsd              4,967
  Test2.txt.tsd              4,969
  Test3.docx.tsd            16,254
  Test4.pdf.tsd            158,748
  Test5.PNG.tsd             33,317
  testTSD_broken_pdf.tsd    91,985   an envelope cut short inside its content

Tika's TSDParserTest (the module test and the integration test) asserts on all of them but Test5.PNG.tsd, whose recursive
test is commented out there; Test5.PNG.tsd is read by the direct-parse test. The JSON fixtures beside them carry what the text
of those tests allows a fixture to say; the metadata, counts and the truncation record are in packages/parsers/test/tsd.test.ts.
The assertions were read from the Tika source; none was run against a Tika.
