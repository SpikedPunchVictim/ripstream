# Real SAS7BDAT files

These files are real SAS7BDAT output, not made by the test builder. They cover the layouts the synthetic tests in
`packages/parsers/test/sas7bdat-layouts.test.ts` cannot show that SAS writes.

| File | Layout | Source |
| --- | --- | --- |
| `sasdate-64le.sas7bdat` | 64-bit, little-endian, uncompressed, DATE family formats | [EPAM parso](https://github.com/epam/parso), `src/test/resources/dates/sas7bdat/date_format_date.sas7bdat`, Apache-2.0 |
| `sas-64be-class.sas7bdat` | 64-bit, big-endian, mixed pages | [EPAM parso](https://github.com/epam/parso), `src/test/resources/bugs/54-class.sas7bdat`, Apache-2.0 |
| `sas-64be-mixed.sas7bdat` | 64-bit, big-endian, mixed page with 727 rows | [EPAM parso](https://github.com/epam/parso), `src/test/resources/sas7bdat/extend_yes.sas7bdat`, Apache-2.0 |
| `sas-rle-longchar.sas7bdat` | 32-bit, little-endian, RLE (`SASYZCRL`), 47 columns | [EPAM parso](https://github.com/epam/parso), `src/test/resources/sas7bdat/mix_data_with_longchar.sas7bdat`, Apache-2.0 |
| `sas-rdc-deleted.sas7bdat` | 64-bit, little-endian, RDC (`SASYZCR2`), one deleted row | [ReadStat](https://github.com/WizardMac/ReadStat), `src/test/resources/compression_type_0x02.sas7bdat`, MIT |
| `sas-deleted.sas7bdat` | 32-bit, little-endian, rows with a deleted-map | [EPAM parso](https://github.com/epam/parso), `src/test/resources/sas7bdat/all_rand_normal_with_deleted.sas7bdat`, Apache-2.0 |
| `sas-deleted-all.sas7bdat` | 32-bit, little-endian, every row deleted | [EPAM parso](https://github.com/epam/parso), `src/test/resources/sas7bdat/all_rand_normal_with_deleted2.sas7bdat`, Apache-2.0 |

The expected cells in `packages/parsers/test/sas7bdat-real.test.ts` were checked against Apache Tika 4.2.0's
`SAS7BDATParser` output for the same files.
