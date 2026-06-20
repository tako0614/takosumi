/**
 * Keyset pagination contract tests (spec §30): opaque cursor round-trip, the
 * limit clamp, and the two paging helpers (`pageSorted` over a materialized
 * array, `pageFromProbe` over a `limit + 1` keyset probe) producing a complete,
 * gap-free, dup-free traversal across the `(createdAt, id)` boundary.
 */
import { describe, expect, it } from "bun:test";
import {
  clampPageLimit,
  decodeCursor,
  DEFAULT_PAGE_LIMIT,
  encodeCursor,
  MAX_PAGE_LIMIT,
  type Page,
  type PageCursor,
  pageFromProbe,
  pageFromProbeBy,
  pageSorted,
  pageSortedBy,
  pageSortedDesc,
} from "../../contract/pagination.ts";

interface Row extends PageCursor {
  readonly createdAt: string;
  readonly id: string;
}

function makeRows(n: number): readonly Row[] {
  // Monotonic ascending by (createdAt, id): the sub-second component encodes the
  // index so the sequence is a valid keyset input (what every store hands the
  // pager after `ORDER BY createdAt, id`).
  return Array.from({ length: n }, (_, i) => ({
    createdAt: `2026-01-01T00:00:00.${String(i).padStart(4, "0")}Z`,
    id: `row_${String(i).padStart(4, "0")}`,
  }));
}

describe("cursor round-trip", () => {
  it("encodes then decodes a keyset position losslessly", () => {
    const cursor: PageCursor = {
      createdAt: "2026-06-12T09:30:00.000Z",
      id: "inst_abc123",
    };
    const token = encodeCursor(cursor);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it("returns undefined for a missing / malformed token", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor("not-base64url!!")).toBeUndefined();
    // Valid base64url of a non-keyset JSON shape.
    expect(decodeCursor(encodeCursorRaw({ hello: "world" }))).toBeUndefined();
  });
});

