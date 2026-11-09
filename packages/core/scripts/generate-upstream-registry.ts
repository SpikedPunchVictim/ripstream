// Generates src/generated/upstream-services.ts from the Apache Tika source at a pinned release.
//
// Tika 3.x listed components in META-INF/services files. Tika 4.x does not: classes carry @TikaComponent and an
// annotation processor writes the indexes at build time, so the source tree has no Parser service file at all.
// This script therefore reads the Java sources: it finds every @TikaComponent class, resolves its supertypes across
// the whole tree, and maps it to an index with the SAME interface table the processor uses (read from
// TikaComponentProcessor.java, not copied). Hand-written service files that still exist are included.
//
// The release tarball is streamed and read in memory; nothing from it is written to disk or executed.
//
//   node scripts/generate-upstream-registry.ts [--ref 4.2.0]
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const DEFAULT_REF = "4.2.0";
const USER_AGENT = { "User-Agent": "ripstream-registry-generator" };
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

interface TarFile {
  readonly path: string;
  readonly text: string;
}

/** Selected files of a gzip'd tar stream; everything else is skipped without being buffered. */
async function readTarball(
  chunks: AsyncIterable<Buffer>,
  select: (path: string) => boolean,
): Promise<TarFile[]> {
  const files: TarFile[] = [];
  let buffer = Buffer.alloc(0);
  let pending: { path: string; remaining: number; keep: boolean; parts: Buffer[]; padding: number } | null = null;
  let paxPath: string | null = null;
  let longName: string | null = null;
  let pendingMeta: { kind: "pax" | "long"; remaining: number; padding: number; parts: Buffer[] } | null = null;
  let ended = false;

  const octal = (header: Buffer, start: number, length: number): number =>
    parseInt(header.toString("latin1", start, start + length).replace(/\0.*$/s, "").trim() || "0", 8);

  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (pending !== null) {
        const take = Math.min(buffer.length, pending.remaining);
        if (pending.keep) pending.parts.push(buffer.subarray(0, take));
        pending.remaining -= take;
        buffer = buffer.subarray(take);
        if (pending.remaining > 0) break;
        if (buffer.length < pending.padding) break;
        buffer = buffer.subarray(pending.padding);
        if (pending.keep) files.push({ path: pending.path, text: Buffer.concat(pending.parts).toString("utf8") });
        pending = null;
        continue;
      }
      if (pendingMeta !== null) {
        const take = Math.min(buffer.length, pendingMeta.remaining);
        pendingMeta.parts.push(buffer.subarray(0, take));
        pendingMeta.remaining -= take;
        buffer = buffer.subarray(take);
        if (pendingMeta.remaining > 0 || buffer.length < pendingMeta.padding) break;
        buffer = buffer.subarray(pendingMeta.padding);
        const body = Buffer.concat(pendingMeta.parts).toString("utf8");
        if (pendingMeta.kind === "long") longName = body.replace(/\0.*$/s, "");
        else paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(`\n${body}`)?.[1] ?? paxPath;
        pendingMeta = null;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) {
        ended = true;
        break;
      }
      const size = octal(header, 124, 12);
      const type = String.fromCharCode(header[156] ?? 0);
      const padding = (512 - (size % 512)) % 512;
      if (type === "x" || type === "L") {
        pendingMeta = { kind: type === "x" ? "pax" : "long", remaining: size, padding, parts: [] };
        continue;
      }
      if (type === "g") {
        pendingMeta = { kind: "pax", remaining: size, padding, parts: [] };
        paxPath = null; // a global header names no file
        continue;
      }
      const name = header.toString("latin1", 0, 100).replace(/\0.*$/s, "");
      const prefix = header.toString("latin1", 345, 500).replace(/\0.*$/s, "");
      const path = paxPath ?? longName ?? (prefix.length > 0 ? `${prefix}/${name}` : name);
      paxPath = null;
      longName = null;
      const regular = type === "0" || type === "\0";
      const keep = regular && select(path) && size <= MAX_SOURCE_BYTES;
      if (size === 0) {
        if (keep) files.push({ path, text: "" });
        continue;
      }
      pending = { path, remaining: size, keep, parts: [], padding };
    }
    if (ended) break;
  }
  return files;
}

// ---- Java: just enough structure to find @TikaComponent classes and their supertypes -------------------------------

