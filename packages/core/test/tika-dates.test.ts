import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inYearBounds,
  normalizeTikaDate,
  parseTikaDate,
  tikaDateMetadataString,
  tikaDateMetadataStringKeepPartial,
} from "../src/tika-dates.ts";

// Rows transcribed from Tika 4.2.0 TikaDatesTest (testNormalize, testRejected, testToMetadataString).
const NORMALIZE: ReadonlyArray<readonly [string, string]> = [
  ["2006-07-15T00:01:46+01:00", "2006-07-14T23:01:46Z"],
  ["2004-08-09T14:03:21-05:00", "2004-08-09T19:03:21Z"],
  ["2011-01-01T12:41:36Z", "2011-01-01T12:41:36Z"],
  ["2007-01-01T00:07+01:00", "2006-12-31T23:07:00Z"],
  ["2010-03-08T21:37-05:00", "2010-03-09T02:37:00Z"],
  ["2016-08-26T07:06Z", "2016-08-26T07:06:00Z"],
  ["2010-01-10T13:00:19", "2010-01-10T13:00:19Z"],
  ["2013-09-08T04:14:06.006", "2013-09-08T04:14:06Z"],
  ["2018-08-06T20:53:57.9843081+01:00", "2018-08-06T19:53:57Z"],
  ["2011-12-17T21:47:07.88+09:00", "2011-12-17T12:47:07Z"],
  ["2007-02-21T09:10:07.0+2:00", "2007-02-21T07:10:07Z"],
  ["2018-03-15T10:18:57+1:00", "2018-03-15T09:18:57Z"],
  ["2011-12-31T15:37:24.00986+03:30", "2011-12-31T12:07:24Z"],
  ["2010-05-09T21:34:38+0200", "2010-05-09T19:34:38Z"],
  ["2003-01-01 12:00:00 +0100", "2003-01-01T11:00:00Z"],
  ["2010-04-22 15:20 -0400", "2010-04-22T19:20:00Z"],
  ["2015-08-26T09:39", "2015-08-26T09:39:00Z"],
  ["2005-11-03", "2005-11-03T12:00:00Z"],
  ["2017-06-1", "2017-06-01T12:00:00Z"],
  ["1969-7-20", "1969-07-20T12:00:00Z"],
  ["D:20041028184621", "2004-10-28T18:46:21Z"],
  ["D:20080528153425+02'00'", "2008-05-28T13:34:25Z"],
  ["D:20030101120000+05'30'", "2003-01-01T06:30:00Z"],
  ["D:20030101120000+05'30", "2003-01-01T06:30:00Z"],
  ["D:20030101120000-08'00'", "2003-01-01T20:00:00Z"],
  ["D:20030101120000Z", "2003-01-01T12:00:00Z"],
  ["D:20030101120000Z00'00'", "2003-01-01T12:00:00Z"],
  ["D:200301011200", "2003-01-01T12:00:00Z"],
  ["D:20041109", "2004-11-09T12:00:00Z"],
  ["  D:20030101  ", "2003-01-01T12:00:00Z"],
  ["20030101120000", "2003-01-01T12:00:00Z"],
  ["2014:08:21 13:33:53", "2014-08-21T13:33:53Z"],
  ["2015:06:12", "2015-06-12T12:00:00Z"],
  ["2017:12:23 12:51:20Z", "2017-12-23T12:51:20Z"],
  ["Fri, 01 Dec 2006 00:06:00 GMT", "2006-12-01T00:06:00Z"],
  ["Fri, 03 Dec 1999 15:17:26 -0500 (EST)", "1999-12-03T20:17:26Z"],
  ["01 Aug 2001 11:14:22 -0400", "2001-08-01T15:14:22Z"],
  ["1 Apr 1999 11:40:10 -0500", "1999-04-01T16:40:10Z"],
  ["Fri, 16 Apr 93 08:25:04 -0400", "1993-04-16T12:25:04Z"],
  ["Fri, 4 Sep 98 00:24:11 -0600", "1998-09-04T06:24:11Z"],
  ["Fri, 01 Apr 1994 16:57 -0800 (PST)", "1994-04-02T00:57:00Z"],
  ["Fri, 01 Dec 2000 08:39:07", "2000-12-01T08:39:07Z"],
  ["Fri, 18 Jun 1993 9:42:24 -0400 (EDT)", "1993-06-18T13:42:24Z"],
  ["10 Jul 1996 13:23 EDT", "1996-07-10T17:23:00Z"],
  ["Fri, 1 Feb 91 18:33:59 PST", "1991-02-02T02:33:59Z"],
  ["Thu,  6 May 2004 10:12:09 +0200 (CEST)", "2004-05-06T08:12:09Z"],
  ["Fri, 12 Apr 2002 18:56:49 -0400 (Eastern Daylight Time)", "2002-04-12T22:56:49Z"],
  ["Fri, 19 Oct 2007 10:23:52 -0600 (GMT-06:00)", "2007-10-19T16:23:52Z"],
  ["Fri, 16 Jan 2004 10:45:33 0000", "2004-01-16T10:45:33Z"],
  ["15 Nov 94 09:44:30 -5", "1994-11-15T14:44:30Z"],
  ["Thursday, 18 December 1997 11:31pm", "1997-12-18T23:31:00Z"],
  ["29 Jan 2014", "2014-01-29T12:00:00Z"],
  ["9 November 2001", "2001-11-09T12:00:00Z"],
  ["3 March, 2017", "2017-03-03T12:00:00Z"],
  ["Friday, April 02, 1999 1:20:07 PM", "1999-04-02T13:20:07Z"],
  ["Fri, Nov 15, 1996 6:58 AM", "1996-11-15T06:58:00Z"],
  ["Friday, December 12, 2008, 11:28 AM", "2008-12-12T11:28:00Z"],
  ["Fri, May 11, 2012 at 6:06 PM", "2012-05-11T18:06:00Z"],
  ["Monday, August 12, 1996 5:13PM", "1996-08-12T17:13:00Z"],
  ["Fri, Mar 9, 2012 20:23", "2012-03-09T20:23:00Z"],
  ["Monday, October 29, 2001 10:13", "2001-10-29T10:13:00Z"],
  ["Friday, June 2, 2000   3:45 PM PDT", "2000-06-02T22:45:00Z"],
  ["Friday, February 19 2010 13:31:33 CET", "2010-02-19T12:31:33Z"],
  ["August 12, 1999", "1999-08-12T12:00:00Z"],
  ["April 5, 1989", "1989-04-05T12:00:00Z"],
  ["Aug 13 2008", "2008-08-13T12:00:00Z"],
  ["Fri Jan 18  2008", "2008-01-18T12:00:00Z"],
  ["Wed May 23 2018 17:52:58 GMT+0200", "2018-05-23T15:52:58Z"],
  ["Fri Apr 10 04:00:33 PDT 1992", "1992-04-10T11:00:33Z"],
  ["Fri Apr  2 04:00:22 PST 1999", "1999-04-02T12:00:22Z"],
  ["Fri Aug 01 10:21:01 2014 -0700", "2014-08-01T17:21:01Z"],
  ["Fri Apr 20 13:38:50 2007", "2007-04-20T13:38:50Z"],
  ["THU JAN 01 22:51:33 1970", "1970-01-01T22:51:33Z"],
  ["5/12/2008", "2008-05-12T12:00:00Z"],
  ["12/31/2008 13:14:15", "2008-12-31T13:14:15Z"],
  ["23/12/2009 16:52:18", "2009-12-23T16:52:18Z"],
  ["13/09/2016", "2016-09-13T12:00:00Z"],
  ["2/22/2016 4:00:00 PM", "2016-02-22T16:00:00Z"],
  ["09/09/2018, 20:47", "2018-09-09T20:47:00Z"],
  ["08/14/18", "2018-08-14T12:00:00Z"],
  ["5/4/05", "2005-05-04T12:00:00Z"],
  ["17/4/13 14:10", "2013-04-17T14:10:00Z"],
  ["2016/01/15 14:27:04", "2016-01-15T14:27:04Z"],
  ["2009/8/26", "2009-08-26T12:00:00Z"],
  ["96/1/02", "1996-01-02T12:00:00Z"],
  ["96/12/2", "1996-12-02T12:00:00Z"],
  ["2017-11-20T13:5836", "2017-11-20T13:58:36Z"],
  ["2018-09-13T18.20.16Z", "2018-09-13T18:20:16Z"],
  ["2006-06-19T12:37:3Z", "2006-06-19T12:37:03Z"],
  ["2012-08-02T19:22:29:93", "2012-08-02T19:22:29Z"],
  ["2008-01-14T19:43:09Z00:00", "2008-01-14T19:43:09Z"],
  ["2016-01-14T11:27:45-6':00", "2016-01-14T17:27:45Z"],
  ["2017-12-31 07:09:59 PM", "2017-12-31T19:09:59Z"],
  ["D:2018-08-02T16:06:22+02'00'", "2018-08-02T14:06:22Z"],
  ["D:20160308221458Z'", "2016-03-08T22:14:58Z"],
  ["D:20210712135012+02'00''", "2021-07-12T11:50:12Z"],
  ["D:20190221101345-6'00'", "2019-02-21T16:13:45Z"],
  ["8/11/2008 14:8:23", "2008-08-11T14:08:23Z"],
  ["Wednesday, 16/02/2011", "2011-02-16T12:00:00Z"],
  ["2006-10-18 16:01:00 -0700 (Wed, 18 Oct 2006)", "2006-10-18T23:01:00Z"],
  ["Mon, 29 Oct 2007 20:20:52 -0500From: someone", "2007-10-30T01:20:52Z"],
  ["Thu, 27 Aug 1998 08:39:32 +0200 <br>", "1998-08-27T06:39:32Z"],
  ["Sat, 19 Jun 93 16:34:27 JST", "1993-06-19T07:34:27Z"],
  ["Wed, 16 Aug 2000 4:19:1 GMT", "2000-08-16T04:19:01Z"],
  ["15 Oct 99 13:47:26 BST", "1999-10-15T13:47:26Z"],
  ["2010-07-28T11:02:12.000CEST", "2010-07-28T09:02:12Z"],
  ["7-JUL-1994 02:36:51.00", "1994-07-07T02:36:51Z"],
  ["Tuesday, 04-Jul-95 06:04:28 GMT", "1995-07-04T06:04:28Z"],
  ["April 18th, 2000", "2000-04-18T12:00:00Z"],
  ["Nov. 21, 1998", "1998-11-21T12:00:00Z"],
];

