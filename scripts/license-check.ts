import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const policy = JSON.parse(readFileSync("license-policy.json", "utf8")) as {
  allowedLicenses: string[];
  exemptions: Record<string, string>;
};
const ALLOWED = new Set(policy.allowedLicenses);
const exempt = new Set(Object.keys(policy.exemptions));

interface LicenseGroup {
  readonly license: string;
  readonly name: string;
  readonly versions: readonly string[];
  readonly paths: readonly string[];
}

const raw = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const groups = Object.values(JSON.parse(raw) as Record<string, LicenseGroup[]>).flat();
const problems: string[] = [];
const seen = new Set<string>();

for (const group of groups) {
  const key = `${group.name}@${group.versions.join(",")}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!exempt.has(group.name) && !licenseAllowed(group.license)) {
    problems.push(`disallowed license ${group.license}: ${key}`);
  }
  for (const path of group.paths) {
    const manifest = join(path, "package.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const hook of ["preinstall", "install", "postinstall"]) {
      if (parsed.scripts?.[hook] !== undefined) {
        problems.push(`install script ${hook}: ${key}`);
      }
    }
  }
}

function licenseAllowed(expression: string): boolean {
  const tokens = expression
    .replace(/[()]/g, "")
    .split(/\s+(?:AND|OR)\s+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => ALLOWED.has(token));
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(
    `license check passed: ${seen.size} packages, ${exempt.size} policy exemptions`,
  );
}
