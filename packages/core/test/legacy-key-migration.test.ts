import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { METADATA_MIGRATION_DROPPED, METADATA_MIGRATION_ROWS } from "../src/generated/metadata-migration.ts";
import {
  LegacyKeyMigrationFilter,
  Metadata,
  ParseContext,
  type LegacyKeyMigrationDirection,
  type MetadataMigrationRow,
} from "../src/index.ts";

function bundled(direction: LegacyKeyMigrationDirection): LegacyKeyMigrationFilter {
  return new LegacyKeyMigrationFilter({ direction });
}

function withRows(direction: LegacyKeyMigrationDirection, rows: readonly MetadataMigrationRow[]): LegacyKeyMigrationFilter {
  return new LegacyKeyMigrationFilter({ direction, rows });
}

function apply(filter: LegacyKeyMigrationFilter, metadata: Metadata): Metadata {
  filter.filter([metadata], new ParseContext());
  return metadata;
}

function metadataOf(values: Record<string, string | string[]>): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(values)) {
    for (const each of Array.isArray(value) ? value : [value]) metadata.add(name, each);
  }
  return metadata;
}

// The first block is Tika 4.2.0 LegacyKeyMigrationFilterTest, in the order it has them.

test("egress renames a 4.x key to its 3.x spelling and passes the rest through", () => {
  const filter = withRows("V4_TO_V3", [{ v3: "pdf:hasMarkedContent", v4: "pdf:has-marked-content" }]);
  const metadata = apply(filter, metadataOf({ "pdf:has-marked-content": "true", "dc:title": "Hello" }));
  assert.equal(metadata.get("pdf:hasMarkedContent"), "true");
  assert.equal(metadata.get("pdf:has-marked-content"), null);
  assert.equal(metadata.get("dc:title"), "Hello");
});

test("egress writes a 3.x key in the X-TIKA: namespace", () => {
  const filter = withRows("V4_TO_V3", [{ v3: "X-TIKA:Parsed-By", v4: "tk:parsed-by" }]);
  const metadata = apply(filter, metadataOf({ "tk:parsed-by": "org.apache.tika.parser.DefaultParser" }));
  assert.equal(metadata.get("X-TIKA:Parsed-By"), "org.apache.tika.parser.DefaultParser");
  assert.equal(metadata.get("tk:parsed-by"), null);
});

test("ingest drops a key 4.x no longer emits and renames the rest", () => {
  const filter = withRows("V3_TO_V4", [
    { v3: "pst:folderPath", v4: METADATA_MIGRATION_DROPPED },
    { v3: "pdf:hasMarkedContent", v4: "pdf:has-marked-content" },
  ]);
  const metadata = apply(filter, metadataOf({ "pst:folderPath": "/Inbox/Sub", "pdf:hasMarkedContent": "true" }));
  assert.equal(metadata.get("pst:folderPath"), null);
  assert.equal(metadata.get("pdf:has-marked-content"), "true");
});

test("every value of a multi-valued key is kept, in order", () => {
  const filter = withRows("V4_TO_V3", [{ v3: "meta:mapi-importance", v4: "mapi:importance" }]);
  const metadata = apply(filter, metadataOf({ "mapi:importance": ["1", "2"] }));
  assert.deepEqual(metadata.getAll("meta:mapi-importance"), ["1", "2"]);
});

test("a filter with no rows still migrates by prefix, and leaves any other key alone", () => {
  const metadata = apply(withRows("V4_TO_V3", []), metadataOf({ "dc:title": "Hello" }));
  assert.equal(metadata.get("dc:title"), "Hello");
});

test("the bundled table rewrites real keys on egress", () => {
  const metadata = apply(bundled("V4_TO_V3"), metadataOf({ "tk:content": "hello", "message:from-email": "a@b.com" }));
  assert.equal(metadata.get("X-TIKA:content"), "hello");
  assert.equal(metadata.get("tk:content"), null);
  assert.equal(metadata.get("Message:From-Email"), "a@b.com");
});