const REJECTED: readonly string[] = [
  "0-01-01T00:00:00Z",
  "0-00-00T00:00:00Z",
  "0000-01-01T00:00:00Z",
  "0-00-00",
  "9999-12-31",
  "9999/12/31",
  "10000-01-01T00:59:59+01:00",
  "406-04-16T07:15:00Z",
  "2/23/201",
  "00:15:54",
  "2:16:58",
  "2014-07-18T05:44:470Z",
  "2015:06:12 10:11:",
  "2016-13-01",
  "2016-02-30",
  "23/13/2009",
  "5/12/8",
  "18/02/98 25:00",
  "11658090",
  "137912",
  "1057298",
  "0",
  "+02:00",
  "()",
  "CPY Document Creation Date",
  "Mon, 7 Jan 2008 08:47:01 0100 (CET)",
  "10 Jun 1998 09:07:34 U",
  "December 15, 2005 Report No. LOXA05-004",
  "2015-09-28T04:47:26-16:00",
  "2017-09-12T02:10:54-21:00",
  "2015-09-28T17:25:50+17:00",
  "2017-05-11T19:05:84",
  "D:20080702212348+20'00'",
  "D:2012010510394209'00'",
  "D:191010111144159",
  "D:20170112095532--4'00'",
];

const METADATA_STRING: ReadonlyArray<readonly [string, string]> = [
  ["2006-07-15T00:01:46+01:00", "2006-07-14T23:01:46Z"],
  ["2016-08-26T07:06Z", "2016-08-26T07:06:00Z"],
  ["2010-01-10T13:00:19", "2010-01-10T13:00:19"],
  ["2013-09-08T04:14:06.006", "2013-09-08T04:14:06"],
  ["2015-08-26T09:39", "2015-08-26T09:39:00"],
  ["D:20041028184621", "2004-10-28T18:46:21"],
  ["D:20080528153425+02'00'", "2008-05-28T13:34:25Z"],
  ["2014:08:21 13:33:53", "2014-08-21T13:33:53"],
  ["Fri, 01 Dec 2000 08:39:07", "2000-12-01T08:39:07"],
  ["Fri, 01 Dec 2006 00:06:00 GMT", "2006-12-01T00:06:00Z"],
  ["2005-11-03", "2005-11-03"],
  ["2015:06:12", "2015-06-12"],
  ["D:20041109", "2004-11-09"],
  ["August 12, 1999", "1999-08-12"],
];

