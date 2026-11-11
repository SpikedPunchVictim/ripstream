The files testBPList.bplist, testWEBARCHIVE.webarchive, testDGN8.dgn, testQUATTRO.qpw, testSAS.sas7bdat,
test-columnar.sas7bdat and test-columnar.sas.xml are test documents of Apache Tika 4.2.0, which is licensed under the Apache
License 2.0. They are not modified. Sizes in bytes, and where each is in the 4.2.0 source release
(tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/):

  testBPList.bplist           24,433  tika-parser-apple-module/src/test/resources/test-documents/
  testWEBARCHIVE.webarchive   78,692  tika-parser-apple-module/src/test/resources/test-documents/
  testDGN8.dgn                28,160  tika-parser-cad-module/src/test/resources/test-documents/
  testQUATTRO.qpw              4,608  tika-parser-miscoffice-module/src/test/resources/test-documents/
  testSAS.sas7bdat            17,408  tika-parser-code-module/src/test/resources/test-documents/
  test-columnar.sas7bdat     131,072  tika-parser-code-module/src/test/resources/test-documents/
  test-columnar.sas.xml        3,330  tika-parser-code-module/src/test/resources/test-documents/

Tika's PListParserTest asserts on the first two, DGN8ParserTest on the third, QuattroProTest on the fourth and
SAS7BDATParserTest on the two .sas7bdat files. test-columnar.sas.xml is SAS's own XML export of test-columnar.sas7bdat; Tika's
tests do not read it, and sas7bdat.test.ts compares every value of the dataset with it. The JSON fixtures beside them carry
what those tests assert, each marked with its bead (tikajs-68os.21). The assertions were read from the Tika source; none was
run against a Tika.
