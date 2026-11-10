// Parser parity matrix against Apache Tika 4.2.0.
//
//   node scripts/parity-matrix.ts           write docs/parity-matrix.{json,md}
//   node scripts/parity-matrix.ts --check   fail when the files are stale or any gap is undeclared
//
// Sources, in order of authority:
//   packages/parity/oracle/tika-4.2.0-parsers.json   what the real 4.2.0 server loads, with each parser's media types
//                                                    (GET /parsers/details; checked in so this runs without Docker)
//   packages/core/src/generated/upstream-services.ts every @TikaComponent parser in the 4.2.0 source (extended and
//                                                    opt-in ones the standard server does not load)
//   tasks/parity/declared.json                       owner decisions: non-goals, tracked gaps, accepted fallbacks
// "Covered" means the REAL default registry would pick a parser for the type, by the same lookup the parser uses.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../packages/core/src/index.ts";
import { UPSTREAM_COMPONENTS, MediaType } from "../packages/core/src/index.ts";
import { TesseractOcrParser } from "../packages/parser-media/src/index.ts";
import { createDefaultParser } from "../packages/parsers/src/index.ts";

export type Resolution = "exact" | "fallback" | "none";
export type DeclaredStatus = "non-goal" | "tracked" | "accepted-fallback";

export interface DeclaredRule {
  readonly id: string;
  readonly match: { readonly type?: string; readonly class?: string };
  readonly status: DeclaredStatus;
  readonly reason: string;
  readonly bead?: string;
}

export interface Declared {
  readonly version: 1;
  readonly rules: readonly DeclaredRule[];
  /** Tika classes the standard server does not load, implemented here: class -> ripstream parser name(s). */
  readonly implementedBy: Readonly<Record<string, string | readonly string[]>>;
}

export interface TypeRow {
  readonly type: string;
  readonly resolution: Resolution;
  readonly by: string | null;
  readonly declared: string | null;
}

export interface ParserRow {
  readonly class: string;
  readonly module: string;
  readonly tier: "standard" | "extended" | "opt-in";
  readonly status: "implemented" | "partial" | "fallback" | "gap" | "non-goal" | "tracked" | "undeclared";
  readonly typeCount: number;
  readonly exact: number;
  /** Non-exact types only; exact ones are counted. */
  readonly open: readonly TypeRow[];
  readonly implementedBy: readonly string[];
  readonly declared: string | null;
}

export interface Matrix {
  readonly generatedBy: "scripts/parity-matrix.ts";
  readonly oracle: { readonly tikaVersion: string; readonly parsers: number; readonly typeClaims: number };
  readonly summary: Readonly<Record<string, number>>;
  readonly parsers: readonly ParserRow[];
}

export interface Problem {
  readonly kind: "undeclared" | "stale-rule" | "bad-rule" | "unknown-parser" | "oracle-not-generated";
  readonly detail: string;
}

interface Snapshot {
  readonly tikaVersion: string;
  readonly parsers: ReadonlyArray<{ readonly name: string; readonly supportedTypes: readonly string[] }>;
}

const root = (path: string): URL => new URL(`../${path}`, import.meta.url);
const readJson = <T>(path: string): T => JSON.parse(readFileSync(root(path), "utf8")) as T;

export function loadDeclared(): Declared {
  return readJson<Declared>("tasks/parity/declared.json");
}

