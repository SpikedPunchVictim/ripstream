import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_VMEM_KB,
  MIN_VMEM_KB,
  WRAPPER_SCRIPT,
  WRAPPER_SCRIPT_NO_VMEM,
  buildWrapperCommand,
  type WrapperOptions,
} from "../src/wrapper.ts";

const base: WrapperOptions = {
  nodePath: "/usr/local/bin/node",
  scriptPath: "/app/child.mjs",
  cpuSecs: 60,
  heapMb: 384,
  parentEnv: {},
  platform: "linux",
};

function build(overrides: Partial<Record<keyof WrapperOptions, unknown>> = {}) {
  return buildWrapperCommand({ ...base, ...overrides } as WrapperOptions);
}

test("runs /bin/sh -c with the constant script and $0 = sh", () => {
  const command = build();
  assert.deepEqual([command.file, ...command.args.slice(0, 3)], ["/bin/sh", "-c", WRAPPER_SCRIPT, "sh"]);
});

test("passes soft cpu, hard cpu (soft + 2), vmem as the first three positionals", () => {
  assert.deepEqual(build().args.slice(3, 6), ["60", "62", String(DEFAULT_VMEM_KB)]);
});

test("hard cpu limit is computed in JS as soft + 2", () => {
  assert.equal(build({ cpuSecs: 7 }).args[4], "9");
});

test("default vmem is 6144 MB", () => {
  assert.equal(DEFAULT_VMEM_KB, 6144 * 1024);
});

test("explicit vmem is passed through", () => {
  assert.equal(build({ vmemKb: 8_388_608 }).args[5], "8388608");
});

test("command line after the limits is node, heap flag, execArgv, script, script args in order", () => {
  const command = build({ execArgv: ["--no-warnings"], scriptArgs: ["--mode", "x"] });
  assert.deepEqual(command.args.slice(6), [
    "/usr/local/bin/node",
    "--max-old-space-size=384",
    "--no-warnings",
    "/app/child.mjs",
    "--mode",
    "x",
  ]);
});

test("script text is constant: it does not depend on any option", () => {
  const a = build({ cpuSecs: 5, heapMb: 100, scriptPath: "/a.mjs" });
  const b = build({ cpuSecs: 999, heapMb: 900, scriptPath: "/b; rm -rf /.mjs" });
  assert.equal(a.args[1], b.args[1]);
});

test("hostile path and args are positional, never part of the script text", () => {
  const evil = "$(touch /tmp/pwned); `id` \"'\n";
  const command = build({ scriptPath: `/x/${evil}.mjs`, scriptArgs: [evil] });
  assert.equal(command.args[1]?.includes("pwned"), false);
});

test("hostile path and args are passed through byte-for-byte", () => {
  const evil = "$(touch /tmp/pwned); `id` \"'\n";
  const command = build({ scriptArgs: [evil] });
  assert.equal(command.args.at(-1), evil);
});

test("empty script arguments are allowed", () => {
  assert.equal(build({ scriptArgs: [""] }).args.at(-1), "");
});

test("script fails closed after each ulimit step with exit 126", () => {
  const ulimitLines = WRAPPER_SCRIPT.split("\n").filter((line) => line.startsWith("ulimit"));
  assert.ok(ulimitLines.length === 3 && ulimitLines.every((line) => line.endsWith("|| exit 126")));
});

test("script applies soft cpu, then hard cpu, then vmem, then oom adjustment, then exec", () => {
  const order = ["ulimit -S -t", "ulimit -H -t", "ulimit -v", "oom_score_adj", 'exec "$@"'].map((needle) =>
    WRAPPER_SCRIPT.indexOf(needle),
  );
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
  assert.ok(order.every((index) => index >= 0));
});

test("oom_score_adj step is best effort (never aborts the wrapper)", () => {
  const line = WRAPPER_SCRIPT.split("\n").find((l) => l.includes("oom_score_adj"));
  assert.ok(line?.includes("2>/dev/null ||") && !line.includes("exit"));
});

test("the ulimit steps match reference.sh once variable names are normalised", () => {
  const normalise = (text: string): string[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("ulimit"))
      .map((line) => line.replace(/"\$[A-Z0-9]+"/, "X"));
  const reference = readFileSync(new URL("./chaos/reference.sh", import.meta.url), "utf8");
  assert.deepEqual(normalise(WRAPPER_SCRIPT), normalise(reference));
});