test("every row of Tika's normalize table is read as Tika reads it", () => {
  for (const [raw, expected] of NORMALIZE) assert.equal(normalizeTikaDate(raw), expected, JSON.stringify(raw));
});

test("every row of Tika's rejected table is refused", () => {
  for (const raw of REJECTED) assert.equal(normalizeTikaDate(raw), null, JSON.stringify(raw));
});

test("every row of Tika's stored-form table is stored as Tika stores it", () => {
  for (const [raw, expected] of METADATA_STRING) assert.equal(tikaDateMetadataString(raw), expected, JSON.stringify(raw));
});

test("the mail forms with a zone all mean 2016-05-09T01:32:00Z", () => {
  for (const raw of [
    "Mon, 9 May 16 01:32:00 GMT", "9 May 16 01:32:00 GMT", "Monday, 9 May 16 01:32:00 GMT",
    "Mon, 9 May 2016 01:32:00 UTC", "9 May 2016 01:32:00 UTC", "09 May 2016 01:32:00 UTC",
    "Mon, 9 May 2016 01:32:00Z", "Mon, 9 May 2016 01:32:00 Z", "Mon, 9 May 2016 01:32:00 GMT",
    "Mon, 9 May 2016 01:32:00GMT", "Mon, 9 May 2016 01:32:00UTC",
    "Mon, 9 May 2016 3:32:00 GMT+0200", "Mon, 9 May 2016 3:32:00 UTC+0200",
    "Mon, 9 May 2016 7:32:00 UTC+0600 (BST)", "       9 May 2016 3:32:00 +0200",
    "      Mon, 9 May 2016 3:32:00 +0200", "Mon, 9 May 2016 3:32:00 +02:00", "9 May 2016 3:32:00 +02:00",
    "Mon, 9 May 2016 3:32:00+02:00", "Mon, 9 May 2016 3:32:00+0200", "      Sun, 8 May 2016 21:32:00 EDT",
  ]) {
    assert.equal(normalizeTikaDate(raw), "2016-05-09T01:32:00Z", raw);
  }
});

