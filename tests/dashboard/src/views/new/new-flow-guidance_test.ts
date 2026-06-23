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
    expect(newAppViewSource).toContain("function CatalogCard");
    expect(newAppViewSource).toContain("const catalogEntries = createMemo");
    expect(newAppViewSource).toContain("function dedupeCatalogConfigs");
    expect(newAppViewSource).toContain("function catalogConfigPriority");
    expect(newAppViewSource).toContain("config.spaceId === undefined");
    expect(newAppViewSource).toContain('config.id.startsWith("cfg-official-")');
    expect(newAppViewSource).toContain("config.catalog?.source");
    expect(newAppViewSource).toContain("const primaryCatalog = createMemo");
    expect(newAppViewSource).toContain(
      "const buildingBlockCatalog = createMemo",
    );
    expect(newAppViewSource).toContain("const exampleCatalog = createMemo");
    expect(newAppViewSource).toContain('entry.surface === "service"');
    expect(newAppViewSource).toContain('entry.surface === "building_block"');
    expect(newAppViewSource).toContain('entry.surface === "example"');
    expect(newAppViewSource).toContain('t("new.store.title")');
    expect(newAppViewSource).toContain('t("new.store.blocksTitle")');
    expect(newAppViewSource).toContain('t("new.store.examplesTitle")');
    expect(newAppViewSource).toContain('class="wb-disclosure av-catalog-more"');
    expect(newAppViewSource).toContain('t("new.advancedImport.open")');
    const storeHeadStart = newAppViewSource.indexOf(
      '<div class="av-store-head">',
    );
    const catalogGridStart = newAppViewSource.indexOf(
      '<ul class="av-catalog-grid">',
    );
    const manualImportStart = newAppViewSource.indexOf(
      '<div class="av-manual-import">',
    );
    const importCardStart = newAppViewSource.indexOf(
      '<Card class="av-import-card">',
    );
    expect(manualImportStart).toBeGreaterThan(catalogGridStart);
    expect(importCardStart).toBeGreaterThan(manualImportStart);
    const manualImportSource = newAppViewSource.slice(
      manualImportStart,
      importCardStart,
    );
    expect(manualImportSource).toContain('t("new.advancedImport.open")');
    expect(manualImportSource).toContain('setActiveTab("git")');
    expect(newAppViewSource).not.toContain(
      '<details class="wb-disclosure av-manual-import">',
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
    expect(en).not.toHaveProperty("new.catalog.select");
    expect(en).not.toHaveProperty("new.store.subtitle");
    expect(en["new.store.title"]).toBe("What do you want to host?");
    expect(en["new.store.blocksTitle"]).toBe("Storage and building blocks");
    expect(en["new.store.examplesTitle"]).toBe("Examples");
    expect(en["new.advancedImport.open"].toLowerCase()).toBe(
      "add another link",
    );
    expect(en["new.advancedImport.open"].toLowerCase()).not.toContain(
      "manually",
    );
    expect(ja).not.toHaveProperty("new.tab.catalog");
    expect(ja).not.toHaveProperty("new.tab.git");
    expect(ja).not.toHaveProperty("new.catalog.select");
    expect(ja).not.toHaveProperty("new.store.subtitle");
    expect(ja["new.store.title"]).toBe("何をホストしますか？");
    expect(ja["new.store.blocksTitle"]).toBe("保存先と部品");
    expect(ja["new.store.examplesTitle"]).toBe("サンプル");
    expect(ja["new.advancedImport.open"]).toBe("その他のリンクから追加");
    expect(ja["new.advancedImport.open"]).not.toContain("手動");
    expect(en).not.toHaveProperty("new.flow.sourceMeta");
    expect(ja).not.toHaveProperty("new.flow.sourceMeta");
    expect(en).not.toHaveProperty("new.selection.sourceDetails");
    expect(ja).not.toHaveProperty("new.selection.sourceDetails");
    expect(en["new.providers.alias"]).toBe("Target: {alias}");
    expect(ja["new.providers.alias"]).toBe("対象: {alias}");
  });

  test("opens normal /new on the catalog while explicit links use the Git flow", () => {
    expect(newAppViewSource).toContain("function initialAddTab");
    expect(newAppViewSource).toContain("if (hasPrefill) return \"git\"");
    expect(newAppViewSource).toContain('params.get("mode") === "link"');
    expect(newAppViewSource).toContain(': "catalog"');
    expect(newAppViewSource).toContain(
      "initialAddTab(initialSearch, Boolean(prefill))",
    );
    expect(newAppViewSource).not.toContain(
      'createSignal<"catalog" | "git">("git")',
    );
  });

  test("catalog exposes multiple runnable service choices backed by official configs", () => {
    const officialSeedSource = readFileSync(
      resolve(
        here,
        "../../../../../core/domains/installations/official_seed.ts",
      ),
      "utf8",
    );
    expect(officialSeedSource).toContain('"cloudflare-hello-worker"');
    expect(officialSeedSource).toContain('"cloudflare-r2-storage"');
    expect(officialSeedSource).toContain('"cloudflare-static-site"');
    expect(officialSeedSource).toContain('"aws-s3-storage"');
    expect(officialSeedSource).toContain("catalogMetadataForTemplate");
    expect(officialSeedSource).toContain("officialCatalogSource");
    expect(officialSeedSource).toContain('name: "accountId"');
    expect(officialSeedSource).toContain('name: "bucketName"');
    expect(officialSeedSource).toContain(
      'defaultValue: "service-name-with-space"',
    );
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
    expect(newAppViewSource).toContain('t("new.catalogInput.subtitle")');
    expect(newAppViewSource).not.toContain('t("new.catalogInput.body")');
    expect(newAppViewSource).toContain('<FormField label={t("new.name")}>');
    expect(newAppViewSource).toContain("name={`catalogInput:${field.name}`}");
    expect(newAppViewSource).toContain("clearSelectedCatalog");
    expect(newAppViewSource).toContain("defaultGitInstallConfig()?.id");
    expect(appViewsCssSource).toContain(".av-service-setup-grid");
    expect(appViewsCssSource).toContain(".av-service-setup-head p");
    expect(en).not.toHaveProperty("new.catalogInput.body");
    expect(en["new.catalogInput.subtitle"]).toContain("minimum fields");
    expect(ja).not.toHaveProperty("new.catalogInput.body");
    expect(ja["new.catalogInput.subtitle"]).toContain("最小限");
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
    expect(newAppViewSource).toContain("isConnectionScopedCatalogInput");
    expect(newAppViewSource).toContain("hasMissingAdvancedCatalogInputs");
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

  test("keeps arbitrary visible service inputs in the add flow", () => {
    expect(newAppViewSource).toContain("const shouldOpenServiceAdvanced = ()");
    expect(newAppViewSource).toContain("normalizedInputVariables");
    expect(newAppViewSource).toContain("installReturnVariables");
    expect(newAppViewSource).toContain("selectedCatalogVariableNames");
    expect(newAppViewSource).toContain("shouldOpenServiceAdvanced() ||");
    expect(newAppViewSource).toContain("hasMissingAdvancedCatalogInputs()");
    expect(newAppViewSource).toContain('t("new.vars.inputsTitle")');
    expect(newAppViewSource).toContain("name={`varName:${index()}`}");
    expect(newAppViewSource).toContain("name={`varValue:${index()}`}");
    expect(newAppViewSource).toContain("inputVariableError");
    expect(en["new.vars.errorCatalogReserved"]).toContain("Service setup");
    expect(ja["new.vars.errorCatalogReserved"]).toContain("サービス設定");
    expect(en["new.vars.inputsBody"].toLowerCase()).toContain("visible inputs");
    expect(ja["new.vars.inputsBody"]).toContain("表示用の入力");
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
    expect(newAppViewSource).toContain('t("new.progress.details")');
    expect(newAppViewSource.indexOf('t("new.progress.status"')).toBeGreaterThan(
      newAppViewSource.indexOf('t("new.progress.details")'),
    );
    expect(newAppViewSource).not.toContain('stepSource() !== "idle"');
    expect(en["new.progress.details"]).toBe("Detailed progress");
    expect(ja["new.progress.details"]).toBe("詳しい進行状況");
  });

  test("uses neutral compatibility summaries for unknown backend diagnostics", () => {
    expect(newAppViewSource).toContain(
      't("new.compat.summary.reviewRequired")',
    );
    expect(newAppViewSource).not.toContain("return result.summary;");
    expect(en["new.compat.summary.reviewRequired"]).toBe(
      "An item needs review before this can be added.",
    );
    expect(ja["new.compat.summary.reviewRequired"]).toBe(
      "追加する前に確認が必要な項目があります。",
    );
  });
});
