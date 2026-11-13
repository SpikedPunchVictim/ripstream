import assert from "node:assert/strict";
import { test } from "node:test";
import { formatExcelDateCode } from "../src/excel-format.ts";

// The values Tika/POI's DataFormatter writes for the formats in POI's 123233_charts.xlsx.
test("formats a date serial by the cell's format code", () => {
  assert.equal(formatExcelDateCode("mmm d, yyyy", 41506), "Aug 20, 2013");
  assert.equal(formatExcelDateCode("h:mm:ss AM/PM", 0.64604166), "3:30:17 PM");
  assert.equal(formatExcelDateCode("m/d/yy h:mm", 41506.64604166), "8/20/13 15:30");
});
