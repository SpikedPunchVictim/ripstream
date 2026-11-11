Test data for the RFC 822 and emlx mail parser (tikajs-68os.46).

The files below were copied unmodified from Apache Tika 4.2.0, which is licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). Each is in tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/
tika-parser-mail-module/src/test/resources/test-documents/, and is used by RFC822ParserTest or EMLXTest in that module.

  testRFC822                          testSimple, testExtendedToFromMetadata
  testRFC822_quoted                   testQuotedPrintable, testExtendedToFromMetadata
  testRFC822_i18nheaders              testI18NHeaders, testExtendedToFromMetadata
  testRFC822_date_utf8                testDates
  testRFC822_oddfrom                  testUnusualFromAddress
  testRFC822-limitedheaders           testSomeMissingHeaders
  testRFC822-multipart                testBasicAlternativeBodyHandling, testMultipartFlags
  testRFC822-mixed-simple             testMixedRelatedMultipart
  testRFC822-mixed-with-pdf-inline    testAlternativeWithComplexMixedChild
  testRFC822_simple_inline_body.txt   testSimpleBodyInlined
  testEMLX_multipart_html.emlx        EMLXTest.testLongHeaderBlockWithHtmlAlternative
  testEMLX_single_part_html.emlx      EMLXTest.testSinglePartHtml

The expected values are the ones those tests assert, read from the Tika source: no Tika was run.
