/** A header of the form `value; name=parameter; name="quoted parameter"`: Content-Type, Content-Disposition. */
export function parseStructured(value: string): {
  readonly type: string;
  readonly parameters: Map<string, string>;
} {
  const parts = splitParameters(value);
  const type = (parts.shift() ?? "text/plain").toLowerCase();
  const parameters = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const name = part.slice(0, equals).trim().toLowerCase();
    let parameter = part.slice(equals + 1).trim();
    if (parameter.startsWith('"') && parameter.endsWith('"')) {
      parameter = parameter.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    parameters.set(name, parameter);
  }
  return { type: type.split(";")[0]!.trim(), parameters };
}

function splitParameters(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"' && current.at(-1) !== "\\") quoted = !quoted;
    if (char === ";" && !quoted) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}
