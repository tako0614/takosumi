import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const root = resolve(import.meta.dir, "../../../../../../dashboard/src");
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

const view = read("views/workspace/tabs/InterfaceRecoveryTab.tsx");
const settings = read("views/workspace/WorkspaceSettingsView.tsx");
const nav = read("views/account/components/shell/nav.ts");

describe("Interface recovery dashboard surface", () => {
  test("is a tools-only Workspace route, not an everyday settings tab", () => {
    expect(nav).toContain('href: "/advanced/workspace/interface-recovery"');
    expect(settings).toContain('raw === "interface-recovery"');
    expect(settings).toContain('tab() === "interface-recovery"');
    expect(settings).toContain('tab() !== "interface-recovery"');
    // No tab item was added to the everyday settings strip.
    const tabItems = settings.slice(
      settings.indexOf("const tabItems"),
      settings.indexOf("return (", settings.indexOf("const tabItems")),
    );
    expect(tabItems).not.toContain("interface-recovery");
  });

  test("renders the value-free projection and useful progress only", () => {
    expect(view).toContain("listInterfaceMaterializationFailures");
    expect(view).toContain("failure.error.code");
    expect(view).toContain("failure.error.recordedAt");
    expect(view).toContain("failure.nextItemIndex");
    expect(view).toContain("failure.totalItems");
    expect(view).toContain("failure.attempts");
    expect(view).toContain("/workloads/${encodeURIComponent(failure.capsuleId)}");
    expect(view).not.toContain("detailDigest");
    expect(view).not.toContain("blueprintsDigest");
    expect(view).not.toContain("failureDigest}");
    expect(view).not.toContain("outputs");
  });

  test("keeps retry identity exact, guards stale Workspace results, and refreshes only", () => {
    expect(view).toContain("createAction");
    expect(view).toContain("failure.failureDigest");
    expect(view).toContain("failure.stateVersionId");
    expect(view).toContain("failure.stateGeneration");
    expect(view).toContain("currentWorkspaceId() !== targetWorkspaceId");
    expect(view).toContain("await refreshFailureList()");
    expect(view).toContain("isInterfaceMaterializationRetryStale(error)");
    expect(view).toContain('t("interfaceRecovery.retryQueued"');
    expect(view).toContain('role=\"status\"');
  });

  test("covers accessible loading, error, empty, bounded-list, refresh, and duplicate guards", () => {
    expect(view).toContain("loading={failures.loading && !failures.latest}");
    expect(view).toContain('t("common.loading")');
    expect(view).toContain("fetchFailedMessage(failures.error, t)");
    expect(view).toContain('t("interfaceRecovery.empty.title")');
    expect(view).toContain("rows().length >= INTERFACE_MATERIALIZATION_FAILURE_LIMIT");
    expect(view).toContain('t("interfaceRecovery.limitNote")');
    expect(view).toContain('t("common.refresh")');
    expect(view).toContain("if (retryAction.busy()) return;");
    expect(view).toContain("disabled={retryAction.busy()}");
    expect(view).toContain("aria-label={t(\"interfaceRecovery.retryFor\"");
  });

  test("keeps the operator copy explicit about pending retries and authorization", () => {
    expect(en["interfaceRecovery.retryQueued"]).toContain("pending");
    expect(en["interfaceRecovery.retryQueued"]).toContain("completion");
    expect(ja["interfaceRecovery.retryQueued"]).toContain("保留中");
    expect(en["interfaceRecovery.retryForbidden"]).toContain("owners");
    expect(ja["interfaceRecovery.retryForbidden"]).toContain("オーナー");
    expect(en["interfaceRecovery.limitNote"]).toContain("100");
    expect(ja["interfaceRecovery.limitNote"]).toContain("100");
  });
});
