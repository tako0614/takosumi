import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js";
import { useLocation } from "@solidjs/router";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  PackagePlus,
  PlugZap,
} from "lucide-solid";
import {
  parseCapsuleSourceOptionsInstallLink,
  parseCapsuleSourceOptionsText,
  type JsonValue,
  type CapsuleSourceOption,
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
  createCapsule,
  createWorkspace,
  extractRunId,
  getInstallConfig,
  listConnections,
  listProviderConnections,
  planCapsule,
  putCapsuleProviderBindingSet,
  readSourceSnapshotFile,
  readSourceSnapshotPresentationFile,
  resolveStableSourceTag,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  type ProviderBindings,
  type ProviderConnection,
} from "../../lib/control-api.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import {
  capsuleNameFromUrl,
  hasInstallPrefillParams,
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
import { readSnapshotDocument } from "../../lib/snapshot-document.ts";
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
  preferredProviderConnection,
  providerConnectionDisplayName,
} from "../../lib/provider-connections.ts";
import { friendlyError } from "../../lib/error-copy.ts";
import { locale, t } from "../../i18n/index.ts";
import { fetchTcsListing, type TcsListing } from "../../lib/tcs-client.ts";
import {
  parseCompositionInstallLink,
  parseCompositionManifestText,
  type CapsuleCompositionComponent,
} from "../../lib/composition-manifest.ts";
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
  storeEntryFromStoreListing,
  storeInputIsDerived,
  storeInputJsonValue,
  storeInputKey,
  storeInputLabel,
  storeInputHelper,
  storePublicEndpoint,
  storePublicEndpointSubdomainField,
  storeInitialSecretField,
  storeSupportsOidc,
  defaultStoreAuthMode,
  storeInstallFeatures,
  storeFeatureInputs,
  storeFeatureLabel,
  storeFeatureInputNames,
  storeVariablePath,
  sourceBuildPreview,
  type ProviderConnectionRow,
  type StoreEntry,
  type StoreInputField,
  type StoreInstallFeature,
} from "./install-helpers.ts";
import InstallExecution from "./InstallExecution.tsx";
import "./install-view.css";

type Phase =
  | "browse"
  | "configure"
  | "entry-confirm"
  | "entry"
  | "preparing"
  | "connections"
  | "setup"
  | "review"
  | "done";

interface EntryChoice {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly source: {
    readonly url: string;
    readonly ref?: string;
    readonly path: string;
  };
}

interface EntryEvidence {
  readonly kind: "composition" | "source-options";
  readonly url: string;
  readonly requestedRef?: string;
  readonly resolvedTag?: string;
  readonly commit: string;
  readonly path: string;
  readonly digest: string;
  readonly sizeBytes?: number;
}

type ManagedPublicHostnameMode = "scoped" | "vanity";

function canonicalProviderSource(provider: string): string {
  const normalized = provider.toLowerCase().trim();
  return normalized.split("/").length === 2
    ? `registry.opentofu.org/${normalized}`
    : normalized;
}

function providerTail(provider: string): string {
  const normalized = canonicalProviderSource(provider);
  return normalized.split("/").at(-1) ?? normalized;
}

function sameProviderSource(required: string, connected: string): boolean {
  return (
    canonicalProviderSource(required) === canonicalProviderSource(connected)
  );
}

function rowsFromCompatibility(
  result: CapsuleCompatibilityResult,
): ProviderConnectionRow[] {
  return result.providers
    .filter(
      (provider) => provider.allowed && provider.credentialRequired === true,
    )
    .flatMap((provider) =>
      (provider.aliases.length > 0 ? provider.aliases : [""]).map(
        (childAlias) => ({
          provider: provider.source,
          moduleLocalName: provider.localName ?? providerTail(provider.source),
          childAlias,
          rootAlias: childAlias,
          connectionId: "",
          credentialRequired: true,
        }),
      ),
    );
}

export default function InstallView() {
  return <Page title={t("installStore.title")}>{() => <Inner />}</Page>;
}

