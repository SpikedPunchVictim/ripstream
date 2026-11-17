import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crc32 } from "node:zlib";
import { MemoryPool } from "@spikedpunch/ripstream-isolation-node";
import { LowYieldError, createRipstream } from "../src/index.ts";
import { createStandardIsolation, type StandardIsolation } from "../src/isolation.ts";

/*
 * The typed warnings of a result (tikajs-icjf) cross the isolation boundary as data: the same warnings come out of a real
 * standard child as out of this process, in text and in records mode, and onLowYield: "throw" is the same typed error.
 */

const encoder = new TextEncoder();
const pool = new MemoryPool({ poolMb: 16_384, maxQueue: 8 });
after(() => pool.dispose());

async function withStandard(action: (standard: StandardIsolation) => Promise<void>): Promise<void> {
  const standard = await createStandardIsolation({ config: { mode: "strict" }, pool });
  try {
    await action(standard);
  } finally {
    await standard.isolator.dispose();
  }
}

/** A ZIP with every entry stored (method 0). */
function storedZip(entries: Readonly<Record<string, string | Uint8Array>>): Uint8Array {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = Buffer.from(typeof value === "string" ? encoder.encode(value) : value);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

/** A one-page PDF that paints an image and shows no text: a scan. */
function scanPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    "<< /Length 28 >>\nstream\nq 612 0 0 792 0 0 cm /Im1 Do Q\nendstream",
    "<< /Length 1 /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray >>\nstream\n\xff\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const reference = createRipstream();

test("a scan gives the same warnings from a child as in this process, in text and in records mode", async () => {
  const scan = scanPdf();
  const expected = (await reference.parse(scan, { filename: "scan.pdf" })).warnings;
  assert.equal(expected.length, 1, "the reference has the warning");
  const expectedRecords = (await reference.parseRecursive(scan, { filename: "scan.pdf" })).map((record) => record.warnings);

  await withStandard(async ({ ripstream }) => {
    assert.deepEqual((await ripstream.parse(scan, { filename: "scan.pdf" })).warnings, expected);
    const records = await ripstream.parseRecursive(scan, { filename: "scan.pdf" });
    assert.deepEqual(records.map((record) => record.warnings), expectedRecords);
  });
});

test("a zip whose entries fail, and a scan inside one, give the same warnings from a child", async () => {
  const zip = storedZip({ "a.docx": "PK\u0003\u0004garbage", "b.pdf": "%PDF-1.4 garbage" });
  const withScan = storedZip({ "scan.pdf": scanPdf(), "ok.txt": "hello there" });
  await withStandard(async ({ ripstream }) => {
    for (const input of [zip, withScan]) {
      const expected = await reference.parse(input, { filename: "t.zip" });
      assert.ok(expected.warnings.length > 0);
      assert.deepEqual((await ripstream.parse(input, { filename: "t.zip" })).warnings, expected.warnings);
      const expectedRecords = (await reference.parseRecursive(input, { filename: "t.zip" })).map((record) => record.warnings);
      const records = await ripstream.parseRecursive(input, { filename: "t.zip" });
      assert.deepEqual(records.map((record) => record.warnings), expectedRecords);
    }
  });
});

test("a clean document gives an empty warnings array from a child", async () => {
  const zip = storedZip({ "ok.txt": "hello there" });
  await withStandard(async ({ ripstream }) => {
    assert.deepEqual((await ripstream.parse(zip, { filename: "t.zip" })).warnings, []);
    assert.deepEqual((await ripstream.parseRecursive(zip, { filename: "t.zip" })).map((record) => record.warnings), [[], []]);
  });
});

test("onLowYield: throw is the same LowYieldError from a child as in this process", async () => {
  const scan = scanPdf();
  const inProcess = await reference.parse(scan, { filename: "scan.pdf", onLowYield: "throw" }).catch((e: unknown) => e);
  assert.ok(inProcess instanceof LowYieldError);
  await withStandard(async ({ ripstream }) => {
    const error = await ripstream.parse(scan, { filename: "scan.pdf", onLowYield: "throw" }).catch((e: unknown) => e);
    assert.ok(error instanceof LowYieldError);
    assert.deepEqual(error.warnings, inProcess.warnings);
    assert.equal(error.code, "LOW_YIELD");
    const recursive = await ripstream.parseRecursive(scan, { filename: "scan.pdf", onLowYield: "throw" }).catch((e: unknown) => e);
    assert.ok(recursive instanceof LowYieldError);
    assert.equal((await ripstream.parse(scan, { filename: "scan.pdf", onLowYield: "record" })).warnings.length, 1);
  });
});
