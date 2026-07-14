/** Generic opaque-cursor pagination for small account-plane collections. */
export const LIST_PAGE_DEFAULT_LIMIT = 50;
export const LIST_PAGE_MAX_LIMIT = 200;

export function parsePageLimit(value: string | null): number | "invalid" {
  if (value === null || value === "") return LIST_PAGE_DEFAULT_LIMIT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return "invalid";
  return Math.min(parsed, LIST_PAGE_MAX_LIMIT);
}

export function encodePageCursor(lastId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ lastId }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function decodePageCursor(
  value: string | null,
): string | "invalid" | undefined {
  if (value === null || value === "") return undefined;
  let normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  try {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const lastId =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { lastId?: unknown }).lastId
        : undefined;
    return typeof lastId === "string" && lastId.length > 0
      ? lastId
      : "invalid";
  } catch {
    return "invalid";
  }
}

export function paginateById<T>(
  rows: readonly T[],
  options: {
    readonly getId: (row: T) => string;
    readonly limit: number;
    readonly afterId?: string;
  },
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  const cursorIndex = options.afterId
    ? rows.findIndex((row) => options.getId(row) === options.afterId)
    : -1;
  const startIndex = options.afterId
    ? cursorIndex === -1
      ? rows.length
      : cursorIndex + 1
    : 0;
  const items = rows.slice(startIndex, startIndex + options.limit);
  const last = items.at(-1);
  const hasMore = startIndex + items.length < rows.length;
  return {
    items,
    nextCursor: hasMore && last ? encodePageCursor(options.getId(last)) : null,
  };
}
