import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
const newAppViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
  "utf8",
);
const appViewsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/app-views.css"),
  "utf8",
);
const catalogSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/catalog.ts"),
  "utf8",
);

describe("/new flow guidance", () => {
  test("keeps /new focused instead of layering guide and progress chrome", () => {
    expect(newAppViewSource).not.toContain("const guideBody = ()");
    expect(newAppViewSource).not.toContain("function AddProgress");
    expect(newAppViewSource).not.toContain('class="av-new-guide"');
    expect(newAppViewSource).not.toContain('class="av-add-steps"');
    expect(newAppViewSource).not.toContain('class="av-selected-service"');
    expect(newAppViewSource).not.toContain('t("new.managed.notice")');
    expect(newAppViewSource).not.toContain('t("new.managed.byoTitle")');
    expect(newAppViewSource).not.toContain('type NewFlowStage = "source"');
    expect(newAppViewSource).not.toContain("const flowStage = ()");
    expect(newAppViewSource).not.toContain('class="av-new-flow"');
    expect(newAppViewSource).not.toContain('t("new.flow.stepSource")');
    expect(en).not.toHaveProperty("new.guide.ready");
    expect(ja).not.toHaveProperty("new.guide.ready");
    expect(en).not.toHaveProperty("new.steps.choose");
    expect(ja).not.toHaveProperty("new.steps.choose");
  });

  test("keeps the cloud UX clear that deploy happens only after review", () => {
    expect(en["new.selection.subtitle"].toLowerCase()).toContain("deploy");
    expect(ja["new.selection.subtitle"]).toContain("デプロイ");
    expect(en).not.toHaveProperty("new.flow.nextReview");
    expect(ja).not.toHaveProperty("new.flow.nextReview");
  });

  test("keeps the /new layout compact on mobile", () => {
    expect(appViewsCssSource).not.toContain(".av-new-guide");
    expect(appViewsCssSource).not.toContain(".av-new-source");
    expect(appViewsCssSource).not.toContain(".av-add-steps");
    expect(appViewsCssSource).not.toContain(".av-selected-service");
    expect(appViewsCssSource).toContain("grid-template-columns: 1fr;");
    expect(appViewsCssSource).not.toContain(".av-new-flow-steps");
    expect(appViewsCssSource).not.toContain(".av-new-flow-step");
  });

  test("keeps the service catalog app-like and the source form advanced", () => {
    expect(newAppViewSource).toContain('class="av-store"');
    expect(newAppViewSource).toContain('class="av-catalog-grid"');
    expect(newAppViewSource).toContain('class="av-catalog-card"');
    expect(newAppViewSource).toContain("function CatalogIcon");
    expect(newAppViewSource).toContain('t("new.store.title")');
    expect(newAppViewSource).toContain('t("new.advancedImport.open")');
    expect(newAppViewSource).toContain('t("new.advancedImport.title")');
    expect(newAppViewSource).toMatch(
      /<details class="wb-disclosure av-manual-import">[\s\S]*t\("new\.advancedImport\.open"\)[\s\S]*setActiveTab\("git"\)/,
    );
    const storeHeadStart = newAppViewSource.indexOf(
      '<div class="av-store-head">',
    );
    const catalogGridStart = newAppViewSource.indexOf(
      '<ul class="av-catalog-grid">',
    );
    expect(storeHeadStart).toBeGreaterThan(-1);
    expect(catalogGridStart).toBeGreaterThan(storeHeadStart);
    expect(
      newAppViewSource.slice(storeHeadStart, catalogGridStart),
    ).not.toContain('setActiveTab("git")');
    expect(newAppViewSource).not.toContain('t("new.selection.sourceDetails")');
    expect(newAppViewSource).not.toContain("sourceSummaryMeta");
    expect(newAppViewSource).toContain('setActiveTab("catalog")');
    expect(newAppViewSource).not.toContain('<code class="av-catalog-src"');
    expect(newAppViewSource).not.toContain('t("new.catalog.provider"');
    expect(newAppViewSource).not.toContain('aria-label="Add method"');
    expect(en).not.toHaveProperty("new.tab.catalog");
    expect(en).not.toHaveProperty("new.tab.git");
    expect(en["new.store.title"]).toBe("Recommended services");
    expect(en["new.advancedImport.open"].toLowerCase()).toContain("own app");
    expect(en["new.advancedImport.open"].toLowerCase()).not.toContain(
      "manually",
    );
    expect(ja).not.toHaveProperty("new.tab.catalog");
    expect(ja).not.toHaveProperty("new.tab.git");
    expect(ja["new.store.title"]).toBe("おすすめサービス");
    expect(ja["new.advancedImport.open"]).toContain("自分のアプリ");
    expect(ja["new.advancedImport.open"]).not.toContain("手動");
    expect(en).not.toHaveProperty("new.flow.sourceMeta");
    expect(ja).not.toHaveProperty("new.flow.sourceMeta");
    expect(en).not.toHaveProperty("new.selection.sourceDetails");
    expect(ja).not.toHaveProperty("new.selection.sourceDetails");
    expect(en["new.providers.alias"]).toBe("Target: {alias}");
    expect(ja["new.providers.alias"]).toBe("対象: {alias}");
  });

  test("catalog exposes multiple runnable service choices backed by official configs", () => {
    expect(catalogSource).toContain('"cloudflare-hello-worker"');
    expect(catalogSource).toContain('"cloudflare-r2-storage"');
    expect(catalogSource).toContain('"cloudflare-static-site"');
    expect(catalogSource).toContain('"aws-s3-storage"');
    expect(catalogSource).toContain(
      'installConfigId: "cfg-official-cloudflare-hello-worker"',
    );
    expect(catalogSource).toContain(
      'installConfigId: "cfg-official-cloudflare-r2-storage"',
    );
    expect(catalogSource).toContain(
      'installConfigId: "cfg-official-cloudflare-static-site"',
    );
    expect(catalogSource).toContain(
      'installConfigId: "cfg-official-aws-s3-storage"',
    );
    expect(catalogSource).toContain('name: "accountId"');
    expect(catalogSource).toContain('name: "bucketName"');
    expect(catalogSource).toContain('defaultValue: "service-name-with-space"');
  });

  test("selected catalog services use friendly setup fields instead of raw variables", () => {
    expect(newAppViewSource).toContain("selectedCatalogEntry");
    expect(newAppViewSource).toContain("selectedCatalogVariables");
    expect(newAppViewSource).toContain("catalogInputError");
    expect(newAppViewSource).toContain(
      "setInstallConfigId(entry.installConfigId)",
    );
    expect(newAppViewSource).toContain('class="av-service-setup"');
    expect(newAppViewSource).toContain('t("new.catalogInput.title")');
    expect(newAppViewSource).not.toContain('t("new.catalogInput.body")');
    expect(newAppViewSource).toContain('<FormField label={t("new.name")}>');
    expect(newAppViewSource).toContain("name={`catalogInput:${field.name}`}");
    expect(newAppViewSource).toContain("clearSelectedCatalog");
    expect(newAppViewSource).toContain("defaultGitInstallConfig()?.id");
    expect(appViewsCssSource).toContain(".av-service-setup-grid");
    expect(en).not.toHaveProperty("new.catalogInput.body");
    expect(ja).not.toHaveProperty("new.catalogInput.body");
  });

  test("selected catalog services can use safe cloud-account hints instead of duplicate setup input", () => {
    const hintSourceStart = newAppViewSource.indexOf(
      "const catalogScopeHintValue",
    );
    const hintSourceEnd = newAppViewSource.indexOf(
      "const sourceGitConnections",
      hintSourceStart,
    );
    expect(hintSourceStart).toBeGreaterThan(-1);
    expect(hintSourceEnd).toBeGreaterThan(hintSourceStart);
    const hintSource = newAppViewSource.slice(hintSourceStart, hintSourceEnd);

    expect(newAppViewSource).toContain("catalogScopeHintValue");
    expect(hintSource).toContain("connection.scopeHints?.accountId");
    expect(hintSource).toContain("connection.scopeHints?.awsRegion");
    expect(newAppViewSource).toContain("catalogInputTouched");
    expect(newAppViewSource).toContain(
      "catalogScopeHintValue(entry, field) ??",
    );
    expect(newAppViewSource).toContain(
      "if (catalogInputTouched()[key]) continue",
    );
    expect(newAppViewSource).toContain(
      'if ((next[key] ?? "").trim()) continue',
    );
    expect(hintSource).not.toContain("repoUrl");
    expect(hintSource).not.toContain("knownHostsEntry");
  });

  test("keeps arbitrary non-secret OpenTofu inputs in the add flow", () => {
    expect(newAppViewSource).toContain("const shouldOpenServiceAdvanced = ()");
    expect(newAppViewSource).toContain("normalizedInputVariables");
    expect(newAppViewSource).toContain("installReturnVariables");
    expect(newAppViewSource).toContain("selectedCatalogVariableNames");
    expect(newAppViewSource).toContain("open={shouldOpenServiceAdvanced()}");
    expect(newAppViewSource).toContain('t("new.vars.inputsTitle")');
    expect(newAppViewSource).toContain("name={`varName:${index()}`}");
    expect(newAppViewSource).toContain("name={`varValue:${index()}`}");
    expect(newAppViewSource).toContain("inputVariableError");
    expect(en["new.vars.errorCatalogReserved"]).toContain("Service setup");
    expect(ja["new.vars.errorCatalogReserved"]).toContain("サービス設定");
    expect(en["new.vars.inputsBody"].toLowerCase()).toContain("non-secret");
    expect(ja["new.vars.inputsBody"]).toContain("非 secret");
    expect(en["new.vars.inputsTitle"]).not.toBe("Advanced settings");
    expect(ja["new.vars.inputsTitle"]).not.toBe("詳細設定");
  });

  test("keeps external connection UI hidden unless there is something to choose", () => {
    expect(newAppViewSource).toContain(
      "providerRowsRequiringChoice().length > 0",
    );
    expect(newAppViewSource).toContain("providerRowNeedsVisibleChoice");
    expect(newAppViewSource).not.toContain('t("new.providers.noneRequired")');
    expect(newAppViewSource).not.toContain(
      't("new.providers.manageConnections")',
    );
    expect(newAppViewSource).not.toContain('t("new.providers.subtitle")');
    expect(newAppViewSource).not.toContain('t("new.providers.advanced")');
    expect(en).not.toHaveProperty("new.providers.noneRequired");
    expect(ja).not.toHaveProperty("new.providers.noneRequired");
    expect(en).not.toHaveProperty("new.providers.manageConnections");
    expect(ja).not.toHaveProperty("new.providers.manageConnections");
    expect(en).not.toHaveProperty("new.providers.subtitle");
    expect(ja).not.toHaveProperty("new.providers.subtitle");
  });

  test("shows setup progress only while it is actionable", () => {
    expect(newAppViewSource).toContain("const showSetupProgress = ()");
    expect(newAppViewSource).toContain(
      'step === "running" || step === "error"',
    );
    expect(newAppViewSource).toContain("showSetupProgress()");
    expect(newAppViewSource).not.toContain('stepSource() !== "idle"');
  });
});
