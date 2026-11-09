import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_IN_PROCESS_TYPES } from "@spikedpunch/ripstream-isolation-node";
import { createInProcessParsers } from "../src/isolation.ts";

/**
 * Hazard audit (epic tikajs-zgg2, P5).
 *
 * The hazard list names the third-party libraries whose parsers must never run inside the server process. The
 * isolation layer keeps them out by routing: only the twelve types in DEFAULT_IN_PROCESS_TYPES are parsed in the
 * parent, and only by the five text parsers of createInProcessParsers(). This test makes that a property of the
 * source tree instead of a habit:
 *
 *   1. It scans every package's `src` for imports of a hazard library, and follows relative imports, so a file that
 *      reaches a hazard through a helper counts too.
 *   2. Every parser class declared in such a file is a "hazard parser". The taint is per file, so a file that also
 *      declares an innocent parser is over-approximated; that errs toward a false alarm, never a miss.
 *   3. A hazard parser must not be in the parent's parser set and must not support a type the parent parses, unless
 *      it is on IN_PROCESS_ALLOWLIST with a justification. The allowlist is empty on purpose.
 *
 * Not covered by the hazard scan: a parser that reaches a hazard only through another package (the scan follows
 * relative imports within a package, not workspace package names; a subclass or wrapper of a hazard parser in
 * another package is such a case), a subclass that inherits `getSupportedTypes`, and any library not on the list.
 * Test 5 closes the first gap for the parent: its parser set must be exactly PARENT_PARSERS, so any addition is a
 * deliberate edit here, reviewed against the hazard list. Adding a library to HAZARDS is how a new finding enters
 * the audit.
 */
const HAZARDS = ["exifr", "sql.js", "pdfjs-dist", "music-metadata", "hyparquet"] as const;

/** The only parsers the server process may run on a document. Changing this list is a security decision. */
const PARENT_PARSERS = ["CsvParser", "HtmlDocumentParser", "MarkdownParser", "TextParser", "XmlParser"];

/** Hazard parser class name -> why it may run in the server process. A hazard parser is isolated unless listed here. */
const IN_PROCESS_ALLOWLIST: ReadonlyMap<string, string> = new Map();

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface SourceFile {
  readonly path: string;
  readonly text: string;
  /** Hazards imported directly, plus those reached through relative imports. */
  readonly hazards: Set<string>;
  readonly relative: string[];
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

// `from "x"`, `import "x"`, `import("x")`, `require("x")`, `require.resolve("x")`. A computed specifier is not visible.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire(?:\.resolve)?\s*\(\s*)["']([^"']+)["']/g;

function hazardOf(specifier: string): string | undefined {
  return HAZARDS.find((hazard) => specifier === hazard || specifier.startsWith(`${hazard}/`));
}

function loadSources(): Map<string, SourceFile> {
  const files = new Map<string, SourceFile>();
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    if (!existsSync(src)) continue;
    for (const path of walk(src)) {
      const text = readFileSync(path, "utf8");
      const hazards = new Set<string>();
      const relative: string[] = [];
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? "";
        const hazard = hazardOf(specifier);
        if (hazard !== undefined) hazards.add(hazard);
        else if (specifier.startsWith(".")) relative.push(resolve(dirname(path), specifier));
      }
      files.set(path, { path, text, hazards, relative });
    }
  }
  return files;
}

/** Propagates hazards from imported files to their importers until nothing changes. */
function taint(files: Map<string, SourceFile>): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of files.values()) {
      for (const target of file.relative) {
        for (const hazard of files.get(target)?.hazards ?? []) {
          if (!file.hazards.has(hazard)) {
            file.hazards.add(hazard);
            changed = true;
          }
        }
      }
    }
  }
}

interface HazardParser {
  readonly name: string;
  readonly file: string;
  readonly hazards: ReadonlySet<string>;
  readonly types: readonly string[];
}

