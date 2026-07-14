import {
  clampPageLimit,
  decodeCursor,
  type PageParams,
} from "takosumi-contract/pagination";

export type PageQueryResult =
  | { readonly ok: true; readonly value: PageParams }
  | { readonly ok: false; readonly message: string };

/**
 * Parses the shared opaque keyset-pagination query without coupling callers to
 * one HTTP error envelope. Public Resource Shape routes and the internal
 * deploy-control routes use different response helpers but must accept and
 * reject the same `limit` / `cursor` grammar.
 */
export function parsePageQuery(
  rawLimit: string | undefined,
  rawCursor: string | undefined,
): PageQueryResult {
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) {
      return { ok: false, message: "limit must be a positive integer" };
    }
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { ok: false, message: "limit must be a positive integer" };
    }
    limit = clampPageLimit(parsed);
  }

  if (
    rawCursor !== undefined &&
    rawCursor !== "" &&
    decodeCursor(rawCursor) === undefined
  ) {
    return { ok: false, message: "cursor is malformed" };
  }

  return {
    ok: true,
    value: {
      ...(limit !== undefined ? { limit } : {}),
      ...(rawCursor !== undefined && rawCursor !== ""
        ? { cursor: rawCursor }
        : {}),
    },
  };
}
