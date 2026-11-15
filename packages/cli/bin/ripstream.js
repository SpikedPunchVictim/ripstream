#!/usr/bin/env node
// The command's front door. A published package ships the CLI twice: the per-file `dist` (the library, and the fallback)
// and `bundle/dist`, the same code as a few code-split chunks that start faster (docs/cli-startup.md). This stub picks:
// the bundle when it is built, unless RIPSTREAM_NO_BUNDLE is set (to anything but "" or "0"). It also switches on
// Node's compile cache first, so a repeat run skips compiling the bundle again.
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { enableCompileCache } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = new URL("../bundle/dist/run.js", import.meta.url);
const optOut = process.env.RIPSTREAM_NO_BUNDLE;

/**
 * Compile cache: the directory in NODE_COMPILE_CACHE if there is one, else a per-user one under the temp directory
 * (never inside the package, which may be read-only or shared). The per-user directory must be ours and not a link,
 * or the cache is left off: code that V8 loads from a cache must not be plantable by another user of a shared /tmp.
 * Failing to enable it (read-only disk, no space) costs nothing but the speedup: enableCompileCache reports, never throws.
 */
function startCompileCache() {
  try {
    if (process.env.NODE_COMPILE_CACHE) {
      enableCompileCache(process.env.NODE_COMPILE_CACHE);
      return;
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const dir = join(tmpdir(), `ripstream-compile-cache-${uid ?? "user"}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) return;
    enableCompileCache(dir);
  } catch {
    // A cache that cannot be had is not worth failing a command for.
  }
}

if ((optOut === undefined || optOut === "" || optOut === "0") && existsSync(BUNDLE)) {
  startCompileCache();
  await import(BUNDLE.href);
} else {
  await import("../dist/run.js");
}
