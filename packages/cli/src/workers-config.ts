/** The environment's way to say `--workers`; the flag wins over it. */
export const WORKERS_VARIABLE = "RIPSTREAM_WORKERS";

/** `pipes --workers`: off, `auto` (sized from the machine when the run starts) or a count. */
export type WorkersSetting = "off" | "auto" | number;

export interface ResolvedWorkers {
  readonly setting: WorkersSetting;
  /** Where the setting came from, for the message that refuses it beside isolation. */
  readonly source: "default" | "flag" | "env";
}

/**
 * `--workers` / RIPSTREAM_WORKERS as typed. A count is digits only, at least 1 (`Number(" 2 ")` is 2, which is not
 * what was typed); its upper bound is the pool's, checked when the pool is built.
 */
export function resolveWorkers(input: {
  readonly flag: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
}): ResolvedWorkers {
  const fromFlag = input.flag !== null;
  const raw = fromFlag ? input.flag : input.env[WORKERS_VARIABLE];
  if (raw === undefined || raw === null) return { setting: "off", source: "default" };
  const where = fromFlag ? "--workers" : WORKERS_VARIABLE;
  const source = fromFlag ? "flag" : "env";
  if (raw === "off" || raw === "auto") return { setting: raw, source };
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`ripstream: ${where} expects a positive whole number, auto or off, got ${JSON.stringify(raw)}`);
  }
  return { setting: Number(raw), source };
}
