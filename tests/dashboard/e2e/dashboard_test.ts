import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import { registerInstallDetailCases } from "./install_detail_case.ts";
import { registerAppPageCases } from "./app_page_case.ts";
import {
  expect,
  request as apiRequest,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createInstallAttemptFixture,
  PORTABLE_CAPSULES,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
  PORTABLE_SOURCE_COMMIT,
  type InstallAttemptFixture,
  type InstallAttemptFixtureConnection,
  type InstallAttemptFixtureOptions,
} from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import { resolvePortableOrigin } from "./portable-origin.ts";
import {
  shouldRecordControlPlaneMutation,
  type DashboardE2EMode,
} from "./traffic-policy.ts";
import { validateExpectedWorkerVersionId } from "../../../scripts/dashboard-browser-e2e/live-inputs.ts";
import { assertExpectedResponseUrl } from "../../../scripts/dashboard-browser-e2e/version-contract.ts";
import { registerInstallAuthReturnCase } from "./install_auth_return_case.ts";
import { registerNavigationAccountCases } from "./navigation_account_case.ts";

type Expectations = {
  readonly workspaceName: string;
  readonly switchWorkspaceName: string;
  readonly appName: string;
  readonly appUrl: string;
};

const rawMode = process.env.TAKOSUMI_E2E_MODE ?? "portable";
if (rawMode !== "portable" && rawMode !== "live" && rawMode !== "public-live") {
  throw new Error(
    "TAKOSUMI_E2E_MODE must be portable, live, or public-live",
  );
}
const mode: DashboardE2EMode = rawMode;
registerInstallAuthReturnCase(mode);
registerNavigationAccountCases(mode);

const expectedWorkerVersionId =
  mode === "live" || mode === "public-live"
    ? validateExpectedWorkerVersionId(
        process.env.TAKOSUMI_E2E_EXPECTED_WORKER_VERSION_ID ?? "",
      )
    : undefined;

function requiredLive(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`live dashboard E2E requires ${name}`);
  return value;
}

const mutationOrigin =
  mode === "portable"
    ? resolvePortableOrigin()
    : (process.env.TAKOSUMI_E2E_BASE_URL?.trim() ?? "");

const expectations: Expectations =
  mode === "portable"
    ? PORTABLE_EXPECTATIONS
    : mode === "live"
      ? {
          workspaceName: requiredLive("TAKOSUMI_E2E_WORKSPACE_NAME"),
          switchWorkspaceName: requiredLive(
            "TAKOSUMI_E2E_SWITCH_WORKSPACE_NAME",
          ),
          appName: requiredLive("TAKOSUMI_E2E_APP_NAME"),
          appUrl: requiredLive("TAKOSUMI_E2E_APP_URL"),
        }
      : {
          workspaceName: "",
          switchWorkspaceName: "",
          appName: "",
          appUrl: "",
        };

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

async function assertNoPageErrors(errors: readonly string[]): Promise<void> {
  expect(errors, "dashboard page raised a browser runtime error").toEqual([]);
}

const EMPTY_API_STORAGE_STATE = { cookies: [], origins: [] };
const PUBLIC_LIVE_BOOTSTRAP_REQUEST_PATH = "/api/v1/dashboard/bootstrap";

type PublicLiveBootstrapResponseFailure =
  | "upstream"
  | "url"
  | "method"
  | "status"
  | "content_type"
  | "worker_version"
  | "body"
  | "dispose"
  | "forward"
  | "abort";

async function publicLiveBootstrapResponseFailure(
  response: Awaited<ReturnType<Route["fetch"]>>,
  expectedUrl: string,
  expectedWorkerVersionId: string,
): Promise<PublicLiveBootstrapResponseFailure | undefined> {
  try {
    assertExpectedResponseUrl({
      route: "public-live dashboard bootstrap",
      expectedUrl,
      observedUrl: response.url(),
    });
  } catch {
    return "url";
  }
  if (response.status() !== 401) return "status";

  const headers = response.headers();
  if (!/^application\/json(?:;|$)/u.test(headers["content-type"] ?? "")) {
    return "content_type";
  }
  if (headers["x-takosumi-version-id"]?.trim() !== expectedWorkerVersionId) {
    return "worker_version";
  }

  try {
    const body = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      !("error" in body) ||
      body.error !== "invalid_token"
    ) {
      return "body";
    }
  } catch {
    return "body";
  }
  return undefined;
}

async function abortPublicLiveBootstrapRoute(
  route: Route,
  failures: PublicLiveBootstrapResponseFailure[],
): Promise<void> {
  try {
    await route.abort("blockedbyresponse");
  } catch {
    failures.push("abort");
  }
}

async function handlePublicLiveBootstrapRoute(
  route: Route,
  expectedOrigin: string,
  expectedWorkerVersionId: string,
  failures: PublicLiveBootstrapResponseFailure[],
  verifiedRequestUrls: string[],
): Promise<boolean> {
  const request = route.request();
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url());
  } catch {
    return false;
  }
  if (
    request.method() !== "GET" ||
    requestUrl.origin !== expectedOrigin ||
    requestUrl.pathname !== PUBLIC_LIVE_BOOTSTRAP_REQUEST_PATH
  ) {
    return false;
  }

  let response: Awaited<ReturnType<Route["fetch"]>>;
  try {
    response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
  } catch {
    failures.push("upstream");
    await abortPublicLiveBootstrapRoute(route, failures);
    return true;
  }

  const failure = await publicLiveBootstrapResponseFailure(
    response,
    request.url(),
    expectedWorkerVersionId,
  );
  if (failure) {
    failures.push(failure);
    try {
      await response.dispose();
    } catch {
      failures.push("dispose");
    }
    await abortPublicLiveBootstrapRoute(route, failures);
    return true;
  }

  try {
    await route.fulfill({ response });
    verifiedRequestUrls.push(request.url());
  } catch {
    failures.push("forward");
    await abortPublicLiveBootstrapRoute(route, failures);
  }
  return true;
}

function routePath(value: string): string {
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

async function gotoDashboardDocument(
  page: Page,
  path: string,
  expectedPagePath = path,
): Promise<void> {
  const requestedUrl = new URL(path, mutationOrigin);
  const expectedPageUrl = new URL(expectedPagePath, requestedUrl.origin);
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} must return a top-level document`).not.toBeNull();
  if (!response) return;
  expect(
    response.request().redirectedFrom(),
    `${path} must not redirect`,
  ).toBeNull();
  assertExpectedResponseUrl({
    route: path,
    expectedUrl: requestedUrl.toString(),
    observedUrl: response.url(),
  });
  expect(response.status(), path).toBe(200);
  expect(response.headers()["content-type"], path).toMatch(/text\/html/u);
  await expect
    .poll(() => page.url(), `${path} must finish on the expected SPA route`)
    .toBe(expectedPageUrl.toString());
  expect(routePath(page.url()), path).toBe(
    routePath(expectedPageUrl.toString()),
  );
}

/**
 * Public-live only: a signed-out document must be served directly, then the
 * SPA must preserve the requested deep link in its expected sign-in return.
 * This distinguishes an intentional client route from an HTTP redirect.
 */
async function gotoPublicDocument(
  page: Page,
  path: string,
  expectedReturnPath = path,
): Promise<void> {
  const requestedUrl = new URL(path, mutationOrigin);
  const expectedReturn = encodeURIComponent(expectedReturnPath);
  const expectedPageUrl = new URL(
    `/sign-in?return=${expectedReturn}`,
    requestedUrl.origin,
  );
  const response = await page.goto(path, { waitUntil: "domcontentloaded" });
  expect(response, `${path} must return a top-level document`).not.toBeNull();
  if (!response) return;
  expect(
    response.request().redirectedFrom(),
    `${path} must not HTTP redirect`,
  ).toBeNull();
  assertExpectedResponseUrl({
    route: path,
    expectedUrl: requestedUrl.toString(),
    observedUrl: response.url(),
  });
  expect(response.status(), path).toBe(200);
  expect(response.headers()["content-type"], path).toMatch(
    /^text\/html(?:;|$)/u,
  );
  await expect
    .poll(() => page.url(), `${path} must preserve its sign-in return`)
    .toBe(expectedPageUrl.toString());
}

async function fetchLiveEndpoint(
  page: Page,
  traffic: ReturnType<typeof monitorDashboardTraffic>,
  path: string,
  expectedStatus: number,
): Promise<{
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
  readonly url: string;
}> {
  const pageUrl = new URL(page.url());
  const requestedUrl = new URL(path, pageUrl);
  expect(requestedUrl.origin, path).toBe(pageUrl.origin);
  const context = await apiRequest.newContext({
    baseURL: requestedUrl.origin,
    storageState: EMPTY_API_STORAGE_STATE,
    maxRedirects: 0,
  });
  try {
    const response = await context.get(requestedUrl.toString(), {
      headers: {
        accept: "application/json",
      },
      maxRedirects: 0,
    });
    assertExpectedResponseUrl({
      route: path,
      expectedUrl: requestedUrl.toString(),
      observedUrl: response.url(),
    });
    expect(response.status(), path).toBe(expectedStatus);
    const headers = response.headers();
    expect(headers["content-type"], `${path} must return JSON`).toMatch(
      /^application\/json(?:;|$)/u,
    );
    traffic.recordVersionedResponse(path, response.status(), headers);
    return {
      body: await response.json(),
      headers,
      status: response.status(),
      url: response.url(),
    };
  } finally {
    await context.dispose();
  }
}

async function expectInsideViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} must have a visible bounding box`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, "browser viewport must be available").not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x, `${label} must not extend left of the viewport`).toBeGreaterThanOrEqual(0);
  expect(
    box.x + box.width,
    `${label} must not extend right of the viewport`,
  ).toBeLessThanOrEqual(viewport.width);
}

