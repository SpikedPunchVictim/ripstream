import { execFile } from "node:child_process";
import { createRequire } from "node:module";

/** `ok`: fine. `warn`: an optional capability is unavailable. `fail`: a requirement is not met. */
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

export interface DoctorReport {
  /** False when a required check failed; a warning alone does not fail the run. */
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

/** What doctor looks at, so a test can stand in for the machine. */
export interface DoctorProbes {
  /** `process.versions.node`. */
  readonly nodeVersion: string;
  /** Whether the optional dependency `name` can be loaded by the package that needs it. */
  canImport(name: string): Promise<boolean>;
  /** The first line `tesseract --version` prints, or null when it is not on PATH. */
  tesseractVersion(): Promise<string | null>;
}

const MIN_NODE = { major: 22, minor: 18 };

/** Optional dependencies, each with what is lost without it. */
const OPTIONAL_DEPENDENCIES: readonly { readonly name: string; readonly capability: string }[] = [
  { name: "pdfjs-dist", capability: "PDF parsing" },
  { name: "cld3-asm", capability: "CLD3 language detection" },
];

function nodeCheck(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const supported = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return {
    name: "node",
    status: supported ? "ok" : "fail",
    detail: supported ? `${version}` : `${version}: Node >= ${MIN_NODE.major}.${MIN_NODE.minor} is required`,
  };
}

export async function runDoctor(probes: DoctorProbes = defaultProbes()): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck(probes.nodeVersion)];
  for (const { name, capability } of OPTIONAL_DEPENDENCIES) {
    const present = await probes.canImport(name);
    checks.push({
      name,
      status: present ? "ok" : "warn",
      detail: present ? "installed" : `not installed: ${capability} is unavailable`,
    });
  }
  const tesseract = await probes.tesseractVersion();
  checks.push({
    name: "tesseract",
    status: tesseract === null ? "warn" : "ok",
    detail: tesseract ?? "not on PATH: OCR is unavailable",
  });
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/**
 * Where each optional dependency is looked up from: the chain of packages that lead to the one that imports it. A
 * strict package manager (pnpm) links a dependency only into its owner, so asking from the CLI would say "missing"
 * for a dependency that is installed.
 */
const OWNER_CHAIN: Readonly<Record<string, readonly string[]>> = {
  "pdfjs-dist": ["@spikedpunch/ripstream-parsers", "@spikedpunch/ripstream-parser-pdf"],
  "cld3-asm": ["@spikedpunch/ripstream-language"],
};

function canResolve(name: string): boolean {
  try {
    let require = createRequire(import.meta.url);
    for (const owner of OWNER_CHAIN[name] ?? []) require = createRequire(require.resolve(owner));
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function tesseractFirstLine(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("tesseract", ["--version"], { timeout: 5000 }, (error, stdout, stderr) => {
      // Older builds print the version to stderr.
      const line = `${stdout}${stderr}`.split("\n")[0]?.trim();
      resolve(error !== null || line === undefined || line === "" ? null : line);
    });
  });
}

function defaultProbes(): DoctorProbes {
  return {
    nodeVersion: process.versions.node,
    canImport: async (name) => canResolve(name),
    tesseractVersion: tesseractFirstLine,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.map((c) => `${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  return `${lines.join("\n")}\n`;
}
