The files testVORBIS.ogg, testVORBIS_coverArt.ogg, testVORBIS_twoCovers.ogg, testFLAC.oga, testOPUS.opus and testAU.au
are test documents of Apache Tika 4.2.0, which is licensed under the Apache License 2.0
(tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-audiovideo-module/src/test/resources/
test-documents/ in the 4.2.0 source release). They are not modified. Sizes in bytes:

  testVORBIS.ogg             4241
  testVORBIS_coverArt.ogg    4429
  testVORBIS_twoCovers.ogg   4802
  testFLAC.oga              10820
  testOPUS.opus              1059
  testAU.au                  3868

Tika asserts on them in AutoDetectParserTest.testOggFlacAudio (the Vorbis, FLAC and Opus files), VorbisParserTest
(testRealFile, testCoverArt, testMultipleCovers) and AudioParserTest.testAU. The JSON fixtures here hold the values
those tests assert and nothing else; what the embedded pictures of the cover art files give is checked in
packages/parser-media/test/ogg.test.ts, as a fixture reads the container only. The expectations were read from the
Tika source and test, not run against a Tika.

Native FLAC (tikajs-68os.61): testFLAC.flac (10604 bytes) is from the test documents of tika-parsers-standard-integration-
tests, and testFLAC_coverArt.flac (10726), testFLAC_twoCovers.flac (10988) and testFLAC_commentAndNativePicture.flac
(10833) from the audiovideo module, both in the same 4.2.0 source release and licensed under the Apache License 2.0. They
are not modified. Tika asserts on testFLAC.flac in AutoDetectParserTest.testOggFlacAudio and on the other three in
FlacParserTest (testCoverArt, testMultipleCovers, testCommentAndNativePictureYieldOneThumbnail); the pictures they embed
are checked in packages/parser-media/test/flac.test.ts. Read from the Tika source, not run against a Tika.