test("egress rewrites a digest key's algorithm and keeps its encoding", () => {
  const metadata = apply(
    withRows("V4_TO_V3", []),
    metadataOf({ "tk:digest:SHA-256": "abc", "tk:digest:SHA-256:BASE32": "def", "tk:digest:MD5": "ghi" }),
  );
  assert.equal(metadata.get("X-TIKA:digest:SHA256"), "abc");
  assert.equal(metadata.get("X-TIKA:digest:SHA256:BASE32"), "def");
  assert.equal(metadata.get("X-TIKA:digest:MD5"), "ghi");
  assert.equal(metadata.get("tk:digest:SHA-256"), null);
});

test("ingest rewrites a digest key's algorithm back", () => {
  const metadata = apply(withRows("V3_TO_V4", []), metadataOf({ "X-TIKA:digest:SHA3_512": "z" }));
  assert.equal(metadata.get("tk:digest:SHA3-512"), "z");
  assert.equal(metadata.get("X-TIKA:digest:SHA3_512"), null);
});

// {4.x key, 3.x key, value}
const EGRESS_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["ner:PERSON", "NER_PERSON", "John McKay"],
  ["ner:WEEK_DAY", "NER_WEEK_DAY", "Sunday"],
  ["envi:lat/lon", "envi.lat/lon", "36.79, -108.48"],
  ["ogg:streams-total", "streams-total", "2"],
  ["iso19115:keywords:2", "Keywords 2", "climate"],
  ["iso19115:keywords-type:2", "KeywordsType 2", "theme"],
  ["iso19115:thesaurus-name-title:2", "ThesaurusNameTitle 2", "GCMD"],
  ["iso19115:thesaurus-name-alternative-title:2", "ThesaurusNameAlternativeTitle 2", "GCMD Keywords"],
  ["geotopic:alt-name1", "Optional_NAME1", "United States"],
  ["geotopic:alt-longitude12", "Optional_LONGITUDE12", "-98.5"],
  ["iwork:document-id", "iworks:document-id", "ABC-123"],
  ["dif:DIF-Entry_ID", "DIF-Entry_ID", "e-42"],
  ["mdb-prop:Title", "MDB_PROP:Title", "My DB"],
  ["mdb-user-prop:Owner", "MDB_USER_PROP:Owner", "me"],
  ["mdb-summary-prop:Company", "MDB_SUMMARY_PROP:Company", "ACME"],
  // bare in 3.x: egress strips the 4.x prefix
  ["hdf:GRingPointLatitude", "GRingPointLatitude", "1.0 2.0"],
  ["netcdf:project_id", "project_id", "IPCC"],
  ["gdal:NETCDF_VARNAME", "NETCDF_VARNAME", "tasmax"],
  ["isatab:Study Title", "Study Title", "Mouse study"],
  ["mp4:com.apple.quicktime.author", "com.apple.quicktime.author", "someone"],
  ["network:geo:lat", "geo:lat", "36.4"],
  ["audio:x-vendor-extension", "x-vendor-extension", "v"],
];

// {3.x key, 4.x key, value}
const INGEST_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["NER_LOCATION", "ner:LOCATION", "Los Angeles"],
  ["envi.samples", "envi:samples", "2400"],
  ["streams-vorbis", "ogg:streams-vorbis", "1"],
  ["Keywords 3", "iso19115:keywords:3", "ocean"],
  ["Optional_LATITUDE1", "geotopic:alt-latitude1", "39.76"],
  ["iworks:document-id", "iwork:document-id", "ABC-123"],
  ["DIF-Entry_ID", "dif:DIF-Entry_ID", "e-42"],
  ["MDB_PROP:Title", "mdb-prop:Title", "My DB"],
  ["MDB_USER_PROP:Owner", "mdb-user-prop:Owner", "me"],
  ["MDB_SUMMARY_PROP:Company", "mdb-summary-prop:Company", "ACME"],
];

// bare in 3.x, with no marker a rule could recognize, so ingest does not touch them
const INGEST_PASSTHROUGH_KEYS = [
  "GRingPointLatitude", "project_id", "Study Title", "com.apple.quicktime.author", "x-vendor-extension",
  "File-Type-Description", "version", "Password",
];

function assertMigrates(direction: LegacyKeyMigrationDirection, from: string, to: string, value: string): void {
  const metadata = apply(withRows(direction, []), metadataOf({ [from]: value }));
  assert.equal(metadata.get(to), value, `${from} -> ${to}`);
  assert.equal(metadata.get(from), null, `${from} should be removed`);
}

