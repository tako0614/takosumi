import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useLocation } from "@solidjs/router";
import {
  ArrowLeft,
  CheckCircle2,
  PackagePlus,
  PlugZap,
} from "lucide-solid";
import {
  isCanonicalRepositoryDirectoryPath,
  type JsonValue,
} from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import AppFace from "../../components/AppFace.tsx";
import { StoreBrowser } from "../store/StoreBrowser.tsx";
import {
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  Spinner,
} from "../../components/ui/index.ts";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  ControlApiIndeterminateError,
  SourceCreateIndeterminateError,
  createCapsule,
  createWorkspace,
  extractRunId,
  getInstallConfig,
  listConnectionsWithSignal,
  listReleaseOwnedProviderConnectionsWithSignal,
  listSourceSnapshotInstallModules,
  planCapsule,
  prepareCapsuleSourceSnapshot,
  putCapsuleProviderBindingSet,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  type PolicyConfig,
  type ProviderBindings,
  type ProviderConnection,
  type SourceCreateReconciliationToken,
} from "../../lib/control-api.ts";
import {
  installConfigRequiresUiSurface,
  listAuthorizedUiSurfaces,
} from "../../lib/ui-surface-interfaces.ts";
import {
  capsuleNameFromUrl,
  hasInstallPrefillParams,
  isSafeHttpsGitUrl,
  parseInstallPrefill,
} from "../../lib/install-link.ts";
import {
  appendAppHandoff,
  appHandoffFromSearch,
  appHandoffProductLabel,
  createAppHandoffConnectHref,
} from "../../lib/app-handoff.ts";
import {
  installReturnPathFromPrefill,
  providerConnectionsHrefForInstallReturn,
} from "../../lib/install-return-context.ts";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import {
  isProviderConnectionCandidate,
  providerConnectionAllowedByInstallPolicy,
  providerConnectionMatchesProviderSource,
  mergeProviderConnectionPolicies,
  preferredProviderConnection,
  providerConnectionDisplayName,
} from "../../lib/provider-connections.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { locale, t } from "../../i18n/index.ts";
import { fetchTcsListing, type TcsListing } from "../../lib/tcs-client.ts";
import {
  CAPSULE_NAME_PATTERN,
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultWorkspaceHandle,
  localizedStoreText,
  providerDisplayName,
  parseInitialTcsHandoff,
  setStoreJsonVariable,
  slugInputValue,
  storeDefaultInputValue,
  installModuleCatalogFromSnapshot,
  storeEntryFromStoreListing,
  storeInputIsDerived,
  storeInputJsonValue,
  storeInputKey,
  storeInputLabel,
  storeInputHelper,
  storeInitialSecretField,
  storeInstallFeatures,
  storeFeatureInputs,
  storeFeatureLabel,
  storeFeatureInputNames,
  storeVariablePath,
  sourceBuildPreview,
  type ProviderConnectionRow,
  type StoreEntry,
  type InstallModuleCatalog,
  type StoreInputField,
  type StoreInstallFeature,
} from "./install-helpers.ts";
import InstallExecution from "./InstallExecution.tsx";
import "./install-view.css";

type Phase =
  | "browse"
  | "configure"
  | "module-select"
  | "preparing"
  | "connections"
  | "setup"
  | "review"
  | "finishing"
  | "done";

const UI_SURFACE_READBACK_ATTEMPTS = 10;
const UI_SURFACE_READBACK_DELAY_MS = 3_000;
const INSTALL_PREPARATION_TIMEOUT_MS = 60_000;

type PreparationStage =
  | "workspace"
  | "connections"
  | "source"
  | "compatibility"
  | "config"
  | "plan";

type WorkspacePolicyState =
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly policy?: PolicyConfig };

function sameProviderSource(required: string, connected: string): boolean {
  return providerConnectionMatchesProviderSource(required, {
    providerSource: connected,
  });
}

function rowsFromCompatibility(
  result: CapsuleCompatibilityResult,
): ProviderConnectionRow[] {
  return result.rootProviderRequirements
    .filter((provider) => provider.credentialRequired === true)
    .map((provider) => {
      const childAlias = provider.childAlias ?? "";
      return {
        provider: provider.source,
        moduleLocalName: provider.moduleLocalName,
        childAlias,
        rootAlias: childAlias,
        connectionId: "",
        credentialRequired: true,
      };
    });
}

export default function InstallView() {
  return (
    <Page title={t("installStore.title")}>
      {(session) => <Inner installingPrincipalId={session.subject} />}
    </Page>
  );
}

