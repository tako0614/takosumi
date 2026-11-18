import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createHomeLibrary } from "../../../dashboard/src/lib/home-apps.ts";
import { clearWorkspaceListCache, primeWorkspaceListCache } from "../../../dashboard/src/lib/workspace-list.ts";
import { clearCapsuleListCache } from "../../../dashboard/src/lib/capsule-list.ts";
import { setCurrentWorkspaceId } from "../../../dashboard/src/lib/workspace-state.ts";
import { resetAppOwnershipCache } from "../../../dashboard/src/lib/control-api.ts";

const solid = await import(resolve(import.meta.dir, "../../../dashboard/node_modules/solid-js/dist/solid.js"));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; resetAppOwnershipCache(); clearWorkspaceListCache(); clearCapsuleListCache(); setCurrentWorkspaceId(""); });
const settle = (ms = 0) => new Promise((done) => setTimeout(done, ms));
const app = (id: string, name = id) => ({ capsuleId: id, name, state: "installed", role: "owner", screens: [] });
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { resolve, promise };
}
function stub(reply: (url: URL) => Response | Promise<Response>) {
  resetAppOwnershipCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => reply(new URL(String(input), "https://dashboard.test"))) as typeof fetch;
}

test("search scans empty server pages without claiming no match before completion", async () => {
  const last = deferred();
  const calls: string[] = [];
  stub((url) => {
    calls.push(url.search);
    if (!url.searchParams.has("q")) return Response.json({ apps: [app("initial")] });
    if (url.searchParams.has("cursor")) return last.promise;
    return Response.json({ apps: [{ ...app("draft"), state: "needs_attention", applied: false }], appliedQuery: "資料", nextCursor: "last" });
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle();
      home.setQuery("資料");
      expect(home.searchComplete()).toBe(false);
      await settle(250);
      expect(home.matches()).toEqual([]);
      expect(home.searching()).toBe(true);
      expect(home.searchComplete()).toBe(false);
      last.resolve(Response.json({ apps: [{ ...app("archive"), displayName: { ja: "資料保管", en: "Archive" } }], appliedQuery: "資料" }));
      await settle();
      expect(home.matches().map((row) => row.id)).toEqual(["archive"]);
      expect(home.searchComplete()).toBe(true);
      expect(home.searching()).toBe(false);
      expect(calls).toEqual(["", "?q=%E8%B3%87%E6%96%99", "?cursor=last&q=%E8%B3%87%E6%96%99"]);
    } finally { dispose(); }
  });
});

test("legacy servers ignoring q retain client filtering over every ordinary page", async () => {
  stub((url) => Response.json(url.searchParams.has("cursor")
    ? { apps: [app("beta", "Beta office")] }
    : { apps: [app("alpha", "Alpha mail")], nextCursor: "more" }));
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle();
      home.setQuery("beta");
      await settle(250);
      expect(home.matches().map((row) => row.id)).toEqual(["beta"]);
      expect(home.apps()).toHaveLength(2);
      expect(home.searchComplete()).toBe(true);
      expect(home.firstPage()?.appliedQuery).toBeUndefined();
    } finally { dispose(); }
  });
});

test("a failed or repeating later page stays incomplete and can be retried", async () => {
  let fail = true;
  stub((url) => {
    if (!url.searchParams.has("q")) return Response.json({ apps: [app("initial")] });
    if (!url.searchParams.has("cursor")) return Response.json({ apps: [], appliedQuery: "missing", nextCursor: "more" });
    return fail ? Response.json({ error: { code: "unavailable" } }, { status: 503 })
      : Response.json({ apps: [], appliedQuery: "missing" });
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("missing"); await settle(250);
      expect(home.moreFailed()).toBe(true);
      expect(home.searchComplete()).toBe(false);
      expect(home.matches()).toEqual([]);
      fail = false;
      expect(await home.loadNext()).toBe(true);
      expect(home.searchComplete()).toBe(true);
    } finally { dispose(); }
  });
  stub((url) => Response.json(url.searchParams.has("q")
    ? { apps: [], appliedQuery: "missing", nextCursor: "same" } : { apps: [app("initial")] }));
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("missing"); await settle(250);
      expect(home.moreFailed()).toBe(true);
      expect(home.searchComplete()).toBe(false);
    } finally { dispose(); }
  });
});

test("changing query discards a delayed old response and never merges its rows", async () => {
  const old = deferred();
  stub((url) => {
    const q = url.searchParams.get("q");
    if (q === "old") return old.promise;
    return Response.json({ apps: [app(q ?? "initial")], ...(q ? { appliedQuery: q } : {}) });
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("old"); await settle(250);
      home.setQuery("new"); expect(home.searchComplete()).toBe(false);
      // Resolve inside the input-to-debounce window, before the next request starts.
      old.resolve(Response.json({ apps: [app("old")], appliedQuery: "old", nextCursor: "stale" }));
      await settle();
      expect(home.apps().map((row) => row.id)).toEqual(["initial"]);
      expect(home.cursor()).toBeUndefined();
      expect(home.searchComplete()).toBe(false);
      await settle(250);
      expect(home.matches().map((row) => row.id)).toEqual(["new"]);
      expect(home.searchComplete()).toBe(true);
    } finally { dispose(); }
  });
});