test("every open-vocabulary family is rewritten by prefix on egress", () => {
  for (const [from, to, value] of EGRESS_ROWS) assertMigrates("V4_TO_V3", from, to, value);
});

test("every open-vocabulary family that has a 3.x marker is rewritten by prefix on ingest", () => {
  for (const [from, to, value] of INGEST_ROWS) assertMigrates("V3_TO_V4", from, to, value);
});

test("a family that was bare in 3.x passes through on ingest", () => {
  const metadata = apply(bundled("V3_TO_V4"), metadataOf(Object.fromEntries(INGEST_PASSTHROUGH_KEYS.map((key) => [key, "v"]))));
  for (const key of INGEST_PASSTHROUGH_KEYS) assert.equal(metadata.get(key), "v", `${key} must pass through unchanged on ingest`);
});

test("the bundled table handles the keys several 4.x keys share one 3.x spelling for, and grobid, and ISO 19115 exactly", () => {
  const egress = bundled("V4_TO_V3");
  const first = apply(
    egress,
    metadataOf({
      "hdf:file-type-description": "HDF5",
      "mp3:version": "MPEG 3 Layer III",
      "mdb:password": "s3cret",
      "grobid:tei:abstract": "text",
    }),
  );
  assert.equal(first.get("File-Type-Description"), "HDF5");
  assert.equal(first.get("version"), "MPEG 3 Layer III");
  assert.equal(first.get("Password"), "s3cret");
  assert.equal(first.get("grobid:header_Abstract"), "text");
  assert.equal(first.get("hdf:file-type-description"), null);

  const second = apply(egress, metadataOf({ "netcdf:file-type-description": "NetCDF-4", "ogg:codec-version": "Theora 3.2.1" }));
  assert.equal(second.get("File-Type-Description"), "NetCDF-4");
  assert.equal(second.get("version"), "Theora 3.2.1");

  const third = apply(
    bundled("V3_TO_V4"),
    metadataOf({ "grobid:header_Title": "A Paper", Title: "not grobid's", "AccessContraints ": "restricted" }),
  );
  assert.equal(third.get("grobid:tei:title"), "A Paper");
  assert.equal(third.get("Title"), "not grobid's");
  assert.equal(third.get("iso19115:access-constraints"), "restricted");
  assert.equal(third.get("grobid:header_Title"), null);
  assert.equal(third.get("AccessContraints "), null);
});

test("the bare mail keys bridge in both directions", () => {
  const ingest = apply(
    bundled("V3_TO_V4"),
    metadataOf({
      "Message-To": "to@example.com",
      "Message-From": "from@example.com",
      "Message-Cc": "cc@example.com",
      "Message-Bcc": "bcc@example.com",
      "Message-Recipient-Address": "rcpt@example.com",
      "Multipart-Boundary": "----=_Part_0",
      "Multipart-Subtype": "mixed",
    }),
  );
  assert.equal(ingest.get("message:to"), "to@example.com");
  assert.equal(ingest.get("message:from"), "from@example.com");
  assert.equal(ingest.get("message:cc"), "cc@example.com");
  assert.equal(ingest.get("message:bcc"), "bcc@example.com");
  assert.equal(ingest.get("message:recipient-address"), "rcpt@example.com");
  assert.equal(ingest.get("multipart:boundary"), "----=_Part_0");
  assert.equal(ingest.get("multipart:subtype"), "mixed");
  assert.equal(ingest.get("Message-To"), null);
  assert.equal(ingest.get("Multipart-Boundary"), null);

  const egress = apply(bundled("V4_TO_V3"), metadataOf({ "message:to": "to@example.com", "multipart:subtype": "mixed" }));
  assert.equal(egress.get("Message-To"), "to@example.com");
  assert.equal(egress.get("Multipart-Subtype"), "mixed");
  assert.equal(egress.get("message:to"), null);
});

