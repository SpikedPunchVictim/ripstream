import assert from "node:assert/strict";
import { test } from "node:test";
import { RipstreamConfigError, loadConfig, validateConfig } from "../src/index.ts";
import { DEFAULT_SERVER_ENDPOINTS, SERVER_ENDPOINTS, parseServerSection } from "../src/server-config.ts";

/*
 * The `server` section is Tika's (TikaServerConfig, tika-server 4.2.0), read for `ripstream serve`. A key that
 * ripstream's server has no counterpart for is refused by name, never dropped.
 */

const section = (value: unknown) => parseServerSection(value);
const issuesOf = (value: unknown): string[] => section(value).issues;

test("an empty server section sets nothing", () => {
  assert.deepEqual(section({}), { settings: {}, issues: [] });
  assert.equal(loadConfig({ server: {} }).server, null);
  assert.equal(loadConfig({}).server, null);
});

test("every applied key is read, and a loaded configuration keeps them frozen", () => {
  const settings = {
    port: 8080,
    host: "0.0.0.0",
    endpoints: ["detect", "status"],
    cors: "https://example.com",
    maxRequestSizeBytes: 1_048_576,
    maxUnpackBytes: 52_428_800,
    requestLogLevel: "info",
    maxRequestReadMillis: 30_000,
    idleTimeoutMillis: 60_000,
  };
  assert.deepEqual(section(settings), { settings, issues: [] });
  const config = loadConfig({ server: settings });
  assert.deepEqual(config.server, settings);
  assert.ok(Object.isFrozen(config.server));
  assert.ok(Object.isFrozen(config.server?.endpoints));
});

test("what Tika reads as unset is unset: * for all hosts, an empty cors, an empty endpoints list", () => {
  assert.deepEqual(section({ host: "*" }).settings, { host: "0.0.0.0" });
  assert.deepEqual(section({ cors: "" }).settings, {});
  assert.deepEqual(section({ endpoints: [] }).settings, {});
  assert.deepEqual(section({ endpoints: ["detect", "detect", "tika"] }).settings, { endpoints: ["detect", "tika"] });
});

test("the endpoints ripstream serves, and the default set Tika serves without an endpoints key", () => {
  assert.deepEqual([...SERVER_ENDPOINTS].sort(), ["async", "detect", "language", "meta", "mime-types", "rmeta", "status", "tika", "unpack", "version"]);
  // Tika: tika rmeta meta unpack detect language mime mime-types detectors parsers version; status, pipes and async are opt-in.
  // ripstream serves all but `detectors` and `parsers` (and `pipes`, which is opt-in there).
  assert.deepEqual([...DEFAULT_SERVER_ENDPOINTS].sort(), ["detect", "language", "meta", "mime-types", "rmeta", "tika", "unpack", "version"]);
});

test("Tika's `mime` and `mime-types` are one endpoint: either serves /mime-types", () => {
  assert.deepEqual(section({ endpoints: ["mime"] }).settings, { endpoints: ["mime-types"] });
  assert.deepEqual(section({ endpoints: ["mime-types"] }).settings, { endpoints: ["mime-types"] });
  assert.deepEqual(section({ endpoints: ["mime", "detect", "mime-types"] }).settings, { endpoints: ["mime-types", "detect"] });
});

test("a port, host or endpoint that is not one is refused", () => {
  for (const port of [-1, 65_536, 1.5, "80", null, true]) {
    assert.deepEqual(issuesOf({ port }), ["server.port must be an integer from 0 to 65535"], String(port));
  }
  for (const host of ["", 1, null]) assert.deepEqual(issuesOf({ host }), ["server.host must be a host name, a non-empty string"], String(host));
  assert.deepEqual(issuesOf({ endpoints: "detect" }), ["server.endpoints must be an array of endpoint names"]);
  assert.deepEqual(issuesOf({ endpoints: [1] }), ["server.endpoints[0] must be an endpoint name"]);
});

test("an endpoint Tika does not know is unrecognized; one Tika has and ripstream does not serve is said so", () => {
  const [unknown] = issuesOf({ endpoints: ["tika", "detct"] });
  assert.match(unknown ?? "", /^server\.endpoints\[1\] "detct" is not an endpoint; ripstream serves /);
  for (const name of ["detectors", "parsers", "pipes"]) {
    const [issue] = issuesOf({ endpoints: [name] });
    assert.match(issue ?? "", new RegExp(`^server\\.endpoints\\[0\\] "${name}" is a Tika endpoint that ripstream does not serve`), name);
  }
});

