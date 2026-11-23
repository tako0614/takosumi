import { expect, test } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";

export function registerRunDetailCases(mode: DashboardE2EMode) {
  test.describe("App-owned Run details", () => {
    test.skip(mode !== "portable", "isolated app Run fixture only");

    for (const kind of ["version", "rollback"] as const) {
      test(`a lost ${kind} retry response returns to the original review from Run details`, async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
        const capsuleId = "cap_revision_retry";
        const capsulePath = `/api/v1/capsules/${capsuleId}`;
        const stateVersionId = "state_rollback_target";
        const requestPath = kind === "rollback"
          ? `/api/v1/state-versions/${stateVersionId}/rollback-plan`
          : capsulePath + "/revision-plans";
        const expectedRequest = kind === "version" ? { ref: "v2.0.0" } : null;
        const failed = {
          id: "plan_failed_version_retry", capsuleId, workspaceId: "ws_alpha",
          type: "plan", status: "failed", origin: kind === "rollback" ? { kind: "rollback", stateVersionId } : { kind: "revision", ref: "v2.0.0" },
          baseStateGeneration: 1, createdBy: "portable-e2e", createdAt: "2026-11-18T00:00:00Z",
        };
        const review = { ...failed, id: "plan_original_version_retry", status: "succeeded", policyStatus: "pass",
          planDigest: `sha256:${"a".repeat(64)}`, summary: { add: 0, change: 1, destroy: 0 } };
        const attempts: { key: string | undefined; request: unknown }[] = [];
        const writes: string[] = [];
        await page.route("**/api/v1/**", (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (request.method() !== "GET") writes.push(`${request.method()} ${path}`);
          if (path === requestPath && request.method() === "POST") {
            const key = request.headers()["idempotency-key"];
            attempts.push({ key, request: request.postDataJSON() });
            if (attempts.length === 1) return route.abort("failed");
            if (!key || key !== attempts[0]?.key) return route.fulfill({ status: 409, json: {
              error: { code: "failed_precondition", message: "Another version change is being prepared." },
            } });
            if (kind === "rollback") return route.fulfill({ status: 201, json: { run: review } });
            return route.fulfill({ json: {
              revisionPlan: { id: "grp_original_version_retry", capsuleId, revision: { targetRef: "v2.0.0" },
                phase: "reviewable", generation: 1, planRunId: review.id },
              nextAction: "review_run", links: { self: "/api/v1/revision-plans/grp_original_version_retry" },
            } });
          }
          if (path === capsulePath) return route.fulfill({ json: { capsule: {
            id: capsuleId, workspaceId: "ws_alpha", name: "Revision retry fixture",
            slug: "revision-retry-fixture", installConfigId: "config_revision_retry",
            status: "active", environment: "production", currentStateGeneration: 1,
            currentStateVersionId: "state_revision_retry", createdAt: failed.createdAt, updatedAt: failed.createdAt,
          } } });
          if (path === capsulePath + "/runs") return route.fulfill({ json: { runs: [] } });
          const current = [failed, review].find(run => path === `/api/v1/runs/${run.id}` || path.startsWith(`/api/v1/runs/${run.id}/`));
          if (current && path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: "" });
          if (current && path.endsWith("/logs")) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (current && path.endsWith("/cost")) return route.fulfill({ json: { cost: {
            runId: current.id, billingMode: "disabled", ratingStatus: "not_applicable",
            estimatedUsdMicros: 0, blocked: false, reasons: [],
          } } });
          if (current) return route.fulfill({ json: { run: current } });
          return route.fallback();
        });
        await page.goto(`/runs/${failed.id}`);
        const retry = page.getByRole("button", { name: "Review changes again", exact: true });
        await retry.click();
        await expect.poll(() => attempts.length).toBe(1);
        await expect(retry).toBeEnabled();
        await retry.click();
        await expect(page).toHaveURL(new RegExp(`/runs/${review.id}$`));
        expect(attempts[0]?.key).toBeTruthy();
        expect(attempts).toEqual([
          { key: attempts[0]?.key, request: expectedRequest },
          { key: attempts[0]?.key, request: expectedRequest },
        ]);
        expect(writes).toEqual([`POST ${requestPath}`, `POST ${requestPath}`]);
      });
    }

    test("an indeterminate Destroy Apply explains the unknown outcome without offering another review", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const capsuleId = "cap_unknown_destroy";
      const now = "2026-11-18T00:00:00Z";
      const base = {
        workspaceId: "ws_alpha", capsuleId, type: "destroy_apply", status: "failed",
        planRunId: "plan_unknown_destroy", createdBy: "portable-e2e", createdAt: now,
      } as const;
      const unknown = { ...base, id: "destroy_unknown_result", errorCode: "runner_mutation_indeterminate" };
      const known = { ...base, id: "destroy_known_failure", errorCode: "apply_failed" };
      const writes: string[] = [];
      const reads: string[] = [];
      await page.route("**/api/v1/**", (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET") {
          writes.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 503, json: { error: "unexpected_mutation" } });
        }
        const current = [unknown, known].find((run) => path === `/api/v1/runs/${run.id}` || path.startsWith(`/api/v1/runs/${run.id}/`));
        if (current && path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (current && path.endsWith("/logs")) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (current && path.endsWith("/cost")) return route.fulfill({ json: { cost: {
          runId: current.id, billingMode: "disabled", ratingStatus: "not_applicable",
          estimatedUsdMicros: 0, blocked: false, reasons: [],
        } } });
        if (current) { reads.push(current.id); return route.fulfill({ json: { run: current } }); }
        if (path === `/api/v1/capsules/${capsuleId}`) return route.fulfill({ json: { capsule: {
          id: capsuleId, workspaceId: "ws_alpha", name: "Unknown Destroy app", environment: "production",
          status: "error", currentStateGeneration: 1, currentStateVersionId: "state_unknown_destroy",
          createdAt: now, updatedAt: now,
        } } });
        if (path === `/api/v1/capsules/${capsuleId}/runs`) return route.fulfill({ json: { runs: [] } });
        return route.fallback();
      });

      await page.goto(`/runs/${unknown.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".av-run-summary")).toContainText("The operation's outcome is unknown.");
      await expect(page.locator(".av-run-summary")).toContainText("Ask an operator to check it before running it again.");
      await expect(page.getByRole("button", { name: "Review changes again", exact: true })).toHaveCount(0);
      expect(reads).toContain(unknown.id);
      expect(writes).toEqual([]);

      // A terminal failure with a known outcome still offers ordinary review.
      await page.goto(`/runs/${known.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".av-run-summary")).toContainText("Check the reason and logs, then try again.");
      await expect(page.getByRole("button", { name: "Review changes again", exact: true })).toBeVisible();
      expect(reads).toContain(known.id);
      expect(writes).toEqual([]);
    });

    test("a cancel confirmation stays with its displayed Run", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const a = "run_confirm_a", b = "run_confirm_b";
      const model = (id: string) => ({ id, workspaceId: "ws_alpha", capsuleId: `cap_${id}`,
        type: "apply", status: "queued", createdBy: "portable-e2e", createdAt: "2026-11-18T00:00:00Z" });
      const rows: Record<string, ReturnType<typeof model>> = { [a]: model(a), [b]: model(b) };
      const mutations: string[] = [];
      const reads: Record<string, number> = {};
      await page.route("**/api/v1/**", (route) => {
        const request = route.request(); const path = new URL(request.url()).pathname;
        const id = path.split("/")[4] ?? ""; const row = rows[id];
        if (row && path.endsWith("/cancel") && request.method() === "POST") {
          mutations.push(`POST /api/v1/runs/${id}/cancel`); row.status = "cancelled";
          return route.fulfill({ json: { run: row } });
        }
        if (row && path === `/api/v1/runs/${id}`) { reads[id] = (reads[id] ?? 0) + 1; return route.fulfill({ json: { run: row } }); }
        if (row && path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (row && path.endsWith("/logs")) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (row && path.endsWith("/cost")) return route.fulfill({ json: { cost: { runId: id, billingMode: "disabled", ratingStatus: "not_applicable", estimatedUsdMicros: 0, blocked: false, reasons: [] } } });
        if (path.startsWith("/api/v1/capsules/cap_run_confirm_")) {
          if (path.endsWith("/runs")) return route.fulfill({ json: { runs: [] } });
          return route.fulfill({ json: { capsule: { id: path.split("/")[4], workspaceId: "ws_alpha", name: "Confirmation fixture", status: "active", environment: "production", currentStateGeneration: 1, createdAt: rows[a]!.createdAt, updatedAt: rows[a]!.createdAt } } });
        }
        return route.fallback();
      });
      await page.goto(`/runs/${a}`);
      await page.getByRole("button", { name: "Cancel this run", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Cancel this run?", exact: true })).toBeVisible();
      // Same router instance, ordinary history transition; the global dialog remains open.
      const navigateTo = async (id: string) => {
        const before = reads[id] ?? 0;
        await page.evaluate((target) => { history.pushState(null, "", `/runs/${target}`); window.dispatchEvent(new PopStateEvent("popstate")); }, id);
        await expect.poll(() => reads[id] ?? 0).toBeGreaterThan(before);
      };
      await navigateTo(b);
      const target = b;
      const beforeConfirm = reads[target] ?? 0;
      await dialog.getByRole("button", { name: "Cancel run", exact: true }).click();
      // Use the current Run's existing fallback read as the settled UI witness.
      await expect.poll(() => reads[target] ?? 0).toBeGreaterThan(beforeConfirm);
      expect(mutations).toEqual([]);
      // A fresh confirmation on this exact target remains a normal one-call action.
      await page.getByRole("button", { name: "Cancel this run", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel run", exact: true }).click();
      await expect.poll(() => rows[target]!.status).toBe("cancelled");
      await expect(page.getByRole("button", { name: "Cancel this run", exact: true })).toHaveCount(0);
      expect(mutations).toEqual([`POST /api/v1/runs/${target}/cancel`]);
    });

    test("a destructive approval stays with its displayed Run", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const a = "run_confirm_destroy_a", b = "run_confirm_destroy_b";
      const retired = "run_confirm_restore_retired";
      const model = (id: string, type = "destroy_plan") => ({ id, workspaceId: "ws_alpha", capsuleId: `cap_${id}`, type,
        status: "waiting_approval", createdBy: "portable-e2e", createdAt: "2026-11-18T00:00:00Z" });
      const rows: Record<string, ReturnType<typeof model>> = { [a]: model(a), [b]: model(b), [retired]: model(retired, "restore") };
      const mutations: string[] = [];
      const reads: Record<string, number> = {};
      await page.route("**/api/v1/**", (route) => {
        const request = route.request(); const path = new URL(request.url()).pathname;
        const id = path.split("/")[4] ?? ""; const row = rows[id];
        if (row && path.endsWith("/approve") && request.method() === "POST") {
          mutations.push(`POST /api/v1/runs/${id}/approve`); row.status = "succeeded";
          return route.fulfill({ json: { run: row } });
        }
        if (row && path === `/api/v1/runs/${id}`) { reads[id] = (reads[id] ?? 0) + 1; return route.fulfill({ json: { run: row } }); }
        if (row && path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (row && path.endsWith("/logs")) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (row && path.endsWith("/cost")) return route.fulfill({ json: { cost: { runId: id, billingMode: "disabled", ratingStatus: "not_applicable", estimatedUsdMicros: 0, blocked: false, reasons: [] } } });
        if (path.startsWith("/api/v1/capsules/cap_run_confirm_")) {
          if (path.endsWith("/runs")) return route.fulfill({ json: { runs: [] } });
          return route.fulfill({ json: { capsule: { id: path.split("/")[4], workspaceId: "ws_alpha", name: "Confirmation fixture", status: "active", environment: "production", currentStateGeneration: 1, createdAt: rows[a]!.createdAt, updatedAt: rows[a]!.createdAt } } });
        }
        return route.fallback();
      });
      const navigateTo = async (id: string) => {
        const before = reads[id] ?? 0;
        await page.evaluate((target) => { history.pushState(null, "", `/runs/${target}`); window.dispatchEvent(new PopStateEvent("popstate")); }, id);
        await expect.poll(() => reads[id] ?? 0).toBeGreaterThan(before);
      };
      const approve = () => page.getByRole("button", { name: "Approve this change", exact: true });
      const dialog = page.getByRole("dialog");
      await page.goto(`/runs/${a}`);
      await approve().click();
      await expect(dialog.getByRole("heading", { name: "Run this deletion?", exact: true })).toBeVisible();
      await navigateTo(b);
      const before = reads[b] ?? 0;
      await dialog.getByRole("button", { name: "Approve this change", exact: true }).click();
      await expect.poll(() => reads[b] ?? 0).toBeGreaterThan(before);
      expect(mutations).toEqual([]);
      await approve().click();
      await dialog.getByRole("button", { name: "Approve this change", exact: true }).click();
      await expect.poll(() => rows[b]!.status).toBe("succeeded");
      await expect(approve()).toHaveCount(0);
      expect(mutations).toEqual([`POST /api/v1/runs/${b}/approve`]);

      await navigateTo(retired);
      await expect(page.getByText("Approval has ended for this legacy restore request.", { exact: true })).toBeVisible();
      await expect(approve()).toHaveCount(0);
      await expect(dialog).toHaveCount(0);
      expect(rows[retired]!.status).toBe("waiting_approval");
      expect(mutations).toEqual([`POST /api/v1/runs/${b}/approve`]);
    });

    for (const recoveryCase of ["transport", "read-refused", "server-error"] as const) {
    test(recoveryCase === "read-refused"
      ? "an individual Run refusal keeps a lost Apply unconfirmed without another mutation"
      : recoveryCase === "server-error"
      ? "an Apply gateway error recovers the exact existing Run with one POST"
      : "lost Apply responses recover only the exact existing app Run without another mutation", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const outcome of recoveryCase !== "transport" ? [recoveryCase] : ["accepted", "absent", "ambiguous", "foreign", "wrong-kind", "wrong-plan", "incomplete", "pending", "retired", "rejected", "normal"] as const) {
        const capsuleId = `cap_apply_${outcome}`;
        const planId = `plan_apply_${outcome}`;
        const applyId = outcome === "accepted" ? "apply/accepted?result#opaque" : `apply_${outcome}`;
        const applyPathId = encodeURIComponent(applyId);
        const replacementId = `replacement_${outcome}`;
        const plan = {
          id: planId, workspaceId: "ws_alpha", capsuleId,
          type: "plan", status: "succeeded", policyStatus: "pass",
          summary: { add: 1, change: 0, destroy: 0 },
          createdBy: "portable-e2e", createdAt: "2026-11-17T00:00:00Z",
          planDigest: `sha256:${"a".repeat(64)}`, baseStateGeneration: 1,
        };
        const apply = { ...plan, id: applyId, type: "apply", status: "running", planRunId: planId };
        const mutations: string[] = [];
        const historyAfterApply: string[] = [];
        let acceptedEffects = 0;
        let attempts = 0;
        let replacementReads = 0;
        let replacementHistoryReads = 0;
        let applyReads = 0;
        const held: { release?: () => Promise<void> } = {};
        await page.route("**/api/v1/**", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const path = url.pathname;
          if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
          if (path === `/api/v1/runs/${planId}/apply` && request.method() === "POST") {
            attempts += 1;
            if (outcome === "rejected") return route.fulfill({ status: 409, json: { error: "conflict" } });
            if (outcome !== "absent" && acceptedEffects === 0) acceptedEffects += 1;
            if (outcome === "normal") return route.fulfill({ status: 201, json: { run: apply } });
            if (outcome === "server-error") return route.fulfill({ status: 503, json: { error: "gateway_unavailable" } });
            return route.abort("failed");
          }
          if (path === `/api/v1/runs/${replacementId}`) {
            replacementReads += 1;
            return route.fulfill({ json: { run: { ...plan, id: replacementId } } });
          }
          if (path === `/api/v1/runs/${planId}` || path === `/api/v1/runs/${applyPathId}`) {
            if (path === `/api/v1/runs/${applyPathId}`) {
              applyReads += 1;
              if (outcome === "read-refused") return route.fulfill({ status: 403, json: { error: "forbidden" } });
            }
            return route.fulfill({ json: { run: path.endsWith(`/${planId}`) ? plan : apply } });
          }
          if (path === `/api/v1/runs/${planId}/stream` || path === `/api/v1/runs/${applyPathId}/stream` || path === `/api/v1/runs/${replacementId}/stream`) {
            return route.fulfill({ contentType: "text/event-stream", body: "" });
          }
          if (path === `/api/v1/runs/${planId}/logs` || path === `/api/v1/runs/${applyPathId}/logs` || path === `/api/v1/runs/${replacementId}/logs`) {
            return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          }
          if (path === `/api/v1/runs/${planId}/cost` || path === `/api/v1/runs/${applyPathId}/cost` || path === `/api/v1/runs/${replacementId}/cost`) {
            return route.fulfill({ json: { cost: {
              runId: path.includes(`/${planId}/`) ? planId : applyId,
              billingMode: "disabled", estimatedUsdMicros: 0,
              ratingStatus: "not_applicable", blocked: false, reasons: [],
            } } });
          }
          if (path === `/api/v1/capsules/${capsuleId}`) return route.fulfill({ json: { capsule: {
            id: capsuleId, workspaceId: "ws_alpha", name: "Apply recovery app", environment: "production",
            status: "active", currentStateGeneration: 1, createdAt: plan.createdAt, updatedAt: plan.createdAt,
          } } });
          if (path === `/api/v1/capsules/${capsuleId}/runs`) {
            const reviewId = url.searchParams.get("planRunId");
            if (reviewId === replacementId) {
              replacementHistoryReads += 1;
              return route.fulfill({ json: { runs: [] } });
            }
            if (attempts === 0 || url.searchParams.get("type") !== "apply") return route.fulfill({ json: { runs: [] } });
            expect(reviewId).toBe(planId);
            historyAfterApply.push(url.search);
            if (outcome === "pending" || outcome === "retired") {
              await new Promise<void>((resolve) => {
                held.release = async () => {
                  await route.fulfill({ json: { runs: [apply] } }).catch(() => {});
                  resolve();
                };
              });
              return;
            }
            if (outcome === "accepted" && !url.searchParams.has("cursor")) {
              return route.fulfill({ json: {
                runs: Array.from({ length: 100 }, (_, index) => ({ ...apply, id: `older_${index}`, planRunId: "another_plan" })),
                nextCursor: "older",
              } });
            }
            const rows = outcome === "absent" ? []
              : outcome === "ambiguous" ? [apply, { ...apply, id: "other_apply" }]
              : outcome === "foreign" ? [{ ...apply, workspaceId: "ws_other" }]
              : outcome === "wrong-kind" ? [{ ...apply, type: "destroy_apply" }]
              : outcome === "wrong-plan" ? [{ ...apply, planRunId: "another_plan" }]
              : [apply];
            return route.fulfill({ json: { runs: rows, ...(outcome === "incomplete" ? { nextCursor: "more" } : {}) } });
          }
          return route.continue();
        });
        await page.goto(`/runs/${planId}`, { waitUntil: "domcontentloaded" });
        const allow = page.getByRole("button", { name: "Allow and apply", exact: true });
        await expect(allow).toBeEnabled();
        await allow.click();
        const expectedPosts = outcome === "normal" || outcome === "rejected" || outcome === "server-error" ? 1 : 2;
        if (outcome === "normal" || outcome === "rejected") {
          await expect.poll(() => attempts).toBe(1);
          if (outcome === "normal") {
            await expect(page).toHaveURL(new URL(`/runs/${applyPathId}`, page.url()).href);
            await expect.poll(() => applyReads).toBeGreaterThan(0);
            await expect(page.locator(".av-run-summary")).toBeVisible();
          } else await expect(allow).toBeEnabled();
          expect(historyAfterApply).toEqual([]);
        } else {
          await expect.poll(() => attempts).toBe(expectedPosts);
          const pages = outcome === "accepted" || outcome === "incomplete" ? 2 : 1;
          await expect.poll(() => historyAfterApply.length).toBe(pages);
          if (outcome === "accepted" || outcome === "server-error") {
            await expect(page).toHaveURL(new URL(`/runs/${applyPathId}`, page.url()).href);
            await expect.poll(() => applyReads).toBeGreaterThan(0);
            await expect(page.locator(".av-run-summary")).toBeVisible();
            expect(historyAfterApply).toEqual(outcome === "accepted"
              ? [
                `?limit=100&type=apply&planRunId=${planId}`,
                `?limit=100&cursor=older&type=apply&planRunId=${planId}`,
              ]
              : [`?limit=100&type=apply&planRunId=${planId}`]);
          } else if (outcome === "retired") {
            await page.evaluate((id) => {
              history.pushState(null, "", `/runs/${id}`);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }, replacementId);
            await expect.poll(() => replacementReads).toBe(1);
            await expect.poll(() => replacementHistoryReads).toBe(1);
            await held.release?.();
            await expect(page).toHaveURL(new RegExp(`/runs/${replacementId}$`, "u"));
            await expect(page.getByRole("alert").filter({ hasText: "We couldn't confirm the result." })).toHaveCount(0);
            expect(historyAfterApply).toHaveLength(1);
          } else {
            await expect(page).toHaveURL(new RegExp(`/runs/${planId}$`, "u"));
            await expect(page.getByRole("alert").filter({ hasText: "We couldn't confirm the result." })).toBeVisible();
            await expect(allow).toHaveCount(0);
            const retry = page.getByRole("button", { name: "Retry", exact: true });
            await expect(retry).toBeEnabled();
            if (outcome === "read-refused") expect(applyReads).toBe(1);
            if (outcome === "pending") await held.release?.();
            if (outcome === "absent") {
              await retry.click();
              await expect.poll(() => historyAfterApply.length).toBe(2);
              await expect(retry).toBeEnabled();
              await expect(allow).toHaveCount(0);
            }
          }
        }
        expect(acceptedEffects).toBe(outcome === "absent" || outcome === "rejected" ? 0 : 1);
        expect(mutations).toEqual(Array.from({ length: expectedPosts }, () => `POST /api/v1/runs/${planId}/apply`));
        await page.unroute("**/api/v1/**");
      }
      expect(errors).toEqual([]);
    });

    }

    for (const { initial, planType, applyStatus } of [
      { initial: "consumed", planType: "plan", applyStatus: "succeeded" },
      { initial: "consumed", planType: "plan", applyStatus: "failed" },
      { initial: "incomplete", planType: "plan", applyStatus: "failed" },
      { initial: "unavailable", planType: "plan", applyStatus: "failed" },
      { initial: "consumed", planType: "destroy_plan", applyStatus: "succeeded" },
      { initial: "consumed", planType: "destroy_plan", applyStatus: "failed" },
    ] as const) {
    test(`a shared app's consumed approval is found beyond 200 newer Runs (${planType}, ${applyStatus}, ${initial})`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const history: string[] = [];
      const legacyReads: string[] = [];
      const mutations: string[] = [];
      let recovered = initial === "consumed";
      const capsuleId = "cap_shared_run";
      const planId = "plan_shared_run";
      const freshPlanId = "plan_shared_run_unexecuted";
      const applyType = planType === "destroy_plan" ? "destroy_apply" : "apply";
      const plan = {
        id: planId, workspaceId: "ws_alpha", capsuleId,
        type: planType, status: "succeeded", policyStatus: "pass",
        createdBy: "member", createdAt: "2026-11-04T00:00:00Z",
        planDigest: `sha256:${"a".repeat(64)}`, baseStateGeneration: 1,
        summary: { add: planType === "plan" ? 1 : 0, change: 0, destroy: planType === "destroy_plan" ? 1 : 0 },
      };
      const freshPlan = { ...plan, id: freshPlanId, createdAt: "2026-11-05T00:00:00Z" };
      const consumedBy = { ...plan, id: "apply_shared_run", type: applyType, status: applyStatus, planRunId: planId };
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (request.method() !== "GET") {
          mutations.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 503, json: { error: "unexpected_mutation" } });
        }
        const displayed = [plan, freshPlan].find((run) =>
          path === `/api/v1/runs/${run.id}` || path.startsWith(`/api/v1/runs/${run.id}/`));
        if (displayed && path.endsWith("/stream")) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (displayed && path.endsWith("/logs")) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (displayed && path.endsWith("/cost")) return route.fulfill({ json: { cost: {
          runId: displayed.id, billingMode: "disabled", estimatedUsdMicros: 0,
          ratingStatus: "not_applicable", blocked: false, reasons: [],
        } } });
        if (displayed) return route.fulfill({ json: { run: displayed } });
        if (path === `/api/v1/capsules/${capsuleId}`) return route.fulfill({ json: { capsule: {
          id: capsuleId, workspaceId: "ws_alpha", name: "Shared Run App", environment: "production",
          status: "active", currentStateGeneration: 1, createdAt: plan.createdAt, updatedAt: plan.createdAt,
        } } });
        if (path === `/api/v1/capsules/${capsuleId}/runs`) {
          history.push(url.search);
          const linkedPlanId = url.searchParams.get("planRunId");
          if (linkedPlanId !== null) {
            expect([planId, freshPlanId]).toContain(linkedPlanId);
            expect(url.searchParams.getAll("type")).toEqual([applyType]);
            if (!recovered) {
              if (initial === "incomplete") return route.fulfill({ json: { runs: [], nextCursor: "older" } });
              return route.fulfill({ status: 503, json: { error: "unavailable" } });
            }
            return route.fulfill({ json: { runs: linkedPlanId === planId ? [consumedBy] : [] } });
          }
          // The old bounded history reader cannot reach the consuming Apply:
          // both first pages contain only newer, unrelated Runs.
          const cursor = url.searchParams.get("cursor");
          if (cursor === "consumed") return route.fulfill({ json: { runs: [consumedBy] } });
          return route.fulfill({
            json: {
              runs: Array.from({ length: 100 }, (_, index) => ({
                ...consumedBy, id: `other_${cursor ?? "first"}_${index}`, planRunId: "plan_other",
                createdAt: "2026-11-06T00:00:00Z",
              })), nextCursor: cursor === "older" ? "consumed" : "older",
            },
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
      expect(history.length).toBeGreaterThan(0);
      for (const query of history) {
        const params = new URLSearchParams(query);
        expect(params.get("planRunId")).toBe(planId);
        expect(params.getAll("type")).toEqual([applyType]);
      }
      expect(legacyReads).toEqual([]);
      await expect(page.getByRole("button", { name: "Allow and apply", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Run destructive changes anyway", exact: true })).toHaveCount(0);
      expect(mutations).toEqual([]);
      if (planType === "plan" && initial === "consumed") {
        const beforeFresh = history.length;
        await page.goto(`/runs/${freshPlanId}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByRole("button", { name: "Allow and apply", exact: true })).toBeEnabled();
        expect(history.length).toBeGreaterThan(beforeFresh);
        for (const query of history.slice(beforeFresh)) {
          const params = new URLSearchParams(query);
          expect(params.get("planRunId")).toBe(freshPlanId);
          expect(params.getAll("type")).toEqual([applyType]);
        }
        expect(mutations).toEqual([]);
      }
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
