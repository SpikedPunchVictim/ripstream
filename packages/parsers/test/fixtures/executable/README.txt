The files testLinux-*, testMacOS-* and testWindows-x86-32.exe are test documents of Apache Tika 4.2.0, which is licensed
under the Apache License 2.0 (tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-code-module/
src/test/resources/test-documents/ in the 4.2.0 source release). Tika's ExecutableParserTest and
UniversalExecutableParserTest assert on them (the elf-arm-32le and elf-mips-32be fixtures are the exception: Tika does
not assert on those two; their expectations were read from the header bytes). They are not modified.
