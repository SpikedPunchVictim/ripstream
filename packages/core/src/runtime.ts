import { UnsupportedRuntimeError } from "./errors.ts";

export type RuntimeKind = "node" | "bun" | "deno" | "browser" | "worker" | "unknown";

export interface RuntimeCapabilities {
  readonly runtime: RuntimeKind;
  readonly version: string;
  readonly fetch: boolean;
  readonly crypto: boolean;
  readonly tempFiles: boolean;
  readonly workers: boolean;
  readonly nodeBuiltins: boolean;
}

type NodeProcess = {
  readonly versions?: Record<string, string | undefined>;
  getBuiltinModule?: (name: string) => unknown;
};

function nodeProcess(): NodeProcess | undefined {
  return (globalThis as { process?: NodeProcess }).process;
}

/** Pure capability detection; safe in every runtime and at import time. */
export function detectRuntime(): RuntimeCapabilities {
  const process = nodeProcess();
  const versions = process?.versions ?? {};
  let runtime: RuntimeKind = "unknown";
  let version = "";
  if (versions["bun"] !== undefined) {
    runtime = "bun";
    version = versions["bun"] ?? "";
  } else if (versions["deno"] !== undefined) {
    runtime = "deno";
    version = versions["deno"] ?? "";
  } else if (versions["node"] !== undefined) {
    runtime = "node";
    version = versions["node"] ?? "";
  } else if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
    runtime = "browser";
  }
  const nodeBuiltins =
    typeof process?.getBuiltinModule === "function" || runtime === "node";
  return {
    runtime,
    version,
    fetch: typeof globalThis.fetch === "function",
    crypto: typeof globalThis.crypto?.subtle !== "undefined",
    tempFiles: nodeBuiltins || runtime === "deno",
    workers: nodeBuiltins || typeof (globalThis as { Worker?: unknown }).Worker !== "undefined",
    nodeBuiltins,
  };
}

export function requireCapability(
  capability: keyof Omit<RuntimeCapabilities, "runtime" | "version">,
): void {
  if (detectRuntime()[capability] !== true) {
    throw new UnsupportedRuntimeError(
      `Runtime ${detectRuntime().runtime} does not support ${capability}`,
    );
  }
}

export async function sha256Digest(data: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto?.subtle !== "undefined") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data.slice().buffer);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  if (nodeProcess()?.getBuiltinModule !== undefined) {
    const crypto = nodeProcess()!.getBuiltinModule!("node:crypto") as {
      createHash(name: string): {
        update(value: Uint8Array): unknown;
        digest(encoding: "hex"): string;
      };
    };
    const hash = crypto.createHash("sha256");
    hash.update(data);
    return hash.digest("hex");
  }
  throw new UnsupportedRuntimeError("No cryptographic digest provider available");
}

export function nowMillis(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export async function createTempDirectory(prefix = "ripstream-"): Promise<string> {
  requireCapability("tempFiles");
  const fs = (await import("node:fs/promises")) as typeof import("node:fs/promises");
  const os = (await import("node:os")) as typeof import("node:os");
  const path = (await import("node:path")) as typeof import("node:path");
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
