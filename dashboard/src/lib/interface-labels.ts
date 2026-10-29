/** Display opaque Interface identifiers as readable words while retaining each segment. */
export function interfaceLabel(value: string): string {
  return value.split(/[./:_-]+/u).filter(Boolean).map((part) =>
    part.charAt(0).toLocaleUpperCase() + part.slice(1)
  ).join(" · ");
}

/** A permission list as readable words, never the raw permission strings. */
export function interfacePermissionList(permissions: readonly string[], separator = ", "): string {
  return permissions.map(interfaceLabel).join(separator);
}