test("the size, time and log settings take only values that mean something", () => {
  for (const value of [-1, 0, 1.5, "1", null]) {
    assert.deepEqual(issuesOf({ maxRequestSizeBytes: value }), ["server.maxRequestSizeBytes must be a positive number of bytes: ripstream always bounds a request body"], String(value));
  }
  for (const value of ["warn", "", "INFO", 1, null]) {
    assert.deepEqual(issuesOf({ requestLogLevel: value }), ['server.requestLogLevel must be "debug" or "info"'], String(value));
  }
  // Tika: positive, or negative to disable the deadline, never zero.
  for (const value of [0, 1.5, "1", null, 2 ** 31]) {
    assert.deepEqual(issuesOf({ maxRequestReadMillis: value }), ["server.maxRequestReadMillis must be a whole number of milliseconds up to 2147483647, or negative to disable the deadline; not zero"], String(value));
  }
  assert.deepEqual(section({ maxRequestReadMillis: -1 }).settings, { maxRequestReadMillis: -1 });
  for (const value of [0, -1, 1.5, "1", null, 2 ** 31]) {
    assert.deepEqual(issuesOf({ idleTimeoutMillis: value }), ["server.idleTimeoutMillis must be a whole number of milliseconds from 1 to 2147483647"], String(value));
  }
  assert.deepEqual(issuesOf({ cors: 1 }), ["server.cors must be an origin, a string"]);
});

// Tika has no such key (its /unpack is bounded by a 10 GiB constant): this is ripstream's own server setting, the
// `maxUnpackBytes` option of createRipstreamServer. The most it may be is the server's to say (2 GiB, and what an isolation
// allows), so it is refused there, naming it, and not here.
test("maxUnpackBytes takes a whole number of bytes, 0 or more", () => {
  for (const value of [-1, 1.5, "1", null, true, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(issuesOf({ maxUnpackBytes: value }), ["server.maxUnpackBytes must be a whole number of bytes, 0 or more"], String(value));
  }
  for (const value of [0, 1, 2 ** 31]) assert.deepEqual(section({ maxUnpackBytes: value }), { settings: { maxUnpackBytes: value }, issues: [] }, String(value));
  assert.equal(loadConfig({ server: { maxUnpackBytes: 0 } }).server?.maxUnpackBytes, 0);
});

test("a switch ripstream does not have is refused when on and accepted when off, which is what it does", () => {
  for (const key of ["allowPipes", "allowPerRequestConfig", "allowHttp2"]) {
    assert.match(issuesOf({ [key]: true }).join("|"), new RegExp(`^server\\.${key} is not supported: `), key);
    assert.deepEqual(section({ [key]: false }), { settings: {}, issues: [] }, key);
    assert.deepEqual(issuesOf({ [key]: "false" }), [`server.${key} must be true or false`], key);
  }
});

test("a setting with no ripstream counterpart is refused by name, with the reason", () => {
  for (const key of ["maxQueuePauseMillis", "maxResponseWriteMillis", "maxInFlightRequestBytes", "id", "tlsConfig", "metricsPort"]) {
    const [issue] = issuesOf({ [key]: key === "tlsConfig" ? {} : 1 });
    assert.match(issue ?? "", new RegExp(`^server\\.${key} is not supported: ripstream `), key);
  }
  assert.match(issuesOf({ bogus: 1 }).join("|"), /^server\.bogus is not a server setting; ripstream applies port, host, endpoints, cors, maxRequestSizeBytes, maxUnpackBytes, /);
});

test("the section must be an object, and loadConfig reports every problem at once", () => {
  for (const value of [[], "x", 1, null]) assert.deepEqual(issuesOf(value), ["server must be an object"], String(value));
  assert.throws(
    () => loadConfig({ server: { port: -1, endpoints: ["pipes"], id: "a" } }),
    (error) => error instanceof RipstreamConfigError && error.issues.length === 3,
  );
  assert.equal(validateConfig({ server: { port: 8080 } }).length, 0);
  assert.equal(validateConfig({ server: { port: "x" } }).length, 1);
});
