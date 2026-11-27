import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Capsule } from "takosumi-contract";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import {
  createInstallAttemptFixture,
  fixtureAttemptName,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_UI_SURFACES,
  type InstallAttemptFixture,
  type InstallAttemptFixtureOptions,
} from "./fixture-data.ts";
import { observeInstallMutationDispatches } from "./traffic-monitor.ts";

type BaseFixture = { readonly mutations: string[] };
type CostFixture = "not_applicable" | "rated_zero" | "unrated" | "unavailable";
const capId = "cap_provider_destination_e2e";
const sourceId = "src_provider_destination_e2e";
const planId = "run_provider_plan_e2e";
const applyId = "run_provider_apply_e2e";
const now = "2026-10-27T01:00:00.000Z";
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const cloudflare = "registry.opentofu.org/cloudflare/cloudflare";
const sourceUrl = `/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Fcloudflare-service.git&ref=${sourceCommit}&path=.&name=cloudflare-service`;
const domainField = /^Domain(?:\s*\*)?$/;
const applyMutation = `POST /api/v1/runs/${planId}/apply`;
const attemptPost = "POST /api/v1/install-plans";

/**
 * One app behind the install-plan coordinator: the attempt routes come from
 * the shared fixture coordinator, the Run, Capsule and app-page reads from
 * this fixture's state.
 */
