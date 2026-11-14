import assert from "node:assert/strict";
import { test } from "node:test";
import { formatExcelDateCode, isDateFormat } from "../src/excel-format.ts";

// The values Tika/POI's DataFormatter writes for the formats in POI's 123233_charts.xlsx.
test("formats a date serial by the cell's format code", () => {
  assert.equal(formatExcelDateCode("mmm d, yyyy", 41506), "Aug 20, 2013");
  assert.equal(formatExcelDateCode("h:mm:ss AM/PM", 0.64604166), "3:30:17 PM");
  assert.equal(formatExcelDateCode("m/d/yy h:mm", 41506.64604166), "8/20/13 15:30");
});

// POI's DataFormatter: a bracketed unit counts the whole serial (tikajs-y2cl).
test("formats elapsed-time codes with the bracketed unit counting the whole serial", () => {
  assert.equal(formatExcelDateCode("[h]:mm", 1.5), "36:00");
  assert.equal(formatExcelDateCode("[h]:mm:ss", 1 + 2 / 24 + 3 / 1440 + 4 / 86400), "26:03:04");
  assert.equal(formatExcelDateCode("[mm]:ss", 0.0625), "90:00");
  assert.equal(formatExcelDateCode("[ss]", 0.001), "86");
});

test("keeps a bracketed color or locale code out of the output", () => {
  assert.equal(formatExcelDateCode("[Red]yyyy", 41506), "2013");
  assert.equal(formatExcelDateCode("[$-409]h:mm AM/PM", 0.5729166666666666), "1:45 PM");
});

test("treats elapsed-time codes as date formats", () => {
  assert.equal(isDateFormat("[h]:mm"), true);
  assert.equal(isDateFormat("[ss]"), true);
  assert.equal(isDateFormat("[Red]0.00"), false);
});
