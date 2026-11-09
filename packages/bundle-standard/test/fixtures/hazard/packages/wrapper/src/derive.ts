/** Clean on its own: it names no hazard. */
export function derive<T extends new () => object>(Base: T): T {
  return class extends Base {};
}
