import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import {
  defaultPoolMb,
  readCgroupLimits,
  validatePoolAgainstCgroup,
  type CgroupLimits,
} from "../src/cgroup.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function reader(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const content = files[path];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

function limits(overrides: Partial<CgroupLimits> = {}): CgroupLimits {
  return { memoryMaxBytes: null, memoryCurrentBytes: null, oomGroup: null, source: "host", ...overrides };
}

test("readCgroupLimits: cgroup v2 with a finite limit", () => {
  const result = readCgroupLimits(
    reader({
      "/sys/fs/cgroup/memory.max": "4294967296\n",
      "/sys/fs/cgroup/memory.current": "1048576\n",
      "/sys/fs/cgroup/memory.oom.group": "1\n",
    }),
    "linux",
  );
  assert.deepEqual(result, {
    memoryMaxBytes: 4294967296,
    memoryCurrentBytes: 1048576,
    oomGroup: true,
    source: "cgroup2",
  });
});

test("readCgroupLimits: cgroup v2 'max' means unlimited", () => {
  const result = readCgroupLimits(reader({ "/sys/fs/cgroup/memory.max": "max\n" }), "linux");
  assert.equal(result.memoryMaxBytes, null);
  assert.equal(result.source, "cgroup2");
  assert.equal(result.memoryCurrentBytes, null);
  assert.equal(result.oomGroup, null);
});

test("readCgroupLimits: oom.group 0 is false, junk is null", () => {
  const base = { "/sys/fs/cgroup/memory.max": "100" };
  assert.equal(readCgroupLimits(reader({ ...base, "/sys/fs/cgroup/memory.oom.group": "0" }), "linux").oomGroup, false);
  assert.equal(readCgroupLimits(reader({ ...base, "/sys/fs/cgroup/memory.oom.group": "x" }), "linux").oomGroup, null);
});

test("readCgroupLimits: garbage memory.max is unknown, not a number", () => {
  const result = readCgroupLimits(reader({ "/sys/fs/cgroup/memory.max": "banana" }), "linux");
  assert.equal(result.memoryMaxBytes, null);
  assert.equal(result.source, "cgroup2");
});

test("readCgroupLimits: cgroup v1 fallback with a finite limit", () => {
  const result = readCgroupLimits(
    reader({
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "5000",
    }),
    "linux",
  );
  assert.deepEqual(result, {
    memoryMaxBytes: 2147483648,
    memoryCurrentBytes: 5000,
    oomGroup: null,
    source: "cgroup1",
  });
});

test("readCgroupLimits: cgroup v1 huge value is unlimited", () => {
  for (const value of ["9223372036854771712", String(2 ** 60)]) {
    const result = readCgroupLimits(reader({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": value }), "linux");
    assert.equal(result.memoryMaxBytes, null, value);
    assert.equal(result.source, "cgroup1");
  }
});

test("readCgroupLimits: v2 wins over v1 when both exist", () => {
  const result = readCgroupLimits(
    reader({
      "/sys/fs/cgroup/memory.max": "1000",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2000",
    }),
    "linux",
  );
  assert.equal(result.source, "cgroup2");
  assert.equal(result.memoryMaxBytes, 1000);
});

test("readCgroupLimits: non-linux never reads files", () => {
  const result = readCgroupLimits(() => {
    throw new Error("must not be called");
  }, "darwin");
  assert.deepEqual(result, limits());
});

test("readCgroupLimits: no files at all degrades to host without throwing", () => {
  assert.deepEqual(readCgroupLimits(reader({}), "linux"), limits());
});

test("readCgroupLimits: default reader on this machine never throws", () => {
  const result = readCgroupLimits();
  assert.ok(["cgroup2", "cgroup1", "host"].includes(result.source));
});

// ---- the process's OWN cgroup, via /proc/self/cgroup (F8) -------------------------------------

const V2 = "/sys/fs/cgroup";
const V1 = "/sys/fs/cgroup/memory";

test("v2, namespaced root: 0::/ reads /sys/fs/cgroup/memory.max (a container with its own cgroup namespace)", () => {
  const result = readCgroupLimits(
    reader({ "/proc/self/cgroup": "0::/\n", [`${V2}/memory.max`]: "1073741824", [`${V2}/memory.current`]: "7" }),
    "linux",
  );
  assert.deepEqual(result, { memoryMaxBytes: 1073741824, memoryCurrentBytes: 7, oomGroup: null, source: "cgroup2" });
});

test("v2, no cgroup namespace (systemd MemoryMax=, docker --cgroupns=host): the limit is at the process's own path", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "0::/system.slice/ripstream.service\n",
      // The real root cgroup has no memory.max at all.
      [`${V2}/system.slice/ripstream.service/memory.max`]: "2147483648\n",
      [`${V2}/system.slice/ripstream.service/memory.current`]: "1000",
      [`${V2}/system.slice/ripstream.service/memory.oom.group`]: "1",
    }),
    "linux",
  );
  assert.deepEqual(result, { memoryMaxBytes: 2147483648, memoryCurrentBytes: 1000, oomGroup: true, source: "cgroup2" });
});

