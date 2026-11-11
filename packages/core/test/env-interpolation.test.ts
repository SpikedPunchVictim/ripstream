import assert from "node:assert/strict";
import { test } from "node:test";
import { interpolateEnv } from "../src/env-interpolation.ts";
import { RipstreamConfigError, loadConfig } from "../src/index.ts";

/*
 * `${env:NAME}` in the string values of a configuration, as Tika 4.2.0 reads it (EnvInterpolator, applied by
 * TikaJsonConfig.load): the exact form only, whole value or inside a longer string, in objects and arrays, never in a key,
 * one pass, and a variable that is not set fails the load naming the variable and the JSON path, never a value.
 * Read from Tika's source, not run against a Tika.
 */

/** `cors` is any string, so it shows what a value became; `custom-mimetypes` is another. */
const corsOf = (config: unknown, env: Record<string, string | undefined>): string | undefined =>
  loadConfig(JSON.stringify(config), { env }).server?.cors;

function failureOf(source: unknown, env: Record<string, string | undefined>): string {
  try {
    loadConfig(typeof source === "string" ? source : JSON.stringify(source), { env });
  } catch (error) {
    assert.ok(error instanceof RipstreamConfigError, String(error));
    return error.message;
  }
  throw new assert.AssertionError({ message: "the configuration loaded" });
}

test("a whole value and a reference inside a longer string are both resolved", () => {
  const env = { ORIGIN: "https://example.com", HOST: "files.example.com", DIR: "/etc/ripstream" };
  assert.equal(corsOf({ server: { cors: "${env:ORIGIN}" } }, env), "https://example.com");
  assert.equal(corsOf({ server: { cors: "https://${env:HOST}/app" } }, env), "https://files.example.com/app");
  assert.equal(loadConfig(JSON.stringify({ "custom-mimetypes": "${env:DIR}/types.xml" }), { env }).customMimeTypes, "/etc/ripstream/types.xml");
});

test("several references in one string are each resolved", () => {
  assert.equal(corsOf({ server: { cors: "${env:A}+${env:B}+${env:A}" } }, { A: "eng", B: "deu" }), "eng+deu+eng");
});

test("strings inside arrays are resolved, and the array is still the one that was written", () => {
  const config = loadConfig(JSON.stringify({ server: { endpoints: ["${env:FIRST}", "status"] } }), { env: { FIRST: "detect" } });
  assert.deepEqual(config.server?.endpoints, ["detect", "status"]);
});

test("only the exact ${env:NAME} form is touched", () => {
  const env = { X: "no", fields: "no", HOME: "no", "1X": "no" };
  const literal = "${fields} $X $JSON ${env:} ${sys:HOME} ${ENV:X} ${env:1X} ${env:X-Y} ${env:X ${env X} $ { env:X}";
  assert.equal(corsOf({ server: { cors: literal } }, env), literal);
});

test("a dollar sign in front of a reference stays, and the reference is resolved", () => {
  // Tika has no escape: `$${env:X}` is a dollar sign and the value (EnvInterpolatorTest.testOnlyTheEnvFormIsTouched).
  assert.equal(corsOf({ server: { cors: "$${env:X}" } }, { X: "no" }), "$no");
});

test("a value is inserted as it is: no second pass, no replacement patterns", () => {
  assert.equal(corsOf({ server: { cors: "${env:A}" } }, { A: "${env:B}", B: "second" }), "${env:B}");
  assert.equal(corsOf({ server: { cors: "x${env:A}y" } }, { A: "a$&b$1c$$d$`e" }), "xa$&b$1c$$d$`ey");
});

test("a variable that is set to the empty string is set, and resolves to nothing", () => {
  assert.equal(corsOf({ server: { cors: "https://a${env:EMPTY}" } }, { EMPTY: "" }), "https://a");
});

test("a key is never interpolated, only a value", () => {
  const message = failureOf({ server: { "${env:SECRET}": 1 } }, { SECRET: "port" });
  assert.match(message, /server\.\$\{env:SECRET\} is not a server setting/);
});

test("a number and a boolean are left alone", () => {
  const config = loadConfig(JSON.stringify({ server: { port: 8080, allowPipes: false }, "parse-context": { "output-limits": { throwOnWriteLimit: true } } }), {
    env: { PORT: "1" },
  });
  assert.equal(config.server?.port, 8080);
  assert.equal(config.throwOnWriteLimit, true);
});