function Inner(props: { readonly installingPrincipalId: string }) {
  const location = useLocation();
  const initial = parseInstallPrefill(location.search);
  // A query path is only a user hint. It is accepted as install authority only
  // after the exact SourceSnapshot module projection proves that path exists.
  const initialModulePathExplicit = Boolean(initial?.path);
  const appHandoff = appHandoffFromSearch(location.search);
  const [phase, setPhase] = createSignal<Phase>(
    hasInstallPrefillParams(location.search) ? "configure" : "browse",
  );
  const [listing, setListing] = createSignal<TcsListing | null>(null);
  const [installModuleCatalog, setInstallModuleCatalog] =
    createSignal<InstallModuleCatalog>({ status: "none", modules: [] });
  const [installModulesLoading, setInstallModulesLoading] =
    createSignal(false);
  const [moduleSelectionConfirmed, setModuleSelectionConfirmed] =
    createSignal(initialModulePathExplicit);
  const [gitUrl, setGitUrl] = createSignal(initial?.git ?? "");
  // Keep the authoritative ref exactly as supplied. Full commit refs are
  // immutable evidence; shortening them for an input display changes the
  // Source/compatibility request and can select a different commit.
  const [gitRef, setGitRef] = createSignal(initial?.ref ?? "");
  const [sourcePath, setSourcePath] = createSignal(initial?.sourcePath ?? ".");
  const [modulePath, setModulePath] = createSignal(initial?.path || ".");
  const [modulePathExplicit, setModulePathExplicit] = createSignal(
    initialModulePathExplicit,
  );
  const [name, setName] = createSignal(
    initial?.name ?? (initial?.git ? capsuleNameFromUrl(initial.git) : ""),
  );
  const [workspaceId, setWorkspaceId] = createSignal(currentWorkspaceId());
  const [workspaceHandle, setWorkspaceHandle] = createSignal<string>();
  const [workspacePolicyState, setWorkspacePolicyState] =
    createSignal<WorkspacePolicyState>({ status: "unavailable" });
  const [sourceId, setSourceId] = createSignal<string>();
  const [sourceSnapshotId, setSourceSnapshotId] = createSignal<string>();
  const [sourceCreateReconciliationToken, setSourceCreateReconciliationToken] =
    createSignal<SourceCreateReconciliationToken>();
  const [sourceAuthConnectionId, setSourceAuthConnectionId] = createSignal("");
  const [sourceConnections, setSourceConnections] = createSignal<
    readonly ProviderConnection[]
  >([]);
  const [providerConnections, setProviderConnections] = createSignal<
    readonly ProviderConnection[]
  >([]);
  const [providerRows, setProviderRows] = createSignal<ProviderConnectionRow[]>(
    [],
  );
  const [autoSelectedProviderRows, setAutoSelectedProviderRows] =
    createSignal<ReadonlySet<string>>(new Set());
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult>();
  const [installConfig, setInstallConfig] = createSignal<InstallConfig>();
  const sourceBuild = createMemo(() =>
    sourceBuildPreview(installConfig()?.sourceBuild),
  );
  const [storeEntry, setStoreEntry] = createSignal<StoreEntry>();
  const [storeValues, setStoreValues] = createSignal<Record<string, string>>(
    {},
  );
  const [storeInputTouched, setStoreInputTouched] = createSignal<
    Record<string, boolean>
  >({});
  const [storeFeatureSelections, setStoreFeatureSelections] = createSignal<
    Record<string, boolean>
  >({});
  const [capsuleId, setCapsuleId] = createSignal<string>();
  const [planRunId, setPlanRunId] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [preparationStage, setPreparationStage] =
    createSignal<PreparationStage>("workspace");
  const [preparationController, setPreparationController] =
    createSignal<AbortController>();
  const [interfaceUrl, setInterfaceUrl] = createSignal<string>();
  let completionAttempt = 0;
  let activePreparationController: AbortController | undefined;
  onCleanup(() => activePreparationController?.abort());

  const preparationStageHint = (): string => {
    switch (preparationStage()) {
      case "workspace":
        return t("installStore.preparingWorkspace");
      case "connections":
        return t("installStore.preparingConnections");
      case "source":
        return t("installStore.preparingSource");
      case "compatibility":
        return t("installStore.preparingCompatibility");
      case "config":
        return t("installStore.preparingConfig");
      case "plan":
        return t("installStore.preparingPlan");
    }
  };

  const selectedTitle = createMemo(() => {
    const selected = listing();
    return selected
      ? localizedStoreText(selected.name, selected.suggestedName)[locale()]
      : name() || capsuleNameFromUrl(gitUrl());
  });

  const selectedModule = createMemo(() => {
    const catalog = installModuleCatalog();
    if (catalog.status !== "ready") return undefined;
    const path = modulePath().trim();
    return catalog.modules.find((module) => module.path === path);
  });

  const selectedModuleProviderRequirements = createMemo(
    () => selectedModule()?.rootProviderRequirements ?? [],
  );

  type InstallStep = "source" | "configure" | "review";
  const activeInstallStep = (): InstallStep => {
    switch (phase()) {
      case "connections":
      case "setup":
        return "configure";
      case "review":
      case "finishing":
      case "done":
        return "review";
      case "preparing":
        return preparationStage() === "plan" ? "review" : "source";
      default:
        return "source";
    }
  };

  const installStepProgress = () => {
    const active = activeInstallStep();
    const order: readonly InstallStep[] = ["source", "configure", "review"];
    const activeIndex = order.indexOf(active);
    return order.map((id, index) => ({
      id,
      state:
        index < activeIndex ? "complete" : index === activeIndex ? "active" : "upcoming",
    } as const));
  };

  const installStepLabel = (step: InstallStep): string => {
    switch (step) {
      case "source":
        return t("installStore.stepSource");
      case "configure":
        return t("installStore.stepConfigure");
      case "review":
        return t("installStore.stepReview");
    }
  };

  const selectedModuleDetails = () => {
    const module = selectedModule();
    if (!module) return undefined;
    return (
      <details
        class="iv-module-details"
        data-testid="install-module-requirements"
      >
        <summary>
          {t("installStore.moduleRequirements")} · <code>{module.path}</code>
        </summary>
        <Show
          when={module.rootProviderRequirements.length > 0}
          fallback={<p>{t("common.none")}</p>}
        >
          <ul>
            <For each={module.rootProviderRequirements}>
              {(requirement) => (
                <li>
                  {t("installStore.moduleRequirement", {
                    source: requirement.source,
                    module: requirement.moduleLocalName,
                    alias: requirement.childAlias
                      ? ` (${requirement.childAlias})`
                      : "",
                    version: requirement.version
                      ? `v${requirement.version}`
                      : "",
                  })}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </details>
    );
  };

  const sourceCandidates = () =>
    sourceConnections().filter(
      (connection) =>
        connection.scope === "workspace" &&
        connection.status === "verified" &&
        (connection.kind === "source_git_https_token" ||
          connection.kind === "source_git_ssh_key"),
    );

  const effectiveProviderPolicy = (
    installPolicy: PolicyConfig | undefined = installConfig()?.policy,
  ): PolicyConfig | undefined => {
    const state = workspacePolicyState();
    return state.status === "ready"
      ? mergeProviderConnectionPolicies(state.policy, installPolicy)
      : undefined;
  };

  const candidatesFor = (
    provider: string,
    installPolicy: PolicyConfig | undefined = installConfig()?.policy,
  ) => {
    if (workspacePolicyState().status !== "ready") return [];
    const policy = effectiveProviderPolicy(installPolicy);
    return providerConnections().filter((connection) => {
      if (
        !isProviderConnectionCandidate(connection) ||
        !sameProviderSource(provider, connection.providerSource)
      ) {
        return false;
      }
      return providerConnectionAllowedByInstallPolicy(connection, policy);
    });
  };

  const providerRowsReady = () => {
    if (workspacePolicyState().status !== "ready") return false;
    return providerRows().every((row) =>
      candidatesFor(row.provider).some(
        (connection) => connection.id === row.connectionId,
      ),
    );
  };

  const providerModuleLabel = (row: ProviderConnectionRow): string =>
    providerDisplayName(row.provider) + " / " + row.moduleLocalName;

  const providerRowKey = (row: ProviderConnectionRow): string =>
    `${row.provider}|${row.moduleLocalName}|${row.childAlias}`;

  /**
   * A destination summary is evidence of the exact preferred selection made
   * during preparation. It must not infer a product label from an arbitrary
   * connection name or provider row, and it disappears when the user changes
   * that row manually.
   */
  const autoSelectedDestination = (): ProviderConnection | undefined => {
    const rows = providerRows();
    const selectedRows = autoSelectedProviderRows();
    if (rows.length === 0 || selectedRows.size !== rows.length) return undefined;
    const destinations = new Map<string, ProviderConnection>();
    for (const row of rows) {
      if (!selectedRows.has(providerRowKey(row))) return undefined;
      const connection = candidatesFor(row.provider).find(
        (candidate) => candidate.id === row.connectionId,
      );
      if (connection) destinations.set(connection.id, connection);
    }
    const values = [...destinations.values()];
    return values.length === 1 ? values[0] : undefined;
  };

  const autoSelectedDestinationSummary = () => (
    <Show when={autoSelectedDestination()}>
      {(destination) => (
        <div
          class="iv-destination-summary"
          data-testid="install-provider-destination"
          data-install-provider-destination="auto-selected"
          data-provider-connection-id={destination().id}
          title={t("installStore.destinationSummary", {
            destination: providerConnectionDisplayName(destination()),
          })}
        >
          <span>{t("installStore.destination")}</span>{" "}
          <Select
            aria-label={t("installStore.destination")}
            value={destination().id}
            disabled={true}
            data-provider-connection-id={destination().id}
          >
            <option value={destination().id}>
              {providerConnectionDisplayName(destination())}
            </option>
          </Select>
        </div>
      )}
    </Show>
  );

  const providerConnectionSetupRequired = () =>
    providerRows().some((row) => candidatesFor(row.provider).length === 0);

  const storeFeatureKey = (entry: StoreEntry, feature: StoreInstallFeature) =>
    `${entry.id}:${feature.id}`;

  const storeFeatureEnabled = (
    entry: StoreEntry,
    feature: StoreInstallFeature,
  ): boolean =>
    storeFeatureSelections()[storeFeatureKey(entry, feature)] ??
    !feature.optional;

  // The public install API still has no sealed secret-material submission
  // contract. Keep secret-backed choices out of the form instead of collecting
  // a value that the host cannot safely deliver to the workload.
  const storeFeatureRequiresSecretMaterialization = (
    entry: StoreEntry,
    feature: StoreInstallFeature,
  ): boolean =>
    storeFeatureInputs(entry, feature).some((field) => field.secret);

  const visibleStoreInstallFeatures = (
    entry: StoreEntry,
  ): readonly StoreInstallFeature[] =>
    storeInstallFeatures(entry).filter(
      (feature) => !storeFeatureRequiresSecretMaterialization(entry, feature),
    );

  const storeRequiresUnavailableSecretMaterialization = (
    entry: StoreEntry,
  ): boolean =>
    Boolean(storeInitialSecretField(entry)) ||
    storeInstallFeatures(entry).some(
      (feature) =>
        !feature.optional &&
        storeFeatureRequiresSecretMaterialization(entry, feature),
    );

  const storeFeatureForInput = (
    entry: StoreEntry,
    field: StoreInputField,
  ): StoreInstallFeature | undefined =>
    storeInstallFeatures(entry).find(
      (feature) =>
        storeFeatureInputNames(entry).has(field.name) &&
        feature.inputs.some((name) => name === field.name),
    );

  const storeInputIsActive = (
    entry: StoreEntry,
    field: StoreInputField,
  ): boolean => {
    if (field.secret) return false;
    const feature = storeFeatureForInput(entry, field);
    if (feature && !storeFeatureEnabled(entry, feature)) return false;
    return true;
  };

  const visibleSetupFields = () => {
    const entry = storeEntry();
    if (!entry) return [];
    return entry.inputs.filter(
      (field) =>
        !storeInputIsDerived(field) && storeInputIsActive(entry, field),
    );
  };

  const setupValue = (field: StoreInputField) => {
    const entry = storeEntry();
    if (!entry) return "";
    return (
      storeValues()[storeInputKey(entry.id, field.name)] ??
      storeDefaultInputValue(
        entry,
        field,
        workspaceHandle(),
        name(),
      )
    );
  };

  const setupError = (): string | undefined => {
    const entry = storeEntry();
    if (!entry) return undefined;
    if (entry.setupProjectionInvalid) return t("installStore.setupInvalid");
    if (storeRequiresUnavailableSecretMaterialization(entry)) {
      return t("installStore.secretUnavailable");
    }
    for (const field of visibleSetupFields()) {
      if (!storeVariablePath(field.name)) return t("installStore.setupInvalid");
      if (field.secret) {
        // Secret values are kept only as a transient input for the supported
        // password fallback; this flow never serializes them into vars.
        continue;
      }
      if (!field.secret && field.required && !setupValue(field).trim()) {
        return t("installStore.setupRequired", {
          label: storeInputLabel(field, locale()),
        });
      }
    }
    return undefined;
  };

  const variables = () => {
    const entry = storeEntry();
    if (!entry) return undefined;
    const result: Record<string, JsonValue> = {};
    for (const field of entry.inputs) {
      if (!storeInputIsActive(entry, field)) continue;
      if (field.secret) continue;
      // Derived identity and endpoint values remain service-owned unless the
      // user explicitly edited that presentation field.
      if (
        storeInputIsDerived(field) &&
        !storeInputTouched()[storeInputKey(entry.id, field.name)]
      ) {
        continue;
      }
      const value = storeInputJsonValue(field, setupValue(field));
      if (value !== undefined) setStoreJsonVariable(result, field.name, value);
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const ensureWorkspace = async (): Promise<string> => {
    setWorkspacePolicyState({ status: "unavailable" });
    const workspaces = await listWorkspacesCached();
    const existing = selectAvailableWorkspaceId(
      currentWorkspaceId(),
      workspaces,
    );
    if (existing) {
      const workspace = workspaces.find((item) => item.id === existing);
      setWorkspaceId(existing);
      observedWorkspaceId = existing;
      setCurrentWorkspaceId(existing);
      setWorkspaceHandle(workspace?.handle);
      setWorkspacePolicyState({
        status: "ready",
        ...(workspace?.policy ? { policy: workspace.policy } : {}),
      });
      return existing;
    }
    const workspace = await createWorkspace({
      handle: defaultWorkspaceHandle(),
      displayName: t("workspace.defaultName"),
      type: "personal",
    });
    setWorkspaceId(workspace.id);
    observedWorkspaceId = workspace.id;
    setCurrentWorkspaceId(workspace.id);
    setWorkspaceHandle(workspace.handle);
    setWorkspacePolicyState({
      status: "ready",
      ...(workspace.policy ? { policy: workspace.policy } : {}),
    });
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    return workspace.id;
  };

  const loadConnections = async (
    workspace: string,
    signal: AbortSignal,
    includeSourceConnections: boolean,
  ) => {
    const [all, releaseOwnedProviders] = await Promise.all([
      includeSourceConnections
        ? listConnectionsWithSignal(workspace, signal)
        : Promise.resolve([] as ProviderConnection[]),
      listReleaseOwnedProviderConnectionsWithSignal(workspace, signal),
    ]);
    const providers = [
      ...new Map(
        [
          ...all.filter(isProviderConnectionCandidate),
          ...releaseOwnedProviders,
        ].map((connection) => [connection.id, connection] as const),
      ).values(),
    ];
    if (currentWorkspaceId() === workspace || workspaceId() === workspace) {
      setSourceConnections(all);
      setProviderConnections(providers);
    }
    return providers;
  };

  const workspaceIsCurrent = (workspace: string): boolean =>
    workspace === currentWorkspaceId() && workspace === workspaceId();

  const validateBasic = (): string | undefined => {
    if (!gitUrl().trim()) return t("installStore.invalidSource");
    if (!isSafeHttpsGitUrl(gitUrl().trim())) {
      return t("installStore.invalidSource");
    }
    if (!CAPSULE_NAME_PATTERN.test(name().trim())) {
      return t("installStore.invalidName");
    }
    if (!isCanonicalRepositoryDirectoryPath(sourcePath())) {
      return t("installStore.invalidSource");
    }
    if (modulePathExplicit() && !modulePath().trim()) {
      return t("installStore.moduleUnavailable");
    }
    return undefined;
  };

  const resetCompiledPreparation = () => {
    setCompatibility(undefined);
    setInstallConfig(undefined);
    setStoreEntry(undefined);
    setStoreValues({});
    setStoreInputTouched({});
    setStoreFeatureSelections({});
    setProviderRows([]);
    setAutoSelectedProviderRows(new Set<string>());
    setCapsuleId(undefined);
    setPlanRunId(undefined);
    setInterfaceUrl(undefined);
  };

  const resetPreparedSource = (options?: {
    readonly preserveModuleSelection?: boolean;
  }) => {
    const preservedModulePath = options?.preserveModuleSelection
      ? modulePath()
      : ".";
    const preservedModulePathExplicit = options?.preserveModuleSelection
      ? modulePathExplicit()
      : false;
    setSourceId(undefined);
    setSourceSnapshotId(undefined);
    setSourceCreateReconciliationToken(undefined);
    setInstallModulesLoading(false);
    setInstallModuleCatalog({ status: "none", modules: [] });
    setModulePath(preservedModulePath);
    setModulePathExplicit(preservedModulePathExplicit);
    setModuleSelectionConfirmed(false);
    resetCompiledPreparation();
  };

  // Header workspace changes are reactive. Never let a previously prepared
  // Source/Capsule/Plan continue writing under the old workspace.
  let observedWorkspaceId = workspaceId();
  createEffect(() => {
    const selected = currentWorkspaceId();
    if (selected === observedWorkspaceId) return;
    observedWorkspaceId = selected;
    setWorkspaceId(selected);
    setWorkspaceHandle(undefined);
    setWorkspacePolicyState({ status: "unavailable" });
    setSourceConnections([]);
    setProviderConnections([]);
    // Hydrating the persisted Workspace must not erase a path explicitly
    // supplied by a direct Git handoff. The Source and module catalog are
    // discarded, but the user's module hint stays
    // attached to this install attempt and is revalidated against the new
    // immutable snapshot below.
    resetPreparedSource({ preserveModuleSelection: true });
    setError(undefined);
    setPhase(listing() || gitUrl() ? "configure" : "browse");
  });

  const chooseListing = (selected: TcsListing) => {
    resetPreparedSource();
    setListing(selected);
    setGitUrl(selected.source.url);
    setGitRef("");
    setSourcePath(".");
    setModulePath(".");
    setModulePathExplicit(false);
    setName(slugInputValue(selected.suggestedName));
    setSourceAuthConnectionId("");
    setError(undefined);
    setPhase("configure");
  };

  const chooseInstallModule = (path: string) => {
    const catalog = installModuleCatalog();
    if (catalog.status !== "ready") return;
    if (!catalog.modules.some((module) => module.path === path)) return;
    // Changing the module invalidates every derived compatibility/configuration
    // artifact. Keep the immutable SourceSnapshot and catalog so the user can
    // confirm another declared directory without refetching bytes.
    resetCompiledPreparation();
    setModulePath(path);
    setModulePathExplicit(true);
    setModuleSelectionConfirmed(false);
    setError(undefined);
  };

  const updateProviderRow = (
    target: ProviderConnectionRow,
    connectionId: string,
  ) => {
    setProviderRows((rows) =>
      rows.map((row) =>
        row.provider === target.provider &&
        row.moduleLocalName === target.moduleLocalName &&
        row.childAlias === target.childAlias
          ? { ...row, connectionId }
          : row,
      ),
    );
    // A manual choice means the final destination set is no longer wholly
    // the exact preferred set discovered during preparation. Do not leave a
    // summary for a different row that could imply the whole install runs on
    // the displayed connection.
    setAutoSelectedProviderRows(new Set<string>());
  };

  const prepareInstall = async () => {
    const validation = validateBasic();
    if (validation) {
      setError(validation);
      return;
    }
    // “Add” responds immediately. Repository and provider analysis belongs to
    // the requested operation, never to the button's enabled state.
    activePreparationController?.abort();
    const controller = new AbortController();
    // This absolute deadline belongs to the whole preparation operation. The
    // compatibility client receives the same value so Source create can stop
    // its mutation window early and retain the final five seconds for
    // authoritative readback.
    const preparationDeadlineAt =
      Date.now() + INSTALL_PREPARATION_TIMEOUT_MS;
    let preparationTimedOut = false;
    const preparationTimeout = setTimeout(() => {
      preparationTimedOut = true;
      controller.abort();
    }, INSTALL_PREPARATION_TIMEOUT_MS);
    activePreparationController = controller;
    setPreparationController(() => controller);
    setPreparationStage("workspace");
    setPhase("preparing");
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await ensureWorkspace();
      if (controller.signal.aborted || !workspaceIsCurrent(workspace)) {
        setError(
          preparationTimedOut ? t("installStore.preparingTimeout") : undefined,
        );
        setPhase("configure");
        return;
      }
      // Provider discovery is independent from Source synchronization and
      // compatibility analysis. Start it now, but do not make public Git
      // installs stare at a serial “checking connections” phase before the
      // repository work can begin. The resolved provider set is consumed only
      // after compatibility tells us which provider rows are required.
      const providersResult = loadConnections(
        workspace,
        controller.signal,
        sourceAuthConnectionId().length > 0,
      ).then(
        (providers) => ({ ok: true as const, providers }),
        (cause: unknown) => ({ ok: false as const, cause }),
      );
      setPreparationStage("source");
      let preparedSourceId = sourceId();
      let preparedSourceSnapshotId = sourceSnapshotId();
      if (!preparedSourceId || !preparedSourceSnapshotId) {
        const prepared = await prepareCapsuleSourceSnapshot({
          workspaceId: workspace,
          sourceId: preparedSourceId,
          gitUrl: gitUrl().trim(),
          ref: gitRef().trim(),
          sourcePath: sourcePath(),
          resolveAbsentRefToStableSemver: listing() !== null,
          name: name().trim(),
          ...(sourceAuthConnectionId()
            ? { authConnectionId: sourceAuthConnectionId() }
            : {}),
          signal: controller.signal,
          deadlineAt: preparationDeadlineAt,
          ...(sourceCreateReconciliationToken()
            ? {
                sourceCreateReconciliationToken:
                  sourceCreateReconciliationToken(),
              }
            : {}),
          onSourceSyncProgress: () => setPreparationStage("source"),
          onSourceCreated: (createdSourceId) => {
            if (workspaceIsCurrent(workspace)) {
              setSourceId(createdSourceId);
              setSourceCreateReconciliationToken(undefined);
            }
          },
        });
        if (controller.signal.aborted || !workspaceIsCurrent(workspace)) {
          setPhase("configure");
          return;
        }
        preparedSourceId = prepared.sourceId;
        preparedSourceSnapshotId = prepared.sourceSnapshotId;
        if (listing() && !gitRef().trim()) {
          // TCS listings omit the operator ref. The source boundary resolves
          // that omission to a stable SemVer commit before Source creation;
          // retain the immutable evidence for all later compatibility/plan
          // requests in this install attempt.
          setGitRef(prepared.snapshot.resolvedCommit);
        }
        setSourceId(prepared.sourceId);
        setSourceSnapshotId(prepared.sourceSnapshotId);
      }

      // Module selection is sourced exclusively from the immutable repository
      // scan. Fetch it before compatibility so no Source default or Store
      // metadata can choose a module directory or policy branch.
      if (
        preparedSourceId &&
        preparedSourceSnapshotId &&
        installModuleCatalog().status === "none"
      ) {
        setInstallModulesLoading(true);
        try {
          const response = await listSourceSnapshotInstallModules(
            preparedSourceId,
            preparedSourceSnapshotId,
            { signal: controller.signal },
          );
          if (
            controller.signal.aborted ||
            !workspaceIsCurrent(workspace)
          ) {
            setPhase("configure");
            return;
          }
          const catalog = installModuleCatalogFromSnapshot(response);
          setInstallModuleCatalog(catalog);
          if (catalog.status === "invalid") {
            setError(t("installStore.moduleUnavailable"));
            setPhase("configure");
            return;
          }
          if (catalog.status !== "ready") {
            setError(t("installStore.moduleUnavailable"));
            setPhase("configure");
            return;
          }
          if (catalog.modules.length === 0) {
            // An empty ready scan is a valid observation, but there is no
            // executable OpenTofu root to install from this revision.
            setError(t("installStore.moduleMissing"));
            setPhase("configure");
            return;
          } else if (modulePathExplicit()) {
            const requestedPath = modulePath().trim();
            const selected = catalog.modules.find(
              (module) => module.path === requestedPath,
            );
            if (!selected) {
              setError(t("installStore.moduleUnavailable"));
              setPhase("configure");
              return;
            }
            // Preserve an explicit direct Git path exactly after canonical
            // validation against the immutable scan.
            setModulePath(selected.path);
            setModuleSelectionConfirmed(true);
          } else if (catalog.modules.length === 1) {
            setModulePath(catalog.modules[0]!.path);
            // A single scanned module is the only noninteractive choice. Keep
            // its path as explicit authority for Store and direct Git alike.
            setModulePathExplicit(true);
            setModuleSelectionConfirmed(true);
          } else {
            // There is no server-side default for a multi-root repository.
            // Leave the select empty until the user chooses one exact path.
            setModulePath("");
            setModulePathExplicit(false);
            setModuleSelectionConfirmed(false);
            // A multi-module scan requires an explicit user confirmation before
            // compatibility can derive setup or provider rows.
            setPhase("module-select");
            return;
          }
        } catch (cause) {
          if (controller.signal.aborted) throw cause;
          setInstallModuleCatalog({ status: "invalid", modules: [] });
          setError(t("installStore.moduleUnavailable"));
          setPhase("configure");
          return;
        } finally {
          setInstallModulesLoading(false);
        }
      }
      if (
        installModuleCatalog().status === "ready" &&
        installModuleCatalog().modules.length > 1 &&
        !moduleSelectionConfirmed()
      ) {
        setPhase("module-select");
        return;
      }
      const selectedModuleCatalog = installModuleCatalog();
      if (selectedModuleCatalog.status === "invalid") {
        setError(t("installStore.moduleUnavailable"));
        setPhase("configure");
        return;
      }
      if (
        selectedModuleCatalog.status !== "ready" ||
        selectedModuleCatalog.modules.length === 0
      ) {
        setError(t("installStore.moduleMissing"));
        setPhase("configure");
        return;
      }
      if (
        selectedModuleCatalog.modules.length > 1 &&
        !moduleSelectionConfirmed()
      ) {
        setPhase("module-select");
        return;
      }
      if (!moduleSelectionConfirmed() || !modulePath().trim()) {
        setError(t("installStore.moduleUnavailable"));
        setPhase("configure");
        return;
      }

      setPreparationStage("compatibility");
      const selectedModulePath = modulePath().trim();
      if (!selectedModulePath || !moduleSelectionConfirmed()) {
        setError(t("installStore.moduleUnavailable"));
        setPhase("configure");
        return;
      }
      const result = await checkCapsuleCompatibility({
        workspaceId: workspace,
        sourceId: preparedSourceId,
        sourceSnapshotId: preparedSourceSnapshotId,
        gitUrl: gitUrl().trim(),
        ref: gitRef().trim(),
        sourcePath: sourcePath(),
        // The exact scanned directory is the authority for both Store and
        // direct Git installs. Source.defaultPath remains only the archive
        // capture root and is never used as a module selection fallback.
        path: selectedModulePath,
        name: name().trim(),
        ...(sourceAuthConnectionId()
          ? { authConnectionId: sourceAuthConnectionId() }
          : {}),
        // Store metadata is presentation only. Every immutable repository
        // snapshot gets the same repo-owned install compilation, including
        // direct Git installs.
        compileInstallUx: true,
        signal: controller.signal,
        timeoutMs: INSTALL_PREPARATION_TIMEOUT_MS,
        deadlineAt: preparationDeadlineAt,
        ...(sourceCreateReconciliationToken()
          ? {
              sourceCreateReconciliationToken:
                sourceCreateReconciliationToken(),
            }
          : {}),
      });
      if (controller.signal.aborted || !workspaceIsCurrent(workspace)) {
        setPhase("configure");
        return;
      }
      setCompatibility(result);
      // Compatibility is a hard gate. A report that needs a patch is not
      // executable merely because the endpoint returned 200; stop before any
      // InstallConfig/Capsule creation and show its diagnostics to the user.
      if (result.level !== "ready") {
        setError(result.summary || t("installStore.compatibilityFailed"));
        setPhase("configure");
        return;
      }
      setPreparationStage("connections");
      const providerResult = await providersResult;
      if (!providerResult.ok) throw providerResult.cause;
      const providers = providerResult.providers;
      if (controller.signal.aborted || !workspaceIsCurrent(workspace)) {
        setError(
          preparationTimedOut ? t("installStore.preparingTimeout") : undefined,
        );
        setPhase("configure");
        return;
      }
      const configId =
        result.repositoryInstallUx?.status === "accepted"
          ? result.repositoryInstallUx.installConfigId
          : (result.installConfigId ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID);
      setPreparationStage("config");
      const config = await getInstallConfig(configId, {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !workspaceIsCurrent(workspace)) {
        setPhase("configure");
        return;
      }
      setInstallConfig(config);
      const selectedListing = listing();
      const entry = selectedListing
        ? storeEntryFromStoreListing(selectedListing, config)
        : undefined;
      setStoreEntry(entry);
      setStoreFeatureSelections(
        entry
          ? Object.fromEntries(
              storeInstallFeatures(entry).map((feature) => [
                storeFeatureKey(entry, feature),
                !feature.optional,
              ]),
            )
          : {},
      );
      const selectedRows = new Set<string>();
      const rows = rowsFromCompatibility(result).map((row) => {
        const matches = candidatesFor(row.provider, config.policy);
        const preferred = preferredProviderConnection(
          matches,
          effectiveProviderPolicy(config.policy),
        );
        if (!preferred) return row;
        selectedRows.add(providerRowKey(row));
        return { ...row, connectionId: preferred.id };
      });
      setAutoSelectedProviderRows(selectedRows);
      setProviderRows(rows);
      if (
        rows.some(
          (row) =>
            !candidatesFor(row.provider, config.policy).some(
              (connection) => connection.id === row.connectionId,
            ),
        )
      ) {
        setPhase("connections");
      } else if (
        visibleSetupFields().length > 0 ||
        entry?.setupProjectionInvalid ||
        (entry && storeRequiresUnavailableSecretMaterialization(entry)) ||
        sourceBuild()
      ) {
        setPhase("setup");
      } else {
        activePreparationController = undefined;
        setPreparationController(undefined);
        await preparePlan(workspace, result, config, rows, undefined);
      }
    } catch (cause) {
      if (cause instanceof SourceCreateIndeterminateError) {
        setSourceCreateReconciliationToken(cause.reconciliationToken);
        setError(t("installStore.sourceRegistrationUnconfirmed"));
      } else if (
        cause instanceof ControlApiError &&
        cause.code === "source_create_baseline_unavailable"
      ) {
        setSourceCreateReconciliationToken(undefined);
        setError(t("installStore.sourceBaselineUnavailable"));
      } else if (
        cause instanceof ControlApiIndeterminateError &&
        cause.operation === "source_create"
      ) {
        // Keep compatibility with a future source-create implementation that
        // can report indeterminate without this client's reconciliation token.
        setSourceCreateReconciliationToken(undefined);
        setError(t("installStore.sourceRegistrationUnconfirmed"));
      } else if (controller.signal.aborted) {
        setError(
          preparationTimedOut ? t("installStore.preparingTimeout") : undefined,
        );
      } else if (
        cause instanceof ControlApiError &&
        cause.code === "request_timeout"
      ) {
        setError(t("installStore.preparingTimeout"));
      } else {
        setError(friendlyError(cause, t).message);
      }
      setPhase("configure");
    } finally {
      clearTimeout(preparationTimeout);
      if (activePreparationController === controller) {
        activePreparationController = undefined;
        setPreparationController(undefined);
      }
      setBusy(false);
    }
  };

  const confirmInstallModule = () => {
    const catalog = installModuleCatalog();
    if (
      catalog.status !== "ready" ||
      !catalog.modules.some((module) => module.path === modulePath())
    ) {
      setError(t("installStore.moduleUnavailable"));
      return;
    }
    // A confirmed chooser selection becomes an explicit module authority for
    // the compile request, including an explicit repository root (`.`).
    setModulePathExplicit(true);
    setModuleSelectionConfirmed(true);
    void prepareInstall();
  };

  const providerBindings = (
    rows: readonly ProviderConnectionRow[],
  ): ProviderBindings =>
    rows.map((row) => ({
      provider: row.provider,
      moduleLocalName: row.moduleLocalName,
      ...(row.childAlias ? { childAlias: row.childAlias } : {}),
      ...(row.rootAlias ? { rootAlias: row.rootAlias } : {}),
      connectionId: row.connectionId,
    }));

  const preparePlan = async (
    workspace = workspaceId(),
    checked = compatibility(),
    config = installConfig(),
    rows = providerRows(),
    vars = variables(),
  ) => {
    if (!workspace || !checked || !config) return;
    if (checked.level !== "ready") {
      setError(checked.summary || t("installStore.compatibilityFailed"));
      setPhase("configure");
      return;
    }
    if (!workspaceIsCurrent(workspace)) return;
    const validation = setupError();
    if (validation) {
      setError(validation);
      return;
    }
    if (workspacePolicyState().status !== "ready") {
      setPhase("connections");
      return;
    }
    if (
      rows.some(
        (row) =>
          !candidatesFor(row.provider, config.policy).some(
            (connection) => connection.id === row.connectionId,
          ),
      )
    ) {
      setPhase("connections");
      return;
    }
    setPreparationStage("plan");
    setPhase("preparing");
    setBusy(true);
    setError(undefined);
    try {
      if (!workspaceIsCurrent(workspace)) return;
      let currentCapsuleId = capsuleId();
      if (!currentCapsuleId) {
        const capsule = await createCapsule({
          workspaceId: workspace,
          name: name().trim(),
          environment: "production",
          sourceId: sourceId() ?? checked.sourceId!,
          installConfigId: config.id,
          // The scanned module path is the same for Store and direct Git. Do
          // not let Source.defaultPath silently switch the root during create.
          modulePath: modulePath().trim(),
          ...(vars ? { vars } : {}),
          ...(Object.keys(config.outputAllowlist).length > 0
            ? { outputAllowlist: config.outputAllowlist }
            : {}),
        });
        if (!workspaceIsCurrent(workspace)) return;
        currentCapsuleId = capsule.id;
        setCapsuleId(capsule.id);
        clearCapsuleListCache(workspace);
        clearCurrentStateVersionCache(workspace);
        clearDashboardOverviewCache(workspace);
      }
      await putCapsuleProviderBindingSet(
        currentCapsuleId,
        providerBindings(rows),
      );
      if (!workspaceIsCurrent(workspace)) return;
      const envelope = await planCapsule(currentCapsuleId, {
        ...(checked.reportId
          ? { compatibilityReportId: checked.reportId }
          : {}),
        timeoutMs: 30_000,
      });
      if (!workspaceIsCurrent(workspace)) return;
      const runId = extractRunId(envelope);
      if (!runId) throw new Error(t("installStore.planMissing"));
      setPlanRunId(runId);
      setPhase("review");
    } catch (cause) {
      setError(friendlyError(cause, t).message);
      setPhase(storeEntry() ? "setup" : "configure");
    } finally {
      setBusy(false);
    }
  };

  const continueAfterConnections = async () => {
    if (!providerRowsReady()) return;
    const entry = storeEntry();
    if (
      visibleSetupFields().length > 0 ||
      entry?.setupProjectionInvalid ||
      (entry && storeRequiresUnavailableSecretMaterialization(entry))
    ) {
      setPhase("setup");
    } else {
      await preparePlan();
    }
  };

  const loadTcsListing = async () => {
    const tcs = parseInitialTcsHandoff(location.search);
    if (!tcs) return;
    setBusy(true);
    try {
      const selected = await fetchTcsListing(tcs.base, tcs.listingId);
      if (!selected) throw new Error(t("installStore.listingUnavailable"));
      chooseListing(selected);
    } catch (cause) {
      setError(friendlyError(cause, t).message);
      setPhase("browse");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    completionAttempt += 1;
    setListing(null);
    setGitUrl("");
    setGitRef("");
    setSourcePath(".");
    setModulePath(".");
    setModulePathExplicit(false);
    setName("");
    setSourceId(undefined);
    setSourceSnapshotId(undefined);
    setSourceCreateReconciliationToken(undefined);
    setInstallModulesLoading(false);
    setInstallModuleCatalog({ status: "none", modules: [] });
    setModuleSelectionConfirmed(false);
    setCompatibility(undefined);
    setInstallConfig(undefined);
    setStoreEntry(undefined);
    setProviderRows([]);
    setCapsuleId(undefined);
    setPlanRunId(undefined);
    setStoreValues({});
    setStoreInputTouched({});
    setStoreFeatureSelections({});
    setSourceAuthConnectionId("");
    setAutoSelectedProviderRows(new Set<string>());
    setInterfaceUrl(undefined);
    setError(undefined);
    setPhase("browse");
  };

  onMount(() => {
    // TCS discovery is a read-only listing lookup. Source preparation creates
    // the Source and sync Run, so that work is reserved for the explicit Add
    // action below.
    if (parseInitialTcsHandoff(location.search)) void loadTcsListing();
  });

  const sourceReturnPath = () =>
    appendAppHandoff(
      installReturnPathFromPrefill({
        git: gitUrl(),
        ref: gitRef(),
        sourcePath: sourcePath(),
        ...(modulePathExplicit() ? { path: modulePath() } : {}),
        name: name(),
      }),
      appHandoff,
    );

  const updateStoreInput = (field: StoreInputField, value: string) => {
    const entry = storeEntry();
    if (!entry) return;
    const key = storeInputKey(entry.id, field.name);
    setStoreValues((current) => ({ ...current, [key]: value }));
    setStoreInputTouched((current) => ({ ...current, [key]: true }));
    // Editing any semantic setup value invalidates the reviewed Capsule/Plan.
    // It does not invalidate the compatibility report, which is fenced to the
    // immutable SourceSnapshot and module rather than Capsule variables.
    setCapsuleId(undefined);
    setPlanRunId(undefined);
  };

  const toggleStoreFeature = (
    entry: StoreEntry,
    feature: StoreInstallFeature,
    enabled: boolean,
  ) => {
    setStoreFeatureSelections((current) => ({
      ...current,
      [storeFeatureKey(entry, feature)]: enabled,
    }));
    setCapsuleId(undefined);
    setPlanRunId(undefined);
  };

  const finishInstallation = async () => {
    const attempt = ++completionAttempt;
    setPhase("finishing");
    setInterfaceUrl(undefined);
    setError(undefined);
    const workspace = currentWorkspaceId();
    const capsule = capsuleId();
    if (!workspace || !capsule || !workspaceIsCurrent(workspace)) {
      setError(t("installStore.launchNotReady"));
      return;
    }
    const config = installConfig();
    if (
      !installConfigRequiresUiSurface(config?.interfaceBlueprints, {
        installingPrincipalId: props.installingPrincipalId,
        repositoryInstallUxAccepted:
          config?.installExperience?.repositoryInstallUx?.status ===
          "accepted",
      })
    ) {
      setPhase("done");
      return;
    }
    for (let index = 0; index < UI_SURFACE_READBACK_ATTEMPTS; index += 1) {
      try {
        const surfaces = await listAuthorizedUiSurfaces(workspace, {
          capsuleId: capsule,
        });
        if (attempt !== completionAttempt || !workspaceIsCurrent(workspace)) {
          return;
        }
        const surface = surfaces[0];
        if (surface) {
          setInterfaceUrl(surface.url);
          setPhase("done");
          return;
        }
      } catch {
        // A transient read failure is retried within the same bounded
        // completion attempt. It is never converted into successful setup.
      }
      if (index + 1 < UI_SURFACE_READBACK_ATTEMPTS) {
        await new Promise((resolve) =>
          globalThis.setTimeout(resolve, UI_SURFACE_READBACK_DELAY_MS),
        );
      }
    }
    if (attempt === completionAttempt && workspaceIsCurrent(workspace)) {
      setError(t("installStore.launchNotReady"));
    }
  };

  const appConnectHref = () =>
    createAppHandoffConnectHref(appHandoff, interfaceUrl());

  const compatibilityBlocker = () => {
    const result = compatibility();
    return result && result.level !== "ready" ? result : undefined;
  };

  return (
    <main class="iv-page">
      <header class="iv-hero">
        <div>
          <span class="iv-kicker">TAKOSUMI STORE</span>
          <h1>{t("installStore.title")}</h1>
          <p>{t("installStore.subtitle")}</p>
        </div>
        <Show
          when={
            phase() !== "browse" &&
            phase() !== "done"
          }
        >
          <Badge tone="info">{selectedTitle()}</Badge>
        </Show>
      </header>

      <Show when={appHandoff}>
        {(handoff) => (
          <aside class="iv-handoff" role="status">
            <strong>
              {appHandoffProductLabel(handoff().product)}{" "}
              {t("installStore.title")}
            </strong>
            <p>{handoff().returnUri}</p>
          </aside>
        )}
      </Show>

      <Show when={error()}>
        {(message) => (
          <div class="iv-error" role="alert">
            {message()}
          </div>
        )}
      </Show>

      <nav
        class="iv-steps"
        aria-label={t("installStore.stepsLabel")}
        data-testid="install-steps"
      >
        <ol>
          <For each={installStepProgress()}>
            {(step) => (
              <li
                data-install-step={step.id}
                data-state={step.state}
                aria-current={step.state === "active" ? "step" : undefined}
              >
                <span>{installStepLabel(step.id)}</span>
              </li>
            )}
          </For>
        </ol>
      </nav>

      <Show when={phase() === "browse"}>
        <section class="iv-catalogue" aria-labelledby="iv-catalogue-title">
          <div class="iv-section-head">
            <h2 id="iv-catalogue-title">{t("installStore.browseTitle")}</h2>
            <p>{t("installStore.browseHint")}</p>
          </div>
          <StoreBrowser
            locale={locale()}
            onConfigure={chooseListing}
            showSourceControls={true}
            showSortControl={true}
          />
          <details class="iv-manual">
            <summary>{t("installStore.manual")}</summary>
            <form
              class="iv-manual-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (gitUrl().trim()) {
                  setName(slugInputValue(capsuleNameFromUrl(gitUrl())));
                  setPhase("configure");
                }
              }}
            >
              <Input
                value={gitUrl()}
                onInput={(event) => setGitUrl(event.currentTarget.value)}
                placeholder="https://github.com/example/service.git"
                spellcheck={false}
              />
              <Button type="submit" variant="secondary">
                {t("installStore.continue")}
              </Button>
            </form>
          </details>
        </section>
      </Show>

      <Show when={phase() === "module-select"}>
        <section
          class="iv-workbench"
          aria-labelledby="iv-module-title"
          data-testid="install-module-chooser"
        >
          <Button
            type="button"
            variant="ghost"
            icon={<ArrowLeft size={16} />}
            onClick={reset}
          >
            {t("installStore.back")}
          </Button>
          <div class="iv-section-head">
            <h2 id="iv-module-title">{t("installStore.moduleTitle")}</h2>
            <p>{t("installStore.moduleHint")}</p>
          </div>
          <form
            class="iv-form"
            onSubmit={(event) => {
              event.preventDefault();
              confirmInstallModule();
            }}
          >
            <FormField label={t("installStore.moduleChoose")} required>
              <Select
                value={modulePath()}
                onChange={(event) =>
                  chooseInstallModule(event.currentTarget.value)
                }
              >
                <option value="">{t("installStore.moduleChoose")}</option>
                <For each={
                  installModuleCatalog().status === "ready"
                    ? installModuleCatalog().modules
                    : []
                }>
                  {(module) => (
                    <option
                      value={module.path}
                      selected={module.path === modulePath()}
                    >
                      {module.path}
                    </option>
                  )}
                </For>
              </Select>
            </FormField>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              busy={busy()}
              icon={<PackagePlus size={18} />}
            >
              {t("installStore.moduleConfirm")}
            </Button>
          </form>
        </section>
      </Show>

      <Show when={phase() === "configure"}>
        <section class="iv-workbench">
          <Button
            type="button"
            variant="ghost"
            icon={<ArrowLeft size={16} />}
            onClick={reset}
          >
            {t("installStore.back")}
          </Button>
          <div class="iv-app-summary">
            <AppFace name={selectedTitle()} iconUrl={listing()?.iconUrl} />
            <div>
              <h2>{selectedTitle()}</h2>
              <p>{t("installStore.configureHint")}</p>
            </div>
          </div>
          {selectedModuleDetails()}
          <Show when={installModulesLoading()}>
            <aside class="iv-setup-note" role="status">
              {t("installStore.moduleHint")}
            </aside>
          </Show>
          <Show when={compatibilityBlocker()}>
            {(result) => (
              <aside class="iv-compat-warning" role="alert">
                <Badge
                  tone={result().level === "unsupported" ? "danger" : "warn"}
                >
                  {result().level === "unsupported"
                    ? "Cannot be added"
                    : "Needs manual changes"}
                </Badge>
                <p>
                  {result().summary || t("installStore.compatibilityFailed")}
                </p>
                <For each={result().diagnostics}>
                  {(diagnostic) => (
                    <p>{diagnostic.detail || diagnostic.message}</p>
                  )}
                </For>
              </aside>
            )}
          </Show>
          <form
            class="iv-form"
            onSubmit={(event) => {
              event.preventDefault();
              void prepareInstall();
            }}
          >
            <FormField label={t("installStore.name")} required>
              <Input
                value={name()}
                onInput={(event) => {
                  resetCompiledPreparation();
                  setName(event.currentTarget.value);
                }}
              />
            </FormField>
            <Show when={!listing()}>
              <details class="iv-advanced">
                <summary>{t("installStore.sourceDetails")}</summary>
                <div class="iv-fields">
                  <FormField label={t("installStore.sourceUrl")} required>
                    <Input
                      value={gitUrl()}
                      onInput={(event) => {
                        resetPreparedSource();
                        setGitUrl(event.currentTarget.value);
                      }}
                      spellcheck={false}
                    />
                  </FormField>
                  <FormField label={t("installStore.sourceRef")}>
                    <Input
                      value={gitRef()}
                      onInput={(event) => {
                        resetPreparedSource();
                        setGitRef(event.currentTarget.value);
                      }}
                    />
                  </FormField>
                  <FormField label={t("installStore.sourcePath")}>
                    <Input
                      value={sourcePath()}
                      onInput={(event) => {
                        resetPreparedSource();
                        setSourcePath(event.currentTarget.value);
                      }}
                    />
                  </FormField>
                  <FormField label={t("installStore.modulePath")}>
                    <Input
                      value={modulePath()}
                      onInput={(event) => {
                        resetPreparedSource();
                        setModulePathExplicit(true);
                        setModulePath(event.currentTarget.value);
                      }}
                    />
                  </FormField>
                  <Show when={sourceCandidates().length > 0}>
                    <FormField label={t("installStore.sourceAuth")}>
                      <Select
                        value={sourceAuthConnectionId()}
                        onChange={(event) => {
                          resetPreparedSource();
                          setSourceAuthConnectionId(event.currentTarget.value);
                        }}
                      >
                        <option value="">
                          {t("installStore.publicSource")}
                        </option>
                        <For each={sourceCandidates()}>
                          {(connection) => (
                            <option value={connection.id}>
                              {providerConnectionDisplayName(connection)}
                            </option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                  </Show>
                </div>
              </details>
            </Show>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              icon={<PackagePlus size={18} />}
            >
              {t("installStore.add")}
            </Button>
          </form>
        </section>
      </Show>

      <Show when={phase() === "preparing"}>
        <section
          class="iv-workbench iv-centered"
          role="status"
          aria-live="polite"
        >
          <Spinner size={24} />
          <h2>{t("installStore.preparing")}</h2>
          <p>{preparationStageHint()}</p>
          <Show when={preparationController()}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => activePreparationController?.abort()}
            >
              {t("common.cancel")}
            </Button>
          </Show>
        </section>
      </Show>

      <Show when={phase() === "connections"}>
        <section class="iv-workbench">
          {selectedModuleDetails()}
          <div class="iv-section-head">
            <PlugZap size={24} aria-hidden="true" />
            <h2>
              {providerConnectionSetupRequired()
                ? t("installStore.providerTitle")
                : t("installStore.destinationTitle")}
            </h2>
            <p>
              {providerConnectionSetupRequired()
                ? t("installStore.providerHint")
                : t("installStore.destinationHint")}
            </p>
          </div>
          <div class="iv-connection-list">
            <For each={providerRows()}>
              {(row) => {
                const choices = () => candidatesFor(row.provider);
                return (
                  <article
                    class="iv-connection-choice"
                    data-provider-source={row.provider}
                    data-module-local-name={row.moduleLocalName}
                  >
                    <div class="iv-connection-provider">
                      <span>{t("installStore.providerModule")}</span>
                      <strong>{providerModuleLabel(row)}</strong>
                      <code>{row.provider}</code>
                    </div>
                    <FormField
                      label={t("installStore.destination")}
                      required
                    >
                      <Select
                        value={row.connectionId}
                        onChange={(event) =>
                          updateProviderRow(row, event.currentTarget.value)
                        }
                      >
                        <option value="">
                          {t("installStore.chooseConnection")}
                        </option>
                        <For each={choices()}>
                          {(connection) => (
                            <option
                              value={connection.id}
                              selected={connection.id === row.connectionId}
                            >
                              {providerConnectionDisplayName(connection)}
                            </option>
                          )}
                        </For>
                      </Select>
                    </FormField>
                  </article>
                );
              }}
            </For>
          </div>
          <div class="iv-action-row">
            <Show when={providerConnectionSetupRequired()}>
              <Button
                href={providerConnectionsHrefForInstallReturn(
                  sourceReturnPath(),
                )}
                variant="secondary"
              >
                {t("installStore.connect")}
              </Button>
            </Show>
            <Button
              type="button"
              variant="primary"
              disabled={!providerRowsReady()}
              onClick={() => void continueAfterConnections()}
            >
              {t("installStore.continue")}
            </Button>
          </div>
        </section>
      </Show>

      <Show when={phase() === "setup"}>
        <section class="iv-workbench">
          {selectedModuleDetails()}
          {autoSelectedDestinationSummary()}
          <div class="iv-section-head">
            <h2>{t("installStore.setupTitle")}</h2>
            <p>{t("installStore.setupHint")}</p>
          </div>
          <Show when={sourceBuild()}>
            {(build) => (
              <section class="iv-source-build" aria-labelledby="iv-source-build-title">
                <div class="iv-section-head">
                  <h3 id="iv-source-build-title">
                    {t("installStore.sourceBuildTitle")}
                  </h3>
                  <p>{t("installStore.sourceBuildHint")}</p>
                </div>
                <ol class="iv-source-build-commands">
                  <For each={build().commands}>
                    {(command, index) => (
                      <li>
                        <strong>
                          {t("installStore.sourceBuildCommand", {
                            index: String(index() + 1),
                          })}
                        </strong>
                        <div class="iv-source-build-argv" aria-label="argv">
                          <For each={command.argv}>
                            {(argument) => <code>{argument}</code>}
                          </For>
                        </div>
                        <p>
                          {t("installStore.sourceBuildWorkingDirectory")}: {" "}
                          <code>
                            {command.workingDirectory ??
                              t("installStore.sourceBuildSourceRoot")}
                          </code>
                        </p>
                      </li>
                    )}
                  </For>
                </ol>
                <div class="iv-source-build-outputs">
                  <strong>{t("installStore.sourceBuildOutputs")}</strong>
                  <ul>
                    <For each={build().outputs}>
                      {(output) => (
                        <li>
                          <code>{output}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </section>
            )}
          </Show>
          <Show when={storeEntry()}>
            {(entry) => (
              <>
                <Show when={entry().setupProjectionInvalid}>
                  <aside class="iv-setup-note" role="alert">
                    <strong>Service setup is unavailable</strong>
                    <p>{t("installStore.setupInvalid")}</p>
                  </aside>
                </Show>
                <Show
                  when={storeRequiresUnavailableSecretMaterialization(entry())}
                >
                  <aside class="iv-setup-note" role="alert">
                    <strong>Secret setup is unavailable</strong>
                    <p>{t("installStore.secretUnavailable")}</p>
                  </aside>
                </Show>
                <Show when={visibleStoreInstallFeatures(entry()).length > 0}>
                  <section class="iv-feature-list">
                    <h3>Optional features</h3>
                    <For each={visibleStoreInstallFeatures(entry())}>
                      {(feature) => (
                        <div class="iv-feature">
                          <Checkbox
                            checked={storeFeatureEnabled(entry(), feature)}
                            disabled={!feature.optional}
                            label={storeFeatureLabel(feature, locale())}
                            onChange={(event) =>
                              toggleStoreFeature(
                                entry(),
                                feature,
                                event.currentTarget.checked,
                              )
                            }
                          />
                        </div>
                      )}
                    </For>
                  </section>
                </Show>
              </>
            )}
          </Show>
          <div class="iv-fields">
            <For each={visibleSetupFields()}>
              {(field) => (
                <FormField
                  label={storeInputLabel(field, locale())}
                  hint={field.secret ? t("installStore.secretHint") : undefined}
                  required={field.required && !field.secret}
                >
                  <Input
                    type={
                      field.secret
                        ? "password"
                        : field.type === "number"
                          ? "number"
                          : "text"
                    }
                    value={setupValue(field)}
                    onInput={(event) =>
                      updateStoreInput(field, event.currentTarget.value)
                    }
                  />
                </FormField>
              )}
            </For>
          </div>
          <Button
            type="button"
            variant="primary"
            size="lg"
            busy={busy()}
            onClick={() => void preparePlan()}
          >
            {t("installStore.continue")}
          </Button>
        </section>
      </Show>

      <Show when={phase() === "review" && planRunId() && capsuleId()}>
        <section class="iv-workbench">
          {autoSelectedDestinationSummary()}
          <InstallExecution
            planRunId={planRunId()!}
            capsuleId={capsuleId()!}
            onDone={() => void finishInstallation()}
          />
        </section>
      </Show>

      <Show when={phase() === "finishing" && capsuleId()}>
        <section
          class="iv-workbench iv-centered"
          role="status"
          aria-live="polite"
        >
          <Show when={!error()}>
            <Spinner size={24} />
            <h2>{t("installStore.finalizing")}</h2>
            <p>{t("installStore.finalizingHint")}</p>
          </Show>
          <Show when={error()}>
            <div class="iv-action-row">
              <Button
                type="button"
                variant="primary"
                onClick={() => void finishInstallation()}
              >
                {t("common.retry")}
              </Button>
              <Button
                href={`/workloads/${encodeURIComponent(capsuleId()!)}`}
                variant="secondary"
              >
                {t("installStore.runDetails")}
              </Button>
            </div>
          </Show>
        </section>
      </Show>

      <Show when={phase() === "done" && capsuleId()}>
        <section class="iv-workbench iv-centered iv-done">
          <CheckCircle2 size={40} aria-hidden="true" />
          <h2>{t("installStore.doneTitle")}</h2>
          <p>{t("installStore.doneHint")}</p>
          <div class="iv-action-row">
            <Button
              href={
                interfaceUrl() ??
                `/workloads/${encodeURIComponent(capsuleId()!)}`
              }
              variant="primary"
              size="lg"
              target={interfaceUrl() ? "_blank" : undefined}
              rel={interfaceUrl() ? "noreferrer noopener" : undefined}
            >
              {t("installStore.open")}
            </Button>
            <Show when={appConnectHref()}>
              {(href) => (
                <Button href={href()} variant="secondary">
                  {appHandoff
                    ? `Open in ${appHandoffProductLabel(appHandoff.product)}`
                    : t("installStore.open")}
                </Button>
              )}
            </Show>
            <Button type="button" variant="ghost" onClick={reset}>
              {t("installStore.chooseAnother")}
            </Button>
          </div>
        </section>
      </Show>
    </main>
  );
}