test("v2, nested: the SMALLEST limit on the way up to the root wins, and its usage and oom.group are reported", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "0::/a/b/c\n",
      [`${V2}/a/b/c/memory.max`]: "4294967296", // 4 GiB
      [`${V2}/a/b/c/memory.current`]: "1",
      [`${V2}/a/b/memory.max`]: "524288000", // 500 MiB: the tightest
      [`${V2}/a/b/memory.current`]: "2",
      [`${V2}/a/b/memory.oom.group`]: "0",
      [`${V2}/a/memory.max`]: "2147483648", // 2 GiB
      [`${V2}/memory.max`]: "8589934592", // 8 GiB
    }),
    "linux",
  );
  assert.deepEqual(result, { memoryMaxBytes: 524288000, memoryCurrentBytes: 2, oomGroup: false, source: "cgroup2" });
});

test("v2, nested: 'max' at some levels and missing files at others are skipped, not read as limits", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "0::/a/b/c\n",
      [`${V2}/a/b/c/memory.max`]: "max",
      // /a/b has no memory.max (controller not enabled for it)
      [`${V2}/a/memory.max`]: "3221225472",
      [`${V2}/memory.max`]: "max",
    }),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, 3221225472);
  assert.equal(result.source, "cgroup2");
});

test("v2, nested: 'max' everywhere is unlimited, still cgroup2", () => {
  const result = readCgroupLimits(
    reader({ "/proc/self/cgroup": "0::/a\n", [`${V2}/a/memory.max`]: "max", [`${V2}/memory.max`]: "max" }),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, null);
  assert.equal(result.source, "cgroup2");
});

test("v2, nested: a deeper level LARGER than its ancestor does not raise the limit", () => {
  const result = readCgroupLimits(
    reader({ "/proc/self/cgroup": "0::/a\n", [`${V2}/a/memory.max`]: "9000", [`${V2}/memory.max`]: "1000" }),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, 1000);
});

test("v2: the own directory missing (private namespace) falls back to the ancestors that exist", () => {
  const result = readCgroupLimits(
    reader({ "/proc/self/cgroup": "0::/kubepods/pod1/ctr\n", [`${V2}/memory.max`]: "123456" }),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, 123456);
});

test("an unreadable or garbage /proc/self/cgroup reads the root only, as before", () => {
  for (const proc of [undefined, "", "garbage without colons\n", "0:\n"]) {
    const files: Record<string, string> = { [`${V2}/memory.max`]: "555" };
    if (proc !== undefined) files["/proc/self/cgroup"] = proc;
    assert.equal(readCgroupLimits(reader(files), "linux").memoryMaxBytes, 555, String(proc));
  }
});

test("a cgroup path with .. segments is not walked: only the root is read", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "0::/../../x/y\n",
      [`${V2}/x/y/memory.max`]: "1",
      [`${V2}/memory.max`]: "777",
    }),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, 777);
});

/** A reader that behaves like a real filesystem: `..` is resolved before the lookup. Every request is recorded. */
function filesystem(files: Record<string, string>, requested: string[]): (path: string) => string {
  return (path) => {
    requested.push(path);
    const content = files[posix.normalize(path)];
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  };
}

const DOTDOT_PATHS = ["/../x", "/../../x/y", "/a/..", "/a/../b", "/x/../..", "/a/b/../../..", "/..", "/./../x"];

