The files testOpenOffice2.odf and testODFwithOOo3.odt are test documents of Apache Tika 4.2.0, which is licensed under
the Apache License 2.0
(tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-miscoffice-module/src/test/resources/
test-documents/ in the 4.2.0 source release). They are not modified. Sizes in bytes:

  testOpenOffice2.odf   10977
  testODFwithOOo3.odt   24286

Tika asserts on them in ODFParserTest.testOO2Metadata and testOO3Metadata (miscoffice module). The JSON fixtures here hold
the metadata values those tests assert and nothing else. The expectations were read from the Tika source and test, not run
against a Tika.
