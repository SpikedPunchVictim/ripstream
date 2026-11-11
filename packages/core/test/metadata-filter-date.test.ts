import assert from "node:assert/strict";
import { test } from "node:test";
import { DateNormalizingMetadataFilter, Metadata, ParseContext } from "../src/index.ts";

function filterOne(filter: DateNormalizingMetadataFilter, values: Record<string, string | string[]>): Metadata {
  const metadata = new Metadata();
  for (const [name, value] of Object.entries(values)) {
    for (const each of Array.isArray(value) ? value : [value]) metadata.add(name, each);
  }
  filter.filter([metadata], new ParseContext());
  return metadata;
}

const CREATED = "dcterms:created";

test("a date with no zone is read in the default zone: Los Angeles is seven hours behind UTC in July", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "America/Los_Angeles" });
  assert.equal(filterOne(filter, { [CREATED]: "2021-07-23T01:02:24" }).get(CREATED), "2021-07-23T08:02:24Z");
});

test("an explicit offset is honoured and the default zone is not used", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "America/Los_Angeles" });
  const cases = [
    ["2010-05-09T21:34:38+0200", "2010-05-09T19:34:38Z"],
    ["2010-05-09T21:34:38+02:00", "2010-05-09T19:34:38Z"],
    ["2010-05-09T21:34:38-05:00", "2010-05-10T02:34:38Z"],
    ["2010-05-09T21:34:38.123+02:00", "2010-05-09T19:34:38Z"],
  ] as const;
  for (const [input, expected] of cases) assert.equal(filterOne(filter, { [CREATED]: input }).get(CREATED), expected, input);
});

test("a date-only value is midday in the default zone, a partial one is day 1 at midday, and junk is left as it is", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "America/New_York" });
  const cases = [
    ["2015-06-12", "2015-06-12T16:00:00Z"],
    ["2020-01-01T10:00:00Z00:00", "2020-01-01T10:00:00Z"],
    ["2018", "2018-01-01T17:00:00Z"],
    ["2018-06", "2018-06-01T16:00:00Z"],
    ["garbage", "garbage"],
    ["+999999999-12-31T23:59:59-10:00", "+999999999-12-31T23:59:59-10:00"],
  ] as const;
  for (const [input, expected] of cases) assert.equal(filterOne(filter, { [CREATED]: input }).get(CREATED), expected, input);
});

test("the default zone is UTC", () => {
  const filter = new DateNormalizingMetadataFilter();
  assert.equal(filterOne(filter, { [CREATED]: "2021-07-23T01:02:24" }).get(CREATED), "2021-07-23T01:02:24Z");
  assert.equal(filterOne(filter, { [CREATED]: "2021-07-23" }).get(CREATED), "2021-07-23T12:00:00Z");
  assert.equal(filter.defaultTimeZone, "UTC");
});

test("the filter reports the default zone it was given", () => {
  assert.equal(new DateNormalizingMetadataFilter({ defaultTimeZone: "America/New_York" }).defaultTimeZone, "America/New_York");
});

test("every value of a multi-valued date field is normalized, each in order", () => {
  const filter = new DateNormalizingMetadataFilter();
  const metadata = filterOne(filter, {
    "tk:signature:date": ["2010-05-09T21:34:38+02:00", "2011-01-01T00:00:00Z", "2012-06-01T08:00:00"],
  });
  assert.deepEqual(metadata.getAll("tk:signature:date"), ["2010-05-09T19:34:38Z", "2011-01-01T00:00:00Z", "2012-06-01T08:00:00Z"]);
});

test("one value that is not a date does not stop the rest of its field from being normalized", () => {
  const metadata = filterOne(new DateNormalizingMetadataFilter(), {
    "tk:signature:date": ["not a date", "2010-05-09T21:34:38+02:00", ""],
  });
  assert.deepEqual(metadata.getAll("tk:signature:date"), ["not a date", "2010-05-09T19:34:38Z", ""]);
});

test("a field that is not a date field is left alone, however much its value looks like one", () => {
  const metadata = filterOne(new DateNormalizingMetadataFilter(), {
    "dc:title": "2010-05-09T21:34:38+02:00",
    "made-up:created": "2010-05-09T21:34:38+02:00",
    "Content-Type": "text/plain",
  });
  assert.equal(metadata.get("dc:title"), "2010-05-09T21:34:38+02:00");
  assert.equal(metadata.get("made-up:created"), "2010-05-09T21:34:38+02:00");
  assert.equal(metadata.get("Content-Type"), "text/plain");
});

