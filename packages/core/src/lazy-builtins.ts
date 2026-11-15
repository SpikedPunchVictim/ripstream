/**
 * Node's networking builtins, loaded at the first request instead of at import.
 *
 * A static `import "node:http"` makes every consumer of core pay for http, https and dns (~30 ms) even when
 * nothing ever fetches a URL. `process.getBuiltinModule` is used rather than `await import()` because the ESM facade
 * of `node:http` reads every export, which loads the builtin undici behind a lazy getter. The dynamic import is the
 * fallback for runtimes that lack `getBuiltinModule` (Node < 22.3).
 */
export async function loadRequest(secure: boolean): Promise<typeof import("node:http").request> {
  const module = secure
    ? (process.getBuiltinModule?.("node:https") ?? (await import("node:https")))
    : (process.getBuiltinModule?.("node:http") ?? (await import("node:http")));
  return module.request;
}

export async function loadDnsLookup(): Promise<typeof import("node:dns/promises").lookup> {
  return (process.getBuiltinModule?.("node:dns/promises") ?? (await import("node:dns/promises"))).lookup;
}
