import {
  expect,
  request as apiRequest,
  test,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
  PORTABLE_SOURCE_OPTIONS_COMMIT,
  PORTABLE_SOURCE_OPTION_DOCUMENTS,
} from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import {
  shouldRecordControlPlaneMutation,
  type DashboardE2EMode,
} from "./traffic-policy.ts";
import { validateExpectedWorkerVersionId } from "../../../scripts/dashboard-browser-e2e/live-inputs.ts";
import { assertExpectedResponseUrl } from "../../../scripts/dashboard-browser-e2e/version-contract.ts";

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
    ? "http://127.0.0.1:4179"
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
async function gotoPublicDocument(page: Page, path: string): Promise<void> {
  const requestedUrl = new URL(path, mutationOrigin);
  const expectedReturn = encodeURIComponent(
    requestedUrl.pathname + requestedUrl.search,
  );
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
    .getByRole("button", { name: /ワークスペースを切り替え|Switch workspace/u })
    .first();
}

type SourceOptionsFixture =
  (typeof PORTABLE_SOURCE_OPTION_DOCUMENTS)[keyof typeof PORTABLE_SOURCE_OPTION_DOCUMENTS];

const SOURCE_OPTIONS_DIGEST = `sha256:${"1".repeat(64)}`;

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

/** Stub only the public source/snapshot projections needed by the real chooser. */
async function stubSourceOptionsRead(
  page: Page,
  fixture: SourceOptionsFixture,
): Promise<SourceCreateFixtureState> {
  const sourceId = `src_options_${fixture.metadata.name}`;
  const snapshotId = `snap_options_${fixture.metadata.name}`;
  const syncRunId = `run_options_${fixture.metadata.name}`;
  const fileText = JSON.stringify(fixture);
  const state: SourceCreateFixtureState = {
    sourceListReads: [],
    sourcePosts: [],
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (
      path === "/api/v1/sources" &&
      request.method() === "GET" &&
      url.search === "?workspaceId=ws_alpha&limit=100"
    ) {
      state.sourceListReads.push(`${path}${url.search}`);
      return route.fulfill({ json: { sources: [] } });
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
              url: fixture.options[0]!.source.url,
              ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
              resolvedCommit: PORTABLE_SOURCE_OPTIONS_COMMIT,
              path: ".",
              archiveRef: "fixture",
              archiveDigest: SOURCE_OPTIONS_DIGEST,
              archiveSizeBytes: fileText.length,
              fetchedByRunId: syncRunId,
              fetchedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        },
      });
    }
    if (path === `/api/v1/sources/${sourceId}/snapshots/${snapshotId}/file`) {
      return route.fulfill({
        json: {
          sourceSnapshotId: snapshotId,
          path: url.searchParams.get("path"),
          text: fileText,
          digest: SOURCE_OPTIONS_DIGEST,
          sizeBytes: fileText.length,
        },
      });
    }
    return route.fallback();
  });
  return state;
}

interface ProviderDestinationFixtureState extends SourceCreateFixtureState {
  readonly mutations: string[];
  readonly compatibilityBodies: unknown[];
  readonly profileDiscoveryRequests: string[];
  bindingBody?: { readonly bindings?: readonly Record<string, unknown>[] };
}

interface ProviderDestinationFixtureOptions {
  readonly deploymentProfiles?: readonly {
    readonly key: string;
    readonly label: { readonly ja: string; readonly en: string };
    readonly description: { readonly ja: string; readonly en: string };
    readonly order: number;
    readonly recommended: boolean;
  }[];
}