test("a reference to a variable that is not set fails the load, naming the variable and the path and never a value", () => {
  const message = failureOf({ server: { cors: "${env:CORS_ORIGIN}" } }, { OTHER: "never-in-a-message" });
  assert.match(message, /environment variable CORS_ORIGIN is not set; referenced at \/server\/cors/);
  assert.doesNotMatch(message, /never-in-a-message/);
});

test("the path names an array position, and a reference inside a longer string fails as well", () => {
  assert.match(failureOf({ server: { endpoints: ["detect", "${env:NAME}"] } }, {}), /environment variable NAME is not set; referenced at \/server\/endpoints\/1/);
  assert.match(failureOf({ server: { cors: "https://${env:HOST}/x" } }, {}), /environment variable HOST is not set; referenced at \/server\/cors/);
});

test("a name that Object.prototype has is not a variable that is set", () => {
  for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.match(failureOf({ server: { cors: `\${env:${name}}` } }, {}), new RegExp(`environment variable ${name} is not set`), name);
  }
});

test("a variable that is undefined in the environment is not set", () => {
  assert.match(failureOf({ server: { cors: "${env:GONE}" } }, { GONE: undefined }), /environment variable GONE is not set/);
});

test("an unset variable fails with the other problems of the file left unreported, as in Tika, which stops at the first", () => {
  const message = failureOf({ unknownKey: 1, server: { cors: "${env:GONE}" } }, {});
  assert.match(message, /environment variable GONE is not set/);
});

test("without an environment, nothing is interpolated and a reference is the literal string", () => {
  assert.equal(loadConfig(JSON.stringify({ server: { cors: "${env:ORIGIN}" } })).server?.cors, "${env:ORIGIN}");
});

test("an object given in place of text is interpolated too, and the caller's object is not changed", () => {
  const source = { server: { cors: "https://${env:HOST}", endpoints: ["${env:E}"] } };
  const config = loadConfig(source, { env: { HOST: "a.example", E: "detect" } });
  assert.equal(config.server?.cors, "https://a.example");
  assert.deepEqual(config.server?.endpoints, ["detect"]);
  assert.deepEqual(source, { server: { cors: "https://${env:HOST}", endpoints: ["${env:E}"] } });
});

test("bytes are interpolated like text", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ server: { cors: "${env:ORIGIN}" } }));
  assert.equal(loadConfig(bytes, { env: { ORIGIN: "https://example.com" } }).server?.cors, "https://example.com");
});

test("a problem with the file's structure is reported before an unset variable is looked for", () => {
  // The repeated key is not the one holding the reference, so the reference is still there after the parse.
  const message = failureOf('{"server": {"cors": "${env:GONE}"}, "version": 1, "version": 1}', {});
  assert.match(message, /duplicate key "version"/);
  assert.doesNotMatch(message, /GONE/);
});

test("a file nested past the limit is refused with the nesting message, not walked", () => {
  const nest = (depth: number): string => "[".repeat(depth) + "]".repeat(depth);
  const message = failureOf(`{"version": 1, "extra": ${nest(100_000)}}`, {});
  assert.match(message, /nesting is deeper than/);
});

test("every section sees the resolved value: a fetcher's basePath of ${env:INPUT} is the directory INPUT names", () => {
  const config = loadConfig(
    JSON.stringify({
      fetchers: { fsf: { "file-system-fetcher": { basePath: "${env:INPUT}" } } },
      emitters: { fse: { "file-system-emitter": { basePath: "${env:OUTPUT}/out" } } },
      "pipes-iterator": { "file-system-pipes-iterator": { basePath: "${env:INPUT}", fetcherId: "fsf", emitterId: "fse" } },
    }),
    { env: { INPUT: "/data/in", OUTPUT: "/data" } },
  );
  assert.equal(config.pipes?.fetchers[0]?.basePath, "/data/in");
  assert.equal(config.pipes?.emitters[0]?.basePath, "/data/out");
  assert.equal(config.pipes?.iterator?.basePath, "/data/in");
});

test("a root that is not an object or an array is returned as it is, as Tika leaves it", () => {
  assert.equal(interpolateEnv("${env:HOME_DIR}", { HOME_DIR: "/x" }), "${env:HOME_DIR}");
  assert.equal(interpolateEnv(7, {}), 7);
  assert.equal(interpolateEnv(null, {}), null);
});

test("an array at the root is interpolated, and the original is not changed", () => {
  const source = ["${env:A}", ["x${env:A}"]];
  assert.deepEqual(interpolateEnv(source, { A: "1" }), ["1", ["x1"]]);
  assert.deepEqual(source, ["${env:A}", ["x${env:A}"]]);
});
