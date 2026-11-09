import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { containmentFor, type Containment } from "./containment.ts";
import { sampleRssMb } from "./rss.ts";
import { runChild } from "./supervisor.ts";

/**
 * One-time availability probe, run by the caller at construction. It runs a
 * tiny built-in child through the SAME wrapper / ulimit / supervisor path a
 * real parse uses. There is no per-call fallback anywhere: if the probe says
 * unavailable, the caller decides once (fail closed in strict mode, run
 * in-process in lenient mode).
 */

export type ProbeResult =
  | { readonly available: true; readonly containment: Containment }
  | { readonly available: false; readonly reason: string };

export interface ProbeOptions {
  /** Node executable. Default process.execPath. */
  readonly nodePath?: string;
  readonly platform?: NodeJS.Platform;
  /** Use the same values the real runner will use so ulimit refusals show up here. */
  readonly cpuSecs?: number;
  readonly heapMb?: number;
  readonly vmemKb?: number;
  readonly execArgv?: readonly string[];
  /** Where the probe child's private directory is made; pass the runner's so the probe shows that it works. */
  readonly tempDir?: string;
  /** Called when the probe child's directory could not be removed. The probe's answer is unaffected. */
  readonly onTempCleanupError?: (message: string) => void;
  /** Whole-probe budget in ms. Default 10 s. */
  readonly timeoutMs?: number;
  /** @internal Test seam: replaces the built-in probe child script. */
  readonly probeScript?: string;
  /** @internal Test seam: arguments for `probeScript`. */
  readonly probeScriptArgs?: readonly string[];
}

const PROBE_INPUT = new Uint8Array([0x72, 0x69, 0x70]);
const DEFAULT_TIMEOUT_MS = 10_000;

/** probe-child next to this file, with this file's extension: .ts in dev and tests, .js after build. */
function builtInProbeScript(): string {
  const here = fileURLToPath(import.meta.url);
  return fileURLToPath(new URL(`./probe-child${extname(here)}`, import.meta.url));
}

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

/** Never throws. */
export async function probeIsolation(options: ProbeOptions = {}): Promise<ProbeResult> {
  const platform = options.platform ?? process.platform;
  try {
    const result = await runChild({
      scriptPath: options.probeScript ?? builtInProbeScript(),
      ...(options.probeScriptArgs === undefined ? {} : { scriptArgs: options.probeScriptArgs }),
      ...(options.nodePath === undefined ? {} : { nodePath: options.nodePath }),
      ...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
      ...(options.vmemKb === undefined ? {} : { vmemKb: options.vmemKb }),
      ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
      ...(options.onTempCleanupError === undefined ? {} : { onTempCleanupError: options.onTempCleanupError }),
      platform,
      cpuSecs: options.cpuSecs ?? 30,
      heapMb: options.heapMb ?? 64,
      request: { input: PROBE_INPUT, output: "text" },
      deadlineMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResultBytes: 64 * 1024,
    });
    if (result.kind !== "text" || result.text !== `probe-ok:${PROBE_INPUT.length}`) {
      return { available: false, reason: "probe child returned an unexpected answer" };
    }
    // Containment claims only what was shown to work: the RSS poll must be able to read this machine.
    const declared = containmentFor(platform);
    const rssWorks = declared.rssPoll === "none" || (await sampleRssMb(process.pid, platform)) !== null;
    return { available: true, containment: rssWorks ? declared : { ...declared, rssPoll: "none" } };
  } catch (error) {
    return { available: false, reason: `isolated parser probe failed: ${describeFailure(error)}` };
  }
}