function workspaceTrigger(page: Page) {
  return page
    .getByRole("button", { name: /スペースを切り替え|Switch workspace/u })
    .first();
}

interface ProviderDestinationFixtureState {
  readonly mutations: string[];
  /** The scripted install-plan coordinator behind the install page. */
  readonly attempts: InstallAttemptFixture;
  /** The confirming answer (`continue: true`), once the page sent it. */
  readonly continued: () => {
    readonly variables?: Readonly<Record<string, unknown>>;
    readonly capsuleName?: string;
  } | undefined;
}

interface ProviderDestinationFixtureCoordinates {
  /** Resource types the analysis previews before any Plan. */
  readonly resources?: readonly { readonly type: string; readonly count?: number; readonly allowed: boolean }[];
  readonly variables?: InstallAttemptFixtureOptions["variables"];
}

/**
 * One app behind the scripted install-plan coordinator: Install starts an
 * attempt, the sheet answers it, Review confirms it and its Plan Run
 * (`run_provider_plan_e2e`) is the review. Nothing applies before the
 * review's explicit click.
 */
async function stubProviderDestinationFixture(
  page: Page,
  providerConnections: readonly InstallAttemptFixtureConnection[] = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  compatibilityProviders: readonly Record<string, unknown>[] = [
    {
      source: "registry.opentofu.org/cloudflare/cloudflare",
      moduleLocalName: "cloudflare",
      allowed: true,
      credentialRequired: true,
    },
  ],
  coordinates: ProviderDestinationFixtureCoordinates = {},
): Promise<ProviderDestinationFixtureState> {
  const planRunId = "run_provider_plan_e2e";
  const attempts = createInstallAttemptFixture({
    capsuleId: "cap_provider_destination_e2e",
    planRunId,
    resources: coordinates.resources ?? [],
    requirements: compatibilityProviders
      .filter((provider) => provider.credentialRequired === true && typeof provider.source === "string")
      .map((provider) => ({
        provider: provider.source as string,
        moduleLocalName: String(provider.moduleLocalName ?? ""),
        ...(typeof provider.childAlias === "string" ? { childAlias: provider.childAlias } : {}),
      })),
    connections: () => providerConnections,
    variables: coordinates.variables ?? [],
  });
  const state: ProviderDestinationFixtureState = {
    mutations: [],
    attempts,
    continued: () => attempts.log.answers.find((answer) =>
      (answer as { continue?: boolean } | undefined)?.continue === true
    ) as ReturnType<ProviderDestinationFixtureState["continued"]>,
  };
  // Whatever route answers it, an Apply posted for the reviewed Plan makes
  // the app's own view report it applied.
  let applied = false;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/v1/runs/${planRunId}/apply`) {
      applied = true;
    }
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") {
      state.mutations.push(`${request.method()} ${path}`);
    }
    const attempt = attempts.handle({
      method: request.method(),
      path,
      search: url.search,
      body: request.postData() ? request.postDataJSON() : undefined,
      idempotencyKey: request.headers()["idempotency-key"],
    });
    if (attempt) return route.fulfill({ status: attempt.status, json: attempt.json });
    if (path === "/api/v1/credential-recipes") return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES } });
    if (path === "/api/v1/connections" && request.method() === "GET") return route.fulfill({ json: { connections: providerConnections.filter((c) => c.scope === "workspace") } });
    if (path === "/api/v1/provider-connections") {
      return route.fulfill({ json: { providerConnections } });
    }
    if (path === "/api/v1/capsules/cap_provider_destination_e2e/runs") return route.fulfill({ json: { runs: [] } });
    if (path === "/api/v1/workspaces/ws_alpha/source-ref-resolutions/stable-semver" && request.method() === "POST") {
      return route.fulfill({ json: { tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT } });
    }
    // The installed app's own reads (`/app`, `/runs`) once an install
    // finishes: installed, with no screen unless a case adds one.
    if (path === "/api/v1/capsules/cap_provider_destination_e2e/app") return route.fulfill({ json: { app: {
      kind: "takosumi.capsule-app@v1", capsuleId: "cap_provider_destination_e2e", workspaceId: "ws_alpha",
      projectId: "prj_alpha", name: "cloudflare-service", environment: "production",
      // Not applied until the review's Allow and install posted its Apply.
      status: applied ? "active" : "pending", applied,
      state: applied ? "installed" : "installing", primaryAction: applied ? "view_resources" : "review", problems: [], screens: [],
      version: { updateAvailable: false, stale: false, autoUpdate: false },
      progress: { revisionPreparing: false }, uninstall: { mode: "scheduled", graceDays: 7 },
      observedAt: "2026-08-01T00:00:00Z",
    } } });
    if (path === "/api/v1/capsules/cap_provider_destination_e2e") return route.fulfill({ json: { capsule: {
      id: "cap_provider_destination_e2e", workspaceId: "ws_alpha", sourceId: "src_provider_destination_e2e",
      installConfigId: "cfg-default-opentofu-capsule", name: "cloudflare-service", slug: "cloudflare-service",
      environment: "production", currentStateGeneration: 1,
      currentStateVersionId: "sv_provider_apply_e2e", status: "active",
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    }, installConfigReAdoption: { authorityGuard: `sha256:${"d".repeat(64)}` } } });
    if (path === "/api/v1/capsule-configs/cfg-default-opentofu-capsule") {
      return route.fulfill({
        json: {
          installConfig: {
            id: "cfg-default-opentofu-capsule",
            name: "default-opentofu-capsule",
            policy: {},
            variableMapping: {},
            variablePresentation: [],
            outputAllowlist: {},
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    }
    if (path === `/api/v1/runs/${planRunId}`) {
      return route.fulfill({
        json: {
          run: {
            id: planRunId,
            workspaceId: "ws_alpha",
            capsuleId: "cap_provider_destination_e2e",
            type: "plan",
            status: "succeeded",
            summary: { add: 1, change: 0, destroy: 0 },
            requiresApproval: true,
            policyStatus: "pass",
            createdBy: "portable-e2e",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    }
    if (path === `/api/v1/runs/${planRunId}/stream`) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    }
    if (path === `/api/v1/runs/${planRunId}/cost`) {
      // Billing is disabled in this Workspace: the review explains provider
      // pricing instead of showing a rated $0.00 estimate.
      return route.fulfill({
        json: {
          cost: {
            runId: planRunId,
            billingMode: "disabled",
            estimatedUsdMicros: 0,
            ratingStatus: "not_applicable",
            blocked: false,
            reasons: [],
          },
        },
      });
    }
    return route.fallback();
  });
  return state;
}

/** The install sheet's own actions (Review / Connect, Stop installing). */
function installSheetActions(page: Page) {
  return page.getByTestId("install-configuration").locator(":scope > .iv-action-row");
}

/** Provider rows in the install sheet's connection block. */
function installConnectionRows(page: Page) {
  return page.getByTestId("install-connections").getByTestId("install-required-connection");
}

/**
 * Press the app page's one Install button and wait for the install sheet. A
 * sheet whose only required field is the app name and whose connections are
 * ready goes straight to Review, which creates the Plan; it never applies it.
 */
async function prepareInlineFixture(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^(Install|インストール)$/u }).click();
  await expect.poll(async () =>
    await page.getByTestId("install-configuration").isVisible() ||
    await page.getByTestId("install-module-chooser").isVisible() ||
    await page.locator(".iv-error, .iv-compat-warning").count() > 0,
  ).toBe(true);
  const config = page.getByTestId("install-configuration");
  if (!await config.isVisible()) return;
  if (await config.getAttribute("data-install-state") === "ready" &&
    await config.locator(".iv-sheet-block > .iv-fields").locator("input, select, textarea").count() === 1) {
    await reviewInlineFixture(page);
  }
}

/** Review creates the install Plan. Nothing is applied until Allow and install. */
async function reviewInlineFixture(page: Page): Promise<void> {
  await installSheetActions(page).getByRole("button", { name: /^(Review|内容を確認)$/u }).click();
}

type ReadinessRouteHandler = (route: Route) => Promise<void>;

interface ReadinessBrowserFixture {
  readonly applyPosts: string[];
  readonly readinessRequests: string[];
  readonly startApply: () => Promise<string>;
}

/** Drive the real InstallExecution route with synthetic external API replies. */
async function startReadinessBrowserFixture(
  page: Page,
  onReadinessRead: ReadinessRouteHandler,
  onActivityRead?: ReadinessRouteHandler,
): Promise<ReadinessBrowserFixture> {
  const applyPosts: string[] = [];
  const readinessRequests: string[] = [];
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  await stubProviderDestinationFixture(page, [], []);
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (
      path === "/api/v1/runs/run_provider_plan_e2e/apply" &&
      request.method() === "POST"
    ) {
      applyPosts.push(path);
      return route.fulfill({ json: { run: {
        id: "run_provider_apply_e2e",
        workspaceId: "ws_alpha",
        capsuleId: "cap_provider_destination_e2e",
        type: "apply",
        status: "succeeded",
        createdBy: "portable-e2e",
        createdAt: "2026-08-01T00:00:00.000Z",
      } } });
    }
    if (path === "/api/v1/runs/run_provider_apply_e2e") {
      return route.fulfill({ json: { run: {
        id: "run_provider_apply_e2e",
        workspaceId: "ws_alpha",
        capsuleId: "cap_provider_destination_e2e",
        type: "apply",
        status: "succeeded",
        createdBy: "portable-e2e",
        createdAt: "2026-08-01T00:00:00.000Z",
      } } });
    }
    if (path === "/api/v1/runs/run_provider_apply_e2e/stream") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "",
      });
    }
    if (path === "/api/v1/capsules/cap_provider_destination_e2e/state-versions") {
      readinessRequests.push(`${request.method()} ${path}`);
      return onReadinessRead(route);
    }
    if (path === "/api/v1/workspaces/ws_alpha/activity") {
      if (onActivityRead) {
        return onActivityRead(route);
      }
      return route.fulfill({ json: { events: [] } });
    }
    return route.fallback();
  });
  return {
    applyPosts,
    readinessRequests,
    startApply: async () => {
      await page.goto(
        `/new?git=${encodeURIComponent("https://github.com/example/cloudflare-service.git")}` +
          `&ref=${PORTABLE_SOURCE_COMMIT}&path=.&name=cloudflare-service`,
        { waitUntil: "domcontentloaded" },
      );
      await prepareInlineFixture(page);
      await expect(page.locator(".iv-execution")).toBeVisible();
      const installUrl = new URL(page.url());
      const originatingInstallPath = `${installUrl.pathname}${installUrl.search}`;
      const allow = page
        .locator(".iv-execution")
        .getByRole("button", { name: "Allow and install", exact: true });
      await expect(allow).toBeVisible();
      // A reviewed Plan never applies on its own.
      expect(applyPosts).toEqual([]);
      const confirmation = page.getByRole("checkbox", { name: "I reviewed these changes" });
      if (await confirmation.isVisible()) await confirmation.check();
      await allow.click();
      await expect.poll(() => applyPosts.length).toBe(1);
      return originatingInstallPath;
    },
  };
}
test.describe("Takosumi dashboard browser surface", () => {
  test.skip(
    mode === "public-live",
    "public-live is an unauthenticated read-only profile",
  );

  for (const stalledAt of ["fetch", "body"] as const) {
    test(`Install review keeps one Run read in flight through ${stalledAt} stalls`, async ({ page }) => {
      test.skip(mode !== "portable", "synthetic install Run reads are portable-only");
      const errors = pageErrors(page);
      await page.clock.install();
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      await page.addInitScript((mode) => {
        const probe = { requests: 0, replyStatus: "" };
        (window as typeof window & { __installRunReadProbe?: typeof probe })
          .__installRunReadProbe = probe;
        const realFetch = window.fetch.bind(window);
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const target =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          const path = new URL(target, location.href).pathname;
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          if (path !== "/api/v1/runs/run_provider_plan_e2e" || method !== "GET") {
            return realFetch(input, init);
          }
          probe.requests += 1;
          if (probe.replyStatus) {
            return new Response(JSON.stringify({ run: {
              id: "run_provider_plan_e2e",
              workspaceId: "ws_alpha",
              capsuleId: "cap_provider_destination_e2e",
              type: "plan",
              status: probe.replyStatus,
              summary: { add: 1, change: 0, destroy: 0 },
              policyStatus: "pass",
              createdBy: "portable-e2e",
              createdAt: "2026-08-01T00:00:00.000Z",
            } }), { status: 200, headers: { "content-type": "application/json" } });
          }
          if (mode === "fetch") {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("fixture aborted", "AbortError")), { once: true });
            });
          }
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"run":'));
              init?.signal?.addEventListener("abort", () =>
                controller.error(new DOMException("fixture aborted", "AbortError")), { once: true });
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;
      }, stalledAt);
      await stubProviderDestinationFixture(page, [], []);

      await page.goto(
        `/new?git=${encodeURIComponent("https://github.com/example/cloudflare-service.git")}` +
          `&ref=${PORTABLE_SOURCE_COMMIT}&path=.&name=cloudflare-service`,
        { waitUntil: "domcontentloaded" },
      );
      await prepareInlineFixture(page);
      const readCount = () => page.evaluate(() =>
        (window as typeof window & { __installRunReadProbe?: { requests: number } })
          .__installRunReadProbe?.requests ?? 0);
      await expect.poll(readCount).toBe(1);

      await page.clock.runFor(9_100);
      expect(await readCount()).toBe(1);
      await page.clock.runFor(21_100);
      await expect(page.locator('.iv-execution [role="alert"]')).toContainText(
        "Couldn't load this run",
      );
      expect(await readCount()).toBe(1);

      await page.evaluate(() => {
        const probe = (window as typeof window & {
          __installRunReadProbe?: { replyStatus: string };
        }).__installRunReadProbe;
        if (probe) probe.replyStatus = "running";
      });
      await page.locator(".iv-execution").getByRole("button", { name: "Retry" }).click();
      await expect.poll(readCount).toBe(2);
      await page.clock.runFor(3_100);
      await expect.poll(readCount).toBe(3);
      await page.evaluate(() => {
        const probe = (window as typeof window & {
          __installRunReadProbe?: { replyStatus: string };
        }).__installRunReadProbe;
        if (probe) probe.replyStatus = "";
      });
      await page.clock.runFor(3_100);
      await expect.poll(readCount).toBe(4);
      await page.clock.runFor(9_100);
      expect(await readCount()).toBe(4);
      await page.evaluate(() => {
        const probe = (window as typeof window & {
          __installRunReadProbe?: { replyStatus: string };
        }).__installRunReadProbe;
        if (probe) probe.replyStatus = "succeeded";
      });
      await page.clock.runFor(24_100);
      await expect.poll(readCount).toBe(5);
      await page.clock.runFor(9_100);
      expect(await readCount()).toBe(5);
      await assertNoPageErrors(errors);
    });
  }

  test("readiness 401 follows sign-in return without reopening Apply", async ({ page }) => {
    test.skip(mode !== "portable", "synthetic readiness auth is portable-only");
    const errors = pageErrors(page);
    const fixture = await startReadinessBrowserFixture(page, async (route) =>
      route.fulfill({ status: 401, json: { error: "unauthorized" } }),
    );
    const originatingInstallPath = await fixture.startApply();

    await expect(page.locator(".sign-in-return-context")).toHaveCount(0);
    await expect(page).toHaveURL(/\/sign-in\?return=/u);
    expect(new URL(page.url()).searchParams.get("return")).toBe(
      originatingInstallPath,
    );
    await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
    await expect(page.locator(".iv-execution")).toHaveCount(0);
    expect(fixture.applyPosts).toHaveLength(1);
    expect(fixture.readinessRequests).toContain(
      "GET /api/v1/capsules/cap_provider_destination_e2e/state-versions",
    );
    await assertNoPageErrors(errors);
  });

  test("a signed-out install link keeps the chosen app through sign-in", async ({ browser, baseURL }) => {
    test.skip(mode !== "portable", "signed-out install return is portable-only");
    const context = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      const errors = pageErrors(page);
      const writes: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET" && request.method() !== "HEAD") {
          writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
        }
      });
      const git = "https://github.com/example/cloudflare-service.git";
      await page.goto(
        `/install?git=${encodeURIComponent(git)}&ref=${PORTABLE_SOURCE_COMMIT}` +
          "&path=.&name=cloudflare-service",
        { waitUntil: "domcontentloaded" },
      );

      // The public alias normalizes onto /new before authentication, so the
      // sign-in screen can show what the visitor is about to add.
      await expect(page).toHaveURL(/\/sign-in\?return=/u);
      const returnTo = new URL(page.url()).searchParams.get("return") ?? "";
      expect(returnTo.startsWith("/new?")).toBe(true);
      await expect(
        page.getByRole("heading", { name: "Sign in to continue installing" }),
      ).toBeVisible();
      await expect(page.locator(".sign-in-return-context")).toContainText(
        "cloudflare-service",
      );
      await expect(page.locator(".sign-in-return-context")).toContainText("App to install");

      await context.addCookies([
        {
          name: "takosumi_session",
          value: "portable-e2e",
          domain: new URL(baseURL!).hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await page.goto(returnTo, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/new\?/u);
      await expect(
        page.getByRole("heading", { level: 1, name: "cloudflare-service" }),
      ).toBeVisible();
      await expect(page.getByTestId("install-provenance")).toContainText(
        "github.com/example/cloudflare-service",
      );
      await expect(page.getByTestId("install-source-fields").locator("input").first()).toHaveValue(
        PORTABLE_SOURCE_COMMIT,
      );
      // Showing the context is read-only: nothing is registered or planned yet.
      expect(writes).toEqual([]);
      await assertNoPageErrors(errors);
    } finally {
      await context.close();
    }
  });

  test("unexpected readiness errors fail closed without showing Open", async ({ page }) => {
    test.skip(mode !== "portable", "synthetic readiness errors are portable-only");
    const errors = pageErrors(page);
    await page.addInitScript(() => {
      const fetchNative = window.fetch.bind(window);
      Object.defineProperty(window, "fetch", {
        configurable: true,
        value: (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).includes(
            "/capsules/cap_provider_destination_e2e/state-versions",
          )
            ? Promise.reject(
                new Error("synthetic unexpected readiness failure"),
              )
            : fetchNative(input, init),
      });
    });
    const fixture = await startReadinessBrowserFixture(page, async (route) =>
      route.fulfill({ json: { stateVersions: [] } }),
    );
    await fixture.startApply();

    // Fails closed at the page boundary: no Open, no readiness Retry — and
    // the rest of the dashboard (nav) stays usable instead of the whole app
    // being replaced by the root card.
    await expect(
      page.getByRole("heading", { name: "This page couldn't be shown" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
    await expect(
      page.locator(".sidebar-nav").getByRole("link", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(fixture.applyPosts).toHaveLength(1);
    expect(fixture.readinessRequests).toHaveLength(0);
    await assertNoPageErrors(errors);
  });

  test("readiness requests abort on navigation without stale failure or Open", async ({ page }) => {
    test.skip(mode !== "portable", "synthetic readiness cancellation is portable-only");
    const errors = pageErrors(page);
    let markReadsStarted!: () => void;
    const readsStarted = new Promise<void>((resolve) => {
      markReadsStarted = resolve;
    });
    let releaseInterceptions!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseInterceptions = resolve;
    });
    let heldReads = 0;
    const holdRead = async (route: Route) => {
      heldReads += 1;
      if (heldReads === 2) markReadsStarted();
      await releaseSignal;
      await route.abort("failed").catch(() => undefined);
    };
    const failedReadErrors = new Map<string, string | undefined>();
    const failedReads = new Promise<void>((resolve) => {
      page.on("requestfailed", (request) => {
        const path = new URL(request.url()).pathname;
        if (
          path === "/api/v1/capsules/cap_provider_destination_e2e/state-versions" ||
          path === "/api/v1/workspaces/ws_alpha/activity"
        ) {
          failedReadErrors.set(path, request.failure()?.errorText);
          if (failedReadErrors.size === 2) resolve();
        }
      });
    });
    const fixture = await startReadinessBrowserFixture(page, holdRead, holdRead);
    await fixture.startApply();
    await readsStarted;
    await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);

    await page.locator('a[href="/account"]').first().click();
    await expect(page).toHaveURL(/\/account$/u);
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await failedReads;
    releaseInterceptions();
    expect([...failedReadErrors.keys()].sort()).toEqual(
      [
        "/api/v1/capsules/cap_provider_destination_e2e/state-versions",
        "/api/v1/workspaces/ws_alpha/activity",
      ].sort(),
    );
    for (const failure of failedReadErrors.values()) {
      expect(failure).toMatch(/ERR_ABORTED/u);
    }

    await expect(page.locator(".iv-execution")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
    expect(fixture.applyPosts).toHaveLength(1);
    await assertNoPageErrors(errors);
  });
  test("Store install waits for apply-linked readiness before opening", async ({ page }) => {
    test.skip(mode !== "portable", "synthetic install lifecycle is portable-only");
    const errors = pageErrors(page);
    const requests: string[] = [];
    const applyPosts: string[] = [];
    let readinessReadFailures = 3;
    let activationAction = "release_activation.pending";
    page.on("request", (request) => {
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.origin}${url.pathname}${url.search}`);
    });
    await page.addInitScript(() => {
      localStorage.setItem("tg_lang", "en");
      localStorage.setItem("tcs.stores", JSON.stringify(["https://store.example.test"]));
    });
    await page.route("https://store.example.test/tcs/v2/listings**", async (route) => {
      await route.fulfill({ json: { items: [
        {
          id: "fixtures/noise-service",
          source: { git: "https://github.com/example/noise-service.git" },
          suggestedName: "noise-service",
          name: { ja: "Noise Service", en: "Noise Service" },
          description: { ja: "Not the selected fixture.", en: "Not the selected fixture." },
          badge: { ja: "Add", en: "Add" },
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        },
        {
          id: "fixtures/readiness-service",
          source: { git: "https://github.com/example/cloudflare-service.git" },
          suggestedName: "readiness-service",
          name: { ja: "Readiness Service", en: "Readiness Service" },
          description: { ja: "Synthetic fixture: input and activation gated.", en: "Synthetic fixture: input and activation gated." },
          badge: { ja: "Add", en: "Add" },
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        },
      ] } });
    });
    const install = await stubProviderDestinationFixture(page, undefined, undefined, {
      variables: [{ name: "region", type: "string", required: true, sensitive: false, label: { en: "Region", ja: "Region" } }],
    });
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/capsule-configs/cfg-default-opentofu-capsule") {
        return route.fulfill({ json: { installConfig: {
          id: "cfg-default-opentofu-capsule",
          name: "readiness-service",
          policy: {},
          variableMapping: {},
          variablePresentation: [{
            name: "region", type: "string", required: true,
            label: { en: "Region", ja: "Region" }, defaultValue: "fixture-default",
          }],
          outputAllowlist: {},
          interfaceBlueprints: [{
            key: "launcher", name: "app.launcher",
            spec: {
              type: "interface.ui.surface", version: "1",
              document: { launcher: true, display: { title: "Synthetic readiness service" } },
              inputs: { url: { source: "capsule_output", capsuleId: "cap_provider_destination_e2e", outputName: "url" } },
              access: { visibility: "workspace" },
            },
            bindings: [{ key: "launcher.installer", subject: { source: "installing_principal" }, permissions: ["ui.open"], delivery: { type: "none" } }],
          }],
          createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
        } } });
      }
      if (path === "/api/v1/runs/run_provider_plan_e2e") {
        return route.fulfill({ json: { run: {
          id: "run_provider_plan_e2e", workspaceId: "ws_alpha",
          capsuleId: "cap_provider_destination_e2e", type: "plan", status: "succeeded",
          summary: { add: 1, change: 0, destroy: 1 }, policyStatus: "pass",
          requiresApproval: false, createdBy: "portable-e2e", createdAt: "2026-08-01T00:00:00.000Z",
        } } });
      }
      if (path === "/api/v1/runs/run_provider_plan_e2e/apply" && request.method() === "POST") {
        applyPosts.push(path);
        return route.fulfill({ json: { run: {
          id: "run_provider_apply_e2e", workspaceId: "ws_alpha",
          capsuleId: "cap_provider_destination_e2e", type: "apply", status: "succeeded",
          createdBy: "portable-e2e", createdAt: "2026-08-01T00:00:00.000Z",
        } } });
      }
      if (path === "/api/v1/runs/run_provider_apply_e2e") {
        return route.fulfill({ json: { run: {
          id: "run_provider_apply_e2e", workspaceId: "ws_alpha",
          capsuleId: "cap_provider_destination_e2e", type: "apply", status: "succeeded",
          createdBy: "portable-e2e", createdAt: "2026-08-01T00:00:00.000Z",
        } } });
      }
      if (path === "/api/v1/runs/run_provider_apply_e2e/stream") {
        return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
      }
      if (path === "/api/v1/capsules/cap_provider_destination_e2e/state-versions") {
        if (readinessReadFailures > 0) {
          readinessReadFailures -= 1;
          return route.fulfill({ status: 503, json: { error: "synthetic_readback_unavailable" } });
        }
        return route.fulfill({ json: { stateVersions: [{
          id: "sv_provider_apply_e2e", workspaceId: "ws_alpha",
          capsuleId: "cap_provider_destination_e2e", environment: "production",
          generation: 1, createdByRunId: "run_provider_apply_e2e",
          createdAt: "2026-08-01T00:00:00.000Z",
        }] } });
      }
      if (path === "/api/v1/workspaces/ws_alpha/activity") {
        return route.fulfill({ json: { events: [{
          id: "activity_provider_activation_e2e", workspaceId: "ws_alpha",
          action: activationAction, targetType: "Capsule", targetId: "cap_provider_destination_e2e",
          runId: "run_provider_apply_e2e",
          metadata: { applyRunId: "run_provider_apply_e2e", stateVersionId: "sv_provider_apply_e2e", capsuleId: "cap_provider_destination_e2e" },
          createdAt: activationAction === "release_activation.succeeded" ? "2026-08-01T00:00:02.000Z" : "2026-08-01T00:00:01.000Z",
        }] } });
      }
      if (path === "/api/v1/capsules/cap_provider_destination_e2e/app" && applyPosts.length > 0) {
        // The installed app's page opens the screen the server lists.
        return route.fulfill({ json: { app: {
          kind: "takosumi.capsule-app@v1", capsuleId: "cap_provider_destination_e2e", workspaceId: "ws_alpha",
          projectId: "prj_alpha", name: "readiness-service", environment: "production", status: "active",
          applied: true, state: "installed", primaryAction: "open", problems: [],
          screens: [{ interfaceId: "if_provider_readiness_e2e", name: "app.launcher", title: "Synthetic readiness service", url: "https://service.example.test/fixture" }],
          version: { updateAvailable: false, stale: false, autoUpdate: false },
          progress: { revisionPreparing: false }, uninstall: { mode: "scheduled", graceDays: 7 },
          observedAt: "2026-08-01T00:00:00.000Z",
        } } });
      }
      if (path === "/api/v1/workspaces/ws_alpha/ui-surfaces") {
        return route.fulfill({ json: { interfaces: [{
          apiVersion: "takosumi.dev/v1alpha1", kind: "Interface",
          metadata: {
            id: "if_provider_readiness_e2e", workspaceId: "ws_alpha", name: "app.launcher",
            ownerRef: { kind: "Capsule", id: "cap_provider_destination_e2e" }, generation: 1,
            createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
          },
          spec: {
            type: "interface.ui.surface", version: "1",
            document: { launcher: true, display: { title: "Synthetic readiness service" } },
            inputs: { url: { source: "capsule_output", capsuleId: "cap_provider_destination_e2e", outputName: "url" } },
            access: { visibility: "workspace" },
          },
          status: { phase: "Resolved", observedGeneration: 1, resolvedRevision: 1, resolvedInputs: { url: "https://service.example.test/fixture" } },
        }] } });
      }
      return route.fallback();
    });
    await page.context().route("https://service.example.test/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<main>Synthetic app fixture</main>" });
    });

    await page.goto("/new", { waitUntil: "domcontentloaded" });
    const search = page.getByRole("searchbox", { name: "Search services…" });
    await expect(search).toBeVisible();
    await search.fill("Readiness");
    await expect(page.getByRole("heading", { name: "Readiness Service" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Noise Service" })).toHaveCount(0);
    await page.getByRole("button", { name: "Readiness Service", exact: true }).click();
    await expect(page.getByTestId("install-app-header")).toContainText("Synthetic fixture: input and activation gated.");
    await prepareInlineFixture(page);
    const sheet = page.getByTestId("install-configuration");
    await expect(sheet.getByRole("heading", { name: "Cloud connection" })).toBeVisible();
    // Two candidates: the row asks for a choice and Review waits for it.
    await expect(sheet).toHaveAttribute("data-install-state", "provider-required");
    await expect(installSheetActions(page).getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await sheet.getByRole("combobox", { name: "Host / account" }).selectOption("pc_takosumi_cloud");
    await expect(installConnectionRows(page)).toHaveAttribute("data-connection-state", "connected");
    await expect(sheet.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.getByLabel("Region").fill("us-west-2");
    await reviewInlineFixture(page);
    await expect(page.getByRole("heading", { name: "What this app will create in your cloud" })).toBeVisible();
    const addButton = page.getByRole("button", { name: "Allow and install", exact: true });
    await expect(addButton).toBeDisabled();
    // The connection choice is an answer; the setting travels only with Review.
    expect(install.attempts.log.answers).toContainEqual(expect.objectContaining({
      providerBindings: [expect.objectContaining({
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        connectionId: "pc_takosumi_cloud",
      })],
    }));
    expect(install.continued()).toMatchObject({ continue: true, variables: { region: "us-west-2" } });
    // A Store listing installs its newest released version unless one is chosen.
    expect(install.attempts.log.creates).toEqual([expect.objectContaining({
      source: {
        url: expect.stringMatching(/^https:\/\/github\.com\/example\/cloudflare-service(?:\.git)?$/u),
        ref: PORTABLE_SOURCE_COMMIT,
      },
    })]);

    // Billing is disabled here: provider pricing is explained, never "$0.00".
    await expect(page.getByTestId("install-plan-cost")).toContainText("Takosumi doesn't calculate costs in this workspace.");
    await expect(page.locator("body")).not.toContainText("$0.00");

    await page.getByRole("checkbox", { name: "I reviewed these changes" }).check();
    await expect(addButton).toBeEnabled();
    await addButton.click();
    await expect.poll(() => applyPosts.length).toBe(1);
    await assertNoPageErrors(errors);
    await expect(page.getByRole("alert")).toContainText(/readiness could not be checked/u);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Technical details" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Waiting for the app's launch link to become available.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
    activationAction = "release_activation.succeeded";
    const openService = page.getByRole("link", { name: "Open", exact: true });
    await expect(openService).toBeVisible({ timeout: 15_000 });
    await expect(openService).toHaveAttribute("href", "https://service.example.test/fixture");
    expect(requests).toContain(`GET ${mutationOrigin}/api/v1/capsules/cap_provider_destination_e2e/state-versions`);
    expect(requests).toContain(`GET ${mutationOrigin}/api/v1/workspaces/ws_alpha/activity?limit=100`);
    expect(requests.filter((entry) => entry === `POST ${mutationOrigin}/api/v1/runs/run_provider_plan_e2e/apply`)).toHaveLength(1);

    const popupPromise = page.waitForEvent("popup");
    await openService.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://service.example.test/fixture");
    await expect(popup.getByText("Synthetic app fixture")).toBeVisible();
    await popup.close();
    await assertNoPageErrors(errors);
    // Every change the page made was an answer to its own install attempt.
    expect(requests.filter((entry) => entry.startsWith("PATCH ")).every((entry) =>
      entry.startsWith(`PATCH ${mutationOrigin}/api/v1/install-plans/gip_`))).toBe(true);
    expect(requests.every((entry) =>
      entry.startsWith(`GET ${mutationOrigin}/`) ||
      entry.startsWith(`POST ${mutationOrigin}/`) ||
      entry.startsWith(`PATCH ${mutationOrigin}/api/v1/install-plans/gip_`) ||
      entry.startsWith("GET https://store.example.test/") ||
      entry.startsWith("GET https://service.example.test/"),
    )).toBe(true);
  });

  for (const change of ["none", "review", "applied"] as const) {
    const title = change === "applied"
      ? "refuses a failed initial Plan retry when another Apply commits before the click"
      : change === "review"
      ? "refuses a failed initial Plan retry when its reviewed source changes before the click"
      : "retries a failed initial Plan with the same reviewed source without abandoning the Capsule";
    test(title, async ({ page }) => {
      test.skip(
        mode !== "portable",
        "the retained initial Plan fixture is portable-only",
      );
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const capsuleId = "cap_retry_initial";
      const oldRunId = "run_initial_failed";
      const nextRunId = "run_initial_retried";
      const compatibilityReportId = "report_initial_reviewed";
      let currentReportId = compatibilityReportId;
      let currentStateGeneration = 0;
      let currentStateVersionId: string | undefined;
      const mutations: { path: string; body: unknown }[] = [];
      const now = "2026-09-06T00:00:00.000Z";
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET") {
          mutations.push({ path, body: request.postDataJSON() });
        }
        if (path === `/api/v1/capsules/${capsuleId}`) {
          return route.fulfill({
            json: {
              capsule: {
                id: capsuleId,
                workspaceId: "ws_alpha",
                name: "Retained service",
                slug: "retained-service",
                sourceId: "source_retained",
                installConfigId: "config_retained",
                environment: "staging",
                currentStateGeneration,
                currentStateVersionId,
                status: "pending",
                compatibilityReportId: currentReportId,
                createdAt: now,
                updatedAt: now,
              },
            },
          });
        }
        if (path === `/api/v1/capsules/${capsuleId}/plan`) {
          return route.fulfill({
            status: 201,
            json: { run: { id: nextRunId } },
          });
        }
        const runId = [oldRunId, nextRunId].find((id) =>
          path.startsWith(`/api/v1/runs/${id}`)
        );
        if (runId && path === `/api/v1/runs/${runId}`) {
          return route.fulfill({
            json: {
              run: {
                id: runId,
                workspaceId: "ws_alpha",
                capsuleId,
                type: "plan",
                baseStateGeneration: 0,
                status: runId === oldRunId ? "failed" : "running",
                policyStatus: "pass",
                sourceSnapshotId: "snapshot_retained",
                compatibilityReportId,
                createdBy: "portable-e2e",
                createdAt: now,
              },
            },
          });
        }
        if (runId && path.endsWith("/logs")) {
          return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        }
        if (runId && path.endsWith("/cost")) {
          return route.fulfill({
            json: {
              cost: {
                runId,
                billingMode: "disabled",
                estimatedUsdMicros: 0,
                ratingStatus: "not_applicable",
                blocked: false,
                reasons: [],
              },
            },
          });
        }
        if (runId && path.endsWith("/stream")) {
          return route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: "",
          });
        }
        if (path === "/api/v1/workspaces/ws_alpha/runs") {
          return route.fulfill({ json: { runs: [] } });
        }
        return route.fallback();
      });
      await gotoDashboardDocument(page, `/runs/${oldRunId}`);
      const retry = page.getByRole("button", {
        name: /もう一度変更を確認|Review changes again/u,
      });
      await expect(retry).toBeVisible();
      await expect(page.getByRole("button", {
        name: /最新のソースで最初からやり直す|latest source/u,
      })).toBeVisible();
      if (change === "review") {
        currentReportId = "report_replaced_after_page_load";
      } else if (change === "applied") {
        currentStateGeneration = 1;
        currentStateVersionId = "state_committed_after_page_load";
      }
      await retry.click();
      if (change !== "none") {
        await expect(page.getByRole("alert")).toContainText(
          /確認結果が古くなりました|The check result is out of date/u,
        );
        await expect(page).toHaveURL(new RegExp(`/runs/${oldRunId}$`, "u"));
        expect(mutations).toEqual([]);
      } else {
        await expect(page).toHaveURL(new RegExp(`/runs/${nextRunId}$`, "u"));
        expect(mutations).toEqual([{
          path: `/api/v1/capsules/${capsuleId}/plan`,
          body: { compatibilityReportId },
        }]);
      }
      await assertNoPageErrors(errors);
      traffic.assertNoFailures();
    });
  }

  test("authenticates through dashboard bootstrap and switches Workspace scope", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const ordinaryPreflight = mode === "portable"
      ? page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === "/auth/oidc/session" && url.search === "";
        })
      : undefined;
    const bootstrap = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/dashboard/bootstrap" &&
        response.status() === 200
      );
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    if (ordinaryPreflight) {
      const response = await ordinaryPreflight;
      const headers = response.headers();
      expect(response.status()).toBe(404);
      expect(headers["content-type"]).toMatch(/^application\/json(?:;|$)/u);
      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["x-takosumi-shared-auth-absent"]).toBe("1");
      expect(await response.json()).toEqual({ error: "not_found" });
    }
    await expect((await bootstrap).status()).toBe(200);

    const trigger = workspaceTrigger(page);
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute(
      "aria-label",
      new RegExp(
        expectations.workspaceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      ),
    );

    await trigger.click();
    const menu = page.locator('[role="menu"]:visible').first();
    await expect(menu).toBeVisible();
    const workspaces = menu.getByRole("menuitemradio");
    if (mode === "portable") {
      await expect(workspaces).toHaveCount(3);
    } else {
      expect(await workspaces.count()).toBeGreaterThanOrEqual(2);
    }
    await workspaces
      .filter({ hasText: expectations.switchWorkspaceName })
      .first()
      .click();
    await expect(trigger).toHaveAttribute(
      "aria-label",
      new RegExp(
        expectations.switchWorkspaceName.replace(
          /[.*+?^${}()|[\]\\]/gu,
          "\\$&",
        ),
      ),
    );
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("live probes keep OIDC, unauthenticated API, and SPA documents on one Version", async ({
    page,
  }) => {
    test.skip(mode !== "live", "immutable Version probes are live-only");
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const mutations: string[] = [];
    page.on("request", (request) => {
      if (
        shouldRecordControlPlaneMutation(
          mode,
          mutationOrigin,
          request.url(),
          request.method(),
        )
      ) {
        mutations.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });

    await gotoDashboardDocument(page, "/");

    const discovery = await fetchLiveEndpoint(
      page,
      traffic,
      "/.well-known/openid-configuration",
      200,
    );
    const discoveryBody = discovery.body as {
      readonly issuer?: unknown;
      readonly jwks_uri?: unknown;
    };
    const origin = new URL(page.url()).origin;
    expect(discoveryBody.issuer).toBe(origin);
    expect(discoveryBody.jwks_uri).toBe(`${origin}/oauth/jwks`);

    const jwks = await fetchLiveEndpoint(page, traffic, "/oauth/jwks", 200);
    const jwksBody = jwks.body as { readonly keys?: unknown };
    expect(Array.isArray(jwksBody.keys)).toBe(true);
    expect((jwksBody.keys as readonly unknown[]).length).toBeGreaterThan(0);

    const unauthenticated = await fetchLiveEndpoint(
      page,
      traffic,
      "/api/v1/dashboard/bootstrap",
      401,
    );
    expect(unauthenticated.body).toMatchObject({
      error: "invalid_token",
    });

    for (const path of ["/account", "/connections", "/account/workspace", "/new"]) {
      await gotoDashboardDocument(page, path);
      await expect(page.locator("body")).not.toContainText("undefined.trim");
    }

    const installPath =
      "/install?git=https%3A%2F%2Fgithub.com%2Fexample%2Fservice.git" +
      "&ref=0123456789abcdef0123456789abcdef01234567&path=deploy%2Fopentofu";
    const installTargetPath =
      "/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Fservice.git" +
      "&ref=0123456789abcdef0123456789abcdef01234567&path=deploy%2Fopentofu";
    await gotoDashboardDocument(page, installPath, installTargetPath);
    // The link names the app and its version; opening it starts nothing.
    await expect(page.getByTestId("install-provenance")).toContainText(
      "github.com/example/service",
    );
    await expect(page.getByLabel(/^Version \(tag, branch or commit; optional\)|^版（tag・branch・commit。省略可）/u)).toHaveValue(
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(
      mutations,
      "live browser discovery and navigation must not mutate the control plane",
    ).toEqual([]);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
    expect(expectedWorkerVersionId).toMatch(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
    );
  });

  test("keeps the current workspace name visible on compact widths and disambiguates duplicates", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the duplicate-name Workspace fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    for (const width of [320, 390, 880]) {
      await page.setViewportSize({ width, height: 844 });
      const trigger = workspaceTrigger(page);
      await expect(trigger.locator(".workspace-switcher-name")).toContainText(
        PORTABLE_EXPECTATIONS.workspaceName,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
        `Workspace chrome must not overflow a ${width}px viewport`,
      ).toBeLessThanOrEqual(1);
    }

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const trigger = workspaceTrigger(page);
      await trigger.click();
      const menu = page.locator('[role="menu"]:visible').first();
      await expect(menu).toBeVisible();
      await expectInsideViewport(page, menu, `Workspace menu at ${width}px`);
      const duplicates = menu
        .getByRole("menuitemradio")
        .filter({ hasText: PORTABLE_EXPECTATIONS.workspaceName });
      await expect(duplicates).toHaveCount(2);
      await expect(
        duplicates.filter({ hasText: "@alpha" }).first(),
      ).toBeVisible();
      await expect(
        duplicates
          .filter({ hasText: `@${PORTABLE_EXPECTATIONS.duplicateWorkspaceHandle}` })
          .first(),
      ).toBeVisible();

      await menu
        .getByRole("menuitem", { name: /環境を分ける|Separate an environment/u })
        .click();
      const dialog = page.getByRole("dialog").first();
      const form = dialog.locator("form.workspace-create-form");
      const input = dialog.getByRole("textbox", {
        name: /環境の名前|Environment name/u,
      });
      await expect(dialog).toBeVisible();
      await expect(form).toBeVisible();
      await expect(input).toBeVisible();
      await expectInsideViewport(page, form, `Workspace create form at ${width}px`);
      await expectInsideViewport(page, input, `Workspace create input at ${width}px`);
      await expect(input).toHaveAttribute("required", "");
      await expect(input).toHaveAttribute(
        "aria-describedby",
        /workspace-switcher-compact-create-name-help/u,
      );
      await dialog
        .getByRole("button", { name: /キャンセル|Cancel/u })
        .click();
      await expect(page.locator('[role="menu"]:visible').first()).toBeVisible();
      await trigger.click();
      await expect(page.locator('[role="menu"]:visible')).toHaveCount(0);
    }

    await page.setViewportSize({ width: 880, height: 844 });
    const trigger = workspaceTrigger(page);
    await trigger.click();
    const menu = page.locator('[role="menu"]:visible').first();
    await expect(menu).toBeVisible();
    const duplicates = menu
      .getByRole("menuitemradio")
      .filter({ hasText: PORTABLE_EXPECTATIONS.workspaceName });
    await expect(duplicates).toHaveCount(2);
    await expect(
      duplicates.filter({ hasText: "@alpha" }).first(),
    ).toBeVisible();
    await expect(
      duplicates
        .filter({ hasText: `@${PORTABLE_EXPECTATIONS.duplicateWorkspaceHandle}` })
        .first(),
    ).toBeVisible();
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("renders the single Store install view on desktop and mobile", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    if (mode === "portable") {
      await page.addInitScript(() => {
        localStorage.setItem("tg_lang", "ja");
        localStorage.setItem("tcs.stores", JSON.stringify(["https://store.example.test"]));
      });
      await page.route("https://store.example.test/tcs/v2/listings?**", async (route) => {
        await route.fulfill({
          json: {
            items: [{
              id: "example/service",
              source: { git: "https://github.com/example/service.git" },
              suggestedName: "example-service",
              name: { ja: "Example Service", en: "Example Service" },
              description: { ja: "サービスの説明", en: "Service description" },
              badge: { ja: "追加", en: "Add" },
              createdAt: "2026-08-04T00:00:00.000Z",
              updatedAt: "2026-08-04T00:00:00.000Z",
            }],
          },
        });
      });
    }
    await page.setViewportSize({ width: 1180, height: 757 });
    await page.goto("/new", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /アプリをインストール|Install an app/u,
      }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: /アプリを探す|Find apps/u })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId("install-steps")).toHaveCount(0);
    const search = page.locator('input[name="storeSearch"]');
    await expect(search).toBeVisible();
    const searchBox = await search.boundingBox();
    expect(searchBox, "Store search must have a visible layout box").not.toBeNull();
    expect(searchBox!.y, "search belongs near the title at 1180 × 757").toBeLessThan(300);
    if (mode === "portable") {
      await expect(page.getByRole("heading", { name: "Example Service" })).toBeVisible();
    }
    await page.screenshot({ path: test.info().outputPath("new-1180.png") });
    await expect(page.locator("body")).not.toContainText("undefined.trim");
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(search).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
        `the install view must not overflow at ${width}px`,
      ).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 375, height: 844 });
    await page.screenshot({ path: test.info().outputPath("new-375.png") });
    const manual = page.locator("details.iv-manual");
    await expect(manual).not.toHaveAttribute("open");
    await manual.locator("summary").click();
    await expect(manual.getByRole("textbox", { name: /Git URL/u })).toBeVisible();
    if (mode === "portable") {
      await page.getByRole("button", { name: "Example Service", exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Example Service");
      await expect(page.getByRole("heading", { level: 2, name: "Example Service" })).toHaveCount(0);
      await expect(page.getByTestId("install-steps")).toHaveCount(0);
      // One primary Install plus "choose again"; no second form behind it.
      await expect(page.getByRole("button", { name: "インストール", exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "インストール", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "選び直す", exact: true })).toBeVisible();
      await expect(page.getByTestId("install-provenance")).toContainText("github.com/example/service");
      await expect(page.getByTestId("install-configuration")).toHaveCount(0);
      // A Store listing exposes only its version, shown plainly.
      await expect(page.getByTestId("install-start").locator("input")).toHaveCount(1);
      await expect(page.getByTestId("install-start").locator("input")).toBeVisible();
      await expect(page.getByTestId("install-start").locator("details")).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath("selected-375.png") });
      for (const width of [320, 375, 390, 414, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `the app page must not overflow at ${width}px`,
        ).toBeLessThanOrEqual(1);
      }
    }
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("shows the repository-owned installed app and its launch URL", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("home-app").filter({ hasText: expectations.appName }).first();
    await expect(card).toBeVisible();
    const app = card.getByRole("link", { name: `Open ${expectations.appName} in a new tab` });
    await expect(app).toHaveAttribute("href", expectations.appUrl);
    await expect(app).toHaveAttribute("target", "_blank");
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  // A failed read on one page must stay on that page: before the per-page
  // boundary and the throw-free resource reads, each of these replaced the
  // whole app — sidebar included — with the root "Something went wrong" card.
  const rootReloadCard = /Something went wrong|問題が発生しました/u;
  const homeLink = (page: Page) =>
    page
      .locator(".sidebar-nav")
      .getByRole("link", { name: /^(Home|ホーム)$/u });

  test("an unreadable run keeps the shell and shows its own recovery", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "synthetic run failures are portable-only");
    const errors = pageErrors(page);
    await page.route("**/api/v1/runs/run_broken_e2e", (route) =>
      route.fulfill({ status: 500, json: { error: "synthetic_failure" } }),
    );

    // The fixture answers unknown run ids with 404.
    await gotoDashboardDocument(page, "/runs/run_missing_e2e");
    await expect(
      page.getByRole("heading", {
        name: /This run was not found|この実行は見つかりませんでした/u,
      }),
    ).toBeVisible();
    await expect(homeLink(page)).toBeVisible();
    await expect(page.getByText(rootReloadCard)).toHaveCount(0);

    await gotoDashboardDocument(page, "/runs/run_broken_e2e");
    await expect(
      page.getByRole("heading", {
        name: /Couldn't load this run|実行を読み込めませんでした/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^(Retry|再試行)$/u }),
    ).toBeVisible();
    await expect(homeLink(page)).toBeVisible();
    await expect(page.getByText(rootReloadCard)).toHaveCount(0);
    await assertNoPageErrors(errors);
  });

  test("a failed run poll keeps the last good run and keeps polling", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "synthetic poll failures are portable-only");
    const errors = pageErrors(page);
    const runPath = "/api/v1/runs/run_poll_e2e";
    let runReads = 0;
    // A non-200 stream fails EventSource for good (no auto-reconnect), so the
    // 3s fallback poll alone drives updates — the path under test.
    await page.route(`**${runPath}/stream`, (route) =>
      route.fulfill({ status: 503, json: { error: "stream_unavailable" } }),
    );
    await page.route(`**${runPath}`, (route) => {
      runReads += 1;
      if (runReads === 2) {
        return route.fulfill({ status: 503, json: { error: "synthetic_blip" } });
      }
      return route.fulfill({
        json: {
          run: {
            id: "run_poll_e2e",
            workspaceId: "ws_alpha",
            capsuleId: "cap_poll_e2e",
            type: "plan",
            status: "running",
            createdBy: "portable-e2e",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    });
    const refreshFailed =
      /Couldn't fetch the latest status|最新の状態を取得できませんでした/u;

    await gotoDashboardDocument(page, "/runs/run_poll_e2e");
    // The 3s fallback poll hits the synthetic failure: the run stays on
    // screen with a quiet notice instead of the whole app going away.
    await expect(page.getByText(refreshFailed)).toBeVisible({ timeout: 10_000 });
    expect(runReads).toBe(2);
    await expect(
      page.getByRole("heading", {
        name: /Couldn't load this run|実行を読み込めませんでした/u,
      }),
    ).toHaveCount(0);
    await expect(page.getByText(rootReloadCard)).toHaveCount(0);
    await expect(homeLink(page)).toBeVisible();

    // Polling continues after the failure and the next good read clears it.
    await expect(page.getByText(refreshFailed)).toHaveCount(0, {
      timeout: 10_000,
    });
    expect(runReads).toBeGreaterThanOrEqual(3);
    await assertNoPageErrors(errors);
  });

  test("an unreadable service keeps the shell and shows not found", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "synthetic service failures are portable-only");
    const errors = pageErrors(page);
    await gotoDashboardDocument(page, "/workloads/cap_missing_e2e");
    await expect(
      page.getByRole("heading", {
        name: /App not found|アプリが見つかりません/u,
      }),
    ).toBeVisible();
    await expect(homeLink(page)).toBeVisible();
    await expect(page.getByText(rootReloadCard)).toHaveCount(0);
    await assertNoPageErrors(errors);
  });

  test("a page that fails to load keeps the nav and recovers on navigation", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "blocking a route chunk is portable-only");
    const errors = pageErrors(page);
    let blockedChunkRequests = 0;
    await page.route("**/assets/AccountView-*.js", (route) => {
      blockedChunkRequests += 1;
      return route.abort();
    });

    // A stale chunk reloads once onto the new build; when the chunk is still
    // missing after that, the page-level card appears instead of a blank app.
    await gotoDashboardDocument(page, "/account");
    // The first fallback can render while location.reload() is still pending.
    // Observe the second chunk request before checking the final error card.
    await expect.poll(() => blockedChunkRequests).toBeGreaterThanOrEqual(2);
    await expect(
      page.getByRole("heading", {
        name: /This page couldn't be shown|この画面を表示できませんでした/u,
      }),
    ).toBeVisible();
    await expect(page.getByText(rootReloadCard)).toHaveCount(0);

    // The chrome stays usable: leaving the broken page clears the error.
    await homeLink(page).click();
    await expect(page).toHaveURL(/\/$/u);
    await expect(
      page.getByRole("heading", {
        name: /This page couldn't be shown|この画面を表示できませんでした/u,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByTestId("home-app").filter({ hasText: expectations.appName }).first(),
    ).toBeVisible();
    await assertNoPageErrors(errors);
  });

  test("a failed Workspace list read keeps the current Workspace selected", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "synthetic list failures are portable-only");
    const errors = pageErrors(page);
    const appTile = page
      .getByTestId("home-app")
      .filter({ hasText: expectations.appName })
      .first();
    await gotoDashboardDocument(page, "/");
    await expect(appTile).toBeVisible();
    const readSelection = () =>
      page.evaluate(() => localStorage.getItem("takosumi.currentWorkspaceId"));
    const selected = await readSelection();
    expect(selected).toBeTruthy();

    let failedListReads = 0;
    await page.route(
      (url) =>
        url.pathname === "/api/v1/workspaces" ||
        url.pathname === "/api/v1/dashboard/bootstrap",
      (route) => {
        failedListReads += 1;
        return route.fulfill({ status: 503, json: { error: "synthetic_list" } });
      },
    );
    // Rename/archive/create broadcast this; the switcher re-reads the list.
    await page.evaluate(() =>
      window.dispatchEvent(new Event("takosumi:workspaces-changed")),
    );
    await expect.poll(() => failedListReads).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".workspace-switcher-error:visible").first()).toBeVisible();

    // The failure is not evidence of "no Workspaces": the selection and the
    // launcher survive instead of resetting to first-Workspace onboarding.
    expect(await readSelection()).toBe(selected);
    await expect(appTile).toBeVisible();
    await assertNoPageErrors(errors);
  });

  test("notifications and the launcher say the next step and state in words", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "synthetic launcher rows are portable-only");
    const errors = pageErrors(page);
    // The run history and activity screens left the UI; their old URLs land
    // on ホーム.
    await page.goto("/activity", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/$/u);

    // An empty notification feed offers the next step, not just a sentence.
    await gotoDashboardDocument(page, "/notifications");
    await expect(
      page.getByRole("main").getByRole("link", { name: /^(Find apps in the store|ストアでアプリを探す)$/u }),
    ).toBeVisible();

    // An available update is said in words on the app's Home card.
    await page.route(
      (url) => url.pathname === "/api/v1/workspaces/ws_alpha/capsules",
      (route) =>
      route.fulfill({
        json: {
          capsules: [
            {
              ...PORTABLE_CAPSULES.ws_alpha[0],
              freshness: "stale",
            },
          ],
        },
      }),
    );
    await gotoDashboardDocument(page, "/");
    const tile = page
      .getByTestId("home-app")
      .filter({ hasText: expectations.appName })
      .first();
    await expect(tile).toContainText(/Update available|更新あり/u);
    await expect(tile).toHaveAttribute("data-app-state", "update_available");
    await assertNoPageErrors(errors);
  });

  test("fails closed on an unexpected same-origin API 404", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the intentional 404 exists only in the fixture server",
    );
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    traffic.assertNoFailures();

    const status = await page.evaluate(async () => {
      const response = await fetch("/api/v1/__e2e/unexpected-404");
      return response.status;
    });
    expect(status).toBe(404);
    await expect.poll(() => traffic.failures.length).toBe(1);
    expect(() => traffic.assertNoFailures()).toThrow(/404/u);
  });
});

