/** The variables a `${env:NAME}` reference is looked up in; the CLI passes `process.env`. */
export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/** A reference to a variable that is not set. Names the variable and where it was written, never a value. */
export class UnsetEnvironmentVariableError extends Error {
  constructor(name: string, path: string) {
    super(`environment variable ${name} is not set; referenced at ${path}`);
    this.name = "UnsetEnvironmentVariableError";
  }
}

/** Tika's EnvInterpolator.REFERENCE (tika-serialization 4.2.0): that exact form, with an ASCII name. */
const REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function resolveText(text: string, env: EnvironmentVariables, path: string): string {
  // A function's result is inserted as it is, so a value holding `$&` or `${env:X}` is neither a pattern nor looked up again.
  return text.replace(REFERENCE, (_reference, name: string) => {
    // Own properties only: `constructor` and `toString` are on every object, and are not variables.
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof value !== "string") throw new UnsetEnvironmentVariableError(name, path);
    return value;
  });
}

function resolveValue(value: unknown, env: EnvironmentVariables, path: string): unknown {
  if (typeof value === "string") return resolveText(value, env, path);
  if (Array.isArray(value)) return value.map((item, index) => resolveValue(item, env, `${path}/${index}`));
  if (typeof value === "object" && value !== null) {
    // fromEntries defines each key as a plain property, so a key named `__proto__` stays a key.
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, env, `${path}/${key}`)]));
  }
  return value;
}

/**
 * Replaces `${env:NAME}` in the string values of a configuration, as Tika does (EnvInterpolator, applied by
 * TikaJsonConfig.load): in objects and arrays at any depth, never in a key; `${NAME}`, `$NAME` and the rest stay as they
 * are; one pass. A reference to a variable that is not set throws, at the first one found. Returns a copy; `root` is not
 * changed. A root that is not an object or an array is returned as it is, as Tika leaves it.
 */
export function interpolateEnv(root: unknown, env: EnvironmentVariables): unknown {
  return typeof root === "object" && root !== null ? resolveValue(root, env, "") : root;
}