for (const cgroupPath of DOTDOT_PATHS) {
  test(`cgroup v2 path ${cgroupPath}: no file outside the mount root is ever requested`, () => {
    const requested: string[] = [];
    const result = readCgroupLimits(
      filesystem(
        {
          "/proc/self/cgroup": `0::${cgroupPath}\n`,
          // What the walk would reach if it followed the ".." segments out of the root:
          "/sys/memory.max": "1",
          "/sys/x/memory.max": "2",
          "/sys/x/y/memory.max": "3",
          "/sys/fs/memory.max": "4",
          [`${V2}/memory.max`]: "777",
        },
        requested,
      ),
      "linux",
    );
    assert.equal(result.memoryMaxBytes, 777);
    for (const path of requested) {
      assert.ok(!path.split("/").includes(".."), `requested ${path}`);
      assert.ok(path === "/proc/self/cgroup" || path.startsWith(`${V2}/`), `requested ${path}`);
    }
  });
}

test("cgroup v1 path with ..: no file outside the memory controller's mount root is ever requested", () => {
  const requested: string[] = [];
  const result = readCgroupLimits(
    filesystem(
      {
        "/proc/self/cgroup": "4:memory:/../../x\n",
        "/sys/fs/x/memory.limit_in_bytes": "1", // `${V1}/../../x`
        "/sys/x/memory.limit_in_bytes": "2",
        [`${V1}/memory.limit_in_bytes`]: "5000",
      },
      requested,
    ),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, 5000);
  for (const path of requested) {
    assert.ok(!path.split("/").includes(".."), `requested ${path}`);
    assert.ok(path === "/proc/self/cgroup" || path.startsWith(`${V1}/`) || path.startsWith(`${V2}/`), `requested ${path}`);
  }
});

test("v1: the memory controller line selects the path; the tightest limit up to the root wins", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "12:cpu,cpuacct:/docker/abc\n4:memory:/docker/abc/inner\n1:name=systemd:/docker/abc\n",
      [`${V1}/docker/abc/inner/memory.limit_in_bytes`]: "9223372036854771712", // unlimited
      [`${V1}/docker/abc/memory.limit_in_bytes`]: "1073741824",
      [`${V1}/docker/abc/memory.usage_in_bytes`]: "42",
      [`${V1}/memory.limit_in_bytes`]: "4294967296",
    }),
    "linux",
  );
  assert.deepEqual(result, { memoryMaxBytes: 1073741824, memoryCurrentBytes: 42, oomGroup: null, source: "cgroup1" });
});

test("v1 in a container: /proc names /docker/<id> but the mount root IS that cgroup, so only the root is visible", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "4:memory:/docker/abc\n",
      [`${V1}/memory.limit_in_bytes`]: "2147483648",
      [`${V1}/memory.usage_in_bytes`]: "9",
    }),
    "linux",
  );
  assert.deepEqual(result, { memoryMaxBytes: 2147483648, memoryCurrentBytes: 9, oomGroup: null, source: "cgroup1" });
});

test("v1: a controller list that merely contains 'memory' as a substring is not the memory controller", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "2:nomemory:/x\n",
      [`${V1}/x/memory.limit_in_bytes`]: "1",
      [`${V1}/memory.limit_in_bytes`]: "999",
    }),
    "linux",
  );
  assert.equal(result.memoryMaxBytes, 999);
});

test("hybrid hierarchy (v2 line plus a v1 memory line): no memory.max anywhere falls through to v1", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "4:memory:/user.slice\n0::/user.slice\n",
      [`${V1}/user.slice/memory.limit_in_bytes`]: "1000",
    }),
    "linux",
  );
  assert.equal(result.source, "cgroup1");
  assert.equal(result.memoryMaxBytes, 1000);
});

test("v2 wins over v1 when both are readable", () => {
  const result = readCgroupLimits(
    reader({
      "/proc/self/cgroup": "4:memory:/x\n0::/x\n",
      [`${V2}/x/memory.max`]: "10",
      [`${V1}/x/memory.limit_in_bytes`]: "20",
    }),
    "linux",
  );
  assert.deepEqual([result.source, result.memoryMaxBytes], ["cgroup2", 10]);
});

test("defaultPoolMb with a nested limit: the pool is sized from the tightest ancestor, not host RAM", () => {
  const result = readCgroupLimits(
    reader({ "/proc/self/cgroup": "0::/svc\n", [`${V2}/svc/memory.max`]: String(3 * 1024 * 1024 * 1024) }),
    "linux",
  );
  assert.equal(defaultPoolMb({ limits: result, hostTotalBytes: 64 * 1024 * 1024 * 1024 }), 3072 - 512);
});

