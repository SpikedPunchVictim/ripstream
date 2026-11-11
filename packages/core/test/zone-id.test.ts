import assert from "node:assert/strict";
import { test } from "node:test";
import { parseZoneId } from "../src/zone-id.ts";

/** Seconds of a local wall-clock time, read as if it were UTC: what `offsetAtLocal` is given. */
function local(text: string): number {
  return Date.parse(`${text}Z`) / 1000;
}

function offsetOf(id: string, wallClock: string): number {
  return parseZoneId(id).offsetAtLocal(local(wallClock));
}

test("UTC, GMT, UT and Z are offset zero, whatever the time", () => {
  for (const id of ["UTC", "GMT", "UT", "Z"]) {
    assert.equal(offsetOf(id, "2021-07-01T12:00:00"), 0, id);
    assert.equal(offsetOf(id, "1500-01-01T00:00:00"), 0, id);
  }
});

test("a numeric offset takes every form Java's ZoneOffset.of takes", () => {
  const forms: Array<[string, number]> = [
    ["+2", 7_200], ["-5", -18_000], ["+02", 7_200], ["+0200", 7_200], ["+02:00", 7_200], ["-05:30", -19_800],
    ["-0530", -19_800], ["+02:00:30", 7_230], ["+020030", 7_230], ["+00:00", 0], ["-00:00", 0], ["+18:00", 64_800], ["-18:00", -64_800],
  ];
  for (const [id, seconds] of forms) assert.equal(offsetOf(id, "2021-07-01T12:00:00"), seconds, id);
});

test("a numeric offset with a prefix is the same offset", () => {
  assert.equal(offsetOf("UTC+02:00", "2021-07-01T12:00:00"), 7_200);
  assert.equal(offsetOf("GMT-5", "2021-07-01T12:00:00"), -18_000);
  assert.equal(offsetOf("UT+1", "2021-07-01T12:00:00"), 3_600);
  assert.equal(offsetOf("UTC-0530", "2021-07-01T12:00:00"), -19_800);
});

test("an offset out of range or not in a form Java accepts is refused", () => {
  for (const id of ["+19:00", "+18:00:01", "+02:60", "+02:00:60", "+2:00", "+", "-", "+123", "+1a", "+٢", "02:00", "UTC+", "UTC+19", "GMT-2:00", "UT+x"]) {
    assert.throws(() => parseZoneId(id), RangeError, id);
  }
});

test("a region is refused when the platform has no such zone", () => {
  for (const id of ["", "Mars/Olympus_Mons", "New York", "A", "America/", "/UTC", "UTM"]) {
    assert.throws(() => parseZoneId(id), RangeError, JSON.stringify(id));
  }
});

test("a region id is case-sensitive, as Java's is", () => {
  assert.throws(() => parseZoneId("america/new_york"), RangeError);
  assert.throws(() => parseZoneId("AMERICA/NEW_YORK"), RangeError);
  assert.doesNotThrow(() => parseZoneId("America/New_York"));
});

test("a region follows its daylight saving: New York is -5 in winter and -4 in summer", () => {
  assert.equal(offsetOf("America/New_York", "2021-01-15T12:00:00"), -18_000);
  assert.equal(offsetOf("America/New_York", "2021-07-15T12:00:00"), -14_400);
});

test("a southern region has its summer in January", () => {
  assert.equal(offsetOf("Australia/Sydney", "2021-01-15T12:00:00"), 39_600);
  assert.equal(offsetOf("Australia/Sydney", "2021-07-15T12:00:00"), 36_000);
});

test("a region may be on a half or three-quarter hour, or a fourteen hour offset", () => {
  assert.equal(offsetOf("Asia/Kolkata", "2021-07-15T12:00:00"), 19_800);
  assert.equal(offsetOf("Asia/Kathmandu", "2021-07-15T12:00:00"), 20_700);
  assert.equal(offsetOf("Pacific/Kiritimati", "2021-07-15T12:00:00"), 50_400);
});

test("a region's past rules are read: London was on British Summer Time all year in 1970", () => {
  assert.equal(offsetOf("Europe/London", "1970-01-15T12:00:00"), 3_600);
  assert.equal(offsetOf("Europe/London", "1980-01-15T12:00:00"), 0);
});

test("a local time that does not exist is moved forward, as Java moves it: New York at 02:30 on 2021-03-14", () => {
  // The clocks went from 02:00 EST to 03:00 EDT. Java reads 02:30 as 03:30 EDT, which is 07:30Z.
  const offset = offsetOf("America/New_York", "2021-03-14T02:30:00");
  assert.equal(local("2021-03-14T02:30:00") - offset, Date.parse("2021-03-14T07:30:00Z") / 1000);
});

test("a local time that happens twice is the earlier one, as Java reads it: New York at 01:30 on 2021-11-07", () => {
  // 01:30 EDT (05:30Z) and 01:30 EST (06:30Z): Java keeps the earlier offset.
  const offset = offsetOf("America/New_York", "2021-11-07T01:30:00");
  assert.equal(local("2021-11-07T01:30:00") - offset, Date.parse("2021-11-07T05:30:00Z") / 1000);
});

test("a gap of half an hour is handled: Lord Howe at 02:15 on 2021-10-03", () => {
  // 02:00 +10:30 became 02:30 +11:00. Java reads 02:15 as 02:45 +11:00, which is 15:45Z the day before.
  const offset = offsetOf("Australia/Lord_Howe", "2021-10-03T02:15:00");
  assert.equal(local("2021-10-03T02:15:00") - offset, Date.parse("2021-10-02T15:45:00Z") / 1000);
});

test("the instants either side of a change use the offset in force", () => {
  assert.equal(offsetOf("America/New_York", "2021-03-14T01:59:59"), -18_000);
  assert.equal(offsetOf("America/New_York", "2021-03-14T03:00:00"), -14_400);
  assert.equal(offsetOf("America/New_York", "2021-11-07T00:59:59"), -14_400);
  assert.equal(offsetOf("America/New_York", "2021-11-07T02:00:00"), -18_000);
});

test("a zone keeps the id it was given", () => {
  assert.equal(parseZoneId("America/New_York").id, "America/New_York");
  assert.equal(parseZoneId("+02:00").id, "+02:00");
  assert.equal(parseZoneId("UTC").id, "UTC");
});
