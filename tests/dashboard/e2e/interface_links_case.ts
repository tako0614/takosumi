/** TASK-0118: app links, using only value-free public projections. */
import { expect, test, type Page } from "@playwright/test";
import type { CapsuleAppLink } from "../../../contract/capsules.ts";
import type { InterfaceLink } from "../../../contract/interfaces.ts";
import {
  createInstallAttemptFixture,
  PORTABLE_SOURCE_COMMIT,
  type InstallAttemptFixtureOptions,
} from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import type { DashboardE2EMode } from "./traffic-policy.ts";

const ID = "cap_links_e2e";
const NOW = "2026-10-28T00:00:00.000Z";
const PLAN = "run_links_install_e2e";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

async function capture(page: Page, name: string): Promise<void> {
  const previous = page.viewportSize();
  for (const [suffix, viewport] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${name} at ${viewport.width}px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`${name}-${suffix}.png`), fullPage: true });
  }
  if (previous) await page.setViewportSize(previous);
}

function link(requirementKey: string, patch: Partial<CapsuleAppLink> = {}): CapsuleAppLink {
  return {
    requirementKey, consumerCapsuleId: ID, interfaceType: `example.${requirementKey}`, interfaceVersion: "1.0.0",
    permissions: ["read"], state: "unset", generation: 0, health: "ok", canManage: true,
    ...patch,
  };
}