test.describe("Takosumi public-live browser profile", () => {
  test.skip(mode !== "public-live", "public-live profile only");

  test("probes public identity, signed-out routes, and zero mutations", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const mutations: string[] = [];
    const bootstrapResponses: {
      readonly status: number;
      readonly url: string;
      readonly contentType: string | undefined;
      readonly workerVersion: string | undefined;
    }[] = [];
    const bootstrapRouteFailures: PublicLiveBootstrapResponseFailure[] = [];
    const bootstrapVerifiedUrls: string[] = [];
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        shouldRecordControlPlaneMutation(
          mode,
          mutationOrigin,
          request.url(),
          request.method(),
        )
      ) {
        const requestUrl = new URL(request.url());
        mutations.push(
          `${request.method()} ${requestUrl.pathname}${requestUrl.search}`,
        );
        await route.abort("blockedbyclient");
        return;
      }
      if (
        await handlePublicLiveBootstrapRoute(
          route,
          new URL(mutationOrigin).origin,
          expectedWorkerVersionId!,
          bootstrapRouteFailures,
          bootstrapVerifiedUrls,
        )
      ) {
        return;
      }
      await route.continue();
    });
    page.on("response", (response) => {
      const responseUrl = new URL(response.url());
      if (
        responseUrl.origin !== new URL(mutationOrigin).origin ||
        responseUrl.pathname !== "/api/v1/dashboard/bootstrap"
      ) {
        return;
      }
      if (response.request().method() !== "GET") {
        bootstrapRouteFailures.push("method");
      }
      const headers = response.headers();
      bootstrapResponses.push({
        status: response.status(),
        url: response.url(),
        contentType: headers["content-type"],
        workerVersion: headers["x-takosumi-version-id"],
      });
    });
    await gotoPublicDocument(page, "/");
    const origin = new URL(page.url()).origin;

    const discovery = await fetchLiveEndpoint(
      page,
      traffic,
      "/.well-known/openid-configuration",
      200,
    );
    const discoveryBody = discovery.body as {
      readonly issuer?: unknown;
      readonly jwks_uri?: unknown;
    };
    expect(discoveryBody.issuer).toBe(origin);
    expect(discoveryBody.jwks_uri).toBe(`${origin}/oauth/jwks`);

    const jwks = await fetchLiveEndpoint(page, traffic, "/oauth/jwks", 200);
    const jwksBody = jwks.body as { readonly keys?: unknown };
    expect(Array.isArray(jwksBody.keys)).toBe(true);
    expect((jwksBody.keys as readonly unknown[]).length).toBeGreaterThan(0);

    const unauthenticated = await fetchLiveEndpoint(
      page,
      traffic,
      "/api/v1/dashboard/bootstrap?includeWorkspaces=false",
      401,
    );
    expect(unauthenticated.body).toMatchObject({ error: "invalid_token" });

    for (const path of [
      "/settings",
      "/workloads",
      "/advanced/workspace",
      "/new",
    ]) {
      await gotoPublicDocument(page, path);
    }

    const installPath =
      "/install?git=https%3A%2F%2Fgithub.com%2Fexample%2Fservice.git" +
      "&ref=0123456789abcdef0123456789abcdef01234567&path=deploy%2Fopentofu";
    const installReturnPath = installPath.replace(/^\/install/u, "/new");
    await gotoPublicDocument(page, installPath, installReturnPath);
    expect(new URL(page.url()).searchParams.get("return")).toBe(
      installReturnPath,
    );

    // SignInPanel discovery starts after mount. Keep a short, bounded quiet
    // window so late same-origin responses cannot arrive after the assertions.
    await page.waitForTimeout(500);
    expect(bootstrapResponses.length).toBeGreaterThan(0);
    for (const response of bootstrapResponses) {
      expect(response.status).toBe(401);
      expect(response.contentType).toMatch(/^application\/json(?:;|$)/u);
      expect(response.workerVersion?.trim()).toBe(expectedWorkerVersionId);
    }
    expect(bootstrapRouteFailures).toEqual([]);
    expect([...bootstrapVerifiedUrls].sort()).toEqual(
      bootstrapResponses.map((response) => response.url).sort(),
    );
    expect(
      mutations,
      "public-live browser discovery and navigation must issue zero mutations",
    ).toEqual([]);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
    expect(expectedWorkerVersionId).toMatch(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u,
    );
  });
});

