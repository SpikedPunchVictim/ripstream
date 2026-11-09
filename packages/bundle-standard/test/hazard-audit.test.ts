import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Hazard audit (epic tikajs-zgg2, P5; blind spots closed in zgg2.13, declared capability in zgg2.14).
 *
 * The hazard list names the third-party libraries whose parsers must never run inside the server process. The
 * isolation layer keeps them out by routing: only the twelve types in DEFAULT_IN_PROCESS_TYPES are parsed in the
 * parent, and only by the five text parsers of createInProcessParsers(). This test makes that a property of the
 * source tree instead of a habit. For a workspace root (the real checkout, or the fixture tree) it works in three steps:
 *
 *   1. Scan. Every package's `src` is searched for imports of a hazard library, and the imports are followed: a
 *      relative import, and an import of a workspace package (`@spikedpunch/ripstream-*`, followed to that package's
 *      `src`). A file that reaches a hazard through either is tainted. The taint is per file and per package entry, so a
 *      file that also declares an innocent parser, or a parser that uses only the clean exports of a package that has a
 *      hazardous one, is over-approximated: that errs toward a false alarm, never a miss.
 *   2. Discover. The parser classes (a function whose prototype has `getSupportedTypes`, own or inherited) exported
 *      by every package's `src/index.ts` and by every tainted file that mentions `getSupportedTypes(` or declares a
 *      subclass are collected by importing those modules. Workspace packages are imported from `src`, never from
 *      `dist` (see routeWorkspaceToSource), so a class has one identity however it is reached and the audit does not
 *      depend on a build.
 *   3. Classify. A discovered class is a hazard parser when it is declared (by its declared name, so an alias
 *      does not hide it) in a tainted file, or when a hazard parser is in its prototype chain (compared by
 *      constructor, so a subclass that inherits `getSupportedTypes`, in this package or another, or one made by a
 *      factory in a file that mentions neither `class` nor `getSupportedTypes`, is found).
 *
 * A hazard parser must not be in the parent's parser set and must not support a type the parent parses, unless it is on
 * IN_PROCESS_ALLOWLIST with a justification (the allowlist is empty on purpose), and it must declare
 * `capabilities.unsafe`. That flag is declarative today; the audit is what keeps it complete.
 *
 * The scanner runs against the fixture tree (test/fixtures/hazard) as well, which holds what the real tree does not:
 * a cross-package wrapper and subclass, an inherited `getSupportedTypes`, an aliased export, a factory-made class, and
 * clean parsers that must stay unflagged. That is what proves the scanner can see them.
 *
 * Still not covered: a library not on HAZARDS; a computed import specifier; a parser class that no package entry or
 * scanned file exports (one built inside a function and never exported); and code outside `packages/*` (a plugin).
 * The pinned-set test backstops the parent for all of these: its parser set must be exactly PARENT_PARSERS, so any addition is a
 * deliberate edit here, reviewed against the hazard list. Adding a library to HAZARDS is how a new finding enters
 * the audit.
 */
const HAZARDS = ["exifr", "sql.js", "pdfjs-dist", "music-metadata", "hyparquet"] as const;

/** The only parsers the server process may run on a document. Changing this list is a security decision. */
const PARENT_PARSERS = ["CsvParser", "HtmlDocumentParser", "MarkdownParser", "TextParser", "XmlParser"];

/** Hazard parser class name -> why it may run in the server process. A hazard parser is isolated unless listed here. */
const IN_PROCESS_ALLOWLIST: ReadonlyMap<string, string> = new Map();

const WORKSPACE_SCOPE = "@spikedpunch/ripstream-";
const REAL_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/hazard/", import.meta.url));

interface SourceFile {
  readonly path: string;
  readonly text: string;
  /** Hazards imported directly, plus those reached through `imports`. */
  readonly hazards: Set<string>;
  /** Import specifiers that are not hazards. */
  readonly specifiers: string[];
  /** Source files this one imports: relative imports and workspace package imports that resolve inside the tree. */
  readonly imports: string[];
}

