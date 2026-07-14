/**
 * Provider-neutral secret guard for Resource Shape desired configuration.
 *
 * The control plane cannot identify arbitrary credentials by maintaining a
 * vendor token-prefix catalog. It therefore rejects secret-bearing field names
 * and structurally unambiguous private-key blocks. Provider-specific validation
 * belongs to the selected Credential/Adapter implementation.
 */

const SECRET_FIELD_PATTERN =
  /(^|[_-])(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|client[_-]?secret)([_-]|$)/i;
const PRIVATE_KEY_BLOCK_PATTERN =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;

export function secretLikeJsonPath(
  value: unknown,
  path: string,
): string | undefined {
  if (typeof value === "string") {
    return PRIVATE_KEY_BLOCK_PATTERN.test(value) ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = secretLikeJsonPath(item, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    if (SECRET_FIELD_PATTERN.test(normalizedKey)) return `${path}.${key}`;
    const found = secretLikeJsonPath(item, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}