/** Every API this app page needs is explicit; unrelated routes reach the strict base fixture. */
async function appFixture(page: Page, initialUses: readonly CapsuleAppLink[] = [], initialUsedBy: readonly CapsuleAppLink[] = []) {
  let uses = [...initialUses];
  let usedBy = [...initialUsedBy];
  const mutations: { method: string; path: string; body: unknown }[] = [];
  const candidates = [
    { interfaceId: "if_files_a", providerCapsuleId: "cap_files_a", providerCapsuleName: "保管庫 A", interfaceName: "files" },
    { interfaceId: "if_files_b", providerCapsuleId: "cap_files_b", providerCapsuleName: "保管庫 B", interfaceName: "files" },
  ];
  const capsule = {
    id: ID, workspaceId: "ws_alpha", name: "リンク検証", slug: "interface-links", installConfigId: `cfg_${ID}`,
    environment: "production", status: "active", currentStateVersionId: "sv_links_e2e", currentStateGeneration: 1,
    createdAt: NOW, updatedAt: NOW,
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (method !== "GET") mutations.push({ method, path, body: request.postData() ? request.postDataJSON() : undefined });
    const linkMatch = path.match(/^\/api\/v1\/capsules\/([^/]+)\/interface-links\/([^/]+)(\/candidates)?$/u);
    if (linkMatch) {
      const consumerId = decodeURIComponent(linkMatch[1]!);
      const key = decodeURIComponent(linkMatch[2]!);
      const current = consumerId === ID ? uses.find((row) => row.requirementKey === key) : usedBy.find((row) => row.consumerCapsuleId === consumerId && row.requirementKey === key);
      if (!current) return route.fulfill({ status: 404, json: { error: "fixture_requirement_not_found" } });
      if (linkMatch[3]) return route.fulfill({ json: { candidates, generation: current.generation } });
      const body = request.postDataJSON() as { expectedGeneration: number; interfaceId?: string };
      if (body.expectedGeneration !== current.generation) return route.fulfill({ status: 409, json: { error: { code: "conflict", message: "Link changed." } } });
      const selected = candidates.find((candidate) => candidate.interfaceId === body.interfaceId);
      const next: CapsuleAppLink = method === "DELETE"
        ? { ...current, state: "revoked", generation: current.generation + 1 }
        : { ...current, state: "active", generation: current.generation + 1, linkId: current.linkId ?? `il_${key}`, providerInterfaceId: selected!.interfaceId, providerCapsuleId: selected!.providerCapsuleId, otherApp: { capsuleId: selected!.providerCapsuleId, name: selected!.providerCapsuleName } };
      if (consumerId === ID) uses = uses.map((row) => row.requirementKey === key ? next : row);
      else usedBy = usedBy.filter((row) => row !== current);
      const receipt: InterfaceLink = {
        id: next.linkId!, generation: next.generation, consumerCapsuleId: next.consumerCapsuleId, requirementKey: next.requirementKey,
        interface: { type: next.interfaceType, version: next.interfaceVersion }, requestedPermissions: next.permissions,
        approvedPermissions: method === "DELETE" ? [] : next.permissions, deliveryType: "http", providerInterfaceId: next.providerInterfaceId!,
        providerCapsuleId: next.providerCapsuleId!, state: method === "DELETE" ? "revoked" : "active", selection: "explicit",
        requestedBy: "sub_portable_e2e", createdAt: NOW, updatedAt: NOW,
      };
      return route.fulfill({ json: { link: receipt } });
    }
    const base = `/api/v1/capsules/${ID}`;
    if (path === base) return route.fulfill({ json: { capsule, installConfigReAdoption: { authorityGuard: `sha256:${"a".repeat(64)}` } } });
    if (path === `${base}/app`) return route.fulfill({ json: { app: {
      kind: "takosumi.capsule-app@v1", capsuleId: ID, workspaceId: "ws_alpha", projectId: "prj_alpha", name: capsule.name,
      environment: "production", status: "active", applied: true, state: "installed", primaryAction: "view_resources",
      problems: [], screens: [], links: { uses, usedBy },
      version: { updateAvailable: false, stale: false, autoUpdate: false }, progress: { revisionPreparing: false },
      uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy } }, observedAt: NOW,
    } } });
    if (path === `${base}/runs`) return route.fulfill({ json: { runs: [] } });
    if (path === `${base}/state-versions`) return route.fulfill({ json: { stateVersions: [] } });
    if (path === `${base}/provider-bindings`) return route.fulfill({ json: { providerBindingSet: null } });
    if (path === `${base}/current-resource-inventory`) return route.fulfill({ json: { inventory: {
      kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: ID, workspaceId: "ws_alpha", environment: "production",
      stateVersionId: "sv_links_e2e", generation: 1, applyRunId: "run_links_apply", planRunId: PLAN, recordedAt: NOW,
      availability: "recorded", resources: [],
    } } });
    if (path === `${base}/usage-summary`) return route.fulfill({ json: { summary: { capsuleId: ID, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
    if (path === `/api/v1/capsule-configs/cfg_${ID}`) return route.fulfill({ json: { installConfig: {
      id: `cfg_${ID}`, name: capsule.name, policy: {}, variableMapping: {}, variablePresentation: [], outputAllowlist: {}, createdAt: NOW, updatedAt: NOW,
    } } });
    if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: [] } });
    if (path === "/api/v1/connections") return route.fulfill({ json: { connections: [] } });
    return route.fallback();
  });
  return { mutations };
}