interface Workspace {
  readonly root: string;
  /** Workspace package name -> package directory. */
  readonly packages: ReadonlyMap<string, string>;
  readonly files: Map<string, SourceFile>;
  /** Imports into the tree that name no source file in it: the scan cannot follow them, so it must not stay silent. */
  readonly unresolved: string[];
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

/**
 * The source file a workspace package specifier stands for: `name` is `src/index.ts`, `name/sub` is `src/sub.ts`.
 * (package.json maps these to `dist`; the audit reads and runs `src`.)
 */
function workspaceSource(packages: ReadonlyMap<string, string>, specifier: string): string | undefined {
  for (const [name, directory] of packages) {
    if (specifier === name) return join(directory, "src", "index.ts");
    if (specifier.startsWith(`${name}/`)) return join(directory, "src", `${specifier.slice(name.length + 1)}.ts`);
  }
  return undefined;
}

function loadWorkspace(root: string): Workspace {
  const packages = new Map<string, string>();
  const files = new Map<string, SourceFile>();
  for (const name of readdirSync(join(root, "packages"))) {
    const directory = join(root, "packages", name);
    const src = join(directory, "src");
    if (!existsSync(src)) continue;
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) packages.set((JSON.parse(readFileSync(manifest, "utf8")) as { name: string }).name, directory);
    for (const path of walk(src)) {
      const text = readFileSync(path, "utf8");
      const hazards = new Set<string>();
      const specifiers: string[] = [];
      for (const match of text.matchAll(IMPORT)) {
        const specifier = match[1] ?? "";
        const hazard = hazardOf(specifier);
        if (hazard !== undefined) hazards.add(hazard);
        else specifiers.push(specifier);
      }
      files.set(path, { path, text, hazards, specifiers, imports: [] });
    }
  }

  const unresolved: string[] = [];
  for (const file of files.values()) {
    for (const specifier of file.specifiers) {
      const relativeImport = specifier.startsWith(".");
      const target = relativeImport ? resolve(dirname(file.path), specifier) : workspaceSource(packages, specifier);
      if (target !== undefined && files.has(target)) file.imports.push(target);
      else if (specifier.startsWith(WORKSPACE_SCOPE) || (relativeImport && specifier.endsWith(".ts"))) {
        unresolved.push(`${relative(root, file.path)} imports ${specifier}`);
      }
    }
  }
  return { root, packages, files, unresolved };
}

/** Propagates hazards from imported files to their importers until nothing changes. */
function taint(workspace: Workspace): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of workspace.files.values()) {
      for (const target of file.imports) {
        for (const hazard of workspace.files.get(target)?.hazards ?? []) {
          if (!file.hazards.has(hazard)) {
            file.hazards.add(hazard);
            changed = true;
          }
        }
      }
    }
  }
}

/**
 * Makes `@spikedpunch/ripstream-*` imports resolve to the package's `src` for everything imported after this call.
 * Without it they resolve to `dist` (package.json `exports`), so a class would exist twice (src and dist) and a
 * subclass in one package would not have the other package's parser in its prototype chain by identity; the fixture
 * packages, which have no `node_modules` link, could not be imported at all.
 */
function routeWorkspaceToSource(...workspaces: Workspace[]): void {
  const packages = new Map(workspaces.flatMap((workspace) => [...workspace.packages]));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = workspaceSource(packages, specifier);
      return target === undefined ? nextResolve(specifier, context) : { url: pathToFileURL(target).href, shortCircuit: true };
    },
  });
}

interface ParserInstance {
  readonly capabilities?: { readonly unsafe?: boolean };
  getSupportedTypes(): ReadonlySet<{ toString(): string }> | Promise<ReadonlySet<{ toString(): string }>>;
}

type ParserClass = (new () => ParserInstance) & { readonly name: string };

function isParserClass(value: unknown): value is ParserClass {
  return typeof value === "function" && typeof (value as { prototype?: ParserInstance }).prototype?.getSupportedTypes === "function";
}