test("clearing input immediately rejects stale first and later search pages", async () => {
  for (const stage of ["first", "later"]) {
    const old = deferred();
    let waiting = false;
    stub((url) => {
      const q = url.searchParams.get("q");
      if (!q) return Response.json({ apps: [app("initial")] });
      if (stage === "later" && !url.searchParams.has("cursor")) return Response.json({ apps: [], appliedQuery: q, nextCursor: "more" });
      waiting = true;
      return old.promise;
    });
    await solid.createRoot(async (dispose: () => void) => {
      const home = createHomeLibrary();
      try {
        await settle(); home.setQuery("old"); await settle(250);
        expect(waiting).toBe(true);
        home.setQuery("");
        old.resolve(Response.json({ apps: [app("old")], appliedQuery: "old", nextCursor: "stale" }));
        await settle();
        expect(home.apps().map((row) => row.id)).toEqual(["initial"]);
        expect(home.cursor()).toBeUndefined();
        expect(home.searchComplete()).toBe(true);
        expect(home.moreFailed()).toBe(false);
      } finally { dispose(); }
    });
  }
});

test("malformed later pages settle as one failure without auto-retry", async () => {
  let reads = 0;
  stub((url) => {
    if (!url.searchParams.has("q")) return Response.json({ apps: [app("initial")] });
    if (!url.searchParams.has("cursor")) return Response.json({ apps: [], appliedQuery: "missing", nextCursor: "more" });
    reads += 1;
    return Response.json({ apps: [null], appliedQuery: "missing" });
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("missing"); await settle(250);
      expect(home.moreFailed()).toBe(true);
      expect(home.loadingMore()).toBe(false);
      expect(home.searching()).toBe(false);
      expect(home.searchComplete()).toBe(false);
      await settle(50);
      expect(reads).toBe(1);
    } finally { dispose(); }
  });
});

test("legacy surface failure stays incomplete but stops searching after reads settle", async () => {
  setCurrentWorkspaceId("workspace");
  primeWorkspaceListCache([{ id: "workspace" }] as never);
  stub((url) => {
    if (url.pathname === "/api/v1/apps") return Response.json({ error: { code: "route_not_found" } }, { status: 404 });
    if (url.pathname.endsWith("/capsules")) return Response.json({ capsules: [{ id: "legacy", name: "Legacy", status: "active", currentStateGeneration: 1 }] });
    if (url.pathname.endsWith("/ui-surfaces")) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("missing"); await settle(250);
      expect(home.firstPage()?.surfacesFailed).toBe(true);
      expect(home.matches()).toEqual([]);
      expect(home.searchComplete()).toBe(false);
      expect(home.searching()).toBe(false);
      expect(home.home.error).toBeUndefined();
    } finally { dispose(); }
  });
});


test("aborted same-query roundtrips and clearing an initial browse refetch once", async () => {
  const old = deferred();
  let oldReads = 0;
  stub((url) => {
    const q = url.searchParams.get("q");
    if (q === "old" && ++oldReads === 1) return old.promise;
    return Response.json({ apps: [app(q ?? "initial")], ...(q ? { appliedQuery: q } : {}) });
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("old"); await settle(250);
      home.setQuery("new"); home.setQuery("old");
      expect(home.searching()).toBe(true);
      expect(home.searchComplete()).toBe(false);
      old.resolve(Response.json({ apps: [app("obsolete")], appliedQuery: "old" }));
      await settle(250);
      expect(oldReads).toBe(2);
      expect(home.matches().map((row) => row.id)).toEqual(["old"]);
      expect(home.searchComplete()).toBe(true);
      home.setQuery(" OLD "); await settle(250);
      expect(oldReads).toBe(2);
    } finally { dispose(); }
  });
  const browse = deferred();
  let browseReads = 0;
  stub(() => { browseReads += 1; return browse.promise; });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      home.setQuery("new"); home.setQuery("");
      browse.resolve(Response.json({ apps: [app("initial")] }));
      await settle();
      expect(home.matches().map((row) => row.id)).toEqual(["initial"]);
      expect(home.searchComplete()).toBe(true);
      // The immutable browse read is still shared; only its waiter was cancelled.
      expect(browseReads).toBe(1);
    } finally { dispose(); }
  });
});

test("modern search stops at nonempty pages and scrolls through empty candidates", async () => {
  const reads: string[] = [];
  stub((url) => {
    const q = url.searchParams.get("q");
    if (!q) return Response.json({ apps: [app("initial")] });
    const cursor = url.searchParams.get("cursor") ?? "";
    reads.push(cursor);
    return Response.json(cursor === "" ? { apps: [app("match1")], appliedQuery: q, nextCursor: "empty" }
      : cursor === "empty" ? { apps: [], appliedQuery: q, nextCursor: "last" }
      : { apps: [app("match2")], appliedQuery: q });
  });
  await solid.createRoot(async (dispose: () => void) => {
    const home = createHomeLibrary();
    try {
      await settle(); home.setQuery("match"); await settle(250);
      expect(reads).toEqual([""]);
      expect(home.matches().map((row) => row.id)).toEqual(["match1"]);
      expect(home.searching()).toBe(false);
      expect(home.searchComplete()).toBe(false);
      await home.loadNext(); await settle();
      expect(reads).toEqual(["", "empty", "last"]);
      expect(home.matches().map((row) => row.id)).toEqual(["match1", "match2"]);
      expect(home.searchComplete()).toBe(true);
    } finally { dispose(); }
  });
});