async function findHazardParsers(files: Map<string, SourceFile>): Promise<HazardParser[]> {
  const found: HazardParser[] = [];
  for (const file of files.values()) {
    if (file.hazards.size === 0 || !/\bgetSupportedTypes\s*\(/.test(file.text)) continue;
    const module = (await import(pathToFileURL(file.path).href)) as Record<string, unknown>;
    for (const match of file.text.matchAll(/\bclass\s+(\w+)/g)) {
      const name = match[1] ?? "";
      const Class = module[name];
      if (typeof Class !== "function" || typeof Class.prototype?.getSupportedTypes !== "function") continue;
      let types: string[];
      try {
        const instance = new (Class as new () => { getSupportedTypes(): ReadonlySet<{ toString(): string }> })();
        types = [...instance.getSupportedTypes()].map((type) => type.toString());
      } catch (error) {
        assert.fail(`cannot construct ${name} (${file.path}) without arguments to read its types; extend the audit: ${String(error)}`);
      }
      found.push({ name, file: file.path, hazards: new Set(file.hazards), types });
    }
  }
  return found;
}

const files = loadSources();
taint(files);
const hazardParsers = await findHazardParsers(files);

test("every hazard library is still imported somewhere, so the list cannot go stale unnoticed", () => {
  const imported = new Set([...files.values()].flatMap((file) => [...file.hazards]));
  for (const hazard of HAZARDS) assert.ok(imported.has(hazard), `${hazard} is on the hazard list but no package source imports it`);
});

test("the scan finds a parser behind every hazard library, so it cannot pass by finding nothing", () => {
  for (const hazard of HAZARDS) {
    assert.ok(
      hazardParsers.some((parser) => parser.hazards.has(hazard)),
      `no parser class was found behind ${hazard}`,
    );
  }
});

test("the scan knows the parsers it should (a canary against a broken scan)", () => {
  const names = new Set(hazardParsers.map((parser) => parser.name));
  for (const expected of ["PdfParser", "ImageParser", "AudioParser", "SqliteParser", "ColumnarParser"]) {
    assert.ok(names.has(expected), `${expected} was not found among ${[...names].sort().join(", ")}`);
  }
});

test("no hazard parser is in the parent's parser set unless it is allowlisted with a reason", () => {
  const inParent = new Set(createInProcessParsers().map((parser) => parser.constructor.name));
  const offenders = hazardParsers.filter((parser) => inParent.has(parser.name) && !IN_PROCESS_ALLOWLIST.has(parser.name));
  assert.deepEqual(
    offenders.map((parser) => `${parser.name} (${[...parser.hazards].join(", ")})`),
    [],
    "a parser built on a hazard library is registered in the in-process ripstream: route it through the isolator",
  );
});

test("the parent's parser set is exactly the five text parsers, whatever they are called or derived from", () => {
  assert.deepEqual(createInProcessParsers().map((parser) => parser.constructor.name).sort(), PARENT_PARSERS);
});

test("no media type a hazard parser handles is parsed in the parent unless allowlisted with a reason", () => {
  const offenders = hazardParsers.flatMap((parser) =>
    IN_PROCESS_ALLOWLIST.has(parser.name)
      ? []
      : parser.types.filter((type) => DEFAULT_IN_PROCESS_TYPES.has(type)).map((type) => `${parser.name}: ${type}`),
  );
  assert.deepEqual(offenders, [], "a type handled by a hazard parser is in DEFAULT_IN_PROCESS_TYPES: it would skip the isolator");
});

test("the in-process parsers declare no unsafe capability (a backstop: only some hazard parsers declare it)", () => {
  const unsafe = createInProcessParsers().filter(
    (parser) => (parser as { capabilities?: { unsafe?: boolean } }).capabilities?.unsafe === true,
  );
  assert.deepEqual(unsafe.map((parser) => parser.constructor.name), []);
});

test("the allowlist is honest: every entry names a real hazard parser and says why", () => {
  const known = new Set(hazardParsers.map((parser) => parser.name));
  for (const [name, justification] of IN_PROCESS_ALLOWLIST) {
    assert.ok(known.has(name), `${name} is on the allowlist but is not a hazard parser (stale entry)`);
    assert.ok(justification.trim().length >= 20, `${name}: the justification is missing or too short to be one`);
  }
});