test("the six open-vocabulary families that changed spelling bridge as Tika's own test says", () => {
  const egress = apply(
    bundled("V4_TO_V3"),
    metadataOf({
      "html:og:description": "a page",
      "html:scriptSrc": "https://example.com/x.js", // declared: its flat row beats the strip
      "img:Image Description": "t1",
      "message:raw-header:X-Originating-IP": "10.0.0.1",
      "rtf:pict:wmetafile": "8",
      "icc:Blue Colorant": "(0.1, 0.2, 0.3)",
      "mbox:from": "someone@example.com",
    }),
  );
  assert.equal(egress.get("og:description"), "a page");
  assert.equal(egress.get("html_meta:scriptSrc"), "https://example.com/x.js");
  assert.equal(egress.get("Image Description"), "t1");
  assert.equal(egress.get("Message:Raw-Header:X-Originating-IP"), "10.0.0.1");
  assert.equal(egress.get("rtf_pict:wmetafile"), "8");
  assert.equal(egress.get("ICC:Blue Colorant"), "(0.1, 0.2, 0.3)");
  assert.equal(egress.get("MboxParser-from"), "someone@example.com");
  assert.equal(egress.get("html:og:description"), null);
  assert.equal(egress.get("html:scriptSrc"), null);
  assert.equal(egress.get("img:Image Description"), null);
  assert.equal(egress.get("mbox:from"), null);

  const ingest = apply(
    bundled("V3_TO_V4"),
    metadataOf({
      "html_meta:scriptSrc": "https://example.com/x.js",
      "Message:Raw-Header:X-Originating-IP": "10.0.0.1",
      "rtf_pict:wmetafile": "8",
      "ICC:Blue Colorant": "(0.1, 0.2, 0.3)",
      "MboxParser-from": "someone@example.com",
      "og:description": "a page", // bare in 3.x: no marker, so it passes through
      "Image Description": "t1",
    }),
  );
  assert.equal(ingest.get("html:scriptSrc"), "https://example.com/x.js");
  assert.equal(ingest.get("message:raw-header:X-Originating-IP"), "10.0.0.1");
  assert.equal(ingest.get("rtf:pict:wmetafile"), "8");
  assert.equal(ingest.get("icc:Blue Colorant"), "(0.1, 0.2, 0.3)");
  assert.equal(ingest.get("mbox:from"), "someone@example.com");
  assert.equal(ingest.get("og:description"), "a page");
  assert.equal(ingest.get("Image Description"), "t1");
  assert.equal(ingest.get("ICC:Blue Colorant"), null);
  assert.equal(ingest.get("MboxParser-from"), null);
});

// What follows is ripstream's own, over the whole bundled table and the edges the Tika test does not reach.

test("the generated table is the one upstream ships: its checksum is the data file's", () => {
  const data = readFileSync(new URL("../data/upstream/metadata-migration-3x-4x.json", import.meta.url), "utf8");
  const generated = readFileSync(new URL("../src/generated/metadata-migration.ts", import.meta.url), "utf8");
  assert.ok(generated.includes(`// metadata-migration-3x-4x sha256: ${createHash("sha256").update(data).digest("hex")}\n`));
  assert.deepEqual(METADATA_MIGRATION_ROWS, JSON.parse(data));
});

test("the bundled table has 253 rows: 4 dropped and 15 egress-only", () => {
  assert.equal(METADATA_MIGRATION_ROWS.length, 253);
  assert.equal(METADATA_MIGRATION_ROWS.filter((row) => row.v4 === METADATA_MIGRATION_DROPPED).length, 4);
  assert.equal(METADATA_MIGRATION_ROWS.filter((row) => row.egressOnly === true).length, 15);
});

test("no 4.x spelling is the target of two rows, and no 3.x spelling of two rows that ingest reads", () => {
  const v4 = METADATA_MIGRATION_ROWS.filter((row) => row.v4 !== METADATA_MIGRATION_DROPPED).map((row) => row.v4);
  assert.equal(new Set(v4).size, v4.length);
  const v3 = METADATA_MIGRATION_ROWS.filter((row) => row.egressOnly !== true).map((row) => row.v3);
  assert.equal(new Set(v3).size, v3.length);
});

test("every row of the bundled table is applied on egress, but a dropped one", () => {
  const filter = bundled("V4_TO_V3");
  for (const row of METADATA_MIGRATION_ROWS) {
    if (row.v4 === METADATA_MIGRATION_DROPPED) continue;
    const metadata = apply(filter, metadataOf({ [row.v4]: "value" }));
    assert.deepEqual(metadata.names(), [row.v3], `${row.v4} -> ${row.v3}`);
    assert.equal(metadata.get(row.v3), "value", row.v4);
  }
});

