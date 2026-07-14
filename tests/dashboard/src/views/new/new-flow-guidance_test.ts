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
    resolve(here, "../../../../../dashboard/src/views/new/install-helpers.ts"),
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
    expect(newAppViewSource).toContain("return <Package size={20} />");
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
    expect(newAppViewSource).toContain("config.store?.source");
    expect(newAppViewSource).toContain("installConfigForStoreListing");
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
    expect(newAppViewSource).toContain('url.searchParams.delete("auto")');
    expect(newAppViewSource).toContain("window.history.replaceState(");
    expect(newAppViewSource).toContain("void submitInstall();");
    expect(newAppViewSource).toContain("tcsHandoffSettled()");
  });

  test("install-contract inputs (domain / password / initial setup) are never folded away", () => {
    // Required inputs and an optional secret projected as `initial_secret`
    // must render on the visible setup sheet. Unprojected optional secrets
    // remain available under advanced settings.
    expect(newAppViewSource).toContain(
      "installExperienceInitialSecret(entry.installExperience)?.variable",
    );
    expect(newAppViewSource).toContain(
      "!isInitialSecretStoreInput(entry, field)",
    );
    expect(newAppViewSource).toContain(
      "/^(internal error|invalid request|not found)$/iu",
    );
  });

  test("treats pasted install links as active prefill state, not raw git input", () => {
    expect(newAppViewSource).toContain("activeInstallPrefill");
    expect(newAppViewSource).toContain("setActiveInstallPrefill(next)");
    // Install links identify a plain Git/OpenTofu source. They never carry
    // module inputs or environment material as a configuration side channel.
    expect(newAppViewSource).not.toContain("next.vars");
    expect(newAppViewSource).not.toContain("inputVariableRowsFromPrefill");
    expect(newAppViewSource).not.toContain("envVariableRowsFromPrefill");
    expect(newAppViewSource).toContain("setInputVariables([])");
    expect(newAppViewSource).toContain("setEnvVariables([])");
    expect(newAppViewSource).not.toContain("SYSTEM_INSTALL_VARIABLE_NAMES");
    expect(newAppViewSource).not.toContain("ADVANCED_INSTALL_VARIABLE_NAMES");
    expect(newAppViewSource).not.toContain("currentInstallPrefill()?.vars");
    expect(newAppViewSource).toContain("activeInstallPrefill()");
    expect(newAppViewSource).toContain("? prefilledLinkReview()");
    expect(newAppViewSource).toContain(": gitFields()");
    expect(newAppViewSource).toContain("setActiveInstallPrefill(null)");
    expect(newAppViewSource).not.toContain(
      "prefill ? prefilledLinkReview() : gitFields()",
    );
  });

  test("Store matching ignores the optional ref hint and never adopts it", () => {
    expect(newAppViewSource).toContain("storeListingForCurrentSource");
    expect(newAppViewSource).toContain("storeListingMatchesCurrentSource");
    // The picked Store row is a discovery pointer. Its optional ref cannot
    // select an InstallConfig or the effective Source ref.
    expect(newAppViewSource).toContain("selectedStoreListing()");
    expect(newAppViewSource).not.toContain(
      "hydrateRequiredTcsListingWithRepoMetadata",
    );
    expect(newAppViewSource).toContain("prepareStoreListing");
    expect(newAppViewSource).not.toContain("localStoreListings");
    expect(newAppViewSource).toContain("sameGitUrl");
    expect(newAppViewSource).toContain("normalizeSourcePath");
    expect(newAppViewSource).not.toContain(
      "listing.source.ref && listing.source.ref !== sourceRef()",
    );
    expect(newAppViewSource).not.toContain(
      "...(listing.source.ref ? { ref: listing.source.ref } : {})",
    );
    expect(newAppViewSource).toContain("url: listing.source.url");
    expect(newAppViewSource).toContain(
      "storeInstallConfigsForSource(\n      installConfigList(),\n      listing.source.url,\n      listing.source.path",
    );
    expect(newAppViewSource).not.toContain(
      "listing.source.ref.trim() !== sourceRef().trim()",
    );
    expect(newAppViewSource).not.toContain("setRef(listing.source.ref)");
    expect(newAppViewSource).toContain("storeMetadataFromStoreListing");
    expect(newAppViewSource).not.toContain(
      "const listing = activeStoreListing();\n    return listing ? storeMetadataFromStoreListing",
    );
  });

  test("direct Git links select only a unique service-side URL/path InstallConfig", () => {
    expect(newAppViewSource).toContain("sourceCoordinateForInstallConfig");
    expect(newAppViewSource).toContain("storeInstallConfigsForSource(");
    expect(newAppViewSource).toContain("sourceMatches.length === 1");
    expect(newAppViewSource).toContain("sourceMatches.length === 0");
    expect(newAppViewSource).toContain(': "";');
    expect(newAppViewSource).toContain("if (matches.length > 1) return null");
    expect(newAppViewSource).not.toContain("listing.source.ref.trim()");
  });

  test("direct Git hand-offs do not adopt repository-owned execution setup", () => {
    expect(newAppViewSource).not.toContain("fetchTcsRepoMetadata");
    expect(newAppViewSource).not.toContain("listingFromSnapshot");
    expect(newAppViewSource).not.toContain("repositoryInstallMetadata");
    expect(newAppViewSource).not.toContain("adoptRepoOwnedListing");
    expect(controlApiSource).toContain("onSourceSnapshot?.(snapshot)");
  });

  test("store metadata stays presentation-only and is not sent on Capsule creation", () => {
    expect(newAppViewSource).toContain("DEFAULT_STORE_BADGE");
    expect(newAppViewSource).toContain("nonEmptyStoreText(listing.badge)");
    expect(newAppViewSource).toContain(
      "badge: nonEmptyStoreText(listing.badge) ?? DEFAULT_STORE_BADGE",
    );
    expect(newAppViewSource).toContain(
      "name: nonEmptyStoreText(listing.name) ?? fallbackName",
    );
    expect(newAppViewSource).not.toContain("inputs: listing.inputs ?? []");
    expect(newAppViewSource).toContain(
      "inputs: installConfig.variablePresentation ?? []",
    );
    expect(newAppViewSource).toContain(
      "{ installExperience: installConfig.installExperience }",
    );
    expect(newAppViewSource).toContain(
      "description: nonEmptyStoreText(listing.description) ?? fallbackName",
    );
    expect(newAppViewSource).not.toContain("storeMetadataForRun");
    expect(newAppViewSource).not.toContain("flowInput.store");
    expect(controlApiSource).not.toContain("readonly store?: NonNullable");
    expect(controlApiSource).not.toContain("...(input.store ? { store:");
  });

  test("Store discovery does not opt a Capsule into auto-update", () => {
    expect(newAppViewSource).not.toContain(
      "Store installs opt into auto-update",
    );
    expect(newAppViewSource).not.toContain(
      "...(flowInput.store ? { autoUpdate: true } : {})",
    );
  });

  test("root module variable names do not declare app or endpoint metadata", () => {
    expect(newAppViewSource).not.toContain("standardCapsuleVariableDefaults");
    expect(newAppViewSource).not.toContain("standardServiceNameVariable");
    expect(newAppViewSource).not.toContain("standardPublicSubdomainVariable");
    expect(newAppViewSource).not.toContain("standardPublicUrlVariable");
    expect(newAppViewSource).not.toContain('"project_name"');
    expect(newAppViewSource).not.toContain('"public_subdomain"');
    expect(newAppViewSource).not.toContain('"worker_name"');
    expect(newAppViewSource).not.toContain('"app_name"');
    expect(newAppViewSource).not.toContain('"public_url"');
    expect(newAppViewSource).not.toContain('"app_url"');
    expect(newAppViewSource).not.toContain(
      "Object.assign(variables, standardCapsuleVariableDefaults(variables))",
    );
  });

  test("explicit installExperience mappings remain authoritative", () => {
    expect(newAppViewSource).toContain("installExperienceForCurrentSource");
    expect(newAppViewSource).toContain("storeServiceNameVariable");
    expect(newAppViewSource).toContain(
      "installExperiencePublicEndpoint(installExperience)",
    );
    expect(newAppViewSource).toContain("if (publicEndpoint)");
    expect(newAppViewSource).toContain(
      "const subdomainVariable = publicEndpoint.subdomainVariable?.trim()",
    );
    expect(newAppViewSource).toContain(
      "const urlVariable = publicEndpoint.urlVariable?.trim()",
    );
    expect(newAppViewSource).toContain(
      "serviceNameHintIsGenerated(storeServiceNameDefault())",
    );
    expect(newAppViewSource).toContain("...storeListingDefaultVariables()");
    expect(newAppViewSource).toContain("...selectedStoreVariables()");
    expect(newAppViewSource).not.toContain("currentInstallPrefill()?.vars");
    expect(newAppViewSource).toContain("storeListingVariableNames");
    expect(newAppViewSource).toContain("...storeListingVariableNames()");
  });

  test("uses explicit managed-provider metadata for store fallback", () => {
    expect(newAppViewSource).toContain(
      "const managedProviderConnectionForRow =",
    );
    expect(newAppViewSource).toContain("providerConnectionsForRow(row).find(");
    expect(newAppViewSource).toContain("isPublicManagedProviderConnection");
    expect(newAppViewSource).not.toContain(
      "scopeHints?.managedProvider === true",
    );
    expect(newAppViewSource).not.toContain(
      "connection.scopeHints.providerConfig?.base_url",
    );
    expect(newAppViewSource).not.toContain("providerConnectionScore");
    expect(newAppViewSource).not.toContain("score += 1_000");
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
    expect(newAppViewSource).toContain('value?.source === "capsule_name"');
    expect(newAppViewSource).toContain(
      'value?.source === "workspace_scoped_capsule_name"',
    );
    expect(newAppViewSource).toContain("serviceNameVariableForCurrentSource");
    expect(newAppViewSource).toContain(
      "slugInputValue(resourcePrefix() || defaultProjectName())",
    );
    expect(newAppViewSource).toContain("const isGeneratedProjectName =");
    expect(newAppViewSource).toMatch(
      /serviceNameHintIsGenerated\(\s*nextProjectNameDefault[,\s]*\)/u,
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
    // served by configured TCS node(s); the picked listing remains a discovery
    // pointer until Source sync observes optional repository presentation.
    expect(newAppViewSource).not.toContain("installable-app-listings");
    expect(newAppViewSource).not.toContain("installableAppStoreListings");
    expect(newAppViewSource).not.toContain("localStoreListings");
    // The /new embedded browser fetches from the store on mount (no
    // loadRemoteOnMount={false} that would leave it dependent on a local list).
    expect(newAppViewSource).not.toContain("loadRemoteOnMount={false}");
    expect(newAppViewSource).toContain("selectedStoreListing");
    expect(newAppViewSource).not.toContain(
      "hydrateRequiredTcsListingWithRepoMetadata",
    );
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

  test("uses one plain OpenTofu default instead of built-in app templates", () => {
    const defaultConfigSource = readFileSync(
      resolve(
        here,
        "../../../../../core/domains/capsules/default_install_config.ts",
      ),
      "utf8",
    );
    expect(defaultConfigSource).toContain('name: "opentofu-capsule"');
    expect(defaultConfigSource).toContain("variableMapping: {}");
    expect(defaultConfigSource).not.toContain("\n    store:");
    expect(defaultConfigSource).not.toContain("\n    variablePresentation:");
    expect(newAppViewSource).toContain(
      "config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID",
    );
    expect(newAppViewSource).toContain(
      'config.name === "opentofu-capsule" && !config.store',
    );
    expect(newAppViewSource).not.toContain("config.workspaceId === undefined");
    expect(newAppViewSource).not.toContain("installConfigList()[0]");
    expect(controlApiSource).not.toContain("listTemplateStoreInstallConfigs");
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

  test("store handoffs use listing metadata and a service-side InstallConfig", () => {
    expect(newAppViewSource).not.toContain("STORE_VIEW");
    expect(newAppViewSource).not.toContain("const [templateConfigs]");
    expect(newAppViewSource).toContain(
      "const [installConfigs, { refetch: refetchInstallConfigs }]",
    );
    expect(newAppViewSource).toContain("listInstallConfigsCached(id)");
    expect(newAppViewSource).toContain("const installConfigList");
    expect(newAppViewSource).toContain("installConfigList().find");
    expect(newAppViewSource).toContain("defaultGitInstallConfig() ?? {");
    expect(newAppViewSource).not.toContain("listing.installConfigId");
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
    expect(newAppViewSource).not.toContain("selectedStoreReturnVariables");
    expect(newAppViewSource).toContain("storeInputJsonValue");
    expect(newAppViewSource).toContain("setStoreJsonVariable");
    expect(newAppViewSource).toContain("storeVariablePath");
    expect(newAppViewSource).toContain("storeInputError");
    expect(newAppViewSource).toContain("installConfigForStoreListing(listing)");
    expect(newAppViewSource).toContain("defaultGitInstallConfig() ?? {");
    expect(newAppViewSource).not.toContain("listing.installConfigId");
    expect(newAppViewSource).not.toContain("storeListing.installConfigId");
    expect(newAppViewSource).toContain('class="av-service-setup"');
    expect(newAppViewSource).toContain('t("new.storeInput.title")');
    expect(newAppViewSource).toContain('t("new.storeInput.subtitle")');
    expect(newAppViewSource).not.toContain('t("new.storeInput.body")');
    // The service-name field carries live inline validation (error prop +
    // invalid input state) instead of the old bare label-only FormField.
    expect(newAppViewSource).toContain('label={t("new.name")}');
    expect(newAppViewSource).toContain("error={serviceNameFieldError()}");
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

  test("service setup supports explicitly mapped managed domains without app-specific branches", () => {
    expect(newAppViewSource).toContain("serviceNameInputValue");
    expect(newAppViewSource).toContain("managedServiceLabel");
    expect(newAppViewSource).toContain("managedPublicHostnameMode");
    expect(newAppViewSource).toContain(
      "selectedManagedProviderConnection() ||",
    );
    expect(newAppViewSource).toContain('t("new.hostname.mode.vanity")');
    expect(newAppViewSource).toContain("managedPublicHostname:");
    // Managed-host derivation lives server-side (9f2912c9); the old client
    // helpers hardcoding app.takos.jp are gone for good.
    expect(newAppViewSource).not.toContain("standardManagedHost");
    expect(newAppViewSource).not.toContain("standardManagedUrl");
    expect(newAppViewSource).not.toContain("standardPublicSubdomainVariable");
    expect(newAppViewSource).not.toContain("standardPublicUrlVariable");
    expect(newAppViewSource).not.toContain("standardRoutePatternVariable");
    expect(newAppViewSource).toContain(
      "installExperiencePublicEndpoint(installExperience)",
    );
    expect(newAppViewSource).toContain("canSuggestPublicHostname");
    expect(newAppViewSource).toContain("storePublicEndpointSubdomainField");
    expect(newAppViewSource).toContain("hostIsManagedBaseDomainSubdomain");
    expect(newAppViewSource).toContain("new.storeInput.errorCustomDomain");
    expect(newAppViewSource).not.toContain("hostIsUnderBaseDomain");
    expect(newAppViewSource).not.toContain('entry.id === "takos"');
    expect(newAppViewSource).not.toContain('entry.id === "yurucommu"');
  });

  test("selected store services use only explicit install presentation metadata", () => {
    expect(newAppViewSource).toContain("field.advanced === true");
    expect(newAppViewSource).toContain(
      "installExperienceInitialSecret(entry.installExperience)?.variable",
    );
    expect(newAppViewSource).toContain(
      'type={field.secret ? "password" : "text"}',
    );
    expect(newAppViewSource).toContain("hasMissingAdvancedStoreInputs");
    expect(newAppViewSource).toContain(
      "connection.scopeHints?.moduleInputDefaults ?? {}",
    );
    expect(newAppViewSource).not.toContain("storeScopeHintValue");
    expect(newAppViewSource).not.toContain("scopeHintValueForStoreInput");
    expect(newAppViewSource).not.toContain("isConnectionScopedStoreInput");
    expect(newAppViewSource).not.toContain("storeInputHasImplicitValue");
    expect(newAppViewSource).not.toContain("connection.scopeHints?.accountId");
    expect(newAppViewSource).not.toContain("connection.scopeHints?.awsRegion");
    expect(newAppViewSource).not.toContain("connection.scopeHints?.zoneId");
    expect(newAppViewSource).not.toContain(
      "connection.scopeHints?.workersSubdomain",
    );
  });

  test("keeps arbitrary visible service inputs in the add flow", () => {
    expect(newAppViewSource).toContain("const shouldOpenServiceAdvanced = ()");
    expect(newAppViewSource).toContain("normalizedInputVariables");
    expect(newAppViewSource).not.toContain("installReturnVariables");
    expect(newAppViewSource).toContain("selectedStoreVariableNames");
    expect(newAppViewSource).toContain("shouldOpenServiceAdvanced() ||");
    expect(newAppViewSource).toContain("hasMissingAdvancedStoreInputs()");
    expect(newAppViewSource).toContain('t("new.vars.inputsTitle")');
    expect(newAppViewSource).toContain("name={`varName:${index}`}");
    expect(newAppViewSource).toContain("name={`varValue:${index}`}");
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
    expect(newAppViewSource).not.toContain("envVariableRowsFromPrefill");
    expect(newAppViewSource).toContain("isSafePlainEnvName");
    expect(newAppViewSource).toContain("normalizedEnvVariables");
    expect(newAppViewSource).toContain("mergeEnvVariables");
    expect(newAppViewSource).toContain("envVariables().length > 0");
    expect(newAppViewSource).toContain('t("new.env.title")');
    expect(newAppViewSource).toContain("name={`envName:${index}`}");
    expect(newAppViewSource).toContain("name={`envValue:${index}`}");
    expect(newAppViewSource).not.toContain("next.vars");
    expect(newAppViewSource).toContain("setEnvVariables([])");
    expect(newAppViewSource).toContain(
      "mergeEnvVariables(variables, normalizedEnvVariables())",
    );
    expect(en["new.env.title"]).toBe("Environment variables");
    expect(ja["new.env.title"]).toBe("環境変数");
    expect(en["new.env.body"].toLowerCase()).toContain("plain text");
    expect(ja["new.env.body"]).toContain("秘密の値");
    // No untranslated "Secret" noun on the consumer surface: route private
    // values through connected accounts.
    expect(en["new.env.errorUnsafeName"]).not.toContain("Secrets");
    expect(ja["new.env.errorUnsafeName"]).not.toContain("Secret");
    expect(en["new.env.errorUnsafeName"]).toContain("uppercase letters");
    expect(ja["new.env.errorUnsafeName"]).toContain("大文字の英字");
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

  test("store-card picks show busy state, surface errors in discovery, and drop stale responses", () => {
    // Hydrating a picked card fetches remote install metadata (can take
    // seconds) — the discovery section must show progress and stay retryable.
    expect(newAppViewSource).toContain(
      "const [storePickBusy, setStorePickBusy]",
    );
    expect(newAppViewSource).toContain("let storePickToken = 0;");
    expect(newAppViewSource).toContain("const token = ++storePickToken;");
    expect(newAppViewSource).toContain("if (token !== storePickToken) return;");
    expect(newAppViewSource).toContain('t("new.pick.checking")');
    expect(newAppViewSource).toContain(
      'class="wb-status-panel av-pick-status"',
    );
    // Errors from a failed pick render INSIDE the discovery section (the
    // chosen-source error slot is not mounted there) with a retry affordance.
    expect(newAppViewSource).toContain("setFailedStorePick(listing)");
    expect(newAppViewSource).toContain("pickStoreListing(listing())");
    expect(newAppViewSource).toContain(
      'class="wb-action-callout av-pick-error"',
    );
    expect(appViewsCssSource).toContain(".av-store-pick-scope.is-picking");
    expect(ja["new.pick.checking"]).toContain("確認しています");
    expect(en["new.pick.checking"].toLowerCase()).toContain("checking");
  });

  test("a chosen source can go back to the picker without leaving /new", () => {
    expect(newAppViewSource).toContain("const returnToDiscovery = () =>");
    expect(newAppViewSource).toContain("if (busy()) return;");
    expect(newAppViewSource).toContain('class="av-add-flow-back"');
    expect(newAppViewSource).toContain('t("new.flow.back")');
    expect(newAppViewSource).toContain("onClick={returnToDiscovery}");
    expect(ja["new.flow.back"]).toBe("選び直す");
    expect(en["new.flow.back"]).toBe("Choose a different service");
  });

  test("選び直す and a successful store pick move focus instead of dropping it on <body>", () => {
    expect(newAppViewSource).toContain("let discoveryHeading:");
    expect(newAppViewSource).toContain("let chosenFlowSection:");
    expect(newAppViewSource).toContain(
      "queueMicrotask(() => discoveryHeading?.focus());",
    );
    expect(newAppViewSource).toContain(
      "queueMicrotask(() => chosenFlowSection?.focus());",
    );
    expect(newAppViewSource).toMatch(
      /<h2 ref=\{discoveryHeading\} tabindex=\{-1\}>/u,
    );
    expect(newAppViewSource).toContain("ref={chosenFlowSection}");
  });

  test("the pick-busy live region mounts empty and fills a microtask later; the spinner is decorative", () => {
    // The Toast microtask pattern: a live region only announces text changing
    // INSIDE an already-mounted region, so the panel mounts empty first. The
    // Spinner carries its own role=status and is aria-hidden within it.
    expect(newAppViewSource).toContain("function StorePickBusyStatus");
    expect(newAppViewSource).toContain(
      "onMount(() => queueMicrotask(() => setAnnounce(true)));",
    );
    expect(newAppViewSource).toMatch(
      /aria-hidden="true"[\s\S]{0,80}<Spinner size=\{16\} \/>/u,
    );
    // The compact-row layout is real (the grid base stacked spinner + text).
    expect(appViewsCssSource).toMatch(/\.av-pick-status \{\s*display: flex;/u);
    expect(appViewsCssSource).toMatch(
      /\.av-pick-error \{\s*justify-items: start;/u,
    );
  });

  test("a >8s check does not leave the stale slow-flag set for the next pick", () => {
    // abortActiveFlow resets it (covers input edits and 選び直す via
    // resetCompatibility); both flow finally-blocks reset it on completion.
    const abortBlock = newAppViewSource.slice(
      newAppViewSource.indexOf("const abortActiveFlow = () => {"),
      newAppViewSource.indexOf("const finishAbortableFlow"),
    );
    expect(abortBlock).toContain("setSourceSyncSlow(false);");
    expect(
      newAppViewSource.match(/setSourceSyncSlow\(false\);/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(4);
  });

  test("editing during an install cannot abort the flow; retries reuse the created Source", () => {
    // Inputs wired to resetCompatibility are disabled while the install runs…
    expect(
      newAppViewSource.match(/disabled=\{busy\(\)\}/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(15);
    // …and the registered Source survives edits that do not change its
    // coordinates (URL / ref / auth), so retries stop accumulating Sources.
    expect(newAppViewSource).toContain(
      "const recordCreatedSource = (sourceId: string) => {",
    );
    expect(newAppViewSource).toContain(
      "createdSourceIdentity !== sourceIdentitySnapshot()",
    );
    expect(newAppViewSource).toContain("recordCreatedSource(result.sourceId)");
  });

  test("install failures expose a support request id and demote the stale check card", () => {
    // control-api's error class exposes the envelope requestId; the failure
    // alert appends it as a muted line (code/requestId only — never raw
    // server message text beyond the existing safe-message filter).
    expect(controlApiSource).toContain("get requestId()");
    expect(newAppViewSource).toContain(
      "setErrorRequestId(apiError?.requestId ?? null)",
    );
    expect(newAppViewSource).toContain(
      't("new.error.requestId", { id: id() })',
    );
    expect(ja["new.error.requestId"]).toContain("{id}");
    expect(en["new.error.requestId"]).toContain("{id}");
    // A failed submit must not keep asserting このまま追加できます above the
    // failure alert: the check-result display is demoted until re-checked.
    expect(newAppViewSource).toContain("setStaleCheckResult(true)");
    expect(newAppViewSource).toContain(
      "<Show when={!staleCheckResult() && compatibility()}>",
    );
  });

  test("failed source-token verification cleans up the just-created connection", () => {
    expect(newAppViewSource).toContain(
      "await revokeConnection(connection.id).catch(() => {})",
    );
  });

  test("duplicate-service staleness check inside the catch cannot throw unhandled", () => {
    expect(newAppViewSource).toContain("if (!isCurrentFlow(flow)) return;");
  });

  test("the main public-name field previews the resulting URL", () => {
    expect(newAppViewSource).toContain("const storeFieldHostPreview = (");
    expect(newAppViewSource).toContain("storeFieldHostPreview(");
    // The advanced サービスID preview stays (same computation, both places).
    expect(newAppViewSource).toContain("<Show when={managedHostPreview()}>");
    // Advanced name fields carry one-line explanations.
    expect(newAppViewSource).toContain(
      "advancedStoreFieldHint(entry(), field)",
    );
    expect(newAppViewSource).toContain('t("new.advanced.serviceIdHint")');
    expect(ja["new.advanced.serviceIdHint"]).toContain("内部名");
    expect(en["new.advanced.customUrlHint"].toLowerCase()).toContain("url");
  });

  test("the chosen listing is not rendered twice on wide screens", () => {
    // Wide screens keep the right-rail 追加内容 summary and hide the top
    // banner duplicate; the ≤720px layout hides the rail card instead.
    expect(appViewsCssSource).toMatch(
      /@media \(min-width: 721px\) \{\s*\.av-add-flow-header \{\s*display: none;/u,
    );
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
