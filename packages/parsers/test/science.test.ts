import assert from "node:assert/strict";
import { test } from "node:test";
import { BodyContentHandler, Metadata, ParseContext, RipstreamInputStream } from "@spikedpunch/ripstream-core";
import { ScienceMetadataParser } from "../src/index.ts";

test("reads scientific/CAD header metadata", async () => {
  const mat = new Uint8Array(128);
  mat.set([...new TextEncoder().encode("MATLAB 5.0 MAT-file")], 0);
  mat.set([0, 1], 124);
  mat.set([0x49, 0x4d], 126);
  const netcdf = new Uint8Array(16);
  netcdf.set([0x43, 0x44, 0x46, 1], 0);
  const grib = new Uint8Array(8);
  grib.set([...new TextEncoder().encode("GRIB")], 0);
  grib[7] = 1;
  const dwg = new Uint8Array(8);
  dwg.set([...new TextEncoder().encode("AC1018")], 0);
  for (const [bytes, format] of [
    [mat, "MAT-file"],
    [netcdf, "NetCDF"],
    [grib, "GRIB"],
    [dwg, "DWG"],
  ] as const) {
    const stream = await RipstreamInputStream.from(bytes);
    const metadata = new Metadata();
    await new ScienceMetadataParser().parse(stream, new BodyContentHandler(), metadata, new ParseContext());
    await stream.close();
    assert.equal(metadata.get("science:format"), format);
  }
});
