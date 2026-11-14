/**
 * Refuses an object key with a "." or ".." segment. `fetch` resolves those in the URL before it sends the request, so
 * the object a key means would not be the object that is asked for (S3 answers 403 to the signature that no longer
 * matches; GCS would address the bucket instead of an object). Azure's client has always refused them.
 */
export function rejectDotSegments(service: string, key: string): void {
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${service} object key ${JSON.stringify(key)} has a "." or ".." segment, which a URL cannot carry (fetch resolves it before sending)`);
  }
}