interface JavaClass {
  readonly fqcn: string;
  readonly simple: string;
  readonly pkg: string;
  readonly module: string;
  readonly imports: readonly string[];
  readonly supers: readonly string[];
  readonly annotation: { readonly args: string } | null;
}

/** Same length as the input: comments become spaces, so offsets stay valid. */
function blankComments(source: string): string {
  return source.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.startsWith("/") ? match.replace(/[^\n]/g, " ") : match,
  );
}

/** Same length as the input: string and char literal contents become spaces. */
function blankLiterals(source: string): string {
  return source.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)'/g, (match) => match[0] + " ".repeat(match.length - 2) + match[0]);
}

function stripGenerics(text: string): string {
  let current = text;
  for (let next = current.replace(/<[^<>]*>/g, ""); next !== current; next = current.replace(/<[^<>]*>/g, "")) {
    current = next;
  }
  return current;
}

function moduleOf(path: string): string {
  const marker = path.indexOf("/src/main/");
  return marker === -1 ? path : path.slice(0, marker);
}

function parseJava(path: string, source: string): JavaClass[] {
  const clean = blankComments(source);
  const shape = blankLiterals(clean);
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(shape)?.[1] ?? "";
  const imports = [...shape.matchAll(/^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm)].map((m) => m[1] as string);
  const classes: JavaClass[] = [];
  let depth = 0;
  const declaration = /\b(?:class|interface|enum|record|@interface)\s+(\w+)/g;
  for (let index = 0; index < shape.length; index++) {
    const char = shape[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (depth === 0 && (char === "c" || char === "i" || char === "e" || char === "r" || char === "@")) {
      declaration.lastIndex = index;
      const match = declaration.exec(shape);
      if (match === null || match.index !== index) continue;
      const open = shape.indexOf("{", index);
      if (open === -1) break;
      const header = stripGenerics(shape.slice(index + match[0].length, open));
      const [beforeImplements = "", implementsText = ""] = header.split(/\bimplements\b/);
      const [, extendsText = ""] = beforeImplements.split(/\bextends\b/);
      const supers = `${extendsText},${implementsText.replace(/\bpermits\b[\s\S]*$/, "")}`
        .split(",")
        .map((name) => name.replace(/\bpermits\b[\s\S]*$/, "").trim())
        .filter((name) => /^[\w.]+$/.test(name));
      const lead = Math.max(shape.lastIndexOf(";", index), shape.lastIndexOf("}", index), shape.lastIndexOf("{", index)) + 1;
      const annotation = /@TikaComponent\b(\s*\(([^)]*)\))?/.exec(clean.slice(lead, index));
      const simple = match[1] as string;
      classes.push({
        fqcn: pkg === "" ? simple : `${pkg}.${simple}`,
        simple,
        pkg,
        module: moduleOf(path),
        imports,
        supers,
        annotation: annotation === null ? null : { args: annotation[2] ?? "" },
      });
      index = open - 1;
    }
  }
  return classes;
}

function annotationValue(args: string, key: string): string | null {
  const match = new RegExp(`\\b${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|[\\w.]+)`).exec(args);
  return match === null ? null : (match[1] as string);
}

function kebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-zA-Z])(\d)/g, "$1-$2")
    .replace(/(\d)([a-zA-Z])/g, "$1-$2")
    .toLowerCase();
}

// ---- Generation ------------------------------------------------------------------------------------------------

interface Component {
  readonly class: string;
  readonly kind: string;
  readonly name: string;
  readonly module: string;
  readonly spi: boolean;
  readonly source: "annotation" | "service-file";
  readonly contextKey?: string;
  readonly defaultFor?: string;
}

const LEGACY = { parsers: "UPSTREAM_PARSERS", detectors: "UPSTREAM_DETECTORS", "encoding-detectors": "UPSTREAM_ENCODING_DETECTORS" } as const;

