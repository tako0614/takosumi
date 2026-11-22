import { expect, jest, test } from "bun:test";
import { setImmediate as realSetImmediate } from "node:timers";
import { getRun } from "../../../../dashboard/src/lib/control-api.ts";
import { recoverApplyRun } from "../../../../dashboard/src/lib/apply-run-recovery.ts";

const plan = { id: "review", capsuleId: "app", workspaceId: "workspace", type: "plan" as const };
const apply = { id: "accepted", capsuleId: "app", workspaceId: "workspace", type: "apply", planRunId: "review", status: "failed", createdBy: "fixture", createdAt: "2026-11-17T00:00:00Z" } as const;

async function withFetch<T>(
  read: (url: URL, init?: RequestInit) => Promise<Response>,
  work: () => Promise<T>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => await read(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://fixture.test"), init),
    { preconnect: original.preconnect },
  );
  try { return await work(); }
  finally { globalThis.fetch = original; }
}

test("the actual reader pages the app ledger and returns only one exact linked operation", async () => {
  const calls: string[] = [];
  await withFetch(async (url, init) => {
    calls.push(`${init?.method} ${url.pathname}${url.search}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (url.pathname === "/api/v1/runs/accepted") return Response.json({ run: apply });
    return Response.json(url.searchParams.has("cursor") ? { runs: [apply] } : {
      runs: Array.from({ length: 100 }, (_, i) => ({ ...apply, id: `older_${i}`, planRunId: "other" })), nextCursor: "older",
    });
  }, async () => expect(await recoverApplyRun(plan, { isCurrent: () => true })).toEqual(apply));
  expect(calls).toEqual([
    `GET /api/v1/capsules/app/runs?limit=100&type=apply&planRunId=${plan.id}`,
    `GET /api/v1/capsules/app/runs?limit=100&cursor=older&type=apply&planRunId=${plan.id}`,
    "GET /api/v1/runs/accepted",
  ]);
  await withFetch(async url => {
    if (url.pathname === "/api/v1/runs/accepted") return Response.json({ run: { ...apply, type: "destroy_apply" } });
    expect(url.searchParams.get("type")).toBe("destroy_apply");
    expect(url.searchParams.get("planRunId")).toBe(plan.id);
    return Response.json({ runs: [{ ...apply, type: "destroy_apply" }] });
  }, async () => expect((await recoverApplyRun({ ...plan, type: "destroy_plan" }, { isCurrent: () => true }))?.id).toBe(apply.id));
});

test("incomplete, duplicate, mismatched and unreadable histories never identify an Apply", async () => {
  const cases = [
    { runs: [] }, { runs: [apply, { ...apply, id: "second" }] },
    { runs: [{ ...apply, workspaceId: "other" }] }, { runs: [{ ...apply, capsuleId: "other" }] },
    { runs: [{ ...apply, planRunId: "other" }] }, { runs: [{ ...apply, type: "destroy_apply" }] },
    { runs: [{ ...apply, id: "" }] }, { runs: [{ ...apply, id: plan.id }] },
    { runs: Array.from({ length: 101 }, () => apply) }, { runs: [apply], nextCursor: "incomplete" },
    { noRuns: true },
  ];
  for (const body of cases) {
    let calls = 0;
    await withFetch(async () => { calls++; return Response.json(body); }, async () => {
      expect(await recoverApplyRun(plan, { isCurrent: () => true })).toBeUndefined();
    });
    expect(calls).toBeLessThanOrEqual(2);
  }
  await withFetch(async () => { throw new TypeError("synthetic read failure"); }, async () => {
    expect(await recoverApplyRun(plan, { isCurrent: () => true })).toBeUndefined();
  });
});

test("retired ownership and cancellation suppress both results and the next history page", async () => {
  let calls = 0;
  let current = true;
  const controller = new AbortController();
  await withFetch(async () => {
    calls++;
    current = false;
    return Response.json({ runs: [apply], nextCursor: "older" });
  }, async () => {
    expect(await recoverApplyRun(plan, { isCurrent: () => current })).toBeUndefined();
    expect(await recoverApplyRun(plan, { isCurrent: () => false })).toBeUndefined();
  });
  expect(calls).toBe(1);
  await withFetch(async () => {
    calls++;
    controller.abort();
    return Response.json({ runs: [apply], nextCursor: "older" });
  }, async () => {
    expect(await recoverApplyRun(plan, { signal: controller.signal, isCurrent: () => true })).toBeUndefined();
    expect(await recoverApplyRun(plan, { signal: controller.signal, isCurrent: () => true })).toBeUndefined();
  });
  expect(calls).toBe(2);
});


test("current individual Run refusal or lineage drift leaves an Apply unconfirmed", async () => {
  const results: unknown[] = [];
  const requests: string[][] = [];
  for (const detail of [
    () => Response.json({ error: "invalid_token" }, { status: 401 }),
    () => Response.json({ run: { ...apply, planRunId: "different-review" } }),
  ]) {
    const calls: string[] = [];
    await withFetch(async (url, init) => {
      calls.push(`${init?.method} ${url.pathname}`);
      return url.pathname === "/api/v1/capsules/app/runs"
        ? Response.json({ runs: [apply] })
        : detail();
    }, async () => results.push(await recoverApplyRun(plan, { isCurrent: () => true })));
    requests.push(calls);
  }
  expect(results).toEqual([undefined, undefined]);
  expect(requests).toEqual(Array.from({ length: 2 }, () => [
    "GET /api/v1/capsules/app/runs", "GET /api/v1/runs/accepted",
  ]));
});


test("only the fresh exact Run is returned, with opaque identity and original credentials", async () => {
  const id = "accepted/with space";
  const current = { ...apply, id, status: "cancelled" as const };
  const signals: AbortSignal[] = [];
  const paths: string[] = [];
  await withFetch(async (url, init) => {
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("include");
    expect(init?.cache).toBe(url.pathname === "/api/v1/capsules/app/runs" ? undefined : "no-store");
    signals.push(init?.signal as AbortSignal);
    paths.push(url.pathname);
    return url.pathname === "/api/v1/capsules/app/runs"
      ? Response.json({ runs: [{ ...apply, id }] })
      : Response.json({ run: current });
  }, async () => expect(await recoverApplyRun(plan, { isCurrent: () => true })).toEqual(current));
  expect(paths).toEqual(["/api/v1/capsules/app/runs", "/api/v1/runs/accepted%2Fwith%20space"]);
  expect(signals[1]).toBe(signals[0]);
});

test("current individual identity, family and read failures never adopt the history row", async () => {
  const currentRows = [
    { ...apply, id: "different" }, { ...apply, capsuleId: "other" },
    { ...apply, workspaceId: "other" }, { ...apply, type: "destroy_apply" },
    { ...apply, planRunId: "other" }, undefined, null,
  ];
  for (const current of currentRows) {
    let calls = 0;
    await withFetch(async (url) => {
      calls++;
      return url.pathname === "/api/v1/capsules/app/runs"
        ? Response.json({ runs: [apply] }) : Response.json({ run: current });
    }, async () => expect(await recoverApplyRun(plan, { isCurrent: () => true })).toBeUndefined());
    expect(calls).toBe(2);
  }
  for (const status of [403, 503]) {
    await withFetch(async (url) => url.pathname === "/api/v1/capsules/app/runs"
      ? Response.json({ runs: [apply] }) : Response.json({ error: "read_refused" }, { status }),
    async () => expect(await recoverApplyRun(plan, { isCurrent: () => true })).toBeUndefined());
  }
});

test("ownership retirement and caller abort during the individual read suppress its result", async () => {
  for (const retire of ["scope", "abort"]) {
    let current = true;
    const controller = new AbortController();
    let calls = 0;
    await withFetch(async (url) => {
      calls++;
      if (url.pathname === "/api/v1/capsules/app/runs") return Response.json({ runs: [apply] });
      if (retire === "scope") current = false;
      else controller.abort();
      return Response.json({ run: apply });
    }, async () => expect(await recoverApplyRun(plan, { signal: controller.signal, isCurrent: () => current })).toBeUndefined());
    expect(calls).toBe(2);
  }
});

test("one five-second budget bounds pages and an uncooperative individual fetch or body", async () => {
  jest.useFakeTimers();
  try {
    for (const stalledAt of ["fetch", "body"]) {
      let reject!: (reason: unknown) => void;
      const promise = new Promise<unknown>((_resolve, no) => { reject = no; });
      const held = { promise, reject };
      let calls = 0;
      let detailSignal: AbortSignal | undefined;
      await withFetch(async (url, init) => {
        calls++;
        if (url.pathname === "/api/v1/capsules/app/runs") return Response.json({ runs: [apply] });
        detailSignal = init?.signal ?? undefined;
        if (stalledAt === "fetch") return await held.promise as Response;
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: () => held.promise } as Response;
      }, async () => {
        let settled = false;
        const recovery = recoverApplyRun(plan, { isCurrent: () => true }).then(value => { settled = true; return value; });
        await new Promise<void>(resolve => realSetImmediate(resolve));
        expect(calls).toBe(2);
        expect(settled).toBe(false);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(4_999);
        await new Promise<void>(resolve => realSetImmediate(resolve));
        expect(settled).toBe(false);
        jest.advanceTimersByTime(1);
        expect(await recovery).toBeUndefined();
        expect(detailSignal?.aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        held.reject(new Error("late read rejection"));
        await new Promise<void>(resolve => realSetImmediate(resolve));
        expect(calls).toBe(2);
      });
    }
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});


test("ordinary Run reads keep their existing cache policy", async () => {
  await withFetch(async (url, init) => {
    expect(url.pathname).toBe("/api/v1/runs/accepted");
    expect(init?.cache).toBeUndefined();
    return Response.json({ run: apply });
  }, async () => expect(await getRun(apply.id)).toEqual(apply));
});


test("retired recovery reads cannot redirect on a late 401 while current reads keep sign-in", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const redirects: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: {
    pathname: "/runs/review", search: "", hash: "",
    assign: (href: string) => { redirects.push(href); },
  } });
  const observed: number[] = [];
  let fakeTimers = false;
  try {
    for (const retirement of ["current", "scope", "abort", "timeout"]) {
      const start = redirects.length;
      let current = true;
      const controller = new AbortController();
      let resolve!: (response: Response) => void;
      const held = new Promise<Response>(yes => { resolve = yes; });
      if (retirement === "timeout") { jest.useFakeTimers(); fakeTimers = true; }
      await withFetch(async (url) => {
        if (url.pathname === "/api/v1/capsules/app/runs") return Response.json({ runs: [apply] });
        if (retirement === "scope") current = false;
        if (retirement === "abort") controller.abort();
        return retirement === "timeout" ? await held : Response.json({ error: "invalid_token" }, { status: 401 });
      }, async () => {
        const recovering = recoverApplyRun(plan, { signal: controller.signal, isCurrent: () => current });
        if (retirement === "timeout") {
          await new Promise<void>(yes => realSetImmediate(yes));
          jest.advanceTimersByTime(5_000);
          expect(await recovering).toBeUndefined();
          resolve(Response.json({ error: "invalid_token" }, { status: 401 }));
        } else expect(await recovering).toBeUndefined();
        await new Promise<void>(yes => realSetImmediate(yes));
      });
      if (retirement === "timeout") { jest.clearAllTimers(); jest.useRealTimers(); fakeTimers = false; }
      observed.push(redirects.length - start);
    }
    expect(observed).toEqual([1, 0, 0, 0]);
    expect(redirects[0]).toBe("/sign-in?return=%2Fruns%2Freview");
  } finally {
    if (fakeTimers) { jest.clearAllTimers(); jest.useRealTimers(); }
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});


test("a retired recovery history read cannot redirect or start the individual read", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const redirects: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, value: {
    pathname: "/runs/review", search: "", hash: "",
    assign: (href: string) => { redirects.push(href); },
  } });
  try {
    for (const retirement of ["scope", "abort"]) {
      let current = true;
      let calls = 0;
      const controller = new AbortController();
      await withFetch(async () => {
        calls++;
        if (retirement === "scope") current = false;
        else controller.abort();
        return Response.json({ error: "invalid_token" }, { status: 401 });
      }, async () => expect(await recoverApplyRun(plan, { signal: controller.signal, isCurrent: () => current })).toBeUndefined());
      expect(calls).toBe(1);
    }
    expect(redirects).toEqual([]);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "location", descriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
