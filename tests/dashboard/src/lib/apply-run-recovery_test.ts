import { expect, test } from "bun:test";
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
    return Response.json(url.searchParams.has("cursor") ? { runs: [apply] } : {
      runs: Array.from({ length: 100 }, (_, i) => ({ ...apply, id: `older_${i}`, planRunId: "other" })), nextCursor: "older",
    });
  }, async () => expect(await recoverApplyRun(plan, { isCurrent: () => true })).toEqual(apply));
  expect(calls).toEqual(["GET /api/v1/capsules/app/runs?limit=100&type=apply", "GET /api/v1/capsules/app/runs?limit=100&cursor=older&type=apply"]);
  await withFetch(async url => {
    expect(url.searchParams.get("type")).toBe("destroy_apply");
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