test("non-safe integers are refused as byte counts and parentHeadroomMb", () => {
  assert.throws(() => defaultPoolMb({ limits: limits(), hostTotalBytes: 8 * GIB, parentHeadroomMb: 2 ** 53 }), RangeError);
  assert.throws(() => validatePoolAgainstCgroup({ requestedPoolMb: 2 ** 53, limits: limits() }), RangeError);
});

const poolCases: Array<{
  name: string;
  limits: CgroupLimits;
  hostTotalBytes: number;
  headroom?: number;
  expected: number;
}> = [
  { name: "cgroup limit wins over host memory", limits: limits({ memoryMaxBytes: 4 * GIB, source: "cgroup2" }), hostTotalBytes: 64 * GIB, expected: 4096 - 512 },
  { name: "host memory when unlimited", limits: limits(), hostTotalBytes: 8 * GIB, expected: 8192 - 512 },
  { name: "custom headroom", limits: limits({ memoryMaxBytes: 4 * GIB }), hostTotalBytes: 64 * GIB, headroom: 1024, expected: 3072 },
  { name: "exactly 1 GiB is accepted", limits: limits({ memoryMaxBytes: 1536 * MIB }), hostTotalBytes: 64 * GIB, expected: 1024 },
  { name: "result is whole MiB", limits: limits({ memoryMaxBytes: 2 * GIB + 1023 }), hostTotalBytes: 64 * GIB, expected: 1536 },
  // R3: a cgroup limit above the machine's RAM is not a limit; the host is the real ceiling.
  { name: "a cgroup limit above host RAM is capped at host RAM", limits: limits({ memoryMaxBytes: 200 * GIB, source: "cgroup2" }), hostTotalBytes: 16 * GIB, expected: 16384 - 512 },
  { name: "a cgroup limit equal to host RAM is that number", limits: limits({ memoryMaxBytes: 16 * GIB }), hostTotalBytes: 16 * GIB, expected: 16384 - 512 },
  { name: "a cgroup limit below host RAM still wins", limits: limits({ memoryMaxBytes: 8 * GIB }), hostTotalBytes: 16 * GIB, expected: 8192 - 512 },
];

for (const c of poolCases) {
  test(`defaultPoolMb: ${c.name}`, () => {
    const args = { limits: c.limits, hostTotalBytes: c.hostTotalBytes };
    const poolMb = defaultPoolMb(c.headroom === undefined ? args : { ...args, parentHeadroomMb: c.headroom });
    assert.equal(poolMb, c.expected);
  });
}

test("defaultPoolMb: when host RAM is the tighter number the message says host memory, not memory.max", () => {
  assert.throws(
    () => defaultPoolMb({ limits: limits({ memoryMaxBytes: 200 * GIB, source: "cgroup2" }), hostTotalBytes: 1024 * MIB }),
    (error: unknown) =>
      error instanceof RangeError && error.message.includes("host memory") && !error.message.includes("cgroup memory.max"),
  );
});

test("defaultPoolMb: below 1 GiB throws a message naming the numbers", () => {
  assert.throws(
    () => defaultPoolMb({ limits: limits({ memoryMaxBytes: 1024 * MIB, source: "cgroup2" }), hostTotalBytes: 64 * GIB }),
    (error: unknown) =>
      error instanceof RangeError &&
      error.message.includes("512 MiB") &&
      error.message.includes("1024 MiB") &&
      error.message.includes("cgroup memory.max"),
  );
});

test("defaultPoolMb: limit smaller than headroom is floored at 0 then rejected", () => {
  assert.throws(
    () => defaultPoolMb({ limits: limits({ memoryMaxBytes: 100 * MIB }), hostTotalBytes: 64 * GIB }),
    /would be 0 MiB/,
  );
});

test("defaultPoolMb: rejects bad inputs", () => {
  assert.throws(() => defaultPoolMb({ limits: limits(), hostTotalBytes: Number.NaN }), RangeError);
  assert.throws(
    () => defaultPoolMb({ limits: limits(), hostTotalBytes: 8 * GIB, parentHeadroomMb: -1 }),
    RangeError,
  );
  assert.throws(
    () => defaultPoolMb({ limits: limits(), hostTotalBytes: 8 * GIB, parentHeadroomMb: 1.5 }),
    RangeError,
  );
});