/** Stub a complete manual source check while retaining mutation ordering. */
async function stubProviderDestinationFixture(
  page: Page,
  providerConnections = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  compatibilityProviders: readonly Record<string, unknown>[] = [
    {
      source: "cloudflare/cloudflare",
      aliases: [],
      allowed: true,
      credentialRequired: true,
    },
  ],
  options: ProviderDestinationFixtureOptions = {},
): Promise<ProviderDestinationFixtureState> {
  const state: ProviderDestinationFixtureState = {
    mutations: [],
    compatibilityBodies: [],
    profileDiscoveryRequests: [],
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
              ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
              resolvedCommit: PORTABLE_SOURCE_OPTIONS_COMMIT,
              path: ".",
              archiveRef: "fixture",
              archiveDigest: SOURCE_OPTIONS_DIGEST,
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
        `/api/v1/sources/${sourceId}/snapshots/${snapshotId}/deployment-profiles` &&
      request.method() === "GET"
    ) {
      state.profileDiscoveryRequests.push(path);
      return route.fulfill({
        json: options.deploymentProfiles
          ? { status: "ready", profiles: options.deploymentProfiles }
          : { status: "none", profiles: [] },
      });
    }
    if (path === `/api/v1/sources/${sourceId}/compatibility-check`) {
      state.compatibilityBodies.push(request.postDataJSON());
      return route.fulfill({
        json: {
          report: {
            id: "report_provider_destination_e2e",
            level: "ready",
            findings: [],
            providers: compatibilityProviders,
            resources: [],
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
      path === "/api/v1/workspaces/ws_alpha/capsules" &&
      request.method() === "POST"
    ) {
      return route.fulfill({
        json: {
          capsule: {
            id: "cap_provider_destination_e2e",
            workspaceId: "ws_alpha",
            name: sourceName,
            slug: sourceName,
            environment: "production",
            sourceId,
            installConfigId: "cfg-default-opentofu-capsule",
            status: "pending",
            currentStateGeneration: 0,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    }
    if (
      path ===
        "/api/v1/capsules/cap_provider_destination_e2e/provider-bindings" &&
      request.method() === "PUT"
    ) {
      state.bindingBody = request.postDataJSON() as ProviderDestinationFixtureState["bindingBody"];
      return route.fulfill({
        json: {
          providerBindingSet: {
            id: "binding-set-provider-destination-e2e",
            workspaceId: "ws_alpha",
            capsuleId: "cap_provider_destination_e2e",
            environment: "production",
            bindings: state.bindingBody?.bindings ?? [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    }
    if (
      path === "/api/v1/capsules/cap_provider_destination_e2e/plan" &&
      request.method() === "POST"
    ) {
      return route.fulfill({ json: { run: { id: planRunId } } });
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
    return route.fallback();
  });
  return state;
}

test.describe("Takosumi dashboard browser surface", () => {
  test.skip(
    mode === "public-live",
    "public-live is an unauthenticated read-only profile",
  );

  test("authenticates through dashboard bootstrap and switches Workspace scope", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const bootstrap = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/dashboard/bootstrap" &&
        response.status() === 200
      );
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
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

    for (const path of ["/settings", "/workloads", "/advanced/workspace", "/new"]) {
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
    await expect(page.getByLabel(/Ref \(optional\)|ref（省略可）/u)).toHaveValue(
      "0123456789abcdef0123456789abcdef01234567",
    );
    await expect(page.getByLabel(/Module path|module path/u)).toHaveValue(
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

  test("keeps the current Workspace name visible on compact widths and disambiguates duplicates", async ({
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
      await expect(trigger.locator(".topbar-workspace-name")).toContainText(
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
        .getByRole("menuitem", { name: /新しいワークスペース|New workspace/u })
        .click();
      const dialog = page.getByRole("dialog").first();
      const form = dialog.locator("form.topbar-workspace-create");
      const input = dialog.getByRole("textbox", {
        name: /用途または名前|Purpose or name/u,
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
    await page.goto("/new", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        name: /サービスを探す|Find a service/u,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("undefined.trim");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: /サービスを追加|Add a service/u }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
      "the install view must not overflow the mobile viewport",
    ).toBeLessThanOrEqual(1);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("opening a repository chooser link performs no control-plane mutation", async ({
    page,
  }) => {
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
        mutations.push(
          `${request.method()} ${new URL(request.url()).pathname}`,
        );
      }
    });
    const query = new URLSearchParams({
      kind: "capsule-source-options",
      git: "https://github.com/example/choices.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
      path: "takosumi/install-options.json",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        name: /追加候補を確認|Review the available choices/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /候補を読み込む|Load choices/u,
      }),
    ).toBeVisible();
    expect(
      mutations,
      "opening the link must not create a Source or Run",
    ).toEqual([]);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("Takos source options keep Portable cloud and Cloudflare direct distinct", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the immutable product chooser fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.addInitScript(() => {
      localStorage.setItem("takosumi.currentWorkspaceId", "ws_alpha");
    });
    const fixture = PORTABLE_SOURCE_OPTION_DOCUMENTS.takos;
    const state = await stubSourceOptionsRead(page, fixture);
    const query = new URLSearchParams({
      kind: "capsule-source-options",
      git: fixture.options[0]!.source.url,
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: "install-options.json",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: /候補を読み込む|Load choices/u })
      .click();

    const cards = page.locator(".iv-entry-card");
    await expect(page.getByRole("heading", { name: fixture.metadata.title })).toBeVisible();
    await expect(cards).toHaveCount(fixture.options.length);
    await expect(cards.nth(0)).toContainText("Portable cloud");
    await expect(cards.nth(1)).toContainText("Cloudflare (direct)");
    await expect(cards.nth(0)).toContainText(fixture.options[0]!.source.url);
    await expect(cards.nth(1)).toContainText(fixture.options[1]!.source.url);
    await expect(cards.nth(0)).not.toContainText("github.com/tako0614/yurucommu");
    await expect(cards.nth(1)).not.toContainText("github.com/tako0614/yurucommu");
    await expect(page.locator(".iv-entry-card").filter({ hasText: "Yurucommu" })).toHaveCount(0);
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("Yurucommu source options keep Takosumi hosted service and Cloudflare direct distinct", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the immutable product chooser fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.addInitScript(() => {
      localStorage.setItem("takosumi.currentWorkspaceId", "ws_alpha");
    });
    const fixture = PORTABLE_SOURCE_OPTION_DOCUMENTS.yurucommu;
    const state = await stubSourceOptionsRead(page, fixture);
    const query = new URLSearchParams({
      kind: "capsule-source-options",
      git: fixture.options[0]!.source.url,
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: "install-options.json",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: /候補を読み込む|Load choices/u })
      .click();

    const cards = page.locator(".iv-entry-card");
    await expect(page.getByRole("heading", { name: fixture.metadata.title })).toBeVisible();
    await expect(cards).toHaveCount(fixture.options.length);
    await expect(cards.nth(0)).toContainText("Takosumi hosted service");
    await expect(cards.nth(1)).toContainText("Cloudflare (direct)");
    await expect(cards.nth(0)).toContainText(fixture.options[0]!.source.url);
    await expect(cards.nth(1)).toContainText(fixture.options[1]!.source.url);
    await expect(cards.nth(0)).not.toContainText("github.com/tako0614/takos.git");
    await expect(cards.nth(1)).not.toContainText("github.com/tako0614/takos.git");
    await expect(page.locator(".iv-entry-card").filter({ hasText: "Portable cloud" })).toHaveCount(0);
    expectSingleSourceCreate(state);
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
          source: "cloudflare/cloudflare-v02",
          aliases: [],
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /追加|Add/u }).click();

    await expect(
      page.getByRole("heading", {
        name: /Host \/ accountを選択|Choose a Host \/ account/u,
      }),
    ).toBeVisible();
    const destinationControl = page.getByLabel(/Host \/ account/u);
    await expect(destinationControl).toHaveValue("");
    await expect(destinationControl.locator("option")).toContainText([
      "Cloudflare account A",
      "Cloudflare account B",
    ]);
    await destinationControl.selectOption("pc_cloudflare_account_b_v02");
    await page.getByRole("button", { name: /続ける|Continue/u }).click();

    await expect
      .poll(() => state.bindingBody?.bindings)
      .toEqual([
        {
          provider: "cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          connectionId: "pc_cloudflare_account_b_v02",
        },
      ]);
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    await expect
      .poll(() => state.mutations.indexOf("PUT /api/v1/capsules/cap_provider_destination_e2e/provider-bindings"))
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(() => state.mutations.indexOf("POST /api/v1/capsules/cap_provider_destination_e2e/plan"))
      .toBeGreaterThanOrEqual(0);
    expect(
      state.mutations.indexOf(
        "PUT /api/v1/capsules/cap_provider_destination_e2e/provider-bindings",
      ),
    ).toBeLessThan(
      state.mutations.indexOf(
        "POST /api/v1/capsules/cap_provider_destination_e2e/plan",
      ),
    );
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

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
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /追加|Add/u }).click();

    await expect(
      page.getByRole("heading", {
        name: /互換性のあるHost \/ accountが必要|A compatible Host \/ account is needed/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /新しい接続を追加|Add a new connection/u,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    expect(state.bindingBody).toBeUndefined();
    expect(state.mutations).not.toContain(
      "PUT /api/v1/capsules/cap_provider_destination_e2e/provider-bindings",
    );
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("mixed manual and auto-selected destinations do not show a singular summary", async ({
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
          source: "cloudflare/cloudflare-v02",
          aliases: [],
          allowed: true,
          credentialRequired: true,
        },
        {
          source: "hashicorp/aws",
          aliases: [],
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /追加|Add/u }).click();

    await expect(
      page.getByRole("heading", {
        name: /Host \/ accountを選択|Choose a Host \/ account/u,
      }),
    ).toBeVisible();
    const destinations = page.locator(".iv-connection-list select");
    await expect(destinations).toHaveCount(2);
    await expect(destinations.nth(0)).toHaveValue("pc_cloudflare_host_v02_mixed");
    await destinations.nth(1).selectOption("pc_aws_primary_mixed");
    await page.getByRole("button", { name: /続ける|Continue/u }).click();

    await expect(
      page.getByRole("heading", { name: /Review before install/u }),
    ).toBeVisible();
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    await expect
      .poll(() => state.bindingBody?.bindings)
      .toEqual([
        {
          provider: "cloudflare/cloudflare-v02",
          moduleLocalName: "cloudflare-v02",
          connectionId: "pc_cloudflare_host_v02_mixed",
        },
        {
          provider: "hashicorp/aws",
          moduleLocalName: "aws",
          connectionId: "pc_aws_primary_mixed",
        },
      ]);
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
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /追加|Add/u }).click();

    await expect(
      page.getByRole("heading", {
        name: /Host \/ accountを選択|Choose a Host \/ account/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /新しい接続を追加|Add a new connection/u,
      }),
    ).toHaveCount(0);
    const destination = page.getByLabel(/Host \/ account/u);
    await expect(destination).toBeVisible();
    await expect(destination.locator("option")).toContainText([
      "Cloudflare connection A",
      "Cloudflare connection B",
    ]);
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
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
          source: "cloudflare/cloudflare-v02",
          aliases: [],
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /追加|Add/u }).click();

    await expect(
      page.getByRole("heading", {
        name: /互換性のあるHost \/ accountが必要|A compatible Host \/ account is needed/u,
      }),
    ).toBeVisible();
    await expect(
      page.locator('[data-install-provider-destination="auto-selected"]'),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", {
        name: /新しい接続を追加|Add a new connection/u,
      }),
    ).toBeVisible();
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
          source: "cloudflare/cloudflare",
          aliases: [],
          allowed: true,
          credentialRequired: true,
        },
        {
          source: "hashicorp/aws",
          aliases: [],
          allowed: true,
          credentialRequired: true,
        },
      ],
    );
    const query = new URLSearchParams({
      git: "https://github.com/example/cloudflare-service.git",
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "cloudflare-service",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /追加|Add/u }).click();

    await expect(
      page.getByRole("heading", {
        name: /互換性のあるHost \/ accountが必要|A compatible Host \/ account is needed/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: /新しい接続を追加|Add a new connection/u,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /続ける|Continue/u }),
    ).toBeDisabled();
    expectSingleSourceCreate(state);
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("Store setup edits keep the ready compatibility fence and continue to Plan", async ({
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
    const profileDiscoveryRequests: string[] = [];
    const stableRefResolutionBodies: unknown[] = [];
    const sourcePostBodies: unknown[] = [];
    const syncBodies: unknown[] = [];
    const sourceState: SourceCreateFixtureState = {
      sourceListReads: [],
      sourcePosts: [],
    };
    await page.route("https://store.example.test/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          id: "example/service",
          source: { git: "https://github.com/example/service.git" },
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
        const profileConfig = (input: {
          readonly id: string;
          readonly key: string;
          readonly label: string;
          readonly modulePath: string;
          readonly order: number;
          readonly recommended: boolean;
        }) => ({
          id: input.id,
          name: input.key,
          sourceSelector: {
            url: "https://github.com/example/service.git",
            path: ".",
          },
          modulePath: input.modulePath,
          variableMapping: {},
          outputAllowlist: {},
          policy: {},
          store: {
            source: {
              url: "https://github.com/example/service.git",
              path: ".",
            },
            order: 1,
            surface: "service",
            kind: "application",
            provider: "portable-e2e",
            suggestedName: "example-service",
            badge: { ja: "追加", en: "Add" },
            name: { ja: "Example Service", en: "Example Service" },
            description: { ja: "Example", en: "Example" },
            deploymentProfile: {
              key: input.key,
              label: { ja: input.label, en: input.label },
              description: {
                ja: `${input.label} fixture`,
                en: `${input.label} fixture`,
              },
              order: input.order,
              recommended: input.recommended,
            },
          },
          createdAt: now,
          updatedAt: now,
        });
        return route.fulfill({
          json: {
            installConfigs: [
              profileConfig({
                id: "cfg_store_takoform_e2e",
                key: "takoform-v2",
                label: "Takoform",
                modulePath: "deploy/takoform",
                order: 20,
                recommended: true,
              }),
              profileConfig({
                id: "cfg_store_cloudflare_e2e",
                key: "cloudflare-v1",
                label: "Cloudflare",
                modulePath: "deploy/cloudflare",
                order: 10,
                recommended: false,
              }),
            ],
          },
        });
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
          "/api/v1/sources/src_install_e2e/snapshots/snap_install_e2e/deployment-profiles" &&
        request.method() === "GET"
      ) {
        profileDiscoveryRequests.push(path);
        return route.fulfill({
          json: {
            status: "ready",
            profiles: [
              {
                key: "takoform-v2",
                label: {
                  ja: "Takoform",
                  en: "Takoform",
                },
                description: {
                  ja: "Takoform fixture",
                  en: "Takoform fixture",
                },
                order: 20,
                recommended: true,
              },
              {
                key: "cloudflare-v1",
                label: {
                  ja: "Cloudflare",
                  en: "Cloudflare",
                },
                description: {
                  ja: "Cloudflare fixture",
                  en: "Cloudflare fixture",
                },
                order: 10,
                recommended: false,
              },
            ],
          },
        });
      }
      if (path === "/api/v1/sources/src_install_e2e/compatibility-check") {
        return route.fulfill({
          json: {
            report: {
              id: "report_install_e2e",
              level: "ready",
              findings: [],
              providers: [],
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
        path === "/api/v1/workspaces/ws_alpha/capsules" &&
        request.method() === "POST"
      ) {
        return route.fulfill({
          json: {
            capsule: {
              id: "cap_install_e2e",
              workspaceId: "ws_alpha",
              name: "example-service",
              slug: "example-service",
              environment: "production",
              sourceId: "src_install_e2e",
              installConfigId: "cfg_install_e2e",
              status: "pending",
              currentStateGeneration: 0,
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
      if (path === "/api/v1/capsules/cap_install_e2e/provider-bindings") {
        return route.fulfill({
          json: {
            providerBindingSet: {
              capsuleId: "cap_install_e2e",
              workspaceId: "ws_alpha",
              bindings: [],
              createdAt: now,
              updatedAt: now,
            },
          },
        });
      }
      if (path === "/api/v1/capsules/cap_install_e2e/plan") {
        return route.fulfill({ json: { run: { id: "run_plan_e2e" } } });
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
    await page.getByRole("button", { name: /追加|Add/u }).last().click();
    await expect(hostingOption).toBeVisible();
    expect(profileDiscoveryRequests).toEqual([
      "/api/v1/sources/src_install_e2e/snapshots/snap_install_e2e/deployment-profiles",
    ]);
    expect(seenMutations).not.toContain(
      "POST /api/v1/sources/src_install_e2e/compatibility-check",
    );
    await expect(hostingOption).toHaveValue("");
    await expect(hostingOption).toContainText(
      /Takoform.*おすすめ|Takoform.*Recommended/u,
    );
    await hostingOption.selectOption("takoform-v2");
    await expect(hostingOption).toHaveValue("takoform-v2");
    await expect(page.getByText("Takoform fixture", { exact: true })).toBeVisible();
    const hostingOptionConfirmation = page.getByRole("checkbox", {
      name: /このプロバイダー \/ モジュールで追加することを確認しました|I confirm this Provider \/ module/u,
    });
    await expect(hostingOptionConfirmation).toBeVisible();
    await expect(hostingOptionConfirmation).not.toBeChecked();
    await hostingOptionConfirmation.check();
    await page.getByRole("button", { name: /追加|Add/u }).last().click();
    await expect(
      page.getByRole("heading", { name: /サービスを設定|Set up the service/u }),
    ).toBeVisible();
    await page.getByLabel(/リージョン|Region/u).fill("edited");
    await page.getByRole("button", { name: /続ける|Continue/u }).click();
    await expect
      .poll(() =>
        seenMutations.includes("POST /api/v1/capsules/cap_install_e2e/plan"),
      )
      .toBe(true);
    expectSingleSourceCreate(sourceState);
    expect(stableRefResolutionBodies).toEqual([
      { url: "https://github.com/example/service" },
    ]);
    expect(sourcePostBodies).toEqual([
      expect.objectContaining({
        defaultRef: resolvedCommit,
        defaultPath: ".",
        autoSync: true,
      }),
    ]);
    expect(syncBodies).toEqual([{ expectedRef: resolvedCommit }]);
  });

  test("direct Git installs discover and submit the snapshot-bound deployment profile", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the deterministic direct Git install fixture is portable-only",
    );
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const state = await stubProviderDestinationFixture(
      page,
      [],
      [],
      {
        deploymentProfiles: [
          {
            key: "takoform-v2",
            label: { ja: "Takoform", en: "Takoform" },
            description: {
              ja: "Run on a Takoform Host",
              en: "Run on a Takoform Host",
            },
            order: 10,
            recommended: true,
          },
          {
            key: "cloudflare-v1",
            label: { ja: "Cloudflare", en: "Cloudflare" },
            description: {
              ja: "Run with a connected Cloudflare account",
              en: "Run with a connected Cloudflare account",
            },
            order: 20,
            recommended: false,
          },
        ],
      },
    );
    const query = new URLSearchParams({
      git: "https://github.com/tako0614/yurucommu.git",
      ref: PORTABLE_SOURCE_OPTIONS_COMMIT,
      path: ".",
      name: "yurucommu",
    });
    await page.goto(`/new?${query}`, { waitUntil: "domcontentloaded" });
    const hostingOption = page.getByRole("combobox", {
      name: /プロバイダー|Provider/u,
    });
    await expect(hostingOption).toHaveCount(0);

    await page.getByRole("button", { name: /追加|Add/u }).click();
    await expect(hostingOption).toBeVisible();
    expect(state.sourcePosts).toEqual(["/api/v1/sources"]);
    expect(state.profileDiscoveryRequests).toEqual([
      "/api/v1/sources/src_provider_destination_e2e/snapshots/snap_provider_destination_e2e/deployment-profiles",
    ]);
    expect(state.compatibilityBodies).toHaveLength(0);
    await expect(hostingOption).toHaveValue("");

    await hostingOption.selectOption("takoform-v2");
    await expect(hostingOption).toHaveValue("takoform-v2");
    await expect(
      page.getByText("Run on a Takoform Host", { exact: true }),
    ).toBeVisible();
    const confirmation = page.getByRole("checkbox", {
      name: /このプロバイダー \/ モジュールで追加することを確認しました|I confirm this Provider \/ module/u,
    });
    await confirmation.check();
    await page.getByRole("button", { name: /追加|Add/u }).click();
    await expect
      .poll(() => state.compatibilityBodies.length)
      .toBe(1);
    expect(state.compatibilityBodies[0]).toMatchObject({
      compileInstallUx: true,
      deploymentProfileKey: "takoform-v2",
      sourceSnapshotId: "snap_provider_destination_e2e",
    });
    expect(state.sourcePosts).toEqual(["/api/v1/sources"]);
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
    const bootstrapDenials: Promise<void>[] = [];
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
      bootstrapDenials.push(
        (async () => {
          expect(response.status(), response.url()).toBe(401);
          expect(response.headers()["content-type"], response.url()).toMatch(
            /^application\/json(?:;|$)/u,
          );
          expect(await response.json(), response.url()).toMatchObject({
            error: "invalid_token",
          });
        })(),
      );
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
    await gotoPublicDocument(page, installPath);
    expect(new URL(page.url()).searchParams.get("return")).toBe(installPath);

    // SignInPanel discovery starts after mount. Keep a short, bounded quiet
    // window so late same-origin responses cannot arrive after the assertions.
    await page.waitForTimeout(500);
    await Promise.all(bootstrapDenials);
    expect(bootstrapDenials.length).toBeGreaterThan(0);
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
