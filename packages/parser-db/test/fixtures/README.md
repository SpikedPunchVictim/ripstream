# Real SQLite and GeoPackage files

`gdal-byte.gpkg` is GDAL's `autotest/gdrivers/data/gpkg/byte.gpkg` from
[OSGeo/gdal](https://github.com/OSGeo/gdal), MIT. It is a GeoPackage 1.1 written by GDAL: a tile table `byte` in
`gpkg_contents`, a `gpkg_tile_matrix` row, and one tile row with an empty `tile_data` BLOB. It is used to check the
GeoPackage reader on a file it did not make (tikajs-68os.55).