test("the forms with no zone read as UTC and are stored with none", () => {
  for (const raw of [
    "Mon, 9 May 2016 01:32:00", "Monday, 9 May 2016 1:32 AM", "May 9 2016 1:32am", "May 9 2016 1:32 am", "2016-05-09 01:32:00",
  ]) {
    assert.equal(normalizeTikaDate(raw), "2016-05-09T01:32:00Z", raw);
    assert.equal(tikaDateMetadataString(raw), "2016-05-09T01:32:00", raw);
  }
});

test("the date-only forms mean midday UTC", () => {
  for (const raw of ["May 15, 2016", "Sun, 15 May 2016", "15 May 2016", "2016-05-15"]) {
    assert.equal(normalizeTikaDate(raw), "2016-05-15T12:00:00Z", raw);
  }
});

test("a named zone is a fixed offset all year", () => {
  assert.equal(normalizeTikaDate("Sun, 8 May 2016 21:32:00 EST"), "2016-05-09T02:32:00Z");
});

test("the slash forms land in 1980..2010 as Tika's regression list does", () => {
  for (const raw of [
    "11/14/08", "1/14/08", "1/2/08", "12/1/2008", "12/02/1996", "96/1/02", "96/12/02", "96/12/2", "1996/12/02",
    "Mon, 29 Jan 96 14:02 GMT", "7/20/95 1:12PM", "08/14/2000  12:48 AM", "8/4/2000  1:48 AM", "8/1/03",
    "Wed, 27 Dec 95 11:20:40 EST", "26 Aug 00 11:14:52 EDT",
  ]) {
    const n = normalizeTikaDate(raw);
    assert.ok(n !== null && n > "1980" && n < "2010", `${raw} -> ${n}`);
  }
});

test("a hyphenated year is not an offset", () => {
  assert.equal(normalizeTikaDate("10-10-2022 not a date"), null);
});

test("a partial date keeps its precision in the stored form for a source-specific key", () => {
  assert.equal(tikaDateMetadataStringKeepPartial("2018"), "2018");
  assert.equal(tikaDateMetadataStringKeepPartial("2018-05"), "2018-05");
  assert.equal(tikaDateMetadataStringKeepPartial("2018-05-01"), "2018-05-01");
  for (const junk of ["", "   ", "0", "18", "0312", "2018 2018", "[www.example.com]"]) {
    assert.equal(tikaDateMetadataStringKeepPartial(junk), null, JSON.stringify(junk));
  }
});

test("the year bounds are 1000 to 2200 inclusive, in UTC", () => {
  assert.equal(inYearBounds(Date.parse("2012-02-20T16:44:22Z")), true);
  assert.equal(inYearBounds(Date.parse("1000-01-01T00:00:00Z")), true);
  assert.equal(inYearBounds(Date.parse("2200-12-31T23:59:59Z")), true);
  assert.equal(inYearBounds(Date.parse("0999-12-31T23:59:59Z")), false);
  assert.equal(inYearBounds(Date.parse("2201-01-01T00:00:00Z")), false);
  assert.equal(inYearBounds(Date.parse("0004-12-31T23:00:00Z")), false);
  assert.equal(inYearBounds(Date.parse("+031135-02-07T00:18:29Z")), false);
  assert.equal(inYearBounds(Number.NaN), false);
});

