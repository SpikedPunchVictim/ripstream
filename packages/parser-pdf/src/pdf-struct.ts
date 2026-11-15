import { type ObjectIndex } from "./pdf-objects.ts";
import { findCatalog } from "./pdf-rebuild.ts";
import { dictEntries, parseReference } from "./pdf-syntax.ts";

/**
 * Whether the catalog's /StructTreeRoot holds structure, which is what Tika 4.2.0 reports as `pdf:has-marked-content`
 * (checked against a running server): a root dictionary whose /K is a dictionary or an array with something in it. A root
 * with no /K, an empty /K, or a /K that is a number, is not. Null when the objects do not settle it (no catalog, an
 * unreadable root).
 */
export function structTreeHasKids(index: ObjectIndex): boolean | null {
  const catalog = findCatalog(index);
  const catalogObject = catalog === null ? undefined : index.objects.get(catalog.num);
  if (catalogObject === undefined) return null;
  const root = value(index, dictEntries(catalogObject.body).get("StructTreeRoot"));
  if (root === undefined) return null;
  if (!root.startsWith("<<")) return false;
  const kids = value(index, dictEntries(root).get("K"));
  if (kids === undefined) return false;
  if (kids.startsWith("<<")) return true;
  return kids.startsWith("[") && /[^\s\]]/.test(kids.slice(1));
}

/** A raw value with a reference followed to its object (once); undefined for a reference to nothing readable. */
function value(index: ObjectIndex, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const ref = parseReference(raw);
  if (ref === null) return raw.trim();
  const target = index.objects.get(ref.num);
  return target === undefined || target.stream !== null ? undefined : target.body.trim();
}