export async function buildMatrix(declared: Declared = loadDeclared()): Promise<{ matrix: Matrix; problems: Problem[] }> {
  const snapshot = readJson<Snapshot>("packages/parity/oracle/tika-4.2.0-parsers.json");
  const composite = createDefaultParser();
  const context = new core.ParseContext();
  // Parsers that exist but are opt-in (not in the default registry), like Tika's non-SPI components.
  const optIn = ["CompositeParser", "EmptyParser", "ErrorParser"].filter((name) => typeof (core as Record<string, unknown>)[name] === "function");
  const registered = new Set([...composite.getParsers().map((parser) => parser.name), ...optIn, new TesseractOcrParser().name]);

  /** What the real default registry does with the type: the parser CompositeParser would run first. */
  const resolve = async (raw: string): Promise<{ resolution: Resolution; by: string | null }> => {
    const parsed = MediaType.parse(raw);
    if (parsed === null) return { resolution: "none", by: null };
    const [first] = await composite.selectParsers(parsed, context);
    if (first === undefined) return { resolution: "none", by: null };
    return { resolution: first.kind === "exact" ? "exact" : "fallback", by: first.parser.name };
  };

  const problems: Problem[] = [];
  const used = new Set<string>();
  const find = (cls: string, type: string | null): DeclaredRule | null => {
    for (const rule of declared.rules) {
      if (rule.match.class !== undefined && !new RegExp(rule.match.class).test(cls)) continue;
      if (rule.match.type !== undefined && (type === null || !new RegExp(rule.match.type).test(type))) continue;
      if (rule.match.class === undefined && rule.match.type === undefined) continue;
      return rule;
    }
    return null;
  };

  for (const rule of declared.rules) {
    if (rule.status === "tracked" && !/^tikajs-[a-z0-9.]+$/.test(rule.bead ?? "")) {
      problems.push({ kind: "bad-rule", detail: `${rule.id}: a tracked rule needs a bead id` });
    }
    if (rule.status !== "tracked" && rule.reason.trim().length === 0) {
      problems.push({ kind: "bad-rule", detail: `${rule.id}: ${rule.status} needs a reason` });
    }
  }

  const rows: ParserRow[] = [];
  const oracleNames = new Set(snapshot.parsers.map((parser) => parser.name));
  const generated = new Map(UPSTREAM_COMPONENTS.filter((c) => c.kind === "parsers").map((c) => [c.class, c]));

  for (const parser of snapshot.parsers) {
    const component = generated.get(parser.name);
    if (component === undefined) problems.push({ kind: "oracle-not-generated", detail: parser.name });
    const types = [...new Set(parser.supportedTypes)].sort();
    const open: TypeRow[] = [];
    let exact = 0;
    const by = new Set<string>();
    for (const type of types) {
      const result = await resolve(type);
      if (result.by !== null) by.add(result.by);
      if (result.resolution === "exact") {
        exact += 1;
        continue;
      }
      const rule = find(parser.name, type);
      if (rule !== null) {
        used.add(rule.id);
        if (rule.status === "accepted-fallback" && result.resolution === "none") {
          problems.push({ kind: "bad-rule", detail: `${rule.id}: accepts a fallback for ${type}, but no parser takes it` });
        }
      } else problems.push({ kind: "undeclared", detail: `${parser.name} ${type} (${result.resolution})` });
      open.push({ type, resolution: result.resolution, by: result.by, declared: rule?.id ?? null });
    }
    const statuses = new Set(open.map((row) => (row.declared === null ? "undeclared" : (declared.rules.find((r) => r.id === row.declared) as DeclaredRule).status)));
    const noneLeft = open.filter((row) => row.resolution === "none").length;
    let status: ParserRow["status"];
    if (open.length === 0) status = "implemented";
    else if (exact > 0) status = statuses.has("undeclared") ? "undeclared" : "partial";
    else if (noneLeft === 0) status = statuses.has("undeclared") ? "undeclared" : "fallback";
    else if (statuses.has("undeclared")) status = "undeclared";
    else status = statuses.size === 1 && statuses.has("non-goal") ? "non-goal" : "tracked";
    rows.push({
      class: parser.name,
      module: component?.module ?? "(not in generated registry)",
      tier: "standard",
      status,
      typeCount: types.length,
      exact,
      open,
      implementedBy: [...by].sort(),
      declared: null,
    });
  }

  for (const component of generated.values()) {
    if (oracleNames.has(component.class)) continue;
    const mapped = declared.implementedBy[component.class];
    const names = mapped === undefined ? [] : Array.isArray(mapped) ? [...mapped] : [mapped as string];
    for (const name of names) {
      if (!registered.has(name)) problems.push({ kind: "unknown-parser", detail: `${component.class} -> ${name} is not in the default registry` });
    }
    const rule = names.length > 0 ? null : find(component.class, null);
    if (rule !== null) used.add(rule.id);
    else if (names.length === 0) problems.push({ kind: "undeclared", detail: `${component.class} (${component.spi ? "extended" : "opt-in"} class, no types in the oracle)` });
    rows.push({
      class: component.class,
      module: component.module,
      tier: component.spi ? "extended" : "opt-in",
      status: names.length > 0 ? "implemented" : rule === null ? "undeclared" : rule.status === "non-goal" ? "non-goal" : "tracked",
      typeCount: 0,
      exact: 0,
      open: [],
      implementedBy: names,
      declared: rule?.id ?? null,
    });
  }

  for (const rule of declared.rules) {
    if (!used.has(rule.id)) problems.push({ kind: "stale-rule", detail: `${rule.id} matches nothing that is still open` });
  }

  rows.sort((a, b) => a.tier.localeCompare(b.tier) || a.class.localeCompare(b.class));
  const summary: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.tier}.${row.status}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  const claims = snapshot.parsers.reduce((sum, parser) => sum + new Set(parser.supportedTypes).size, 0);
  const matrix: Matrix = {
    generatedBy: "scripts/parity-matrix.ts",
    oracle: { tikaVersion: snapshot.tikaVersion, parsers: snapshot.parsers.length, typeClaims: claims },
    summary: Object.fromEntries(Object.entries(summary).sort(([a], [b]) => a.localeCompare(b))),
    parsers: rows,
  };
  return { matrix, problems };
}

