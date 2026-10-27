import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  PackagePlus,
  PlugZap,
} from "lucide-solid";
import {
  isCanonicalRepositoryDirectoryPath,
  type JsonValue,
} from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import { StoreBrowser } from "../store/StoreBrowser.tsx";
import { buildNewQuery } from "../store/store-link.ts";
import {
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  Spinner,
  Textarea,
} from "../../components/ui/index.ts";
import {
  abandonUnappliedCapsule,
  checkCapsuleCompatibility,
  capsuleAbandonmentCompleted,
  ControlApiError,
  ControlApiIndeterminateError,
  SourceCreateIndeterminateError,
  createReviewableGitInstallPlan,
  createWorkspace,
  extractRunId,
  getGitInstallPlan,
  getInstallConfig,
  listConnectionsWithSignal,
  listReleaseOwnedProviderConnectionsWithSignal,
  listSourceSnapshotInstallModules,
  prepareCapsuleSourceSnapshot,
  patchSource,
  deleteSource,
  reconcileGitInstallPlan,
  testConnection,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  type PolicyConfig,
  type ProviderConnection,
  type SourceCreateReconciliationToken,
} from "../../lib/control-api.ts";
import type { GitInstallPlanResponse } from "takosumi-contract";
import {
  createInstallRecoveryFence,
  hasInstallRecoveryLocator,
  installRecoveryId,
  installRecoveryMatches,
  installRecoveryPresentation,
  installRecoveryRouteMatches,
  installRecoverySearch,
} from "../../lib/install-recovery.ts";
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
import {
  getOrCreateInstallPlanAttempt,
  installPlanAttemptRequest,
  type InstallPlanAttempt,
} from "../../lib/install-plan-attempt.ts";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { locale, t } from "../../i18n/index.ts";
import { fetchTcsListing, type TcsListing } from "../../lib/tcs-client.ts";
import {
  CAPSULE_NAME_PATTERN,
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultWorkspaceHandle,
  localizedStoreText,
  providerDisplayName,
  compatibilityDiagnosticDisplay,
  compatibilityLabel,
  compatibilitySummaryDisplay,
  compatibilityTone,
  parseInitialTcsHandoff,
  setStoreJsonVariable,
  slugInputValue,
  storeDefaultInputValue,
  installModuleCatalogFromSnapshot,
  scannedModuleChoice,
  storeEntryFromStoreListing,
  storeEntryFromRepositoryConfig,
  installFlowErrorMessage,
  isDuplicateServiceError,
  uniqueServiceIdCandidate,
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
import InstallLifecycle from "./InstallLifecycle.tsx";
import ConnectionCreateForm from "../workspace/connections/ConnectionCreateForm.tsx";
import { providerConnectionStatusLabel } from "../../lib/labels.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import AppFace from "../../components/AppFace.tsx";
import { PlannedResources } from "../app/PlannedResources.tsx";
import { installCapsuleId, installCapsuleSearch, type InstallUiState } from "./install-lifecycle.ts";
import "./install-view.css";
import "./install-simplification.css";

/** One scanned root-module candidate from the immutable SourceSnapshot index. */
type InstallModuleCatalogEntry = Extract<
  InstallModuleCatalog,
  { readonly status: "ready" }
>["modules"][number];

type Phase =
  | "browse"
  | "configure"
  | "module-select"
  | "preparing"
  | "setup"
  | "review"
  | "finishing"
  | "done";

const UI_SURFACE_READBACK_ATTEMPTS = 10;
const UI_SURFACE_READBACK_DELAY_MS = 3_000;
const INSTALL_PREPARATION_TIMEOUT_MS = 60_000;
const SOURCE_FETCH_SLOW_HINT_MS = 5_000;

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

/** `https://github.com/o/r.git` → `github.com/o/r`, for the provenance line. */
function repositoryLabel(url: string): string {
  return url.trim().replace(/^https:\/\//u, "").replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
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
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const initial = parseInstallPrefill(location.search);
  // A query path is only a user hint. It is accepted as install authority only
  // after the exact SourceSnapshot module projection proves that path exists.
  const initialModulePathExplicit = Boolean(initial?.path);
  const appHandoff = createMemo(() => appHandoffFromSearch(location.search));
  const [phase, setPhase] = createSignal<Phase>(
    installCapsuleId(location.search) ? "done" : hasInstallPrefillParams(location.search) ? "configure" : "browse",
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
  const [gitRefResolvedFromListing, setGitRefResolvedFromListing] =
    createSignal(false);
  const [sourcePath, setSourcePath] = createSignal(initial?.sourcePath ?? ".");
  const [modulePath, setModulePath] = createSignal(initial?.path || ".");
  const [modulePathExplicit, setModulePathExplicit] = createSignal(
    initialModulePathExplicit,
  );
  // True while the module path arrived with a link or a listing and the user
  // has not touched it. A catalog entry can go stale, so a hint the immutable
  // scan cannot prove falls back to the scan's own choice instead of a hard
  // error.
  const [modulePathHint, setModulePathHint] = createSignal(
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
  // The exact Git version this attempt read. Shown as provenance so a Store
  // install never picks a version silently.
  const [preparedVersion, setPreparedVersion] = createSignal<
    { readonly ref: string; readonly commit: string }
  >();
  // The Source keeps the name it was registered with. The install Plan must
  // repeat that exact name for `preflight.sourceId`; renaming the app before
  // the Plan only changes the Capsule name.
  let preparedSourceName: string | undefined;
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
  const [capsuleId, setCapsuleId] = createSignal<string | undefined>(installCapsuleId(location.search));
  // The provider row whose connection form is open inside the install sheet.
  const [connectingProvider, setConnectingProvider] = createSignal<string>();
  // Per-row connection problems shown inside the install sheet.
  const [connectionErrors, setConnectionErrors] = createSignal<
    Readonly<Record<string, string>>
  >({});
  // A Source this attempt created itself. Only that Source is offered for
  // cleanup when the user discards the attempt; a reused Source is never deleted.
  let attemptCreatedSourceId: string | undefined;
  const [discarding, setDiscarding] = createSignal(false);
  const [lifecycleState, setLifecycleState] = createSignal<InstallUiState>("configuring");
  const [executionState, setExecutionState] = createSignal<InstallUiState>("installing");
  const [planRunId, setPlanRunId] = createSignal<string>();
  // True once "Allow and install" finished in this page view (not a reload).
  const [completedHere, setCompletedHere] = createSignal(false);
  let installPlanAttempt: InstallPlanAttempt | undefined;
  const [recovery, setRecovery] = createSignal<
    | { readonly status: "loading" | "unavailable" }
    | { readonly status: "ready"; readonly response: GitInstallPlanResponse }
  >({ status: "unavailable" });
  const [recoveryBusy, setRecoveryBusy] = createSignal(false);
  const recoveryFence = createInstallRecoveryFence();
  let disposed = false;
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [preparationStage, setPreparationStage] =
    createSignal<PreparationStage>("workspace");
  const [sourceFetchSlow, setSourceFetchSlow] = createSignal(false);
  const [preparationController, setPreparationController] =
    createSignal<AbortController>();
  const [interfaceUrl, setInterfaceUrl] = createSignal<string>();
  let completionAttempt = 0;
  let autoSyncSourceForInstall:
    | { readonly workspaceId: string; readonly sourceId: string }
    | undefined;
  const [sourceAutoSyncError, setSourceAutoSyncError] = createSignal<string>();
  const [sourceAutoSyncBusy, setSourceAutoSyncBusy] = createSignal(false);
  let activePreparationController: AbortController | undefined;
  let sourceFetchSlowHintTimeout: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    if (sourceFetchSlowHintTimeout) clearTimeout(sourceFetchSlowHintTimeout);
    sourceFetchSlowHintTimeout = undefined;
    setSourceFetchSlow(false);
    if (phase() !== "preparing" || preparationStage() !== "source") return;
    sourceFetchSlowHintTimeout = setTimeout(
      () => setSourceFetchSlow(true),
      SOURCE_FETCH_SLOW_HINT_MS,
    );
  });
  onCleanup(() => {
    disposed = true;
    activePreparationController?.abort();
    if (sourceFetchSlowHintTimeout) clearTimeout(sourceFetchSlowHintTimeout);
  });

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

  const selectedDescription = () => {
    const description = listing()?.description?.[locale()] ?? storeEntry()?.description?.[locale()];
    return description && description !== selectedTitle() ? description : t("installStore.appDescription");
  };

  /**
   * The chooser is the one place the user picks a destination, so every
   * candidate carries the provider set Takosumi derived from that exact
   * scanned directory. The list is read from the immutable scan; nothing is
   * inferred from Store metadata or a repository manifest.
   */
  const moduleCandidateLabel = (
    module: InstallModuleCatalogEntry,
  ): string => {
    const providers = [
      ...new Set(
        module.providerPackages.map((provider) =>
          providerDisplayName(provider.source),
        ),
      ),
    ];
    return t("installStore.moduleOption", {
      path: module.path,
      providers:
        providers.length > 0
          ? providers.join(", ")
          : t("installStore.moduleNoProviders"),
    });
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
          {/* Already decided, so plain text: a disabled select looked like a
              choice that did nothing and cut long names at its chevron. */}
          <span>{t("installStore.destination")}</span>{" "}
          <strong class="iv-destination-name">
            {providerConnectionDisplayName(destination())}
          </strong>
        </div>
      )}
    </Show>
  );

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
        storeInputIsActive(entry, field),
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

  const renderSetupField = (field: StoreInputField) => (
    <FormField label={storeInputLabel(field, locale())} hint={storeInputHelper(field, locale())} required={field.required}>
      <Show when={field.type === "boolean"} fallback={
        <Show when={field.type === "json"} fallback={
          <Input type={field.type === "number" ? "number" : "text"} value={setupValue(field)} placeholder={field.placeholder}
            onInput={(event) => updateStoreInput(field, event.currentTarget.value)} />
        }><Textarea value={setupValue(field)} onInput={(event) => updateStoreInput(field, event.currentTarget.value)} /></Show>
      }><Select value={setupValue(field)} onChange={(event) => updateStoreInput(field, event.currentTarget.value)}>
        <option value="">{t("installStore.selectValue")}</option><option value="true">{t("installStore.yes")}</option><option value="false">{t("installStore.no")}</option>
      </Select></Show>
    </FormField>
  );

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

  const loadRecovery = async (id: string, workspace: string, signal?: AbortSignal) => {
    const epoch = recoveryFence.begin();
    setRecovery({ status: "loading" });
    try {
      const response = await getGitInstallPlan(id, { signal });
      if (disposed || signal?.aborted || !recoveryFence.isCurrent(epoch) || installRecoveryId(location.search) !== id) return;
      setRecovery(
        workspaceIsCurrent(workspace) &&
          installRecoveryMatches(response, id, workspace, props.installingPrincipalId)
          ? { status: "ready", response }
          : { status: "unavailable" },
      );
      if (!busy() && workspaceIsCurrent(workspace) &&
        installRecoveryMatches(response, id, workspace, props.installingPrincipalId) &&
        response.installPlan.capsuleId && response.installPlan.planRunId) {
        setCapsuleId(response.installPlan.capsuleId);
        setPhase("done");
        navigate(appendAppHandoff(`${location.pathname}${installCapsuleSearch(response.installPlan.capsuleId)}`, appHandoff())!, { replace: true });
      }
    } catch {
      if (!disposed && !signal?.aborted && recoveryFence.isCurrent(epoch) && installRecoveryId(location.search) === id) {
        setRecovery({ status: "unavailable" });
      }
    }
  };

  createEffect(() => {
    const search = location.search;
    const workspace = currentWorkspaceId();
    const id = installRecoveryId(search);
    setRecoveryBusy(false);
    if (!id || !workspace) {
      recoveryFence.invalidate();
      setRecovery({ status: "unavailable" });
      return;
    }
    const controller = new AbortController();
    void loadRecovery(id, workspace, controller.signal);
    onCleanup(() => controller.abort());
  });

  const continueRecovery = async () => {
    const state = recovery();
    const id = installRecoveryId(location.search);
    const workspace = currentWorkspaceId();
    if (
      state.status !== "ready" || state.response.nextAction !== "reconcile" ||
      !id || !workspaceIsCurrent(workspace) || recoveryBusy() ||
      !installRecoveryMatches(state.response, id, workspace, props.installingPrincipalId)
    ) return;
    const epoch = recoveryFence.begin();
    setRecoveryBusy(true);
    try {
      const response = await reconcileGitInstallPlan(id);
      if (disposed || !recoveryFence.isCurrent(epoch) || installRecoveryId(location.search) !== id || !workspaceIsCurrent(workspace)) return;
      setRecovery(
        installRecoveryMatches(response, id, workspace, props.installingPrincipalId)
          ? { status: "ready", response }
          : { status: "unavailable" },
      );
    } catch {
      if (!disposed && recoveryFence.isCurrent(epoch) && installRecoveryId(location.search) === id && workspaceIsCurrent(workspace)) {
        // A failed explicit mutation is unknown, so only a fresh GET is offered.
        setRecovery({ status: "unavailable" });
      }
    } finally {
      if (recoveryFence.isCurrent(epoch)) setRecoveryBusy(false);
    }
  };

  const clearRecovery = () => {
    recoveryFence.invalidate();
    setRecoveryBusy(false);
    navigate(location.pathname, { replace: true });
    setRecovery({ status: "unavailable" });
    reset();
  };

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
    setConnectionErrors({});
    setCapsuleId(undefined);
    setPlanRunId(undefined);
    setInterfaceUrl(undefined);
    installPlanAttempt = undefined;
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
    const preservedModulePathHint = options?.preserveModuleSelection
      ? modulePathHint()
      : false;
    autoSyncSourceForInstall = undefined;
    setSourceAutoSyncError(undefined);
    setSourceAutoSyncBusy(false);
    setSourceId(undefined);
    setSourceSnapshotId(undefined);
    setPreparedVersion(undefined);
    preparedSourceName = undefined;
    setSourceCreateReconciliationToken(undefined);
    setInstallModulesLoading(false);
    setInstallModuleCatalog({ status: "none", modules: [] });
    setModulePath(preservedModulePath);
    setModulePathExplicit(preservedModulePathExplicit);
    setModulePathHint(preservedModulePathHint);
    setModuleSelectionConfirmed(false);
    resetCompiledPreparation();
  };

  // Header workspace changes are reactive. Never let a previously prepared
  // Source/Capsule/Plan continue writing under the old workspace.
  let observedWorkspaceId = workspaceId();
  createEffect(() => {
    const selected = currentWorkspaceId();
    if (selected === observedWorkspaceId) return;
    const hydrating = !observedWorkspaceId && Boolean(installCapsuleId(location.search));
    observedWorkspaceId = selected;
    setWorkspaceId(selected);
    if (hydrating) return;
    setConnectingProvider(undefined);
    attemptCreatedSourceId = undefined;
    if (installCapsuleId(location.search)) navigate(location.pathname, { replace: true });
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

  let observedCapsuleLocator = installCapsuleId(location.search);
  createEffect(() => {
    const next = installCapsuleId(location.search);
    if (next === observedCapsuleLocator) return;
    observedCapsuleLocator = next;
    // A new browser route may select another app, but never replay an install.
    if (!next && phase() === "done") {
      reset();
      const prefill = parseInstallPrefill(location.search);
      if (prefill) {
        setGitUrl(prefill.git); setGitRef(prefill.ref ?? ""); setSourcePath(prefill.sourcePath ?? ".");
        setModulePath(prefill.path || "."); setModulePathExplicit(Boolean(prefill.path)); setModulePathHint(Boolean(prefill.path));
        setName(prefill.name ?? capsuleNameFromUrl(prefill.git)); setPhase("configure");
      }
      return;
    }
    if (next && next !== capsuleId()) {
      resetPreparedSource(); setListing(null); setName(""); setCapsuleId(next);
      setConnectingProvider(undefined); setPhase("done");
    }
  });

  const chooseListing = (selected: TcsListing) => {
    resetPreparedSource();
    setConnectingProvider(undefined);
    attemptCreatedSourceId = undefined;
    setListing(selected);
    setGitUrl(selected.source.url);
    setGitRef("");
    setGitRefResolvedFromListing(false);
    setSourcePath(".");
    // The listing names the module it reviewed. Keep it as an explicit hint;
    // the scan below still has to prove the directory before it becomes
    // install authority.
    setModulePath(selected.source.path ?? ".");
    setModulePathExplicit(Boolean(selected.source.path));
    setModulePathHint(Boolean(selected.source.path));
    setModuleSelectionConfirmed(Boolean(selected.source.path));
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
    setModulePathHint(false);
    setModuleSelectionConfirmed(false);
    setError(undefined);
  };

  const updateProviderRow = (
    target: ProviderConnectionRow,
    connectionId: string,
  ) => {
    installPlanAttempt = undefined;
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
    // A timeout does not cancel the durable coordinator. An unchanged explicit
    // retry must replay its exact evidence/body, not run compatibility again.
    if (installPlanAttempt) {
      await submitInstallPlan(installPlanAttempt);
      return;
    }
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
        const creatingSource = !preparedSourceId;
        const sourceName = name().trim();
        const prepared = await prepareCapsuleSourceSnapshot({
          workspaceId: workspace,
          sourceId: preparedSourceId,
          gitUrl: gitUrl().trim(),
          ref: gitRef().trim(),
          sourcePath: sourcePath(),
          resolveAbsentRefToStableSemver: listing() !== null,
          name: sourceName,
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
              if (creatingSource) {
                attemptCreatedSourceId = createdSourceId;
                autoSyncSourceForInstall = {
                  workspaceId: workspace,
                  sourceId: createdSourceId,
                };
              }
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
          setGitRefResolvedFromListing(true);
        }
        setSourceId(prepared.sourceId);
        setSourceSnapshotId(prepared.sourceSnapshotId);
        if (creatingSource || !preparedSourceName) preparedSourceName = sourceName;
        setPreparedVersion({
          ref: prepared.snapshot.ref,
          commit: prepared.snapshot.resolvedCommit,
        });
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
          // A module path that arrived with a link or a listing is a hint the
          // catalog cannot verify. When the immutable scan does not expose that
          // exact directory, drop the hint and let the scan choose — the single
          // installed root, or the user. A typed path still fails loudly below.
          if (
            modulePathExplicit() &&
            modulePathHint() &&
            !catalog.modules.some(
              (module) => module.path === modulePath().trim(),
            )
          ) {
            setModulePathHint(false);
            setModulePathExplicit(false);
            setModuleSelectionConfirmed(false);
            setModulePath("");
          }
          if (catalog.modules.length === 0) {
            // An empty ready scan is a valid observation, but there is no
            // executable OpenTofu root to install from this revision.
            setError(t("installStore.moduleMissing"));
            setPhase("configure");
            return;
          } else if (modulePathExplicit()) {
            const choice = scannedModuleChoice({
              modules: catalog.modules,
              requestedPath: modulePath(),
              requestedPathIsHint: modulePathHint(),
            });
            if (choice.kind === "missing") {
              setError(t("installStore.moduleUnavailable"));
              setPhase("configure");
              return;
            }
            // Preserve the requested directory exactly after canonical
            // validation against the immutable scan. A path the user typed is
            // the whole choice; a proven link or listing hint only preselects
            // the destination, so a repository whose OpenTofu files define
            // more than one root still reaches the chooser below with every
            // candidate selectable.
            setModulePath(choice.path);
            setModuleSelectionConfirmed(choice.kind === "adopt");
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
        setError(compatibilitySummaryDisplay(result));
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
        : result.repositoryInstallUx?.status === "accepted"
          ? storeEntryFromRepositoryConfig(config, {
              gitUrl: gitUrl().trim(),
              name: name().trim(),
            })
          : storeEntryFromRepositoryConfig(config, { gitUrl: gitUrl().trim(), name: name().trim() });
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
      // Preparation reveals the form; it never creates an install Plan yet.
      setPhase("setup");
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
        setError(installFlowErrorMessage(cause));
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

  const restartFailedInstall = async () => {
    const workspace = workspaceId();
    const failedCapsuleId = capsuleId();
    if (
      !workspace ||
      !failedCapsuleId ||
      !workspaceIsCurrent(workspace)
    ) {
      throw new Error(t("installStore.restartUnavailable"));
    }
    const accepted = await confirm({
      title: t("installStore.restartConfirmTitle"),
      message: t("installStore.restartConfirmMessage"),
      confirmText: t("installStore.restartWithLatestSource"),
      cancelText: t("common.cancel"),
      danger: true,
    });
    if (!accepted || disposed || !workspaceIsCurrent(workspace)) return;

    const deleted = await abandonUnappliedCapsule(failedCapsuleId);
    if (
      !capsuleAbandonmentCompleted(deleted, {
        id: failedCapsuleId,
        workspaceId: workspace,
      })
    ) {
      throw new Error(t("installStore.restartUnavailable"));
    }
    if (disposed || !workspaceIsCurrent(workspace)) return;
    navigate(appendAppHandoff(location.pathname, appHandoff())!, { replace: true });
    clearCapsuleListCache(workspace);
    clearCurrentStateVersionCache(workspace);
    clearDashboardOverviewCache(workspace);

    // A listing may have resolved an omitted ref to the previous stable tag.
    // Restore the omission so the new Source resolves the latest stable tag;
    // an operator-supplied explicit ref remains exact.
    if (gitRefResolvedFromListing()) {
      setGitRef("");
      setGitRefResolvedFromListing(false);
    }
    // The failed Plan and immutable SourceSnapshot remain as history. The old
    // unapplied Capsule is abandoned, so rebuilding from the same inputs can
    // safely create a new Source/InstallConfig/Capsule with the same name.
    const retainedValues = storeValues();
    const retainedTouched = storeInputTouched();
    const retainedFeatures = storeFeatureSelections();
    resetPreparedSource({ preserveModuleSelection: true });
    setError(undefined);
    setPhase("configure");
    await prepareInstall();
    if (workspaceIsCurrent(workspace)) {
      setStoreValues(retainedValues); setStoreInputTouched(retainedTouched); setStoreFeatureSelections(retainedFeatures);
    }
  };

  /**
   * Discards this install attempt and returns to the same app, not installed.
   * Only a never-applied Capsule is abandoned (the server refuses an applied
   * one), and only the Source this attempt created is deleted, best effort.
   */
  // The direct-Git link fields that describe this app, so a reload after
  // discarding still shows the same app and the version it was linked to.
  const directGitQuery = (): string => {
    const params = new URLSearchParams({ git: gitUrl().trim() });
    const ref = gitRef().trim();
    if (ref && !gitRefResolvedFromListing()) params.set("ref", ref);
    if (sourcePath() !== ".") params.set("sourcePath", sourcePath());
    if (modulePathExplicit() && modulePath().trim()) params.set("path", modulePath().trim());
    if (name().trim()) params.set("name", name().trim());
    return params.toString();
  };

  const discardAttempt = async () => {
    // A Plan request in flight has an unknown outcome; never discard over it.
    // Only repository preparation can be cancelled while busy.
    const cancellingPreparation =
      phase() === "preparing" && preparationStage() !== "plan";
    if (discarding() || (busy() && !cancellingPreparation)) return;
    const workspace = workspaceId();
    activePreparationController?.abort();
    setDiscarding(true);
    setError(undefined);
    try {
      const pendingCapsuleId = capsuleId();
      if (workspace && pendingCapsuleId && workspaceIsCurrent(workspace)) {
        const abandoned = await abandonUnappliedCapsule(pendingCapsuleId);
        if (
          !capsuleAbandonmentCompleted(abandoned, {
            id: pendingCapsuleId,
            workspaceId: workspace,
          })
        ) {
          throw new Error(t("installStore.discardUnavailable"));
        }
        clearCapsuleListCache(workspace);
        clearCurrentStateVersionCache(workspace);
        clearDashboardOverviewCache(workspace);
      }
      const createdSourceId = attemptCreatedSourceId;
      if (createdSourceId && workspace && workspaceIsCurrent(workspace)) {
        // A refusal (still referenced, a sync in flight, or no management
        // authority) keeps the Source. Stop it polling Git instead; neither
        // outcome blocks discarding the attempt.
        await deleteSource(createdSourceId).catch(() =>
          patchSource(createdSourceId, { autoSync: false }).catch(() => undefined)
        );
      }
      if (disposed || (workspace && !workspaceIsCurrent(workspace))) return;
      attemptCreatedSourceId = undefined;
      // Return to the same app page, so a reload still shows this app.
      const selectedListing = listing();
      const appSearch = selectedListing
        ? `?${buildNewQuery(selectedListing)}`
        : gitUrl().trim()
          ? `?${directGitQuery()}`
          : "";
      navigate(appendAppHandoff(`${location.pathname}${appSearch}`, appHandoff())!, { replace: true });
      if (gitRefResolvedFromListing()) {
        setGitRef("");
        setGitRefResolvedFromListing(false);
      }
        setConnectingProvider(undefined);
      resetPreparedSource({ preserveModuleSelection: true });
      setPhase("configure");
    } catch (cause) {
      if (!disposed) setError(installFlowErrorMessage(cause));
    } finally {
      if (!disposed) setDiscarding(false);
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
    setModulePathHint(false);
    setModulePathExplicit(true);
    setModuleSelectionConfirmed(true);
    void prepareInstall();
  };

  const preparePlan = async (
    workspace = workspaceId(),
    checked = compatibility(),
    config = installConfig(),
    rows = providerRows(),
    vars = variables(),
  ) => {
    if (!workspace || !checked || !config) return;
    if (checked.level !== "ready") {
      setError(compatibilitySummaryDisplay(checked));
      setPhase("configure");
      return;
    }
    if (!workspaceIsCurrent(workspace)) return;
    const basicValidation = validateBasic();
    if (basicValidation) { setError(basicValidation); return; }
    const validation = setupError();
    if (validation) {
      setError(validation);
      return;
    }
    if (workspacePolicyState().status !== "ready") {
      setPhase("setup");
      openFirstMissingConnection();
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
      setPhase("setup");
      openFirstMissingConnection();
      return;
    }
    setPreparationStage("plan");
    setPhase("preparing");
    setBusy(true);
    setError(undefined);
    try {
      if (!workspaceIsCurrent(workspace)) return;
      const exactSourceId = sourceId() ?? checked.sourceId;
      const exactSnapshotId = sourceSnapshotId() ?? checked.sourceSnapshotId;
      if (
        !exactSourceId ||
        !exactSnapshotId ||
        !checked.reportId ||
        !checked.compatibilityCheckRunId
      ) {
        throw new ControlApiError(
          409,
          "install_preflight_evidence_missing",
          "The exact successful install preflight is unavailable.",
        );
      }
      installPlanAttempt = getOrCreateInstallPlanAttempt(
        installPlanAttempt,
        workspace,
        {
          source: {
            name: preparedSourceName ?? name().trim(),
            url: gitUrl().trim(),
            ref: gitRef().trim() || "HEAD",
            path: sourcePath(),
            ...(sourceAuthConnectionId()
              ? { authConnectionId: sourceAuthConnectionId() }
              : {}),
          },
          capsule: { name: name().trim(), environment: "production" },
          options: {
            modulePath: modulePath().trim(),
            providerBindings: rows.map((row) => ({
              provider: row.provider,
              moduleLocalName: row.moduleLocalName,
              ...(row.childAlias ? { childAlias: row.childAlias } : {}),
              ...(row.rootAlias ? { rootAlias: row.rootAlias } : {}),
              connectionId: row.connectionId,
            })),
          },
          preflight: {
            sourceId: exactSourceId,
            sourceSnapshotId: exactSnapshotId,
            compatibilityCheckRunId: checked.compatibilityCheckRunId,
            compatibilityReportId: checked.reportId,
            installConfigId: config.id,
          },
          ...(vars ? { variables: vars } : {}),
        },
      );
      await submitInstallPlan(installPlanAttempt);
    } catch (cause) {
      setError(installFlowErrorMessage(cause));
      // Every prepared install has the sheet (at least its app name), not
      // only apps with settings: return there, not to the bare app page.
      setPhase(compatibility() && installConfig() ? "setup" : "configure");
    } finally {
      setBusy(false);
    }
  };

  const enableInstallSourceAutoSync = async (workspace: string) => {
    const pendingAutoSyncSource = autoSyncSourceForInstall;
    if (
      disposed || sourceAutoSyncBusy() || !pendingAutoSyncSource ||
      pendingAutoSyncSource.workspaceId !== workspace ||
      pendingAutoSyncSource.sourceId !== sourceId() ||
      !workspaceIsCurrent(workspace)
    ) return;
    const stillOwnsPendingSource = () =>
      !disposed && autoSyncSourceForInstall === pendingAutoSyncSource &&
      workspaceIsCurrent(workspace) && pendingAutoSyncSource.sourceId === sourceId();
    setSourceAutoSyncBusy(true);
    try {
      await patchSource(pendingAutoSyncSource.sourceId, { autoSync: true });
      if (!stillOwnsPendingSource()) return;
      // Keep this marker through failures so retry only repeats this PATCH,
      // without creating another Source, compatibility check, or install Plan.
      autoSyncSourceForInstall = undefined;
      setSourceAutoSyncError(undefined);
    } catch (cause) {
      if (stillOwnsPendingSource()) {
        setSourceAutoSyncError(installFlowErrorMessage(cause));
      }
    } finally {
      if (!disposed && workspaceIsCurrent(workspace) && pendingAutoSyncSource.sourceId === sourceId()) {
        setSourceAutoSyncBusy(false);
      }
    }
  };

  const submitInstallPlan = async (attempt: InstallPlanAttempt) => {
    const workspace = attempt.workspaceId;
    if (!workspaceIsCurrent(workspace)) return;
    const requestPath = location.pathname;
    const requestSearch = location.search;
    let acknowledgedPlanId: string | undefined;
    const routeStillOwnsPlan = (id: string) =>
      installRecoveryRouteMatches(
        location.pathname, location.search, requestPath, requestSearch, id,
      );
    setPreparationStage("plan");
    setPhase("preparing");
    setBusy(true);
    setError(undefined);
    try {
      const response = await createReviewableGitInstallPlan(
        workspace,
        installPlanAttemptRequest(attempt),
        {
          idempotencyKey: attempt.idempotencyKey,
          onProgress: (progress) => {
            if (
              !disposed && installPlanAttempt === attempt &&
              workspaceIsCurrent(workspace) &&
              routeStillOwnsPlan(progress.installPlan.id) &&
              installRecoveryMatches(
                progress, progress.installPlan.id, workspace, props.installingPrincipalId,
              )
            ) {
              acknowledgedPlanId = progress.installPlan.id;
              // Only the opaque acknowledged ID survives reload. Never persist
              // variables, request JSON, idempotency keys, or approval consent.
              navigate(appendAppHandoff(`${location.pathname}${installRecoverySearch(progress.installPlan.id)}`, appHandoff())!, {
                replace: true,
              });
            }
          },
        },
      );
      if (
        disposed || installPlanAttempt !== attempt ||
        !workspaceIsCurrent(workspace) || !routeStillOwnsPlan(response.installPlan.id)
      ) return;
      const currentCapsuleId = response.installPlan.capsuleId;
      const runId = response.installPlan.planRunId;
      if (!currentCapsuleId || !runId) {
        throw new Error(t("installStore.planMissing"));
      }
      setCapsuleId(currentCapsuleId);
      clearCapsuleListCache(workspace);
      clearCurrentStateVersionCache(workspace);
      clearDashboardOverviewCache(workspace);
      setPlanRunId(runId);
      await enableInstallSourceAutoSync(workspace);
      if (
        disposed || installPlanAttempt !== attempt ||
        !workspaceIsCurrent(workspace) || !routeStillOwnsPlan(response.installPlan.id)
      ) return;
      navigate(appendAppHandoff(`${location.pathname}${installCapsuleSearch(currentCapsuleId)}`, appHandoff())!, { replace: true });
      setPhase("review");
    } catch (cause) {
      if (disposed || installPlanAttempt !== attempt || !workspaceIsCurrent(workspace)) return;
      if (
        cause instanceof ControlApiError &&
        cause.status > 0 &&
        cause.status < 500 &&
        !acknowledgedPlanId
      ) {
        if (installPlanAttempt === attempt) installPlanAttempt = undefined;
      }
      if (isDuplicateServiceError(cause instanceof ControlApiError ? cause : undefined)) {
        setName(uniqueServiceIdCandidate(name().trim()));
        setError(t("new.error.alreadyExistsGeneric"));
      } else {
        setError(installFlowErrorMessage(cause));
      }
      // Every prepared install has the sheet (at least its app name), not
      // only apps with settings: return there, not to the bare app page.
      setPhase(compatibility() && installConfig() ? "setup" : "configure");
    } finally {
      setBusy(false);
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
      setError(installFlowErrorMessage(cause));
      setPhase("browse");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    completionAttempt += 1;
    setCompletedHere(false);
    setConnectingProvider(undefined);
    attemptCreatedSourceId = undefined;
    if (installCapsuleId(location.search)) navigate(location.pathname, { replace: true });
    setListing(null);
    setGitUrl("");
    setGitRef("");
    setGitRefResolvedFromListing(false);
    setSourcePath(".");
    setModulePath(".");
    setModulePathExplicit(false);
    setModulePathHint(false);
    setName("");
    autoSyncSourceForInstall = undefined;
    setSourceAutoSyncError(undefined);
    setSourceAutoSyncBusy(false);
    setSourceId(undefined);
    setSourceSnapshotId(undefined);
    setPreparedVersion(undefined);
    preparedSourceName = undefined;
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
    installPlanAttempt = undefined;
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

  const updateStoreInput = (field: StoreInputField, value: string) => {
    const entry = storeEntry();
    if (!entry) return;
    installPlanAttempt = undefined;
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
    installPlanAttempt = undefined;
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
      setCompletedHere(true);
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
          setCompletedHere(true);
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
    createAppHandoffConnectHref(appHandoff(), interfaceUrl());

  let connectionRefresh: AbortController | undefined;
  onCleanup(() => connectionRefresh?.abort());
  const refreshProviderChoices = async () => {
    const workspace = workspaceId(); if (!workspace || !workspaceIsCurrent(workspace)) return;
    connectionRefresh?.abort(); const controller = new AbortController(); connectionRefresh = controller;
    try {
      await loadConnections(workspace, controller.signal, true);
      if (controller.signal.aborted || disposed || !workspaceIsCurrent(workspace)) return;
      setProviderRows((rows) => rows.map((row) => {
        const choices = candidatesFor(row.provider);
        if (choices.some((c) => c.id === row.connectionId)) return row;
        const connectionId = preferredProviderConnection(choices, effectiveProviderPolicy())?.id ?? "";
        // An unchanged row keeps its identity, so <For> keeps its DOM (and the
        // focused row toggle) instead of re-creating the row.
        return connectionId === row.connectionId ? row : { ...row, connectionId };
      }));
    } catch (cause) { if (!controller.signal.aborted && workspaceIsCurrent(workspace)) setError(installFlowErrorMessage(cause)); }
  };
  const uiState = (): InstallUiState => phase() === "done" ? lifecycleState() :
    phase() === "review" ? executionState() : error() ? "failed" :
    phase() === "preparing" || phase() === "module-select" ? "configuring" : phase() === "finishing" ? "installing" :
    phase() === "setup" ? (!providerRowsReady() ? "provider-required" : setupError() ? "configuring" : "ready") :
    "not-installed";

  // Renaming before the Plan only changes the Capsule name in the Plan request.
  // The Source keeps its registered name (preparedSourceName), and the
  // compatibility evidence is not bound to the app name, so both stay.
  const updateName = (value: string) => {
    installPlanAttempt = undefined;
    setName(value);
  };

  const versionLabel = (): string | undefined => {
    const version = preparedVersion();
    if (!version) {
      const ref = gitRef().trim();
      // A pinned full commit reads as its short form, like after preparation.
      return /^[0-9a-f]{40}$/iu.test(ref) ? ref.slice(0, 7) : ref || undefined;
    }
    const commit = version.commit.slice(0, 7);
    return version.ref && version.ref !== version.commit && version.ref !== "HEAD"
      ? `${version.ref} · ${commit}`
      : commit;
  };

  const connectFormId = (row: ProviderConnectionRow) =>
    `install-connect-${providerRowKey(row).replace(/[^A-Za-z0-9_-]/gu, "-")}`;

  /**
   * Closing a row's form removes the focused control (or re-renders the row
   * with its new selection). Return focus that fell to the page to the row's
   * toggle instead of the top of the document.
   */
  const focusRowToggleIfLost = (row: ProviderConnectionRow) =>
    queueMicrotask(() => {
      if (disposed || (document.activeElement && document.activeElement !== document.body)) return;
      document.querySelector<HTMLElement>(`[aria-controls="${connectFormId(row)}"]`)?.focus({ preventScroll: true });
    });

  const setConnectionError = (row: ProviderConnectionRow, message?: string) =>
    setConnectionErrors((current) => {
      const next = { ...current };
      if (message) next[providerRowKey(row)] = message;
      else delete next[providerRowKey(row)];
      return next;
    });

  /** Select a just-created connection for its row once it is a valid choice. */
  const adoptRowConnection = async (row: ProviderConnectionRow, connectionId: string) => {
    await refreshProviderChoices();
    if (disposed) return;
    if (candidatesFor(row.provider).some((connection) => connection.id === connectionId)) {
      updateProviderRow(row, connectionId);
      setConnectionError(row);
      if (connectingProvider() === providerRowKey(row)) {
        setConnectingProvider(undefined);
        focusRowToggleIfLost(row);
      }
      return;
    }
    // A verified connection the install policy refuses must say so, not
    // silently stay unselected.
    const created = providerConnections().find((connection) => connection.id === connectionId);
    if (created?.status === "verified") {
      setConnectionError(row, t("installStore.connectionNotAllowed"));
    }
  };

  // Credential connections are tested once after saving, as on the
  // connections screen. OAuth connections arrive verified and skip the test.
  const verifyRowConnection = async (row: ProviderConnectionRow, connectionId: string) => {
    try {
      const result = (await testConnection(connectionId)) as
        { readonly status?: string } | undefined;
      if (result?.status && result.status !== "verified") {
        setConnectionError(row, t("conn.test.notReady", {
          status: providerConnectionStatusLabel(result.status),
        }));
      }
    } catch (cause) {
      if (!disposed) setConnectionError(row, friendlyError(cause, t).message);
    }
    await adoptRowConnection(row, connectionId);
  };

  const toggleConnect = (row: ProviderConnectionRow) => {
    const key = providerRowKey(row);
    if (connectingProvider() === key) {
      setConnectingProvider(undefined);
      focusRowToggleIfLost(row);
      void refreshProviderChoices();
      return;
    }
    setConnectingProvider(key);
    queueMicrotask(() => {
      if (disposed || connectingProvider() !== key) return;
      document.getElementById(connectFormId(row))?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  };

  /** The sheet's primary action when a connection is missing: open that row. */
  const openFirstMissingConnection = () => {
    const missing = providerRows().find((row) =>
      !candidatesFor(row.provider).some((connection) => connection.id === row.connectionId)
    );
    if (missing && connectingProvider() !== providerRowKey(missing)) toggleConnect(missing);
  };

  const renderConnectionRow = (row: ProviderConnectionRow) => {
    const choices = () => candidatesFor(row.provider);
    const selected = () => choices().find((connection) => connection.id === row.connectionId);
    const open = () => connectingProvider() === providerRowKey(row);
    return (
      <article
        class="iv-connection-row"
        data-testid="install-required-connection"
        data-provider-source={row.provider}
        data-module-local-name={row.moduleLocalName}
        data-child-alias={row.childAlias}
        data-connection-state={selected() ? "connected" : "missing"}
      >
        <div class="iv-connection-head">
          <strong>
            {providerDisplayName(row.provider)}
            {row.childAlias ? ` (${row.childAlias})` : ""}
          </strong>
          <Badge tone={selected() ? "ok" : "warn"}>
            {selected() ? t("installStore.connectionReady") : t("installStore.connectionMissing")}
          </Badge>
        </div>
        <Show
          when={choices().length > 1 || (choices().length === 1 && !selected())}
          fallback={
            <Show when={selected()}>
              {(connection) => (
                <p class="iv-connection-name">{providerConnectionDisplayName(connection())}</p>
              )}
            </Show>
          }
        >
          <FormField label={t("installStore.destination")} required>
            <Select
              value={row.connectionId}
              onChange={(event) => updateProviderRow(row, event.currentTarget.value)}
            >
              <option value="">{t("installStore.chooseConnection")}</option>
              <For each={choices()}>
                {(connection) => (
                  <option value={connection.id} selected={connection.id === row.connectionId}>
                    {providerConnectionDisplayName(connection)}
                  </option>
                )}
              </For>
            </Select>
          </FormField>
        </Show>
        <div class="iv-action-row">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<PlugZap size={16} />}
            aria-expanded={open()}
            aria-controls={connectFormId(row)}
            onClick={() => toggleConnect(row)}
          >
            {open()
              ? t("installStore.closePanel")
              : choices().length === 0
                ? t("installStore.connect")
                : t("installStore.addConnection")}
          </Button>
        </div>
        <Show when={connectionErrors()[providerRowKey(row)]}>
          {(message) => <p class="iv-muted" role="alert">{message()}</p>}
        </Show>
        <Show when={open() && workspaceId()}>
          <div class="iv-inline-connect" id={connectFormId(row)}>
            {/* The form reads the setup catalog; suspend here, not the whole
                page (which blanked the sheet and lost the scroll position). */}
            <Suspense fallback={<div role="status"><Spinner size={18} />{t("common.loading")}</div>}>
              <ConnectionCreateForm
                workspaceId={workspaceId()}
                initialProviderSource={row.provider}
                restrictToInitialProvider
                onCreated={(connection) => adoptRowConnection(row, connection.id)}
                verifyConnection={(connectionId) => verifyRowConnection(row, connectionId)}
              />
            </Suspense>
          </div>
        </Show>
      </article>
    );
  };

  const sectionError = () => (
    <Show when={error()}>
      {(message) => (
        <div class="iv-error" role="alert">
          {message()}
        </div>
      )}
    </Show>
  );

  const compatibilityBlocker = () => {
    const result = compatibility();
    return result && result.level !== "ready" ? result : undefined;
  };

  return (
    <>
      <Show when={hasInstallRecoveryLocator(location.search) && !busy()}>
        <main class="iv-page">
          <section
            class="iv-workbench iv-centered"
            data-testid="install-plan-recovery"
            // The internal coordinator phase stays machine-readable for
            // diagnostics and tests; the heading below is what a person reads.
            data-phase={(() => {
              const current = recovery();
              return current.status === "ready"
                ? current.response.installPlan.phase
                : undefined;
            })()}
          >
            <Show when={recovery().status === "loading"}>
              <Spinner size={24} />
              <h2>{t("common.loading")}</h2>
            </Show>
            <Show when={recovery().status === "unavailable"}>
              <h2>{t("installStore.recoveryUnverified")}</h2>
              <p>{t("installStore.recoveryUnverifiedHint")}</p>
              <div class="iv-action-row">
                <Button type="button" variant="secondary" onClick={() => {
                  const id = installRecoveryId(location.search);
                  if (id) void loadRecovery(id, currentWorkspaceId());
                }}>{t("common.retry")}</Button>
                <Button type="button" variant="ghost" onClick={clearRecovery}>
                  {t("installStore.chooseAnother")}
                </Button>
              </div>
            </Show>
            <Show when={recovery().status === "ready" ? recovery() as { status: "ready"; response: GitInstallPlanResponse } : undefined}>
              {(ready) => {
                const response = ready().response;
                const presentation = installRecoveryPresentation(response);
                return (
                  <>
                    <h2>{
                      presentation === "review" ? t("installStore.recoveryReview") :
                      presentation === "failed_run" ? t("installStore.recoveryFailedRun") :
                      presentation === "failed" ? t("installStore.recoveryFailed") :
                      presentation === "continue" ? t("installStore.recoveryContinue") :
                      t("installStore.recoveryUnverified")
                    }</h2>
                    <p>{
                      presentation === "review" ? t("installStore.recoveryReviewHint") :
                      presentation === "failed_run" ? t("installStore.recoveryFailedRunHint") :
                      presentation === "failed" ? t("installStore.recoveryFailedHint") :
                      presentation === "continue" ? t("installStore.recoveryContinueHint") :
                      t("installStore.recoveryUnverifiedHint")
                    }</p>
                    <Show when={response.installPlan.diagnostic?.message}>
                      {(message) => <p role="status">{message()}</p>}
                    </Show>
                    <div class="iv-action-row">
                      <Show when={presentation === "continue"}>
                        <Button type="button" variant="primary" busy={recoveryBusy()}
                          onClick={() => void continueRecovery()}>
                          {t("installStore.continue")}
                        </Button>
                      </Show>
                      <Show when={presentation === "review"}>
                        <Button variant="primary" href={`/runs/${encodeURIComponent(response.installPlan.planRunId!)}`}>
                          {t("installStore.stepReview")}
                        </Button>
                      </Show>
                      <Show when={presentation === "failed_run"}>
                        <Button variant="secondary" href={`/runs/${encodeURIComponent(response.installPlan.planRunId!)}`}>
                          {t("installStore.runDetails")}
                        </Button>
                      </Show>
                      <Button type="button" variant="ghost" onClick={clearRecovery}>
                        {t("installStore.chooseAnother")}
                      </Button>
                    </div>
                  </>
                );
              }}
            </Show>
          </section>
        </main>
      </Show>
      <Show when={!hasInstallRecoveryLocator(location.search) || busy()}>
    <main
      class="iv-page"
      data-install-state={uiState()}
      classList={{
        "iv-browse-page": phase() === "browse",
        "iv-configure-page": phase() === "configure",
      }}
    >
      <Show
        when={phase() !== "browse"}
        fallback={<header class="iv-hero iv-page-heading"><h1>{t("installStore.title")}</h1></header>}
      >
        <Show when={!(phase() === "done" && (lifecycleState() === "installed" || lifecycleState() === "uninstalling"))}>
        <header class="iv-app-detail" data-testid="install-app-header">
          <AppFace name={selectedTitle()} iconUrl={listing()?.iconUrl ?? storeEntry()?.iconUrl} class="iv-app-icon" />
          <div><h1>{selectedTitle() || t("common.loading")}</h1>
            <p>{selectedDescription()}</p>
            <Show when={gitUrl().trim()}>
              <p class="iv-provenance" data-testid="install-provenance">
                <span>{t("installStore.provenance")}</span>{" "}
                <code>{repositoryLabel(gitUrl())}</code>
                <Show when={versionLabel()}>
                  {(version) => <> · <code>{version()}</code></>}
                </Show>
              </p>
            </Show>
          </div>
        </header>
        </Show>
      </Show>

      <Show when={appHandoff()}>
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

      <Show when={phase() === "browse"}>{sectionError()}</Show>

      <Show when={sourceAutoSyncError()}>
        {(message) => (
          <aside class="iv-compat-warning" role="alert" data-testid="install-source-auto-sync-retry">
            <strong>{t("installStore.sourceAutoSyncFailed")}</strong>
            <p>{message()}</p>
            <Button type="button" variant="secondary" busy={sourceAutoSyncBusy()}
              onClick={() => void enableInstallSourceAutoSync(workspaceId())}>
              {t("common.retry")}
            </Button>
          </aside>
        )}
      </Show>

      <Show when={phase() === "browse"}>
        <section
          class="iv-catalogue iv-catalogue-browse"
          aria-label={t("installStore.browseTitle")}
        >
          <StoreBrowser
            locale={locale()}
            onConfigure={chooseListing}
            onSelectListing={chooseListing}
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
                aria-label={t("installStore.sourceUrl")}
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
          {sectionError()}
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
                      {moduleCandidateLabel(module)}
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
        <section class="iv-workbench iv-start" data-testid="install-start">
          {sectionError()}
          <Show when={compatibilityBlocker()}>
            {(result) => (
              <aside class="iv-compat-warning" role="alert">
                <Badge tone={compatibilityTone(result().level)}>
                  {compatibilityLabel(result().level)}
                </Badge>
                {/* The analyzer speaks English prose and may echo repository or
                    compiler text; the display helpers map typed codes to the
                    product's own localized explanation. Only diagnostics the
                    helpers cannot classify keep their raw text, folded. */}
                <p>{compatibilitySummaryDisplay(result())}</p>
                <For each={result().diagnostics}>
                  {(diagnostic) => {
                    const display = compatibilityDiagnosticDisplay(diagnostic);
                    return (
                      <Show
                        when={display.technical && display.detail}
                        fallback={
                          <p>
                            {display.message}
                            <Show when={display.detail}>
                              {(detail) => <span> {detail()}</span>}
                            </Show>
                          </p>
                        }
                      >
                        {(detail) => (
                          <details class="iv-advanced">
                            <summary>{display.message}</summary>
                            <p>{detail()}</p>
                          </details>
                        )}
                      </Show>
                    );
                  }}
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
            <div class="iv-action-row iv-start-actions">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                busy={busy()}
                icon={<PackagePlus size={18} />}
              >
                {t("installStore.install")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                icon={<ArrowLeft size={16} />}
                onClick={reset}
              >
                {t("installStore.back")}
              </Button>
            </div>
            <p class="iv-start-hint">{t("installStore.startHint")}</p>
            {/* The version is part of choosing what to install, so it is shown
                plainly. A module is chosen only when the repository's version
                defines more than one (the chooser after Install). */}
            <div class="iv-fields iv-source-fields" data-testid="install-source-fields">
              <Show when={!listing()}>
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
              </Show>
              <FormField
                label={t("installStore.sourceRef")}
                hint={listing() ? t("installStore.sourceRefStableHint") : t("installStore.sourceRefHint")}
              >
                <Input
                  value={gitRefResolvedFromListing() ? "" : gitRef()}
                  placeholder={listing() ? t("installStore.sourceRefStable") : undefined}
                  onInput={(event) => {
                    // A listing's reviewed module stays a hint for the new version.
                    resetPreparedSource({ preserveModuleSelection: listing() !== null });
                    setGitRefResolvedFromListing(false);
                    setGitRef(event.currentTarget.value);
                  }}
                  spellcheck={false}
                />
              </FormField>
              <Show when={!listing() && sourceCandidates().length > 0}>
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
          <p>
            {sourceFetchSlow()
              ? t("installStore.preparingFetching")
              : preparationStageHint()}
          </p>
          <Show when={preparationController()}>
            <Button
              type="button"
              variant="ghost"
              busy={discarding()}
              onClick={() => void discardAttempt()}
            >
              {t("common.cancel")}
            </Button>
          </Show>
        </section>
      </Show>

      <Show when={phase() === "setup"}>
        <section
          class="iv-workbench iv-sheet"
          data-testid="install-configuration"
          data-install-state={providerRowsReady() ? (setupError() ? "configuring" : "ready") : "provider-required"}
          aria-labelledby="iv-sheet-title"
        >
          <div class="iv-section-head">
            <h2 id="iv-sheet-title">{t("installStore.sheetTitle")}</h2>
            <p>{t("installStore.sheetHint")}</p>
          </div>
          {sectionError()}

          <section class="iv-sheet-block" aria-labelledby="iv-planned-title" data-testid="install-planned-resources">
            <h3 id="iv-planned-title">{t("installStore.plannedTitle")}</h3>
            <PlannedResources resources={compatibility()?.resources ?? []} />
            <p class="iv-muted">{t("installStore.plannedHint")}</p>
          </section>

          <Show when={providerRows().length > 0}>
            <section class="iv-sheet-block" aria-labelledby="iv-connections-title" data-testid="install-connections">
              <h3 id="iv-connections-title">{t("installStore.cloudConnection")}</h3>
              <p class="iv-muted">
                {providerRowsReady() ? t("installStore.cloudConnected") : t("installStore.providerHint")}
              </p>
              <For each={providerRows()}>{renderConnectionRow}</For>
            </section>
          </Show>

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
                        <div
                          class="iv-source-build-argv"
                          aria-label={t("installStore.sourceBuildArguments")}
                        >
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

          <section class="iv-sheet-block" aria-labelledby="iv-settings-title">
            <h3 id="iv-settings-title">{t("installStore.setupTitle")}</h3>
            <Show when={storeEntry()}>
              {(entry) => (
                <>
                  <Show when={entry().setupProjectionInvalid}>
                    <aside class="iv-setup-note" role="alert">
                      <strong>{t("installStore.setupUnavailableTitle")}</strong>
                      <p>{t("installStore.setupInvalid")}</p>
                    </aside>
                  </Show>
                  <Show
                    when={storeRequiresUnavailableSecretMaterialization(entry())}
                  >
                    <aside class="iv-setup-note" role="alert">
                      <strong>{t("installStore.secretSetupUnavailableTitle")}</strong>
                      <p>{t("installStore.secretUnavailable")}</p>
                    </aside>
                  </Show>
                  <Show when={visibleStoreInstallFeatures(entry()).length > 0}>
                    <section class="iv-feature-list">
                      <h4>{t("installStore.optionalFeatures")}</h4>
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
              <FormField label={t("installStore.name")} hint={t("installStore.nameHint")} required>
                <Input
                  value={name()}
                  onInput={(event) => updateName(event.currentTarget.value)}
                  spellcheck={false}
                />
              </FormField>
              <For each={visibleSetupFields().filter((field) => field.required)}>{renderSetupField}</For>
            </div>
            <Show when={visibleSetupFields().some((field) => !field.required)}>
              <div class="iv-optional-settings" data-testid="install-optional-settings">
                <h4>{t("installStore.optionalSettings")}</h4>
                <p class="iv-muted">{t("installStore.optionalSettingsHint")}</p>
                <div class="iv-fields">
                  <For each={visibleSetupFields().filter((field) => !field.required)}>{renderSetupField}</For>
                </div>
              </div>
            </Show>
          </section>

          <Show when={setupError()}>{(message) => <p class="iv-muted" role="status">{message()}</p>}</Show>
          <div class="iv-action-row">
            <Button
              type="button"
              variant="primary"
              size="lg"
              busy={busy()}
              disabled={discarding() || (providerRowsReady() && Boolean(setupError()))}
              onClick={() => {
                if (!providerRowsReady()) { openFirstMissingConnection(); return; }
                void preparePlan();
              }}
            >
              {providerRowsReady() ? t("installStore.reviewChanges") : t("installStore.connect")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              busy={discarding()}
              disabled={busy()}
              onClick={() => void discardAttempt()}
            >
              {t("installStore.discard")}
            </Button>
          </div>
        </section>
      </Show>

      <Show when={phase() === "review" && planRunId() && capsuleId()}>
        <section class="iv-workbench iv-sheet">
          {sectionError()}
          {autoSelectedDestinationSummary()}
          <InstallExecution
            planRunId={planRunId()!}
            capsuleId={capsuleId()!}
            onState={setExecutionState}
            onDone={() => void finishInstallation()}
            onRestart={() => restartFailedInstall()}
            onDiscard={() => discardAttempt()}
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
            {sectionError()}
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
                {t("installStore.manageApp")}
              </Button>
            </div>
          </Show>
        </section>
      </Show>

      <Show when={phase() === "done" && capsuleId() && !workspaceId()}>
        <section class="iv-workbench"><p role="status">{t("installStore.selectWorkspace")}</p><Button type="button" variant="secondary" onClick={reset}>{t("installStore.chooseAnother")}</Button></section>
      </Show>
      <Show when={phase() === "done" && capsuleId() && workspaceId()}>
        <Show when={error()}>
          <div class="iv-handoff-actions">{sectionError()}</div>
        </Show>
        <InstallLifecycle capsuleId={capsuleId()!} workspaceId={workspaceId()}
          onIdentity={(capsule, config) => { setName(capsule.name); setInstallConfig(config);
            if (!storeEntry()) setStoreEntry(storeEntryFromRepositoryConfig(config, { gitUrl: gitUrl(), name: capsule.name })); }}
          onLaunch={setInterfaceUrl}
          onState={setLifecycleState} principalId={props.installingPrincipalId}
          justInstalled={completedHere()} onChooseAnother={reset} />
        <Show when={appConnectHref()}>{(href) => <div class="iv-action-row iv-handoff-actions"><Button href={href()} variant="secondary">{appHandoff() ? t("run.appHandoff.open", { app: appHandoffProductLabel(appHandoff()!.product) }) : t("installStore.open")}</Button></div>}</Show>
      </Show>
    </main>
      </Show>
    </>
  );
}