test("validatePoolAgainstCgroup: fitting request is unchanged", () => {
  const result = validatePoolAgainstCgroup({
    requestedPoolMb: 3584,
    limits: limits({ memoryMaxBytes: 4 * GIB }),
  });
  assert.deepEqual(result, { poolMb: 3584, warning: null });
});

test("validatePoolAgainstCgroup: oversize request is clamped with a warning", () => {
  const result = validatePoolAgainstCgroup({
    requestedPoolMb: 4096,
    limits: limits({ memoryMaxBytes: 4 * GIB }),
  });
  assert.equal(result.poolMb, 3584);
  assert.ok(result.warning?.includes("4096") && result.warning.includes("3584"));
});

test("validatePoolAgainstCgroup: clamped pool plus headroom never exceeds memory.max", () => {
  for (const requestedPoolMb of [1, 1000, 2047, 2048, 2049, 1_000_000]) {
    const { poolMb } = validatePoolAgainstCgroup({
      requestedPoolMb,
      limits: limits({ memoryMaxBytes: 2 * GIB }),
      parentHeadroomMb: 256,
    });
    assert.ok(poolMb + 256 <= 2048, `requested ${requestedPoolMb} -> ${poolMb}`);
  }
});

test("validatePoolAgainstCgroup: memory.max below headroom clamps to 0", () => {
  const result = validatePoolAgainstCgroup({
    requestedPoolMb: 2048,
    limits: limits({ memoryMaxBytes: 100 * MIB }),
  });
  assert.equal(result.poolMb, 0);
  assert.notEqual(result.warning, null);
});

test("validatePoolAgainstCgroup: unlimited cgroup leaves the request alone", () => {
  assert.deepEqual(validatePoolAgainstCgroup({ requestedPoolMb: 99999, limits: limits() }), {
    poolMb: 99999,
    warning: null,
  });
});

test("validatePoolAgainstCgroup: with hostTotalBytes, a cgroup limit above host RAM clamps to host RAM", () => {
  const result = validatePoolAgainstCgroup({
    requestedPoolMb: 100_000,
    limits: limits({ memoryMaxBytes: 200 * GIB, source: "cgroup2" }),
    hostTotalBytes: 16 * GIB,
  });
  assert.equal(result.poolMb, 16384 - 512);
  assert.ok(result.warning?.includes("100000") && result.warning.includes("16384"), String(result.warning));
});

test("validatePoolAgainstCgroup: a request that fits under min(cgroup, host) is unchanged", () => {
  const result = validatePoolAgainstCgroup({
    requestedPoolMb: 8000,
    limits: limits({ memoryMaxBytes: 200 * GIB }),
    hostTotalBytes: 16 * GIB,
  });
  assert.deepEqual(result, { poolMb: 8000, warning: null });
});

test("validatePoolAgainstCgroup: hostTotalBytes only caps a cgroup limit; with none, the request is left alone", () => {
  assert.deepEqual(validatePoolAgainstCgroup({ requestedPoolMb: 99999, limits: limits(), hostTotalBytes: 16 * GIB }), {
    poolMb: 99999,
    warning: null,
  });
});

test("validatePoolAgainstCgroup: a cgroup limit below host RAM is the one that clamps", () => {
  const result = validatePoolAgainstCgroup({
    requestedPoolMb: 8000,
    limits: limits({ memoryMaxBytes: 4 * GIB }),
    hostTotalBytes: 16 * GIB,
  });
  assert.equal(result.poolMb, 3584);
});

test("validatePoolAgainstCgroup: rejects a bad hostTotalBytes", () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validatePoolAgainstCgroup({ requestedPoolMb: 1, limits: limits(), hostTotalBytes: bad }), RangeError, String(bad));
  }
});

test("validatePoolAgainstCgroup: rejects bad inputs", () => {
  assert.throws(() => validatePoolAgainstCgroup({ requestedPoolMb: -1, limits: limits() }), RangeError);
  assert.throws(() => validatePoolAgainstCgroup({ requestedPoolMb: 1.5, limits: limits() }), RangeError);
});
