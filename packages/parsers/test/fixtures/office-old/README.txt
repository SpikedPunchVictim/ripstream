testEXCEL_4.xls (39942 bytes) and testEXCEL_5.xls (7168 bytes) are test documents of Apache Tika 4.2.0, which is licensed
under the Apache License 2.0 (tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/
src/test/resources/test-documents/ in the 4.2.0 source release). Tika's OldExcelParserTest asserts on them. They are not
modified. The expectations in the JSON files are the ones that test states, read from Tika's source, not run against a Tika.

testEXCEL_dateFormats.xls (6144 bytes) and testPPT.ppt (16384 bytes) are test documents of the same Tika 4.2.0 release and
licence (tika-parser-microsoft-module test-documents, TestEXCEL_dateFormats.xls / testPPT.ppt), not modified. The expectations in
excel-date-formats-summary.json and powerpoint-summary.json are the metadata of Tika 4.2.0's /rmeta run on them (tikajs-nb4y).