// Cheap gates for importing a tainted file: it names getSupportedTypes, or declares a class that extends something
// (and so may inherit it). Importing is the only way to see a class, so the gate keeps modules with side effects out.
const MAY_DECLARE_PARSER = /\bgetSupportedTypes\s*\(|\bclass\b[^{}]*\bextends\b/;

/** Every parser class exported by a package entry or by a tainted file that may declare one -> the names it is exported as. */
async function discoverParserClasses(workspace: Workspace): Promise<Map<ParserClass, Set<string>>> {
  const modules = new Set<string>();
  for (const directory of workspace.packages.values()) {
    const entry = join(directory, "src", "index.ts");
    if (workspace.files.has(entry)) modules.add(entry);
  }
  for (const file of workspace.files.values()) {
    if (file.hazards.size > 0 && MAY_DECLARE_PARSER.test(file.text)) modules.add(file.path);
  }

  const classes = new Map<ParserClass, Set<string>>();
  for (const path of modules) {
    let exported: Record<string, unknown>;
    try {
      exported = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`cannot import ${relative(workspace.root, path)} to list its parsers; extend the audit: ${String(error)}`, { cause: error });
    }
    for (const [key, value] of Object.entries(exported)) {
      if (!isParserClass(value)) continue;
      const names = classes.get(value) ?? new Set<string>();
      names.add(key);
      classes.set(value, names);
    }
  }
  return classes;
}

interface HazardParser {
  /** The declared class name; for an anonymous class, the first name it is exported as. */
  readonly name: string;
  readonly exportedAs: readonly string[];
  readonly Class: ParserClass;
  readonly instance: ParserInstance;
  readonly hazards: ReadonlySet<string>;
  /** Why it counts: `declared in <file>` (a file that reaches a hazard), `extends <class>` (a hazard parser is an ancestor). */
  readonly reasons: readonly string[];
  readonly types: readonly string[];
}

interface Analysis {
  readonly workspace: Workspace;
  /** Every parser class discovered, hazardous or not: what the classification was applied to. */
  readonly discovered: ReadonlyMap<ParserClass, ReadonlySet<string>>;
  readonly hazardParsers: readonly HazardParser[];
}

async function analyse(workspace: Workspace): Promise<Analysis> {
  const { root } = workspace;
  taint(workspace);
  const discovered = await discoverParserClasses(workspace);
  const nameOf = (Class: ParserClass): string => Class.name || [...(discovered.get(Class) ?? [])][0] || "(anonymous)";

  // Declared in a file that reaches a hazard. Matched by declared class name, not by export name.
  const declaredIn = new Map<string, SourceFile[]>();
  for (const file of workspace.files.values()) {
    if (file.hazards.size === 0) continue;
    for (const match of file.text.matchAll(/\bclass\s+(\w+)/g)) {
      declaredIn.set(match[1] ?? "", [...(declaredIn.get(match[1] ?? "") ?? []), file]);
    }
  }
  const found = new Map<ParserClass, { hazards: Set<string>; reasons: string[] }>();
  const record = (Class: ParserClass): { hazards: Set<string>; reasons: string[] } => {
    const existing = found.get(Class) ?? { hazards: new Set<string>(), reasons: [] };
    found.set(Class, existing);
    return existing;
  };
  for (const Class of discovered.keys()) {
    for (const file of declaredIn.get(Class.name) ?? []) {
      const entry = record(Class);
      entry.reasons.push(`declared in ${relative(root, file.path)}`);
      for (const hazard of file.hazards) entry.hazards.add(hazard);
    }
  }

  // A hazard parser in the prototype chain, compared by constructor. Ancestors are taken from the declared set only: a
  // derived class always has a declared ancestor, so the chain needs no second pass.
  const declared = new Map(found);
  for (const Class of discovered.keys()) {
    for (let parent: unknown = Object.getPrototypeOf(Class); typeof parent === "function"; parent = Object.getPrototypeOf(parent)) {
      const ancestor = declared.get(parent as ParserClass);
      if (ancestor === undefined) continue;
      const entry = record(Class);
      entry.reasons.push(`extends ${nameOf(parent as ParserClass)}`);
      for (const hazard of ancestor.hazards) entry.hazards.add(hazard);
    }
  }

  const hazardParsers: HazardParser[] = [];
  for (const [Class, { hazards, reasons }] of found) {
    const name = nameOf(Class);
    let instance: ParserInstance;
    let types: string[];
    try {
      instance = new Class();
      types = [...(await instance.getSupportedTypes())].map((type) => type.toString());
    } catch (error) {
      assert.fail(`cannot construct ${name} (${reasons.join("; ")}) without arguments to read its types; extend the audit: ${String(error)}`);
    }
    hazardParsers.push({ name, exportedAs: [...(discovered.get(Class) ?? [])], Class, instance, hazards, reasons, types });
  }
  hazardParsers.sort((a, b) => a.name.localeCompare(b.name));
  return { workspace, discovered, hazardParsers };
}