test.describe("public-live bootstrap response local regression", () => {
  test.skip(
    mode !== "public-live" ||
      process.env.TAKOSUMI_E2E_LOCAL_BOOTSTRAP_FIXTURE !== "1",
    "focused local bootstrap fixture only",
  );

  test("buffers the actual bootstrap query through sign-in navigation and rejects mismatches", async ({
    page,
  }) => {
    const expectedVersion = "00000000-0000-4000-8000-000000000001";
    const bootstrapPath =
      "/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50";
    type FixtureMode = "valid" | "wrong-status" | "wrong-body" | "wrong-version";
    let fixtureMode: FixtureMode = "valid";
    let bootstrapRequests = 0;
    let signInRequests = 0;
    const responseEvents: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === bootstrapPath) {
        bootstrapRequests += 1;
        const requestId = bootstrapRequests;
        responseEvents.push(`bootstrap-${requestId}-headers`);
        const status = fixtureMode === "wrong-status" ? 200 : 401;
        const version =
          fixtureMode === "wrong-version"
            ? "00000000-0000-4000-8000-000000000002"
            : expectedVersion;
        const body =
          fixtureMode === "wrong-body"
            ? '{"error":"expired_token"}'
            : '{"error":"invalid_token"}';
        response.writeHead(status, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "x-takosumi-version-id": version,
        });
        response.flushHeaders();
        setTimeout(
          () =>
            response.end(body, () =>
              responseEvents.push(`bootstrap-${requestId}-body-complete`),
            ),
          200,
        );
        return;
      }

      if (
        request.method === "GET" &&
        (request.url === "/" || request.url === "/sign-in")
      ) {
        if (request.url === "/sign-in") {
          signInRequests += 1;
          responseEvents.push("sign-in");
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end("<!doctype html><title>Local sign-in fixture</title>");
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const bootstrapUrl = `${origin}${bootstrapPath}`;
    const bootstrapRouteFailures: PublicLiveBootstrapResponseFailure[] = [];
    const bootstrapVerifiedUrls: string[] = [];
    const bootstrapResponseUrls: string[] = [];
    let raceArmed = true;
    let raceObservation:
      | {
          readonly status: number;
          readonly contentType: string | undefined;
          readonly cacheControl: string | undefined;
          readonly workerVersion: string | undefined;
        }
      | undefined;
    let signInNavigation: Promise<Awaited<ReturnType<Page["goto"]>>> | undefined;

    await page.route("**/*", async (route) => {
      if (
        await handlePublicLiveBootstrapRoute(
          route,
          origin,
          expectedVersion,
          bootstrapRouteFailures,
          bootstrapVerifiedUrls,
        )
      ) {
        return;
      }
      await route.continue();
    });
    page.on("response", (response) => {
      if (response.url() !== bootstrapUrl) return;
      bootstrapResponseUrls.push(response.url());
      if (!raceArmed) return;
      raceArmed = false;
      const headers = response.headers();
      raceObservation = {
        status: response.status(),
        contentType: headers["content-type"],
        cacheControl: headers["cache-control"],
        workerVersion: headers["x-takosumi-version-id"],
      };
      signInNavigation = page.goto(`${origin}/sign-in`, {
        waitUntil: "domcontentloaded",
      });
    });

    try {
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
      await page.evaluate((url) => void fetch(url).catch(() => undefined), bootstrapUrl);
      await expect.poll(() => raceObservation !== undefined).toBe(true);
      await expect.poll(() => signInNavigation !== undefined).toBe(true);
      const signInResponse = await signInNavigation!;
      expect(signInResponse?.status()).toBe(200);
      expect(raceObservation).toMatchObject({
        status: 401,
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store",
        workerVersion: expectedVersion,
      });
      expect(signInRequests).toBe(1);
      expect(bootstrapRequests).toBe(1);
      const bodyCompleteIndex = responseEvents.indexOf(
        "bootstrap-1-body-complete",
      );
      const signInIndex = responseEvents.indexOf("sign-in");
      expect(bodyCompleteIndex).toBeGreaterThanOrEqual(0);
      expect(signInIndex).toBeGreaterThanOrEqual(0);
      expect(bodyCompleteIndex).toBeLessThan(signInIndex);
      expect(bootstrapRouteFailures).toEqual([]);

      const forwarded = await page.evaluate(async (url) => {
        const response = await fetch(url, { cache: "no-store" });
        return {
          status: response.status,
          contentType: response.headers.get("content-type"),
          cacheControl: response.headers.get("cache-control"),
          workerVersion: response.headers.get("x-takosumi-version-id"),
          body: await response.text(),
        };
      }, bootstrapUrl);
      expect(forwarded).toMatchObject({
        status: 401,
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store",
        workerVersion: expectedVersion,
        body: '{"error":"invalid_token"}',
      });
      expect(bootstrapRequests).toBe(2);
      expect(bootstrapRouteFailures).toEqual([]);
      expect([...bootstrapVerifiedUrls].sort()).toEqual(
        [...bootstrapResponseUrls].sort(),
      );

      for (const [mode, expectedFailure] of [
        ["wrong-status", "status"],
        ["wrong-body", "body"],
        ["wrong-version", "worker_version"],
      ] as const) {
        fixtureMode = mode;
        const previousRequestCount = bootstrapRequests;
        const browserFetch = await page.evaluate(async (url) => {
          try {
            await fetch(url, { cache: "no-store" });
            return "response";
          } catch {
            return "rejected";
          }
        }, bootstrapUrl);
        expect(browserFetch).toBe("rejected");
        expect(bootstrapRequests).toBe(previousRequestCount + 1);
        expect(bootstrapRouteFailures.at(-1)).toBe(expectedFailure);
      }
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

registerAppPageCases(mode);
registerInstallDetailCases(mode, (page, needsProvider) => stubProviderDestinationFixture(
  page,
  [],
  needsProvider ? [{ source: "registry.opentofu.org/cloudflare/cloudflare", moduleLocalName: "cloudflare", credentialRequired: true }] : [],
  { resources: [{ type: "cloudflare_workers_script", count: 1, allowed: true }, { type: "cloudflare_d1_database", count: 2, allowed: true }] },
));