test("null, undefined, empty and blank are not dates", () => {
  assert.equal(normalizeTikaDate(null), null);
  assert.equal(normalizeTikaDate(undefined), null);
  assert.equal(normalizeTikaDate(""), null);
  assert.equal(normalizeTikaDate("   "), null);
  assert.equal(parseTikaDate(null), null);
});

test("a year, and a year and month, are partial dates that normalize refuses", () => {
  assert.equal(parseTikaDate("2019")?.precision, "YEAR");
  assert.equal(parseTikaDate("2019-06")?.precision, "MONTH");
  assert.equal(parseTikaDate("D:2003")?.precision, "YEAR");
  assert.equal(parseTikaDate("2019")?.isFullPrecision, false);
  assert.equal(normalizeTikaDate("2019"), null);
  assert.equal(normalizeTikaDate("2019-06"), null);
  assert.equal(normalizeTikaDate("D:2003"), null);
});

test("a partial date is day 1 at midday, with no zone", () => {
  const year = parseTikaDate("2019")!;
  assert.deepEqual([year.year, year.month, year.day, year.hour, year.minute, year.second, year.hasZone], [2019, 1, 1, 12, 0, 0, false]);
  const month = parseTikaDate("2019-06")!;
  assert.deepEqual([month.year, month.month, month.day, month.hour], [2019, 6, 1, 12]);
});

test("precision and zone follow what the value says", () => {
  const bare = parseTikaDate("2010-01-10T13:00:19")!;
  assert.equal(bare.precision, "SECOND");
  assert.equal(bare.hasZone, false);
  assert.equal(parseTikaDate("2010-01-10T13:00:19Z")?.hasZone, true);
  assert.equal(parseTikaDate("2016-08-26T07:06Z")?.precision, "MINUTE");
  assert.equal(parseTikaDate("2005-11-03")?.precision, "DAY");
  assert.equal(parseTikaDate("2005-11-03")?.isFullPrecision, true);
});

test("a normalized value normalizes to itself", () => {
  for (const raw of [
    "2006-07-15T00:01:46+01:00", "D:20080528153425+02'00'", "Fri, 01 Dec 2006 00:06:00 GMT", "2005-11-03", "2014:08:21 13:33:53",
  ]) {
    const n = normalizeTikaDate(raw);
    assert.equal(normalizeTikaDate(n), n, raw);
  }
});

test("a stored value reads back to the same instant, zone, day-only flag and local time", () => {
  for (const raw of [
    "2006-07-15T00:01:46+01:00", "2010-01-10T13:00:19", "2015-08-26T09:39", "D:20041028184621", "2014:08:21 13:33:53",
    "2005-11-03", "Fri, 01 Dec 2006 00:06:00 GMT",
  ]) {
    const a = parseTikaDate(raw)!;
    const stored = a.toMetadataString();
    const b = parseTikaDate(stored)!;
    assert.equal(a.epochSeconds, b.epochSeconds, raw);
    assert.equal(a.hasZone, b.hasZone, raw);
    assert.equal(a.precision === "DAY", b.precision === "DAY", raw);
    if (!a.hasZone) assert.deepEqual(localOf(a), localOf(b), raw);
    assert.equal(tikaDateMetadataString(stored), stored, raw);
  }
});

function localOf(date: { year: number; month: number; day: number; hour: number; minute: number; second: number }): number[] {
  return [date.year, date.month, date.day, date.hour, date.minute, date.second];
}

test("a partial or unreadable value has no stored form", () => {
  assert.equal(tikaDateMetadataString("2019"), null);
  assert.equal(tikaDateMetadataString("2019-06"), null);
  assert.equal(tikaDateMetadataString("0-01-01T00:00:00Z"), null);
  assert.equal(tikaDateMetadataString(null), null);
});