test("every row of the bundled table is applied on ingest, but an egress-only one, and a dropped one is removed", () => {
  const filter = bundled("V3_TO_V4");
  for (const row of METADATA_MIGRATION_ROWS) {
    const metadata = apply(filter, metadataOf({ [row.v3]: "value" }));
    if (row.egressOnly === true) {
      assert.equal(metadata.get(row.v3), "value", `${row.v3} (egress-only) must pass through on ingest`);
    } else if (row.v4 === METADATA_MIGRATION_DROPPED) {
      assert.deepEqual(metadata.names(), [], `${row.v3} is dropped on ingest`);
    } else {
      assert.deepEqual(metadata.names(), [row.v4], `${row.v3} -> ${row.v4}`);
    }
  }
});

test("a dropped row is not applied on egress: the 4.x name does not exist, and a key of that name is left alone", () => {
  const metadata = apply(bundled("V4_TO_V3"), metadataOf({ DROPPED: "x", "pst:folderPath": "/Inbox" }));
  assert.equal(metadata.get("DROPPED"), "x");
  assert.equal(metadata.get("pst:folderPath"), "/Inbox");
});

test("a key goes 4.x to 3.x to 4.x unchanged, for every row that ingest reads", () => {
  const egress = bundled("V4_TO_V3");
  const ingest = bundled("V3_TO_V4");
  for (const row of METADATA_MIGRATION_ROWS) {
    if (row.egressOnly === true || row.v4 === METADATA_MIGRATION_DROPPED) continue;
    const metadata = apply(ingest, apply(egress, metadataOf({ [row.v4]: "value" })));
    assert.deepEqual(metadata.names(), [row.v4], row.v4);
  }
});

test("a key goes 3.x to 4.x to 3.x unchanged, for every row that ingest reads", () => {
  const egress = bundled("V4_TO_V3");
  const ingest = bundled("V3_TO_V4");
  for (const row of METADATA_MIGRATION_ROWS) {
    if (row.egressOnly === true || row.v4 === METADATA_MIGRATION_DROPPED) continue;
    const metadata = apply(egress, apply(ingest, metadataOf({ [row.v3]: "value" })));
    assert.deepEqual(metadata.names(), [row.v3], row.v3);
  }
});

test("every digest algorithm is renamed in both directions, with or without an encoding", () => {
  const algorithms: ReadonlyArray<readonly [string, string]> = [
    ["SHA-1", "SHA1"], ["SHA-256", "SHA256"], ["SHA-384", "SHA384"], ["SHA-512", "SHA512"],
    ["SHA3-256", "SHA3_256"], ["SHA3-384", "SHA3_384"], ["SHA3-512", "SHA3_512"], ["MD2", "MD2"], ["MD5", "MD5"],
  ];
  for (const [v4, v3] of algorithms) {
    for (const encoding of ["", ":BASE32", ":BASE64", ":HEX"]) {
      assertMigrates("V4_TO_V3", `tk:digest:${v4}${encoding}`, `X-TIKA:digest:${v3}${encoding}`, "v");
      assertMigrates("V3_TO_V4", `X-TIKA:digest:${v3}${encoding}`, `tk:digest:${v4}${encoding}`, "v");
    }
  }
});

test("a digest algorithm that is not in the table keeps its name, as its encoding does", () => {
  assertMigrates("V4_TO_V3", "tk:digest:BLAKE2B:BASE64", "X-TIKA:digest:BLAKE2B:BASE64", "v");
  assertMigrates("V3_TO_V4", "X-TIKA:digest:BLAKE2B", "tk:digest:BLAKE2B", "v");
  assertMigrates("V4_TO_V3", "tk:digest:SHA256", "X-TIKA:digest:SHA256", "v");
  assertMigrates("V3_TO_V4", "X-TIKA:digest:SHA-256", "tk:digest:SHA-256", "v");
});

test("a digest key is read on the direction's own prefix only", () => {
  const egress = apply(bundled("V4_TO_V3"), metadataOf({ "X-TIKA:digest:SHA256": "a", "tk:digest:SHA-1": "b" }));
  assert.equal(egress.get("X-TIKA:digest:SHA256"), "a");
  assert.equal(egress.get("X-TIKA:digest:SHA1"), "b");
  const ingest = apply(bundled("V3_TO_V4"), metadataOf({ "tk:digest:SHA-256": "a", "X-TIKA:digest:SHA1": "b" }));
  assert.equal(ingest.get("tk:digest:SHA-256"), "a");
  assert.equal(ingest.get("tk:digest:SHA-1"), "b");
});

