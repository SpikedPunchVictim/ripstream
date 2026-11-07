export function echo(payload: unknown): unknown {
  return payload;
}

export function crash(): never {
  throw new Error("boom");
}

export function hang(): Promise<never> {
  return new Promise(() => undefined);
}
