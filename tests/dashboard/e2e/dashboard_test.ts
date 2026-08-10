import { expect, test, type Locator, type Page } from "@playwright/test";
import { PORTABLE_EXPECTATIONS } from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import {
  shouldRecordControlPlaneMutation,
  type DashboardE2EMode,
} from "./traffic-policy.ts";

type Expectations = {
  readonly workspaceName: string;
  readonly switchWorkspaceName: string;
  readonly appName: string;
  readonly appUrl: string;
};

const rawMode = process.env.TAKOSUMI_E2E_MODE ?? "portable";
if (rawMode !== "portable" && rawMode !== "live") {
  throw new Error("TAKOSUMI_E2E_MODE must be either portable or live");
}
const mode: DashboardE2EMode = rawMode;

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
    : {
        workspaceName: requiredLive("TAKOSUMI_E2E_WORKSPACE_NAME"),
        switchWorkspaceName: requiredLive("TAKOSUMI_E2E_SWITCH_WORKSPACE_NAME"),
        appName: requiredLive("TAKOSUMI_E2E_APP_NAME"),
        appUrl: requiredLive("TAKOSUMI_E2E_APP_URL"),
      };

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

async function assertNoPageErrors(errors: readonly string[]): Promise<void> {
  expect(errors, "dashboard page raised a browser runtime error").toEqual([]);
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

test.describe("Takosumi dashboard browser surface", () => {
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

  test("Store setup edits keep the ready compatibility fence and continue to Plan", async ({
    page,
  }) => {
    test.skip(
      mode !== "portable",
      "the deterministic install API fixture is portable-only",
    );
    const now = "2026-08-04T00:00:00.000Z";
    const seenMutations: string[] = [];
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
      if (path === "/api/v1/connections") {
        return route.fulfill({ json: { connections: [] } });
      }
      if (path === "/api/v1/provider-connections") {
        return route.fulfill({ json: { providerConnections: [] } });
      }
      if (path === "/api/v1/sources" && request.method() === "POST") {
        return route.fulfill({
          json: {
            source: {
              id: "src_install_e2e",
              workspaceId: "ws_alpha",
              name: "example-service",
              url: "https://github.com/example/service.git",
              defaultRef: "",
              defaultPath: ".",
              status: "active",
              autoSync: true,
              createdAt: now,
              updatedAt: now,
            },
            hookSecret: "fixture-only",
          },
        });
      }
      if (path === "/api/v1/sources/src_install_e2e/sync") {
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
                ref: "v1.0.0",
                resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
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
    await page
      .getByRole("button", { name: /追加|Add/u })
      .last()
      .click();
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
