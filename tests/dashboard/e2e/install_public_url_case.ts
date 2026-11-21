import { expect, test, type Page } from "@playwright/test";
import {
  createInstallAttemptFixture,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_SOURCE_COMMIT,
} from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import type { DashboardE2EMode } from "./traffic-policy.ts";

const provider = "registry.opentofu.org/cloudflare/cloudflare";
const originalName = "fixture-app";
const urlVariable = "app_public_url";
const capsuleId = "cap_public_url_e2e";
const planId = "run_public_url_e2e";
const at = "2026-11-17T00:00:00.000Z";
const customUrl = "https://manually-chosen.example.test";
const standardUrl = (name: string) => `https://worker-${name}.fixture-account.workers.dev`;
const connectionA = {
  ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1],
  id: "pc_public_url_fixture_a",
  displayName: "Verified Cloudflare connection",
  ownerAccountId: "sub_portable_e2e",
};
const connectionB = {
  ...connectionA,
  id: "pc_public_url_fixture_b",
  displayName: "Cloudflare without a Workers subdomain",
};
const binding = (connectionId: string) => ({ provider, moduleLocalName: "cloudflare", connectionId });

async function publicUrlFixture(page: Page, options: { alsoOfferConnectionB?: boolean; marker?: boolean } = {}) {
  const connections = options.alsoOfferConnectionB ? [connectionA, connectionB] : [connectionA];
  const attempts = createInstallAttemptFixture({
    capsuleId, planRunId: planId,
    requirements: [{ provider, moduleLocalName: "cloudflare" }],
    connections: () => connections,
    variables: [
      { name: urlVariable, required: true, sensitive: false, type: "string", label: { ja: "公開URL", en: "Public URL" } },
      ...(options.marker ? [{
        name: "welcome_note", required: true, sensitive: false, type: "string" as const, label: { ja: "挨拶", en: "Welcome note" },
      }] : []),
    ],
  });
  const plans = "/api/v1/install-plans";
  // A GET-only reopen begins with a saved, verified selection. Opening the
  // sheet may propose a URL, but does not make a Plan until the person acts.
  const created = attempts.handle({
    method: "POST", path: plans, idempotencyKey: "fixture-public-url-seed",
    body: {
      mode: "attempt",
      source: { url: "https://github.com/example/public-url-fixture.git", ref: PORTABLE_SOURCE_COMMIT },
      capsule: { name: originalName, environment: "production" },
      options: { modulePath: ".", providerBindings: [binding(connectionA.id)] },
    },
  });
  expect(created?.status).toBe(201);
  const attempt = attempts.latest()!;
  const path = `${plans}/${attempt.id}`;
  for (let step = 0; step < 2; step++) {
    expect(attempts.handle({ method: "POST", path: `${path}/reconcile` })?.status).toBe(200);
  }
  expect(attempt.phase).toBe("awaiting_input");

  const metadataReads: string[] = [];
  const mutations: string[] = [];
  const connectionMetadata = {
    ...connectionA,
    scopeHints: {
      moduleInputDefaults: {
        cloudflare_account_id: "a".repeat(32), cloudflare_workers_subdomain: "fixture-account",
      },
      providerSettings: { accountId: "a".repeat(32), workersSubdomain: "fixture-account" },
    },
  };
  let finishConnectionReadB!: () => void;
  const heldConnectionReadB = new Promise<void>((resolve) => { finishConnectionReadB = resolve; });

  await page.addInitScript(() => {
    localStorage.setItem("tg_lang", "en");
    localStorage.setItem("tcs.stores", JSON.stringify(["https://store.example.test"]));
  });
  await page.route("https://store.example.test/**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (method !== "GET") mutations.push(`${method} ${url.pathname}`);
    const reply = attempts.handle({
      method, path: url.pathname, search: url.search,
      body: request.postData() ? request.postDataJSON() : undefined,
      idempotencyKey: request.headers()["idempotency-key"],
    });
    if (reply) {
      const json = reply.json as { userAction?: { kind: string; name: { current: string }; variables: readonly { name: string }[] } };
      if (json.userAction?.kind === "provide_inputs") {
        const name = json.userAction.name.current;
        return route.fulfill({ status: reply.status, json: { ...json, userAction: {
          ...json.userAction,
          variables: json.userAction.variables.map((variable) => variable.name !== urlVariable ? variable : {
            ...variable,
            userEditable: true,
            format: "cloudflare-workers-url",
            publicEndpoint: {
              serviceNameVariable: "project_name", serviceNameSource: "capsule_name",
              // Use the compiler-projected name, which differs from App name.
              suggestedName: `worker-${name}`,
            },
          }),
        } } });
      }
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    if (url.pathname === "/api/v1/connections") {
      const selected = attempts.latest()?.options.providerBindings?.[0]?.connectionId;
      if (typeof selected === "string") metadataReads.push(selected);
      if (selected === connectionB.id) await heldConnectionReadB;
      return route.fulfill({ json: { connections: [connectionMetadata, ...connections.slice(1)] } });
    }
    if (url.pathname === `/api/v1/capsules/${capsuleId}/app`) {
      return route.fulfill({ json: { app: {
        kind: "takosumi.capsule-app@v1", capsuleId, workspaceId: "ws_alpha", projectId: "prj_alpha",
        name: attempts.latest()?.capsule.name, environment: "production", status: "pending",
        applied: false, state: "installing", primaryAction: "review", problems: [], screens: [],
        version: { updateAvailable: false, stale: false, autoUpdate: false },
        progress: { revisionPreparing: false }, uninstall: { mode: "discard" }, observedAt: at,
      } } });
    }
    if (url.pathname === `/api/v1/runs/${planId}`) return route.fulfill({ json: { run: {
      id: planId, workspaceId: "ws_alpha", capsuleId, type: "plan", status: "succeeded",
      policyStatus: "pass", summary: { add: 0, change: 0, destroy: 0 }, planResources: [], createdAt: at,
    } } });
    if (url.pathname === `/api/v1/runs/${planId}/cost`) return route.fulfill({ json: { cost: {
      runId: planId, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [],
    } } });
    if (url.pathname === `/api/v1/runs/${planId}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
    if (url.pathname === `/api/v1/runs/${planId}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
    return route.fallback();
  });
  const continues = () => attempts.log.answers.filter((answer) => (answer as { continue?: boolean })?.continue === true);
  return { attempts, metadataReads, mutations, continues, finishConnectionReadB, href: `/new?installPlan=${attempt.id}` };
}

export function registerInstallPublicUrlCases(mode: DashboardE2EMode): void {
  test.describe("Cloudflare public URL suggestion", () => {
    test.skip(mode !== "portable", "deterministic local install-plan fixture only");

    test("shows the standard URL without editors and preserves a custom URL after a deployment name change", async ({ page }, info) => {
      const fixture = await publicUrlFixture(page, { marker: true });
      const traffic = monitorDashboardTraffic(page, mode);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(fixture.href);
      const url = page.getByTestId("install-public-url");
      const standard = url.getByRole("button", { name: "Standard URL", exact: true });
      const custom = url.getByRole("button", { name: "Custom URL", exact: true });
      const output = url.locator(`output[data-variable-name="${urlVariable}"]`);
      await expect(output).toHaveText(standardUrl(originalName));
      const appTitle = page.getByRole("heading", { level: 1 });
      await expect(appTitle).toHaveText("public-url-fixture");
      expect(fixture.mutations).toEqual([]);
      expect(fixture.metadataReads).toContain(connectionA.id);

      const nameSettings = page.getByTestId("install-customization");
      const summary = nameSettings.locator(":scope > summary");
      const appName = nameSettings.getByTestId("install-app-name");
      await expect(appName).not.toBeVisible();
      await expect(custom).not.toBeVisible();
      await summary.press("Enter");
      await appName.fill("renamed-app");
      await appName.press("Enter");
      await summary.press("Enter");
      await expect(output).toHaveText(standardUrl("renamed-app"));
      await expect(appTitle).toHaveText("public-url-fixture");
      expect(fixture.continues()).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath("standard-url-mobile.png"), fullPage: true, animations: "disabled" });

      await url.getByTestId("install-public-url-options").locator(":scope > summary").press("Enter");
      await expect(standard).toHaveAttribute("aria-pressed", "true");
      await custom.press("Enter");
      await expect(custom).toHaveAttribute("aria-pressed", "true");
      const customInput = url.locator(`input[data-variable-name="${urlVariable}"]`);
      await customInput.fill(customUrl);
      await customInput.press("Enter");
      await summary.press("Enter");
      await appName.fill("renamed-again");
      await appName.press("Enter");
      await expect.poll(() => fixture.attempts.latest()?.capsule.name).toBe("renamed-again");
      await expect(customInput).toHaveValue(customUrl);
      await expect(output).toHaveCount(0);

      const welcome = page.getByRole("textbox", { name: /^Welcome note/u });
      await welcome.fill("hello");
      await welcome.press("Enter");
      await expect.poll(fixture.continues).toEqual([{
        expectedGeneration: expect.any(Number), continue: true, variables: { [urlVariable]: customUrl, welcome_note: "hello" },
      }]);
      await expect(page.getByTestId("install-review").getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(fixture.mutations.some((mutation) => mutation.endsWith("/apply"))).toBe(false);
      traffic.assertNoFailures();
    });

    test("cannot continue with an old suggestion after switching to a connection without metadata", async ({ page }, info) => {
      const fixture = await publicUrlFixture(page, { alsoOfferConnectionB: true });
      const traffic = monitorDashboardTraffic(page, mode);
      try {
        await page.goto(fixture.href);
        const url = page.getByTestId("install-public-url");
        const output = url.locator(`output[data-variable-name="${urlVariable}"]`);
        await expect(output).toHaveText(standardUrl(originalName));
        expect(fixture.mutations).toEqual([]);
        await page.screenshot({ path: info.outputPath("standard-url-desktop.png"), fullPage: true, animations: "disabled" });

        const connection = page.getByTestId("install-required-connection").getByRole("combobox", { name: /Host \/ account/u });
        await expect(connection).toHaveValue(connectionA.id);
        await connection.selectOption(connectionB.id);
        await expect.poll(() => fixture.metadataReads).toContain(connectionB.id);
        await expect(url.getByRole("status")).toContainText(/loading|checking/iu);
        await expect(output).toHaveCount(0);
        await expect(page.getByTestId("install-plan-preview").getByRole("button", { name: "Install", exact: true })).toBeDisabled();
        // Hold the read across the 900 ms automatic preparation debounce.
        await page.waitForTimeout(1_100);
        expect(fixture.continues()).toEqual([]);

        fixture.finishConnectionReadB();
        await expect(url.getByRole("status")).toContainText("No standard URL confirmed");
        await url.getByTestId("install-public-url-options").locator(":scope > summary").press("Enter");
        await url.getByRole("button", { name: "Custom URL", exact: true }).press("Enter");
        const input = url.locator(`input[data-variable-name="${urlVariable}"]`);
        await expect(input).toHaveValue("");
        expect(fixture.continues()).toEqual([]);
        await input.fill(customUrl);
        await input.press("Enter");
        await expect.poll(() => fixture.attempts.log.answers).toEqual([
          { expectedGeneration: expect.any(Number), providerBindings: [binding(connectionB.id)] },
          { expectedGeneration: expect.any(Number), continue: true, variables: { [urlVariable]: customUrl } },
        ]);
        await expect(page.getByTestId("install-review").getByRole("button", { name: "Install", exact: true })).toBeEnabled();
        expect(fixture.mutations.some((mutation) => mutation.endsWith("/apply"))).toBe(false);
        traffic.assertNoFailures();
      } finally {
        fixture.finishConnectionReadB();
      }
    });
  });
}
