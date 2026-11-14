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

    test("a completed app Run keeps authorized Open and retries a partial screen read", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const capsuleId = "cap_partial_run";
      const runId = "apply_partial_run";
      const stateId = "sv_partial_run";
      const now = "2026-11-14T00:00:00Z";
      const launchUrl = "https://screens.example.test/authorized";
      const launcherReads: string[] = [];
      const legacyReads: string[] = [];
      const mutations: string[] = [];
      let partial = true;
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
        if (path === `/api/v1/runs/${runId}`) return route.fulfill({ json: { run: {
          id: runId, workspaceId: "ws_alpha", capsuleId, type: "apply", status: "succeeded",
          createdBy: "portable-e2e", createdAt: now,
        } } });
        if (path === `/api/v1/runs/${runId}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (path === `/api/v1/runs/${runId}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (path === `/api/v1/runs/${runId}/cost`) return route.fulfill({ json: { cost: {
          runId, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [],
        } } });
        if (path === `/api/v1/capsules/${capsuleId}`) return route.fulfill({ json: { capsule: {
          id: capsuleId, workspaceId: "ws_alpha", name: "Partial Run App", environment: "production", status: "active",
          currentStateGeneration: 1, currentStateVersionId: stateId, createdAt: now, updatedAt: now,
        } } });
        if (path === `/api/v1/capsules/${capsuleId}/state-versions`) return route.fulfill({ json: { stateVersions: [{
          id: stateId, workspaceId: "ws_alpha", capsuleId, environment: "production", generation: 1,
          createdByRunId: runId, createdAt: now,
        }] } });
        if (path === `/api/v1/capsules/${capsuleId}/activity`) return route.fulfill({ json: { events: [{
          id: "act_partial_run", workspaceId: "ws_alpha", action: "release_activation.succeeded", targetType: "Capsule",
          targetId: capsuleId, runId, metadata: { applyRunId: runId, stateVersionId: stateId, capsuleId }, createdAt: now,
        }] } });
        if (path === "/api/v1/ui-surfaces") {
          launcherReads.push(url.search);
          expect(url.searchParams.get("capsuleId")).toBe(capsuleId);
          return route.fulfill({ json: { interfaces: [{
            apiVersion: "takosumi.dev/v1alpha1", kind: "Interface",
            metadata: { id: "if_partial_run", workspaceId: "ws_alpha", name: "app.launcher", ownerRef: { kind: "Capsule", id: capsuleId }, generation: 1 },
            spec: {
              type: "interface.ui.surface", version: "1", document: { launcher: true },
              inputs: { url: { source: "capsule_output", capsuleId, outputName: "url" } }, access: { visibility: "workspace" },
            },
            status: { phase: "Resolved", observedGeneration: 1, resolvedRevision: 1, resolvedInputs: { url: launchUrl } },
          }], ...(partial ? { incomplete: true } : {}) } });
        }
        if (path.includes("/workspaces/") && path.endsWith("/ui-surfaces")) {
          legacyReads.push(path);
          return route.fulfill({ status: 403, json: { error: "forbidden" } });
        }
        return route.continue();
      });
      await page.goto(`/runs/${runId}`, { waitUntil: "domcontentloaded" });
      const open = page.getByRole("link", { name: "Open app", exact: true });
      const warning = page.getByRole("alert").filter({ hasText: "Couldn't read its screens." });
      await expect(open).toHaveAttribute("href", launchUrl);
      await expect(warning).toBeVisible();
      partial = false;
      await page.getByRole("button", { name: "Reload screens", exact: true }).click();
      await expect.poll(() => launcherReads.length).toBe(2);
      await expect(warning).toHaveCount(0);
      await expect(open).toHaveAttribute("href", launchUrl);
      expect(launcherReads).toEqual([`?capsuleId=${capsuleId}`, `?capsuleId=${capsuleId}`]);
      expect(legacyReads).toEqual([]);
      expect(mutations).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
