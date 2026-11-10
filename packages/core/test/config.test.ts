import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RipstreamConfig,
  RipstreamConfigError,
  configGeneration,
  loadConfig,
  validateConfig,
} from "../src/index.ts";

test("loads a valid JSON configuration", () => {
  const before = configGeneration();
  const config = loadConfig(JSON.stringify({ version: 2, isolation: { mode: "off" } }));
  assert.ok(config.generation > before);
  assert.equal(config.version, 2);
  assert.equal(config.isolation?.mode, "off");
  assert.equal(RipstreamConfig.prototype.isPrototypeOf(config), true);
});

// Sections Tika's configuration has and ripstream does not apply. Accepting one would report success while changing
// nothing (measured: tasks/parity/audits/config-inventory.json), so each is refused by name. `parsers` left this list
// when createRipstream began applying it (tikajs-68os.8.6; see component-config.test.ts).
const UNAPPLIED_SECTIONS: ReadonlyArray<readonly [string, unknown]> = [
  ["detectors", [{ class: "org.example.Detector" }]],
  ["contentHandlers", [{ class: "org.example.Handler" }]],
  ["metadataFilters", [{ class: "org.example.Filter" }]],
  ["encodingDetector", { class: "org.example.Encoding" }],
];
for (const [section, value] of UNAPPLIED_SECTIONS) {
  test(`the ${section} section is refused, not silently ignored`, () => {
    for (const config of [{ [section]: value }, { [section]: [] }, { [section]: "nope" }]) {
      assert.deepEqual(validateConfig(config), [`"${section}" is not supported: ripstream would ignore it`]);
      assert.throws(() => loadConfig(config), RipstreamConfigError);
    }
  });
}

test("fails fast with all validation issues", () => {
  const issues = validateConfig({
    unknown: true,
    parsers: [{ maxDepth: 2 }],
    detectors: "nope",
    version: 0,
  });
  assert.equal(issues.length, 4);
  assert.throws(
    () => loadConfig(JSON.stringify({ parsers: [{}] })),
    RipstreamConfigError,
  );
  assert.throws(() => loadConfig("{"), RipstreamConfigError);
});

test("new configurations invalidate previous generations", () => {
  const first = loadConfig({});
  assert.equal(first.current, true);
  const second = loadConfig({});
  assert.equal(first.current, false);
  assert.equal(second.current, true);
});

test("isolation is null when unconfigured", () => {
  assert.equal(loadConfig({}).isolation, null);
  assert.equal(new RipstreamConfig().isolation, null);
  assert.deepEqual(validateConfig({ version: 1 }), []);
});

test("loads a valid isolation block as a frozen copy", () => {
  const source = {
    mode: "strict",
    requireStrictContainment: true,
    memoryPoolMb: 4096,
    perChildMb: 768,
    maxInputBytes: 1048576,
    maxTaskMillis: 30000,
    heapMb: 512,
    maxQueue: 8,
    maxDiskMb: 2048,
  };
  const config = loadConfig({ isolation: source });
  assert.deepEqual(config.isolation, source);
  assert.notEqual(config.isolation, source);
  assert.equal(Object.isFrozen(config.isolation), true);
  assert.deepEqual(loadConfig({ isolation: { mode: "off" } }).isolation, { mode: "off" });
  assert.equal(loadConfig({ isolation: { mode: "strict", maxQueue: 0 } }).isolation?.maxQueue, 0);
});

test("isolation validation rejects bad shapes and values", () => {
  const bad = (isolation: unknown): string[] => validateConfig({ isolation });
  assert.match(bad("strict").join(";"), /isolation must be an object/);
  assert.match(bad(null).join(";"), /isolation must be an object/);
  assert.match(bad([]).join(";"), /isolation must be an object/);
  assert.match(bad({}).join(";"), /isolation\.mode/);
  assert.match(bad({ mode: "paranoid" }).join(";"), /isolation\.mode/);
  assert.match(bad({ mode: "strict", surprise: 1 }).join(";"), /unknown key "surprise" in isolation/);
  assert.match(
    bad({ mode: "strict", requireStrictContainment: "yes" }).join(";"),
    /isolation\.requireStrictContainment must be a boolean/,
  );
  for (const field of [
    "memoryPoolMb",
    "perChildMb",
    "maxInputBytes",
    "maxTaskMillis",
    "heapMb",
    "maxQueue",
    "maxDiskMb",
  ]) {
    const rejected = [Number.NaN, -1, 0, -0, 1.5, Infinity, "10", null, Number.MAX_SAFE_INTEGER + 1];
    for (const value of field === "maxQueue" ? rejected.filter((v) => v !== 0) : rejected) {
      const issues = bad({ mode: "lenient", [field]: value });
      assert.equal(issues.length, 1, `${field}=${String(value)}`);
      assert.match(issues[0]!, new RegExp(`isolation\\.${field} must be an integer from`));
    }
  }
  assert.throws(() => loadConfig({ isolation: { mode: "nope" } }), RipstreamConfigError);
});

