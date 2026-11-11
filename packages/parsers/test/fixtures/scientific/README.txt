Test data for the scientific-format parsers (tikajs-68os.22).

The files below were copied unmodified from Apache Tika 4.2.0, which is licensed under the Apache License, Version 2.0
(https://www.apache.org/licenses/LICENSE-2.0). Each is in the Tika tree under the module's src/test/resources directory.

  envi_test_header.hdr                    818 bytes   tika-parser-scientific-module   EnviHeaderParserTest.testParseGlobalMetadata
  ang20150420t182050_corr_v1e_img.hdr     20.2 KB     tika-parser-scientific-module   EnviHeaderParserTest.testParseGlobalMetadataMultiLineMetadataValues
  EnviHeaderGroundTruth.txt               4.3 KB      tika-parser-scientific-module   the expected correction-factors line of that test
  s_BII-S-1.txt                           41.2 KB     tika-parser-scientific-module   test-documents/testISATab_BII-I-1/, ISArchiveParserTest.testParseArchive (study file only: the investigation file beside it is not copied)
  s_BII-S-2.txt                           5.9 KB      tika-parser-scientific-module   test-documents/testISATab_BII-I-1/ (study file only)
  sampleFile.iso19139                     18.9 KB     tika-parser-scientific-module   GeographicInformationParserTest.testISO19139

This one was NOT copied from Tika (the Tika tree holds no GeoPackage file); it was made for this repository:

  synthetic-features.gpkg                 6.5 KB      made with sql.js (SQLite as WASM): the GeoPackage 1.2 tables gpkg_spatial_ref_sys, gpkg_contents and
                                                      gpkg_geometry_columns, a feature table "points" (two rows, a POINT geom blob) and a tile table "tiles"
                                                      (one tile_data blob holding the ASCII text "embedded tile text"), PRAGMA application_id = 0x47504b47
                                                      ("GPKG") and user_version = 10200, page_size 512. The statements are the GEOPACKAGE list in
                                                      packages/parser-db/test/geopkg.test.ts plus the tiles table.

The *.json files are ripstream's own declarative fixtures (see packages/parsers/test/fixture-runner.ts).