test("the name of a date field is matched exactly", () => {
  const metadata = filterOne(new DateNormalizingMetadataFilter(), {
    "DCTERMS:CREATED": "2010-05-09T21:34:38+02:00",
    "dcterms:Created": "2010-05-09T21:34:38+02:00",
  });
  assert.equal(metadata.get("DCTERMS:CREATED"), "2010-05-09T21:34:38+02:00");
  assert.equal(metadata.get("dcterms:Created"), "2010-05-09T21:34:38+02:00");
});

test("every date field Tika types as a date is normalized, wherever it comes from", () => {
  const names = ["dc:date", "dcterms:modified", "exif:DateTimeOriginal", "pdf:docinfo:created", "xmp:CreateDate", "mapi:creation-time", "fs:modified"];
  const metadata = filterOne(new DateNormalizingMetadataFilter(), Object.fromEntries(names.map((name) => [name, "2006-07-15T00:01:46+01:00"])));
  for (const name of names) assert.equal(metadata.get(name), "2006-07-14T23:01:46Z", name);
});

test("every document in the list is normalized", () => {
  const first = new Metadata();
  first.add(CREATED, "2006-07-15T00:01:46+01:00");
  const second = new Metadata();
  second.add("dcterms:modified", "D:20080528153425+02'00'");
  new DateNormalizingMetadataFilter().filter([first, second], new ParseContext());
  assert.equal(first.get(CREATED), "2006-07-14T23:01:46Z");
  assert.equal(second.get("dcterms:modified"), "2008-05-28T13:34:25Z");
});

test("a document with no date field is not changed", () => {
  const metadata = filterOne(new DateNormalizingMetadataFilter(), { "dc:title": "t" });
  assert.deepEqual(metadata.names(), ["dc:title"]);
});

test("the filter does not add a field the document did not have", () => {
  const metadata = filterOne(new DateNormalizingMetadataFilter(), { [CREATED]: "2006-07-15T00:01:46Z" });
  assert.deepEqual(metadata.names(), [CREATED]);
});

test("a value that is already canonical is unchanged", () => {
  const metadata = filterOne(new DateNormalizingMetadataFilter({ defaultTimeZone: "Asia/Tokyo" }), { [CREATED]: "2006-07-15T00:01:46Z" });
  assert.equal(metadata.get(CREATED), "2006-07-15T00:01:46Z");
});

test("a zone-less value in a zone whose offset has seconds or minutes is converted exactly", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "Asia/Kolkata" });
  assert.equal(filterOne(filter, { [CREATED]: "2021-07-23T12:00:00" }).get(CREATED), "2021-07-23T06:30:00Z");
});

test("a numeric default zone is accepted", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "-03:30" });
  assert.equal(filterOne(filter, { [CREATED]: "2021-07-23T12:00:00" }).get(CREATED), "2021-07-23T15:30:00Z");
});

test("a local time in a daylight saving gap is moved forward, and one that happens twice is the earlier", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "America/New_York" });
  assert.equal(filterOne(filter, { [CREATED]: "2021-03-14T02:30:00" }).get(CREATED), "2021-03-14T07:30:00Z");
  assert.equal(filterOne(filter, { [CREATED]: "2021-11-07T01:30:00" }).get(CREATED), "2021-11-07T05:30:00Z");
});

test("a default zone that is not a zone is refused when the filter is built, with the zone in the message", () => {
  assert.throws(() => new DateNormalizingMetadataFilter({ defaultTimeZone: "Mars/Olympus_Mons" }), /Mars\/Olympus_Mons/);
  assert.throws(() => new DateNormalizingMetadataFilter({ defaultTimeZone: "" }), RangeError);
});

test("a default zone that is not a string is refused", () => {
  assert.throws(() => new DateNormalizingMetadataFilter({ defaultTimeZone: 5 as unknown as string }), /defaultTimeZone/);
});

test("the default zone does not change what an explicit zone or a named zone means", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "Pacific/Kiritimati" });
  assert.equal(filterOne(filter, { [CREATED]: "Fri, 01 Dec 2006 00:06:00 GMT" }).get(CREATED), "2006-12-01T00:06:00Z");
  assert.equal(filterOne(filter, { [CREATED]: "10 Jul 1996 13:23 EDT" }).get(CREATED), "1996-07-10T17:23:00Z");
});

test("a mail date whose zone is unknown is read in the default zone", () => {
  const filter = new DateNormalizingMetadataFilter({ defaultTimeZone: "America/New_York" });
  assert.equal(filterOne(filter, { [CREATED]: "15 Oct 99 13:47:26 BST" }).get(CREATED), "1999-10-15T17:47:26Z");
});
