# Real Unix dump volumes

`commons-bla.dump` is Apache Commons Compress's `src/test/resources/bla.dump` (92,160 bytes), Apache-2.0. It is a real
dump(8) volume written for the commons-compress `DumpArchiveInputStream` tests, not by this project. It is uncompressed;
the compressed variant in the tests is encoded from it in the same block format commons-compress's `TapeInputStream`
reads (4-byte block header, zlib payload), to exercise tikajs-cg2p without a second externally written archive.
