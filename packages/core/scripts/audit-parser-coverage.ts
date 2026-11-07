import { readFileSync } from "node:fs";
import { UPSTREAM_PARSERS } from "../src/generated/upstream-services.ts";

interface CoverageModule {
  readonly owner: string;
  readonly status: "implemented" | "partial" | "planned" | "aggregate";
  readonly notes?: string;
}

interface CoverageManifest {
  readonly version: 1;
  readonly modules: Readonly<Record<string, CoverageModule>>;
}

const manifest = JSON.parse(
  readFileSync(new URL("../../../tasks/parser-coverage.json", import.meta.url), "utf8"),
) as CoverageManifest;

const errors: string[] = [];
const seen = new Set<string>();
const counts: Record<string, number> = {};

for (const group of UPSTREAM_PARSERS) {
  seen.add(group.module);
  const coverage = manifest.modules[group.module];
  if (coverage === undefined) {
    errors.push(`unmapped module: ${group.module}`);
    continue;
  }
  if (!/^tikajs-[a-z0-9.]+$/.test(coverage.owner)) {
    errors.push(`invalid owner for ${group.module}: ${coverage.owner}`);
  }
  counts[coverage.status] = (counts[coverage.status] ?? 0) + group.classes.length;
}

for (const module of Object.keys(manifest.modules)) {
  if (!seen.has(module)) errors.push(`stale module mapping: ${module}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    `parser coverage: ${seen.size} modules, ${Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ")} classes`,
  );
}