function Inner() {
  const location = useLocation();
  const initial = parseInstallPrefill(location.search);
  const appHandoff = appHandoffFromSearch(location.search);
  const compositionEntry = () => parseCompositionInstallLink(location.search);
  const sourceOptionsEntry = () =>
    parseCapsuleSourceOptionsInstallLink(location.search);
  const externalDocument = () => compositionEntry() ?? sourceOptionsEntry();
  const initialExternalDocument = externalDocument();
  const [phase, setPhase] = createSignal<Phase>(
    initialExternalDocument
      ? "entry-confirm"
      : hasInstallPrefillParams(location.search)
        ? "configure"
        : "browse",
  );
  const [listing, setListing] = createSignal<TcsListing | null>(null);
  const [gitUrl, setGitUrl] = createSignal(initial?.git ?? "");
  // Keep the authoritative ref exactly as supplied. Full commit refs are
  // immutable evidence; shortening them for an input display changes the
  // Source/compatibility request and can select a different commit.
  const [gitRef, setGitRef] = createSignal(initial?.ref ?? "");
  const [modulePath, setModulePath] = createSignal(initial?.path || ".");
  const [name, setName] = createSignal(
    initial?.name ?? (initial?.git ? capsuleNameFromUrl(initial.git) : ""),
  );
  const [workspaceId, setWorkspaceId] = createSignal(currentWorkspaceId());
  const [workspaceHandle, setWorkspaceHandle] = createSignal<string>();
  const [sourceId, setSourceId] = createSignal<string>();
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
  const [storeAuthMode, setStoreAuthMode] = createSignal<"oidc" | "password">(
    "oidc",
  );
  const [storeFeatureSelections, setStoreFeatureSelections] = createSignal<
    Record<string, boolean>
  >({});
  const [managedPublicHostnameMode, setManagedPublicHostnameMode] =
    createSignal<ManagedPublicHostnameMode>("scoped");
  const [capsuleId, setCapsuleId] = createSignal<string>();
  const [planRunId, setPlanRunId] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [entryChoices, setEntryChoices] = createSignal<readonly EntryChoice[]>(
    [],
  );
  const [entryTitle, setEntryTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [entryEvidence, setEntryEvidence] = createSignal<EntryEvidence>();
  const [interfaceUrl, setInterfaceUrl] = createSignal<string>();

  const selectedTitle = createMemo(() => {
    const selected = listing();
    return selected
      ? localizedStoreText(selected.name, selected.suggestedName)[locale()]
      : name() || capsuleNameFromUrl(gitUrl());
  });

  const sourceCandidates = () =>
    sourceConnections().filter(
      (connection) =>
        connection.scope === "workspace" &&
        connection.status === "verified" &&
        (connection.kind === "source_git_https_token" ||
          connection.kind === "source_git_ssh_key"),
    );

  const candidatesFor = (provider: string) =>
    providerConnections().filter(
      (connection) =>
        isProviderConnectionCandidate(connection) &&
        sameProviderSource(provider, connection.providerSource),
    );

  const providerRowsReady = () =>
    providerRows().every((row) =>
      candidatesFor(row.provider).some(
        (connection) => connection.id === row.connectionId,
      ),
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
    (!storeSupportsOidc(entry) && Boolean(storeInitialSecretField(entry))) ||
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
    const initialSecret = storeInitialSecretField(entry);
    if (initialSecret?.name === field.name) {
      return storeAuthMode() === "password";
    }
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
        storePublicEndpoint(entry)?.baseDomain,
        managedPublicHostnameMode(),
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
    const selected = currentWorkspaceId();
    if (selected && selected !== workspaceId()) setWorkspaceId(selected);
    if (workspaceId()) {
      if (!workspaceHandle()) {
        const workspaces = await listWorkspacesCached();
        setWorkspaceHandle(
          workspaces.find((workspace) => workspace.id === workspaceId())
            ?.handle,
        );
      }
      return workspaceId();
    }
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
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    return workspace.id;
  };

  const loadConnections = async (workspace: string) => {
    const [all, providers] = await Promise.all([
      listConnections(workspace),
      listProviderConnections(workspace),
    ]);
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
    try {
      const parsed = new URL(gitUrl().trim());
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        return t("installStore.invalidSource");
      }
    } catch {
      return t("installStore.invalidSource");
    }
    if (!CAPSULE_NAME_PATTERN.test(name().trim())) {
      return t("installStore.invalidName");
    }
    return undefined;
  };

  const resetPreparedSource = () => {
    setSourceId(undefined);
    setCompatibility(undefined);
    setInstallConfig(undefined);
    setStoreEntry(undefined);
    setStoreValues({});
    setStoreInputTouched({});
    setStoreFeatureSelections({});
    setProviderRows([]);
    setCapsuleId(undefined);
    setPlanRunId(undefined);
    setInterfaceUrl(undefined);
  };

  // Header workspace changes are reactive. Never let a previously prepared
  // Source/Capsule/Plan continue writing under the old workspace.
  let observedWorkspaceId = workspaceId();
  createEffect(() => {
    // Auth/session routing can hydrate the query after this lazy view is first
    // constructed. Keep the chooser selector reactive, while never sending a
    // user back after the exact document has already been loaded.
    if (
      externalDocument() &&
      !entryEvidence() &&
      !listing() &&
      (phase() === "browse" || phase() === "configure")
    ) {
      setPhase("entry-confirm");
    }
  });
  createEffect(() => {
    const selected = currentWorkspaceId();
    if (selected === observedWorkspaceId) return;
    observedWorkspaceId = selected;
    setWorkspaceId(selected);
    setWorkspaceHandle(undefined);
    setSourceConnections([]);
    setProviderConnections([]);
    resetPreparedSource();
    setError(undefined);
    setPhase(listing() || gitUrl() ? "configure" : "browse");
  });

  const chooseListing = (selected: TcsListing) => {
    resetPreparedSource();
    setListing(selected);
    setGitUrl(selected.source.url);
    setGitRef("");
    setModulePath(".");
    setName(slugInputValue(selected.suggestedName));
    setSourceAuthConnectionId("");
    setEntryEvidence(undefined);
    setError(undefined);
    setPhase("configure");
  };

  const updateProviderRow = (
    target: ProviderConnectionRow,
    connectionId: string,
  ) =>
    setProviderRows((rows) =>
      rows.map((row) =>
        row.provider === target.provider &&
        row.moduleLocalName === target.moduleLocalName &&
        row.childAlias === target.childAlias
          ? { ...row, connectionId }
          : row,
      ),
    );

  const prepareInstall = async () => {
    const validation = validateBasic();
    if (validation) {
      setError(validation);
      return;
    }
    // “Add” responds immediately. Repository and provider analysis belongs to
    // the requested operation, never to the button's enabled state.
    setPhase("preparing");
    setBusy(true);
    setError(undefined);
    try {
      const workspace = await ensureWorkspace();
      if (!workspaceIsCurrent(workspace)) return;
      const providers = await loadConnections(workspace);
      if (!workspaceIsCurrent(workspace)) return;
      const result = await checkCapsuleCompatibility({
        workspaceId: workspace,
        sourceId: sourceId(),
        gitUrl: gitUrl().trim(),
        ref: gitRef().trim(),
        path: listing() ? "." : modulePath().trim() || ".",
        name: name().trim(),
        ...(sourceAuthConnectionId()
          ? { authConnectionId: sourceAuthConnectionId() }
          : {}),
        ...(!listing()
          ? { installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID }
          : {}),
        compileInstallUx: listing() !== null,
        onSourceCreated: (createdSourceId) => {
          if (workspaceIsCurrent(workspace)) setSourceId(createdSourceId);
        },
      });
      if (!workspaceIsCurrent(workspace)) return;
      setCompatibility(result);
      // Compatibility is a hard gate. A report that needs a patch is not
      // executable merely because the endpoint returned 200; stop before any
      // InstallConfig/Capsule creation and show its diagnostics to the user.
      if (result.level !== "ready") {
        setError(result.summary || t("installStore.compatibilityFailed"));
        setPhase("configure");
        return;
      }
      const configId =
        result.repositoryInstallUx?.status === "accepted"
          ? result.repositoryInstallUx.installConfigId
          : (result.installConfigId ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID);
      const config = await getInstallConfig(configId);
      if (!workspaceIsCurrent(workspace)) return;
      setInstallConfig(config);
      const selectedListing = listing();
      const entry = selectedListing
        ? storeEntryFromStoreListing(selectedListing, config)
        : undefined;
      setStoreEntry(entry);
      setStoreAuthMode(
        entry ? (defaultStoreAuthMode(entry) ?? "oidc") : "oidc",
      );
      setManagedPublicHostnameMode("scoped");
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
      const rows = rowsFromCompatibility(result).map((row) => {
        const matches = providers.filter(
          (connection) =>
            isProviderConnectionCandidate(connection) &&
            sameProviderSource(row.provider, connection.providerSource),
        );
        const preferred = preferredProviderConnection(matches);
        return preferred
          ? { ...row, connectionId: preferred.id }
          : row;
      });
      setProviderRows(rows);
      if (
        rows.some(
          (row) =>
            !providers.some(
              (connection) =>
                isProviderConnectionCandidate(connection) &&
                sameProviderSource(row.provider, connection.providerSource) &&
                connection.id === row.connectionId,
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
        await preparePlan(workspace, result, config, rows, undefined);
      }
    } catch (cause) {
      setError(friendlyError(cause, t).message);
      setPhase("configure");
    } finally {
      setBusy(false);
    }
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
    if (
      rows.some(
        (row) =>
          !candidatesFor(row.provider).some(
            (connection) => connection.id === row.connectionId,
          ),
      )
    ) {
      setPhase("connections");
      return;
    }
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
          ...(modulePath().trim() && modulePath().trim() !== "."
            ? { modulePath: modulePath().trim() }
            : {}),
          ...(vars ? { vars } : {}),
          ...(Object.keys(config.outputAllowlist).length > 0
            ? { outputAllowlist: config.outputAllowlist }
            : {}),
          ...(storeEntry() && storePublicEndpoint(storeEntry()!)
            ? { managedPublicHostname: { mode: managedPublicHostnameMode() } }
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

  const chooseEntry = async (choice: EntryChoice) => {
    setBusy(true);
    setError(undefined);
    try {
      let ref = choice.source.ref ?? "";
      if (!ref) {
        const workspace = await ensureWorkspace();
        if (!workspaceIsCurrent(workspace)) return;
        const resolved = await resolveStableSourceTag(
          workspace,
          choice.source.url,
        );
        if (!workspaceIsCurrent(workspace)) return;
        ref = resolved.commit;
      }
      // Selecting a component is the explicit action that may create a
      // Workspace when the visitor has none. The chooser itself never does.
      resetPreparedSource();
      setListing(null);
      setGitUrl(choice.source.url);
      setGitRef(ref);
      setModulePath(choice.source.path || ".");
      setName(slugInputValue(choice.id));
      setSourceAuthConnectionId("");
      setPhase("configure");
    } catch (cause) {
      setError(friendlyError(cause, t).message);
    } finally {
      setBusy(false);
    }
  };

  const loadExternalEntry = async () => {
    const tcs = parseInitialTcsHandoff(location.search);
    const composition = parseCompositionInstallLink(location.search);
    const options = parseCapsuleSourceOptionsInstallLink(location.search);
    if (!tcs && !composition && !options) return;
    setPhase("preparing");
    setBusy(true);
    try {
      if (tcs) {
        const selected = await fetchTcsListing(tcs.base, tcs.listingId);
        if (!selected) throw new Error(t("installStore.listingUnavailable"));
        chooseListing(selected);
        return;
      }
      // Reading the immutable chooser document may use the already selected
      // Workspace, but opening the link must never create one. Creation is
      // reserved for the explicit component/service Add action.
      const workspace = currentWorkspaceId();
      if (!workspace) {
        throw new Error(t("workspace.selectMessage"));
      }
      setWorkspaceId(workspace);
      if (composition) {
        const { file, commit, resolvedTag } = await readSnapshotDocument({
          workspaceId: workspace,
          namePrefix: "composition",
          git: composition.git,
          ref: composition.ref,
          path: composition.path,
          read: readSourceSnapshotFile,
        });
        if (!workspaceIsCurrent(workspace)) return;
        const loaded = await parseCompositionManifestText(file.text);
        setEntryEvidence({
          kind: "composition",
          url: composition.git,
          requestedRef: composition.ref,
          ...(resolvedTag ? { resolvedTag } : {}),
          commit,
          path: composition.path,
          digest: loaded.digest,
        });
        setEntryTitle(loaded.manifest.metadata.title);
        setEntryChoices(
          loaded.manifest.components.map(
            (component: CapsuleCompositionComponent) => ({
              id: component.id,
              title: component.title,
              ...(component.description
                ? { description: component.description }
                : {}),
              source: component.source,
            }),
          ),
        );
      } else if (options) {
        const { file, commit, resolvedTag } = await readSnapshotDocument({
          workspaceId: workspace,
          namePrefix: "options",
          git: options.git,
          ref: options.ref,
          path: options.path,
          read: readSourceSnapshotPresentationFile,
        });
        if (!workspaceIsCurrent(workspace)) return;
        const parsed = parseCapsuleSourceOptionsText(file.text);
        if (!parsed.ok) throw new Error(parsed.error);
        setEntryEvidence({
          kind: "source-options",
          url: options.git,
          ...(options.ref ? { requestedRef: options.ref } : {}),
          ...(resolvedTag ? { resolvedTag } : {}),
          commit,
          path: options.path,
          digest: file.digest,
          sizeBytes: file.sizeBytes,
        });
        setEntryTitle(parsed.document.metadata.title);
        setEntryChoices(
          parsed.document.options.map((option: CapsuleSourceOption) => ({
            id: option.id,
            title: option.title,
            ...(option.description ? { description: option.description } : {}),
            source: option.source,
          })),
        );
      }
      setPhase("entry");
    } catch (cause) {
      setError(friendlyError(cause, t).message);
      setPhase(composition || options ? "entry-confirm" : "browse");
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setListing(null);
    setGitUrl("");
    setGitRef("");
    setModulePath(".");
    setName("");
    setSourceId(undefined);
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
    setEntryEvidence(undefined);
    setInterfaceUrl(undefined);
    setError(undefined);
    setPhase("browse");
  };

  onMount(() => {
    // TCS discovery is a read-only listing lookup. Repository chooser
    // documents are different: reading one creates a Source and sync Run, so
    // that work is reserved for the explicit confirmation button below.
    if (parseInitialTcsHandoff(location.search)) void loadExternalEntry();
  });

  const sourceReturnPath = () =>
    appendAppHandoff(
      installReturnPathFromPrefill({
        git: gitUrl(),
        ref: gitRef(),
        path: modulePath(),
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

  const evidenceRef = (evidence: EntryEvidence): string =>
    evidence.requestedRef ?? evidence.resolvedTag ?? evidence.commit;

  const finishInstallation = async () => {
    setPhase("done");
    setInterfaceUrl(undefined);
    const workspace = currentWorkspaceId();
    const capsule = capsuleId();
    if (!workspace || !capsule || !workspaceIsCurrent(workspace)) return;
    try {
      const surfaces = await listAuthorizedUiSurfaces(workspace, {
        capsuleId: capsule,
      });
      if (workspaceIsCurrent(workspace)) setInterfaceUrl(surfaces[0]?.url);
    } catch {
      // The service detail link remains the safe completion target when the
      // Interface projection is still settling or unavailable.
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
            phase() !== "entry-confirm" &&
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

      <Show when={phase() === "entry-confirm" && externalDocument()}>
        <section class="iv-workbench">
          <Button
            type="button"
            variant="ghost"
            icon={<ArrowLeft size={16} />}
            onClick={reset}
          >
            {t("installStore.back")}
          </Button>
          <div class="iv-section-head">
            <h2>{t("installStore.entryLoadTitle")}</h2>
            <p>{t("installStore.entryLoadHint")}</p>
          </div>
          <aside class="iv-source-evidence" role="note">
            <strong>
              {compositionEntry() ? "Composition" : "CapsuleSourceOptions"}
            </strong>
            <p>
              <code>{externalDocument()?.git}</code>
            </p>
            <p>
              ref{" "}
              <code>{externalDocument()?.ref ?? "latest stable SemVer"}</code> ·
              file <code>{externalDocument()?.path}</code>
            </p>
          </aside>
          <Button
            type="button"
            variant="primary"
            size="lg"
            busy={busy()}
            onClick={() => void loadExternalEntry()}
          >
            {t("installStore.entryLoad")}
          </Button>
        </section>
      </Show>

      <Show when={phase() === "entry"}>
        <section class="iv-workbench">
          <Button
            type="button"
            variant="ghost"
            icon={<ArrowLeft size={16} />}
            onClick={reset}
          >
            {t("installStore.back")}
          </Button>
          <div class="iv-section-head">
            <h2>{entryTitle()}</h2>
            <p>{t("installStore.entryHint")}</p>
          </div>
          <Show when={entryEvidence()}>
            {(evidence) => (
              <aside class="iv-source-evidence" role="note">
                <strong>Immutable source evidence</strong>
                <p>
                  <code>{evidence().url}</code> @{" "}
                  <code>{evidenceRef(evidence())}</code>
                </p>
                <p>
                  commit <code>{evidence().commit}</code> · file{" "}
                  <code>{evidence().path}</code>
                </p>
                <p>
                  digest <code>{evidence().digest}</code>
                  <Show when={evidence().sizeBytes !== undefined}>
                    {" "}
                    ({evidence().sizeBytes} bytes)
                  </Show>
                </p>
                <p>Only the explicitly selected source below will be added.</p>
              </aside>
            )}
          </Show>
          <div class="iv-entry-grid">
            <For each={entryChoices()}>
              {(choice) => (
                <article class="iv-entry-card">
                  <div>
                    <h3>{choice.title}</h3>
                    <Show when={choice.description}>
                      <p>{choice.description}</p>
                    </Show>
                    <code>{choice.source.url}</code>
                  </div>
                  <Button
                    type="button"
                    variant="primary"
                    busy={busy()}
                    icon={<ChevronRight size={16} />}
                    onClick={() => void chooseEntry(choice)}
                  >
                    {t("installStore.select")}
                  </Button>
                </article>
              )}
            </For>
          </div>
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
          <Show when={entryEvidence()}>
            {(evidence) => (
              <aside class="iv-source-evidence" role="note">
                <strong>Source evidence retained from the chooser</strong>
                <p>
                  <code>{evidence().url}</code> @{" "}
                  <code>{evidenceRef(evidence())}</code>
                </p>
                <p>
                  immutable commit <code>{evidence().commit}</code> · path{" "}
                  <code>{evidence().path}</code>
                </p>
                <p>Review this evidence before adding the selected service.</p>
              </aside>
            )}
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
                  resetPreparedSource();
                  setName(event.currentTarget.value);
                }}
              />
            </FormField>
            <Show when={!listing()}>
              <details class="iv-advanced" open>
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
                      value={modulePath()}
                      onInput={(event) => {
                        resetPreparedSource();
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
          <p>{t("installStore.preparingHint")}</p>
        </section>
      </Show>

      <Show when={phase() === "connections"}>
        <section class="iv-workbench">
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
                          <option value={connection.id}>
                            {providerConnectionDisplayName(connection)}
                          </option>
                        )}
                      </For>
                    </Select>
                  </FormField>
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
                <Show when={storeSupportsOidc(entry())}>
                  <aside class="iv-setup-note" role="status">
                    <strong>Takosumi account sign-in</strong>
                    <p>
                      This service uses its declared OIDC client projection. No
                      password is sent as a Capsule variable.
                    </p>
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
                <Show when={storePublicEndpoint(entry())}>
                  <FormField
                    label="Managed hostname"
                    hint="The selected mode is passed to the service-owned public endpoint allocation."
                  >
                    <Select
                      value={managedPublicHostnameMode()}
                      onChange={(event) => {
                        setManagedPublicHostnameMode(
                          event.currentTarget
                            .value as ManagedPublicHostnameMode,
                        );
                        setCapsuleId(undefined);
                        setPlanRunId(undefined);
                      }}
                    >
                      <option value="scoped">Workspace-scoped hostname</option>
                      <option value="vanity">Vanity hostname</option>
                    </Select>
                  </FormField>
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
          <InstallExecution
            planRunId={planRunId()!}
            capsuleId={capsuleId()!}
            onDone={() => void finishInstallation()}
          />
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
