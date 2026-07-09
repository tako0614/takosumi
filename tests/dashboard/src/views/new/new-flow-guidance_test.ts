import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The /new flow spans the view (state machine + render) and its pure helper
// module — string pins check the combined install-flow source.
const newAppViewSource =
  readFileSync(
    resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
    "utf8",
  ) +
  readFileSync(
    resolve(
      here,
      "../../../../../dashboard/src/views/new/install-helpers.ts",
    ),
    "utf8",
  );
const appViewsCssSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/styles/app-views.css"),
  "utf8",
);
const controlApiSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/control-api.ts"),
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

  test("keeps a real page heading for accessibility without adding visual chrome", () => {
    expect(newAppViewSource).toContain(
      '<h1 class="sr-only">{t("new.title")}</h1>',
    );
    expect(newAppViewSource).not.toContain("<PageHeader");
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

  test("integrates service browsing and link install into /new", () => {
    expect(newAppViewSource).toContain("StoreBrowser");
    // Discovery is store-driven; no hardcoded local store is injected.
    expect(newAppViewSource).not.toContain("localStoreListings");
    expect(newAppViewSource).not.toContain("installableAppStoreListings");
    expect(newAppViewSource).not.toContain("localListings=");
    expect(newAppViewSource).not.toContain("storeEntryToListing");
    expect(newAppViewSource).toContain("pickStoreListing");
    expect(newAppViewSource).toContain(
      'setActiveTab(storeListing ? "store" : "git")',
    );
    expect(newAppViewSource).toContain(
      "applyInstallPrefillInput(prefill, { storeListing: hydratedListing })",
    );
    expect(newAppViewSource).toContain("startLinkImport");
    expect(newAppViewSource).toContain('class="av-add-discovery"');
    expect(newAppViewSource).toContain('class="av-link-entry"');
    expect(newAppViewSource).toContain("showSourceControls={true}");
    expect(newAppViewSource).toContain("showSortControl={false}");
    expect(newAppViewSource).not.toContain("showKindFilters");
    expect(newAppViewSource).toContain("function StoreIcon");
    expect(newAppViewSource).not.toContain("function storeKindLabel");
    expect(newAppViewSource).not.toContain("function StoreCard");
    expect(newAppViewSource).not.toContain("function ManualImportCard");
    expect(newAppViewSource).not.toContain("const [storeQuery");
    expect(newAppViewSource).not.toContain(
      "const allStoreEntries = createMemo",
    );
    expect(newAppViewSource).not.toContain("const storeEntries = createMemo");
    expect(newAppViewSource).not.toContain("storeEntryMatchesQuery");
    expect(newAppViewSource).not.toContain("function dedupeStoreConfigs");
    expect(newAppViewSource).not.toContain("function storeConfigPriority");
    expect(newAppViewSource).not.toContain(
      'config.id.startsWith("cfg-built-in-")',
    );
    expect(newAppViewSource).not.toContain("config.store?.source");
    expect(newAppViewSource).not.toContain("const primaryStore = createMemo");
    expect(newAppViewSource).not.toContain(
      "const buildingBlockStore = createMemo",
    );
    expect(newAppViewSource).not.toContain("const exampleStore = createMemo");
    expect(newAppViewSource).not.toContain('entry.surface === "service"');
    expect(newAppViewSource).not.toContain(
      'entry.surface === "building_block"',
    );
    expect(newAppViewSource).not.toContain('entry.surface === "example"');
    expect(newAppViewSource).not.toContain('t("new.store.title")');
    expect(newAppViewSource).not.toContain('t("new.store.featuredTitle")');
    expect(newAppViewSource).not.toContain('t("new.store.searchPlaceholder")');
    expect(newAppViewSource).not.toContain('t("new.store.blocksTitle")');
    expect(newAppViewSource).not.toContain('t("new.store.examplesTitle")');
    expect(newAppViewSource).not.toContain('class="av-store-section"');
    expect(newAppViewSource).not.toContain(
      'class="wb-disclosure av-store-more"',
    );
    expect(newAppViewSource).not.toContain('class="av-store-link-tile"');
    expect(newAppViewSource).not.toContain('class="av-store-link-icon"');
    expect(newAppViewSource).not.toContain('t("new.manualCard.title")');
    expect(newAppViewSource).not.toContain('t("new.manualCard.body")');
    expect(newAppViewSource).not.toContain('class="av-manual-import"');
    expect(newAppViewSource).not.toContain("av-store-card-manual");
    expect(newAppViewSource).not.toContain(
      '<details class="wb-disclosure av-manual-import">',
    );
    expect(newAppViewSource).not.toContain('t("new.selection.sourceDetails")');
    expect(newAppViewSource).not.toContain("sourceSummaryMeta");
    expect(newAppViewSource).toContain("<Show when={!usingSelectedService()}>");
    expect(newAppViewSource).toContain("<Show when={!hasChosenSource()}>");
    expect(newAppViewSource).toMatch(/<Show\s+when=\{hasChosenSource\(\)\}/u);
    expect(newAppViewSource).toContain('activeTab() === "git"');
    expect(newAppViewSource).toContain('setActiveTab("store")');
    expect(newAppViewSource).not.toContain('<code class="av-store-src"');
    expect(newAppViewSource).not.toContain('t("new.store.provider"');
    expect(newAppViewSource).not.toContain('aria-label="Add method"');
    expect(en).not.toHaveProperty("new.tab.store");
    expect(en).not.toHaveProperty("new.tab.git");
    expect(en).not.toHaveProperty("new.store.select");
    expect(en).not.toHaveProperty("new.store.subtitle");
    expect(en).not.toHaveProperty("new.store.title");
    expect(en).not.toHaveProperty("new.store.featuredTitle");
    expect(en).not.toHaveProperty("new.store.searchPlaceholder");
    expect(en).not.toHaveProperty("new.manualCard.title");
    expect(en).not.toHaveProperty("new.manualCard.action");
    expect(en).not.toHaveProperty("new.store.add");
    expect(en).not.toHaveProperty("new.store.kind.worker");
    expect(en).not.toHaveProperty("new.store.kind.site");
    expect(en["new.summary.provider"]).toBe("Runs on");
    expect(en).not.toHaveProperty("new.store.blocksTitle");
    expect(en).not.toHaveProperty("new.store.examplesTitle");
    expect(en).not.toHaveProperty("new.advancedImport.open");
    expect(en["new.discovery.title"]).toBe("Choose a service to add");
    expect(ja["new.discovery.title"]).toBe("追加するサービスを選ぶ");
    expect(ja).not.toHaveProperty("new.tab.store");
    expect(ja).not.toHaveProperty("new.tab.git");
    expect(ja).not.toHaveProperty("new.store.select");
    expect(ja).not.toHaveProperty("new.store.subtitle");
    expect(ja).not.toHaveProperty("new.store.title");
    expect(ja).not.toHaveProperty("new.store.featuredTitle");
    expect(ja).not.toHaveProperty("new.store.searchPlaceholder");
    expect(ja).not.toHaveProperty("new.manualCard.title");
    expect(ja).not.toHaveProperty("new.manualCard.action");
    expect(ja).not.toHaveProperty("new.store.add");
    expect(ja).not.toHaveProperty("new.store.kind.worker");
    expect(ja).not.toHaveProperty("new.store.kind.site");
    expect(ja).not.toHaveProperty("new.store.kind.storage");
    expect(ja["new.summary.provider"]).toBe("ホスト先");
    expect(ja).not.toHaveProperty("new.store.blocksTitle");
    expect(ja).not.toHaveProperty("new.store.examplesTitle");
    expect(ja).not.toHaveProperty("new.advancedImport.open");
    expect(en).not.toHaveProperty("new.flow.sourceMeta");
    expect(ja).not.toHaveProperty("new.flow.sourceMeta");
    expect(en).not.toHaveProperty("new.selection.sourceDetails");
    expect(ja).not.toHaveProperty("new.selection.sourceDetails");
    expect(en["new.providers.alias"]).toBe("Target: {alias}");
    expect(ja["new.providers.alias"]).toBe("対象: {alias}");
  });

  test("opens /new on service discovery while install links prefill the add flow", () => {
    expect(newAppViewSource).toContain("function initialAddTab");
    expect(newAppViewSource).toContain("parseInitialTcsHandoff(search)");
    expect(newAppViewSource).not.toContain("parseInitialInstallConfigId");
    expect(newAppViewSource).toContain("!hasInstallPrefillParams(search)");
    expect(newAppViewSource).not.toContain('if (hasPrefill) return "git"');
    expect(newAppViewSource).not.toContain('params.get("mode") === "link"');
    expect(newAppViewSource).toContain("initialAddTab(initialSearch)");
    expect(newAppViewSource).toContain('createSignal<"store" | "git">(');
  });

  test("the wizard chrome is gone; store [入手] auto-starts the single install action", () => {
    // No 選択→設定→確認 step rail — installing feels like an app store, not a
    // deploy console. The flow still stops on real blockers.
    expect(newAppViewSource).toContain("const hasChosenSource = () =>");
    expect(newAppViewSource).not.toContain("addGuideStage");
    expect(newAppViewSource).not.toContain("addGuideClass");
    expect(newAppViewSource).not.toContain("av-add-guide");
    expect(appViewsCssSource).not.toContain(".av-add-guide");
    // ?auto=1 (appended by the store's 入手 button) fires submitInstall once
    // prerequisites settle; validation errors fall back to the visible form.
    expect(newAppViewSource).toContain(
      'new URLSearchParams(initialSearch).get("auto") === "1"',
    );
    expect(newAppViewSource).toContain("autoInstallAttempted = true;");
    expect(newAppViewSource).toContain("void submitInstall();");
    expect(newAppViewSource).toContain("tcsHandoffSettled()");
  });

  test("required store inputs (domain / password / initial setup) are never folded away", () => {
    // .well-known/tcs.json required inputs must render on the visible sheet
    // even when marked secret/advanced — only OPTIONAL extras fold into
    // 詳細設定. Raw generic API phrases must not surface as 詳細 either.
    expect(newAppViewSource).toContain(
      "(!field.required && (field.advanced === true || field.secret === true))",
    );
    expect(newAppViewSource).toContain(
      '/^(internal error|invalid request|not found)$/iu',
    );
  });

  test("treats pasted install links as active prefill state, not raw git input", () => {
    expect(newAppViewSource).toContain("activeInstallPrefill");
    expect(newAppViewSource).toContain("setActiveInstallPrefill(next)");
    expect(newAppViewSource).toContain(
      "setInputVariables(inputVariableRowsFromPrefill(next.vars))",
    );
    expect(newAppViewSource).not.toContain("SYSTEM_INSTALL_VARIABLE_NAMES");
    expect(newAppViewSource).not.toContain("ADVANCED_INSTALL_VARIABLE_NAMES");
    expect(newAppViewSource).toContain("currentInstallPrefill()?.vars ?? {}");
    expect(newAppViewSource).toContain("activeInstallPrefill()");
    expect(newAppViewSource).toContain("? prefilledLinkReview()");
    expect(newAppViewSource).toContain(": gitFields()");
    expect(newAppViewSource).toContain("setActiveInstallPrefill(null)");
    expect(newAppViewSource).not.toContain(
      "prefill ? prefilledLinkReview() : gitFields()",
    );
  });

  test("known Git sources keep app store metadata even when ref differs", () => {
    expect(newAppViewSource).toContain("storeListingForCurrentSource");
    expect(newAppViewSource).toContain("storeListingMatchesCurrentSource");
    // Presentation metadata comes from repo-owned metadata hydrated onto the
    // picked store listing, not a hardcoded local store.
    expect(newAppViewSource).toContain("selectedStoreListing()");
    expect(newAppViewSource).toContain("hydrateTcsListingWithRepoMetadata");
    expect(newAppViewSource).toContain("hydrateStoreListing");
    expect(newAppViewSource).not.toContain("localStoreListings");
    expect(newAppViewSource).toContain("sameGitUrl");
    expect(newAppViewSource).toContain("normalizeSourcePath");
    expect(newAppViewSource).not.toContain(
      "listing.source.ref && listing.source.ref !== sourceRef()",
    );
    expect(newAppViewSource).not.toContain(
      "...(listing.source.ref ? { ref: listing.source.ref } : {})",
    );
    expect(newAppViewSource).toContain(
      "const listing = storeListingForCurrentSource()",
    );
    expect(newAppViewSource).toContain("storeMetadataFromStoreListing");
    expect(newAppViewSource).not.toContain(
      "{ installExperience: listing.installExperience }",
    );
    expect(newAppViewSource).not.toContain(
      "const listing = activeStoreListing();\n    return listing ? storeMetadataFromStoreListing",
    );
  });

  test("store metadata is normalized before being sent to the control API", () => {
    expect(newAppViewSource).toContain("DEFAULT_STORE_BADGE");
    expect(newAppViewSource).toContain("nonEmptyStoreText(listing.badge)");
    expect(newAppViewSource).toContain(
      "badge: nonEmptyStoreText(listing.badge) ?? DEFAULT_STORE_BADGE",
    );
    expect(newAppViewSource).toContain(
      "name: nonEmptyStoreText(listing.name) ?? fallbackName",
    );
    expect(newAppViewSource).toContain(
      "description: nonEmptyStoreText(listing.description) ?? fallbackName",
    );
  });

  test("known Git sources derive setup defaults from root module variables", () => {
    expect(newAppViewSource).toContain("standardCapsuleVariableDefaults");
    expect(newAppViewSource).toContain("rootModuleVariables");
    expect(newAppViewSource).toContain("standardServiceNameVariable");
    expect(newAppViewSource).toContain("standardPublicSubdomainVariable");
    expect(newAppViewSource).toContain("standardPublicUrlVariable");
    expect(newAppViewSource).toContain(
      "serviceNameHintIsGenerated(storeServiceNameDefault())",
    );
    expect(newAppViewSource).toContain(
      "Object.assign(variables, standardCapsuleVariableDefaults(variables))",
    );
    expect(newAppViewSource).toContain(
      "...storeListingDefaultVariables(),\n      ...(currentInstallPrefill()?.vars ?? {})",
    );
    expect(newAppViewSource).toContain("storeListingVariableNames");
    expect(newAppViewSource).toContain("...storeListingVariableNames()");
  });

  test("prefers managed provider connections for known store sources", () => {
    expect(newAppViewSource).toContain(
      "const listing = storeListingForCurrentSource()",
    );
    expect(newAppViewSource).toContain(
      "providerTail(listing.provider) === provider",
    );
    expect(newAppViewSource).toContain(
      "connection.scopeHints?.managedProvider === true",
    );
    expect(newAppViewSource).toContain("score += 1_000");
  });

  test("normalizes pasted install links before checking or creating the source", () => {
    expect(newAppViewSource).toContain("const currentInstallPrefill = () =>");
    expect(newAppViewSource).toContain("const sourceGitUrl = () =>");
    expect(newAppViewSource).toContain("gitUrl: sourceGitUrl()");
    expect(newAppViewSource).toContain("ref: sourceRef()");
    expect(newAppViewSource).toContain("const installModulePath = () =>");
    expect(newAppViewSource).toContain("path: installModulePath()");
    expect(newAppViewSource).toContain('defaultPath: "."');
    expect(newAppViewSource).toContain("modulePath: flowInput.path");
    expect(newAppViewSource).toContain("selectedInstallConfig()?.modulePath");
    expect(newAppViewSource).toContain("<dd>{displayRef(sourceRef())}</dd>");
    expect(newAppViewSource).toContain(
      "<dd>{displayModulePath(sourcePath())}</dd>",
    );
    expect(controlApiSource).toContain('defaultPath: "."');
    expect(controlApiSource).toContain(
      'input.path && input.path !== "." ? { modulePath: input.path } : {}',
    );
  });

  test("generated service-name hints follow the visible service name mapping", () => {
    expect(newAppViewSource).toContain("function serviceNameHintIsGenerated");
    expect(newAppViewSource).toContain(
      'value === "service-name" || value === "service-name-with-space"',
    );
    expect(newAppViewSource).toContain("serviceNameVariableForCurrentSource");
    expect(newAppViewSource).toContain(
      "slugInputValue(resourcePrefix() || defaultProjectName())",
    );
    expect(newAppViewSource).toContain("const isGeneratedProjectName =");
    expect(newAppViewSource).toContain(
      "serviceNameHintIsGenerated(nextProjectName)",
    );
    expect(newAppViewSource).not.toContain('name="project_name"');
  });

  test("does not allow install-link submit before add configuration loads", () => {
    expect(newAppViewSource).toContain("const installConfigLoading = () =>");
    expect(newAppViewSource).toContain(
      'if (installConfigLoading()) return t("new.error.configLoading")',
    );
    expect(newAppViewSource).toContain("installConfigLoading() ||");
    expect(en["new.error.configLoading"]).toContain(
      "Loading add configuration",
    );
    expect(ja["new.error.configLoading"]).toContain("追加設定を読み込み中");
  });

  test("/new sources installable apps from the store, not a hardcoded store", () => {
    // The dashboard-local installable-app-listings.ts is retired; discovery is
    // served by the takosumi-store node(s); the picked listing is hydrated from
    // repo-owned presentation metadata.
    expect(newAppViewSource).not.toContain("installable-app-listings");
    expect(newAppViewSource).not.toContain("installableAppStoreListings");
    expect(newAppViewSource).not.toContain("localStoreListings");
    // The /new embedded browser fetches from the store on mount (no
    // loadRemoteOnMount={false} that would leave it dependent on a local list).
    expect(newAppViewSource).not.toContain("loadRemoteOnMount={false}");
    expect(newAppViewSource).toContain("selectedStoreListing");
    expect(newAppViewSource).toContain("hydrateTcsListingWithRepoMetadata");
  });

  test("/new uses active Capsule list reads instead of loading destroyed history", () => {
    expect(controlApiSource).toContain("includeDestroyed");
    expect(controlApiSource).toContain('includeDestroyed: "false"');
    expect(newAppViewSource).toContain("listCapsulesCached");
    expect(newAppViewSource).toContain("includeDestroyed: false");
    expect(newAppViewSource).toContain("clearCapsuleListCache(workspace)");
  });

  test("/new defers config API reads until a Git source or store listing is selected", () => {
    expect(newAppViewSource).not.toContain(
      "const shouldLoadTemplateConfigs = ()",
    );
    expect(newAppViewSource).not.toContain("initialInstallConfigId");
    expect(newAppViewSource).toContain("const shouldLoadInstallConfigs = ()");
    expect(newAppViewSource).toContain('activeTab() === "git"');
    expect(newAppViewSource).toContain(
      "gitUrl().trim() || activeInstallPrefill() || selectedStoreListing()",
    );
    expect(newAppViewSource).not.toMatch(
      /createResource\(\s*shouldLoadTemplateConfigs/u,
    );
    expect(newAppViewSource).toMatch(
      /createResource\(\s*shouldLoadInstallConfigs/u,
    );
    expect(newAppViewSource).not.toContain(
      "createResource(workspaceId, listTemplateStoreInstallConfigs",
    );
    expect(newAppViewSource).not.toContain(
      "createResource(workspaceId, (id) =>\n    listInstallConfigs(id)",
    );
    expect(newAppViewSource).toContain("listInstallConfigsCached");
  });

  test("keeps internal template configs separate from /new app discovery", () => {
    const bootstrapSource = readFileSync(
      resolve(
        here,
        "../../../../../core/domains/capsules/install_config_bootstrap.ts",
      ),
      "utf8",
    );
    expect(bootstrapSource).toContain('"cloudflare-hello-worker"');
    expect(bootstrapSource).toContain("storeMetadataForTemplate");
    expect(bootstrapSource).toContain("builtInStoreSource");
    expect(bootstrapSource).toContain('name: "accountId"');
    expect(bootstrapSource).toContain('name: "workersSubdomain"');
    expect(bootstrapSource).not.toContain('name: "bucketName"');
    expect(bootstrapSource).toContain(
      'defaultValue: "service-name-with-space"',
    );
    expect(controlApiSource).toContain("listTemplateStoreInstallConfigs");
    expect(newAppViewSource).not.toContain("STORE_VIEW");
    expect(newAppViewSource).not.toContain(
      "const allStoreEntries = createMemo",
    );
    expect(newAppViewSource).not.toContain("selectedStoreEntry");
    expect(newAppViewSource).not.toContain("storeEntryToListing");
    expect(newAppViewSource).not.toContain(
      "createResource(workspaceId, listInstallConfigs)",
    );
  });

  test("store handoffs use listing metadata and generic Capsule config only", () => {
    expect(newAppViewSource).not.toContain("STORE_VIEW");
    expect(newAppViewSource).not.toContain("const [templateConfigs]");
    expect(newAppViewSource).toContain("const [installConfigs]");
    expect(newAppViewSource).toContain("listInstallConfigsCached(id)");
    expect(newAppViewSource).toContain("const installConfigList");
    expect(newAppViewSource).toContain("installConfigList().find");
    expect(newAppViewSource).toContain('sourceKind === "generic_capsule"');
    expect(newAppViewSource).not.toContain("templateConfigList().length === 0");
    expect(newAppViewSource).not.toContain("parseInitialInstallConfigId");
  });

  test("selected store services use friendly setup fields instead of raw variables", () => {
    expect(newAppViewSource).not.toContain("selectedStoreEntry");
    expect(newAppViewSource).toContain("storeServiceEntry");
    expect(newAppViewSource).toContain("selectedServiceEntry");
    expect(newAppViewSource).toContain(
      "const selectedServiceEntry = () => storeServiceEntry()",
    );
    expect(newAppViewSource).toContain("storeEntryFromStoreListing");
    expect(newAppViewSource).toContain("selectedStoreVariables");
    expect(newAppViewSource).toContain("selectedStoreReturnVariables");
    expect(newAppViewSource).toContain("storeInputJsonValue");
    expect(newAppViewSource).toContain("setStoreJsonVariable");
    expect(newAppViewSource).toContain("storeVariablePath");
    expect(newAppViewSource).toContain("storeInputError");
    expect(newAppViewSource).toContain(
      "defaultGitInstallConfig()?.id ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID",
    );
    expect(newAppViewSource).not.toContain("listing.installConfigId");
    expect(newAppViewSource).not.toContain("storeListing.installConfigId");
    expect(newAppViewSource).toContain('class="av-service-setup"');
    expect(newAppViewSource).toContain('t("new.storeInput.title")');
    expect(newAppViewSource).toContain('t("new.storeInput.subtitle")');
    expect(newAppViewSource).not.toContain('t("new.storeInput.body")');
    expect(newAppViewSource).toContain('<FormField label={t("new.name")}>');
    expect(newAppViewSource).toContain("name={`storeInput:${field.name}`}");
    expect(newAppViewSource).toContain("clearSelectedStoreEntry");
    expect(newAppViewSource).toContain("defaultGitInstallConfig()?.id");
    expect(appViewsCssSource).toContain(".av-service-setup-grid");
    expect(appViewsCssSource).toContain(".av-service-setup-head p");
    expect(en).not.toHaveProperty("new.storeInput.body");
    expect(en["new.storeInput.subtitle"]).toContain("minimum fields");
    expect(ja).not.toHaveProperty("new.storeInput.body");
    expect(ja["new.storeInput.subtitle"]).toContain("最小限");
  });

  test("does not hard-code Takos repo behavior into the add flow", () => {
    expect(newAppViewSource).not.toContain("isTakosOpenTofuCapsule");
    expect(newAppViewSource).not.toContain("supportsCloudflareScopeInput");
    expect(newAppViewSource).not.toContain('repo.endsWith("/takos")');
  });

  test("service setup defaults managed domains without app-specific branches", () => {
    expect(newAppViewSource).toContain("serviceIdSeed");
    expect(newAppViewSource).toContain("standardManagedHost");
    expect(newAppViewSource).toContain("standardManagedUrl");
    expect(newAppViewSource).toContain("standardPublicSubdomainVariable");
    expect(newAppViewSource).toContain("standardPublicUrlVariable");
    expect(newAppViewSource).toContain("standardRoutePatternVariable");
    expect(newAppViewSource).toContain("canSuggestPublicHostname");
    expect(newAppViewSource).toContain("storePublicEndpointSubdomainField");
    expect(newAppViewSource).toContain("hostIsManagedBaseDomainSubdomain");
    expect(newAppViewSource).toContain("new.storeInput.errorCustomDomain");
    expect(newAppViewSource).not.toContain("hostIsUnderBaseDomain");
    expect(newAppViewSource).not.toContain('entry.id === "takos"');
    expect(newAppViewSource).not.toContain('entry.id === "yurucommu"');
  });

  test("selected store services can use safe cloud-account hints instead of duplicate setup input", () => {
    const hintSourceStart = newAppViewSource.indexOf(
      "const storeScopeHintValue",
    );
    const hintSourceEnd = newAppViewSource.indexOf(
      "const sourceGitConnections",
      hintSourceStart,
    );
    expect(hintSourceStart).toBeGreaterThan(-1);
    expect(hintSourceEnd).toBeGreaterThan(hintSourceStart);
    const hintSource = newAppViewSource.slice(hintSourceStart, hintSourceEnd);

    expect(newAppViewSource).toContain("storeScopeHintValue");
    expect(newAppViewSource).toContain("scopeHintValueForStoreInput");
    expect(hintSource).toContain("connection.scopeHints?.accountId");
    expect(hintSource).toContain("connection.scopeHints?.awsRegion");
    expect(hintSource).toContain("connection.scopeHints?.zoneId");
    expect(hintSource).toContain("connection.scopeHints?.workersSubdomain");
    expect(hintSource).not.toContain('entry.provider === "cloudflare"');
    expect(hintSource).not.toContain('entry.provider === "aws"');
    expect(newAppViewSource).toContain("storeInputTouched");
    expect(newAppViewSource).toContain("isConnectionScopedStoreInput");
    expect(newAppViewSource).toContain("hasMissingAdvancedStoreInputs");
    expect(newAppViewSource).toContain(
      "const scopeHint = storeScopeHintValue(entry, field)",
    );
    expect(newAppViewSource).toContain("if (scopeHint === undefined) continue");
    expect(newAppViewSource).toContain("next[key] = scopeHint");
    expect(newAppViewSource).toContain(
      "if (storeInputTouched()[key]) continue",
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
    expect(newAppViewSource).toContain("selectedStoreVariableNames");
    expect(newAppViewSource).toContain("shouldOpenServiceAdvanced() ||");
    expect(newAppViewSource).toContain("hasMissingAdvancedStoreInputs()");
    expect(newAppViewSource).toContain('t("new.vars.inputsTitle")');
    expect(newAppViewSource).toContain("name={`varName:${index()}`}");
    expect(newAppViewSource).toContain("name={`varValue:${index()}`}");
    expect(newAppViewSource).toContain("inputVariableError");
    expect(en["new.vars.errorStoreReserved"]).toContain("Service setup");
    expect(ja["new.vars.errorStoreReserved"]).toContain("サービス設定");
    expect(en["new.vars.inputsBody"].toLowerCase()).toContain("visible inputs");
    expect(ja["new.vars.inputsBody"]).toContain("表示用の入力");
    expect(en["new.vars.inputsTitle"]).not.toBe("Advanced settings");
    expect(ja["new.vars.inputsTitle"]).not.toBe("詳細設定");
  });

  test("keeps plain environment variables dynamic and separate from fixed setup inputs", () => {
    expect(newAppViewSource).toContain("interface EnvVariableRow");
    expect(newAppViewSource).toContain("envVariableRowsFromPrefill");
    expect(newAppViewSource).toContain("isSafePlainEnvName");
    expect(newAppViewSource).toContain("normalizedEnvVariables");
    expect(newAppViewSource).toContain("mergeEnvVariables");
    expect(newAppViewSource).toContain("envVariables().length > 0");
    expect(newAppViewSource).toContain('t("new.env.title")');
    expect(newAppViewSource).toContain("name={`envName:${index()}`}");
    expect(newAppViewSource).toContain("name={`envValue:${index()}`}");
    expect(newAppViewSource).toContain(
      "setEnvVariables(envVariableRowsFromPrefill(next.vars))",
    );
    expect(newAppViewSource).toContain(
      "mergeEnvVariables(variables, normalizedEnvVariables())",
    );
    expect(en["new.env.title"]).toBe("Environment variables");
    expect(ja["new.env.title"]).toBe("環境変数");
    expect(en["new.env.body"].toLowerCase()).toContain("plain text");
    expect(ja["new.env.body"]).toContain("秘密値");
    expect(en["new.env.errorUnsafeName"]).toContain("Secrets");
    expect(ja["new.env.errorUnsafeName"]).toContain("Secret");
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

  test("keeps install progress copy app-oriented instead of OpenTofu-oriented", () => {
    const forbiddenRawTerms =
      /\b(Terraform|OpenTofu|tofu|init|plan|apply|module|provider|variable)\b/iu;
    const progressEntries = [
      ...Object.entries(en),
      ...Object.entries(ja),
    ].filter(([key]) => /^new\.(install|progress|step)\./u.test(key));
    expect(progressEntries.length).toBeGreaterThan(0);
    for (const [, value] of progressEntries) {
      expect(value).not.toMatch(forbiddenRawTerms);
    }
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