test("maxQueue accepts zero for load shedding; other numeric fields do not", () => {
  assert.deepEqual(validateConfig({ isolation: { mode: "strict", maxQueue: 0 } }), []);
  assert.equal(validateConfig({ isolation: { mode: "strict", maxQueue: -0 } }).length, 1);
  assert.equal(validateConfig({ isolation: { mode: "strict", maxQueue: -1 } }).length, 1);
  assert.equal(validateConfig({ isolation: { mode: "strict", perChildMb: 0 } }).length, 1);
});

test("isolation numeric fields have upper bounds", () => {
  const bad = (isolation: unknown): string[] => validateConfig({ isolation });
  assert.equal(bad({ mode: "off", heapMb: 2 ** 52 }).length, 1);
  assert.equal(bad({ mode: "off", memoryPoolMb: 1_048_577 }).length, 1);
  assert.equal(bad({ mode: "off", perChildMb: 1_048_577 }).length, 1);
  assert.equal(bad({ mode: "off", maxTaskMillis: 2_147_483_648 }).length, 1);
  assert.deepEqual(bad({ mode: "off", maxTaskMillis: 2_147_483_647 }), []);
  assert.deepEqual(bad({ mode: "off", heapMb: 1_048_576 }), []);
  assert.equal(bad({ mode: "off", maxDiskMb: 1_048_577 }).length, 1);
  assert.deepEqual(bad({ mode: "off", maxDiskMb: 1_048_576 }), []);
  assert.deepEqual(bad({ mode: "off", maxDiskMb: 1 }), []);
  assert.deepEqual(bad({ mode: "off", maxInputBytes: Number.MAX_SAFE_INTEGER }), []);
  assert.equal(bad({ mode: "off", maxInputBytes: Number.MAX_SAFE_INTEGER + 1 }).length, 1);
});

test("isolation cross-field consistency is enforced", () => {
  const bad = (isolation: unknown): string[] => validateConfig({ isolation });
  assert.match(
    bad({ mode: "strict", memoryPoolMb: 1024, perChildMb: 2048 }).join(";"),
    /perChildMb must not exceed isolation\.memoryPoolMb/,
  );
  assert.match(
    bad({ mode: "strict", perChildMb: 512, heapMb: 1024 }).join(";"),
    /heapMb must not exceed isolation\.perChildMb/,
  );
  assert.deepEqual(
    bad({ mode: "strict", memoryPoolMb: 2048, perChildMb: 768, heapMb: 512 }),
    [],
  );
  assert.deepEqual(bad({ mode: "strict", perChildMb: 768 }), []);
  assert.match(
    bad({ mode: "off", requireStrictContainment: true }).join(";"),
    /requireStrictContainment requires isolation\.mode to be strict/,
  );
  assert.equal(bad({ mode: "lenient", requireStrictContainment: true }).length, 1);
  assert.deepEqual(bad({ mode: "off", requireStrictContainment: false }), []);
  assert.deepEqual(bad({ mode: "strict", requireStrictContainment: true }), []);
});

test("isolation validation reads one copy of own data properties", () => {
  const bad = (isolation: unknown): string[] => validateConfig({ isolation });
  // inherited mode is not an own property
  assert.match(bad(Object.create({ mode: "strict" })).join(";"), /isolation\.mode/);
  assert.throws(
    () => loadConfig({ isolation: Object.create({ mode: "strict" }) }),
    RipstreamConfigError,
  );
  // non-enumerable own mode
  const hidden = Object.defineProperty({}, "mode", { value: "strict", enumerable: false });
  assert.match(bad(hidden).join(";"), /isolation\.mode/);
  // proxy that lies about its keys but answers get()
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => [],
      get: (_target, key) => (key === "mode" ? "strict" : undefined),
      getOwnPropertyDescriptor: () => undefined,
    },
  );
  assert.throws(() => loadConfig({ isolation: proxy }), RipstreamConfigError);
  // accessors are rejected outright, so a getter cannot change between reads
  let reads = 0;
  const getter = {
    get mode() {
      return reads++ === 0 ? "off" : "evil";
    },
  };
  assert.match(bad(getter).join(";"), /isolation\.mode must be a plain data property/);
  assert.throws(() => loadConfig({ isolation: getter }), RipstreamConfigError);
});

test("isolation rejects prototype-related and negative-zero keys", () => {
  const polluted = JSON.parse('{"isolation":{"mode":"off","__proto__":{"polluted":1}}}');
  assert.match(validateConfig(polluted).join(";"), /unknown key "__proto__" in isolation/);
  assert.throws(() => loadConfig(polluted), RipstreamConfigError);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.match(
    validateConfig({ isolation: { mode: "off", constructor: 1 } }).join(";"),
    /unknown key "constructor" in isolation/,
  );
});