test("the oom_score_adj redirect matches reference.sh", () => {
  const reference = readFileSync(new URL("./chaos/reference.sh", import.meta.url), "utf8");
  assert.ok(reference.includes("{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null"));
  assert.ok(WRAPPER_SCRIPT.includes("{ echo 1000 > /proc/self/oom_score_adj; } 2>/dev/null"));
});

// ---- numeric validation --------------------------------------------------

const badNumbers: [string, unknown][] = [
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["float", 1.5],
  ["zero", 0],
  ["negative", -5],
  ["unsafe integer", 2 ** 60],
  ["numeric string", "60"],
  ["unlimited", "unlimited"],
  ["empty string", ""],
  ["null", null],
  ["undefined", undefined],
  ["bigint", 60n],
  ["object", {}],
];

for (const field of ["cpuSecs", "heapMb"] as const) {
  for (const [label, value] of badNumbers) {
    test(`${field} rejects ${label}`, () => {
      assert.throws(() => build({ [field]: value }), /safe integer|between/);
    });
  }
}

for (const [label, value] of badNumbers) {
  if (value === undefined) continue; // undefined means "use the default"
  test(`vmemKb rejects ${label}`, () => {
    assert.throws(() => build({ vmemKb: value }), /safe integer|between/);
  });
}

test("cpuSecs above the upper bound is rejected", () => {
  assert.throws(() => build({ cpuSecs: 86_401 }), RangeError);
});

test("cpuSecs at the upper bound is accepted", () => {
  assert.equal(build({ cpuSecs: 86_400 }).args[4], "86402");
});

test("heapMb above the upper bound is rejected", () => {
  assert.throws(() => build({ heapMb: 65_537 }), RangeError);
});

test("vmemKb below 4 GiB is rejected", () => {
  assert.throws(() => build({ vmemKb: MIN_VMEM_KB - 1 }), RangeError);
});

test("vmemKb exactly 4 GiB is accepted", () => {
  assert.equal(build({ vmemKb: MIN_VMEM_KB }).args[5], String(MIN_VMEM_KB));
});

test("vmemKb above the upper bound is rejected", () => {
  assert.throws(() => build({ vmemKb: 1_073_741_825 }), RangeError);
});

test("validation errors name the offending option", () => {
  assert.throws(() => build({ cpuSecs: -1 }), /cpuSecs/);
});

// ---- strings ---------------------------------------------------------------

test("nodePath must be non-empty", () => {
  assert.throws(() => build({ nodePath: "" }), TypeError);
});

test("nodePath must be a string", () => {
  assert.throws(() => build({ nodePath: 5 }), TypeError);
});

test("nodePath must not look like an option", () => {
  assert.throws(() => build({ nodePath: "-c" }), /nodePath/);
});

test("scriptPath must not look like a node option", () => {
  assert.throws(() => build({ scriptPath: "--eval" }), /scriptPath/);
});

test("scriptPath with NUL is rejected", () => {
  assert.throws(() => build({ scriptPath: "/a\0b" }), /NUL/);
});

test("scriptArgs with a non-string entry is rejected", () => {
  assert.throws(() => build({ scriptArgs: [1] }), /scriptArgs\[0\]/);
});

test("scriptArgs with NUL is rejected", () => {
  assert.throws(() => build({ scriptArgs: ["a\0"] }), /NUL/);
});

test("execArgv entries must be flags", () => {
  assert.throws(() => build({ execArgv: ["evil.js"] }), /execArgv\[0\]/);
});

// execArgv is an ALLOWLIST for bare flags. Node takes `--flag value` as well as `--flag=value` for any flag that
// needs a value, and which flags those are is knowledge about node and V8 (hundreds of them) that we cannot keep
// complete. A bare flag we do not know can swallow the NEXT word (a preload, code to eval, the script path itself,
// after which node reads a script from stdin). So a bare `--flag` must be on a short list of known booleans, and
// everything else must say its value: `--flag=value`. Short flags and `-` / `--` are refused outright.
for (const flag of [
  "-",
  "--",
  "-e",
  "-p",
  "-i",
  "-r",
  "-C",
  "-pe",
  "--require",
  "--import",
  "--eval",
  "--print",
  "--input-type",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "--env-file",
  "--title",
  "--stack-trace-limit",
  // a sample of the ~70 flags that make node swallow the next word, or change what it runs, when written bare:
  "--inspect-brk",
  "--inspect",
  "--inspect-wait",
  "--gc-interval",
  "--random-seed",
  "--trace",
  "--help",
  "--version",
  "--check",
  "--interactive",
  "--test",
  "--watch",
  "--run",
  "--expose-gc",
  "--prof",
  "--cpu-prof",
  "--abort-on-uncaught-exception",
  "--jitless",
  "--allow-natives-syntax",
  "--v8-options",
  "--completion-bash",
  "--experimental-default-type",
  "--some-flag-nobody-has-heard-of",
]) {
  test(`execArgv refuses the bare flag "${flag}"`, () => {
    assert.throws(() => build({ execArgv: [flag] }), TypeError);
  });
}