test("the geotopic alternate-location key takes its three words and a numeric index, and nothing else", () => {
  for (const [v4, v3] of [
    ["geotopic:alt-name0", "Optional_NAME0"],
    ["geotopic:alt-longitude7", "Optional_LONGITUDE7"],
    ["geotopic:alt-latitude123", "Optional_LATITUDE123"],
  ] as const) {
    assertMigrates("V4_TO_V3", v4, v3, "v");
    assertMigrates("V3_TO_V4", v3, v4, "v");
  }
  for (const key of ["geotopic:alt-name", "geotopic:alt-foo1", "geotopic:alt-name1x", "geotopic:alt-NAME1", "geotopic:alt-name-1", "geotopic:alt-name\n1"]) {
    const metadata = apply(bundled("V4_TO_V3"), metadataOf({ [key]: "v" }));
    assert.equal(metadata.get(key), "v", JSON.stringify(key));
  }
  for (const key of ["Optional_NAME", "Optional_FOO1", "Optional_NAME1x", "Optional_name1", "xOptional_NAME1", "Optional_NAME1\n"]) {
    const metadata = apply(bundled("V3_TO_V4"), metadataOf({ [key]: "v" }));
    assert.equal(metadata.get(key), "v", JSON.stringify(key));
  }
});

test("a prefix rule reads the whole of the prefix and is case-sensitive", () => {
  for (const key of ["ner", "NER:PERSON", "Ner:PERSON", "nerd:x", "envi", "iwork", "xner:PERSON"]) {
    const metadata = apply(bundled("V4_TO_V3"), metadataOf({ [key]: "v" }));
    assert.equal(metadata.get(key), "v", key);
  }
  assertMigrates("V4_TO_V3", "ner:", "NER_", "v");
});

test("a flat row beats a prefix rule that would also match", () => {
  const metadata = apply(bundled("V4_TO_V3"), metadataOf({ "hdf:file-type-description": "x", "gdal:driver": "y", "audio:channels": "z" }));
  assert.equal(metadata.get("File-Type-Description"), "x");
  assert.equal(metadata.get("Driver"), "y");
  assert.equal(metadata.get("channels"), "z");
  assert.equal(metadata.get("file-type-description"), null);
  assert.equal(metadata.get("driver"), null);
});

test("a key no rule reads passes through, on both directions, with its values", () => {
  for (const direction of ["V4_TO_V3", "V3_TO_V4"] as const) {
    const metadata = apply(bundled(direction), metadataOf({ "dc:title": ["a", "b"], "Content-Type": "text/plain", made_up: "x" }));
    assert.deepEqual(metadata.getAll("dc:title"), ["a", "b"]);
    assert.equal(metadata.get("Content-Type"), "text/plain");
    assert.equal(metadata.get("made_up"), "x");
  }
});

test("a renamed key's values are added to the target's values when the target is already there", () => {
  const filter = withRows("V4_TO_V3", [{ v3: "old", v4: "new" }]);
  const metadata = apply(filter, metadataOf({ old: ["1"], new: ["2", "3"] }));
  assert.deepEqual(metadata.getAll("old"), ["1", "2", "3"]);
  assert.equal(metadata.get("new"), null);
});

test("every document in the list is migrated", () => {
  const list = [metadataOf({ "tk:content": "a" }), metadataOf({ "tk:content": "b" })];
  bundled("V4_TO_V3").filter(list, new ParseContext());
  assert.deepEqual(list.map((metadata) => metadata.get("X-TIKA:content")), ["a", "b"]);
});

test("the direction is egress, V4_TO_V3, unless it is given", () => {
  const metadata = apply(new LegacyKeyMigrationFilter(), metadataOf({ "tk:content": "x" }));
  assert.equal(metadata.get("X-TIKA:content"), "x");
});

test("a direction that is not one of the two is refused, naming both", () => {
  assert.throws(() => new LegacyKeyMigrationFilter({ direction: "UP" as LegacyKeyMigrationDirection }), /V4_TO_V3.*V3_TO_V4|V3_TO_V4.*V4_TO_V3/);
  assert.throws(() => new LegacyKeyMigrationFilter({ direction: "v4_to_v3" as LegacyKeyMigrationDirection }), RangeError);
});

