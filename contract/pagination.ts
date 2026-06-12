/**
 * Shared keyset pagination contract for the deploy-control list reads.
 *
 * Every list endpoint that was an unbounded `SELECT … ORDER BY (createdAt, id)`
 * full-table read is bounded by a hard cap and a keyset cursor. The cursor is an
 * OPAQUE base64url-encoded `{ createdAt, id }` keyset position: callers MUST
 * treat it as a token and only echo it back; the encoding is an implementation
 * detail and may change.
 *
 * The `(createdAt, id)` sort already used by every list method is keyset-ready,
 * so the store pages by `WHERE (createdAt, id) > (cursor.createdAt, cursor.id)
 * ORDER BY createdAt, id LIMIT limit + 1`; the extra probe row tells the store
 * whether a `nextCursor` exists.
 *
 * `nextCursor` is added to each `List…Response` as an OPTIONAL field — additive,
 * so existing readers that ignore it are unaffected.
 */

/** Default page size when no `?limit=` is given. */
export const DEFAULT_PAGE_LIMIT = 100;
/** Hard cap on the page size; a larger `?limit=` is clamped down to this. */
export const MAX_PAGE_LIMIT = 100;

/**
 * The parsed `?limit=` / `?cursor=` page request threaded from a list route
 * through the service into the store keyset query.
 *
 *   - `limit`  — clamped to `1..MAX_PAGE_LIMIT`; absent ⇒ `DEFAULT_PAGE_LIMIT`.
 *   - `cursor` — the OPAQUE token from a prior page's `nextCursor`, decoded to a
 *                `{ createdAt, id }` keyset position by {@link decodeCursor}.
 */
export interface PageParams {
  readonly limit?: number;
  readonly cursor?: string;
}

/** The decoded keyset position carried by an opaque cursor token. */
export interface PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * A bounded page of `T` plus the opaque cursor for the NEXT page. `nextCursor`
 * is absent when the page is the last one (the keyset `limit + 1` probe found no
 * further row).
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

/**
 * Clamps a raw limit to `1..MAX_PAGE_LIMIT`, defaulting an absent / non-finite
 * value to {@link DEFAULT_PAGE_LIMIT}. A `<= 0` request collapses to 1 row so a
 * caller can never request an empty page accidentally.
 */
export function clampPageLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_PAGE_LIMIT;
  const truncated = Math.trunc(raw);
  if (truncated < 1) return 1;
  if (truncated > MAX_PAGE_LIMIT) return MAX_PAGE_LIMIT;
  return truncated;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encodes a `{ createdAt, id }` keyset position into an OPAQUE cursor token.
 * Callers MUST NOT parse the result; only echo it back as the next `?cursor=`.
 */
export function encodeCursor(cursor: PageCursor): string {
  const json = JSON.stringify({ c: cursor.createdAt, i: cursor.id });
  return base64UrlEncode(new TextEncoder().encode(json));
}

/**
 * Decodes an opaque cursor token back to its `{ createdAt, id }` keyset
 * position. Returns `undefined` for a missing / malformed / structurally invalid
 * token so a bad `?cursor=` degrades to "start from the beginning" instead of a
 * 500 (the route validates and rejects an invalid cursor as a 400 before this
 * point; this is the defensive last line).
 */
export function decodeCursor(token: string | undefined): PageCursor | undefined {
  if (token === undefined || token === "") return undefined;
  try {
    const json = new TextDecoder().decode(base64UrlDecode(token));
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { c?: unknown }).c !== "string" ||
      typeof (parsed as { i?: unknown }).i !== "string"
    ) {
      return undefined;
    }
    return {
      createdAt: (parsed as { c: string }).c,
      id: (parsed as { i: string }).i,
    };
  } catch {
    return undefined;
  }
}

/**
 * Pages an in-memory array already sorted ascending by `(createdAt, id)`: drops
 * everything at or before the cursor position, then takes `limit` rows and emits
 * a `nextCursor` when a further row exists. Used by the in-memory store and by
 * any service that pages a fully-materialized list.
 */
export function pageSorted<T extends PageCursor>(
  sorted: readonly T[],
  params: PageParams,
): Page<T> {
  const limit = clampPageLimit(params.limit);
  const cursor = decodeCursor(params.cursor);
  const start = cursor
    ? sorted.findIndex(
        (row) =>
          row.createdAt > cursor.createdAt ||
          (row.createdAt === cursor.createdAt && row.id > cursor.id),
      )
    : 0;
  const from = start === -1 ? sorted.length : start;
  const window = sorted.slice(from, from + limit);
  const hasMore = from + limit < sorted.length;
  const last = window[window.length - 1];
  return hasMore && last !== undefined
    ? { items: window, nextCursor: encodeCursor(last) }
    : { items: window };
}

/**
 * Builds a `Page<T>` from a keyset `limit + 1`-probe result: when the store
 * fetched one more row than asked for, the extra row is dropped and its
 * predecessor (the last KEPT row) becomes the `nextCursor` keyset.
 */
export function pageFromProbe<T extends PageCursor>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return last !== undefined
    ? { items, nextCursor: encodeCursor(last) }
    : { items };
}