test("a bare flag followed by its value is refused at the flag, however the value looks", () => {
  assert.throws(() => build({ execArgv: ["--require", "-/evil.js"] }), /execArgv\[0\]/);
  assert.throws(() => build({ execArgv: ["--inspect-brk", "9229"] }), /execArgv\[0\]/);
});

const BARE_FLAGS_ACCEPTED = [
  "--no-warnings",
  "--no-deprecation",
  "--enable-source-maps",
  "--experimental-strip-types",
  "--experimental-wasm-modules",
  "--experimental-vm-modules",
];

for (const flag of BARE_FLAGS_ACCEPTED) {
  test(`execArgv accepts the known-boolean bare flag "${flag}"`, () => {
    const command = build({ execArgv: [flag] });
    assert.ok(command.args.includes(flag));
  });
}

test("execArgv accepts the --flag=value form for flags that are not about the heap or stack", () => {
  const flags = ["--require=./preload.cjs", "--import=./hook.mjs", "--input-type=module", "--stack-trace-limit=50", "--inspect-port=0"];
  const command = build({ execArgv: [...BARE_FLAGS_ACCEPTED, ...flags] });
  const first = command.args.indexOf(BARE_FLAGS_ACCEPTED[0] ?? "");
  assert.deepEqual(command.args.slice(first, first + BARE_FLAGS_ACCEPTED.length + flags.length), [...BARE_FLAGS_ACCEPTED, ...flags]);
});

test("the name rule looks at the flag name, not at its value", () => {
  assert.doesNotThrow(() => build({ execArgv: ["--require=./heap-helper.cjs", "--title=stack-size-test"] }));
});

// Heap, stack and memory shaping by name, in either form. heapMb is the only way to size the child's heap: the pool,
// the RSS limit and the cgroup arithmetic all assume it. (`--max-heap-size=4000` gives heap_size_limit 6208 MB with
// heapMb=64: it silently overrides --max-old-space-size.)
for (const flag of [
  "--max-heap-size=4000",
  "--max-heap-size",
  "--initial-heap-size=1",
  "--max-semi-space-size=64",
  "--min-semi-space-size=64",
  "--semi-space-growth-factor=4",
  "--max-old-space-size=99999",
  "--max-old-space-size-percentage=90",
  "--initial-old-space-size=4000",
  "--max-old-generation-size=4000",
  "--max-young-generation-size=4000",
  "--stack-size=900",
  "--stack-size",
  "--MAX-HEAP-SIZE=4000",
  "--max_heap_size=4000",
  "--max_semi_space_size=64",
  "--stack_size=900",
  "--huge-max-old-generation-size",
  "--heapsnapshot-signal=SIGUSR2",
  "--trace-memory=1",
]) {
  test(`execArgv refuses the heap/stack/memory-shaping flag "${flag}" in either form`, () => {
    assert.throws(() => build({ execArgv: [flag] }), /heap|stack|memory/);
  });
}

test("execArgv refuses a flag with characters that are not part of a flag name", () => {
  for (const flag of ["--no warnings", "--a;b", "--$(x)", "--=x", "--"]) {
    assert.throws(() => build({ execArgv: [flag] }), TypeError, flag);
  }
});

test("execArgv may not override the heap size (hyphen form)", () => {
  assert.throws(() => build({ execArgv: ["--max-old-space-size=99999"] }), /heap/);
});

test("execArgv may not override the heap size (underscore form)", () => {
  assert.throws(() => build({ execArgv: ["--max_old_space_size=99999"] }), /heap/);
});

// ---- env ---------------------------------------------------------------------

test("env sets MALLOC_ARENA_MAX=1", () => {
  assert.equal(build().env.MALLOC_ARENA_MAX, "1");
});