test("a hostile run of parentheses is read in linear time, as Tika's timeout test requires", () => {
  const started = Date.now();
  for (const prefix of ["", "1", "MON ", "JAN "]) {
    const hostile = prefix + "(".repeat(100_000);
    assert.equal(parseTikaDate(hostile), null);
    assert.equal(parseTikaDate(`${hostile})X`), null);
  }
  assert.notEqual(parseTikaDate(`2020-01-01T10:00:00Z${" ".repeat(1000)}`), null);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("an explicit UTC marker with a redundant zero offset is still a zone", () => {
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00Z00:00"), "2020-01-01T10:00:00Z");
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00Z0000"), "2020-01-01T10:00:00Z");
  assert.equal(parseTikaDate("2020-01-01T10:00:00Z00:00")?.hasZone, true);
});

test("a ctime zone name that is unknown means zone unknown, and a known one must agree with the offset", () => {
  assert.equal(tikaDateMetadataString("Wed Jan 1 10:00:00 IST 2020"), "2020-01-01T10:00:00");
  assert.equal(tikaDateMetadataString("Wed Jan 1 10:00:00 EST 2020"), "2020-01-01T15:00:00Z");
  assert.equal(tikaDateMetadataString("Wed Jan 1 10:00:00 EST 2020 -0500"), "2020-01-01T15:00:00Z");
  assert.equal(tikaDateMetadataString("Wed Jan 1 10:00:00 EST 2020 +0100"), null);
});

test("the offset range is -12:00 to +14:00, minutes included", () => {
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00+14:00"), "2019-12-31T20:00:00Z");
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00-12:00"), "2020-01-01T22:00:00Z");
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00+05:45"), "2020-01-01T04:15:00Z");
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00+14:45"), null);
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00-12:30"), null);
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00+05:60"), null);
});

test("an offset on a bare date is read and then ignored: a date-only value has no zone", () => {
  assert.equal(tikaDateMetadataString("2020-01-01+14:00"), "2020-01-01");
  assert.equal(normalizeTikaDate("2020-01-01+14:00"), "2020-01-01T12:00:00Z");
  assert.equal(parseTikaDate("2020-01-01-12:00")?.hasZone, false);
  assert.equal(normalizeTikaDate("2020-01-01+15:00"), null);
});

test("a day that does not exist is refused, and February 29 only in a leap year of the proleptic Gregorian calendar", () => {
  assert.equal(normalizeTikaDate("2016-02-29"), "2016-02-29T12:00:00Z");
  assert.equal(normalizeTikaDate("2000-02-29"), "2000-02-29T12:00:00Z");
  assert.equal(normalizeTikaDate("2015-02-29"), null);
  assert.equal(normalizeTikaDate("1900-02-29"), null);
  assert.equal(normalizeTikaDate("2100-02-29"), null);
  assert.equal(normalizeTikaDate("2016-04-31"), null);
  assert.equal(normalizeTikaDate("2016-04-30"), "2016-04-30T12:00:00Z");
  assert.equal(normalizeTikaDate("2016-12-32"), null);
  assert.equal(normalizeTikaDate("2016-01-00"), null);
  assert.equal(normalizeTikaDate("2016-00-10"), null);
});

test("an hour, minute or second out of range is refused", () => {
  assert.equal(normalizeTikaDate("2016-05-09T24:00:00Z"), null);
  assert.equal(normalizeTikaDate("2016-05-09T23:60:00Z"), null);
  assert.equal(normalizeTikaDate("2016-05-09T23:59:60Z"), null);
  assert.equal(normalizeTikaDate("2016-05-09T23:59:59Z"), "2016-05-09T23:59:59Z");
  assert.equal(normalizeTikaDate("2016-05-09T00:00:00Z"), "2016-05-09T00:00:00Z");
});

test("12 AM is midnight, 12 PM is noon, and an hour outside 1..12 with AM or PM is refused", () => {
  assert.equal(normalizeTikaDate("2016-05-09 12:30 AM"), "2016-05-09T00:30:00Z");
  assert.equal(normalizeTikaDate("2016-05-09 12:30 PM"), "2016-05-09T12:30:00Z");
  assert.equal(normalizeTikaDate("2016-05-09 1:30 PM"), "2016-05-09T13:30:00Z");
  assert.equal(normalizeTikaDate("2016-05-09 0:30 AM"), null);
  assert.equal(normalizeTikaDate("2016-05-09 13:30 PM"), null);
});

test("the year bounds apply to the instant: a local time just inside is outside once its offset is applied", () => {
  assert.equal(normalizeTikaDate("1000-01-01T00:00:00Z"), "1000-01-01T00:00:00Z");
  assert.equal(normalizeTikaDate("1000-01-01T00:00:00+01:00"), null);
  assert.equal(normalizeTikaDate("2200-12-31T23:59:59Z"), "2200-12-31T23:59:59Z");
  assert.equal(normalizeTikaDate("2200-12-31T23:59:59-01:00"), null);
  assert.equal(normalizeTikaDate("2201-01-01T00:00:00Z"), null);
  assert.equal(normalizeTikaDate("0999-12-31"), null);
});

test("a value is trimmed as Java trims it: control characters go and a no-break space stays", () => {
  assert.equal(normalizeTikaDate("\u0001\u0002 2005-11-03 \u001f"), "2005-11-03T12:00:00Z");
  assert.equal(normalizeTikaDate(" 2005-11-03"), null);
  assert.equal(normalizeTikaDate("2005-11-03 "), null);
  assert.equal(normalizeTikaDate("﻿2005-11-03"), null);
});

test("only ASCII whitespace inside a value is a space, and runs of it are one", () => {
  assert.equal(normalizeTikaDate("2016-05-09 \t 01:32:00 \n Z"), "2016-05-09T01:32:00Z");
  assert.equal(normalizeTikaDate("2016-05-09 01:32:00Z"), null);
  assert.equal(normalizeTikaDate("May 9 2016"), null);
});

test("only ASCII digits and letters make a date", () => {
  assert.equal(normalizeTikaDate("٢٠١٦-05-09"), null);
  assert.equal(normalizeTikaDate("2016-٠٥-09"), null);
  assert.equal(normalizeTikaDate("١ Jan 2016"), null);
  assert.equal(normalizeTikaDate("Maý 9 2016"), null);
});

test("the text of a value is read in upper case, so month and zone names take any case", () => {
  assert.equal(normalizeTikaDate("mon, 9 may 2016 01:32:00 gmt"), "2016-05-09T01:32:00Z");
  assert.equal(normalizeTikaDate("MAY 9 2016 1:32pm est"), "2016-05-09T18:32:00Z");
  assert.equal(normalizeTikaDate("2016-05-09t01:32:00z"), "2016-05-09T01:32:00Z");
});

test("a value of 256 characters is read and one of 257 is not read at all", () => {
  const padded = (length: number): string => {
    const head = "2020-01-01T10:00:00Z (";
    return `${head}${"a".repeat(length - head.length - 1)})`;
  };
  assert.equal(padded(256).length, 256);
  assert.equal(normalizeTikaDate(padded(256)), "2020-01-01T10:00:00Z");
  assert.equal(normalizeTikaDate(padded(257)), null);
});

test("a zone name of two to five letters that Tika does not know means the zone is unknown, one letter or six is refused", () => {
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00ZJUNK"), "2020-01-01T10:00:00");
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00 ABCDE"), "2020-01-01T10:00:00");
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00 ABCDEF"), null);
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00 Q"), null);
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00 Z"), "2020-01-01T10:00:00Z");
});

test("the named zones are the fixed offsets Tika lists", () => {
  const table: Record<string, number> = {
    UT: 0, UTC: 0, GMT: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, CET: 1, CEST: 2,
    MET: 1, MEST: 2, WET: 0, WEST: 1, EET: 2, EEST: 3, MSK: 3, JST: 9, HST: -10, AKST: -9, AKDT: -8, NZST: 12, NZDT: 13,
  };
  for (const [name, hours] of Object.entries(table)) {
    const utc = Date.parse("2020-06-15T12:00:00Z") - hours * 3_600_000;
    assert.equal(
      normalizeTikaDate(`2020-06-15T12:00:00 ${name}`),
      new Date(utc).toISOString().replace(".000Z", "Z"),
      name,
    );
  }
});

test("a two-digit year below 50 is 20xx and 50 or more is 19xx", () => {
  assert.equal(normalizeTikaDate("1 Jan 49"), "2049-01-01T12:00:00Z");
  assert.equal(normalizeTikaDate("1 Jan 50"), "1950-01-01T12:00:00Z");
  assert.equal(normalizeTikaDate("1 Jan 00"), "2000-01-01T12:00:00Z");
});

test("the parsed fields are the written ones, with the offset in seconds or null", () => {
  const date = parseTikaDate("2006-07-15T00:01:46+05:30")!;
  assert.deepEqual(
    [date.year, date.month, date.day, date.hour, date.minute, date.second, date.offsetSeconds],
    [2006, 7, 15, 0, 1, 46, 19_800],
  );
  assert.equal(parseTikaDate("2006-07-15T00:01:46")?.offsetSeconds, null);
  assert.equal(parseTikaDate("2006-07-15T00:01:46-08:00")?.offsetSeconds, -28_800);
  assert.equal(parseTikaDate("2006-07-15T00:01")?.second, 0);
  assert.ok(Object.is(parseTikaDate("2006-07-15T00:01:46-00:00")?.offsetSeconds, 0));
});

test("the epoch seconds read a zone-less value as UTC and a date-only one as midday UTC", () => {
  assert.equal(parseTikaDate("1970-01-01T00:00:00Z")?.epochSeconds, 0);
  assert.equal(parseTikaDate("1970-01-02T00:00:00")?.epochSeconds, 86_400);
  assert.equal(parseTikaDate("1970-01-01")?.epochSeconds, 43_200);
  assert.equal(parseTikaDate("2006-07-15T00:01:46+01:00")?.epochSeconds, Date.parse("2006-07-14T23:01:46Z") / 1000);
  assert.equal(parseTikaDate("1500-03-01T00:00:00Z")?.epochSeconds, Date.parse("1500-03-01T00:00:00Z") / 1000);
});

test("bare digits are a date only at 8, 12 or 14 digits", () => {
  assert.equal(normalizeTikaDate("20030101"), "2003-01-01T12:00:00Z");
  assert.equal(normalizeTikaDate("200301011200"), "2003-01-01T12:00:00Z");
  assert.equal(normalizeTikaDate("20030101120000"), "2003-01-01T12:00:00Z");
  for (const raw of ["200301", "2003010", "2003010112", "20030101120", "2003010112000", "200301011200001"]) {
    assert.equal(normalizeTikaDate(raw), null, raw);
  }
});

test("a D: date with an hour and no minute is refused, and one with a date only is read", () => {
  assert.equal(normalizeTikaDate("D:2003010112"), null);
  assert.equal(normalizeTikaDate("D:200301011200"), "2003-01-01T12:00:00Z");
  assert.equal(normalizeTikaDate("D:20030101"), "2003-01-01T12:00:00Z");
});

test("a D: date with a Z has a zone and one with none has not", () => {
  assert.equal(tikaDateMetadataString("D:20030101120000Z"), "2003-01-01T12:00:00Z");
  assert.equal(tikaDateMetadataString("D:20030101120000"), "2003-01-01T12:00:00");
  assert.equal(parseTikaDate("D:20030101120000Z")?.hasZone, true);
  assert.equal(parseTikaDate("D:20030101120000")?.hasZone, false);
});

test("a first field of 32 is a year in yy/M/d, and 31 is a day", () => {
  assert.equal(normalizeTikaDate("32/1/02"), "2032-01-02T12:00:00Z");
  assert.equal(normalizeTikaDate("31/12/2009"), "2009-12-31T12:00:00Z");
  assert.equal(normalizeTikaDate("12/31/2009"), "2009-12-31T12:00:00Z");
  assert.equal(normalizeTikaDate("12/12/2009"), "2009-12-12T12:00:00Z");
});

test("an offset may have minutes up to 59", () => {
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00+05:59"), "2020-01-01T04:01:00Z");
  assert.equal(normalizeTikaDate("2020-01-01T10:00:00-05:59"), "2020-01-01T15:59:00Z");
});

test("a two-letter zone name that Tika does not know means the zone is unknown", () => {
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00 AB"), "2020-01-01T10:00:00");
  assert.equal(tikaDateMetadataString("2020-01-01T10:00:00 UT"), "2020-01-01T10:00:00Z");
});

test("a zone name after an offset with a colon is redundant and is dropped", () => {
  assert.equal(normalizeTikaDate("01 Aug 2001 11:14:22 -04:00 EDT"), "2001-08-01T15:14:22Z");
  assert.equal(normalizeTikaDate("01 Aug 2001 11:14:22 -0400 EDT"), "2001-08-01T15:14:22Z");
  assert.equal(normalizeTikaDate("01 Aug 2001 11:14 +0200 CEST"), "2001-08-01T09:14:00Z");
});

test("a month name is a prefix of the full name of at least three letters, and nothing else", () => {
  assert.equal(normalizeTikaDate("1 Sept 2020"), "2020-09-01T12:00:00Z");
  assert.equal(normalizeTikaDate("1 Septem 2020"), "2020-09-01T12:00:00Z");
  assert.equal(normalizeTikaDate("1 September 2020"), "2020-09-01T12:00:00Z");
  assert.equal(normalizeTikaDate("1 JANXYZ 2020"), null);
  assert.equal(normalizeTikaDate("1 Marchh 2020"), null);
  assert.equal(normalizeTikaDate("1 Janu 2020"), "2020-01-01T12:00:00Z");
  assert.equal(normalizeTikaDate("1 Foo 2020"), null);
});

test("every ASCII whitespace character is a space inside a value, and a run of them is one", () => {
  for (const space of [" ", "\t", "\n", "\u000b", "\f", "\r"]) {
    assert.equal(normalizeTikaDate(`2014:08:21${space}13:33:53`), "2014-08-21T13:33:53Z", JSON.stringify(space));
  }
  assert.equal(normalizeTikaDate("2014:08:21  13:33:53"), "2014-08-21T13:33:53Z");
  assert.equal(normalizeTikaDate("2014:08:21 \t\n\u000b\f\r 13:33:53"), "2014-08-21T13:33:53Z");
});
