The files testGeoGebra.ggb, testGeoGebra_classic.ggb, testIndesign.idml, testWACZ.wacz and testXLIFF12.xlz are test documents
of Apache Tika 4.2.0, which is licensed under the Apache License 2.0. They are not modified. Sizes in bytes, and where each
is in the 4.2.0 source release (tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/):

  testGeoGebra.ggb            2,010  tika-parser-miscoffice-module/src/test/resources/test-documents/
  testGeoGebra_classic.ggb    4,761  tika-parser-miscoffice-module/src/test/resources/test-documents/
  testIndesign.idml          30,574  tika-parser-miscoffice-module/src/test/resources/test-documents/
  testWACZ.wacz               4,186  tika-parser-webarchive-module/src/test/resources/test-documents/
  testXLIFF12.xlz             1,004  tika-parser-xml-module/src/test/resources/test-documents/

testGeoGebra.ggb and testWACZ.wacz are also in tika-parser-zip-commons, and testGeoGebra_classic.ggb in
tika-parsers-standard-integration-tests, byte for byte the same. Tika's GeoGebraParserTest and GeoGebraDetectionTest assert on
the .ggb files, IDMLParserTest on the .idml, WACZParserTest on the .wacz and XLZParserTest on the .xlz. The JSON fixtures beside
them carry what those tests assert, each marked with its bead (tikajs-68os.52); what a fixture cannot say (the embedded
documents) is in archive-samples.test.ts. The assertions were read from the Tika source; none was run against a Tika.

synthetic-unix-dump.dump (20,480 bytes) is not a Tika file and not produced by dump(8): the Tika 4.2.0 tree has no Unix dump
test document, and no dump tool was available. It is two files (readme.txt and docs/notes.txt) in a volume built to the dump
layout by packages/parser-archive/test/dump-builder.ts (volume header, CLRI and BITS maps, the root and docs directories, the
two inodes, the end record, padded to a 10-record block). It proves the reader's own reading order, not that real dump
output reads the same; that layout is from memory of commons-compress (tikajs-68os.47). To replace it with a real volume, run
dump(8) on a small file system and add a fixture beside it.