test("env passes only the allowlisted variables", () => {
  const env = build({
    parentEnv: { PATH: "/bin", HOME: "/h", LANG: "C", TZ: "UTC", SECRET: "x", AWS_KEY: "y" },
  }).env;
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "MALLOC_ARENA_MAX", "PATH", "TZ"]);
});

test("env drops NODE_OPTIONS", () => {
  assert.equal("NODE_OPTIONS" in build({ parentEnv: { NODE_OPTIONS: "--require /evil.js" } }).env, false);
});

test("env omits allowlisted variables that are unset", () => {
  assert.deepEqual(build({ parentEnv: { PATH: "/bin" } }).env, { PATH: "/bin", MALLOC_ARENA_MAX: "1" });
});

test("a parent MALLOC_ARENA_MAX cannot override ours", () => {
  assert.equal(build({ parentEnv: { MALLOC_ARENA_MAX: "64" } }).env.MALLOC_ARENA_MAX, "1");
});

test("defaults to filtering process.env", () => {
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = "--trace-warnings";
  try {
    const { parentEnv: _omit, ...withoutEnv } = base;
    assert.equal("NODE_OPTIONS" in buildWrapperCommand(withoutEnv).env, false);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
});

// ---- platform ---------------------------------------------------------------

test("linux passes the vmem positional and uses the vmem script", () => {
  const command = build({ platform: "linux" });
  assert.equal(command.args[1], WRAPPER_SCRIPT);
  assert.equal(command.args[5], String(DEFAULT_VMEM_KB));
});

test("darwin uses the no-vmem script and passes no vmem positional", () => {
  const command = build({ platform: "darwin" });
  assert.equal(command.args[1], WRAPPER_SCRIPT_NO_VMEM);
  assert.deepEqual(command.args.slice(3, 6), ["60", "62", "/usr/local/bin/node"]);
});

test("the no-vmem script has no vmem and no /proc step, and still fails closed on each ulimit", () => {
  assert.equal(WRAPPER_SCRIPT_NO_VMEM.includes("ulimit -v"), false);
  assert.equal(WRAPPER_SCRIPT_NO_VMEM.includes("/proc"), false);
  const ulimitLines = WRAPPER_SCRIPT_NO_VMEM.split("\n").filter((line) => line.startsWith("ulimit"));
  assert.ok(ulimitLines.length === 2 && ulimitLines.every((line) => line.endsWith("|| exit 126")));
  assert.ok(WRAPPER_SCRIPT_NO_VMEM.endsWith('exec "$@"'));
});

test("the no-vmem script shifts exactly the two limit positionals", () => {
  assert.ok(WRAPPER_SCRIPT_NO_VMEM.includes("shift 2"));
});

test("vmemKb is still validated on darwin even though it is not applied", () => {
  assert.throws(() => build({ platform: "darwin", vmemKb: 5 }), RangeError);
});

test("an unknown platform gets the no-vmem script", () => {
  assert.equal(build({ platform: "freebsd" }).args[1], WRAPPER_SCRIPT_NO_VMEM);
});

test("platform defaults to process.platform", () => {
  const command = buildWrapperCommand({ ...base, platform: undefined } as unknown as WrapperOptions);
  assert.equal(command.args[1], process.platform === "linux" ? WRAPPER_SCRIPT : WRAPPER_SCRIPT_NO_VMEM);
});

// A config file can carry NODE_OPTIONS / nodeOptions, which would bypass the environment allowlist and the heap rule
// (`--max-old-space-size=64 --env-file=f` with NODE_OPTIONS="--max-heap-size=4000" gave heap_size_limit 6208 MB).
for (const flag of ["--env-file=f", "--env-file-if-exists=f", "--experimental-config-file=f", "--config-file=f", "--ENV-FILE=f", "--env_file=f"]) {
  test(`execArgv refuses the config-loading flag "${flag}"`, () => {
    assert.throws(() => build({ execArgv: [flag] }), /loads options from a file/);
  });
}

test("execArgv passes the normalised flag spelling on, never the original text", () => {
  const command = build({ execArgv: ["--NO-WARNINGS", "--no_deprecation", "--Require=./Preload.cjs"] });
  const first = command.args.indexOf("--no-warnings");
  assert.deepEqual(command.args.slice(first, first + 3), ["--no-warnings", "--no-deprecation", "--require=./Preload.cjs"]);
});
