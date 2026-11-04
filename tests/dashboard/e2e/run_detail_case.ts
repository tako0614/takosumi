import { expect, test } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";

export function registerRunDetailCases(mode: DashboardE2EMode) {
  test.describe("App-owned Run details", () => {
    test.skip(mode !== "portable", "isolated app Run fixture only");

    for (const initial of ["consumed", "incomplete", "unavailable"] as const) {
    test(`a shared app's consumed approval is found beyond its first history page (${initial})`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const history: string[] = [];
      const legacyReads: string[] = [];
      let recovered = initial === "consumed";
      const capsuleId = "cap_shared_run";
      const planId = "plan_shared_run";
      const plan = {
        id: planId, workspaceId: "ws_alpha", capsuleId,
        type: "plan", status: "succeeded", policyStatus: "pass",
        createdBy: "member", createdAt: "2026-11-04T00:00:00Z",
        planDigest: `sha256:${"a".repeat(64)}`, baseStateGeneration: 1,
      };
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        const path = url.pathname;
        if (path === `/api/v1/runs/${planId}`) return route.fulfill({ json: { run: plan } });
        if (path === `/api/v1/runs/${planId}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (path === `/api/v1/runs/${planId}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (path === `/api/v1/runs/${planId}/cost`) return route.fulfill({ json: { cost: {
          runId: planId, billingMode: "disabled", estimatedUsdMicros: 0,
          ratingStatus: "not_applicable", blocked: false, reasons: [],
        } } });
        if (path === `/api/v1/capsules/${capsuleId}`) return route.fulfill({ json: { capsule: {
          id: capsuleId, workspaceId: "ws_alpha", name: "Shared Run App", environment: "production",
          status: "active", currentStateGeneration: 1, createdAt: plan.createdAt, updatedAt: plan.createdAt,
        } } });
        if (path === `/api/v1/capsules/${capsuleId}/runs`) {
          history.push(url.search);
          if (!recovered) {
            if (initial === "incomplete") return route.fulfill({ json: { runs: [], nextCursor: "older" } });
            if (url.searchParams.has("cursor")) return route.fulfill({ status: 503, json: { error: "unavailable" } });
          }
          return route.fulfill({ json: url.searchParams.get("cursor") === "older"
            ? { runs: [{ ...plan, id: "apply_shared_run", type: "apply", status: "failed", planRunId: planId }] }
            : { runs: Array.from({ length: 100 }, (_, index) => ({
                ...plan, id: `other_${index}`, type: "apply", status: "failed", planRunId: "plan_other",
              })), nextCursor: "older" },
          });
        }
        if (path.startsWith("/api/v1/workspaces/")) {
          legacyReads.push(path);
          return route.fulfill({ status: 403, json: { error: "forbidden" } });
        }
        return route.continue();
      });
      await page.goto(`/runs/${planId}`, { waitUntil: "domcontentloaded" });
      if (!recovered) {
        await expect(page.locator(".av-run-summary")).toContainText("We couldn't check whether this change can still be applied.");
        await expect(page.getByRole("button", { name: "Allow and apply", exact: true })).toHaveCount(0);
        recovered = true;
        await page.getByRole("button", { name: "Retry", exact: true }).click();
      }
      await expect(page.locator(".av-run-summary")).toContainText("This review has already been used.");
      expect(history.slice(-2)).toEqual(["?limit=100", "?limit=100&cursor=older"]);
      expect(legacyReads).toEqual([]);
      await expect(page.getByRole("button", { name: "Allow and apply", exact: true })).toHaveCount(0);
      expect(errors).toEqual([]);
    });
    }
  });
}