async function detailFixture(
  page: Page,
  base: (page: Page, provider: boolean) => Promise<BaseFixture>,
  provider = false,
  oauth = false,
  cost: CostFixture = "not_applicable",
  attemptOptions: Partial<InstallAttemptFixtureOptions> = {},
) {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  await base(page, provider);
  const mutations: string[] = [];
  let applied = false;
  let applyStatus = "running";
  let capsuleStatus = "pending";
  let connected = false;
  let retryCount = 0;
  let retryFailed = false;
  let screensUnreadable = false;
  let removalAnswerLost = false;
  let cancellationAnswerLost = false;
  let uninstallRecord: Capsule["uninstall"];
  const connection ={ ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1], ...(oauth ? { credentialRecipe: { id: "cloudflare", authMode: "oauth", secretPartition: "provider-credentials" } } : {}), scope: "personal", ownerAccountId: "sub_portable_e2e", workspaceId: undefined, id: "conn_inline_fixture", displayName: "My Cloudflare" };
  const attempts: InstallAttemptFixture = createInstallAttemptFixture({
    capsuleId: capId,
    planRunId: planId,
    resources: [
      { type: "cloudflare_workers_script", allowed: true },
      { type: "cloudflare_d1_database", count: 2, allowed: true },
    ],
    requirements: provider ? [{ provider: cloudflare, moduleLocalName: "cloudflare" }] : [],
    connections: () => connected ? [{ ...connection, status: "verified" }] : [],
    variables: [
      { name: "domain", type: "string", required: false, sensitive: false, label: { ja: "ドメイン", en: "Domain" }, defaultValue: "default.example.com" },
      { name: "custom_domain", type: "string", required: false, sensitive: false, label: { en: "Custom domain", ja: "カスタムドメイン" } },
      { name: "service_name", type: "string", required: false, sensitive: false, label: { en: "Service name", ja: "サービス名" }, derivedDefault: "capsule_name" },
    ],
    ...attemptOptions,
  });
  const planResources = [
    { address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["create"] },
    { address: "cloudflare_d1_database.data", type: "cloudflare_d1_database", actions: ["create"] },
  ];
  const plan = () => ({ id: retryCount ? `run_retry_fixture_${retryCount}` : attempts.latest()?.planRunId ?? planId, workspaceId: "ws_alpha", capsuleId: capId, type: "plan", status: retryCount && retryFailed ? "failed" : "succeeded", summary: { add: 2, change: 0, destroy: 0 }, planResources, policyStatus: "pass", createdBy: "portable-e2e", createdAt: retryCount ? new Date(Date.parse(now) + 120000 + retryCount * 1000).toISOString() : now });
  const apply = () => ({ ...plan(), id: applyId, planRunId: planId, type: "apply", status: applyStatus, errorCode: applyStatus === "failed" ? "runner_apply_failed" : undefined, createdAt: "2026-10-27T01:01:00.000Z" });
  const capsule = () => ({ id: capId, workspaceId: "ws_alpha", sourceId, name: "cloudflare-service", slug: "cloudflare-service", installConfigId: "cfg-default-opentofu-capsule", environment: "production", status: capsuleStatus, currentStateGeneration: capsuleStatus === "pending" ? 0 : 1, currentStateVersionId: capsuleStatus === "pending" ? undefined : "sv_inline", uninstall: uninstallRecord, createdAt: now, updatedAt: now });
  // The control plane's view of the app (`GET /capsules/:id/app`), derived
  // from the same fixture state the Capsule read reports.
  const appView = () => {
    const base = {
      kind: "takosumi.capsule-app@v1", capsuleId: capId, workspaceId: "ws_alpha", projectId: "prj_alpha",
      name: "cloudflare-service", environment: "production", status: capsuleStatus,
      applied: capsuleStatus !== "pending" && capsuleStatus !== "destroyed", problems: [] as Record<string, unknown>[],
      screens: [] as Record<string, unknown>[],
      links: { uses: [], usedBy: [] },
      version: {
        repository: { url: "https://github.com/example/cloudflare-service.git", defaultRef: sourceCommit },
        ...(capsuleStatus !== "pending" && capsuleStatus !== "destroyed"
          ? { current: { sourceSnapshotId: "snap_inline", ref: sourceCommit, path: ".", commit: sourceCommit } }
          : {}),
        updateAvailable: false, stale: false, autoUpdate: false,
      },
      progress: { revisionPreparing: false } as Record<string, unknown>,
      uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy: [] } } as Record<string, unknown>,
      observedAt: now,
    };
    const failedApply = { code: "run_failed", severity: "error", runId: applyId, runType: "apply", errorCode: "runner_apply_failed" };
    switch (capsuleStatus) {
      case "pending":
        if (applied && applyStatus === "running") {
          return { ...base, state: "installing", primaryAction: "none", progress: { revisionPreparing: false, run: { id: applyId, type: "apply", status: "running", createdAt: apply().createdAt } }, uninstall: { mode: "discard" } };
        }
        if (applied && applyStatus === "failed") {
          return { ...base, state: "needs_attention", primaryAction: "retry", problems: [failedApply], uninstall: { mode: "discard" } };
        }
        return { ...base, state: "installing", primaryAction: "review", progress: { revisionPreparing: false, review: { runId: plan().id, runType: "plan" } }, uninstall: { mode: "discard" } };
      case "active":
        return screensUnreadable
          ? { ...base, state: "installed", primaryAction: "open", incomplete: ["screens"] }
          : { ...base, state: "installed", primaryAction: "open", screens: [{ interfaceId: "if_inline", name: "app.launcher", title: "Cloudflare Service", url: "https://apps.example.test/inline-app" }] };
      case "error":
        return { ...base, state: "needs_attention", primaryAction: "retry", problems: applyStatus === "failed" ? [failedApply] : [{ code: "capsule_error", severity: "error" }] };
      case "uninstalled":
        return {
          ...base, state: "uninstall_scheduled", primaryAction: "cancel_uninstall",
          problems: [{ code: "uninstall_scheduled", severity: "warning" }],
          uninstall: { mode: "scheduled", graceDays: 7, scheduled: { phase: "scheduled", requestedAt: now, deleteAfter: "2026-11-03T01:00:00Z", cancellable: true, blocked: false } },
        };
      case "disabled":
        return { ...base, state: "stopped", primaryAction: "none", uninstall: { mode: "none" } };
      default:
        return { ...base, state: "uninstalled", primaryAction: "reinstall", uninstall: { mode: "none" } };
    }
  };
  if (oauth) await page.context().route("**/api/v1/connections/oauth/cloudflare/callback**", async (route) => {
    const url = new URL(route.request().url());
    connected = !url.searchParams.has("error");
    const flow = "sha256:" + Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify("opaque-fixture-state")))).toString("hex");
    const result = { kind: "connection-oauth", error: !connected, connectionId: connection.id, connectionStatus: "verified" };
    return route.fulfill({ contentType: "text/html", body: `<h1>Connection callback</h1><script>new BroadcastChannel(${JSON.stringify("takosumi.oauth." + flow)}).postMessage(${JSON.stringify(result)})</script>` });
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    const attempt = attempts.handle({
      method: request.method(),
      path,
      search: url.search,
      body: request.postData() ? request.postDataJSON() : undefined,
      idempotencyKey: request.headers()["idempotency-key"],
    });
    if (attempt) return route.fulfill({ status: attempt.status, json: attempt.json });
    if (path === "/api/v1/credential-recipes") return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES, oauthHelpers: oauth ? [{ id: "cloudflare", providerSource: cloudflare, credentialRecipe: { id: "cloudflare", authMode: "oauth" }, setupFields: [{ key: "accountId", envName: "CLOUDFLARE_ACCOUNT_ID" }] }] : [] } });
    if (path === "/api/v1/connections/oauth/cloudflare/start") return route.fulfill({ json: { authorizationUrl: "https://dash.cloudflare.test/oauth2/auth?state=opaque-fixture-state", state: "opaque-fixture-state", expiresAt: new Date(Date.now() + 600000).toISOString() } });
    if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: connected ? [connection] : [] } });
    if (path === "/api/v1/connections") {
      if (request.method() === "POST") return route.fulfill({ status: 201, json: { connection: { ...connection, status: "pending" } } });
      return route.fulfill({ json: { connections: connected ? [connection] : [] } });
    }
    if (path === "/api/v1/connections/conn_inline_fixture/test") { connected = true; return route.fulfill({ json: { status: "verified" } }); }
    if (path === "/api/v1/capsule-configs/cfg-default-opentofu-capsule") return route.fulfill({ json: { installConfig: {
      id: "cfg-default-opentofu-capsule", name: "Example", policy: {}, variableMapping: {}, variablePresentation: [],
      sourceSelector: { url: "https://github.com/example/cloudflare-service.git", path: "." }, modulePath: ".",
      outputAllowlist: {}, createdAt: now, updatedAt: now,
    } } });
    // A removed app is no longer one of the person's apps.
    if (path === "/api/v1/apps" && capsuleStatus === "destroyed") return route.fulfill({ json: { apps: [] } });
    if (path === `/api/v1/capsules/${capId}`) {
      if (request.method() === "DELETE" && capsuleStatus === "pending") {
        // A never-applied app is abandoned at once, exactly as the control
        // plane answers it: 202 with the destroyed Capsule and `abandoned`.
        capsuleStatus = "destroyed";
        if (removalAnswerLost) return route.fulfill({ status: 503, json: { error: "fixture_answer_lost" } });
        return route.fulfill({ status: 202, json: { capsule: capsule(), abandoned: true } });
      }
      if (request.method() === "DELETE") {
        if (capsuleStatus !== "uninstalled") {
          uninstallRecord = { id: "uninstall_inline", revision: (uninstallRecord?.revision ?? 0) + 1,
            phase: "scheduled", requestedAt: now, scheduledDestroyAt: "2026-11-03T01:00:00Z",
            previousStatus: capsuleStatus as "active" | "stale" | "error" };
          capsuleStatus = "uninstalled";
        }
        if (removalAnswerLost) return route.fulfill({ status: 503, json: { error: "fixture_answer_lost" } });
      }
      // A capsule read always carries the configuration authority guard.
      return route.fulfill({ json: { capsule: capsule(), graceDays: 7, installConfigReAdoption: { authorityGuard: `sha256:${"c".repeat(64)}` } } });
    }
    if (path === `/api/v1/capsules/${capId}/app`) return route.fulfill({ json: { app: appView() } });
    if (path === `/api/v1/capsules/${capId}/runs`) {
      const runs = applied ? [apply(), plan()] : [plan()];
      const types = url.searchParams.getAll("type");
      return route.fulfill({ json: { runs: runs.filter((run) => types.length === 0 || types.includes(run.type)) } });
    }
    if (path === `/api/v1/capsules/${capId}/provider-bindings`) return route.fulfill({ json: { providerBindingSet: { id: "pbs_inline", workspaceId: "ws_alpha", capsuleId: capId, environment: "production", bindings: provider ? [{ provider: cloudflare, moduleLocalName: "cloudflare", connectionId: connection.id }] : [], createdAt: now, updatedAt: now } } });
    if (path === `/api/v1/capsules/${capId}/current-resource-inventory`) return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: capId, workspaceId: "ws_alpha", environment: "production", stateVersionId: "sv_inline", generation: 1, applyRunId: applyId, planRunId: planId, recordedAt: now, availability: "recorded", resources: planResources.map(({ address, type }) => ({ address, type, providerSource: cloudflare })) } } });
    if (path === `/api/v1/capsules/${capId}/usage-summary`) return route.fulfill({ json: { summary: { capsuleId: capId, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
    if (path === `/api/v1/capsules/${capId}/cancel-uninstall`) {
      capsuleStatus = uninstallRecord?.previousStatus ?? "active";
      if (uninstallRecord) uninstallRecord = { ...uninstallRecord, revision: uninstallRecord.revision + 1,
        phase: "cancelled", cancelledAt: "2026-10-27T01:02:00Z" };
      if (cancellationAnswerLost) return route.fulfill({ status: 503, json: { error: "fixture_answer_lost" } });
      return route.fulfill({ json: { capsule: capsule() } });
    }
    if (path === "/api/v1/state-versions/sv_inline/rollback-plan" && request.method() === "POST") { retryCount += 1; return route.fulfill({ status: 201, json: { run: plan() } }); }
    if (path === `/api/v1/capsules/${capId}/plan`) { retryCount += 1; return route.fulfill({ json: { run: plan() } }); }
    if (path === "/api/v1/workspaces/ws_alpha/runs" || path === `/api/v1/capsules/${capId}/runs`) return route.fulfill({ json: { runs: applied ? [apply(), plan()] : [plan()] } });
    if (path.startsWith("/api/v1/runs/") && path.endsWith("/cost")) {
      if (cost === "unavailable") return route.fulfill({ status: 503, json: { error: "fixture_cost_unavailable" } });
      return route.fulfill({ json: { cost: {
        runId: path.split("/").at(-2), billingMode: cost === "not_applicable" ? "disabled" : "showback",
        estimatedUsdMicros: 0, ratingStatus: cost === "rated_zero" ? "rated" : cost, blocked: false, reasons: [],
      } } });
    }
    if (path === `/api/v1/runs/${planId}` || path.startsWith("/api/v1/runs/run_retry_fixture_") && !path.endsWith("/stream") && !path.endsWith("/logs")) return route.fulfill({ json: { run: { ...plan(), id: path.split("/").at(-1) } } });
    if (path === `/api/v1/runs/${planId}/apply`) { applied = true; return route.fulfill({ status: 201, json: { run: apply() } }); }
    if (path === `/api/v1/runs/${applyId}`) return route.fulfill({ json: { run: apply() } });
    if (path.endsWith("/stream") && [planId, applyId, "run_retry_fixture_"].some((id) => path.includes(id))) return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/logs") && [planId, applyId, "run_retry_fixture_"].some((id) => path.includes(id))) return route.fulfill({ json: { diagnostics: [{ severity: "info", message: "Installing fixture resources" }], auditEvents: [] } });
    if (path === `/api/v1/capsules/${capId}/activity`) return route.fulfill({ json: { events: [] } });
    if (path === `/api/v1/capsules/${capId}/state-versions`) return route.fulfill({ json: { stateVersions: applyStatus === "succeeded" ? [{ id: "sv_inline", capsuleId: capId, workspaceId: "ws_alpha", generation: 1, createdByRunId: applyId, createdAt: now }] : [] } });
    if (path === "/api/v1/workspaces/ws_alpha/ui-surfaces" ||
        (path === "/api/v1/ui-surfaces" && url.searchParams.get("capsuleId") === capId)) {
      const surface = JSON.parse(JSON.stringify(PORTABLE_UI_SURFACES.ws_alpha[0]));
      surface.metadata.ownerRef.id = capId; surface.metadata.id = "if_inline";
      surface.spec.inputs.url.capsuleId = capId; surface.status.resolvedInputs.url = "https://apps.example.test/inline-app";
      return route.fulfill({ json: { interfaces: ["active", "error", "disabled"].includes(capsuleStatus) ? [surface] : [] } });
    }
    return route.fallback();
  });
  await page.context().route("https://apps.example.test/inline-app", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Installed application</h1>" }));
  return {
    attempts,
    mutations,
    appView,
    capsule,
    authorize: () => { connected = true; },
    finish: () => { applied = true; applyStatus = "succeeded"; capsuleStatus = "active"; },
    fail: (partialState = false) => { applyStatus = "failed"; if (partialState) capsuleStatus = "error"; },
    destroy: () => { capsuleStatus = "destroyed"; },
    problem: (status: string) => { capsuleStatus = status; },
    failRetry: (failed: boolean) => { retryFailed = failed; },
    screensUnreadable: (value: boolean) => { screensUnreadable = value; },
    /** The removal commits, but its answer fails on the way back. */
    loseRemovalAnswer: () => { removalAnswerLost = true; },
    loseCancellationAnswer: () => { cancellationAnswerLost = true; },
    /** The confirming answer (`continue: true`) the page sent, if any. */
    continued: () => attempts.log.answers.find((answer) => (answer as { continue?: boolean } | undefined)?.continue === true) as
      { readonly variables?: Readonly<Record<string, unknown>>; readonly capsuleName?: string } | undefined,
  };
}

/** The one install screen 「インストール」 opens. */
function installSheet(page: Page): Locator {
  return page.getByTestId("install-configuration");
}

/** Before the Plan: the preview, its disabled 「インストール」 and 「やめる」. */
function planPreview(page: Page): Locator {
  return page.getByTestId("install-plan-preview");
}

/** The Plan the screen made on its own: resources, cost and the one apply click. */
function planReview(page: Page): Locator {
  return page.getByTestId("install-review").locator(".iv-execution");
}

/** One provider row in the sheet's connection block. */
function connectionRows(page: Page): Locator {
  return page.getByTestId("install-connections").getByTestId("install-required-connection");
}

async function expandDetails(page: Page, testId: string) {
  const details = page.getByTestId(testId);
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator(":scope > summary").click();
  }
}

async function openInstallSheet(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const sheet = installSheet(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * Wait for the Plan: once nothing is missing the screen makes it on its own.
 * Install is the only Apply consent.
 */
async function waitForPlan(page: Page): Promise<Locator> {
  const review = planReview(page);
  await expect(review.getByRole("button", { name: "Install", exact: true })).toBeVisible({ timeout: 15_000 });
  return review;
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${label} must not overflow horizontally`).toBeLessThanOrEqual(1);
}

/** Compare location on the page even when Playwright scrolls a control into view. */
function documentPosition(target: Locator): Promise<{ x: number; y: number; width: number }> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width };
  });
}

/** Desktop 1440×900 and mobile 390×844 captures of one install state. */
async function captureInstallState(page: Page, name: string): Promise<void> {
  const original = page.viewportSize();
  for (const [suffix, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await expectNoHorizontalOverflow(page, `${name} at ${size.width}px`);
    // From the top, so the sticky shell is not stamped into the middle of a full-page capture.
    // Instant: the shell's smooth scrolling would otherwise race later clicks.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: test.info().outputPath(`${name}-${suffix}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

async function expectNothingStored(page: Page, ...values: string[]): Promise<void> {
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
  for (const value of values) expect(stored).not.toContain(value);
}

export function registerInstallDetailCases(mode: string, base: (page: Page, provider: boolean) => Promise<BaseFixture>) {
  test.describe("Inline app detail installation", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");
    for (const entry of ["Git", "Store", "Git with a refused replay"] as const) {
      test(`reopening the same ${entry} install after a lost creation response resumes the original attempt`, async ({ page }) => {
        const f = await detailFixture(page, base);
        const git = "https://github.com/example/cloudflare-service.git";
        const store = "https://store.example.test";
        const newCommit = "a".repeat(40);
        let url = sourceUrl;
        let resolutions = 0;
        const refusedReplay = entry === "Git with a refused replay";
        if (entry === "Git") {
          // A supported HTTP LAN origin has storage but no subtle crypto.
          await page.addInitScript(() => {
            Object.defineProperty(crypto, "subtle", { value: undefined });
            Object.defineProperty(crypto, "randomUUID", { value: undefined });
          });
        }
        if (refusedReplay) {
          await page.addInitScript(() => {
            const store = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (key.startsWith("takosumi.install-start:") && document.documentElement.dataset.blockInstallReceipt) {
                throw new DOMException("Fixture temporarily denied storage", "SecurityError");
              }
              return store.call(this, key, value);
            };
          });
        }
        if (entry === "Store") {
          url = `/new?tcsBase=${encodeURIComponent(store)}&tcsListing=tako%2Fservice`;
          await page.route(`${store}/**`, (route) => route.fulfill({ json: {
            id: "tako/service", source: { git, path: "." }, suggestedName: "cloudflare-service",
            name: { en: "Store Service" }, createdAt: now, updatedAt: now,
          } }));
          await page.route(
            (url) => url.pathname === "/api/v1/source-ref-resolutions" || url.pathname.endsWith("/source-ref-resolutions/stable-semver"),
            (route) => route.fulfill({ json: ++resolutions === 1
              ? { tag: "v1.0.0", commit: sourceCommit }
              : { tag: "v1.1.0", commit: newCommit } }),
          );
        }
        const keys: (string | undefined)[] = [];
        const refs: string[] = [];
        const acceptedIds: string[] = [];
        await page.route("**/api/v1/install-plans", async (route) => {
          const request = route.request();
          if (request.method() !== "POST") return route.fallback();
          const idempotencyKey = request.headers()["idempotency-key"];
          const body = request.postDataJSON();
          keys.push(idempotencyKey);
          refs.push(body.source.ref);
          if (refusedReplay && keys.length === 2) {
            return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Fixture refused replay" } } });
          }
          const accepted = f.attempts.handle({ method: "POST", path: "/api/v1/install-plans", idempotencyKey, body })!;
          acceptedIds.push(f.attempts.latest()!.id);
          if (keys.length === 1) return route.abort("failed");
          return route.fulfill({ status: accepted.status, json: accepted.json });
        });

        await page.goto(url);
        if (refusedReplay) await page.evaluate(() => { document.documentElement.dataset.blockInstallReceipt = "yes"; });
        const installButton = page.getByRole("button", { name: "Install", exact: true });
        await installButton.click();
        await expect(page.locator(".iv-error[role=alert]")).toBeVisible();
        expect(keys).toHaveLength(1);
        expect(keys[0]).toBeTruthy();
        const stored = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
        expect(stored).not.toContain(git);
        if (refusedReplay) {
          expect(stored).not.toContain(keys[0]!);
          await page.evaluate(() => { delete document.documentElement.dataset.blockInstallReceipt; });
          const refused = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/install-plans" &&
            response.request().method() === "POST" && response.status() === 403);
          await installButton.click();
          await refused;
          await expect(installButton).toBeEnabled();
        }
        await page.reload();
        await expect(installButton).toBeEnabled();
        const submissions = refusedReplay ? 3 : 2;
        expect(keys).toHaveLength(submissions - 1);
        await openInstallSheet(page);
        expect(keys).toEqual(Array(submissions).fill(keys[0]));
        expect(acceptedIds).toEqual([acceptedIds[0], acceptedIds[0]]);
        expect(refs).toEqual(Array(submissions).fill(sourceCommit));
        expect(resolutions).toBe(entry === "Store" ? 1 : 0);
        await expect(page).toHaveURL(new RegExp(`installPlan=${acceptedIds[0]}`, "u"));
        expect(f.mutations).not.toContain(applyMutation);
        if (entry === "Store") {
          await page.getByText("Source and version", { exact: true }).click();
          await expect(page.getByTestId("install-provenance")).toContainText(`v1.0.0 · ${sourceCommit.slice(0, 7)}`);
        }

        await page.goto(url);
        await openInstallSheet(page);
        expect(keys[submissions]).not.toBe(keys[0]);
        expect(acceptedIds[2]).not.toBe(acceptedIds[0]);
        expect(refs[submissions]).toBe(entry === "Store" ? newCommit : sourceCommit);
      });
    }

    test("Store app detail presents its gallery, release notes, and reviews without starting an install", async ({ page }) => {
      const f = await detailFixture(page, base);
      const store = "https://store.example.test";
      const listing = {
        id: "tako/service",
        source: { git: "https://github.com/example/store-service.git", path: "deploy/service" },
        provider: "cloudflare",
        suggestedName: "store-service",
        name: { ja: "ストアサービス", en: "Store Service" },
        description: { ja: "サービスの説明", en: "About this service" },
        badge: { ja: "公式", en: "Official" },
        publisher: { handle: "example", displayName: "Example" },
        rating: { average: 4.5, count: 2 },
        gallery: [{ kind: "image", url: "/media/screen.svg", width: 640, height: 360, alt: { ja: "画面", en: "Service screen" } }],
        releaseNotes: { ja: "更新内容", en: "Release notes for this version" },
        createdAt: now,
        updatedAt: now,
      };
      const storeRequests: string[] = [];
      const installRequests: string[] = [];
      page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (request.method() === "POST" || pathname.includes("/source-ref-resolutions")) {
          installRequests.push(`${request.method()} ${pathname}`);
        }
      });
      await page.route(`${store}/**`, async (route) => {
        const url = new URL(route.request().url());
        storeRequests.push(`${route.request().method()} ${url.pathname}`);
        if (url.pathname.endsWith("/reviews")) {
          return route.fulfill({ json: { items: [{
            id: "review-1", author: "A reviewer", stars: 5, text: "A useful service.",
            createdAt: now, updatedAt: now,
          }] } });
        }
        if (url.pathname.endsWith("/media/screen.svg")) {
          return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="white"/></svg>' });
        }
        if (url.pathname.endsWith("/minimal")) {
          return route.fulfill({ json: {
            id: "tako/minimal", source: { git: "https://github.com/example/minimal.git" },
            suggestedName: "minimal", name: { en: "Minimal Store Service" }, createdAt: now, updatedAt: now,
          } });
        }
        return route.fulfill({ json: listing });
      });

      await page.goto(`/new?tcsBase=${encodeURIComponent(store)}&tcsListing=tako%2Fservice`);
      await expect(page.getByRole("heading", { name: "Store Service" })).toBeVisible();
      await expect(page.getByTestId("install-app-header").getByText("About this service")).toBeVisible();
      await expect(page.getByText("About this service", { exact: true })).toHaveCount(1);
      const screenshot = page.getByRole("button", { name: "Service screen" });
      await expect(screenshot).toBeVisible();
      await expect.poll(() => screenshot.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
      await screenshot.click();
      await expect(page.getByRole("dialog", { name: "Screenshots" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(page.getByRole("heading", { name: "What’s new" })).toBeVisible();
      await expect(page.getByText("Release notes for this version")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Ratings and reviews" })).toBeVisible();
      await expect(page.getByText("A reviewer")).toBeVisible();
      await expect(page.getByText("A useful service.")).toBeVisible();
      expect(storeRequests).toContain("GET /tcs/v2/listings/tako/service/reviews");

      const provenance = page.getByTestId("install-provenance");
      const openProvenance = () => page.getByText("Source and version", { exact: true }).click();
      await openProvenance();
      await expect(provenance).toContainText("github.com/example/store-service");
      await expect(provenance).toContainText("Module path deploy/service");
      await expect(provenance).not.toContainText("Source path");
      await expect(provenance).toContainText("Store connection hint Cloudflare");
      await expect(provenance).toContainText("Latest selects the newest stable tag and its commit when you start installation.");

      const versions = page.getByTestId("install-source-fields");
      const versionInput = versions.locator("input");
      await versions.locator("summary").click();
      await expect(versionInput).toHaveAttribute("id", "install-source-ref");
      await expect(versionInput).toHaveAttribute("name", "ref");
      await expect(versions.getByRole("button", { name: "Latest", exact: true })).toHaveAttribute("aria-pressed", "true");
      await versions.getByRole("button", { name: "Development preview", exact: true }).click();
      await expect(versionInput).toHaveValue("HEAD");
      await expect(provenance).toContainText("HEAD");
      await expect(provenance).not.toContainText("newest stable tag");
      await versionInput.fill("v2.5.2");
      await expect(provenance).toContainText("v2.5.2");
      await versions.getByRole("button", { name: "Latest", exact: true }).click();
      await expect(versionInput).toHaveValue("");

      await page.goto(`/new?tcsBase=${encodeURIComponent(store)}&tcsListing=tako%2Fminimal`);
      await expect(page.getByRole("heading", { name: "Minimal Store Service" })).toBeVisible();
      await openProvenance();
      await expect(provenance).not.toContainText(/Module path|Source path|Store connection hint/u);

      const gitUrl = new URL(sourceUrl, "http://fixture.example.test");
      gitUrl.searchParams.set("sourcePath", "apps/service");
      gitUrl.searchParams.set("path", "deploy/live");
      await page.goto(`${gitUrl.pathname}${gitUrl.search}`);
      await openProvenance();
      await expect(provenance).toContainText("Source path apps/service");
      await expect(provenance).toContainText("Module path deploy/live");
      await expect(provenance).toContainText(sourceCommit.slice(0, 7));
      await expect(provenance).not.toContainText(/Store connection hint|newest stable tag/u);
      expect(installRequests).toEqual([]);
      expect(f.mutations).toEqual([]);
    });

    test("a late install response cannot take over a different app's page", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", { holdSourceReading: () => true });
      const otherGit = "https://github.com/example/other-service.git";
      const otherApp = `/new?${new URLSearchParams({ git: otherGit, ref: sourceCommit, path: ".", name: "other-service" })}`;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/v1/install-plans", async (route) => {
        const request = route.request();
        if (request.method() !== "POST" || request.postDataJSON().source.url === otherGit) return route.fallback();
        const attempt = f.attempts.handle({
          method: "POST",
          path: "/api/v1/install-plans",
          body: request.postDataJSON(),
          idempotencyKey: request.headers()["idempotency-key"],
        })!;
        f.mutations.push(attemptPost);
        await gate;
        return route.fulfill({ status: attempt.status, json: attempt.json });
      });
      try {
        await page.goto(otherApp);
        await expect(page.getByTestId("install-app-header")).toContainText("other-service");
        await page.evaluate((url) => {
          history.pushState(history.state, "", url);
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        }, sourceUrl);
        await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
        await page.getByTestId("install-start").getByRole("button", { name: "Install", exact: true }).click();
        await expect.poll(() => f.attempts.log.creates.length).toBe(1);
        const originalAttempt = f.attempts.latest()!.id;

        await page.goBack();
        await expect(page.getByTestId("install-app-header")).toContainText("other-service");
        const start = page.getByTestId("install-start").getByRole("button", { name: "Install", exact: true });
        await expect(start).toBeEnabled();

        const reply = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/install-plans" &&
          response.request().method() === "POST" && response.request().postDataJSON().source.url !== otherGit);
        release();
        await (await reply).finished();
        await start.click();
        await expect(page).toHaveURL((url) => url.searchParams.get("git") === otherGit &&
          url.searchParams.get("installPlan") === f.attempts.latest()?.id);
        expect(f.attempts.log.creates).toHaveLength(2);
        expect(f.attempts.log.creates[1]).toMatchObject({ source: { url: otherGit } });
        expect(f.mutations.some((mutation) => mutation.includes(`${originalAttempt}/`))).toBe(false);
      } finally {
        release();
      }
    });

    test("opening the app page creates nothing; Install reads the repository as one attempt", async ({ page }) => {
      let readingHeld = true;
      const f = await detailFixture(page, base, false, false, "not_applicable", { holdSourceReading: () => readingHeld });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      const provenance = page.getByTestId("install-provenance");
      const sourceDetails = page.getByText("Source and version", { exact: true });
      await expect(provenance).not.toBeVisible();
      await sourceDetails.click();
      await expect(provenance).toBeVisible();
      await expect(provenance).toContainText("github.com/example/cloudflare-service");
      // A pinned full commit reads as its short form.
      await expect(provenance).toContainText(sourceCommit.slice(0, 7));
      await expect(provenance).not.toContainText(sourceCommit);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      // A Git link has no publisher description: avoid the generic install boilerplate.
      await expect(page.locator('[data-testid="install-app-header"] > div > p:not(.iv-provenance)')).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Install from Git", exact: true }))
        .toHaveAttribute("href", "/new?entry=git");
      await expect(page.getByTestId("install-start")).not.toContainText("Nothing is created in your cloud yet");
      await sourceDetails.click();
      await captureInstallState(page, "app-not-installed");
      await page.waitForTimeout(500);
      expect(f.mutations).toEqual([]);

      await page.getByRole("button", { name: "Install", exact: true }).click();
      // One screen from here on: the progress is a line on it, and
      // 「インストール」 is there from the start, waiting with its reason.
      const progress = installSheet(page).getByTestId("install-progress");
      await expect(progress).toHaveText("Preparing…");
      await expect(page).toHaveURL(/[?&]installPlan=gip_[0-9a-f]{16}/u);
      const waiting = planPreview(page).getByRole("button", { name: "Install", exact: true });
      await expect(waiting).toBeDisabled();
      await expect(waiting).toHaveAccessibleDescription("Preparing…");
      await expect(page.getByTestId("install-apply-reason")).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(planPreview(page).getByTestId("install-planned-resources")).toContainText("Shown after reading the repository.");
      await captureInstallState(page, "app-reading");
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
      expect(f.attempts.log.creates).toEqual([{
        mode: "attempt",
        source: { url: "https://github.com/example/cloudflare-service.git", ref: sourceCommit },
        options: { modulePath: "." },
      }]);
      // Keep reading stable through the UI checks and captures, then release
      // it through the normal reconcile phases. Reading never applies anything;
      // the Plan itself is covered by the two-decision case.
      readingHeld = false;
      await expect(installSheet(page).getByTestId("install-selected-configuration")).toHaveText("Selected", { timeout: 30_000 });
      expect(f.mutations.some((m) => /\/(apply|approve)$/u.test(m))).toBe(false);
      expect(errors).toEqual([]);
    });
    test("connects a missing provider inline, keeps settings, and submits the verified binding", async ({ page }) => {
      const f = await detailFixture(page, base, true);
      await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(installSheet(page)).toHaveCount(0);
      const sheet = await openInstallSheet(page);
      await expect(sheet).toHaveAttribute("data-install-state", "connections");
      await expect(page.getByTestId("install-apply-reason")).toHaveText("Choose a connection to check it");
      // Held, not removed from the keyboard: it stays focusable and names
      // its reason, and pressing it does nothing.
      const waiting = planPreview(page).getByRole("button", { name: "Install", exact: true });
      await expect(waiting).toBeDisabled();
      await expect(waiting).toHaveAttribute("aria-describedby", "iv-apply-reason");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await waiting.focus();
      await expect(waiting).toBeFocused();
      await waiting.click({ force: true });
      expect(f.continued()).toBeUndefined();
      expect(f.mutations.some((m) => m.endsWith("/apply"))).toBe(false);
      await expandDetails(page, "install-customization");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("default.example.com");
      await sheet.getByRole("textbox", { name: domainField }).fill("chosen.example.com");
      expect(f.continued()).toBeUndefined();

      const row = connectionRows(page);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-connection-state", "missing");
      await expect(row).toContainText("Not connected");
      await expect(row.locator("select")).toHaveCount(0);
      const connect = row.getByRole("button", { name: "Connect", exact: true });
      await expect(connect).toHaveAttribute("aria-expanded", "false");
      const formId = await connect.getAttribute("aria-controls");
      expect(formId).toMatch(/^install-connect-[A-Za-z0-9_-]+$/u);
      // The row toggle keeps its identity while its label changes.
      const toggle = row.locator(`button[aria-controls="${formId}"]`);
      const form = page.locator(`[id="${formId}"]`);
      await expect(form).toHaveCount(0);
      await captureInstallState(page, "app-sheet-missing-connection");
      // Connecting happens in the row itself; opening the form must not
      // suspend and remount the whole screen.
      await sheet.evaluate((element) => element.setAttribute("data-e2e-mounted", "before-connect"));
      await toggle.click();
      await expect(form).toBeVisible();
      await expect(form.getByText("Connect account", { exact: true })).toBeVisible();
      await expect(sheet).toHaveAttribute("data-e2e-mounted", "before-connect");
      await expect(row.locator(".iv-inline-connect")).toHaveCount(1);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(form).toHaveClass(/\biv-inline-connect\b/u);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveText("Close");
      expect(f.continued()).toBeUndefined();
      // The form is limited to the row's provider: only its own sign-in methods.
      const methods = await form.locator("#connection-provider option").allTextContents();
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) expect(method).toMatch(/^Cloudflare\b/u);
      await expect(form.locator("#connection-field-CLOUDFLARE_API_TOKEN")).toBeVisible();
      await expectNoHorizontalOverflow(page, "inline connection form at 390px");
      expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await captureInstallState(page, "app-inline-connect");

      // Closing the row keeps every setting already typed in the sheet.
      await toggle.click();
      await expect(form).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
      await expandDetails(page, "install-customization");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("chosen.example.com");

      await toggle.click();
      await form.locator("#connection-field-CLOUDFLARE_API_TOKEN").fill("fixture-only-token");
      await form.locator("#connection-field-CLOUDFLARE_ACCOUNT_ID").fill("fixture-account");
      await form.getByRole("button", { name: "Save connection", exact: true }).click();
      // Saved, tested once, then offered (and chosen) for this row; the form closes.
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(row).toContainText("Connected");
      await expect(row).toContainText("My Cloudflare");
      await expect(form).toHaveCount(0);
      await expect(toggle).toHaveText("Connect another account");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      // The form that held focus is gone; focus returns to the row toggle.
      await expect(toggle).toBeFocused();
      await expect(page.getByTestId("install-connections")).not.toContainText("Review installation");
      expect(f.mutations.filter((m) => m === "POST /api/v1/connections")).toHaveLength(1);
      expect(f.mutations.filter((m) => m === "POST /api/v1/connections/conn_inline_fixture/test")).toHaveLength(1);
      await expandDetails(page, "install-customization");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("chosen.example.com");

      // Nothing else to press: with the connection in place the Plan is made.
      await waitForPlan(page);
      await expect(sheet).toHaveAttribute("data-install-state", "review");
      // Only the edited value travels, and only in the confirming answer.
      expect(f.continued()?.variables).toEqual({ domain: "chosen.example.com" });
      expect(f.attempts.latest()?.options.providerBindings ?? []).toEqual([]);
      expect(f.attempts.log.answers.filter((answer) => JSON.stringify(answer).includes("chosen.example.com"))).toHaveLength(1);
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "fixture-only-token", "chosen.example.com");
      expect(errors).toEqual([]);
    });
    test("a late connection error stays visible after closing the form without changing the selected account", async ({ page }) => {
      const existing = { ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1], id: "pc_existing", displayName: "Existing account", status: "verified" };
      const f = await detailFixture(page, base, true, false, "not_applicable", {
        connections: () => [existing],
        variables: [{ name: "region", type: "string", required: true, sensitive: false }],
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let testing = false;
      await page.route("**/api/v1/connections/conn_inline_fixture/test", async (route) => {
        testing = true;
        await gate;
        await route.fulfill({ json: { status: "pending" } });
      });
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const row = connectionRows(page);
      await expect(row).toContainText("Existing account");
      await row.getByRole("button", { name: "Connect another account", exact: true }).click();
      const form = row.locator(".iv-inline-connect");
      await form.locator("#connection-field-CLOUDFLARE_API_TOKEN").fill("fixture-only-token");
      await form.locator("#connection-field-CLOUDFLARE_ACCOUNT_ID").fill("fixture-account");
      await form.getByRole("button", { name: "Save connection", exact: true }).click();
      await expect.poll(() => testing).toBe(true);
      try {
        await row.getByRole("button", { name: "Close", exact: true }).click();
        await expect(form).toHaveCount(0);
      } finally {
        release();
      }
      await expect(row.getByRole("alert")).toBeVisible();
      await expect(form).toHaveCount(0);
      await expect(row).toContainText("Existing account");
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "fixture-only-token");
    });
    test("several connections ask for a choice that is answered as the exact provider tuple", async ({ page }) => {
      const others = [
        { id: "pc_account_a", providerSource: cloudflare, displayName: "Cloudflare account A", status: "verified", scope: "workspace", workspaceId: "ws_alpha" },
        { id: "pc_account_b", providerSource: cloudflare, displayName: "Cloudflare account B", status: "verified", scope: "workspace", workspaceId: "ws_alpha" },
      ];
      const f = await detailFixture(page, base, true, false, "not_applicable", { connections: () => others });
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      const row = connectionRows(page);
      const choice = row.getByRole("combobox", { name: /Host \/ account/u });
      await expect(choice).toHaveValue("");
      await expect(choice.locator("option")).toContainText(["Cloudflare account A", "Cloudflare account B"]);
      await expect(sheet).toHaveAttribute("data-install-state", "connections");
      await choice.selectOption("pc_account_b");
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(row).toContainText("✓ Connected");
      await waitForPlan(page);
      expect(f.attempts.log.answers).toEqual([
        {
          expectedGeneration: expect.any(Number),
          providerBindings: [{ provider: cloudflare, moduleLocalName: "cloudflare", connectionId: "pc_account_b" }],
        },
        { expectedGeneration: expect.any(Number), continue: true },
      ]);
    });
    test("OAuth keeps settings mounted and uses the verified returned connection", async ({ page, context }) => {
      const f = await detailFixture(page, base, true, true);
      await context.route("https://dash.cloudflare.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Authorize Cloudflare</h1>" }));
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await expandDetails(page, "install-customization");
      await sheet.getByRole("textbox", { name: domainField }).fill("oauth-chosen.example.net");
      // Optional settings stay available through the customization disclosure.
      await expect(sheet.getByTestId("install-optional-settings")).toBeVisible();
      await sheet.getByLabel("Custom domain", { exact: false }).fill("custom.example.org");
      const row = connectionRows(page);
      await row.getByRole("button", { name: "Connect", exact: true }).click();
      const form = row.locator(".iv-inline-connect");
      await expect(form).toBeVisible();
      await expect(form.locator("#connection-field-CLOUDFLARE_API_TOKEN")).toBeHidden();
      const popupEvent = context.waitForEvent("page");
      await form.getByRole("button", { name: "Connect Cloudflare", exact: true }).click();
      const popup = await popupEvent;
      await expect(popup.getByRole("heading")).toHaveText("Authorize Cloudflare");
      await popup.goto(new URL("/api/v1/connections/oauth/cloudflare/callback?state=opaque-fixture-state&code=fixture", page.url()).toString());
      // The OAuth connection arrives verified: chosen for the row without a test.
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(form).toHaveCount(0);
      await expect(page.getByTestId("install-connections")).not.toContainText("Review installation");
      await expandDetails(page, "install-customization");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("oauth-chosen.example.net");
      await expect(sheet.getByLabel("Custom domain", { exact: false })).toHaveValue("custom.example.org");
      await waitForPlan(page);
      expect(f.continued()?.variables).toEqual({ domain: "oauth-chosen.example.net", custom_domain: "custom.example.org" });
      expect(f.mutations.some((entry) => entry === "POST /api/v1/connections")).toBe(false);
      expect(f.mutations.some((entry) => entry.endsWith("/test"))).toBe(false);
      await expectNothingStored(page, "oauth-chosen.example.net", "opaque-fixture-state");
    });
    test("OAuth failure and cancel leave settings editable and allow retry", async ({ page, context }) => {
      const f = await detailFixture(page, base, true, true);
      await context.route("https://dash.cloudflare.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Authorize Cloudflare</h1>" }));
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await expandDetails(page, "install-customization");
      await sheet.getByRole("textbox", { name: domainField }).fill("retry.example.net");
      const row = connectionRows(page);
      const formId = await row.getByRole("button", { name: "Connect", exact: true }).getAttribute("aria-controls");
      const toggle = row.locator(`button[aria-controls="${formId}"]`);
      await toggle.click();
      const form = row.locator(".iv-inline-connect");
      const popupEvent = context.waitForEvent("page");
      await form.getByRole("button", { name: "Connect Cloudflare", exact: true }).click();
      const popup = await popupEvent;
      await expect(popup.getByRole("heading")).toHaveText("Authorize Cloudflare");
      await popup.goto(new URL("/api/v1/connections/oauth/cloudflare/callback?state=opaque-fixture-state&error=access_denied", page.url()).toString());
      await expect(form.getByText("Connection was not completed.", { exact: false })).toBeVisible();
      await expect(row).toHaveAttribute("data-connection-state", "missing");
      await expect(form.getByRole("button", { name: "Connect Cloudflare", exact: true })).toBeEnabled();
      await form.getByRole("button", { name: "Connect Cloudflare", exact: true }).click();
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(form.getByRole("button", { name: "Connect Cloudflare", exact: true })).toBeEnabled();
      await expect(toggle).toHaveText("Close");
      // One Close per row: the row toggle closes the form and keeps focus.
      await expect(form.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
      await toggle.click();
      await expect(form).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveText("Connect");
      await expect(toggle).toBeFocused();
      await expandDetails(page, "install-customization");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("retry.example.net");
      await expect(sheet).toHaveAttribute("data-install-state", "connections");
      expect(f.continued()).toBeUndefined();
    });
    test("a secret setting is write-only and leaves the page only in the confirming answer", async ({ page }) => {
      await page.clock.install();
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        variables: [{ name: "api_token", type: "string", required: true, sensitive: true, label: { en: "API token", ja: "APIトークン" } }],
      });
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      const secret = sheet.getByLabel(/^API token/u);
      await expect(secret).toBeVisible();
      await expect(secret).toHaveAttribute("type", "password");
      await expect(secret).toHaveValue("");
      await expect(sheet).toContainText("Not saved. Sent only to check what will be created.");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Until the setting is in, the preview keeps the definition's resource
      // details available and explains why the button waits.
      const preview = planPreview(page);
      await expect(preview.getByRole("button", { name: "Install", exact: true })).toBeDisabled();
      await expect(page.getByTestId("install-apply-reason")).toHaveText("Fill in the required settings");
      const planned = preview.getByTestId("install-planned-resources");
      await expect(planned.locator("li").first()).not.toBeVisible();
      await expandDetails(page, "install-planned-resources");
      await expect(planned.locator('li[data-resource-type="cloudflare_workers_script"]')).toBeVisible();
      await expect(planned.locator('li[data-resource-type="cloudflare_d1_database"]')).toContainText("×2");
      await page.clock.runFor(1_500);
      expect(f.continued()).toBeUndefined();
      // Typed text counts once its field is left (Enter here).
      await secret.fill("fixture-secret-value");
      await expect(page.getByTestId("install-apply-reason")).toHaveText("Checked once you finish typing");
      await page.clock.runFor(1_200);
      expect(f.continued()).toBeUndefined();
      await secret.press("Enter");
      await waitForPlan(page);
      expect(f.continued()?.variables).toEqual({ api_token: "fixture-secret-value" });
      const carrying = f.attempts.log.answers.filter((answer) => JSON.stringify(answer).includes("fixture-secret-value"));
      expect(carrying).toEqual([f.continued()]);
      expect(JSON.stringify(f.attempts.log.creates)).not.toContain("fixture-secret-value");
      await expectNothingStored(page, "fixture-secret-value");
    });
    test("default configuration keeps editors and infrastructure folded while cost and install stay visible", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const review = await waitForPlan(page);
      await expect(page.getByTestId("install-version")).not.toBeVisible();
      await expect(page.getByTestId("install-version-choice").locator(":scope > summary")).toContainText("0123456");
      await expect(page.getByTestId("install-customization")).not.toHaveAttribute("open", "");
      await expect(page.getByTestId("install-selected-configuration")).not.toBeVisible();
      await expect(page.getByTestId("install-app-name")).not.toBeVisible();
      await expect(page.getByTestId("install-optional-settings").locator("input").first()).not.toBeVisible();
      await expect(review.getByTestId("install-plan-resources")).not.toBeVisible();
      await expect(review.getByTestId("install-plan-cost")).toBeVisible();
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await expectNoHorizontalOverflow(page, `default install at ${width}px`);
      }
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { localStorage.setItem("tg_theme", theme); document.documentElement.dataset.theme = theme; }, theme);
        await captureInstallState(page, `install-default-${theme}`);
      }
      const details = page.getByTestId("install-resource-details");
      await details.locator(":scope > summary").focus();
      await page.keyboard.press("Enter");
      await expect(review.getByTestId("install-plan-resources")).toBeVisible();
      expect(f.mutations).not.toContain(applyMutation);
      await expandDetails(page, "install-customization");
      await expandDetails(page, "install-version-choice");
      await expect(page.getByTestId("install-version")).toBeVisible();
      await page.getByTestId("install-version").focus();
      await page.keyboard.press("Tab");
      expect(f.attempts.log.creates).toHaveLength(1);
      await page.getByTestId("install-version-choice").locator(":scope > summary").click();
      const configuration = page.getByTestId("install-customization").locator(":scope > summary");
      await configuration.click();
      const appHeading = page.getByRole("heading", { name: "cloudflare-service", exact: true });
      for (const width of [375, 1024]) {
        await page.setViewportSize({ width, height: 900 });
        await configuration.focus();
        const before = await documentPosition(appHeading);
        await configuration.press("Enter");
        await expect(page.getByTestId("install-app-name")).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        expect(await documentPosition(appHeading)).toEqual(before);
        await configuration.press("Enter");
        await expect(page.getByTestId("install-app-name")).not.toBeVisible();
        await expect(configuration).toBeFocused();
      }
    });
    test("two Install clicks: prepare, then apply; the app stays on the same screen", async ({ page, context }) => {
      const f = await detailFixture(page, base);
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      const launcherReads: string[] = [];
      const activityReads: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/ui-surfaces")) launcherReads.push(url.pathname + url.search);
        if (url.pathname.endsWith("/activity")) activityReads.push(url.pathname + url.search);
      });
      // The installer need not have membership in the app's internal partition.
      await page.route("**/api/v1/workspaces/*/ui-surfaces**", (route) =>
        route.fulfill({ status: 403, json: { error: "forbidden" } }));
      await page.goto(sourceUrl);
      // Decision 1.
      const install = page.getByRole("button", { name: "Install", exact: true });
      const appHeading = page.getByRole("heading", { name: "cloudflare-service", exact: true });
      await expect(install).toBeEnabled();
      const initialHeading = await documentPosition(appHeading);
      await install.click();
      // Reading, the sheet and the Plan follow on their own: nothing to press.
      const review = await waitForPlan(page);
      await expect(installSheet(page).getByTestId("install-customization")).toBeVisible();
      await expect(installSheet(page).getByTestId("install-basics")).not.toBeVisible();
      await expect(install).toHaveCount(1);
      await expect(install).toBeEnabled();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await documentPosition(appHeading)).toEqual(initialHeading);
      await expect(review.getByTestId("install-plan-resources")).toContainText("Cloudflare Workers Script");
      await expect(review.getByTestId("install-plan-cost")).toContainText("No estimate. Cloud usage charges may apply.");
      await captureInstallState(page, "app-two-step-review");
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
      expect(f.mutations).not.toContain(applyMutation);
      // Decision 2.
      await review.getByRole("button", { name: "Install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
      await expect(planReview(page)).toContainText("Installing");
      // What is being applied can no longer be changed on the screen.
      await expandDetails(page, "install-customization");
      await expect(installSheet(page).getByRole("textbox", { name: domainField })).toBeDisabled();
      await expect(installSheet(page).getByTestId("install-app-name")).toBeDisabled();
      // A reload follows the Apply already started for this Plan; it never offers consent again.
      await page.reload();
      await expect(planReview(page)).toContainText("Installing");
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      await page.getByText("Progress and logs", { exact: true }).click();
      await expect(page.getByTestId("install-run-logs")).toContainText("Installing fixture resources");
      f.finish();
      // Installed: the same screen offers Open and the app's own page.
      const complete = page.getByTestId("install-complete");
      await expect(complete.getByRole("heading", { name: "Installed", exact: true })).toBeVisible({ timeout: 20_000 });
      const open = complete.getByRole("link", { name: "Open", exact: true });
      await expect(open).toHaveAttribute("href", "https://apps.example.test/inline-app");
      expect(activityReads).toContain(`/api/v1/capsules/${capId}/activity?limit=100`);
      expect(activityReads.some((path) => path.startsWith("/api/v1/workspaces/"))).toBe(false);
      expect(launcherReads).toContain(`/api/v1/ui-surfaces?capsuleId=${capId}`);
      expect(launcherReads.some((path) => path.startsWith("/api/v1/workspaces/"))).toBe(false);
      await expect(complete.getByRole("link", { name: "Manage app", exact: true })).toHaveAttribute("href", `/apps/${capId}`);
      // The same screen can go to a phone, outside the completion's live region.
      const phone = page.getByTestId("app-phone");
      await expect(phone.getByTestId("app-phone-url")).toHaveText("https://apps.example.test/inline-app");
      await expect(complete.getByTestId("app-phone")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await captureInstallState(page, "app-installed");
      const popupPromise = context.waitForEvent("page"); await open.click(); const popup = await popupPromise;
      await expect(popup.getByRole("heading")).toHaveText("Installed application"); await popup.close();
      await complete.getByRole("link", { name: "Manage app", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/apps/${capId}$`, "u"));
      await expect(page.getByTestId("app-page")).toBeVisible();
      expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
      expect(errors).toEqual([]);
    });
    for (const outcome of ["needs attention", "uninstalled", "installed"] as const) {
      test(`a saved install shows the app's current ${outcome} state after reload`, async ({ page }) => {
        const fixture = await detailFixture(page, base);
        await page.goto(sourceUrl);
        await openInstallSheet(page);
        const review = await waitForPlan(page);
        await review.getByRole("button", { name: "Install", exact: true }).click();
        await expect.poll(() => fixture.mutations.filter((mutation) => mutation === applyMutation).length).toBe(1);
        if (outcome === "needs attention") fixture.fail(true);
        else fixture.finish();
        if (outcome === "uninstalled") fixture.destroy();

        // Current server app views keep applied=true when a failed Apply or
        // completed Destroy saved a StateVersion. It is not launch readiness.
        await page.route(`**/api/v1/capsules/${capId}/app`, (route) => route.fulfill({
          json: { app: { ...fixture.appView(), applied: true } },
        }));
        let screenReads = 0;
        await page.route("**/api/v1/ui-surfaces?**", (route) => {
          if (new URL(route.request().url()).searchParams.get("capsuleId") === capId) screenReads += 1;
          return route.fallback();
        });

        const mutations = [...fixture.mutations];
        await page.reload({ waitUntil: "domcontentloaded" });
        const complete = page.getByTestId("install-complete");
        if (outcome === "installed") {
          await expect(complete.getByRole("heading", { name: "Installed", exact: true })).toBeVisible();
          await expect(complete.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", "https://apps.example.test/inline-app");
          expect(screenReads).toBeGreaterThan(0);
        } else {
          const existing = page.getByTestId("install-existing-app");
          await expect(existing).toContainText(outcome === "uninstalled" ? "Uninstalled." : "This app needs attention.");
          await expect(existing.getByRole("link", { name: "Manage app", exact: true })).toHaveAttribute("href", `/apps/${capId}`);
          await expect(complete).toHaveCount(0);
          await expect(installSheet(page).getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
          await expect(installSheet(page).getByRole("button", { name: "Stop installing", exact: true })).toHaveCount(0);
          expect(screenReads).toBe(0);
        }
        expect(fixture.mutations).toEqual(mutations);
      });
    }
    test("a saved install attempt replaces an older completion for the same repository", async ({ page }) => {
      const f = await detailFixture(page, base);
      const matchesScreenRead = (url: URL) =>
        url.pathname === "/api/v1/ui-surfaces" && url.searchParams.get("capsuleId") === capId;
      const oldRead = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const retiredRead = Promise.withResolvers<void>();
      await page.route(matchesScreenRead, async (route) => {
        oldRead.resolve();
        await release.promise;
        await route.fallback();
      }, { times: 1 });
      const settleRead = (request: { url: () => string }) => {
        if (matchesScreenRead(new URL(request.url()))) retiredRead.resolve();
      };
      page.on("requestfinished", settleRead);
      page.on("requestfailed", settleRead);
      try {
        await page.goto(sourceUrl);
        await openInstallSheet(page);
        const review = await waitForPlan(page);
        await review.getByRole("button", { name: "Install", exact: true }).click();
        await expect.poll(() => f.mutations.filter((mutation) => mutation === applyMutation).length).toBe(1);
        f.finish();
        const complete = page.getByTestId("install-complete");
        await expect(complete.getByRole("heading", { name: "Installed", exact: true })).toBeVisible();
        await oldRead.promise;

        // Another tab already created this draft. Same repository and release,
        // different coordinator ID, so the router retains the install page.
        const previous = f.attempts.latest()!;
        expect(f.attempts.handle({
          method: "POST", path: "/api/v1/install-plans", idempotencyKey: "another-tab-fixture",
          body: { mode: "attempt", source: previous.source, capsule: { name: "second-instance" } },
        })?.status).toBe(201);
        const second = f.attempts.latest()!.id;
        expect(second).not.toBe(previous.id);
        const mutationFloor = f.mutations.length;
        const secondRead = page.waitForResponse((response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === `/api/v1/install-plans/${second}` && response.ok());
        await page.evaluate((id) => {
          const url = new URL(location.href);
          url.searchParams.set("installPlan", id);
          history.pushState(history.state, "", url);
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        }, second);
        await secondRead;
        await expect(page).toHaveURL((url) => url.searchParams.get("installPlan") === second);
        await expect(complete).toHaveCount(0);
        const progress = installSheet(page).getByTestId("install-progress");
        await expect(progress).toHaveAttribute("data-progress", "paused");
        release.resolve();
        await retiredRead.promise;
        await expect(complete).toHaveCount(0);
        await expect(progress).toHaveAttribute("data-progress", "paused");
        expect(f.mutations.slice(mutationFloor)).toEqual([]);
      } finally {
        release.resolve();
      }
    });
    test("a stalled screen lookup ends without offering to open an unverified app", async ({ page }) => {
      await page.clock.install();
      const f = await detailFixture(page, base);
      const isScreenRead = (url: URL) =>
        url.pathname === "/api/v1/ui-surfaces" && url.searchParams.get("capsuleId") === capId;
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reads = 0;
      await page.route(isScreenRead, async (route) => {
        reads += 1;
        started.resolve();
        await release.promise;
        await route.fallback();
      });
      try {
        await page.goto(sourceUrl);
        await openInstallSheet(page);
        const review = await waitForPlan(page);
        await review.getByRole("button", { name: "Install", exact: true }).click();
        await expect.poll(() => f.mutations.filter((mutation) => mutation === applyMutation).length).toBe(1);
        f.finish();
        const complete = page.getByTestId("install-complete");
        const spinner = complete.getByRole("status", { name: "Loading…" });
        await expect(spinner).toBeVisible();
        await started.promise;
        const mutations = [...f.mutations];
        const cancelled = page.waitForEvent("requestfailed", (request) => isScreenRead(new URL(request.url())));
        await page.clock.fastForward(30_000);
        await expect(spinner).toHaveCount(0);
        await cancelled;
        await expect(complete.getByRole("link", { name: "Manage app", exact: true })).toHaveAttribute("href", `/apps/${capId}`);
        await expect(complete.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
        release.resolve();
        await page.clock.fastForward(10_000);
        await expect(complete.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
        expect(reads).toBe(1);
        expect(f.mutations).toEqual(mutations);
      } finally {
        release.resolve();
      }
    });
    test("a change after the Plan marks it out of date and prepares the install again with the same answers", async ({ page }) => {
      await page.clock.install();
      const mutationDispatches = await observeInstallMutationDispatches(page);
      const f = await detailFixture(page, base, true, false, "not_applicable", {
        connections: () => [{ ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1], id: "pc_only", displayName: "Only Cloudflare", status: "verified" }],
        planRunIdFor: (sequence) => (sequence === 1 ? planId : `run_retry_fixture_replan${sequence}`),
      });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const first = await waitForPlan(page);
      const firstAttempt = new URL(page.url()).searchParams.get("installPlan");
      // The only connection was chosen on its own; the first Plan carries no values.
      expect(f.continued()).toEqual({ expectedGeneration: expect.any(Number), continue: true });
      // Typing holds the shown Plan at once: it cannot be applied while the
      // screen differs from it.
      await expandDetails(page, "install-customization");
      const domain = installSheet(page).getByRole("textbox", { name: domainField });
      await domain.fill("edited.example.com");
      const held = first.getByRole("button", { name: "Install", exact: true });
      await expect(held).toBeDisabled();
      await expect(held).toHaveAttribute("aria-describedby", "iv-plan-outdated");
      await expect(first.getByTestId("install-plan-outdated")).toHaveText("Checked once you finish typing");
      await captureInstallState(page, "app-plan-outdated");
      // Leaving the field makes the change count: the install is prepared again.
      await domain.press("Enter");
      // Prepared again in place: the attempt is discarded and a new one starts
      // with the same name, module and connection; the value goes only with
      // its confirmation.
      await expect.poll(() => f.attempts.log.creates.length, { timeout: 15_000 }).toBe(2);
      const review = await waitForPlan(page);
      await expect(review.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(new URL(page.url()).searchParams.get("installPlan")).not.toBe(firstAttempt);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/install-plans/${firstAttempt}`)).toHaveLength(1);
      expect(f.attempts.log.creates[1]).toEqual({
        mode: "attempt",
        source: { url: "https://github.com/example/cloudflare-service.git", ref: sourceCommit },
        capsule: { name: fixtureAttemptName(1), environment: "production" },
        options: { modulePath: ".", providerBindings: [{ provider: cloudflare, moduleLocalName: "cloudflare", connectionId: "pc_only" }] },
      });
      const continues = f.attempts.log.answers.filter((answer) => (answer as { continue?: boolean }).continue === true);
      expect(continues).toEqual([
        { expectedGeneration: expect.any(Number), continue: true },
        { expectedGeneration: expect.any(Number), continue: true, variables: { domain: "edited.example.com" } },
      ]);
      expect(JSON.stringify(f.attempts.log.creates)).not.toContain("edited.example.com");
      // Prepared once for one change; nothing applied without the click.
      const before = await mutationDispatches();
      await page.clock.runFor(1_500);
      expect(await mutationDispatches()).toBe(before);
      expect(f.attempts.log.creates).toHaveLength(2);
      expect(f.mutations.some((m) => m.endsWith("/apply"))).toBe(false);
      await expectNothingStored(page, "edited.example.com");
      expect(errors).toEqual([]);
    });
    for (const cost of ["rated_zero", "not_applicable", "unrated", "unavailable"] as const) {
      test(`review exposes planned resources and the ${cost} cost before the Install click`, async ({ page }) => {
        if (cost === "rated_zero") await page.clock.install();
        const f = await detailFixture(page, base, false, false, cost);
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(sourceUrl);
        await openInstallSheet(page);
        const review = await waitForPlan(page);
        await expect(review.getByTestId("install-plan-resources")).not.toBeVisible();
        await expandDetails(page, "install-resource-details");
        const counts = review.getByRole("definition");
        await expect(counts).toHaveText(["2", "0", "0"]);
        const resources = review.getByTestId("install-plan-resources");
        await expect(resources.getByRole("heading", { name: "Planned changes" })).toBeVisible();
        await expect(resources).toContainText("Cloudflare Workers Script");
        await expect(resources).toContainText("Cloudflare D1 Database");
        const costBlock = review.getByTestId("install-plan-cost");
        await expect(costBlock).toHaveAccessibleName("Cost estimate");
        const expectedCost = {
          rated_zero: "The estimate is $0.00.",
          not_applicable: "No estimate. Cloud usage charges may apply.",
          unrated: "Usage measured; no price policy is configured.",
          unavailable: "Could not load costs. Check pricing with the connected cloud.",
        }[cost];
        await expect(costBlock).toContainText(expectedCost);
        // An unknown cost is never presented as free.
        if (cost !== "rated_zero") await expect(costBlock).not.toContainText("$0.00");
        const allow = review.getByRole("button", { name: "Install", exact: true });
        await expect(allow).toBeEnabled();
        await expect(review.getByRole("checkbox")).toHaveCount(0);
        expect(f.mutations).not.toContain(applyMutation);
        if (cost !== "rated_zero") return;
        await captureInstallState(page, "app-review");
        // A clean Plan waits for consent: no Apply across Run poll intervals.
        await page.clock.runFor(3_500);
        expect(f.mutations).not.toContain(applyMutation);
        // A reload reopens the same review, read-only: no new attempt, no Apply.
        await page.reload();
        await expect(planReview(page).getByRole("button", { name: "Install", exact: true })).toBeEnabled();
        expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
        expect(f.mutations).not.toContain(applyMutation);
        await planReview(page).getByRole("button", { name: "Install", exact: true }).click();
        await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
        await expect(planReview(page).getByRole("status").filter({ hasText: "Installing" })).toBeVisible();
        expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
        expect(errors).toEqual([]);
      });
    }
    test("Stop installing from the sheet discards the whole attempt and returns to the same app", async ({ page }) => {
      const f = await detailFixture(page, base, true);
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await expect(sheet).toHaveAttribute("data-install-state", "connections");
      const attemptId = new URL(page.url()).searchParams.get("installPlan");
      await planPreview(page).getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(installSheet(page)).toHaveCount(0);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(page.getByTestId("install-start")).toBeVisible();
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/install-plans/${attemptId}`)).toHaveLength(1);
      expect(f.attempts.log.discards).toEqual([{ id: attemptId, expectedGeneration: f.attempts.latest()!.generation - 1 }]);
      // The page itself deletes nothing else: the coordinator owns the cleanup.
      expect(f.mutations.some((m) => m.includes("/sources") || m.includes("/abandon"))).toBe(false);
      // The URL still names this app, so a reload returns to the same page.
      const discarded = new URL(page.url());
      expect(discarded.searchParams.get("installPlan")).toBeNull();
      expect(discarded.searchParams.get("git")).toBe("https://github.com/example/cloudflare-service.git");
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "cloudflare-service" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
    });
    test("Stop installing from the review discards the attempt and its unapplied app", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const review = await waitForPlan(page);
      await review.getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(installSheet(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(page).not.toHaveURL(/[?&]installPlan=/u);
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      expect(f.mutations.some((m) => m.endsWith("/apply") || m.startsWith("DELETE /api/v1/capsules/") || m.includes("/abandon"))).toBe(false);
    });
    for (const lateResponse of ["conflict read", "discard success"] as const) {
      test(`Stop installing leaves the replacement attempt visible after a late ${lateResponse}`, async ({ page }) => {
        const fixture = await detailFixture(page, base, true);
        await page.goto(sourceUrl);
        await openInstallSheet(page);
        await expect(installSheet(page)).toHaveAttribute("data-install-state", "connections");
        const original = fixture.attempts.latest()!;
        const path = `/api/v1/install-plans/${original.id}`;
        const parked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let requested = 0;
        await page.route(`**${path}`, async (route) => {
          const method = route.request().method();
          if (method === "DELETE") {
            requested += 1;
            if (lateResponse === "conflict read") {
              return route.fulfill({ status: 409, json: { error: { code: "install_plan_generation_conflict" } } });
            }
          }
          if (method !== (lateResponse === "conflict read" ? "GET" : "DELETE")) return route.fallback();
          parked.resolve();
          await release.promise;
          return lateResponse === "conflict read"
            ? route.fulfill({ status: 401, json: { error: "invalid_token" } })
            : route.fallback();
        });
        await page.evaluate(({ ownedPath, watchedMethod }) => {
          const originalFetch = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const input = args[0];
            const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
            if (url.pathname !== ownedPath || args[1]?.method !== watchedMethod) return originalFetch(...args);
            try {
              return await originalFetch(...args);
            } finally {
              requestAnimationFrame(() => requestAnimationFrame(() => {
                document.documentElement.dataset.oldDiscardSettled = "true";
              }));
            }
          };
        }, { ownedPath: path, watchedMethod: lateResponse === "conflict read" ? "GET" : "DELETE" });
        try {
          await planPreview(page).getByRole("button", {name: "Stop installing", exact: true}).click();
          await parked.promise;
          expect(fixture.attempts.handle({
            method: "POST", path: "/api/v1/install-plans", idempotencyKey: "discard-other-attempt",
            body: { mode: "attempt", source: original.source, capsule: { name: "another-install" } },
          })?.status).toBe(201);
          const replacement = fixture.attempts.latest()!.id;
          expect(replacement).not.toBe(original.id);
          const next = `${sourceUrl}&installPlan=${replacement}`;
          await page.evaluate((url) => {
            history.pushState(history.state, "", url);
            window.dispatchEvent(new PopStateEvent("popstate", {state: history.state}));
          }, next);
          await expect(page).toHaveURL((url) => url.pathname + url.search === next);
          const outcome = Promise.race([
            page.waitForFunction(() => document.documentElement.dataset.oldDiscardSettled === "true").then(() => "settled"),
            page.waitForRequest((request) =>
              request.isNavigationRequest() && new URL(request.url()).pathname === "/sign-in").then(() => "redirected"),
          ]);
          release.resolve();
          expect(await outcome).toBe("settled");
          await expect(page).toHaveURL((url) => url.pathname + url.search === next);
          expect(requested).toBe(1);
          expect(fixture.mutations.some((mutation) => mutation.endsWith("/apply") || mutation === `DELETE /api/v1/install-plans/${replacement}`)).toBe(false);
        } finally {
          release.resolve();
        }
      });
    }
    test("Stop installing while reading waits for the coordinator and then discards", async ({ page }) => {
      await page.clock.install();
      const f = await detailFixture(page, base, false, false, "not_applicable", { roundsPerPhase: 1_000 });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(installSheet(page).getByTestId("install-progress")).toHaveText("Preparing…");
      await expect.poll(() => f.attempts.log.reconciles).toBeGreaterThan(0);
      await planPreview(page).getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      // The user's own stop is not reported as a failure.
      await expect(page.locator(".iv-error")).toHaveCount(0);
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      const reconcilesAfterStop = f.attempts.log.reconciles;
      await page.clock.runFor(1_000);
      expect(f.attempts.log.reconciles).toBe(reconcilesAfterStop);
    });
    test("the app name is edited before the app exists; a taken name offers a free one", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", { takenNames: [fixtureAttemptName(1)] });
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await expandDetails(page, "install-customization");
      const name = sheet.getByTestId("install-app-name");
      await expect(name).toHaveValue(fixtureAttemptName(1));
      await expect(sheet).toContainText("This internal name is already in use.");
      await expect(page.getByTestId("install-apply-reason")).toHaveText("Check what you entered");
      await name.fill("Not A Valid Name");
      await expect(sheet).toContainText("Use lowercase letters");
      await sheet.getByRole("button", { name: `Use “${fixtureAttemptName(1, 8)}”`, exact: true }).click();
      await expect(name).toHaveValue(fixtureAttemptName(1, 8));
      expect(f.attempts.log.answers).toContainEqual({ expectedGeneration: expect.any(Number), capsuleName: fixtureAttemptName(1, 8) });
      // The free name completes the sheet: the Plan is made with it.
      await waitForPlan(page);
      expect(f.attempts.latest()?.capsule.name).toBe(fixtureAttemptName(1, 8));
      // Renaming after the Plan prepares the install again under the new name.
      await name.fill("renamed-app");
      await name.press("Enter");
      await expect.poll(() => f.attempts.log.creates.length, { timeout: 15_000 }).toBe(2);
      await waitForPlan(page);
      expect(f.attempts.log.creates[1]).toMatchObject({ capsule: { name: "renamed-app" } });
      expect(f.attempts.latest()?.capsule.name).toBe("renamed-app");
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "renamed-app");
    });
    test("Tab reaches a third configuration without submitting until Enter", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        modules: [
          { path: "apps/web", providers: [cloudflare], recommended: true },
          { path: "apps/api", providers: [] },
          { path: "apps/worker", providers: [] },
        ],
      });
      await page.goto(`/new?git=${encodeURIComponent("https://github.com/example/cloudflare-service.git")}&name=cloudflare-service`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      // The choice is part of the same screen, not a step of its own.
      const chooser = installSheet(page).getByTestId("install-module-chooser");
      await expect(chooser.getByRole("heading", { name: "Choose a configuration" })).toBeVisible();
      await expect(page.getByTestId("install-apply-reason")).toHaveText("Choose a configuration to continue");
      const recommended = chooser.getByRole("button", { name: /apps\/web.*Publisher recommendation/u });
      await expect(chooser.getByRole("button", { name: "Use this configuration" })).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await recommended.focus();
      await expect(recommended).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(chooser.getByRole("button", { name: "apps/api", exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(chooser.getByRole("button", { name: "apps/worker", exact: true })).toBeFocused();
      expect(f.attempts.log.answers).toHaveLength(0);
      await page.keyboard.press("Enter");
      await waitForPlan(page);
      await expect(chooser).toHaveCount(0);
      expect(f.attempts.log.answers.filter((entry) => (entry as { modulePath?: string }).modulePath !== undefined)).toEqual([
        { expectedGeneration: expect.any(Number), modulePath: "apps/worker" },
      ]);
      expect(f.mutations).not.toContain(applyMutation);
    });
    test("a failed attempt explains why and starts over as a new attempt", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        failAt: { phase: "analyzing_compatibility", code: "source_sync_failed" },
      });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const problem = page.getByTestId("install-attempt-problem");
      await expect(problem).toHaveAttribute("data-install-stage", "failed");
      await expect(problem).toContainText("The Git repository couldn't be read.");
      await problem.getByRole("button", { name: "Start over", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === attemptPost).length).toBe(2);
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      expect(f.attempts.log.creates[1]).toEqual({
        mode: "attempt",
        source: { url: "https://github.com/example/cloudflare-service.git", ref: sourceCommit },
        capsule: { name: fixtureAttemptName(1), environment: "production" },
        options: { modulePath: "." },
      });
    });
    test("a reopened attempt is read only until the person continues", async ({ page }) => {
      await page.clock.install();
      const mutationDispatches = await observeInstallMutationDispatches(page);
      const f = await detailFixture(page, base, false, false, "not_applicable", { roundsPerPhase: 3 });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(page).toHaveURL(/[?&]installPlan=gip_/u);
      const attemptId = new URL(page.url()).searchParams.get("installPlan")!;
      // Opening a saved attempt URL must not advance the coordinator.
      await page.goto(`/new?installPlan=${attemptId}`);
      const progress = installSheet(page).getByTestId("install-progress");
      await expect(progress).toHaveAttribute("data-progress", "paused");
      await expect(progress).toContainText("Reading stopped partway.");
      const reconciles = f.attempts.log.reconciles;
      await page.clock.runFor(1_000);
      expect(await mutationDispatches()).toBe(0);
      expect(f.attempts.log.reconciles).toBe(reconciles);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await progress.getByRole("button", { name: "Continue", exact: true }).click();
      await waitForPlan(page);
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
    });
    test("the Store does not list unfinished installs; the saved install page can resume or stop", async ({ page }) => {
      const f = await detailFixture(page, base, true);
      await page.goto(sourceUrl);
      await expect(await openInstallSheet(page)).toHaveAttribute("data-install-state", "connections");
      const attemptUrl = page.url();
      const attemptId = new URL(attemptUrl).searchParams.get("installPlan")!;
      const listReads: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/install-plans") && url.searchParams.has("open")) listReads.push(url.pathname);
      });
      await page.goto("/new");
      await expect(page.locator(".iv-catalogue-browse")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Unfinished installs" })).toHaveCount(0);
      expect(listReads).toEqual([]);

      await page.goto(attemptUrl);
      const sheet = installSheet(page);
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(sheet).toHaveCount(0);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/install-plans/${attemptId}`)).toHaveLength(1);
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
    });
    test("an expired attempt says so and starts over", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const attemptId = new URL(page.url()).searchParams.get("installPlan")!;
      f.attempts.invalidate(attemptId);
      await page.reload();
      const problem = page.getByTestId("install-attempt-problem");
      await expect(problem).toHaveAttribute("data-install-stage", "invalidated");
      await expect(problem).toContainText("This install expired");
      await problem.getByRole("button", { name: "Start over", exact: true }).click();
      await expect(installSheet(page)).toBeVisible();
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(2);
    });
    test("a saved review never substitutes another Plan for its saved operation", async ({ page }) => {
      const otherPlanId = "run_other_explicit_review";
      const otherApplyId = "run_other_explicit_apply";
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        planRunIdFor: (sequence) => sequence === 1 ? planId : otherPlanId,
      });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      let mode: "other_plan" | "other_apply" | "saved" | "accepted" = "other_plan";
      let reads = 0;
      let applyPosts = 0;
      let releaseRead: (() => void) | undefined;
      let pendingRead: Promise<void> | undefined;
      const actual = (id: string, type: "plan" | "apply", parent?: string) => ({
        id, workspaceId: "ws_alpha", capsuleId: capId, type, status: type === "apply" ? "running" : "succeeded",
        ...(parent ? { planRunId: parent } : {}),
        summary: { add: 1, change: 0, destroy: 0 }, policyStatus: "pass", createdBy: "portable-e2e", createdAt: now,
        planResources: [{ address: "fixture.other_operation", type: "cloudflare_workers_script", actions: ["create"] }],
      });
      await page.route(`**/api/v1/capsules/${capId}/app`, async (route) => {
        await pendingRead;
        if (mode === "saved") return route.fallback();
        const id = mode === "other_plan" ? otherPlanId : mode === "other_apply" ? otherApplyId : applyId;
        const type = mode === "other_plan" ? "plan" : "apply";
        const latest = { id, type, status: type === "plan" ? "succeeded" : "running", createdAt: now };
        return route.fulfill({ json: { app: { ...f.appView(), latestRun: latest,
          progress: { revisionPreparing: false, ...(type === "plan"
            ? { review: { runId: id, runType: "plan" } } : { run: latest }) },
        } } });
      });
      await page.route("**/api/v1/runs/*", (route) => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1);
        if (id === otherPlanId) { reads += 1; return route.fulfill({ json: { run: actual(id, "plan") } }); }
        if (id === otherApplyId || id === applyId) return route.fulfill({ json: { run: actual(id, "apply", id === applyId ? planId : otherPlanId) } });
        return route.fallback();
      });
      await page.route(`**/api/v1/runs/${planId}/apply`, (route) => {
        applyPosts += 1;
        mode = "accepted"; // One accepted effect; its response alone is lost.
        return route.fulfill({ status: 503, json: { error: "fixture_lost_answer" } });
      });
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      await expect.poll(() => reads).toBeGreaterThan(0);
      // A normal different Plan has no durable link to this saved attempt.
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop installing", exact: true })).toHaveCount(0);
      const issue = page.getByTestId("install-review-unverified");
      await expect(issue).toBeVisible();
      await expect(issue.getByRole("link", { name: "Technical details", exact: true })).toHaveAttribute("href", `/runs/${otherPlanId}`);
      await expandDetails(page, "install-customization");
      await expect(installSheet(page).getByTestId("install-app-name")).toBeDisabled();
      const mutations = [...f.mutations];
      mode = "other_apply";
      await issue.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(issue.getByRole("link", { name: "Technical details", exact: true })).toHaveAttribute("href", `/runs/${otherApplyId}`);
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      expect(f.mutations).toEqual(mutations);
      expect(applyPosts).toBe(0);
      // A verified fresh saved Plan stays editable; the hold is temporary.
      mode = "saved";
      await issue.getByRole("button", { name: "Retry", exact: true }).click();
      const review = await waitForPlan(page);
      await expect(installSheet(page).getByTestId("install-app-name")).toBeEnabled();
      await review.getByRole("button", { name: "Install", exact: true }).click();
      await expect(review.getByRole("alert")).toContainText("We couldn't confirm the result.");
      expect(applyPosts).toBe(1);
      // A reload first holds the outer sheet too, then follows the exact accepted Apply.
      pendingRead = new Promise<void>((resolve) => { releaseRead = resolve; });
      await page.reload();
      await expect(page.getByTestId("install-review")).toBeVisible();
      await expandDetails(page, "install-customization");
      await expect(installSheet(page).getByTestId("install-app-name")).toBeDisabled();
      await expect(installSheet(page).getByTestId("install-review-edit")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      releaseRead!(); pendingRead = undefined;
      await expect(planReview(page)).toContainText("Installing");
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      expect(applyPosts).toBe(1);
      expect(f.mutations).toEqual(mutations);
      // A new explicit attempt's own canonical P2 is valid, even though P1 could not adopt it.
      mode = "other_plan";
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install another", exact: true }).click();
      await expect(installSheet(page)).toBeVisible();
      await expect((await waitForPlan(page)).getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(2);
      expect(f.mutations.some((m) => m.startsWith("DELETE "))).toBe(false);
      expect(applyPosts).toBe(1);
      // A definitive rejection retains the existing explicit Stop action.
      await page.route(`**/api/v1/runs/${otherPlanId}/apply`, (route) => route.fulfill({ status: 403, json: { error: "forbidden" } }));
      await planReview(page).getByRole("button", { name: "Install", exact: true }).click();
      const stop = planReview(page).getByRole("button", { name: "Stop installing", exact: true });
      await expect(stop).toBeEnabled();
      await stop.click();
      await expect.poll(() => f.mutations.filter((m) => m.startsWith("DELETE ")).length).toBe(1);
      expect(errors).toEqual([]);
    });
    for (const destination of ["another install", "another saved attempt", "current attempt"] as const) {
      test(`a saved attempt read handles 401 when opening ${destination}`, async ({ page }) => {
        const fixture = await detailFixture(page, base);
        const makeAttempt = (key: string) => {
          expect(fixture.attempts.handle({
            method: "POST", path: "/api/v1/install-plans", idempotencyKey: key,
            body: {
              mode: "attempt",
              source: { url: "https://github.com/example/cloudflare-service.git", ref: sourceCommit, path: "." },
              options: { modulePath: "." },
            },
          })?.status).toBe(201);
          return fixture.attempts.latest()!.id;
        };
        const old = makeAttempt("saved-401-old-fixture");
        const current = `${sourceUrl}&installPlan=${old}`;
        const other = destination === "another saved attempt"
          ? `${sourceUrl}&installPlan=${makeAttempt("saved-401-next-fixture")}`
          : sourceUrl.replaceAll("cloudflare-service", "other-service");
        const path = `/api/v1/install-plans/${old}`;
        await page.addInitScript((heldPath) => {
          const original = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const input = args[0];
            const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
            if (url.pathname !== heldPath) return original(...args);
            try {
              return await original(...args);
            } finally {
              requestAnimationFrame(() => requestAnimationFrame(() => {
                document.documentElement.dataset.savedAttemptReadSettled = "true";
              }));
            }
          };
        }, path);
        const read = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        await page.route(`**${path}`, async (route) => {
          read.resolve();
          await release.promise;
          await route.fulfill({ status: 401, json: { error: "invalid_token" } });
        });
        try {
          await page.goto(current, { waitUntil: "domcontentloaded" });
          await expect(page.getByTestId("install-loading")).toBeVisible();
          await read.promise;
          if (destination !== "current attempt") {
            await page.evaluate((url) => {
              history.pushState(history.state, "", url);
              window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
            }, other);
            await expect(page).toHaveURL((url) => url.pathname + url.search === other);
          }
          if (destination === "current attempt") {
            release.resolve();
            await expect(page).toHaveURL((url) =>
              url.pathname === "/sign-in" && url.searchParams.get("return") === current);
          } else {
            const outcome = Promise.race([
              page.waitForFunction(() => document.documentElement.dataset.savedAttemptReadSettled === "true").then(() => "settled"),
              page.waitForRequest((request) =>
                request.isNavigationRequest() && new URL(request.url()).pathname === "/sign-in").then(() => "redirected"),
            ]);
            release.resolve();
            expect(await outcome).toBe("settled");
            await expect(page).toHaveURL((url) => url.pathname + url.search === other);
          }
          expect(fixture.mutations).toEqual([]);
        } finally {
          release.resolve();
        }
      });
    }
    for (const read of ["app", "candidate", "run", "cost", "logs"] as const) {
      for (const retired of [true, false]) {
        test(`an install review's ${retired ? "retired" : "current"} ${read} read handles 401 in its own view`, async ({ page }) => {
          const fixture = await detailFixture(page, base);
          const appPath = `/api/v1/capsules/${capId}/app`;
          const candidateId = "run_recovering_install";
          const candidatePath = `/api/v1/runs/${candidateId}`;
          const runPath = `/api/v1/runs/${planId}`;
          const failedPath = { app: appPath, candidate: candidatePath, run: runPath,
            cost: `${runPath}/cost`, logs: `${runPath}/logs` }[read];
          await page.addInitScript((path) => {
            const fetch = window.fetch.bind(window);
            window.fetch = async (...args) => {
              const response = await fetch(...args);
              if (response.status === 401 && new URL(response.url).pathname === path) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                  document.documentElement.dataset.installReviewReadSettled = "true";
                }));
              }
              return response;
            };
          }, failedPath);
          let release!: () => void;
          const held = new Promise<void>((resolve) => { release = resolve; });
          let deniedReads = 0;
          if (read === "candidate") {
            await page.route(`**${appPath}`, (route) => route.fulfill({
              json: { app: { ...fixture.appView(), progress: {
                revisionPreparing: false,
                run: { id: candidateId, type: "apply", status: "running", createdAt: now },
              } } },
            }));
          }
          await page.route(`**${failedPath}`, async (route) => {
            deniedReads += 1;
            await held;
            return route.fulfill({ status: 401, json: { error: "invalid_token" } });
          });
          try {
            await page.goto(sourceUrl);
            await openInstallSheet(page);
            if (read === "logs") await page.getByText("Progress and logs", { exact: true }).click();
            await expect.poll(() => deniedReads).toBe(1);
            const current = new URL(page.url());
            const next = sourceUrl.replaceAll("cloudflare-service", "other-service");
            if (retired) {
              await page.evaluate((url) => {
                history.pushState(history.state, "", url);
                window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
              }, next);
              await expect(page.getByTestId("install-app-header")).toContainText("other-service");
              await expect(page.getByTestId("install-review")).toHaveCount(0);
            }
            const settled = Promise.race([
              page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/sign-in").then(() => "redirected"),
              page.waitForFunction(() => document.documentElement.dataset.installReviewReadSettled === "true").then(() => "stayed"),
            ]);
            release();
            expect(await settled).toBe(retired ? "stayed" : "redirected");
            if (retired) {
              await expect(page).toHaveURL(new URL(next, current.origin).href);
              await expect(page.getByTestId("install-app-header")).toContainText("other-service");
            } else {
              await expect(page).toHaveURL((url) => url.pathname === "/sign-in" &&
                url.searchParams.get("return") === current.pathname + current.search + current.hash);
            }
            expect(deniedReads).toBe(1);
            expect(fixture.mutations).not.toContain(applyMutation);
          } finally {
            release();
          }
        });
      }
    }
    test("review blocks Install while the app's current state cannot be read and retries the read", async ({ page }) => {
      const f = await detailFixture(page, base);
      let unavailable = true;
      await page.route(`**/api/v1/capsules/${capId}/app`, (route) => unavailable
        ? route.fulfill({ status: 503, json: { error: "fixture_unavailable" } })
        : route.fallback());
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const issue = page.getByTestId("install-review-read-error");
      await expect(issue).toBeVisible();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toHaveCount(0);
      expect(f.mutations).not.toContain(applyMutation);
      const mutations = [...f.mutations];
      unavailable = false;
      await issue.getByRole("button", { name: "Retry", exact: true }).click();
      const review = await waitForPlan(page);
      await expect(review.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(issue).toHaveCount(0);
      expect(f.mutations).toEqual(mutations);
    });
    test("failed Apply offers a new reviewed Plan without abandoning partial state or replaying Apply", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl); await openInstallSheet(page);
      await waitForPlan(page);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
      f.fail(true); f.failRetry(true);
      const review = planReview(page);
      await expect(review.getByRole("button", { name: "Retry installation", exact: true })).toBeVisible({ timeout: 15_000 });
      await review.getByRole("button", { name: "Retry installation", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${capId}/plan`)).length).toBe(1);
      expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
      expect(f.mutations.some((m) => m.includes("/abandon") || m.startsWith("DELETE "))).toBe(false);
      await expect(review.getByRole("link", { name: "Technical details", exact: true })).toHaveAttribute("href", "/runs/run_retry_fixture_1");
    });
    for (const retired of [true, false]) {
    test(retired
      ? "a late install retry 401 cannot redirect a replacement app page"
      : "a current install retry 401 preserves its review as the sign-in destination", async ({ page }) => {
      const f = await detailFixture(page, base);
      const planPath = `/api/v1/capsules/${capId}/plan`;
      await page.addInitScript((path) => {
        const fetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await fetch(...args);
          if (response.status === 401 && new URL(response.url).pathname === path) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              document.documentElement.dataset.installRetrySettled = "true";
            }));
          }
          return response;
        };
      }, planPath);
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let planPosts = 0;
      await page.route(`**${planPath}`, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        planPosts += 1;
        await held;
        return route.fulfill({ status: 401, json: { error: "invalid_token" } });
      });
      try {
        await page.goto(sourceUrl);
        await openInstallSheet(page);
        const review = await waitForPlan(page);
        await review.getByRole("button", { name: "Install", exact: true }).click();
        await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
        f.fail(true);
        await review.getByRole("button", { name: "Retry installation", exact: true }).click();
        await expect.poll(() => planPosts).toBe(1);
        const current = new URL(page.url());
        const next = sourceUrl.replaceAll("cloudflare-service", "other-service");
        if (retired) {
          await page.evaluate((url) => {
            history.pushState(history.state, "", url);
            window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
          }, next);
          await expect(page.getByTestId("install-app-header")).toContainText("other-service");
          await expect(review).toHaveCount(0);
        }
        const settled = Promise.race([
          page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/sign-in").then(() => "redirected"),
          page.waitForFunction(() => document.documentElement.dataset.installRetrySettled === "true").then(() => "stayed"),
        ]);
        release();
        expect(await settled).toBe(retired ? "stayed" : "redirected");
        if (retired) {
          await expect(page).toHaveURL(new URL(next, current.origin).href);
        } else {
          await expect(page).toHaveURL((url) => url.pathname === "/sign-in" &&
            url.searchParams.get("return") === current.pathname + current.search + current.hash);
        }
        expect(planPosts).toBe(1);
        expect(f.mutations.filter((m) => m.endsWith("/apply"))).toEqual([applyMutation]);
      } finally {
        release();
      }
    });
    }
    test("an unconfirmed Apply is held and reload does not restore consent", async ({ page }) => {
      await detailFixture(page, base);
      let posts = 0;
      await page.route(`**/runs/${planId}/apply`, (route) => { posts += 1; return route.fulfill({ status: 503, json: { error: "fixture_indeterminate" } }); });
      await page.goto(sourceUrl); await openInstallSheet(page);
      const review = await waitForPlan(page);
      expect(posts).toBe(0);
      await review.getByRole("button", { name: "Install", exact: true }).click();
      await expect(review.getByRole("button", { name: "Install", exact: true })).toBeDisabled();
      const recovery = review.getByRole("alert");
      await expect(recovery).toContainText("We couldn't confirm the result.");
      await recovery.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(recovery.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
      // An Apply that may have started can no longer be discarded from here.
      await expect(review.getByRole("button", { name: "Stop installing", exact: true })).toHaveCount(0);
      expect(posts).toBe(1);
      await page.reload();
      await expect(planReview(page).getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(posts).toBe(1);
    });
  });

  test.describe("Installed app page", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");

    async function openUninstall(page: Page): Promise<Locator> {
      await page.getByTestId("app-management").locator('[data-app-section-link="danger"]').click();
      await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-section", "danger");
      const section = page.getByTestId("app-uninstall");
      await expect(section).toBeVisible();
      return section;
    }

    test("Uninstall confirms once, restores its real reservation, and supports cancellation", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      // The reservation uses this fixture's fixed timestamps, not today's date.
      await page.clock.setFixedTime(new Date(now));
      // An old install-page locator opens the app's own page.
      await page.goto(`/new?capsule=${capId}`);
      await expect(page).toHaveURL(new RegExp(`/apps/${capId}$`, "u"));
      const appPage = page.getByTestId("app-page");
      const section = await openUninstall(page);
      // The grace period shows before anything is scheduled.
      await expect(section).toContainText("Its data stays for 7 days");
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(appPage).toHaveAttribute("data-app-state", "uninstall_scheduled");
      await page.reload(); await expect(appPage).toHaveAttribute("data-app-state", "uninstall_scheduled");
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
      // The scheduled uninstall is this app's problem until it runs.
      const scheduled = page.getByTestId("app-problems").locator('[data-problem="uninstall"]');
      await expect(scheduled).toContainText("will be uninstalled on");
      await expect(page.getByTestId("app-uninstall")).toHaveCount(0);
      await page.getByTestId("app-section-back").click();
      await expect(appPage).toHaveAttribute("data-app-section", "overview");
      await expect(page.locator('[data-app-section-link="danger"]')).toHaveCount(0);
      await page.getByTestId("app-header").getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      f.destroy(); await page.reload();
      await expect(appPage).toHaveAttribute("data-app-state", "uninstalled");
      await expect(page.getByTestId("app-header").getByRole("link", { name: "Install again", exact: true })).toBeVisible();
    });
    test("lost uninstall and cancellation answers recover the current reservation without resending", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish(); f.loseRemovalAnswer(); f.loseCancellationAnswer();
      await page.clock.setFixedTime(new Date(now));
      let contextReads = 0;
      let metadata: "normal" | "other" | "missing" | "unavailable" = "normal";
      await page.route(`**/api/v1/capsules/${capId}`, (route) => {
        if (route.request().method() !== "GET" || f.capsule().uninstall?.phase !== "cancelled") return route.fallback();
        if (metadata === "unavailable") return route.fulfill({ status: 503, json: { error: "fixture_read_unavailable" } });
        const value = f.capsule();
        return route.fulfill({ json: { capsule: { ...value, uninstall: metadata === "missing" ? undefined :
          metadata === "other" ? { ...value.uninstall!, id: "other_reservation" } : value.uninstall },
          installConfigReAdoption: { authorityGuard: `sha256:${"c".repeat(64)}` } } });
      });
      page.on("request", (request) => {
        if (request.method() === "GET" && new URL(request.url()).pathname === `/api/v1/capsules/${capId}`) contextReads += 1;
      });
      await page.goto(`/apps/${capId}`);
      const section = await openUninstall(page);
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Uninstall", exact: true }).click();
      const appPage = page.getByTestId("app-page");
      await expect(appPage).toHaveAttribute("data-app-state", "uninstall_scheduled");
      // This is the current reservation, not proof of who created it.
      const scheduled = f.capsule().uninstall!;
      expect(scheduled).toMatchObject({ id: "uninstall_inline", phase: "scheduled", revision: 1 });
      await expect(page.getByTestId("app-header").getByRole("button", { name: "Cancel uninstall", exact: true })).toBeEnabled();
      const scheduleErrors = await appPage.locator('[role="alert"].wa-error').allTextContents();
      const before = contextReads;
      metadata = "other";
      await page.getByTestId("app-section-back").click();
      await page.getByTestId("app-header").getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      // The server committed exactly one cancellation, although its answer was lost.
      await expect.poll(() => f.mutations.filter((m) => m.endsWith("/cancel-uninstall")).length).toBe(1);
      expect(f.capsule().uninstall).toMatchObject({ id: scheduled.id, revision: 2, phase: "cancelled" });
      await expect(appPage).toHaveAttribute("data-app-state", "installed");
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      expect(contextReads).toBeGreaterThan(before);
      const recovery = page.getByTestId("app-uninstall-recovery");
      await expect(recovery).toBeVisible(); // A different cancelled record cannot confirm this cancellation.
      for (const incomplete of ["missing", "unavailable"] as const) {
        metadata = incomplete;
        const count = contextReads;
        await recovery.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect.poll(() => contextReads).toBeGreaterThan(count);
        await expect(recovery).toBeVisible();
      }
      metadata = "normal";
      await recovery.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(recovery).toHaveCount(0);
      expect(scheduleErrors).toEqual([]);
      await expect(appPage.locator('[role="alert"].wa-error')).toHaveCount(0);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
      expect(f.mutations.filter((m) => m.endsWith("/cancel-uninstall"))).toHaveLength(1);
    });
    test("a refused cancellation stays visible when a later read shows the app restored", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.clock.setFixedTime(new Date(now));
      let refused = false;
      let cancellations = 0;
      await page.route(`**/api/v1/capsules/${capId}/cancel-uninstall`, (route) => {
        cancellations += 1; refused = true;
        return route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Cancellation was refused." } } });
      });
      // Later public facts may change, but they cannot turn the explicit rejection into success.
      await page.route(`**/api/v1/capsules/${capId}`, (route) => {
        if (!refused || route.request().method() !== "GET") return route.fallback();
        const current = f.capsule();
        return route.fulfill({ json: { capsule: { ...current, status: "active", uninstall: {
          ...current.uninstall!, revision: current.uninstall!.revision + 1, phase: "cancelled", cancelledAt: "2026-10-27T01:02:00Z",
        } }, installConfigReAdoption: { authorityGuard: `sha256:${"c".repeat(64)}` } } });
      });
      await page.route(`**/api/v1/capsules/${capId}/app`, (route) => !refused ? route.fallback() : route.fulfill({ json: { app: {
        ...f.appView(), status: "active", state: "installed", primaryAction: "none", problems: [],
        uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy: [] } },
      } } }));
      await page.goto(`/apps/${capId}`);
      const section = await openUninstall(page);
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Uninstall", exact: true }).click();
      const appPage = page.getByTestId("app-page");
      await expect(appPage).toHaveAttribute("data-app-state", "uninstall_scheduled");
      await page.getByTestId("app-section-back").click();
      await page.getByTestId("app-header").getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      await expect(appPage).toHaveAttribute("data-app-state", "installed");
      const rejection = appPage.getByRole("alert");
      await expect(rejection).toHaveCount(1);
      await expect(rejection).toBeVisible();
      await expect(rejection).not.toBeEmpty();
      await expect(page.getByTestId("app-uninstall-recovery")).toHaveCount(0);
      expect(cancellations).toBe(1);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
    });
    test("returning to Store exits the installed detail without replaying any action", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.goto(`/new?capsule=${capId}`);
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Store", exact: true }).first().click();
      await expect(page).toHaveURL(/\/new$/u);
      await expect(page.getByTestId("install-app-header")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "Store" })).toBeVisible();
      await expect(page.locator('input[name="storeSearch"]')).toBeVisible();
      expect(f.mutations).toEqual([]);
    });
    test("launch read failure is retryable and a later failed update retains management", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish(); f.screensUnreadable(true);
      await page.goto(`/apps/${capId}`);
      const header = page.getByTestId("app-header");
      // Screens the server could not read are named, never silently absent.
      await expect(header.getByRole("alert")).toContainText("Couldn't read its screens.");
      await expect(header.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
      f.screensUnreadable(false);
      await header.getByRole("button", { name: "Reload screens", exact: true }).click();
      await expect(header.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      await expect(header.getByRole("alert")).toHaveCount(0);
      // A later problem is this app's, with the server's next step; the app
      // stays manageable.
      f.problem("error"); await page.reload();
      await expect(page.getByTestId("app-problems").locator('[data-problem="capsule_error"]')).toContainText("This app has a problem");
      await expect(header.getByRole("button", { name: "Review the installed version again", exact: true })).toBeVisible();
      await expect((await openUninstall(page)).getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      await page.getByTestId("app-section-back").click();
      await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-section", "overview");
      f.problem("disabled"); await page.reload();
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Stopped.");
      await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
      // A stopped app cannot be scheduled for uninstall; it is removed by a
      // reviewed plan instead.
      await expect((await openUninstall(page)).getByRole("button", { name: "Uninstall now", exact: true })).toBeVisible();
    });
    /** Uninstall a never-applied app from its page; the dialog promises an immediate removal. */
    async function uninstallNeverApplied(page: Page): Promise<void> {
      await page.goto(`/apps/${capId}`);
      await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-state", "installing");
      const section = await openUninstall(page);
      await expect(section).toContainText("hasn't created anything in your cloud yet");
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("so it is removed right away");
      await dialog.getByRole("button", { name: "Uninstall", exact: true }).click();
    }
    /** Home, loaded, without the removed app (the account's app list was re-read). */
    async function expectHomeWithoutRemovedApp(page: Page): Promise<void> {
      await expect(page).toHaveURL(/\/$/u);
      await expect(page.getByTestId("app-page")).toHaveCount(0);
      await expect(page.getByRole("region", { name: "First app" })).toBeVisible();
      await expect(page.locator(`[data-testid="home-app"][data-capsule-id="${capId}"]`)).toHaveCount(0);
    }
    test("uninstalling a never-applied app removes it at once and returns home", async ({ page }) => {
      const f = await detailFixture(page, base);
      await uninstallNeverApplied(page);
      // The removal is immediate, so the page must not stay on the removed app
      // with its old content and an enabled Uninstall button, and Home must
      // not list it from the app list the page had just read.
      await expectHomeWithoutRemovedApp(page);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
    });
    test("a removal whose answer is lost re-reads the app and still returns home", async ({ page }) => {
      const f = await detailFixture(page, base); f.loseRemovalAnswer();
      await uninstallNeverApplied(page);
      // The server committed the removal; the page re-reads the app instead of
      // keeping the removed app's old content on screen.
      await expectHomeWithoutRemovedApp(page);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
    });
    test("uninstall confirmation does not claim retired app dependencies", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.goto(`/new?capsule=${capId}`);
      const section = await openUninstall(page);
      await expect(section).not.toContainText("Linked apps");
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("dialog")).not.toContainText("Dependent app");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
    });
  });
}