const realWorkspace = loadWorkspace(REAL_ROOT);
const fixtureWorkspace = loadWorkspace(FIXTURE_ROOT);
routeWorkspaceToSource(realWorkspace, fixtureWorkspace);
// Imported only now, so every workspace package under them is the `src` one (see routeWorkspaceToSource).
const { createInProcessParsers } = await import("../src/isolation.ts");
const { DEFAULT_IN_PROCESS_TYPES } = await import("@spikedpunch/ripstream-isolation-node");
const real = await analyse(realWorkspace);
const fixture = await analyse(fixtureWorkspace);
const hazardParsers = real.hazardParsers;

test("every hazard library is still imported somewhere, so the list cannot go stale unnoticed", () => {
  const imported = new Set([...real.workspace.files.values()].flatMap((file) => [...file.hazards]));
  for (const hazard of HAZARDS) assert.ok(imported.has(hazard), `${hazard} is on the hazard list but no package source imports it`);
});

test("every workspace and relative .ts import of the real tree resolves to a source file, so the taint can follow it", () => {
  assert.deepEqual(real.workspace.unresolved, []);
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

test("the scan also saw the clean parsers, so what it does not flag is a decision and not a blind spot", () => {
  const discovered = new Set([...real.discovered.keys()].map((Class) => Class.name));
  for (const clean of PARENT_PARSERS) assert.ok(discovered.has(clean), `${clean} was not discovered`);
  const flagged = new Set(hazardParsers.map((parser) => parser.name));
  for (const clean of PARENT_PARSERS) assert.ok(!flagged.has(clean), `${clean} is flagged as a hazard parser`);
});

test("no hazard parser is in the parent's parser set unless it is allowlisted with a reason", () => {
  const inParent = createInProcessParsers();
  // By constructor and by subclassing, and by name as well: the allowlist is keyed by name.
  const offenders = hazardParsers.filter(
    (parser) =>
      !IN_PROCESS_ALLOWLIST.has(parser.name) &&
      inParent.some((member) => member instanceof parser.Class || member.constructor.name === parser.name),
  );
  assert.deepEqual(
    offenders.map((parser) => `${parser.name} (${[...parser.hazards].join(", ")})`),
    [],
    "a parser built on a hazard library is registered in the in-process ripstream: route it through the isolator",
  );
});

test("the parent's parser set is exactly the five text parsers, by class name", () => {
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

test("every hazard parser declares capabilities.unsafe", () => {
  const undeclared = hazardParsers.filter((parser) => parser.instance.capabilities?.unsafe !== true);
  assert.deepEqual(
    undeclared.map((parser) => `${parser.name} (${parser.reasons.join("; ")})`),
    [],
    "a parser built on a hazard library must say so: add `unsafe: true` to its capabilities",
  );
});

test("the in-process parsers declare no unsafe capability", () => {
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

// The scanner against the fixture tree: what the real tree has no example of, and what it must leave alone.

function fixtureParser(name: string): HazardParser {
  const parser = fixture.hazardParsers.find((candidate) => candidate.name === name);
  assert.ok(parser !== undefined, `${name} was not flagged; flagged: ${fixture.hazardParsers.map((candidate) => candidate.name).join(", ")}`);
  return parser;
}

test("fixture: the scanner flags exactly the hazard parsers of the fixture tree", () => {
  assert.deepEqual(
    fixture.hazardParsers.map((parser) => parser.name),
    [
      "CrossPackageSubclassParser",
      "CrossPackageWrapperParser",
      "FactoryMadeParser",
      "HazardParser",
      "InheritingParser",
      "InternalNameParser",
      "InternalOnlyParser",
    ],
  );
  assert.deepEqual(fixture.workspace.unresolved, []);
});

test("fixture: it does not flag clean parsers, a clean subclass, or a clean cross-package import (and did see them)", () => {
  const discovered = new Set([...fixture.discovered.keys()].map((Class) => Class.name));
  for (const clean of ["CleanParser", "CleanChildParser"]) {
    assert.ok(discovered.has(clean), `${clean} was not discovered, so not flagging it proves nothing`);
    assert.ok(!fixture.hazardParsers.some((parser) => parser.name === clean), `${clean} is flagged`);
  }
  const clean = fixture.workspace.files.get(join(FIXTURE_ROOT, "packages", "clean", "src", "clean.ts"));
  assert.deepEqual([...(clean?.hazards ?? ["missing"])], []);
});

test("fixture: it flags a parser that reaches a hazard only through another package", () => {
  const wrapper = fixtureParser("CrossPackageWrapperParser");
  const file = fixture.workspace.files.get(join(FIXTURE_ROOT, "packages", "wrapper", "src", "wrapper.ts"));
  assert.ok(file?.hazards.has("exifr"), "the taint must cross the package boundary");
  assert.equal(file?.text.includes("exifr"), false, "the wrapper must not name the hazard library itself");
  assert.deepEqual(wrapper.reasons, ["declared in packages/wrapper/src/wrapper.ts"]);
});

test("fixture: it flags a subclass that inherits getSupportedTypes, in the same package and in another", () => {
  for (const [name, path] of [
    ["InheritingParser", join("base", "src", "inheriting.ts")],
    ["CrossPackageSubclassParser", join("wrapper", "src", "subclass.ts")],
  ] as const) {
    const text = readFileSync(join(FIXTURE_ROOT, "packages", path), "utf8");
    assert.equal(/getSupportedTypes/.test(text), false, `${name}'s file must not mention getSupportedTypes, or this proves nothing`);
    assert.ok(fixtureParser(name).reasons.includes("extends HazardParser"), `${name} was not recognised as a subclass of HazardParser`);
  }
});

test("fixture: it flags a class that is exported only under another name", () => {
  const aliased = fixtureParser("InternalNameParser");
  assert.deepEqual(aliased.exportedAs, ["AliasedPublicParser"]);
  assert.deepEqual([...aliased.hazards], ["sql.js"]);
});

test("fixture: it flags a class that its package entry does not export", () => {
  const index = readFileSync(join(FIXTURE_ROOT, "packages", "base", "src", "index.ts"), "utf8");
  assert.equal(index.includes("InternalOnlyParser") || index.includes("internal.ts"), false, "the entry must not export it, or this proves nothing");
  assert.deepEqual(fixtureParser("InternalOnlyParser").exportedAs, ["InternalOnlyParser"]);
});

test("fixture: it flags a class that only the prototype chain of an export reveals", () => {
  const text = readFileSync(join(FIXTURE_ROOT, "packages", "wrapper", "src", "factory-made.ts"), "utf8");
  assert.equal(/\bclass\b|getSupportedTypes\s*\(/.test(text.replace(/\/\/.*$/gm, "")), false, "the file must declare no class and no getSupportedTypes");
  // Not declared in a tainted file under any name: the prototype chain is the only thing that shows it.
  assert.deepEqual(fixtureParser("FactoryMadeParser").reasons, ["extends HazardParser"]);
});