function encodeCursorRaw(value: unknown): string {
  const json = JSON.stringify(value);
  const b64 = btoa(json);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("clampPageLimit", () => {
  it("defaults an absent limit and caps at the hard ceiling", () => {
    expect(clampPageLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
    expect(clampPageLimit(1000)).toBe(MAX_PAGE_LIMIT);
    expect(clampPageLimit(50)).toBe(50);
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(-5)).toBe(1);
  });
});

function drain<T extends PageCursor>(
  rows: readonly T[],
  pageOf: (cursor: string | undefined) => Page<T>,
): readonly T[] {
  const seen: T[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < rows.length + 5; guard += 1) {
    const page = pageOf(cursor);
    seen.push(...page.items);
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  return seen;
}

describe("pageSorted", () => {
  it("caps the default page at DEFAULT_PAGE_LIMIT and emits a cursor", () => {
    const rows = makeRows(250);
    const first = pageSorted(rows, {});
    expect(first.items).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(first.nextCursor).toBeDefined();
  });

  it("traverses every row with no gaps or dupes across the boundary", () => {
    const rows = makeRows(250);
    const seen = drain(rows, (cursor) =>
      pageSorted(rows, { limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    expect(seen.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("omits nextCursor on the final exact-fit page", () => {
    const rows = makeRows(100);
    const page = pageSorted(rows, { limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBeUndefined();
  });

  it("disambiguates equal createdAt by id", () => {
    const rows: readonly Row[] = [
      { createdAt: "2026-01-01T00:00:00.000Z", id: "a" },
      { createdAt: "2026-01-01T00:00:00.000Z", id: "b" },
      { createdAt: "2026-01-01T00:00:00.000Z", id: "c" },
    ];
    const seen = drain(rows, (cursor) =>
      pageSorted(rows, { limit: 1, ...(cursor ? { cursor } : {}) }),
    );
    expect(seen.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("pageFromProbe", () => {
  it("drops the n+1 probe row and exposes its predecessor as the cursor", () => {
    const rows = makeRows(11); // probe for a limit of 10
    const page = pageFromProbe(rows, 10);
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBe(encodeCursor(rows[9]!));
  });

  it("returns no cursor when the probe found no extra row", () => {
    const rows = makeRows(7);
    const page = pageFromProbe(rows, 10);
    expect(page.items).toHaveLength(7);
    expect(page.nextCursor).toBeUndefined();
  });
});

// A row whose keyset column is NOT literally `createdAt` (a SourceSnapshot keyed
// by `fetchedAt`): exercises the `…By` projection pagers.
interface FetchedRow {
  readonly fetchedAt: string;
  readonly id: string;
}

function makeFetchedRows(n: number): readonly FetchedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    fetchedAt: `2026-02-02T00:00:00.${String(i).padStart(4, "0")}Z`,
    id: `snap_${String(i).padStart(4, "0")}`,
  }));
}

const fetchedKeyset = (r: FetchedRow): PageCursor => ({
  createdAt: r.fetchedAt,
  id: r.id,
});

describe("pageSortedBy / pageFromProbeBy (projected keyset)", () => {
  it("caps the default page at DEFAULT_PAGE_LIMIT and emits a cursor", () => {
    const rows = makeFetchedRows(250);
    const first = pageSortedBy(rows, {}, fetchedKeyset);
    expect(first.items).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(first.nextCursor).toBeDefined();
  });

  it("traverses every row with no gaps or dupes across the fetchedAt boundary", () => {
    const rows = makeFetchedRows(250);
    const seen: FetchedRow[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < rows.length + 5; guard += 1) {
      const page: Page<FetchedRow> = pageSortedBy(
        rows,
        { limit: 100, ...(cursor ? { cursor } : {}) },
        fetchedKeyset,
      );
      seen.push(...page.items);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("pageFromProbeBy drops the probe row and cursors on its predecessor", () => {
    const rows = makeFetchedRows(11);
    const page = pageFromProbeBy(rows, 10, fetchedKeyset);
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBe(encodeCursor(fetchedKeyset(rows[9]!)));
    // The probe-less case carries no cursor.
    expect(pageFromProbeBy(makeFetchedRows(7), 10, fetchedKeyset).nextCursor)
      .toBeUndefined();
  });
});

describe("pageSortedDesc (newest-first keyset)", () => {
  // Descending input: index 0 is newest, last is oldest (what a backup listing
  // hands the pager after ORDER BY createdAt DESC, id DESC).
  function makeRowsDesc(n: number): readonly Row[] {
    return Array.from({ length: n }, (_, i) => {
      const seq = n - 1 - i;
      return {
        createdAt: `2026-03-03T00:00:00.${String(seq).padStart(4, "0")}Z`,
        id: `bkp_${String(seq).padStart(4, "0")}`,
      };
    });
  }

  it("caps the default page and emits a cursor", () => {
    const rows = makeRowsDesc(250);
    const first = pageSortedDesc(rows, {});
    expect(first.items).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(first.nextCursor).toBeDefined();
  });

  it("traverses every row newest-first with no gaps or dupes", () => {
    const rows = makeRowsDesc(250);
    const seen = drain(rows, (cursor) =>
      pageSortedDesc(rows, { limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    expect(seen.map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("omits nextCursor on the final exact-fit page", () => {
    const rows = makeRowsDesc(100);
    const page = pageSortedDesc(rows, { limit: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.nextCursor).toBeUndefined();
  });

  it("disambiguates equal createdAt by id (descending)", () => {
    const rows: readonly Row[] = [
      { createdAt: "2026-03-03T00:00:00.000Z", id: "c" },
      { createdAt: "2026-03-03T00:00:00.000Z", id: "b" },
      { createdAt: "2026-03-03T00:00:00.000Z", id: "a" },
    ];
    const seen = drain(rows, (cursor) =>
      pageSortedDesc(rows, { limit: 1, ...(cursor ? { cursor } : {}) }),
    );
    expect(seen.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});
