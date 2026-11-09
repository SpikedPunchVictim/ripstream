/**
 * What the harness can actually enforce on a platform, so P4 can show it in
 * /status and evaluate `requireStrictContainment`.
 *
 * Linux enforces everything. macOS has no `ulimit -v` (RLIMIT_AS is not
 * supported) and no /proc, so the address-space cap is absent and the RSS
 * poll is the weaker, slower `ps` poll. Anything else is treated like macOS
 * minus the RSS poll.
 */
export interface Containment {
  /** The parse runs in a separate, detached process group. Always true. */
  readonly processIsolation: true;
  /** V8 old-space is capped (--max-old-space-size). Always true. */
  readonly heapLimit: true;
  /** The parent kills the group at the wall-clock deadline. Always true. */
  readonly wallClock: true;
  /** How the parent measures child RSS: /proc statm (20 ms), `ps` (>= 250 ms), or not at all. */
  readonly rssPoll: "proc" | "ps" | "none";
  /** RLIMIT_AS (`ulimit -v`) is applied. Linux only. */
  readonly addressSpaceCap: boolean;
  /** RLIMIT_CPU (`ulimit -t`) is applied. */
  readonly cpuLimit: boolean;
}

export function supportsAddressSpaceCap(platform: NodeJS.Platform): boolean {
  return platform === "linux";
}

export function rssPollKind(platform: NodeJS.Platform): Containment["rssPoll"] {
  if (platform === "linux") return "proc";
  if (platform === "darwin") return "ps";
  return "none";
}

export function containmentFor(platform: NodeJS.Platform = process.platform): Containment {
  return {
    processIsolation: true,
    heapLimit: true,
    wallClock: true,
    rssPoll: rssPollKind(platform),
    addressSpaceCap: supportsAddressSpaceCap(platform),
    cpuLimit: true,
  };
}
