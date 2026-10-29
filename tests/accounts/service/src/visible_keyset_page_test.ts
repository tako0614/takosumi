import { expect, test } from "bun:test";
import { visibleKeysetPage } from "../../../../accounts/service/src/control/app-authorization.ts";

interface Row { readonly id: string }

/** A keyset store whose opaque cursor names the last row it returned. */
function store(rows: Row[]) {
  const reads: { cursor?: string; limit: number }[] = [];
  const cursorOf = (row: Row) => Buffer.from(JSON.stringify({ i: row.id })).toString("base64url");
  return {
    reads,
    cursorOf,
    read: async (page: { readonly cursor?: string; readonly limit: number }) => {
      reads.push({ ...page });
      const after = page.cursor ? (JSON.parse(Buffer.from(page.cursor, "base64url").toString()) as { i: string }).i : undefined;
      const start = after ? rows.findIndex((row) => row.id === after) + 1 : 0;
      const items = rows.slice(start, start + page.limit);
      return { items, ...(start + items.length < rows.length ? { nextCursor: cursorOf(items.at(-1)!) } : {}) };
    },
  };
}

const visibility = (hidden: ReadonlySet<string>) => async () => (row: Row) => !hidden.has(row.id);

async function pageAll(rows: Row[], hidden: ReadonlySet<string>, limit: number) {
  const fake = store(rows);
  const seen: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let request = 0; request < 1000; request++) {
    const page = await visibleKeysetPage({ limit, ...(cursor ? { cursor } : {}), read: fake.read, visibility: visibility(hidden) });
    seen.push(...page.items.map((row) => row.id));
    if (page.nextCursor === undefined) break;
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  return { seen, cursors, reads: fake.reads };
}

test("every visible row is visited exactly once and no cursor names a hidden row", async () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `row_${String(index).padStart(2, "0")}` }));
  for (const pattern of [(i: number) => i % 2 === 0, (i: number) => i % 3 !== 0, (i: number) => i >= 5 && i < 30, (i: number) => i === 39]) {
    const hidden = new Set(rows.filter((_, index) => pattern(index)).map((row) => row.id));
    const visible = rows.map((row) => row.id).filter((id) => !hidden.has(id));
    for (const limit of [1, 2, 3, 7, 100]) {
      const { seen, cursors } = await pageAll(rows, hidden, limit);
      expect(seen).toEqual(visible);
      for (const cursor of cursors) {
        const named = (JSON.parse(Buffer.from(cursor, "base64url").toString()) as { i: string }).i;
        expect(hidden.has(named)).toBe(false);
      }
    }
  }
});

test("a page without hidden rows is the store's page, read once", async () => {
  const fake = store(Array.from({ length: 5 }, (_, index) => ({ id: `row_${index}` })));
  const page = await visibleKeysetPage({ limit: 2, read: fake.read, visibility: visibility(new Set()) });
  expect(page).toEqual({ items: [{ id: "row_0" }, { id: "row_1" }], nextCursor: fake.cursorOf({ id: "row_1" }) });
  expect(fake.reads).toEqual([{ limit: 2 }]);
});

test("a run of hidden rows longer than the scan budget ends the listing without revealing it", async () => {
  const rows = [
    { id: "visible_first" },
    ...Array.from({ length: 1200 }, (_, index) => ({ id: `hidden_${index}` })),
    { id: "visible_last" },
  ];
  const hidden = new Set(rows.filter((row) => row.id.startsWith("hidden_")).map((row) => row.id));
  const first = await visibleKeysetPage({ limit: 1, read: store(rows).read, visibility: visibility(hidden) });
  expect(first.items).toEqual([{ id: "visible_first" }]);
  const second = await visibleKeysetPage({ limit: 1, cursor: first.nextCursor!, read: store(rows).read, visibility: visibility(hidden) });
  expect(second).toEqual({ items: [] });
});

test("a short run of hidden rows is skipped within the budget", async () => {
  const rows = [{ id: "a" }, ...Array.from({ length: 300 }, (_, index) => ({ id: `h_${index}` })), { id: "z" }];
  const hidden = new Set(rows.filter((row) => row.id.startsWith("h_")).map((row) => row.id));
  const { seen, cursors } = await pageAll(rows, hidden, 1);
  expect(seen).toEqual(["a", "z"]);
  expect(cursors.every((cursor) => !Buffer.from(cursor, "base64url").toString().includes("h_"))).toBe(true);
});

test("a window that moved between reads ends the page instead of emitting a cursor", async () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const fake = store(rows);
  let reads = 0;
  const page = await visibleKeysetPage({
    limit: 1,
    read: async (request) => {
      reads++;
      // The refetch that anchors the cursor sees a row inserted before "c".
      if (reads === 3) rows.splice(2, 0, { id: "b2" });
      return await fake.read(request);
    },
    visibility: visibility(new Set(["a", "b"])),
  });
  expect(page.items).toEqual([{ id: "c" }]);
  expect(page.nextCursor).toBeUndefined();
});
