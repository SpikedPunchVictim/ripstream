The file testSqlite3b.db is a test document of Apache Tika 4.2.0, which is licensed under the Apache License 2.0
(tika-parsers/tika-parsers-extended/tika-parser-sqlite3-module/src/test/resources/test-documents/ in the 4.2.0 source
release). It is not modified.

Tika asserts on it in SQLite3ParserTest.testSpacesInBodyContentHandler (text and the two sqlite3: header keys). The JSON
fixture here holds the values that test asserts and nothing else; testNulls (a row of nulls is empty cells) is checked in
packages/parser-db/test/sqlite.test.ts. The expectations were read from the Tika source and test, not run against a Tika.