function argument(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

async function main(): Promise<void> {
  const ref = argument("--ref", DEFAULT_REF);
  const treeResponse = await fetch(`https://api.github.com/repos/apache/tika/git/trees/${ref}`, { headers: USER_AGENT });
  if (!treeResponse.ok) throw new Error(`GitHub tree request failed: ${treeResponse.status}`);
  const treeSha = ((await treeResponse.json()) as { sha: string }).sha;

  const tarball = await fetch(`https://codeload.github.com/apache/tika/tar.gz/refs/tags/${ref}`, { headers: USER_AGENT });
  if (!tarball.ok || tarball.body === null) throw new Error(`Tarball request failed: ${tarball.status}`);
  const select = (path: string): boolean => {
    const inner = path.slice(path.indexOf("/") + 1);
    if (inner.includes("/src/test/")) return false;
    return (
      (inner.includes("/src/main/java/") && inner.endsWith(".java")) ||
      (inner.includes("/src/main/resources/META-INF/services/") && !inner.endsWith(".md"))
    );
  };
  const raw = await readTarball(Readable.fromWeb(tarball.body as never).pipe(createGunzip()), select);
  const files = raw
    .map((file) => ({ path: file.path.slice(file.path.indexOf("/") + 1), text: file.text }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const processor = files.find((file) => file.path.endsWith("/TikaComponentProcessor.java"));
  if (processor === undefined) throw new Error("TikaComponentProcessor.java not found: the registration scheme changed");
  const interfaces = new Map<string, string>(
    [...processor.text.matchAll(/SERVICE_INTERFACES\.put\("([\w.]+)",\s*"([\w-]+)"\)/g)].map((m) => [m[1] as string, m[2] as string]),
  );
  if (interfaces.size === 0) throw new Error("no SERVICE_INTERFACES entries found in TikaComponentProcessor.java");

  const classes = new Map<string, JavaClass>();
  const bySimple = new Map<string, JavaClass[]>();
  for (const file of files) {
    if (!file.path.endsWith(".java")) continue;
    for (const parsed of parseJava(file.path, file.text)) {
      classes.set(parsed.fqcn, parsed);
      bySimple.set(parsed.simple, [...(bySimple.get(parsed.simple) ?? []), parsed]);
    }
  }

  const resolve = (from: JavaClass, name: string): string | null => {
    if (classes.has(name)) return name;
    const simple = name.slice(name.lastIndexOf(".") + 1);
    const imported = from.imports.find((entry) => entry.endsWith(`.${simple}`));
    if (imported !== undefined) return classes.has(imported) ? imported : interfaces.has(imported) ? imported : null;
    const samePackage = `${from.pkg}.${simple}`;
    if (classes.has(samePackage)) return samePackage;
    for (const entry of from.imports) {
      if (entry.endsWith(".*") && classes.has(`${entry.slice(0, -2)}.${simple}`)) return `${entry.slice(0, -2)}.${simple}`;
    }
    const candidates = bySimple.get(simple) ?? [];
    return candidates.length === 1 ? (candidates[0] as JavaClass).fqcn : null;
  };
  const ancestors = (start: JavaClass): Set<string> => {
    const seen = new Set<string>();
    const walk = (current: JavaClass): void => {
      for (const name of current.supers) {
        const fqcn = resolve(current, name);
        if (fqcn === null || seen.has(fqcn)) continue;
        seen.add(fqcn);
        const parent = classes.get(fqcn);
        if (parent !== undefined) walk(parent);
      }
    };
    walk(start);
    return seen;
  };

  const components: Component[] = [];
  const add = (component: Component): void => {
    if (!components.some((c) => c.class === component.class && c.kind === component.kind)) components.push(component);
  };

  for (const parsed of classes.values()) {
    if (parsed.annotation === null) continue;
    const args = parsed.annotation.args;
    const nameValue = annotationValue(args, "name");
    const name = nameValue === null ? kebabCase(parsed.simple) : nameValue.replace(/^"|"$/g, "");
    const spi = annotationValue(args, "spi") !== "false";
    const contextKey = annotationValue(args, "contextKey")?.replace(/\.class$/, "");
    const defaultFor = annotationValue(args, "defaultFor")?.replace(/\.class$/, "");
    const reached = ancestors(parsed);
    const kinds = [...interfaces].filter(([fqcn]) => reached.has(fqcn)).map(([, kind]) => kind);
    const base = { class: parsed.fqcn, name, module: parsed.module, spi, source: "annotation" as const };
    const extra = { ...(contextKey === undefined ? {} : { contextKey }), ...(defaultFor === undefined ? {} : { defaultFor }) };
    if (kinds.length === 0) add({ ...base, ...extra, kind: "parse-context" });
    else for (const kind of kinds) add({ ...base, ...extra, kind });
  }

  const IGNORED_SERVICES = new Set([
    "javax.annotation.processing.Processor",
    "java.nio.file.spi.FileTypeDetector",
    "org.junit.platform.launcher.LauncherSessionListener",
    "org.junit.platform.launcher.TestExecutionListener",
    "org.apache.lucene.analysis.TokenFilterFactory",
  ]);
  for (const file of files) {
    const marker = "/META-INF/services/";
    const at = file.path.indexOf(marker);
    if (at === -1) continue;
    const service = file.path.slice(at + marker.length);
    if (IGNORED_SERVICES.has(service)) continue;
    const kind = interfaces.get(service) ?? service.slice(service.lastIndexOf(".") + 1);
    for (const line of file.text.split(/\r?\n/)) {
      const fqcn = line.replace(/#.*/, "").trim();
      if (fqcn.length === 0) continue;
      add({ class: fqcn, kind, name: kebabCase(fqcn.slice(fqcn.lastIndexOf(".") + 1)), module: moduleOf(file.path), spi: true, source: "service-file" });
    }
  }
  components.sort((a, b) => a.kind.localeCompare(b.kind) || a.module.localeCompare(b.module) || a.class.localeCompare(b.class));

  const checksum = createHash("sha256")
    .update(files.map((file) => `${file.path}\n${file.text}`).join("\n"))
    .digest("hex");

  const grouped = (kind: string): Array<{ module: string; classes: string[] }> => {
    const byModule = new Map<string, Set<string>>();
    // The default registry is what ServiceLoader would find: opt-in (spi = false) components are excluded.
    for (const c of components.filter((entry) => entry.kind === kind && entry.spi)) {
      byModule.set(c.module, (byModule.get(c.module) ?? new Set()).add(c.class));
    }
    return [...byModule].sort(([a], [b]) => a.localeCompare(b)).map(([module, set]) => ({ module, classes: [...set].sort() }));
  };
  const count = (kind: string): number => new Set(components.filter((c) => c.kind === kind && c.spi).map((c) => c.class)).size;

  const lines: string[] = [
    "// Generated by packages/core/scripts/generate-upstream-registry.ts — do not edit.",
    `// Upstream: apache/tika ${ref}, tree ${treeSha}.`,
    `// source sha256: ${checksum}`,
    "",
    "export interface UpstreamServiceGroup {",
    "  readonly module: string;",
    "  readonly classes: readonly string[];",
    "}",
    "",
    "/** One Tika component: a @TikaComponent class (or a hand-written service file entry), as the build indexes it. */",
    "export interface UpstreamComponent {",
    "  readonly class: string;",
    "  /** Index the component is listed in: parsers, detectors, renderers, metadata-filters, parse-context, ... */",
    "  readonly kind: string;",
    "  /** Name used by name-based lookup in Tika configuration. */",
    "  readonly name: string;",
    "  readonly module: string;",
    "  /** False for opt-in components that Tika's default loading does not register. */",
    "  readonly spi: boolean;",
    '  readonly source: "annotation" | "service-file";',
    "  readonly contextKey?: string;",
    "  readonly defaultFor?: string;",
    "}",
    "",
  ];
  for (const [kind, constant] of Object.entries(LEGACY)) {
    lines.push(`export const ${constant}: readonly UpstreamServiceGroup[] = [`);
    for (const group of grouped(kind)) lines.push(`  ${JSON.stringify(group)},`);
    lines.push("];", "");
  }
  lines.push("export const UPSTREAM_COMPONENTS: readonly UpstreamComponent[] = [");
  for (const component of components) lines.push(`  ${JSON.stringify(component)},`);
  lines.push("];", "");
  const kinds = [...new Set(components.map((c) => c.kind))].sort();
  lines.push("export const UPSTREAM_SERVICE_STATS = Object.freeze({");
  lines.push(`  ref: ${JSON.stringify(ref)},`);
  lines.push(`  parserClasses: ${count("parsers")},`);
  lines.push(`  detectorClasses: ${count("detectors")},`);
  lines.push(`  encodingDetectorClasses: ${count("encoding-detectors")},`);
  lines.push(`  components: ${components.length},`);
  lines.push(`  kinds: ${JSON.stringify(kinds)},`);
  lines.push("});");

  writeFileSync(new URL("../src/generated/upstream-services.ts", import.meta.url), `${lines.join("\n")}\n`);
  const perKind = kinds.map((kind) => `${kind}=${count(kind)}`).join(", ");
  console.log(`generated upstream components for ${ref}: ${components.length} (${perKind}); ${files.length} files read`);
}

await main();
