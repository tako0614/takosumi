import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import { registerInstallDetailCases } from "./install_detail_case.ts";
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
  PORTABLE_CAPSULES,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
  PORTABLE_SOURCE_COMMIT,
  PORTABLE_UI_SURFACES,
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

const SOURCE_ARCHIVE_DIGEST = `sha256:${"1".repeat(64)}`;

interface SourceCreateFixtureState {
  readonly sourceListReads: string[];
  readonly sourcePosts: string[];
}

function expectSingleSourceCreate(state: SourceCreateFixtureState): void {
  expect(state.sourceListReads).toEqual([
    "/api/v1/sources?workspaceId=ws_alpha&limit=100",
  ]);
  expect(state.sourcePosts).toEqual(["/api/v1/sources"]);
}

async function expectSourceAutoSyncOptInAfterPlan(
  state: ProviderDestinationFixtureState,
): Promise<void> {
  expect(state.sourceCreateBodies).toEqual([
    expect.objectContaining({ autoSync: false }),
  ]);
  await expect.poll(() => state.sourceAutoSyncPatches).toEqual([
    { autoSync: true },
  ]);
  const planIndex = state.mutations.indexOf(
    "POST /api/v1/workspaces/ws_alpha/install-plans",
  );
  const patchIndex = state.mutations.indexOf(
    "PATCH /api/v1/sources/src_provider_destination_e2e",
  );
  expect(planIndex).toBeGreaterThanOrEqual(0);
  expect(patchIndex).toBeGreaterThan(planIndex);
}

interface ProviderDestinationFixtureState extends SourceCreateFixtureState {
  readonly mutations: string[];
  readonly compatibilityBodies: unknown[];
  readonly installModuleRequests: string[];
  readonly sourceCreateBodies: Record<string, unknown>[];
  readonly sourceAutoSyncPatches: Record<string, unknown>[];
  installPlanBody?: {
    readonly capsule?: Readonly<Record<string, unknown>>;
    readonly options?: {
      readonly providerBindings?: readonly Record<string, unknown>[];
    };
    readonly preflight?: Readonly<Record<string, unknown>>;
    readonly variables?: Readonly<Record<string, unknown>>;
  };
}

interface ProviderDestinationFixtureCoordinates {
  readonly sourcePath?: string;
  readonly modulePath?: string;
  readonly freshCompatibilityIds?: boolean;
  readonly providerPackages?: readonly { readonly source: string; readonly version?: string }[];
  readonly rootProviderRequirements?: readonly Record<string, unknown>[];
  /** Resource types the compatibility report previews before any Plan. */
  readonly resources?: readonly Record<string, unknown>[];
}