export function renderMarkdown(matrix: Matrix, declared: Declared): string {
  const short = (cls: string): string => cls.slice(cls.lastIndexOf(".") + 1);
  const lines = [
    "# Parser parity matrix",
    "",
    `Oracle: Apache Tika ${matrix.oracle.tikaVersion} (${matrix.oracle.parsers} standard parsers, ${matrix.oracle.typeClaims} media-type claims). Generated by \`node scripts/parity-matrix.ts\`; do not edit.`,
    "",
    "A type is **exact** when the default registry picks a parser for it directly, **fallback** when only a supertype has one (Tika would use a specific parser), **none** otherwise. Every non-exact type or class carries a declared decision (`tasks/parity/declared.json`); a test fails otherwise.",
    "",
    "| Tier | Status | Parsers |",
    "|---|---|---:|",
    ...Object.entries(matrix.summary).map(([key, count]) => `| ${key.split(".")[0]} | ${key.split(".")[1]} | ${count} |`),
    "",
    "## Open items",
    "",
    "| Parser | Tier | Type / class | Resolution | Decision |",
    "|---|---|---|---|---|",
  ];
  for (const row of matrix.parsers) {
    if (row.status === "implemented") continue;
    const decision = (id: string | null): string => {
      const rule = declared.rules.find((r) => r.id === id);
      return rule === undefined ? "UNDECLARED" : `${rule.status}${rule.bead === undefined ? "" : ` ${rule.bead}`}: ${rule.reason}`;
    };
    if (row.open.length === 0) lines.push(`| ${short(row.class)} | ${row.tier} | (class) | - | ${decision(row.declared)} |`);
    for (const open of row.open) lines.push(`| ${short(row.class)} | ${row.tier} | ${open.type} | ${open.resolution}${open.by === null ? "" : ` via ${open.by}`} | ${decision(open.declared)} |`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The media types each standard-server Tika parser claims, by component name: what a `parsers` section is applied
 * against (packages/parsers/src/parser-config.ts). Emitted here so the oracle snapshot stays the one source and this
 * file is checked for staleness with the rest.
 */
export function renderParserTypes(): string {
  const snapshot = readJson<Snapshot>("packages/parity/oracle/tika-4.2.0-parsers.json");
  const names = new Map(UPSTREAM_COMPONENTS.filter((c) => c.kind === "parsers").map((c) => [c.class, c.name]));
  const lines = snapshot.parsers
    .map((parser) => {
      const name = names.get(parser.name);
      if (name === undefined) throw new Error(`${parser.name} is in the oracle snapshot but not in the generated registry`);
      return [name, [...new Set(parser.supportedTypes)].sort()] as const;
    })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, types]) => `  ${JSON.stringify(name)}: ${JSON.stringify(types)},`);
  return [
    "// Generated by scripts/parity-matrix.ts from packages/parity/oracle/tika-4.2.0-parsers.json: do not edit.",
    `// Apache Tika ${snapshot.tikaVersion}: the media types each parser the standard server loads claims, by component name.`,
    "",
    "export const TIKA_PARSER_TYPES: Readonly<Record<string, readonly string[]>> = {",
    ...lines,
    "};",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const declared = loadDeclared();
  const { matrix, problems } = await buildMatrix(declared);
  const json = `${JSON.stringify(matrix, null, 1)}\n`;
  const markdown = renderMarkdown(matrix, declared);
  const parserTypes = renderParserTypes();
  const parserTypesPath = "packages/parsers/src/generated/tika-parser-types.ts";
  const check = process.argv.includes("--check");
  if (check) {
    for (const [path, content] of [
      ["docs/parity-matrix.json", json],
      ["docs/parity-matrix.md", markdown],
      [parserTypesPath, parserTypes],
    ] as const) {
      let current = "";
      try {
        current = readFileSync(root(path), "utf8");
      } catch {
        // missing counts as stale
      }
      if (current !== content) problems.push({ kind: "stale-rule", detail: `${path} is stale: run node scripts/parity-matrix.ts` });
    }
  } else {
    writeFileSync(root("docs/parity-matrix.json"), json);
    writeFileSync(root("docs/parity-matrix.md"), markdown);
    mkdirSync(dirname(fileURLToPath(root(parserTypesPath))), { recursive: true });
    writeFileSync(root(parserTypesPath), parserTypes);
  }
  console.log(Object.entries(matrix.summary).map(([key, count]) => `${key}=${count}`).join(" "));
  for (const problem of problems) console.error(`${problem.kind}: ${problem.detail}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("parity-matrix.ts")) await main();