async function installFixture(page: Page, interfaces: InstallAttemptFixtureOptions["interfaces"]) {
  const attempts = createInstallAttemptFixture({ capsuleId: ID, planRunId: PLAN, interfaces });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = attempts.handle({ method: request.method(), path: url.pathname, search: url.search, body: request.postData() ? request.postDataJSON() : undefined, idempotencyKey: request.headers()["idempotency-key"] });
    if (reply) return route.fulfill({ status: reply.status, json: reply.json });
    if (url.pathname === `/api/v1/runs/${PLAN}`) return route.fulfill({ json: { run: {
      id: PLAN, workspaceId: "ws_alpha", capsuleId: ID, type: "plan", status: "succeeded", summary: { add: 0, change: 0, destroy: 0 },
      policyStatus: "pass", planResources: [], createdBy: "portable-e2e", createdAt: NOW,
    } } });
    if (url.pathname === `/api/v1/runs/${PLAN}/cost`) return route.fulfill({ json: { cost: { runId: PLAN, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
    if (url.pathname === `/api/v1/runs/${PLAN}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (url.pathname === `/api/v1/runs/${PLAN}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
    return route.fallback();
  });
  return attempts;
}

export function registerInterfaceLinksCases(mode: DashboardE2EMode): void {
  test.describe("Interface app links", () => {
    test.skip(mode !== "portable", "deterministic app-link fixture; not production evidence");

    test("install sheet handles zero, one and many candidates and answers later before debounced continue", async ({ page }) => {
      await page.clock.install();
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const errors = watchErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      await appFixture(page);
      const candidate = (id: string, name: string) => ({ id, name: "files", capsuleId: `cap_${id}`, capsuleName: name });
      const requirement = (requirementKey: string, candidates: ReturnType<typeof candidate>[]) => ({ requirementKey, type: `example.${requirementKey}`, version: "1.0.0", permissions: ["read"], candidates });
      const attempts = await installFixture(page, [requirement("zero", []), requirement("one", [candidate("if_one", "保管庫")]), requirement("many", [candidate("if_first", "保管庫 A"), candidate("if_second", "保管庫 B")])]);
      await page.goto(`/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Finterface-links.git&ref=${PORTABLE_SOURCE_COMMIT}&path=.&name=interface-links`);
      await page.getByRole("button", { name: /^インストール$/u }).click();
      const section = page.getByTestId("install-interfaces");
      await expect(section).toContainText("連携するアプリ");
      const zero = section.locator('[data-testid="install-required-interface"][data-requirement-key="zero"]');
      const one = section.locator('[data-testid="install-required-interface"][data-requirement-key="one"]');
      const many = section.locator('[data-testid="install-required-interface"][data-requirement-key="many"]');
      await expect(zero).toHaveAttribute("data-interface-state", "later");
      await expect(zero.getByRole("combobox")).toHaveCount(0);
      await expect(one).toHaveAttribute("data-interface-state", "selected");
      await expect(one.getByRole("combobox")).toHaveValue("if_one");
      await expect(one).toContainText("自動選択");
      await expect(many).toHaveAttribute("data-interface-state", "missing");
      await expect(many.getByRole("combobox")).toHaveValue("");
      // No requirement choice is ready yet. Freeze timers before making it
      // ready, so assertions and screenshots cannot consume the debounce.
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
      await capture(page, "interface-install-candidates");
      await many.getByTestId("install-interface-choice").selectOption("later");
      await expect(many).toHaveAttribute("data-interface-state", "later");
      await expect(many.getByRole("combobox")).toHaveValue("later");
      await expect(one.getByRole("combobox")).toHaveValue("if_one");
      await capture(page, "interface-install-later");
      await expect.poll(() => attempts.log.answers.some((body) => (body as { interfaceLinks?: unknown[] }).interfaceLinks?.some((entry) => JSON.stringify(entry) === JSON.stringify({ requirementKey: "many", choice: { kind: "later" } })))).toBe(true);
      expect(attempts.log.answers.some((body) => (body as { continue?: boolean }).continue === true)).toBe(false);
      // The ordinary debounced continuation is a separate request; it may
      // prepare the Plan after the explicit later answer has been accepted.
      await page.clock.runFor(1_000);
      await expect.poll(() => attempts.log.answers.some((body) => (body as { continue?: boolean }).continue === true)).toBe(true);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });

    test("app page shows both directions, changes, selects and revokes links with removal impact", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const errors = watchErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const incoming = link("files", {
        linkId: "il_wiki_files", consumerCapsuleId: "cap_wiki", providerCapsuleId: ID, providerInterfaceId: "if_app_files",
        state: "active", generation: 4, otherApp: { capsuleId: "cap_wiki", name: "チームWiki" },
      });
      const fixture = await appFixture(page, [
        link("files", { linkId: "il_files", state: "active", generation: 1, providerCapsuleId: "cap_files_a", providerInterfaceId: "if_files_a", otherApp: { capsuleId: "cap_files_a", name: "保管庫 A" } }),
        link("pending", { linkId: "il_pending", state: "pending_approval", generation: 3, canManage: false, otherApp: { capsuleId: "cap_calendar", name: "予定表" } }),
        link("later"),
        link("later_two"),
        link("declined", { linkId: "il_declined", state: "declined", generation: 2, canManage: false }),
        link("revoked", { linkId: "il_revoked", state: "revoked", generation: 5, canManage: false }),
        link("unavailable", { linkId: "il_unavailable", state: "active", generation: 1, health: "provider_uninstall_scheduled", canManage: false, otherApp: { capsuleId: "cap_retiring", name: "旧保管庫" } }),
      ], [incoming]);
      await page.goto(`/apps/${ID}#links`);
      const section = page.getByTestId("app-linked");
      await expect(section).toContainText("このアプリが使う機能");
      await expect(section).toContainText("このアプリの機能を使うアプリ");
      const use = (key: string) => section.locator(`[data-testid="app-link-use"][data-requirement="${key}"]`);
      const usedBy = section.getByTestId("app-link-used-by");
      await expect(use("files").getByRole("link", { name: "保管庫 A", exact: true })).toHaveAttribute("href", "/apps/cap_files_a");
      await expect(usedBy.getByRole("link", { name: "チームWiki", exact: true })).toHaveAttribute("href", "/apps/cap_wiki");
      for (const text of ["連携中", "承認待ち", "あとで連携する", "承認されませんでした", "連携は取り消されています", "提供元はアンインストール予定です。連携先を変更してください。"]) {
        await expect(section).toContainText(text);
      }
      await expect(use("pending").getByRole("button")).toHaveCount(0);
      const firstLaterName = await use("later").getByRole("button").getAttribute("aria-label");
      const secondLaterName = await use("later_two").getByRole("button").getAttribute("aria-label");
      expect(firstLaterName).not.toBe(secondLaterName);
      expect(`${firstLaterName}${secondLaterName}`).not.toMatch(/later(?:_two)?/u);
      await capture(page, "interface-app-links");

      // Removal explains the affected app by name before any DELETE is sent.
      await page.getByTestId("app-uninstall").getByRole("button", { name: "アンインストール", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("チームWiki は リンク検証 の機能を使えなくなります（アプリ自体は残ります）");
      await capture(page, "interface-uninstall-impact");
      await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
      expect(fixture.mutations).toEqual([]);

      await use("files").getByRole("button", { name: /との連携を変更/u }).click();
      await use("files").getByRole("combobox").selectOption("if_files_b");
      await use("files").getByRole("button", { name: "このアプリと連携する", exact: true }).click();
      await expect(use("files")).toContainText("保管庫 B");
      await use("later").getByRole("button", { name: /の連携先を選ぶ/u }).click();
      await use("later").getByRole("combobox").selectOption("if_files_a");
      await use("later").getByRole("button", { name: "このアプリと連携する", exact: true }).click();
      await expect(use("later")).toContainText("保管庫 A");
      await expect(use("later")).toContainText("連携中");

      await use("files").getByRole("button", { name: /との連携を取り消す/u }).click();
      await expect(dialog).toContainText("アプリ自体は残ります");
      await dialog.getByRole("button", { name: "取り消す", exact: true }).click();
      await expect(use("files")).toContainText("連携は取り消されています");
      await usedBy.getByRole("button", { name: /との連携を取り消す/u }).click();
      await dialog.getByRole("button", { name: "取り消す", exact: true }).click();
      await expect(section.getByTestId("app-link-used-by")).toHaveCount(0);
      await capture(page, "interface-app-links-revoked");
      expect(fixture.mutations).toEqual([
        { method: "PUT", path: `/api/v1/capsules/${ID}/interface-links/files`, body: { interfaceId: "if_files_b", expectedGeneration: 1 } },
        { method: "PUT", path: `/api/v1/capsules/${ID}/interface-links/later`, body: { interfaceId: "if_files_a", expectedGeneration: 0 } },
        { method: "DELETE", path: `/api/v1/capsules/${ID}/interface-links/files`, body: { expectedGeneration: 2 } },
        { method: "DELETE", path: "/api/v1/capsules/cap_wiki/interface-links/files", body: { expectedGeneration: 4 } },
      ]);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });
  });
}