/** Stub a complete manual source check while retaining mutation ordering. */
async function stubProviderDestinationFixture(
  page: Page,
  providerConnections = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
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
  const sourcePath = coordinates.sourcePath ?? ".";
  const modulePath = coordinates.modulePath ?? ".";
  const state: ProviderDestinationFixtureState = {
    mutations: [],
    compatibilityBodies: [],
    installModuleRequests: [],
    sourceCreateBodies: [],
    sourceAutoSyncPatches: [],
    sourceListReads: [],
    sourcePosts: [],
  };
  const sourceId = "src_provider_destination_e2e";
  const snapshotId = "snap_provider_destination_e2e";
  const syncRunId = "run_provider_source_sync_e2e";
  const planRunId = "run_provider_plan_e2e";
  let sourceName = "cloudflare-service";
  let sourceUrl = "https://github.com/example/cloudflare-service.git";
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") {
      state.mutations.push(`${request.method()} ${path}`);
    }
    if (
      path === "/api/v1/sources" &&
      request.method() === "GET" &&
      url.search === "?workspaceId=ws_alpha&limit=100"
    ) {
      state.sourceListReads.push(`${path}${url.search}`);
      return route.fulfill({ json: { sources: [] } });
    }
    if (path === "/api/v1/connections") {
      return route.fulfill({ json: { connections: [] } });
    }
    if (path === "/api/v1/credential-recipes") return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES } });
    if (path === "/api/v1/connections" && request.method() === "GET") return route.fulfill({ json: { connections: providerConnections.filter((c) => c.scope === "workspace") } });
    if (path === "/api/v1/capsules/cap_provider_destination_e2e") return route.fulfill({ json: { capsule: {
      id: "cap_provider_destination_e2e", workspaceId: "ws_alpha", sourceId,
      installConfigId: "cfg-default-opentofu-capsule", name: sourceName, slug: sourceName,
      environment: "production", currentStateGeneration: 1,
      currentStateVersionId: "sv_provider_apply_e2e", status: "active",
      createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z",
    } } });
    if (path === "/api/v1/provider-connections") {
      return route.fulfill({
        json: { providerConnections },
      });
    }
    if (path === "/api/v1/sources" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        readonly workspaceId: string;
        readonly name: string;
        readonly url: string;
        readonly defaultRef?: string;
        readonly defaultPath?: string;
        readonly autoSync?: boolean;
      };
      state.sourcePosts.push(path);
      state.sourceCreateBodies.push(body);
      sourceName = body.name;
      sourceUrl = body.url;
      return route.fulfill({
        json: {
          source: {
            id: sourceId,
            workspaceId: body.workspaceId,
            name: body.name,
            url: body.url,
            defaultRef: body.defaultRef ?? "HEAD",
            defaultPath: body.defaultPath ?? ".",
            status: "active",
            autoSync: body.autoSync ?? false,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          hookSecret: "fixture-only",
        },
      });
    }
    if (
      path === `/api/v1/sources/${sourceId}` &&
      request.method() === "PATCH"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.sourceAutoSyncPatches.push(body);
      return route.fulfill({
        json: {
          source: {
            id: sourceId,
            workspaceId: "ws_alpha",
            name: sourceName,
            url: sourceUrl,
            defaultRef: PORTABLE_SOURCE_COMMIT,
            defaultPath: sourcePath,
            status: "active",
            autoSync: body.autoSync === true,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:01.000Z",
          },
        },
      });
    }
    if (
      path === `/api/v1/sources/${sourceId}/sync` &&
      request.method() === "POST"
    ) {
      return route.fulfill({ json: { run: { id: syncRunId } } });
    }
    if (path === `/api/v1/runs/${syncRunId}`) {
      return route.fulfill({
        json: {
          run: {
            id: syncRunId,
            workspaceId: "ws_alpha",
            sourceId,
            type: "source_sync",
            status: "succeeded",
            sourceSnapshotId: snapshotId,
            createdBy: "portable-e2e",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    }
    if (path === `/api/v1/sources/${sourceId}/snapshots`) {
      return route.fulfill({
        json: {
          snapshots: [
            {
              id: snapshotId,
              origin: "git",
              workspaceId: "ws_alpha",
              sourceId,
              url: sourceUrl,
              ref: PORTABLE_SOURCE_COMMIT,
              resolvedCommit: PORTABLE_SOURCE_COMMIT,
              path: sourcePath,
              archiveRef: "fixture",
              archiveDigest: SOURCE_ARCHIVE_DIGEST,
              archiveSizeBytes: 1,
              fetchedByRunId: syncRunId,
              fetchedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      });
    }
    if (
      path ===
        `/api/v1/sources/${sourceId}/snapshots/${snapshotId}/install-modules` &&
      request.method() === "GET"
    ) {
      state.installModuleRequests.push(path);
      return route.fulfill({
        json: {
          status: "ready",
          sourceSnapshotId: snapshotId,
          scopePath: sourcePath,
          modules: [
            {
              path: modulePath,
              providerPackages: coordinates.providerPackages ?? [],
              rootProviderRequirements: coordinates.rootProviderRequirements ?? [],
            },
          ],
        },
      });
    }
    if (path === `/api/v1/sources/${sourceId}/compatibility-check`) {
      state.compatibilityBodies.push(request.postDataJSON());
      const suffix = coordinates.freshCompatibilityIds
        ? `_${state.compatibilityBodies.length}`
        : "";
      return route.fulfill({
        json: {
          run: {
            id: `ccr_provider_destination_e2e${suffix}`,
            type: "compatibility_check",
            status: "succeeded",
            compatibilityReportId: `caprep_provider_destination_e2e${suffix}`,
          },
          report: {
            id: `caprep_provider_destination_e2e${suffix}`,
            level: "ready",
            findings: [],
            providerPackages: [
              ...new Map(
                compatibilityProviders
                  .filter((provider) => typeof provider.source === "string")
                  .map((provider) => [
                    provider.source,
                    {
                      source: provider.source,
                      ...(typeof provider.version === "string"
                        ? { version: provider.version }
                        : {}),
                      allowed: provider.allowed !== false,
                    },
                  ]),
              ).values(),
            ],
            rootProviderRequirements: compatibilityProviders
              .filter(
                (provider) =>
                  typeof provider.source === "string" &&
                  typeof provider.moduleLocalName === "string",
              )
              .map((provider) => ({
                source: provider.source,
                moduleLocalName: provider.moduleLocalName,
                ...(typeof provider.childAlias === "string"
                  ? { childAlias: provider.childAlias }
                  : {}),
                ...(typeof provider.version === "string"
                  ? { version: provider.version }
                  : {}),
                ...(provider.credentialRequired === true
                  ? { credentialRequired: true }
                  : {}),
              })),
            resources: coordinates.resources ?? [],
            rootModuleVariables: [],
          },
        },
      });
    }
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
    if (
      path === "/api/v1/workspaces/ws_alpha/install-plans" &&
      request.method() === "POST"
    ) {
      state.installPlanBody =
        request.postDataJSON() as ProviderDestinationFixtureState["installPlanBody"];
      return route.fulfill({
        status: 201,
        json: {
          installPlan: {
            id: "install_provider_destination_e2e",
            workspaceId: "ws_alpha",
            createdBy: "portable-e2e",
            requestDigest: `sha256:${"2".repeat(64)}`,
            source: {
              name: sourceName,
              url: sourceUrl,
              ref: PORTABLE_SOURCE_COMMIT,
              path: sourcePath,
            },
            capsule: { name: sourceName, environment: "production" },
            options: state.installPlanBody?.options ?? {},
            preflight: state.installPlanBody?.preflight,
            sourceId,
            sourceSnapshotId: snapshotId,
            installConfigId: "cfg-default-opentofu-capsule",
            capsuleId: "cap_provider_destination_e2e",
            planRunId,
            phase: "reviewable",
            generation: 1,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
          nextAction: "review_run",
          links: {
            self: "/api/v1/install-plans/install_provider_destination_e2e",
            run: `/api/v1/runs/${planRunId}`,
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
 * Press the app page's one Install button and wait for the install sheet.
 * Advanced settings is opened so module details can be read. A sheet whose
 * only field is the app name and whose connections are ready goes straight
 * to Review, which creates the Plan; it never applies it.
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
  const advanced = config.locator(":scope > .iv-sheet-block details.iv-advanced").last();
  if (await advanced.count() && !await advanced.getAttribute("open")) await advanced.locator("summary").first().click();
  if (await config.getAttribute("data-install-state") === "ready" &&
    await config.locator(".iv-fields input, .iv-fields select, .iv-fields textarea").count() === 1) {
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
      await page.locator("details.iv-advanced > summary", { hasText: "Source and version" }).click();
      await expect(page.getByLabel("Git URL")).toHaveValue(
        "https://github.com/example/cloudflare-service.git",
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
    const install = await stubProviderDestinationFixture(page);
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/v1/workspaces/ws_alpha/source-ref-resolutions/stable-semver" && request.method() === "POST") {
        return route.fulfill({ json: { tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT } });
      }
      if (path === "/api/v1/runs/run_provider_source_sync_e2e") {
        return route.fulfill({ json: { run: {
          id: "run_provider_source_sync_e2e", workspaceId: "ws_alpha",
          sourceId: "src_provider_destination_e2e", type: "source_sync", status: "succeeded",
          sourceSnapshotId: "snap_provider_destination_e2e", ref: PORTABLE_SOURCE_COMMIT,
          createdBy: "portable-e2e", createdAt: "2026-08-01T00:00:00.000Z",
        } } });
      }
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
    expect(install.installPlanBody).toMatchObject({
      variables: { region: "us-west-2" },
      options: { providerBindings: [expect.objectContaining({
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        connectionId: "pc_takosumi_cloud",
      })] },
    });

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
    expect(requests.filter((entry) => entry.startsWith("PATCH "))).toEqual([
      `PATCH ${mutationOrigin}/api/v1/sources/src_provider_destination_e2e`,
    ]);
    expect(requests.every((entry) =>
      entry.startsWith(`GET ${mutationOrigin}/`) ||
      entry.startsWith(`POST ${mutationOrigin}/`) ||
      entry === `PATCH ${mutationOrigin}/api/v1/sources/src_provider_destination_e2e` ||
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
    await expect(page.getByLabel(/Git URL/u)).toHaveValue(
      "https://github.com/example/service.git",
    );
    await expect(page.getByLabel(/^Version \(tag, branch or commit; optional\)|^版（tag・branch・commit。省略可）/u)).toHaveValue(
      "0123456789abcdef0123456789abcdef01234567",
    );
    await expect(page.getByLabel(/Module folder|モジュールのフォルダ/u)).toHaveValue(
      "deploy/opentofu",
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
      await expect(page.getByRole("button", { name: "選び直す", exact: true })).toBeVisible();
      await expect(page.getByTestId("install-provenance")).toContainText("github.com/example/service");
      await expect(page.getByTestId("install-configuration")).toHaveCount(0);
      // A Store listing exposes only its version, folded under Source and version.
      await expect(page.getByTestId("install-start").locator("input")).toHaveCount(1);
      await expect(page.getByTestId("install-start").locator("input")).toBeHidden();
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

  test("reload reads the accepted install coordinator and links a terminal Plan without automatic mutation", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "acknowledged install recovery fixture is portable-only");
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const planId = "gip_0123456789abcdef";
    const runId = "plan_0123456789abcdef";
    const recoveryUrl = `/new?installPlan=${planId}`;
    const coordinatorReads: string[] = [];
    const mutations: string[] = [];
    let phase: "reviewable" | "failed" = "reviewable";
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/v1/") && request.method() !== "GET") {
        mutations.push(`${request.method()} ${path}`);
      }
    });
    await page.route(`**/api/v1/install-plans/${planId}`, async (route) => {
      const request = route.request();
      expect(request.method()).toBe("GET");
      coordinatorReads.push(request.url());
      await route.fulfill({
        json: {
          installPlan: {
            id: planId,
            operation: "install",
            workspaceId: "ws_alpha",
            createdBy: "sub_portable_e2e",
            planRunId: runId,
            phase,
            generation: phase === "reviewable" ? 5 : 6,
          },
          nextAction: phase === "reviewable" ? "review_run" : "none",
          links: { self: `/api/v1/install-plans/${planId}`, run: `/api/v1/runs/${runId}` },
        },
      });
    });

    await gotoDashboardDocument(page, recoveryUrl);
    await expect(page.getByTestId("install-plan-recovery")).toHaveAttribute("data-phase", "reviewable");
    await expect(page.getByRole("heading", { name: /最初の変更を確認できます|The first review is ready/u })).toBeVisible();
    await expect(page.locator(`[data-testid="install-plan-recovery"] a[href="/runs/${runId}"]`)).toBeVisible();
    expect(coordinatorReads).toHaveLength(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("install-plan-recovery")).toHaveAttribute("data-phase", "reviewable");
    expect(coordinatorReads).toHaveLength(2);

    phase = "failed";
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("install-plan-recovery")).toHaveAttribute("data-phase", "failed");
    await expect(page.getByRole("heading", { name: /インストールの準備は停止|The install stopped/u })).toBeVisible();
    await expect(page.locator(`[data-testid="install-plan-recovery"] a[href="/runs/${runId}"]`)).toBeVisible();
    expect(coordinatorReads).toHaveLength(3);
    expect(mutations).toEqual([]);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("supported resources show every compatible Host/account before Plan", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the compatible ProviderConnection fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const accountA = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0]!,
      id: "pc_cloudflare_account_a_v02",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare-v02",
      displayName: "Cloudflare account A",
    };
    const accountB = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1]!,
      id: "pc_cloudflare_account_b_v02",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare-v02",
      displayName: "Cloudflare account B",
    };
    const state = await stubProviderDestinationFixture(
      page,
      [accountA, accountB],
      [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    const destinationControl = page.getByLabel(/Host \/ account/u);
    await expect(destinationControl).toHaveValue("");
    await expect(destinationControl.locator("option")).toContainText([
      "Cloudflare account A",
      "Cloudflare account B",
    ]);
    await expect(installConnectionRows(page)).toHaveAttribute("data-connection-state", "missing");
    expect(state.installPlanBody).toBeUndefined();
    await destinationControl.selectOption("pc_cloudflare_account_b_v02");
    await expect(installConnectionRows(page)).toHaveAttribute("data-connection-state", "connected");
    await reviewInlineFixture(page);

    await expect
      .poll(() => state.installPlanBody?.options?.providerBindings)
      .toEqual([
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          connectionId: "pc_cloudflare_account_b_v02",
        },
      ]);
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        state.mutations.indexOf(
          "POST /api/v1/workspaces/ws_alpha/install-plans",
        ),
      )
      .toBeGreaterThanOrEqual(0);
    expect(state.installPlanBody?.preflight).toEqual({
      sourceId: "src_provider_destination_e2e",
      sourceSnapshotId: "snap_provider_destination_e2e",
      compatibilityCheckRunId: "ccr_provider_destination_e2e",
      compatibilityReportId: "caprep_provider_destination_e2e",
      installConfigId: "cfg-default-opentofu-capsule",
    });
    await expectSourceAutoSyncOptInAfterPlan(state);
    expect(state.mutations).not.toContain(
      "POST /api/v1/workspaces/ws_alpha/capsules",
    );
    expect(state.mutations).not.toContain(
      "PUT /api/v1/capsules/cap_provider_destination_e2e/provider-bindings",
    );
    expect(state.mutations).not.toContain(
      "POST /api/v1/capsules/cap_provider_destination_e2e/plan",
    );
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  for (const edited of [false, true]) {
    test(`direct Git timeout retry ${edited ? "discards edited" : "retains exact"} request`, async ({ page }) => {
      test.skip(mode !== "portable", "local install fixture only");
      const state = await stubProviderDestinationFixture(page, [], [], {
        freshCompatibilityIds: true,
      });
      const posts: { body: string; key: string | undefined }[] = [];
      await page.route("**/workspaces/ws_alpha/install-plans", async (route) => {
        posts.push({
          body: route.request().postData()!,
          key: route.request().headers()["idempotency-key"],
        });
        if (posts.length === 1) {
          return route.fulfill({ status: 504, json: {
            error: { code: "git_install_plan_timeout", message: "Timed out" },
          } });
        }
        return route.fallback();
      });
      const query = new URLSearchParams({
        git: "https://github.com/example/cloudflare-service.git",
        ref: PORTABLE_SOURCE_COMMIT,
        path: ".",
        name: "cloudflare-service",
      });
      await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
      await prepareInlineFixture(page);
      await expect.poll(() => posts.length).toBe(1);
      // The unknown outcome returns to the sheet with its inputs intact.
      const review = installSheetActions(page).getByRole("button", { name: "Review", exact: true });
      await expect(review).toBeEnabled();
      // No automatic mutation retry after an unknown outcome.
      expect(posts).toHaveLength(1);
      expect(state.sourceAutoSyncPatches).toEqual([]);
      if (edited) {
        await page.getByTestId("install-configuration")
          .getByRole("textbox", { name: /^App name\b/u }).fill("edited-service");
      }
      await review.click();
      await expect.poll(() => posts.length).toBe(2);
      await expect(page.locator(".iv-execution")).toBeVisible();
      expect(posts[0]!.key).toBeTruthy();
      if (edited) {
        // A renamed request is a new request; the immutable Source and
        // compatibility evidence are reused because the name is not bound to them.
        expect(posts[1]!.key).not.toBe(posts[0]!.key);
        const [first, retried] = posts.map((post) => JSON.parse(post.body));
        expect(retried.capsule.name).toBe("edited-service");
        expect(first.capsule.name).toBe("cloudflare-service");
        // The Source keeps its registered name; only the Capsule is renamed.
        expect(retried.source.name).toBe("cloudflare-service");
        expect(retried.preflight).toEqual(first.preflight);
      } else {
        expect(posts[1]).toEqual(posts[0]);
      }
      expect(state.compatibilityBodies).toHaveLength(1);
    });
  }

  test("source auto-sync retries after PATCH failure without recreating the install Plan", async ({ page }) => {
    test.skip(mode !== "portable", "auto-sync failures are a portable-only fixture");
    const errors = pageErrors(page);
    const state = await stubProviderDestinationFixture(page, [], []);
    const patchBodies: unknown[] = [];
    const patchPath = "/api/v1/sources/src_provider_destination_e2e";
    await page.route(`**${patchPath}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      patchBodies.push(route.request().postDataJSON());
      if (patchBodies.length <= 2) {
        return route.fulfill({ status: 503, json: {
          error: { code: "unavailable", message: "Source polling temporarily unavailable" },
        } });
      }
      return route.fallback();
    });
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);
    await expect(page.locator(".iv-execution")).toBeVisible();
    await expect.poll(() => patchBodies.length).toBe(1);
    const warning = page.getByTestId("install-source-auto-sync-retry");
    await expect(warning).toContainText(/自動更新を有効にできませんでした|Automatic source updates could not be enabled/u);
    const retry = warning.getByRole("button", { name: /再試行|Retry/u });
    await retry.click();
    await expect.poll(() => patchBodies.length).toBe(2);
    await expect(retry).toBeEnabled();
    await expect(warning).toContainText(/自動更新を有効にできませんでした|Automatic source updates could not be enabled/u);
    await retry.click();
    await expect.poll(() => patchBodies.length).toBe(3);
    await expect(warning).toHaveCount(0);
    expect(patchBodies).toEqual([
      { autoSync: true }, { autoSync: true }, { autoSync: true },
    ]);
    expect(state.sourceAutoSyncPatches).toEqual([{ autoSync: true }]);
    expectSingleSourceCreate(state);
    expect(state.compatibilityBodies).toHaveLength(1);
    expect(state.mutations.filter((mutation) =>
      mutation === "POST /api/v1/workspaces/ws_alpha/install-plans"
    )).toHaveLength(1);
    expect(state.mutations.some((mutation) => mutation.includes("/apply"))).toBe(false);
    await assertNoPageErrors(errors);
  });

  for (const succeeds of [false, true]) {
    test(`source auto-sync ignores a late PATCH ${succeeds ? "success" : "failure"} after Workspace change`, async ({ page }) => {
      test.skip(mode !== "portable", "auto-sync races are a portable-only fixture");
      const errors = pageErrors(page);
      const state = await stubProviderDestinationFixture(page, [], []);
      let heldPatch: Route | undefined;
      await page.route("**/api/v1/sources/src_provider_destination_e2e", (route) => {
        if (route.request().method() !== "PATCH") return route.fallback();
        heldPatch = route;
      });
      const query = new URLSearchParams({
        git: "https://github.com/example/cloudflare-service.git",
        ref: PORTABLE_SOURCE_COMMIT,
        name: "cloudflare-service",
      });
      await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
      await prepareInlineFixture(page);
      await expect.poll(() => Boolean(heldPatch)).toBe(true);
      const trigger = workspaceTrigger(page);
      await trigger.click();
      await page.locator('[role="menu"]:visible').first()
        .getByRole("menuitemradio").filter({ hasText: expectations.switchWorkspaceName })
        .first().click();
      await expect(trigger).toHaveAttribute("aria-label", /Beta Workspace/u);
      const response = page.waitForResponse((current) =>
        current.request().method() === "PATCH" &&
        new URL(current.url()).pathname === "/api/v1/sources/src_provider_destination_e2e"
      );
      await heldPatch!.fulfill(succeeds
        ? { json: { source: {
            id: "src_provider_destination_e2e",
            workspaceId: "ws_alpha",
            name: "cloudflare-service",
            url: "https://github.com/example/cloudflare-service.git",
            defaultRef: PORTABLE_SOURCE_COMMIT,
            defaultPath: ".",
            status: "active",
            autoSync: true,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:01.000Z",
          } } }
        : { status: 503, json: { error: { code: "unavailable", message: "Stale polling failure" } } });
      await response;
      await expect(page.getByRole("button", { name: /^(インストール|Install)$/u })).toBeEnabled();
      await expect(page.getByTestId("install-source-auto-sync-retry")).toHaveCount(0);
      await expect(page.locator(".iv-execution")).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("Stale polling failure");
      expectSingleSourceCreate(state);
      expect(state.mutations.filter((mutation) => mutation.includes("/install-plans")))
        .toHaveLength(1);
      await assertNoPageErrors(errors);
    });
  }

  test("unsupported resources offer connection setup before Plan", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the unsupported provider fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const state = await stubProviderDestinationFixture(page, []);
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    const row = installConnectionRows(page);
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute("data-connection-state", "missing");
    await expect(row.getByRole("button", { name: /^(Connect|接続する)$/u })).toBeEnabled();
    await expect(page.getByTestId("install-configuration")).toHaveAttribute("data-install-state", "provider-required");
    await expect(installSheetActions(page).getByRole("button", { name: /^(Connect|接続する)$/u })).toBeVisible();
    await expect(installSheetActions(page).getByRole("button", { name: /^(Review|内容を確認)$/u })).toHaveCount(0);
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    expect(state.installPlanBody).toBeUndefined();
    expect(state.mutations).not.toContain(
      "PUT /api/v1/capsules/cap_provider_destination_e2e/provider-bindings",
    );
    expect(state.mutations).not.toContain(
      "POST /api/v1/workspaces/ws_alpha/install-plans",
    );
    expect(state.sourceAutoSyncPatches).toEqual([]);
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("module review shows all scanned providers and mixed required connections before apply", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the mixed ProviderConnection fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const cloudflareHost = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0]!,
      id: "pc_cloudflare_host_v02_mixed",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare-v02",
      displayName: "Cloudflare host",
    };
    const awsPrimary = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1]!,
      id: "pc_aws_primary_mixed",
      provider: "aws",
      providerSource: "registry.opentofu.org/hashicorp/aws",
      displayName: "AWS primary",
    };
    const awsSecondary = {
      ...awsPrimary,
      id: "pc_aws_secondary_mixed",
      displayName: "AWS secondary",
    };
    const state = await stubProviderDestinationFixture(
      page,
      [cloudflareHost, awsPrimary, awsSecondary],
      [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          allowed: true,
          credentialRequired: true,
        },
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
          allowed: true,
          credentialRequired: true,
        },
      ],
      {
        modulePath: "deploy/opentofu/portable",
        providerPackages: [
          { source: "registry.opentofu.org/cloudflare/cloudflare-v02", version: "5.0.0" },
          { source: "registry.opentofu.org/hashicorp/aws", version: "5.0.0" },
          { source: "registry.opentofu.org/hashicorp/random", version: "3.6.0" },
        ],
        rootProviderRequirements: [
          { source: "registry.opentofu.org/cloudflare/cloudflare-v02", moduleLocalName: "cloudflare-v02", version: "5.0.0" },
          { source: "registry.opentofu.org/hashicorp/aws", moduleLocalName: "aws", version: "5.0.0" },
        ],
      },
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: "deploy/opentofu/portable",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    // One row per required provider: the single Cloudflare candidate is
    // already chosen, while two AWS candidates ask for a choice.
    const rows = installConnectionRows(page);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-provider-source", "registry.opentofu.org/cloudflare/cloudflare-v02");
    await expect(rows.nth(0)).toHaveAttribute("data-connection-state", "connected");
    await expect(rows.nth(0)).toContainText("Cloudflare host");
    await expect(rows.nth(0).locator("select")).toHaveCount(0);
    await expect(rows.nth(1)).toHaveAttribute("data-provider-source", "registry.opentofu.org/hashicorp/aws");
    await expect(rows.nth(1)).toHaveAttribute("data-connection-state", "missing");
    const awsDestination = rows.nth(1).locator("select");
    await expect(awsDestination).toHaveValue("");
    const summary = page.getByTestId("install-source-summary");
    await expect(page.getByRole("region", { name: "Configuration and connections" })).toBeVisible();
    await expect(summary.locator("dt").first()).toHaveText("Configuration");
    await expect(summary.getByTestId("install-selected-module")).toHaveText("deploy/opentofu/portable");
    const packages = summary.getByTestId("install-provider-packages");
    await expect(packages.locator("li")).toHaveCount(3);
    await expect(packages).toContainText("registry.opentofu.org/hashicorp/random");
    await expect(packages).toContainText("3.6.0");
    await expect(summary.getByTestId("install-required-connection")).toHaveCount(2);
    await expect(summary.getByTestId("install-required-connection").nth(0)).toContainText("Cloudflare host");
    await expect(summary.getByTestId("install-required-connection").nth(1)).toContainText("Not selected");
    expect(state.installPlanBody).toBeUndefined();
    await awsDestination.selectOption("pc_aws_primary_mixed");
    await expect(rows.nth(1)).toHaveAttribute("data-connection-state", "connected");
    await expect(summary.getByTestId("install-required-connection").nth(1)).toContainText("AWS primary");
    await page.screenshot({ path: test.info().outputPath("module-sheet-desktop.png"), fullPage: true });
    for (const width of [320, 375, 390, 414, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(summary).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `the install sheet must not overflow at ${width}px`,
      ).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await reviewInlineFixture(page);

    await expect(
      page.getByRole("heading", { name: /このアプリがあなたのクラウドに作るもの|What this app will create in your cloud/u }),
    ).toBeVisible();
    // A succeeded plan is ready to review; nothing has been installed yet.
    const reviewBadge = page.locator(".iv-review-head .tg-badge");
    await expect(reviewBadge).toHaveText(/確認できます|Ready to review/u);
    await expect(reviewBadge).not.toHaveText(/成功|Succeeded/u);
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    await expect(page.getByTestId("install-plan-cost")).toBeVisible();
    await expect(page.getByRole("link", { name: /Technical details/u }).first()).toHaveAttribute("href", "/runs/run_provider_plan_e2e");
    expect(state.mutations.some((entry) => /apply|approve/u.test(entry))).toBe(false);
    await page.screenshot({ path: test.info().outputPath("module-review-desktop.png"), fullPage: true });
    for (const width of [320, 375, 390, 414, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.locator(".iv-execution")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `the review must not overflow at ${width}px`,
      ).toBe(true);
      if (width === 375) {
        await page.screenshot({ path: test.info().outputPath("module-review-mobile.png"), fullPage: true });
      }
    }
    await expect
      .poll(() => state.installPlanBody?.options?.providerBindings)
      .toEqual([
        {
          provider: "registry.opentofu.org/cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          connectionId: "pc_cloudflare_host_v02_mixed",
        },
        {
          provider: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
          connectionId: "pc_aws_primary_mixed",
        },
      ]);
    await expectSourceAutoSyncOptInAfterPlan(state);
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("exact compatibility provider tuples preserve same-source aliases", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the exact provider tuple fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const awsPrimary = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0]!,
      id: "pc_aws_primary_tuple",
      provider: "aws",
      providerSource: "registry.opentofu.org/aws/aws",
      displayName: "AWS primary",
    };
    const awsSecondary = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1]!,
      id: "pc_aws_secondary_tuple",
      provider: "aws",
      providerSource: "registry.opentofu.org/aws/aws",
      displayName: "AWS secondary",
    };
    const state = await stubProviderDestinationFixture(
      page,
      [awsPrimary, awsSecondary],
      [
        {
          source: "registry.opentofu.org/aws/aws",
          moduleLocalName: "aws",
          childAlias: "primary",
          version: "5.0.0",
          allowed: true,
          credentialRequired: true,
        },
        {
          source: "registry.opentofu.org/aws/aws",
          moduleLocalName: "aws",
          childAlias: "secondary",
          version: "5.0.0",
          allowed: true,
          credentialRequired: true,
        },
        {
          source: "registry.opentofu.org/aws/aws",
          moduleLocalName: "aws-edge",
          childAlias: "edge",
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/aws-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "aws-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    const choices = installConnectionRows(page);
    await expect(choices).toHaveCount(3);
    await expect(choices.nth(0)).toHaveAttribute(
      "data-provider-source",
      "registry.opentofu.org/aws/aws",
    );
    await expect(choices.nth(0)).toHaveAttribute(
      "data-module-local-name",
      "aws",
    );
    await expect(choices.nth(1)).toHaveAttribute(
      "data-module-local-name",
      "aws",
    );
    await expect(choices.nth(2)).toHaveAttribute(
      "data-module-local-name",
      "aws-edge",
    );
    await expect(choices.nth(0)).toHaveAttribute("data-child-alias", "primary");
    await expect(choices.nth(1)).toHaveAttribute("data-child-alias", "secondary");
    await expect(choices.nth(2)).toHaveAttribute("data-child-alias", "edge");
    await choices.nth(0).locator("select").selectOption("pc_aws_primary_tuple");
    await choices.nth(1).locator("select").selectOption("pc_aws_secondary_tuple");
    await choices.nth(2).locator("select").selectOption("pc_aws_primary_tuple");
    for (const [index, connection] of ["pc_aws_primary_tuple", "pc_aws_secondary_tuple", "pc_aws_primary_tuple"].entries()) {
      await expect(choices.nth(index).locator("select")).toHaveValue(connection);
      await expect(choices.nth(index)).toHaveAttribute("data-connection-state", "connected");
    }

    // The module details name each exact tuple's chosen connection.
    const connectionSummary = page.getByTestId("install-source-summary").getByTestId("install-required-connection");
    await expect(connectionSummary).toHaveCount(3);
    await expect(connectionSummary.nth(0)).toHaveAttribute("data-child-alias", "primary");
    await expect(connectionSummary.nth(1)).toHaveAttribute("data-child-alias", "secondary");
    await expect(connectionSummary.nth(2)).toHaveAttribute("data-child-alias", "edge");
    await expect(connectionSummary.nth(0)).toContainText("AWS primary");
    await expect(connectionSummary.nth(1)).toContainText("AWS secondary");
    await expect(connectionSummary.nth(2)).toContainText("AWS primary");
    await reviewInlineFixture(page);

    await expect
      .poll(() => state.installPlanBody?.options?.providerBindings)
      .toEqual([
        {
          provider: "registry.opentofu.org/aws/aws",
          moduleLocalName: "aws",
          childAlias: "primary",
          rootAlias: "primary",
          connectionId: "pc_aws_primary_tuple",
        },
        {
          provider: "registry.opentofu.org/aws/aws",
          moduleLocalName: "aws",
          childAlias: "secondary",
          rootAlias: "secondary",
          connectionId: "pc_aws_secondary_tuple",
        },
        {
          provider: "registry.opentofu.org/aws/aws",
          moduleLocalName: "aws-edge",
          childAlias: "edge",
          rootAlias: "edge",
          connectionId: "pc_aws_primary_tuple",
        },
      ]);
    await expectSourceAutoSyncOptInAfterPlan(state);
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("ambiguous supported destinations ask for a choice without connection setup", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the ambiguous destination fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const connectionA = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0]!,
      id: "pc_cloudflare_connection_a",
      displayName: "Cloudflare connection A",
    };
    const connectionB = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1]!,
      id: "pc_cloudflare_connection_b",
      displayName: "Cloudflare connection B",
    };
    const state = await stubProviderDestinationFixture(page, [
      connectionA,
      connectionB,
    ]);
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /新しい接続を追加|Add a new connection/u,
      }),
    ).toHaveCount(0);
    const destination = page.getByLabel(/Host \/ account/u);
    await expect(destination).toBeVisible();
    await expect(destination).toHaveValue("");
    await expect(destination.locator("option")).toContainText([
      "Cloudflare connection A",
      "Cloudflare connection B",
    ]);
    // Choosing is enough: no connection form opens on its own, and adding
    // another account stays a collapsed, explicit choice.
    const row = installConnectionRows(page);
    await expect(row).toHaveAttribute("data-connection-state", "missing");
    await expect(page.locator(".iv-inline-connect")).toHaveCount(0);
    const another = row.getByRole("button", { name: /Connect another account|別のアカウントで接続/u });
    await expect(another).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    expect(state.installPlanBody).toBeUndefined();
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("the auto-selected Host/account keeps its label on one line on a phone", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the single destination fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.setViewportSize({ width: 390, height: 844 });
    const longName = "Cloudflare (direct) production account for the example team";
    const state = await stubProviderDestinationFixture(page, [
      { ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1]!, displayName: longName },
    ]);
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", { name: /このアプリがあなたのクラウドに作るもの|What this app will create in your cloud/u }),
    ).toBeVisible();
    const destination = page.locator(
      '[data-install-provider-destination="auto-selected"]',
    );
    await expect(destination).toHaveAttribute(
      "data-provider-connection-id",
      "pc_cloudflare_direct",
    );
    // The choice is already made: plain text, not a disabled select.
    await expect(destination.locator("select, [role=combobox]")).toHaveCount(0);
    await expect(destination).toContainText(/ホスト \/ アカウント|Host \/ account/u);
    await expect(destination.locator(".iv-destination-name")).toHaveText(longName);
    // A squeezed flex label used to stack one character per line; a long name
    // has to wrap inside the row rather than be cut off.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await destination.evaluate((row) => {
        const style = getComputedStyle(row);
        const outer = row.getBoundingClientRect();
        const label = row.querySelector(":scope > span")!;
        return {
          content: {
            left: outer.left + Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.paddingLeft),
            right: outer.right - Number.parseFloat(style.borderRightWidth) - Number.parseFloat(style.paddingRight),
          },
          label: label.getBoundingClientRect().toJSON() as DOMRect,
          name: row.querySelector(".iv-destination-name")!.getBoundingClientRect().toJSON() as DOMRect,
          fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
          pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        };
      });
      expect(geometry.label.height, `label is one line at ${width}px`).toBeLessThan(geometry.fontSize * 2);
      for (const [name, box] of [
        ["label", geometry.label],
        ["name", geometry.name],
      ] as const) {
        expect(box.left, `${name} starts inside the row at ${width}px`).toBeGreaterThanOrEqual(geometry.content.left);
        expect(box.right, `${name} ends inside the row at ${width}px`).toBeLessThanOrEqual(geometry.content.right);
      }
      expect(geometry.pageFits, `page fits ${width}px`).toBe(true);
      if (width === 320) {
        expect(geometry.name.height, "the long name wraps at 320px").toBeGreaterThan(geometry.fontSize * 2);
      }
    }
    expect(state.mutations.some((entry) => /apply|approve/u.test(entry))).toBe(false);
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("unrelated v01 provider labels cannot masquerade as a v02 destination", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the provider version mismatch fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const unrelatedV01 = {
      ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0]!,
      id: "pc_cloudflare_connection_v01",
      providerSource: "registry.opentofu.org/cloudflare/cloudflare-v01",
      displayName: "Cloudflare v01 connection",
    };
    const state = await stubProviderDestinationFixture(
      page,
      [unrelatedV01],
      [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    // The v01 connection is not offered for the v02 provider row.
    const row = installConnectionRows(page);
    await expect(row).toHaveAttribute("data-provider-source", "registry.opentofu.org/cloudflare/cloudflare-v02");
    await expect(row).toHaveAttribute("data-connection-state", "missing");
    await expect(row.locator("select")).toHaveCount(0);
    await expect(row).not.toContainText("Cloudflare v01 connection");
    await expect(row.getByRole("button", { name: /^(Connect|接続する)$/u })).toBeEnabled();
    expect(state.installPlanBody).toBeUndefined();
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("mixed provider support keeps connection setup available for the unsupported provider", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the mixed provider fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const state = await stubProviderDestinationFixture(
      page,
      [PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0]!],
      [
        {
          source: "registry.opentofu.org/cloudflare/cloudflare",
          moduleLocalName: "cloudflare",
          allowed: true,
          credentialRequired: true,
        },
        {
          source: "registry.opentofu.org/hashicorp/aws",
          moduleLocalName: "aws",
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await prepareInlineFixture(page);

    await expect(
      page.getByRole("heading", {
        name: /クラウド接続|Cloud connection/u,
      }),
    ).toBeVisible();
    const rows = installConnectionRows(page);
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-provider-source", "registry.opentofu.org/cloudflare/cloudflare");
    await expect(rows.nth(0)).toHaveAttribute("data-connection-state", "connected");
    await expect(rows.nth(1)).toHaveAttribute("data-provider-source", "registry.opentofu.org/hashicorp/aws");
    await expect(rows.nth(1)).toHaveAttribute("data-connection-state", "missing");
    const connectAws = rows.nth(1).getByRole("button", { name: /^(Connect|接続する)$/u });
    await expect(connectAws).toBeEnabled();
    // Connecting the unsupported provider opens a form for that provider only.
    await connectAws.click();
    const form = rows.nth(1).locator(".iv-inline-connect");
    await expect(form).toBeVisible();
    await expect(rows.nth(0).locator(".iv-inline-connect")).toHaveCount(0);
    expect(state.installPlanBody).toBeUndefined();
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  const storeSetupRetryTest = (
    retryMode: "none" | "unchanged" | "edited",
    reviewedModule?: { readonly path: string; readonly exposed: boolean },
  ) => {
  const reviewedLabel = reviewedModule
    ? `, reviewed ${reviewedModule.path}${reviewedModule.exposed ? "" : " (stale)"}`
    : "";
  test(`Store setup edits keep the ready compatibility fence and continue to Plan (${retryMode}${reviewedLabel})`, async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the deterministic install API fixture is portable-only",
    );
    const now = "2026-08-04T00:00:00.000Z";
    const resolvedCommit = "0123456789abcdef0123456789abcdef01234567";
    const seenMutations: string[] = [];
    const prematureConfigReads: string[] = [];
    const installModuleRequests: string[] = [];
    const compatibilityBodies: unknown[] = [];
    const stableRefResolutionBodies: unknown[] = [];
    const sourcePostBodies: unknown[] = [];
    const sourceAutoSyncPatchBodies: unknown[] = [];
    const syncBodies: unknown[] = [];
    const installPlanBodies: unknown[] = [];
    const installPlanKeys: (string | undefined)[] = [];
    const sourceState: SourceCreateFixtureState = {
      sourceListReads: [],
      sourcePosts: [],
    };
    await page.route("https://store.example.test/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "example/service",
          // A catalog that reviewed one module of a multi-module repository.
          source: {
            git: "https://github.com/example/service.git",
            ...(reviewedModule ? { path: reviewedModule.path } : {}),
          },
          suggestedName: "example-service",
          name: { ja: "Example Service", en: "Example Service" },
          description: { ja: "Example", en: "Example" },
          badge: { ja: "追加", en: "Add" },
          createdAt: now,
          updatedAt: now,
        }),
      });
    });
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (
        shouldRecordControlPlaneMutation(
          mode,
          mutationOrigin,
          request.url(),
          request.method(),
        )
      ) {
        seenMutations.push(`${request.method()} ${path}`);
      }
      if (
        path === "/api/v1/sources" &&
        request.method() === "GET" &&
        url.search === "?workspaceId=ws_alpha&limit=100"
      ) {
        sourceState.sourceListReads.push(`${path}${url.search}`);
        return route.fulfill({ json: { sources: [] } });
      }
      if (
        path ===
          "/api/v1/workspaces/ws_alpha/source-ref-resolutions/stable-semver" &&
        request.method() === "POST"
      ) {
        stableRefResolutionBodies.push(request.postDataJSON());
        return route.fulfill({
          json: { tag: "v1.0.0", commit: resolvedCommit },
        });
      }
      if (
        path === "/api/v1/capsule-configs" &&
        request.method() === "GET" &&
        url.search === "?view=store"
      ) {
        prematureConfigReads.push(`${path}${url.search}`);
        return route.fulfill({ json: { installConfigs: [] } });
      }
      if (path === "/api/v1/connections") {
        return route.fulfill({ json: { connections: [] } });
      }
      if (path === "/api/v1/provider-connections") {
        return route.fulfill({ json: { providerConnections: [] } });
      }
      if (path === "/api/v1/sources" && request.method() === "POST") {
        const body = request.postDataJSON() as {
          readonly workspaceId: string;
          readonly name: string;
          readonly url: string;
          readonly defaultRef?: string;
          readonly defaultPath?: string;
          readonly autoSync?: boolean;
        };
        sourceState.sourcePosts.push(path);
        sourcePostBodies.push(body);
        return route.fulfill({
          json: {
            source: {
              id: "src_install_e2e",
              workspaceId: body.workspaceId,
              name: body.name,
              url: body.url,
              defaultRef: body.defaultRef ?? "HEAD",
              defaultPath: body.defaultPath ?? ".",
              status: "active",
              autoSync: body.autoSync ?? false,
              createdAt: now,
              updatedAt: now,
            },
            hookSecret: "fixture-only",
          },
        });
      }
      if (
        path === "/api/v1/sources/src_install_e2e" &&
        request.method() === "PATCH"
      ) {
        sourceAutoSyncPatchBodies.push(request.postDataJSON());
        return route.fulfill({
          json: {
            source: {
              id: "src_install_e2e",
              workspaceId: "ws_alpha",
              name: "example-service",
              url: "https://github.com/example/service",
              defaultRef: resolvedCommit,
              defaultPath: ".",
              status: "active",
              autoSync: true,
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
      if (path === "/api/v1/sources/src_install_e2e/sync") {
        syncBodies.push(request.postDataJSON());
        return route.fulfill({ json: { run: { id: "run_sync_e2e" } } });
      }
      if (path === "/api/v1/runs/run_sync_e2e") {
        return route.fulfill({
          json: {
            run: {
              id: "run_sync_e2e",
              workspaceId: "ws_alpha",
              sourceId: "src_install_e2e",
              type: "source_sync",
              status: "succeeded",
              sourceSnapshotId: "snap_install_e2e",
              ref: resolvedCommit,
              createdBy: "portable-e2e",
              createdAt: now,
            },
          },
        });
      }
      if (path === "/api/v1/sources/src_install_e2e/snapshots") {
        return route.fulfill({
          json: {
            snapshots: [
              {
                id: "snap_install_e2e",
                origin: "git",
                workspaceId: "ws_alpha",
                sourceId: "src_install_e2e",
                url: "https://github.com/example/service.git",
                ref: resolvedCommit,
                resolvedCommit,
                path: ".",
                archiveRef: "fixture",
                archiveDigest: `sha256:${"0".repeat(64)}`,
                archiveSizeBytes: 1,
                fetchedByRunId: "run_sync_e2e",
                fetchedAt: now,
              },
            ],
          },
        });
      }
      if (
        path ===
          "/api/v1/sources/src_install_e2e/snapshots/snap_install_e2e/install-modules" &&
        request.method() === "GET"
      ) {
        installModuleRequests.push(path);
        return route.fulfill({
          json: {
            status: "ready",
            sourceSnapshotId: "snap_install_e2e",
            scopePath: ".",
            modules: [
              {
                path: ".",
                providerPackages: [
                  {
                    source: "registry.opentofu.org/cloudflare/cloudflare",
                  },
                ],
                rootProviderRequirements: [
                  {
                    source: "registry.opentofu.org/cloudflare/cloudflare",
                    moduleLocalName: "cloudflare",
                  },
                ],
              },
              {
                path: "deploy/takoform",
                providerPackages: [
                  {
                    source: "registry.opentofu.org/aws/aws",
                  },
                  {
                    source: "registry.opentofu.org/cloudflare/cloudflare",
                    version: "4.0.0",
                  },
                ],
                rootProviderRequirements: [
                  {
                    source: "registry.opentofu.org/aws/aws",
                    moduleLocalName: "aws",
                  },
                  {
                    source: "registry.opentofu.org/cloudflare/cloudflare",
                    moduleLocalName: "cloudflare",
                    childAlias: "edge",
                    version: "4.0.0",
                  },
                ],
              },
            ],
          },
        });
      }
      if (path === "/api/v1/sources/src_install_e2e/compatibility-check") {
        compatibilityBodies.push(request.postDataJSON());
        return route.fulfill({
          json: {
            run: {
              id: "ccr_install_e2e",
              type: "compatibility_check",
              status: "succeeded",
              compatibilityReportId: "caprep_install_e2e",
            },
            report: {
              id: "caprep_install_e2e",
              level: "ready",
              findings: [],
              providerPackages: [],
              rootProviderRequirements: [],
              resources: [],
              rootModuleVariables: ["region"],
            },
            repositoryInstallUx: {
              status: "accepted",
              installConfigId: "cfg_install_e2e",
            },
          },
        });
      }
      if (path === "/api/v1/capsule-configs/cfg_install_e2e") {
        return route.fulfill({
          json: {
            installConfig: {
              id: "cfg_install_e2e",
              name: "example-service",
              policy: {},
              variableMapping: {},
              variablePresentation: [
                {
                  name: "region",
                  type: "string",
                  required: true,
                  label: { ja: "リージョン", en: "Region" },
                  defaultValue: "initial",
                },
              ],
              outputAllowlist: {},
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
      if (
        path === "/api/v1/workspaces/ws_alpha/install-plans" &&
        request.method() === "POST"
      ) {
        const body = request.postDataJSON() as Record<string, unknown>;
        installPlanBodies.push(body);
        installPlanKeys.push(request.headers()["idempotency-key"]);
        if (retryMode !== "none" && installPlanBodies.length === 1) {
          return route.fulfill({ status: 504, json: {
            error: { code: "git_install_plan_timeout", message: "Timed out" },
          } });
        }
        return route.fulfill({
          status: 201,
          json: {
            installPlan: {
              id: "install_plan_e2e",
              workspaceId: "ws_alpha",
              createdBy: "portable-e2e",
              requestDigest: `sha256:${"3".repeat(64)}`,
              source: body.source,
              capsule: body.capsule,
              options: body.options ?? {},
              preflight: body.preflight,
              sourceId: "src_install_e2e",
              sourceSnapshotId: "snap_install_e2e",
              installConfigId: "cfg_install_e2e",
              capsuleId: "cap_install_e2e",
              planRunId: "run_plan_e2e",
              phase: "reviewable",
              generation: 1,
              createdAt: now,
              updatedAt: now,
            },
            nextAction: "review_run",
            links: {
              self: "/api/v1/install-plans/install_plan_e2e",
              run: "/api/v1/runs/run_plan_e2e",
            },
          },
        });
      }
      return route.fallback();
    });

    const handoff = new URLSearchParams({
      tcsBase: "https://store.example.test",
      tcsListing: "example/service",
    });
    await page.goto(`/new?${handoff}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    const hostingOption = page.getByRole("combobox", {
      name: /プロバイダー|Provider/u,
    });
    await expect(hostingOption).toHaveCount(0);
    expect(prematureConfigReads).toEqual([]);
    await prepareInlineFixture(page);
    const moduleChooser = page.getByTestId("install-module-chooser");
    // This revision's tracked OpenTofu files expose two root modules, so the
    // chooser is where the destination comes from. A Store listing that
    // reviewed one of them makes that module the preselected choice; it never
    // replaces the repository's other roots with a single entry path.
    await expect(moduleChooser).toBeVisible();
    expect(sourceAutoSyncPatchBodies).toEqual([]);
    // No compatibility check may run before the user confirms a module.
    expect(seenMutations).not.toContain(
      "POST /api/v1/sources/src_install_e2e/compatibility-check",
    );
    const moduleOption = moduleChooser.getByRole("combobox", {
      name: /モジュールディレクトリ|Module directory/u,
    });
    await expect(moduleOption).toHaveValue(
      reviewedModule?.exposed ? reviewedModule.path : "",
    );
    // Each candidate carries the provider set derived from that exact scanned
    // directory, so the choice names the destination instead of a bare path:
    // the Cloudflare root and the takoform root stay selectable either way.
    await expect(moduleOption.locator("option")).toHaveText([
      /モジュールディレクトリ|Module directory/u,
      ". — Cloudflare",
      "deploy/takoform — AWS, Cloudflare",
    ]);
    await moduleOption.selectOption("deploy/takoform");
    await moduleChooser
      .getByRole("button", {
        name: /このモジュールで続ける|Continue with this module/u,
      })
      .click();
    await expect
      .poll(() => compatibilityBodies.length)
      .toBe(1);
    await expect
      .poll(() => installModuleRequests.length)
      .toBe(1);
    expect(installModuleRequests).toEqual([
      "/api/v1/sources/src_install_e2e/snapshots/snap_install_e2e/install-modules",
    ]);
    expect(compatibilityBodies[0]).toMatchObject({
      compileInstallUx: true,
      modulePath: "deploy/takoform",
      sourceSnapshotId: "snap_install_e2e",
    });
    await expect(
      page.getByTestId("install-configuration").getByRole("heading", { name: /^(設定|Settings)$/u }),
    ).toBeVisible();
    await page.getByLabel(/リージョン|Region/u).fill("edited");
    await reviewInlineFixture(page);
    await expect
      .poll(() =>
        seenMutations.includes("POST /api/v1/workspaces/ws_alpha/install-plans"),
      )
      .toBe(true);
    expect(installPlanBodies).toEqual([
      expect.objectContaining({
        options: expect.objectContaining({ modulePath: "deploy/takoform" }),
        preflight: {
          sourceId: "src_install_e2e",
          sourceSnapshotId: "snap_install_e2e",
          compatibilityCheckRunId: "ccr_install_e2e",
          compatibilityReportId: "caprep_install_e2e",
          installConfigId: "cfg_install_e2e",
        },
        variables: { region: "edited" },
      }),
    ]);
    if (retryMode !== "none") {
      const next = installSheetActions(page).getByRole("button", { name: /^(内容を確認|Review)$/u });
      await expect(next).toBeEnabled();
      expect(installPlanBodies).toHaveLength(1);
      if (retryMode === "edited") await page.getByLabel(/リージョン|Region/u).fill("changed-again");
      await next.click();
      await expect.poll(() => installPlanBodies.length).toBe(2);
      expect(installPlanKeys[0]).toBeTruthy();
      if (retryMode === "unchanged") {
        expect(installPlanBodies[1]).toEqual(installPlanBodies[0]);
        expect(installPlanKeys[1]).toBe(installPlanKeys[0]);
      } else {
        expect(installPlanBodies[1]).toMatchObject({ variables: { region: "changed-again" } });
        expect(installPlanKeys[1]).not.toBe(installPlanKeys[0]);
      }
      expect(compatibilityBodies).toHaveLength(1);
    }
    expect(seenMutations).not.toContain(
      "POST /api/v1/workspaces/ws_alpha/capsules",
    );
    expect(seenMutations).not.toContain(
      "PUT /api/v1/capsules/cap_install_e2e/provider-bindings",
    );
    expect(seenMutations).not.toContain(
      "POST /api/v1/capsules/cap_install_e2e/plan",
    );
    expectSingleSourceCreate(sourceState);
    expect(stableRefResolutionBodies).toEqual([
      { url: "https://github.com/example/service" },
    ]);
    expect(sourcePostBodies).toEqual([
      expect.objectContaining({
        defaultRef: resolvedCommit,
        defaultPath: ".",
        autoSync: false,
      }),
    ]);
    await expect.poll(() => sourceAutoSyncPatchBodies).toEqual([
      { autoSync: true },
    ]);
    const installPlanMutationIndex = seenMutations.lastIndexOf(
      "POST /api/v1/workspaces/ws_alpha/install-plans",
    );
    const sourcePatchMutationIndex = seenMutations.lastIndexOf(
      "PATCH /api/v1/sources/src_install_e2e",
    );
    expect(installPlanMutationIndex).toBeGreaterThanOrEqual(0);
    expect(sourcePatchMutationIndex).toBeGreaterThan(installPlanMutationIndex);
    expect(syncBodies).toEqual([{ expectedRef: resolvedCommit }]);
  });
  };
  storeSetupRetryTest("none");
  storeSetupRetryTest("unchanged");
  storeSetupRetryTest("edited");
  // Store handoff: a reviewed module the snapshot proves is preselected, a
  // stale entry falls back to the scan's own choice, and in both cases every
  // root module of the scanned revision stays selectable.
  storeSetupRetryTest("none", { path: "deploy/takoform", exposed: true });
  storeSetupRetryTest("none", { path: "deploy/moved", exposed: false });

  test("Workload settings submit one complete Configuration Plan and open its Run review", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the deterministic configuration authority fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const now = "2026-08-05T00:00:00.000Z";
    const capsuleId = "cap_repository_office";
    const installConfigId = `cfg_${capsuleId}`;
    const sourceId = `src_${capsuleId}`;
    const planRunId = "run_configuration_plan_e2e";
    const authorityGuard = `sha256:${"a".repeat(64)}`;
    const stateVersionId = "sv_configuration_e2e";
    let multipleSurfaces = false;
    const configurationPlanBodies: unknown[] = [];
    const seenMutations: string[] = [];
    const capsule = {
      id: capsuleId,
      workspaceId: "ws_alpha",
      name: PORTABLE_EXPECTATIONS.appName,
      slug: "repository-office",
      sourceId,
      installConfigId,
      environment: "production",
      currentStateVersionId: stateVersionId,
      currentStateGeneration: 1,
      status: "active",
      freshness: "fresh",
      createdAt: now,
      updatedAt: now,
    };
    const stateVersion = {
      id: stateVersionId,
      workspaceId: "ws_alpha",
      capsuleId,
      environment: "production",
      generation: 1,
      createdByRunId: "run_original_apply",
      createdAt: now,
    };

    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (
        shouldRecordControlPlaneMutation(
          mode,
          mutationOrigin,
          request.url(),
          request.method(),
        )
      ) {
        seenMutations.push(`${request.method()} ${path}`);
      }
      if (path === `/api/v1/capsules/${capsuleId}`) {
        return route.fulfill({
          json: {
            capsule,
            installConfigReAdoption: { authorityGuard },
          },
        });
      }
      if (path === `/api/v1/state-versions/${stateVersionId}`) {
        return route.fulfill({ json: { stateVersion } });
      }
      if (path === `/api/v1/capsules/${capsuleId}/state-versions`) {
        return route.fulfill({ json: { stateVersions: [stateVersion] } });
      }
      if (
        path === `/api/v1/capsules/${capsuleId}/backups` &&
        request.method() === "POST"
      ) {
        return route.fulfill({
          status: 201,
          json: {
            backup: {
              id: "bkp_partial_export_e2e",
              workspaceId: "ws_alpha",
              capsuleId,
              environment: "production",
              ref: "backup_control/ws_alpha/bkp_partial_export_e2e/control.tar.zst",
              digest: `sha256:${"b".repeat(64)}`,
              sizeBytes: 256,
              createdAt: now,
            },
          },
        });
      }
      if (path === `/api/v1/capsules/${capsuleId}/current-resource-inventory`) {
        return route.fulfill({
          json: {
            inventory: {
              kind: "takosumi.capsule-current-resource-inventory@v1",
              capsuleId,
              workspaceId: "ws_alpha",
              environment: "production",
              stateVersionId,
              generation: 1,
              applyRunId: "run_original_apply",
              planRunId: "run_original_plan",
              recordedAt: now,
              availability: "recorded",
              resources: [],
            },
          },
        });
      }
      if (path === "/api/v1/workspaces/ws_alpha/ui-surfaces" && multipleSurfaces) {
        const original = PORTABLE_UI_SURFACES.ws_alpha[0];
        const surface = (id: string, title: string, sortOrder: number) => ({
          ...original,
          metadata: { ...original.metadata, id: `if_${id}`, name: `app.${id}` },
          spec: {
            ...original.spec,
            document: { launcher: true, display: { title, sortOrder } },
            inputs: { url: { source: "capsule_output", capsuleId, outputName: `${id}_url` } },
          },
          status: { ...original.status, resolvedInputs: { url: `https://apps.example.test/${id}` } },
        });
        // The API order differs from the Interface's declared primary order.
        return route.fulfill({
          json: { interfaces: [surface("documentation", "Documentation", 20), surface("control", "Control panel", 10)] },
        });
      }
      if (path === "/api/v1/workspaces/ws_alpha/graph") {
        return route.fulfill({ json: { nodes: [], edges: [] } });
      }
      if (path === `/api/v1/capsule-configs/${installConfigId}`) {
        return route.fulfill({
          json: {
            installConfig: {
              id: installConfigId,
              workspaceId: "ws_alpha",
              name: PORTABLE_EXPECTATIONS.appName,
              sourceSelector: {
                kind: "git",
                url: "https://github.com/example/repository-office.git",
                ref: PORTABLE_SOURCE_COMMIT,
                path: ".",
              },
              policy: {},
              variableMapping: { region: "initial" },
              variablePresentation: [
                {
                  name: "region",
                  type: "string",
                  required: true,
                  label: { ja: "リージョン", en: "Region" },
                },
              ],
              outputAllowlist: {},
              interfaceBlueprints: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
      if (path === `/api/v1/capsules/${capsuleId}/provider-bindings`) {
        return route.fulfill({
          json: {
            providerBindingSet: {
              id: "pbs_configuration_plan_e2e",
              workspaceId: "ws_alpha",
              capsuleId,
              environment: "production",
              bindings: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
      if (path === `/api/v1/capsules/${capsuleId}/usage-summary`) {
        return route.fulfill({
          json: {
            summary: {
              capsuleId,
              usdMicros: 0,
              eventCount: 0,
              ratedEventCount: 0,
              unratedEventCount: 0,
            },
          },
        });
      }
      if (path === "/api/v1/sources") {
        return route.fulfill({
          json: {
            sources: [
              {
                id: sourceId,
                workspaceId: "ws_alpha",
                name: PORTABLE_EXPECTATIONS.appName,
                url: "https://github.com/example/repository-office.git",
                defaultRef: PORTABLE_SOURCE_COMMIT,
                defaultPath: ".",
                status: "active",
                autoSync: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        });
      }
      if (path === "/api/v1/provider-connections") {
        return route.fulfill({ json: { providerConnections: [] } });
      }
      if (
        path === `/api/v1/capsules/${capsuleId}/configuration-plans` &&
        request.method() === "POST"
      ) {
        configurationPlanBodies.push(request.postDataJSON());
        return route.fulfill({
          status: 201,
          json: {
            capsule: { ...capsule, installConfigId: "cfg_configuration_e2e" },
            configurationPlan: {
              replayed: false,
              previousInstallConfigId: installConfigId,
              targetInstallConfigId: "cfg_configuration_e2e",
              sourceSnapshotId: "snap_configuration_e2e",
              planRunId,
            },
            links: { run: `/api/v1/runs/${planRunId}` },
          },
        });
      }
      if (path === `/api/v1/runs/${planRunId}`) {
        return route.fulfill({
          json: {
            run: {
              id: planRunId,
              workspaceId: "ws_alpha",
              capsuleId,
              type: "plan",
              status: "succeeded",
              summary: { add: 0, change: 1, destroy: 0 },
              policyStatus: "pass",
              createdBy: "portable-e2e",
              createdAt: now,
            },
          },
        });
      }
      if (path === `/api/v1/runs/${planRunId}/logs`) {
        return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
      }
      if (path === `/api/v1/runs/${planRunId}/cost`) {
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
      if (path === `/api/v1/runs/${planRunId}/stream`) {
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: "",
        });
      }
      if (
        path === "/api/v1/workspaces/ws_alpha/runs" &&
        url.searchParams.get("limit") === "200"
      ) {
        return route.fulfill({ json: { runs: [] } });
      }
      return route.fallback();
    });

    await page.setViewportSize({ width: 1180, height: 757 });
    await gotoDashboardDocument(page, `/workloads/${capsuleId}`);
    const header = page.locator(".tg-page-header");
    const openApp = page.getByRole("link", { name: /Open Repository Office|Repository Office.*開/u });
    await expect(openApp).toBeVisible();
    await expect(openApp).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
    await expect(openApp).toHaveAttribute("rel", "noreferrer noopener");
    const openBox = await openApp.boundingBox();
    expect(openBox!.y, "Open app belongs in the visible header").toBeLessThan(300);
    const urlDetails = page.locator("details").filter({
      has: page.locator("summary", { hasText: /URLとアクセス情報|URLs and access information/u }),
    });
    await expect(urlDetails).not.toHaveAttribute("open");
    await expect(urlDetails.locator("code")).toBeHidden();
    await expect(page.getByRole("button", { name: /削除の確認|Review deletion/u })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("overview-1180.png") });
    await urlDetails.locator("summary").click();
    await expect(urlDetails.locator("code")).toHaveText(PORTABLE_EXPECTATIONS.appUrl);
    await expect(urlDetails.locator(".muted")).toBeVisible();
    multipleSurfaces = true;
    await page.reload({ waitUntil: "domcontentloaded" });
    const namedOpen = header.getByRole("link", { name: "Open Control panel in a new tab" });
    await expect(namedOpen).toBeVisible();
    await expect(namedOpen).toContainText("Control panel");
    await expect(namedOpen).toHaveAttribute("href", "https://apps.example.test/control");
    await expect(header.locator(".tg-btn-primary")).toHaveCount(1);
    await expect(urlDetails).not.toHaveAttribute("open");
    await expect(header.getByRole("link", { name: "Open Documentation in a new tab" })).toHaveCount(0);
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(namedOpen).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: test.info().outputPath("overview-multiple-768.png") });
    await page.setViewportSize({ width: 1180, height: 757 });
    multipleSurfaces = false;
    // Bookmarked /danger routes still reach the warning and the same delete flow.
    await page.goto(`/workloads/${capsuleId}/danger`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/workloads/${capsuleId}/settings#delete$`, "u"));
    const deletion = page.locator("details#delete");
    await expect(deletion).toHaveAttribute("open", "");
    await expect(deletion.getByRole("button", { name: /削除の確認|Review deletion/u })).toBeVisible();
    await expect(deletion).toContainText(PORTABLE_EXPECTATIONS.appName);
    await expect(page.getByRole("button", { name: /削除の確認|Review deletion/u })).toHaveCount(1);
    await expect(header.getByRole("link", { name: /削除|Delete/u })).toHaveCount(0);
    expect(seenMutations).toEqual([]);

    await gotoDashboardDocument(page, `/workloads/${capsuleId}/deploys`);
    const versionCard = page.locator(".tg-card").filter({
      has: page.locator(".tg-card-title", { hasText: /^(取得元のバージョン|Source version)$/u }),
    });
    await expect(versionCard).toHaveCount(1);
    const trackedRef = versionCard.locator("code", { hasText: PORTABLE_SOURCE_COMMIT });
    const changeVersion = versionCard.locator("summary", { hasText: /^(バージョンを変更|Change version)$/u });
    const updateReview = versionCard.getByRole("button", { name: /^(変更を確認|Review changes)$/u });
    await expect(trackedRef).toBeVisible();
    await expect(changeVersion).toBeVisible();
    await expect(updateReview).toBeEnabled();
    expect((await trackedRef.boundingBox())!.y).toBeLessThan((await changeVersion.boundingBox())!.y);
    expect((await changeVersion.boundingBox())!.y).toBeLessThan((await updateReview.boundingBox())!.y);
    const revision = versionCard.getByRole("textbox", { name: /ブランチ・タグ・コミット|Git ref/u, includeHidden: true });
    await expect(revision).toBeHidden();
    await changeVersion.click();
    await expect(revision).toBeVisible();
    await revision.fill("v1.2.3");
    await expect(versionCard.getByRole("button", { name: /このバージョンを確認|Review this version/u })).toBeEnabled();
    expect(seenMutations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("updates-1180.png") });

    const exportActions = versionCard.locator("details").filter({
      has: page.locator("summary", { hasText: /^(必要なときだけ使う操作|Extra actions)$/u }),
    });
    await exportActions.locator("summary").click();
    await expect(exportActions).toContainText(/ワークスペースの管理情報の一部|selected workspace management records/u);
    await expect(exportActions).toContainText(/このデータの取り込み・復元には対応していません|This export cannot be imported or used to restore a service/u);
    const createExport = exportActions.getByRole("button", { name: /^(管理情報の一部を書き出す|Create partial export)$/u });
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(createExport).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    }
    await createExport.click();
    const exportNotice = versionCard.locator(".wa-notice");
    await expect(exportNotice).toContainText(/管理情報の一部を書き出しました|Partial export created/u);
    await expect(exportNotice).toContainText(/このデータの取り込み・復元には対応していません|This export cannot be imported or used to restore a service/u);
    await expect(exportNotice.locator("code")).toBeHidden();
    await expect(exportNotice.locator("summary")).toHaveText(/^(書き出し ID|Export ID)$/u);
    expect(seenMutations).toEqual([`POST /api/v1/capsules/${capsuleId}/backups`]);
    await page.screenshot({ path: test.info().outputPath("partial-export-768.png") });
    await page.setViewportSize({ width: 1180, height: 757 });

    await gotoDashboardDocument(
      page,
      `/workloads/${capsuleId}/settings`,
    );
    const region = page.getByRole("textbox", { name: /^(リージョン|Region)$/u });
    await expect(region).toHaveValue("initial");
    await expect(page.locator(".tg-card-title").filter({ hasText: /^(設定値|Settings)$/u })).toHaveCount(1);
    await expect(page.locator("code", { hasText: /^region$/u })).toBeHidden();
    const autoUpdate = page.locator("details").filter({
      has: page.locator("summary", { hasText: /自動更新|Automatic updates/u }),
    });
    await expect(autoUpdate).not.toHaveAttribute("open");
    expect((await region.boundingBox())!.y).toBeLessThan((await autoUpdate.boundingBox())!.y);
    await expect(deletion).not.toHaveAttribute("open");
    await page.screenshot({ path: test.info().outputPath("settings-1180.png") });
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(region).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1180, height: 757 });
    await region.fill("edited");
    await page
      .getByRole("button", { name: /変更を確認|Review changes/u })
      .click();

    await expect.poll(() => configurationPlanBodies.length).toBe(1);
    expect(configurationPlanBodies).toEqual([
      {
        variablePatch: { set: { region: "edited" }, remove: [] },
        providerBindings: [],
        interfaceBlueprints: [],
        expected: { authorityGuard },
      },
    ]);
    expect(seenMutations).toEqual([
      `POST /api/v1/capsules/${capsuleId}/backups`,
      `POST /api/v1/capsules/${capsuleId}/configuration-plans`,
    ]);
    await expect(page).toHaveURL(new RegExp(`/runs/${planRunId}$`, "u"));
    await expect(
      page.getByRole("heading", { name: /変更内容を確認|Review changes/u }),
    ).toBeVisible();
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("manual Git module input survives preparation reset and submits its scanned path", async ({ page }) => {
    test.skip(mode !== "portable", "the deterministic direct Git install fixture is portable-only");
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const state = await stubProviderDestinationFixture(page, [], [], {
      modulePath: "deploy/selected",
    });
    const query = new URLSearchParams({
      git: "https://github.com/tako0614/yurucommu.git",
      ref: PORTABLE_SOURCE_COMMIT,
      name: "yurucommu",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.locator("summary").filter({ hasText: /取得元と版|Source and version/u }).click();
    const modulePath = page.getByRole("textbox", { name: /モジュールのフォルダ|Module folder/u });
    await modulePath.fill("");
    await modulePath.pressSequentially("deploy/selected");
    await expect(modulePath).toHaveValue("deploy/selected");
    await prepareInlineFixture(page);
    await expect.poll(() => state.compatibilityBodies.length).toBe(1);
    expect(state.compatibilityBodies[0]).toMatchObject({
      modulePath: "deploy/selected",
      sourceSnapshotId: "snap_provider_destination_e2e",
    });
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("direct Git installs submit the exact scanned module path", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the deterministic direct Git install fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const state = await stubProviderDestinationFixture(page, [], [], {
      sourcePath: "infra",
      modulePath: "deploy/selected",
    });
    const query = new URLSearchParams({
      git: "https://github.com/tako0614/yurucommu.git",
      ref: PORTABLE_SOURCE_COMMIT,
      sourcePath: "infra",
      path: "deploy/selected",
      name: "yurucommu",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("install-module-chooser")).toHaveCount(0);

    await prepareInlineFixture(page);
    await expect
      .poll(() => state.sourcePosts.length)
      .toBe(1);
    expect(state.sourcePosts).toEqual(["/api/v1/sources"]);
    await expect
      .poll(() => state.installModuleRequests.length)
      .toBe(1);
    expect(state.installModuleRequests).toEqual([
      "/api/v1/sources/src_provider_destination_e2e/snapshots/snap_provider_destination_e2e/install-modules",
    ]);
    await expect
      .poll(() => state.compatibilityBodies.length)
      .toBe(1);
    expect(state.compatibilityBodies[0]).toMatchObject({
      compileInstallUx: true,
      modulePath: "deploy/selected",
      sourceSnapshotId: "snap_provider_destination_e2e",
    });
    expect(state.sourceCreateBodies).toEqual([
      expect.objectContaining({ defaultPath: "infra" }),
    ]);
    expect(state.sourcePosts).toEqual(["/api/v1/sources"]);
    await expectSourceAutoSyncOptInAfterPlan(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("shows the repository-owned installed app and its launch URL", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const app = page
      .locator('a.av-tile[target="_blank"]')
      .filter({ hasText: expectations.appName })
      .first();
    await expect(app).toBeVisible();
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
        name: /Service not found|サービスが見つかりません/u,
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
      page.locator("a.av-tile").filter({ hasText: expectations.appName }).first(),
    ).toBeVisible();
    await assertNoPageErrors(errors);
  });

  test("a failed Workspace list read keeps the current Workspace selected", async ({
    page,
  }) => {
    test.skip(mode !== "portable", "synthetic list failures are portable-only");
    const errors = pageErrors(page);
    const appTile = page
      .locator("a.av-tile")
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

    // An available update is said in words on the tile, not only as a dot.
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
      .locator("a.av-tile")
      .filter({ hasText: expectations.appName })
      .first();
    await expect(tile).toContainText(/Update available|更新があります/u);
    await expect(tile.locator(".av-tile-dot")).toBeVisible();
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

registerInstallDetailCases(mode, (page, needsProvider) => stubProviderDestinationFixture(
  page,
  [],
  needsProvider ? [{ source: "registry.opentofu.org/cloudflare/cloudflare", moduleLocalName: "cloudflare", credentialRequired: true }] : [],
  { resources: [{ type: "cloudflare_workers_script", count: 1, allowed: true }, { type: "cloudflare_d1_database", count: 2, allowed: true }] },
));
