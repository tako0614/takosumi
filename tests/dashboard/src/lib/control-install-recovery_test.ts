import { afterEach, expect, test } from "bun:test";
import { createReviewableGitInstallPlan, getGitInstallPlan } from "../../../../dashboard/src/lib/control-api.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("reload readback is GET only and never reconciles or applies", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({
      installPlan: { id: "gip_0123456789abcdef", workspaceId: "ws_one", createdBy: "user_one" },
      nextAction: "review_run",
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await expect(getGitInstallPlan("gip_0123456789abcdef")).resolves.toMatchObject({
    installPlan: { id: "gip_0123456789abcdef" }, nextAction: "review_run",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ method: "GET" });
  expect(calls[0]?.url).toEndWith("/install-plans/gip_0123456789abcdef");
});

test("only acknowledged coordinator progress is exposed; no Apply is posted", async () => {
  const calls: string[] = [];
  const progress: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({
      installPlan: {
        id: "gip_0123456789abcdef", workspaceId: "ws_one", createdBy: "user_one",
        ...(url.endsWith("/reconcile") ? { planRunId: "plan_one" } : {}),
      },
      nextAction: url.endsWith("/reconcile") ? "review_run" : "reconcile",
    }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  await createReviewableGitInstallPlan("ws_one", {
    source: { name: "Test", url: "https://example.com/repo.git", ref: "main" },
    capsule: { name: "Test", environment: "production" },
  }, { idempotencyKey: "same-request", onProgress: (response) => progress.push(response.nextAction) });
  expect(progress).toEqual(["reconcile", "review_run"]);
  expect(calls.some((url) => /\/(approve|apply)$/.test(url))).toBe(false);
});