test("a row that is not a pair of key names is refused", () => {
  assert.throws(() => withRows("V4_TO_V3", [{ v3: "", v4: "x" }]), /v3/);
  assert.throws(() => withRows("V4_TO_V3", [{ v3: "x", v4: "" }]), /v4/);
  assert.throws(() => withRows("V4_TO_V3", [{ v3: 1, v4: "x" } as unknown as MetadataMigrationRow]), /v3/);
});

test("the rows given are copied, so a later change to them changes nothing", () => {
  const rows: MetadataMigrationRow[] = [{ v3: "old", v4: "new" }];
  const filter = withRows("V4_TO_V3", rows);
  rows.push({ v3: "other-old", v4: "other-new" });
  const metadata = apply(filter, metadataOf({ new: "1", "other-new": "2" }));
  assert.equal(metadata.get("old"), "1");
  assert.equal(metadata.get("other-new"), "2");
});

test("an egress-only row is applied on egress and not on ingest, in a table of the caller's", () => {
  const rows: MetadataMigrationRow[] = [{ v3: "version", v4: "mp3:version", egressOnly: true }];
  assert.equal(apply(withRows("V4_TO_V3", rows), metadataOf({ "mp3:version": "x" })).get("version"), "x");
  assert.equal(apply(withRows("V3_TO_V4", rows), metadataOf({ version: "x" })).get("version"), "x");
});

test("a prefix is read from the start of a key only", () => {
  const strips = ["hdf:", "netcdf:", "gdal:", "isatab:", "mp4:", "network:", "audio:", "html:", "img:"];
  for (const prefix of strips) {
    for (const key of [`x${prefix}foo`, `${prefix.toUpperCase()}foo`]) {
      const metadata = apply(bundled("V4_TO_V3"), metadataOf({ [key]: "v" }));
      assert.equal(metadata.get(key), "v", key);
    }
  }
  for (const key of ["xgeotopic:alt-name1", "geotopic:alt-name1x", "xtk:digest:SHA-256", "xicc:Blue", "my-mdb-prop:Title"]) {
    const metadata = apply(bundled("V4_TO_V3"), metadataOf({ [key]: "v" }));
    assert.equal(metadata.get(key), "v", key);
  }
  for (const key of ["xX-TIKA:digest:SHA1", "xOptional_NAME1", "myNER_PERSON"]) {
    const metadata = apply(bundled("V3_TO_V4"), metadataOf({ [key]: "v" }));
    assert.equal(metadata.get(key), "v", key);
  }
});

test("a key that starts like a 4.x family is left alone on ingest, because 3.x never wrote it bare", () => {
  const keys = ["hdf:foo", "netcdf:foo", "gdal:foo", "isatab:foo", "mp4:foo", "network:foo", "audio:foo", "html:foo", "img:foo"];
  const metadata = apply(bundled("V3_TO_V4"), metadataOf(Object.fromEntries(keys.map((key) => [key, "v"]))));
  assert.deepEqual(metadata.names().sort(), [...keys].sort());
});

test("a row that maps a key to itself keeps it where it is, and keeps a prefix rule from stripping it", () => {
  const filter = withRows("V4_TO_V3", [{ v3: "hdf:keep", v4: "hdf:keep" }]);
  const metadata = apply(filter, metadataOf({ "hdf:keep": "1", "dc:title": "t", "hdf:strip": "2" }));
  assert.deepEqual(metadata.names(), ["hdf:keep", "dc:title", "strip"]);
  assert.equal(metadata.get("hdf:keep"), "1");
});

test("when two rows name the same key, the later one counts, as it does in Tika", () => {
  const rows: MetadataMigrationRow[] = [
    { v3: "first", v4: "shared" },
    { v3: "second", v4: "shared" },
  ];
  assert.equal(apply(withRows("V4_TO_V3", rows), metadataOf({ shared: "x" })).get("second"), "x");
  const sameV3: MetadataMigrationRow[] = [
    { v3: "shared", v4: "first" },
    { v3: "shared", v4: "second" },
  ];
  assert.equal(apply(withRows("V3_TO_V4", sameV3), metadataOf({ shared: "x" })).get("second"), "x");
});
