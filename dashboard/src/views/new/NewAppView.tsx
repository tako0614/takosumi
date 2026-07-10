/**
 * Add a service (`/new`) — app discovery first for normal users, explicit
 * install links / Git sources second, one underlying flow.
 *
 * Three entry shapes, identical install path:
 *   - Link/source import: the primary path for app install links or raw Git
 *     URLs, including services that are not in the store.
 *   - Store listings: a selected store node announces a Git repository and
 *     presentation metadata. Picking one pre-fills the same Git-backed flow.
 *   - External install link: another site links `/install?git=…` (or the
 *     packed `?source=git::…` form); the router forwards the query here and
 *     lib/install-link.ts pre-fills the Git form. A link only PRE-FILLS — the
 *     summary states the provenance and the visitor still confirms in this
 *     client (compatibility check → explicit add). No worker-side handling.
 *
 * The flow registers/fetches the Source, checks compatibility, reviews
 * Provider Connections, creates the current service record, and opens the first
 * change review. Technical progress stays available without dominating the
 * normal hosted-service UX.
 */
import "../../styles/wave-b.css";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Cloud,
  Download,
  Globe2,
  HardDrive,
  KeyRound,
  Search,
  Plus,
  Trash,
} from "lucide-solid";
import {
  installExperienceInitialSecret,
  installExperiencePublicEndpoint,
  installExperienceServiceNameVariable,
  type JsonValue,
} from "takosumi-contract";
import { isCredentialFreeUtilityProvider } from "takosumi-contract/provider-env-rules";
import Page from "../account/components/auth/Page.tsx";
import {
  currentWorkspaceId,
  setCurrentWorkspaceId,
} from "../../lib/workspace-state.ts";
import {
  capsuleNameFromUrl,
  hasInstallPrefillParams,
  type InstallPrefill,
  isSafeInstallVariableName,
  isSafeInstallVariableValue,
  parseInstallPrefill,
  parseInstallPrefillFromInput,
} from "../../lib/install-link.ts";
import {
  installReturnPathFromPrefill,
  providerConnectionsHrefForInstallReturn,
} from "../../lib/install-return-context.ts";
import {
  appendAppHandoff,
  appHandoffFromSearch,
  appHandoffProductLabel,
} from "../../lib/app-handoff.ts";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  createCapsule,
  createWorkspace,
  createSourceHttpsTokenConnection,
  createSource,
  extractRunId,
  listCapsules,
  type CapsuleProviderConnectionBindings,
  type Capsule,
  type CapsuleCompatibilityDiagnostic,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  listProviderConnections,
  listConnections,
  planCapsule,
  putCapsuleProviderConnectionSet,
  syncSource,
  testConnection,
  waitForLatestSourceSnapshot,
  type CapsuleCompatibilityProvider,
  type Connection,
  type ProviderConnection,
  type RunStatus,
  type Workspace,
} from "../../lib/control-api.ts";
import { locale, t } from "../../i18n/index.ts";
import { StoreBrowser } from "../store/StoreBrowser.tsx";
import { buildNewQuery } from "../store/store-link.ts";
import {
  fetchTcsListing,
  hydrateRequiredTcsListingWithRepoMetadata,
  type TcsListing,
} from "../../lib/tcs-client.ts";
import {
  clearCapsuleListCache,
  listCapsulesCached,
} from "../../lib/capsule-list.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { listInstallConfigsCached } from "../../lib/install-config-list.ts";
import { listWorkspacesCached } from "../../lib/workspace-list.ts";
import {
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  Select,
  Toast,
  type Tone,
} from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";

import {
  type StepState,
  type FlowRun,
  type SourceAccessMode,
  type ProviderConnectionRow,
  type InputVariableRow,
  type EnvVariableRow,
  type StoreMetadata,
  type StoreEntry,
  type StoreInputField,
  DEFAULT_STORE_BADGE,
  INSTALLATION_NAME_PATTERN,
  INSTALLATION_DONE,
  compatibilityTone,
  compatibilityLabel,
  providerNameFromDiagnostic,
  providerDisplayName,
  compatibilityDiagnosticDisplay,
  compatibilitySummaryDisplay,
  compatibilityCheckLooksTransient,
  abortableDelay,
  sourceFetchErrorMessage,
  safeControlApiErrorMessage,
  addFlowErrorMessage,
  shouldShowCompatibilityPanel,
  isFullCommitSha,
  refInputValue,
  displayRef,
  sourceHostLabel,
  displayModulePath,
  normalizeGitUrl,
  sameGitUrl,
  normalizeSourcePath,
  slugInputValue,
  uniqueServiceIdCandidate,
  managedServiceLabel,
  publicEndpointHost,
  hostIsManagedBaseDomainSubdomain,
  isManagedSubdomainLabel,
  isSha256Hex,
  storeInputKey,
  storePublicEndpoint,
  storeEndpointField,
  storePublicEndpointSubdomainField,
  storeServiceNameVariable,
  storeServiceNameField,
  isStorePublicEndpointField,
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  storeDefaultInputValue,
  serviceNameHintIsGenerated,
  storeVariablePath,
  isSafeStoreVariablePathSegment,
  storeInputJsonValue,
  parseStoreJsonValue,
  isSafeStoreJsonValue,
  setStoreJsonVariable,
  isJsonRecord,
  installVariableDisplayValue,
  routePatternFromAppUrl,
  managedBaseDomain,
  inputVariableRowsFromPrefill,
  envVariableRowsFromPrefill,
  isSafePlainEnvName,
  storeKindFromStoreListing,
  storeSurfaceFromStoreListing,
  safeStoreToken,
  nonEmptyStoreText,
  storeMetadataFromStoreListing,
  storeEntryIdFromStoreListing,
  storeEntryFromStoreListing,
  sourceIdFromControlError,
  isDuplicateServiceError,
  runStatusLabel,
  isAbortError,
  defaultWorkspaceHandle,
  parseInitialTcsHandoff,
  initialAddTab,
} from "./install-helpers.ts";

/**
 * Well-known credential-free OpenTofu provider tails (short name / local name)
 * that are NOT a credential boundary, so an install must not force a Provider
 * Connection for them. `isCredentialFreeUtilityProvider` already covers the
 * canonical http / random / tls; this set adds the other common credential-free
 * providers and matches bare local-name declarations (e.g. `null`, `local`).
 */
const CREDENTIAL_FREE_PROVIDER_TAILS: ReadonlySet<string> = new Set([
  "http",
  "random",
  "tls",
  "null",
  "local",
  "time",
  "external",
  "archive",
  "cloudinit",
  "template",
]);

function StoreIcon(props: { readonly entry: StoreEntry }) {
  if (props.entry.iconUrl) {
    return <img src={props.entry.iconUrl} alt="" loading="lazy" />;
  }
  switch (props.entry.kind) {
    case "worker":
      return <Cloud size={20} />;
    case "site":
      return <Globe2 size={20} />;
    case "storage":
      return <HardDrive size={20} />;
  }
}

export default function NewAppView() {
  return <Page title={t("new.title")}>{() => <Inner />}</Page>;
}

function NoWorkspaceStartPanel(props: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCreate: () => void;
}) {
  return (
    <section class="av-start" aria-label={t("workspace.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("workspace.start.kicker")}</span>
        <h2 class="av-start-title">{t("workspace.start.title")}</h2>
        <p class="av-start-sub">{t("workspace.start.body")}</p>
      </div>
      <Button
        variant="primary"
        type="button"
        busy={props.busy}
        icon={<Plus size={18} />}
        onClick={props.onCreate}
      >
        {props.busy
          ? t("workspace.start.creating")
          : t("workspace.start.create")}
      </Button>
      <Show when={props.error}>
        {(message) => <Toast tone="error">{message()}</Toast>}
      </Show>
    </section>
  );
}

function Inner() {
  const navigate = useNavigate();

  // External install link (client-handled): another site links
  // `/install?git=…` (or the packed `?source=git::…` form), the router
  // forwards the query here, and the parser pre-fills the Git form. A link only
  // PRE-FILLS — the visitor still confirms in this client (compatibility
  // check, then the explicit add button).
  const initialSearch = typeof location === "undefined" ? "" : location.search;
  const appHandoff = appHandoffFromSearch(initialSearch);
  const initialTcsHandoff = parseInitialTcsHandoff(initialSearch);
  // ストア[追加]: `?auto=1` asks this flow to start the single install action
  // itself once prerequisites settle (workspace, install config, store
  // hydration). Blockers still stop it — auto never bypasses a review.
  //
  // Auto-start is gated on a genuine store handoff (tcsBase/tcsListing). The
  // in-app store CTA always carries one; an EXTERNAL link (`/install?git=…` or a
  // hand-crafted `/new?git=…&auto=1`) carries only a raw git URL, and those must
  // stay pre-fill only — never silently register + deploy an attacker-chosen
  // repo into the user's workspace without an explicit Add click.
  const autoInstallRequested =
    new URLSearchParams(initialSearch).get("auto") === "1" &&
    initialTcsHandoff !== null;
  const initialInstallPrefill =
    typeof location === "undefined"
      ? undefined
      : parseInstallPrefill(initialSearch);
  const installPrefillRejected =
    typeof location !== "undefined" &&
    !initialInstallPrefill &&
    hasInstallPrefillParams(initialSearch);
  const [linkDraft, setLinkDraft] = createSignal(
    initialInstallPrefill?.git ?? "",
  );

  // `/new` opens the install-link form. External `/install?git=…` redirects and
  // Store hand-offs (`?tcsBase=…&tcsListing=…`) seed the same Git-backed flow.
  const [activeTab, setActiveTab] = createSignal<"store" | "git">(
    initialAddTab(initialSearch),
  );
  const [selectedStoreListing, setSelectedStoreListing] =
    createSignal<TcsListing | null>(null);
  const [storeMetadataUnavailable, setStoreMetadataUnavailable] =
    createSignal(false);
  const [storeInputValues, setStoreInputValues] = createSignal<
    Readonly<Record<string, string>>
  >({});
  const [storeInputTouched, setStoreInputTouched] = createSignal<
    Readonly<Record<string, boolean>>
  >({});
  const [activeInstallPrefill, setActiveInstallPrefill] =
    createSignal<InstallPrefill | null>(initialInstallPrefill ?? null);
  const initialRef = initialInstallPrefill?.ref ?? "";
  const [gitUrl, setGitUrl] = createSignal(initialInstallPrefill?.git ?? "");
  const [ref, setRef] = createSignal(refInputValue(initialRef));
  const [pinnedFullRef, setPinnedFullRef] = createSignal<string | null>(
    isFullCommitSha(initialRef) ? initialRef : null,
  );
  const [path, setPath] = createSignal(initialInstallPrefill?.path || ".");
  const [sourceAccessMode, setSourceAccessMode] =
    createSignal<SourceAccessMode>("public");
  const [sourceAuthConnectionId, setSourceAuthConnectionId] = createSignal("");
  const [sourceTokenUsername, setSourceTokenUsername] = createSignal("git");
  const [sourceToken, setSourceToken] = createSignal("");
  const [savingSourceToken, setSavingSourceToken] = createSignal(false);
  const [sourceTokenError, setSourceTokenError] = createSignal<string | null>(
    null,
  );
  const initialName = initialInstallPrefill
    ? (initialInstallPrefill.name ??
      capsuleNameFromUrl(initialInstallPrefill.git))
    : "";
  const [name, setName] = createSignal(initialName);
  const [resourcePrefix, setResourcePrefix] = createSignal("");
  const [resourcePrefixTouched, setResourcePrefixTouched] = createSignal(false);
  const [inputVariables, setInputVariables] = createSignal<
    readonly InputVariableRow[]
  >(inputVariableRowsFromPrefill(initialInstallPrefill?.vars));
  const [envVariables, setEnvVariables] = createSignal<
    readonly EnvVariableRow[]
  >(envVariableRowsFromPrefill(initialInstallPrefill?.vars));
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [appHostnameConflict, setAppHostnameConflict] = createSignal(false);
  const [providerRows, setProviderRows] = createSignal<ProviderConnectionRow[]>(
    [],
  );
  let serviceNameInput: HTMLInputElement | undefined;

  const workspaceId = () =>
    currentWorkspaceId() ? currentWorkspaceId() : null;
  const [workspaceList] = createResource(
    () => workspaceId() ?? undefined,
    (selectedWorkspaceId) => listWorkspacesCached({ selectedWorkspaceId }),
  );
  const workspaceHandle = (): string | undefined => {
    const current = workspaceId();
    return (
      workspaceList()?.find((workspace) => workspace.id === current)?.handle ||
      undefined
    );
  };
  const shouldLoadInstallConfigs = () => {
    const id = workspaceId();
    if (!id) return null;
    if (activeTab() === "git") return id;
    if (gitUrl().trim() || activeInstallPrefill() || selectedStoreListing()) {
      return id;
    }
    return null;
  };
  const [installConfigs, { refetch: refetchInstallConfigs }] = createResource(
    shouldLoadInstallConfigs,
    (id) => listInstallConfigsCached(id),
  );
  const [connections, setConnections] = createSignal<
    readonly Connection[] | null
  >(null);
  const [providerConnections, setProviderConnections] = createSignal<
    readonly ProviderConnection[] | null
  >(null);
  let loadedWorkspaceId: string | null = null;
  let connectionsPromise: Promise<readonly Connection[]> | null = null;
  let providerConnectionsPromise: Promise<
    readonly ProviderConnection[]
  > | null = null;

  const resetLazyWorkspaceData = () => {
    connectionsPromise = null;
    providerConnectionsPromise = null;
    setConnections(null);
    setProviderConnections(null);
  };

  const loadConnections = async (
    options: { readonly force?: boolean } = {},
  ): Promise<readonly Connection[]> => {
    const current = workspaceId();
    if (!current) {
      setConnections(null);
      return [];
    }
    const cached = connections();
    if (!options.force && cached) return cached;
    if (!options.force && connectionsPromise) return connectionsPromise;
    const request = listConnections(current)
      .then((items) => {
        if (workspaceId() === current) setConnections(items);
        return items;
      })
      .finally(() => {
        if (connectionsPromise === request) connectionsPromise = null;
      });
    connectionsPromise = request;
    return request;
  };

  const loadProviderConnections = async (
    options: { readonly force?: boolean } = {},
  ): Promise<readonly ProviderConnection[]> => {
    const current = workspaceId();
    if (!current) {
      setProviderConnections(null);
      return [];
    }
    const cached = providerConnections();
    if (!options.force && cached) return cached;
    if (!options.force && providerConnectionsPromise) {
      return providerConnectionsPromise;
    }
    const request = listProviderConnections(current)
      .then((items) => {
        if (workspaceId() === current) setProviderConnections(items);
        return items;
      })
      .finally(() => {
        if (providerConnectionsPromise === request) {
          providerConnectionsPromise = null;
        }
      });
    providerConnectionsPromise = request;
    return request;
  };

  createEffect(() => {
    const current = workspaceId();
    if (current === loadedWorkspaceId) return;
    loadedWorkspaceId = current;
    resetLazyWorkspaceData();
  });
  const createFirstWorkspace = createAction(async (): Promise<Workspace> => {
    const workspace = await createWorkspace({
      handle: defaultWorkspaceHandle(),
      displayName: t("workspace.defaultName"),
      type: "personal",
    });
    setCurrentWorkspaceId(workspace.id);
    window.dispatchEvent(new Event("takosumi:workspaces-changed"));
    return workspace;
  });
  const installConfigList = createMemo<readonly InstallConfig[]>(
    () => installConfigs() ?? [],
  );
  const defaultGitInstallConfig = () =>
    installConfigList().find(
      (config) => config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    ) ??
    installConfigList().find(
      (config) =>
        config.sourceKind === "generic_capsule" &&
        config.workspaceId === undefined,
    ) ??
    installConfigList().find(
      (config) => config.sourceKind === "generic_capsule",
    );
  const ensureConfigSelected = () => {
    const list = installConfigList();
    if (list.length === 0) return list;
    const current = installConfigId();
    if (!current || !list.some((config) => config.id === current)) {
      setInstallConfigId(defaultGitInstallConfig()?.id ?? "");
    }
    return list;
  };
  const installConfigLoading = () =>
    installConfigs.loading && installConfigList().length === 0;
  const selectedInstallConfigId = () => {
    ensureConfigSelected();
    return installConfigId();
  };
  const selectedInstallConfig = () => {
    const id = selectedInstallConfigId();
    return installConfigList().find((config) => config.id === id) ?? null;
  };
  const storeServiceEntry = (): StoreEntry | null => {
    const listing = selectedStoreListing();
    if (!listing) return null;
    return storeEntryFromStoreListing(
      listing,
      defaultGitInstallConfig()?.id ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    );
  };
  const selectedServiceEntry = () => storeServiceEntry();
  const storeInputValue = (entry: StoreEntry, field: StoreInputField) => {
    const key = storeInputKey(entry.id, field.name);
    return (
      storeInputValues()[key] ??
      storeDefaultInputValue(
        entry,
        field,
        workspaceHandle(),
        defaultProjectName(),
      )
    );
  };
  const storeInputBooleanChecked = (
    entry: StoreEntry,
    field: StoreInputField,
  ) =>
    ["true", "1", "yes", "on"].includes(
      storeInputValue(entry, field).trim().toLowerCase(),
    );
  const updateStoreInputValue = (
    entry: StoreEntry,
    field: StoreInputField,
    value: string,
  ) => {
    const key = storeInputKey(entry.id, field.name);
    const touched = storeInputTouched();
    setStoreInputValues((current) => {
      const next: Record<string, string> = {
        ...current,
        [key]: value,
      };
      const endpoint = storePublicEndpoint(entry);
      const baseDomain = managedBaseDomain(endpoint?.baseDomain);
      const setUntouched = (name: string | undefined, nextValue: string) => {
        const variable = name?.trim();
        if (!variable) return;
        if (!storeEndpointField(entry, variable)) return;
        const targetKey = storeInputKey(entry.id, variable);
        if (touched[targetKey]) return;
        next[targetKey] = nextValue;
      };
      if (field.name === endpoint?.subdomainVariable) {
        const label = value.trim().toLowerCase();
        if (isManagedSubdomainLabel(label)) {
          const managedLabel = managedServiceLabel(workspaceHandle(), label);
          const host = `${managedLabel}.${baseDomain}`;
          setUntouched(endpoint.urlVariable, `https://${host}`);
          setUntouched(endpoint.routePatternVariable, `${host}/*`);
        }
      } else if (field.name === endpoint?.urlVariable) {
        const host = publicEndpointHost(value);
        if (host) setUntouched(endpoint?.routePatternVariable, `${host}/*`);
      }
      return next;
    });
    setStoreInputTouched((current) => ({
      ...current,
      [key]: true,
    }));
    resetCompatibility();
  };
  const selectedStoreVariables = () => {
    const entry = selectedServiceEntry();
    if (!entry) return {};
    const variables: Record<string, JsonValue> = {};
    for (const field of entry.inputs) {
      const value = storeInputJsonValue(field, storeInputValue(entry, field));
      if (value !== undefined) {
        setStoreJsonVariable(variables, field.name, value);
      }
    }
    return variables;
  };
  const selectedStoreReturnVariables = (): Readonly<Record<string, string>> => {
    const entry = selectedServiceEntry();
    if (!entry) return {};
    const variables: Record<string, string> = {};
    for (const field of entry.inputs) {
      if (!isSafeInstallVariableName(field.name)) continue;
      const value = storeInputValue(entry, field).trim();
      if (value) variables[field.name] = value;
    }
    return variables;
  };
  const selectedStoreVariableNames = () => {
    const entry = selectedServiceEntry();
    if (!entry) return new Set<string>();
    return new Set(
      entry.inputs
        .map((field) => storeVariablePath(field.name)?.[0])
        .filter((name): name is string => name !== undefined),
    );
  };
  const storeInputError = (): string | null => {
    const entry = selectedServiceEntry();
    if (!entry) return null;
    for (const field of entry.inputs) {
      if (!storeVariablePath(field.name)) {
        return t("new.vars.errorUnsafeName", { name: field.name });
      }
      const value = storeInputValue(entry, field).trim();
      if (field.required && !value) {
        if (
          isConnectionScopedStoreInput(entry, field) ||
          isServiceIdentityStoreInput(entry, field)
        ) {
          continue;
        }
        return t("new.storeInput.errorRequired", {
          label: field.label[locale()],
        });
      }
      if (value && !isSafeInstallVariableValue(value)) {
        return t("new.storeInput.errorUnsafeValue", {
          label: field.label[locale()],
        });
      }
      const publicEndpoint = storePublicEndpoint(entry);
      if (
        value &&
        (field.format === "subdomain" ||
          field.name === publicEndpoint?.subdomainVariable) &&
        !isManagedSubdomainLabel(value)
      ) {
        return t("new.storeInput.errorSubdomain", {
          label: field.label[locale()],
          baseDomain: managedBaseDomain(publicEndpoint?.baseDomain),
        });
      }
      if (
        value &&
        (field.format === "url" || field.name === publicEndpoint?.urlVariable)
      ) {
        const baseDomain = managedBaseDomain(publicEndpoint?.baseDomain);
        const host = publicEndpointHost(value);
        if (
          !host ||
          (host.endsWith(`.${baseDomain}`) &&
            !hostIsManagedBaseDomainSubdomain(host, baseDomain))
        ) {
          return t("new.storeInput.errorCustomDomain", {
            label: field.label[locale()],
            baseDomain,
          });
        }
      }
      if (value && field.format === "sha256" && !isSha256Hex(value)) {
        return t("new.storeInput.errorUnsafeValue", {
          label: field.label[locale()],
        });
      }
    }
    return null;
  };
  const clearSelectedStoreEntry = () => {
    const hadStoreListing = Boolean(selectedStoreListing());
    setStoreMetadataUnavailable(false);
    if (!hadStoreListing) return;
    setSelectedStoreListing(null);
    setStoreInputValues({});
    setStoreInputTouched({});
    setInstallConfigId(defaultGitInstallConfig()?.id ?? "");
  };

  // Step machine: keep the created Source id so a retry resumes mid-flow.
  const [createdSourceId, setCreatedSourceId] = createSignal<string | null>(
    null,
  );
  const [createdCapsuleId, setCreatedCapsuleId] = createSignal<string | null>(
    null,
  );
  const [existingCapsule, setExistingCapsule] = createSignal<Capsule | null>(
    null,
  );
  const [stepSource, setStepSource] = createSignal<StepState>("idle");
  const [stepSync, setStepSync] = createSignal<StepState>("idle");
  const [stepInstall, setStepInstall] = createSignal<StepState>("idle");
  const [stepPlan, setStepPlan] = createSignal<StepState>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [syncRequired, setSyncRequired] = createSignal(false);
  const [sourceSyncSlow, setSourceSyncSlow] = createSignal(false);
  const [sourceSyncRunStatus, setSourceSyncRunStatus] =
    createSignal<RunStatus | null>(null);
  const [busy, setBusy] = createSignal(false);
  let sourceSyncSlowTimer: ReturnType<typeof setTimeout> | undefined;
  let activeFlowAbort: AbortController | undefined;
  let activeFlowId = 0;

  const clearSourceSyncSlowTimer = () => {
    if (sourceSyncSlowTimer) {
      clearTimeout(sourceSyncSlowTimer);
      sourceSyncSlowTimer = undefined;
    }
  };
  const startSourceSyncSlowTimer = () => {
    clearSourceSyncSlowTimer();
    setSourceSyncSlow(false);
    sourceSyncSlowTimer = setTimeout(() => {
      if (checkingCompatibility() || busy()) {
        setSourceSyncSlow(true);
      }
    }, 8_000);
  };
  const startAbortableFlow = (): FlowRun => {
    activeFlowAbort?.abort();
    activeFlowId += 1;
    const controller = new AbortController();
    activeFlowAbort = controller;
    return { id: activeFlowId, controller };
  };
  const isCurrentFlow = (flow: FlowRun) =>
    activeFlowId === flow.id &&
    activeFlowAbort === flow.controller &&
    !flow.controller.signal.aborted;
  const throwIfStaleFlow = (flow: FlowRun) => {
    if (!isCurrentFlow(flow)) {
      throw new DOMException("Request was aborted.", "AbortError");
    }
  };
  const abortActiveFlow = () => {
    activeFlowAbort?.abort();
    activeFlowAbort = undefined;
    activeFlowId += 1;
    clearSourceSyncSlowTimer();
    setCheckingCompatibility(false);
    setBusy(false);
    setSourceSyncRunStatus(null);
  };
  const finishAbortableFlow = (flow: FlowRun) => {
    if (isCurrentFlow(flow)) {
      activeFlowAbort = undefined;
    }
  };
  onCleanup(() => {
    clearSourceSyncSlowTimer();
    activeFlowAbort?.abort();
  });

  const validate = (): string | null => {
    if (!workspaceId()) return t("new.error.workspaceRequired");
    if (!gitUrl().trim()) return t("new.error.urlRequired");
    if (!name().trim()) return t("new.error.nameRequired");
    if (!INSTALLATION_NAME_PATTERN.test(name().trim())) {
      return t("new.error.nameInvalid");
    }
    if (installConfigLoading()) return t("new.error.configLoading");
    if (!selectedInstallConfigId()) return t("new.error.configMissing");
    if (storeMetadataUnavailable()) return t("new.error.configLoadFailed");
    const sourceCredentialError = sourceAccessError();
    if (sourceCredentialError) return sourceCredentialError;
    const storeError = storeInputError();
    if (storeError) return storeError;
    const variableError = inputVariableError();
    if (variableError) return variableError;
    const envError = envVariableError();
    if (envError) return envError;
    return null;
  };
  const effectiveRef = () => {
    const current = ref().trim();
    const pinned = pinnedFullRef();
    if (pinned && current === displayRef(pinned)) return pinned;
    return current;
  };
  const currentInstallPrefill = () =>
    activeInstallPrefill() ?? parseInstallPrefillFromInput(gitUrl());
  const sourceGitUrl = () => currentInstallPrefill()?.git ?? gitUrl().trim();
  const sourceRef = () => {
    const prefill = currentInstallPrefill();
    return prefill ? prefill.ref : effectiveRef();
  };
  const sourcePath = () =>
    currentInstallPrefill()?.path || path().trim() || ".";
  const installModulePath = () =>
    (selectedInstallConfig()?.modulePath ??
      selectedServiceEntry()?.source.path ??
      currentInstallPrefill()?.path ??
      path().trim()) ||
    ".";
  const activeStoreListing = (): TcsListing | null => {
    const listing = selectedStoreListing();
    if (!listing) return null;
    if (listing.source.git !== sourceGitUrl()) return null;
    if ((listing.source.path || ".") !== installModulePath()) return null;
    return listing;
  };
  const storeListingForCurrentSource = (): TcsListing | null => {
    const active = activeStoreListing();
    if (active) return active;
    const selected = selectedStoreListing();
    if (selected && storeListingMatchesCurrentSource(selected)) {
      return selected;
    }
    // No hardcoded store: install metadata comes from the repo-owned
    // `.well-known/tcs.json` hydrated onto the listing the user picked.
    return null;
  };
  const storeListingMatchesCurrentSource = (listing: TcsListing): boolean => {
    if (!sameGitUrl(listing.source.git, sourceGitUrl())) return false;
    return (
      normalizeSourcePath(listing.source.path || ".") ===
      normalizeSourcePath(installModulePath())
    );
  };
  const storeMetadataForRun = () => {
    const listing = storeListingForCurrentSource();
    return listing ? storeMetadataFromStoreListing(listing) : undefined;
  };
  const installExperienceForCurrentSource = () =>
    selectedServiceEntry()?.installExperience ??
    storeMetadataForRun()?.installExperience;
  const rootModuleVariableSet = () =>
    new Set(compatibility()?.rootModuleVariables ?? []);
  const rootModuleHasVariable = (name: string) =>
    rootModuleVariableSet().has(name);
  const firstRootModuleVariable = (
    names: readonly string[],
  ): string | undefined => names.find(rootModuleHasVariable);
  const standardServiceNameVariables = () =>
    ["project_name", "public_subdomain", "worker_name", "app_name"].filter(
      rootModuleHasVariable,
    );
  const standardServiceNameVariable = () =>
    firstRootModuleVariable([
      "project_name",
      "public_subdomain",
      "worker_name",
      "app_name",
    ]);
  const standardPublicSubdomainVariable = () =>
    firstRootModuleVariable(["public_subdomain", "worker_name"]);
  const standardPublicUrlVariable = () =>
    firstRootModuleVariable(["public_url", "app_url"]);
  const standardRoutePatternVariable = () =>
    firstRootModuleVariable(["cloudflare_route_pattern"]);
  const serviceNameVariableForCurrentSource = () =>
    selectedServiceEntry()
      ? storeServiceNameVariable(selectedServiceEntry()!)
      : (storeServiceNameVariable(storeMetadataForRun() ?? {}) ??
        standardServiceNameVariable());
  const storeServiceNameDefault = () => {
    const store = storeMetadataForRun();
    const variable = store ? storeServiceNameVariable(store) : undefined;
    return variable
      ? storeListingForCurrentSource()?.inputs?.find(
          (input) => input.name === variable,
        )?.defaultValue
      : undefined;
  };
  const storeConfigServiceNameDefault = () =>
    selectedServiceEntry()
      ? storeServiceNameField(selectedServiceEntry()!)?.defaultValue
      : undefined;
  const prefilledServiceName = () => {
    const variable = serviceNameVariableForCurrentSource();
    const value = variable
      ? currentInstallPrefill()?.vars?.[variable]
      : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const supportsServiceNameInput = () =>
    prefilledServiceName() !== undefined ||
    serviceNameHintIsGenerated(storeServiceNameDefault()) ||
    serviceNameHintIsGenerated(storeConfigServiceNameDefault()) ||
    standardServiceNameVariables().length > 0;
  const defaultProjectName = () => {
    const base = slugInputValue(name() || capsuleNameFromUrl(sourceGitUrl()));
    return base;
  };
  const serviceNameInputValue = () =>
    slugInputValue(resourcePrefix() || defaultProjectName());
  // Preview the FINAL managed hostname (workspace-prefixed + base domain) the
  // deploy will use, so the workspace prefix is not a surprise. Empty until
  // the workspace handle and a base domain are known.
  const managedHostPreview = (): string => {
    const endpoint = installExperiencePublicEndpoint(
      installExperienceForCurrentSource(),
    );
    const baseDomain = managedBaseDomain(endpoint?.baseDomain);
    const label = managedServiceLabel(
      workspaceHandle(),
      serviceNameInputValue(),
    );
    return label && baseDomain ? `${label}.${baseDomain}` : "";
  };
  const useSuggestedServiceName = () => {
    const entry = selectedServiceEntry();
    const publicEndpointField = entry
      ? storePublicEndpointSubdomainField(entry)
      : undefined;
    const candidate = uniqueServiceIdCandidate(
      (entry && publicEndpointField
        ? storeInputValue(entry, publicEndpointField)
        : serviceNameInputValue()) || defaultProjectName(),
    );
    if (entry && publicEndpointField) {
      updateStoreInputValue(entry, publicEndpointField, candidate);
      return;
    }
    setResourcePrefixTouched(true);
    setResourcePrefix(candidate);
    resetCompatibility();
    queueMicrotask(() => serviceNameInput?.focus());
  };
  const canSuggestPublicHostname = () => {
    const entry = selectedServiceEntry();
    return Boolean(
      supportsServiceNameInput() ||
      (entry && storePublicEndpointSubdomainField(entry)),
    );
  };
  const updateInputVariable = (
    index: number,
    patch: Partial<InputVariableRow>,
  ) => {
    setInputVariables((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        const next = { ...row, ...patch };
        return "value" in patch ? { name: next.name, value: next.value } : next;
      }),
    );
    resetCompatibility();
  };
  const addInputVariable = () =>
    setInputVariables((rows) => [...rows, { name: "", value: "" }]);
  const removeInputVariable = (index: number) => {
    setInputVariables((rows) => rows.filter((_, i) => i !== index));
    resetCompatibility();
  };
  const updateEnvVariable = (index: number, patch: Partial<EnvVariableRow>) => {
    setEnvVariables((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    resetCompatibility();
  };
  const addEnvVariable = () =>
    setEnvVariables((rows) => [...rows, { name: "", value: "" }]);
  const removeEnvVariable = (index: number) => {
    setEnvVariables((rows) => rows.filter((_, i) => i !== index));
    resetCompatibility();
  };
  const normalizedInputVariables = (): Record<string, JsonValue> => {
    const variables: Record<string, JsonValue> = {};
    for (const row of inputVariables()) {
      const variableName = row.name.trim();
      const value = row.value.trim();
      if (!variableName && !value) continue;
      variables[variableName] =
        row.jsonValue !== undefined &&
        value === installVariableDisplayValue(row.jsonValue)
          ? row.jsonValue
          : value;
    }
    return variables;
  };
  const normalizedEnvVariables = (): Record<string, JsonValue> => {
    const env: Record<string, JsonValue> = {};
    for (const row of envVariables()) {
      const name = row.name.trim();
      const value = row.value.trim();
      if (!name && !value) continue;
      env[name] = value;
    }
    return env;
  };
  const mergeEnvVariables = (
    variables: Record<string, JsonValue>,
    env: Readonly<Record<string, JsonValue>>,
  ) => {
    if (Object.keys(env).length === 0) return variables;
    const existing = isJsonRecord(variables.env) ? variables.env : {};
    variables.env = { ...existing, ...env };
    return variables;
  };
  const standardCapsuleVariableDefaults = (
    current: Readonly<Record<string, JsonValue>>,
  ): Record<string, JsonValue> => {
    const variables = rootModuleVariableSet();
    if (variables.size === 0) return {};
    const defaults: Record<string, JsonValue> = {};
    const setDefault = (name: string, value: JsonValue | undefined) => {
      if (!variables.has(name)) return;
      if (current[name] !== undefined) return;
      if (value === undefined || value === "") return;
      defaults[name] = value;
    };
    const serviceName = serviceNameInputValue();
    for (const name of standardServiceNameVariables()) {
      setDefault(name, serviceName);
    }
    const publicSubdomainVariable = standardPublicSubdomainVariable();
    if (publicSubdomainVariable) {
      setDefault(publicSubdomainVariable, serviceName);
    }
    const managedHost = managedHostPreview();
    const publicUrlVariable = standardPublicUrlVariable();
    if (managedHost && publicUrlVariable) {
      setDefault(publicUrlVariable, `https://${managedHost}`);
    }
    const routePatternVariable = standardRoutePatternVariable();
    if (managedHost && routePatternVariable) {
      setDefault(routePatternVariable, `${managedHost}/*`);
    }
    return defaults;
  };
  const storeListingDefaultVariables = (): Readonly<
    Record<string, JsonValue>
  > => ({});
  const storeListingVariableNames = () => new Set<string>();
  const standardVariableNames = () =>
    new Set([
      ...standardServiceNameVariables(),
      ...[
        standardPublicSubdomainVariable(),
        standardPublicUrlVariable(),
        standardRoutePatternVariable(),
        "takosumi_accounts_url",
        "takosumi_accounts_issuer_url",
        "takosumi_accounts_redirect_uri",
      ].filter((name): name is string =>
        Boolean(name && rootModuleHasVariable(name)),
      ),
    ]);
  const inputVariableError = (): string | null => {
    const seen = new Set<string>();
    const storeNames = new Set([
      ...selectedStoreVariableNames(),
      ...storeListingVariableNames(),
      ...standardVariableNames(),
    ]);
    const serviceNameVariable = serviceNameVariableForCurrentSource();
    for (const row of inputVariables()) {
      const variableName = row.name.trim();
      const value = row.value.trim();
      if (!variableName && !value) continue;
      if (!variableName) return t("new.vars.errorNameRequired");
      if (!isSafeInstallVariableName(variableName)) {
        return t("new.vars.errorUnsafeName", { name: variableName });
      }
      if (!isSafeInstallVariableValue(value)) {
        return t("new.vars.errorUnsafeValue", { name: variableName });
      }
      if (
        serviceNameVariable &&
        supportsServiceNameInput() &&
        variableName === serviceNameVariable
      ) {
        return t("new.vars.errorProjectNameReserved");
      }
      if (storeNames.has(variableName)) {
        return t("new.vars.errorStoreReserved", { name: variableName });
      }
      if (seen.has(variableName)) {
        return t("new.vars.errorDuplicate", { name: variableName });
      }
      seen.add(variableName);
    }
    return null;
  };
  const envVariableError = (): string | null => {
    const seen = new Set<string>();
    for (const row of envVariables()) {
      const variableName = row.name.trim();
      const value = row.value.trim();
      if (!variableName && !value) continue;
      if (!variableName) return t("new.env.errorNameRequired");
      if (!isSafePlainEnvName(variableName)) {
        return t("new.env.errorUnsafeName", { name: variableName });
      }
      if (!isSafeInstallVariableValue(value)) {
        return t("new.env.errorUnsafeValue", { name: variableName });
      }
      if (seen.has(variableName)) {
        return t("new.env.errorDuplicate", { name: variableName });
      }
      seen.add(variableName);
    }
    return null;
  };
  const shouldOpenServiceAdvanced = () =>
    inputVariables().length > 0 || envVariables().length > 0;
  const installReturnVariables = (): Readonly<Record<string, JsonValue>> => {
    const variables: Record<string, JsonValue> = {
      ...storeListingDefaultVariables(),
      ...(currentInstallPrefill()?.vars ?? {}),
    };
    const serviceNameVariable = serviceNameVariableForCurrentSource();
    if (serviceNameVariable && supportsServiceNameInput()) {
      variables[serviceNameVariable] = serviceNameInputValue();
    }
    Object.assign(variables, standardCapsuleVariableDefaults(variables));
    Object.assign(variables, selectedStoreReturnVariables());
    Object.assign(variables, normalizedInputVariables());
    mergeEnvVariables(variables, normalizedEnvVariables());
    return variables;
  };
  const installVariables = ():
    Readonly<Record<string, JsonValue>> | undefined => {
    const variables: Record<string, JsonValue> = {
      ...storeListingDefaultVariables(),
      ...(currentInstallPrefill()?.vars ?? {}),
      ...selectedStoreVariables(),
      ...normalizedInputVariables(),
    };
    const serviceNameVariable = serviceNameVariableForCurrentSource();
    if (serviceNameVariable && supportsServiceNameInput()) {
      variables[serviceNameVariable] = serviceNameInputValue();
    }
    Object.assign(variables, standardCapsuleVariableDefaults(variables));
    mergeEnvVariables(variables, normalizedEnvVariables());
    Object.assign(variables, managedProviderVariableDefaults(variables));
    return Object.keys(variables).length > 0 ? variables : undefined;
  };
  const currentInstallReturnPath = () =>
    appendAppHandoff(
      installReturnPathFromPrefill({
        git: sourceGitUrl(),
        ref: sourceRef(),
        path: sourcePath(),
        name: name().trim(),
        vars: installReturnVariables(),
      }),
      appHandoff,
    );
  const providerConnectionsHref = () =>
    providerConnectionsHrefForInstallReturn(currentInstallReturnPath());

  const visibleConnections = () => connections() ?? [];
  const selectedManagedProviderConnection = ():
    ProviderConnection | undefined => {
    for (const row of providerRows()) {
      const connection = providerConnectionsForProvider(row.provider).find(
        (candidate) =>
          candidate.id === row.connectionId &&
          candidate.scopeHints?.managedProvider === true,
      );
      if (connection) return connection;
    }
    return undefined;
  };
  const managedProviderVariableDefaults = (
    current: Readonly<Record<string, JsonValue>>,
  ): Record<string, JsonValue> => {
    const connection = selectedManagedProviderConnection();
    if (!connection && !hasManagedCloudflareProviderFallback()) return {};
    const variables = new Set(compatibility()?.rootModuleVariables ?? []);
    if (variables.size === 0) return {};
    const defaults: Record<string, JsonValue> = {};
    const setDefault = (name: string, value: JsonValue | undefined) => {
      if (!variables.has(name)) return;
      if (current[name] !== undefined) return;
      if (value === undefined || value === "") return;
      defaults[name] = value;
    };
    const installExperience = installExperienceForCurrentSource();
    const publicEndpoint = installExperiencePublicEndpoint(installExperience);
    if (
      !connection ||
      sameProviderFamily(connection.providerSource, "cloudflare")
    ) {
      // Enable Cloudflare resources only when an account id is actually
      // known (a scoped connection, or the operator-managed fallback whose
      // proxy injects it). A generic BYO-env connection without scope hints
      // must leave the module's own defaults alone — modules validate
      // `cloudflare_account_id is required when enable_cloudflare_resources
      // is true`, so blindly enabling guarantees a failed plan.
      const cloudflareAccountKnown =
        Boolean(connection?.scopeHints?.accountId) ||
        (!connection && hasManagedCloudflareProviderFallback());
      if (cloudflareAccountKnown) {
        setDefault("enable_cloudflare_resources", true);
        setDefault("enable_cloudflare_worker_script", true);
      }
      setDefault("cloudflare_account_id", connection?.scopeHints?.accountId);
      setDefault("account_id", connection?.scopeHints?.accountId);
      setDefault("cloudflare_route_zone_id", connection?.scopeHints?.zoneId);
      if (publicEndpoint) {
        const subdomainVariable = publicEndpoint.subdomainVariable?.trim();
        const urlVariable = publicEndpoint.urlVariable?.trim();
        const routePatternVariable =
          publicEndpoint.routePatternVariable?.trim();
        const publicBaseDomain = managedBaseDomain(publicEndpoint.baseDomain);
        const currentSubdomain =
          subdomainVariable && typeof current[subdomainVariable] === "string"
            ? current[subdomainVariable].trim()
            : "";
        const currentAppUrl =
          urlVariable && typeof current[urlVariable] === "string"
            ? current[urlVariable].trim()
            : "";
        const managedAppLabel = currentSubdomain
          ? managedServiceLabel(workspaceHandle(), currentSubdomain)
          : "";
        const managedAppHost = managedAppLabel
          ? `${managedAppLabel}.${publicBaseDomain}`
          : "";
        const managedAppUrl =
          currentAppUrl || (managedAppHost ? `https://${managedAppHost}` : "");
        if (managedAppUrl && urlVariable) {
          setDefault(urlVariable, managedAppUrl);
        }
        if (managedAppUrl && routePatternVariable) {
          setDefault(
            routePatternVariable,
            routePatternFromAppUrl(managedAppUrl) ?? `${managedAppHost}/*`,
          );
        }
      }
      if (
        variables.has("enable_workers_dev_subdomain") &&
        current.enable_workers_dev_subdomain === undefined
      ) {
        defaults.enable_workers_dev_subdomain = false;
      }
    }
    return defaults;
  };
  const storeScopeHintValue = (
    entry: StoreEntry,
    field: StoreInputField,
  ): string | undefined => {
    const matchingConnections = visibleConnections().filter(
      (connection) =>
        connection.scope === "space" &&
        connection.status === "verified" &&
        sameProviderFamily(entry.provider, connection.provider),
    );
    const hints = new Set<string>();
    for (const connection of matchingConnections) {
      const value = scopeHintValueForStoreInput(connection, field);
      if (value) hints.add(value);
    }
    return hints.size === 1 ? Array.from(hints)[0] : undefined;
  };
  const scopeHintValueForStoreInput = (
    connection: Connection,
    field: StoreInputField,
  ): string | undefined => {
    const name = field.name
      .trim()
      .replace(/[^A-Za-z0-9]+/gu, "_")
      .toLowerCase();
    const hint =
      name === "accountid" ||
      name === "account_id" ||
      name === "cloudflare_account_id"
        ? connection.scopeHints?.accountId
        : name === "zoneid" ||
            name === "zone_id" ||
            name === "cloudflare_zone_id" ||
            name === "cloudflare_route_zone_id"
          ? connection.scopeHints?.zoneId
          : name === "region" || name === "aws_region"
            ? connection.scopeHints?.awsRegion
            : name === "workerssubdomain" ||
                name === "workers_subdomain" ||
                name === "cloudflare_workers_subdomain"
              ? connection.scopeHints?.workersSubdomain
              : undefined;
    const value = hint?.trim();
    return value || undefined;
  };
  const storeInputHasImplicitValue = (
    entry: StoreEntry,
    field: StoreInputField,
  ) =>
    field.required &&
    !storeInputTouched()[storeInputKey(entry.id, field.name)] &&
    storeScopeHintValue(entry, field) !== undefined;
  const isServiceIdentityStoreInput = (
    entry: StoreEntry,
    field: StoreInputField,
  ) =>
    field.name === storeServiceNameVariable(entry) &&
    serviceNameHintIsGenerated(field.defaultValue);
  const isConnectionScopedStoreInput = (
    entry: StoreEntry,
    field: StoreInputField,
  ) => storeInputHasImplicitValue(entry, field);
  const isInitialSecretStoreInput = (
    entry: StoreEntry,
    field: StoreInputField,
  ) =>
    installExperienceInitialSecret(entry.installExperience)?.variable ===
    field.name;
  const isAdvancedStoreInput = (entry: StoreEntry, field: StoreInputField) =>
    storeInputHasImplicitValue(entry, field) ||
    // `initial_secret` is part of the install contract, so keep it beside
    // other initial settings even when it is optional. Unprojected optional
    // secrets remain available under advanced settings.
    (!field.required &&
      !isInitialSecretStoreInput(entry, field) &&
      (field.advanced === true || field.secret === true));
  const visibleStoreInputs = (entry: StoreEntry) =>
    entry.inputs.filter(
      (field) =>
        !isConnectionScopedStoreInput(entry, field) &&
        !isServiceIdentityStoreInput(entry, field) &&
        !isAdvancedStoreInput(entry, field),
    );
  const advancedStoreInputs = (entry: StoreEntry) =>
    entry.inputs.filter(
      (field) =>
        !isConnectionScopedStoreInput(entry, field) &&
        !isServiceIdentityStoreInput(entry, field) &&
        isAdvancedStoreInput(entry, field),
    );
  const hasMissingAdvancedStoreInputs = () => {
    const entry = selectedServiceEntry();
    if (!entry || !compatibility()) return false;
    return advancedStoreInputs(entry).some(
      (field) => field.required && !storeInputValue(entry, field).trim(),
    );
  };
  const sourceGitConnections = () =>
    visibleConnections().filter(
      (connection) =>
        connection.scope === "space" &&
        (connection.kind === "source_git_https_token" ||
          connection.kind === "source_git_ssh_key") &&
        connection.status === "verified",
    );
  const sourceConnectionLabel = (connection: Connection) =>
    connection.displayName ||
    connection.scopeHints?.repoUrl ||
    (connection.kind === "source_git_ssh_key"
      ? t("new.sourceAccess.sshConnection")
      : t("new.sourceAccess.httpsConnection"));
  const sourceAuthConnectionIdForRun = () =>
    sourceAccessMode() === "existing"
      ? sourceAuthConnectionId().trim() || undefined
      : undefined;
  const sourceAccessError = (): string | null => {
    if (sourceAccessMode() === "public") return null;
    if (sourceAccessMode() === "token") {
      return t("new.sourceAccess.errorSaveToken");
    }
    const connectionId = sourceAuthConnectionId().trim();
    if (!connectionId) return t("new.sourceAccess.errorSelectConnection");
    if (
      !sourceGitConnections().some(
        (connection) => connection.id === connectionId,
      )
    ) {
      return t("new.sourceAccess.errorConnectionUnavailable");
    }
    return null;
  };
  const saveSourceTokenConnection = async () => {
    setSourceTokenError(null);
    const currentWorkspaceId = workspaceId();
    if (!currentWorkspaceId) {
      setSourceTokenError(t("new.error.workspaceRequired"));
      return;
    }
    const token = sourceToken().trim();
    if (!token) {
      setSourceTokenError(t("new.sourceAccess.errorTokenRequired"));
      return;
    }
    setSavingSourceToken(true);
    try {
      const connection = await createSourceHttpsTokenConnection({
        workspaceId: currentWorkspaceId,
        displayName: t("new.sourceAccess.defaultDisplayName", {
          name: name().trim() || capsuleNameFromUrl(gitUrl()) || "source",
        }),
        repoUrl: gitUrl().trim() || undefined,
        username: sourceTokenUsername().trim() || "git",
        token,
      });
      await testConnection(connection.id);
      await loadConnections({ force: true });
      setSourceAuthConnectionId(connection.id);
      setSourceAccessMode("existing");
      setSourceToken("");
      resetCompatibility();
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      setSourceTokenError(apiError?.message ?? t("new.error.generic"));
    } finally {
      setSavingSourceToken(false);
    }
  };

  createEffect(() => {
    if (!supportsServiceNameInput() || resourcePrefixTouched()) return;
    setResourcePrefix(defaultProjectName());
  });

  createEffect(() => {
    if (sourceAccessMode() === "existing") void loadConnections();
  });

  createEffect(() => {
    if (sourceAccessMode() !== "existing") return;
    const current = sourceAuthConnectionId();
    const options = sourceGitConnections();
    if (current && options.some((connection) => connection.id === current)) {
      return;
    }
    setSourceAuthConnectionId(options[0]?.id ?? "");
  });

  const providerConnectionLabel = (connection: ProviderConnection) =>
    connection.displayName || providerLabel(connection.providerSource);

  const canonicalProvider = (provider: string) => provider.toLowerCase().trim();
  const providerTail = (provider: string) => {
    const normalized = canonicalProvider(provider);
    return normalized.split("/").at(-1) ?? normalized;
  };
  const providerLabel = (provider: string) =>
    providerDisplayName(providerTail(provider));
  // Any provider that is a credential boundary needs a Provider Connection (the
  // user's own key) — NOT only the curated preset providers. This is what lets
  // an install bind a bring-your-own-key connection for an ARBITRARY OpenTofu
  // provider, not just the presets we ship a guided form for. Credential-free
  // providers never force a connection: isCredentialFreeUtilityProvider covers
  // the canonical http / random / tls, and the tail set below covers the other
  // common credential-free providers (null / local / time / external / archive /
  // cloudinit / template) — including bare local-name declarations — so a Capsule
  // that uses e.g. null_resource / local_file / time_static is not falsely
  // blocked on a bogus key.
  const providerRequiresConnection = (provider: string) =>
    !isCredentialFreeUtilityProvider(provider) &&
    !CREDENTIAL_FREE_PROVIDER_TAILS.has(providerTail(provider));
  const sameProviderFamily = (
    requiredProvider: string,
    connectionProvider: string,
  ) => {
    const required = canonicalProvider(requiredProvider);
    const connection = canonicalProvider(connectionProvider);
    if (required === connection) return true;
    return providerTail(required) === providerTail(connection);
  };

  const visibleProviderConnections = () => providerConnections() ?? [];
  const isUsableManagedProviderConnection = (connection: ProviderConnection) =>
    connection.status === "pending" &&
    connection.scope === "operator" &&
    connection.scopeHints?.managedProvider === true &&
    typeof connection.scopeHints.providerBaseUrl === "string" &&
    connection.scopeHints.providerBaseUrl.trim().length > 0;
  const isReadyProviderConnection = (connection: ProviderConnection) =>
    connection.status === "verified" ||
    isUsableManagedProviderConnection(connection);
  const readyProviderConnections = () =>
    visibleProviderConnections().filter(isReadyProviderConnection);
  const providerConnectionsForProvider = (provider: string) =>
    readyProviderConnections().filter((connection) =>
      sameProviderFamily(provider, connection.providerSource),
    );
  const providerConnectionScore = (
    row: ProviderConnectionRow,
    connection: ProviderConnection,
  ): number => {
    let score = 0;
    const provider = providerTail(row.provider);
    const listing = storeListingForCurrentSource();
    if (
      listing &&
      providerTail(listing.provider) === provider &&
      connection.scopeHints?.managedProvider === true
    ) {
      score += 1_000;
    }
    const wantsWorkersSubdomain =
      row.resourceTypes.includes("cloudflare_workers_script_subdomain") ||
      row.rootModuleVariables.includes("cloudflare") ||
      row.rootModuleVariables.includes("cloudflare_workers_subdomain") ||
      row.rootModuleVariables.includes("workersSubdomain");
    if (provider === "cloudflare" && connection.scopeHints?.accountId) {
      score += 10;
    }
    if (
      provider === "cloudflare" &&
      wantsWorkersSubdomain &&
      connection.scopeHints?.workersSubdomain
    ) {
      score += 100;
    }
    return score;
  };
  const providerConnectionsForRow = (row: ProviderConnectionRow) =>
    providerConnectionsForProvider(row.provider)
      .map((connection, index) => ({
        connection,
        index,
        score: providerConnectionScore(row, connection),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.connection);
  const managedProviderConnectionForRow = (
    row: ProviderConnectionRow,
  ): ProviderConnection | undefined =>
    providerConnectionsForRow(row).find(
      (connection) => connection.scopeHints?.managedProvider === true,
    );
  const managedStoreProviderForCurrentSource = (): string | undefined =>
    selectedServiceEntry()?.provider ??
    storeListingForCurrentSource()?.provider;
  const rowCanUseManagedProviderFallback = (row: ProviderConnectionRow) => {
    const managedProvider = managedStoreProviderForCurrentSource();
    return (
      managedProvider !== undefined &&
      providerTail(managedProvider) === providerTail(row.provider) &&
      providerTail(row.provider) === "cloudflare" &&
      // The fallback is real only when an operator-managed connection is
      // actually listed (Cloud). A self-host without one must show the
      // friendly connection callout instead of failing server-side.
      managedProviderConnectionForRow(row) !== undefined
    );
  };
  const hasManagedCloudflareProviderFallback = () =>
    providerRows().some(rowCanUseManagedProviderFallback);
  const rowHasManagedProviderDefault = (row: ProviderConnectionRow) => {
    const managedProvider = managedStoreProviderForCurrentSource();
    if (!managedProvider) return false;
    if (providerTail(managedProvider) !== providerTail(row.provider)) {
      return false;
    }
    const best = providerConnectionsForRow(row)[0];
    return (
      best !== undefined &&
      best.id === row.connectionId &&
      best.scopeHints?.managedProvider === true
    );
  };
  const providerNeedsConnection = (row: ProviderConnectionRow) =>
    providerRequiresConnection(row.provider) &&
    !rowCanUseManagedProviderFallback(row) &&
    providerConnectionsForProvider(row.provider).length === 0;
  const needsCloudCredential = () =>
    compatibility() !== null && providerRows().some(providerNeedsConnection);
  const missingProviderRows = () =>
    providerRows().filter(providerNeedsConnection);
  const providerRowNeedsVisibleChoice = (row: ProviderConnectionRow) => {
    if (!providerRequiresConnection(row.provider)) return false;
    if (rowCanUseManagedProviderFallback(row)) return false;
    if (rowHasManagedProviderDefault(row)) return false;
    const candidates = providerConnectionsForRow(row);
    if (candidates.length !== 1) return true;
    return row.connectionId !== candidates[0]?.id;
  };
  const providerRowsRequiringChoice = () =>
    providerRows().filter(providerRowNeedsVisibleChoice);

  const defaultConnectionForRow = (row: ProviderConnectionRow): string => {
    const candidates = providerConnectionsForRow(row);
    return candidates[0]?.id ?? "";
  };

  const defaultProviderRowsWithReadyConnections = (
    rows: readonly ProviderConnectionRow[],
  ): ProviderConnectionRow[] => {
    let changed = false;
    const defaultedRows = rows.map((row) => {
      if (rowCanUseManagedProviderFallback(row)) {
        const managed = managedProviderConnectionForRow(row);
        const connectionId = managed?.id ?? "";
        if (row.connectionId === connectionId) return row;
        changed = true;
        return { ...row, connectionId };
      }
      const candidates = providerConnectionsForProvider(row.provider);
      if (
        row.connectionId &&
        candidates.some((connection) => connection.id === row.connectionId)
      ) {
        return row;
      }
      const connectionId = defaultConnectionForRow(row);
      if (!connectionId || connectionId === row.connectionId) {
        return row;
      }
      changed = true;
      return { ...row, connectionId };
    });
    return changed ? defaultedRows : [...rows];
  };

  createEffect(() => {
    if (!compatibility()) return;
    const rows = providerRows();
    if (rows.length === 0) return;
    const defaultedRows = defaultProviderRowsWithReadyConnections(rows);
    if (
      defaultedRows.some(
        (row, index) => row.connectionId !== rows[index]?.connectionId,
      )
    ) {
      setProviderRows(defaultedRows);
    }
  });

  const settleProviderConnectionRows = async () => {
    setProviderRows((rows) => defaultProviderRowsWithReadyConnections(rows));
    await Promise.resolve();
  };

  const rowsFromCompatibility = (
    result: CapsuleCompatibilityResult,
  ): ProviderConnectionRow[] =>
    result.providers
      .filter(
        (provider) =>
          provider.allowed && providerRequiresConnection(provider.source),
      )
      .flatMap((provider) => {
        const aliases = provider.aliases.length > 0 ? provider.aliases : [""];
        const resourceTypes = result.resources
          .filter(
            (resource) =>
              resource.allowed &&
              resource.type
                .toLowerCase()
                .startsWith(`${providerTail(provider.source)}_`),
          )
          .map((resource) => resource.type);
        return aliases.map((alias) => ({
          provider: provider.source,
          alias,
          connectionId: "",
          resourceTypes,
          rootModuleVariables: result.rootModuleVariables,
        }));
      });

  // Keyed by row identity (provider + alias), NOT by position: the chooser
  // renders the FILTERED providerRowsRequiringChoice() list, so a positional
  // index would write through to a hidden managed/auto-selected row.
  const updateProviderRow = (
    target: ProviderConnectionRow,
    patch: Partial<ProviderConnectionRow>,
  ) =>
    setProviderRows((rows) =>
      rows.map((row) =>
        row.provider === target.provider && row.alias === target.alias
          ? { ...row, ...patch }
          : row,
      ),
    );

  const providerConnectionError = (): string | null => {
    for (const row of providerRows()) {
      const candidates = providerConnectionsForProvider(row.provider);
      if (!row.connectionId.trim()) {
        if (rowCanUseManagedProviderFallback(row)) continue;
        return t("new.providers.errorConnection", {
          provider: providerLabel(row.provider),
        });
      }
      if (
        !candidates.some((connection) => connection.id === row.connectionId)
      ) {
        return t("new.providers.errorConnection", {
          provider: providerLabel(row.provider),
        });
      }
    }
    return null;
  };

  const providerConnectionsPayload = (): CapsuleProviderConnectionBindings =>
    providerRows()
      .filter((row) => providerRequiresConnection(row.provider))
      .filter((row) => row.connectionId.trim())
      .map((row) => ({
        provider: row.provider,
        ...(row.alias ? { alias: row.alias } : {}),
        connectionId: row.connectionId,
      }));

  const resetCompatibility = () => {
    abortActiveFlow();
    setCompatibility(null);
    setProviderRows([]);
    setCreatedSourceId(null);
    setCreatedCapsuleId(null);
    setExistingCapsule(null);
    setAppHostnameConflict(false);
    setError(null);
  };
  const applyInstallPrefillInput = (
    next: InstallPrefill,
    options: { readonly storeListing?: TcsListing } = {},
  ) => {
    const nextRef = next.ref;
    const storeListing = options.storeListing;
    if (storeListing) void loadConnections();
    setActiveTab(storeListing ? "store" : "git");
    setActiveInstallPrefill(next);
    setSelectedStoreListing(storeListing ?? null);
    setGitUrl(next.git);
    setRef(refInputValue(nextRef));
    setPinnedFullRef(isFullCommitSha(nextRef) ? nextRef : null);
    setPath(next.path || ".");
    if (next.name || !name().trim()) {
      setName(next.name ?? capsuleNameFromUrl(next.git));
    }
    if (storeListing) {
      const entry = storeEntryFromStoreListing(
        storeListing,
        defaultGitInstallConfig()?.id ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
      );
      const defaults: Record<string, string> = {};
      for (const field of entry.inputs) {
        const value = next.vars?.[field.name];
        if (value === undefined) continue;
        defaults[storeInputKey(entry.id, field.name)] =
          installVariableDisplayValue(value);
      }
      setStoreInputValues(defaults);
      setStoreInputTouched({});
      setInputVariables([]);
      setEnvVariables(envVariableRowsFromPrefill(next.vars));
      setInstallConfigId(entry.installConfigId);
    } else {
      setInputVariables(inputVariableRowsFromPrefill(next.vars));
      setEnvVariables(envVariableRowsFromPrefill(next.vars));
    }
    const nextServiceNameVariable = storeListing
      ? storeServiceNameVariable(storeMetadataFromStoreListing(storeListing))
      : undefined;
    const nextProjectName =
      nextServiceNameVariable &&
      typeof next.vars?.[nextServiceNameVariable] === "string"
        ? next.vars[nextServiceNameVariable]
        : undefined;
    if (nextProjectName) {
      const isGeneratedProjectName =
        serviceNameHintIsGenerated(nextProjectName);
      setResourcePrefix(isGeneratedProjectName ? "" : nextProjectName);
      setResourcePrefixTouched(!isGeneratedProjectName);
    } else {
      setResourcePrefix("");
      setResourcePrefixTouched(false);
    }
    resetCompatibility();
  };

  const hydrateStoreListing = async (
    listing: TcsListing,
    signal?: AbortSignal,
  ): Promise<TcsListing> => {
    const hydrated = await hydrateRequiredTcsListingWithRepoMetadata(
      listing,
      signal,
    );
    setStoreMetadataUnavailable(false);
    return hydrated;
  };

  const pickStoreListing = (listing: TcsListing) => {
    void (async () => {
      let hydratedListing: TcsListing;
      try {
        hydratedListing = await hydrateStoreListing(listing);
      } catch {
        setStoreMetadataUnavailable(true);
        setError(t("new.error.configLoadFailed"));
        return;
      }
      void loadConnections();
      const prefill = parseInstallPrefill(`?${buildNewQuery(hydratedListing)}`);
      if (prefill) {
        applyInstallPrefillInput(prefill, { storeListing: hydratedListing });
        return;
      }

      setActiveTab("store");
      setActiveInstallPrefill(null);
      setSelectedStoreListing(hydratedListing);
      setGitUrl(hydratedListing.source.git);
      setRef("");
      setPinnedFullRef(null);
      setPath(hydratedListing.source.path || ".");
      setName(hydratedListing.suggestedName);
      setInstallConfigId(
        defaultGitInstallConfig()?.id ?? DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
      );
      setStoreInputValues({});
      setStoreInputTouched({});
      setInputVariables([]);
      setEnvVariables([]);
      resetCompatibility();
    })();
  };
  const startLinkImport = () => {
    const raw = linkDraft().trim();
    if (!raw) {
      setActiveTab("git");
      clearSelectedStoreEntry();
      return;
    }
    const parsed = parseInstallPrefillFromInput(raw);
    if (parsed) {
      applyInstallPrefillInput(parsed);
      return;
    }
    clearSelectedStoreEntry();
    setSelectedStoreListing(null);
    setActiveTab("git");
    setActiveInstallPrefill(null);
    setGitUrl(raw);
    setName(name().trim() || capsuleNameFromUrl(raw));
    setRef("");
    setPinnedFullRef(null);
    setPath(".");
    resetCompatibility();
  };

  let initialTcsHandoffApplied = false;
  const [tcsHandoffSettled, setTcsHandoffSettled] =
    createSignal(!initialTcsHandoff);
  createEffect(() => {
    if (initialTcsHandoffApplied || !initialTcsHandoff) return;
    initialTcsHandoffApplied = true;
    void (async () => {
      try {
        const listing = await fetchTcsListing(
          initialTcsHandoff.base,
          initialTcsHandoff.listingId,
        );
        if (!listing || !storeListingMatchesCurrentSource(listing)) return;
        const hydratedListing = await hydrateStoreListing({
          ...listing,
          primaryServer: initialTcsHandoff.base,
        });
        setSelectedStoreListing(hydratedListing);
        setActiveTab("store");
        void loadConnections();
      } catch {
        setStoreMetadataUnavailable(true);
        setError(t("new.error.configLoadFailed"));
      } finally {
        setTcsHandoffSettled(true);
      }
    })();
  });

  createEffect(() => {
    const entry = selectedServiceEntry();
    if (!entry) return;
    setStoreInputValues((current) => {
      let changed = false;
      const next: Record<string, string> = { ...current };
      for (const field of entry.inputs) {
        const key = storeInputKey(entry.id, field.name);
        if (storeInputTouched()[key]) continue;
        if ((next[key] ?? "").trim()) continue;
        const scopeHint = storeScopeHintValue(entry, field);
        if (scopeHint === undefined) continue;
        next[key] = scopeHint;
        changed = true;
      }
      return changed ? next : current;
    });
  });

  const compatibilityRunnable = () => {
    const level = compatibility()?.level;
    return level === "ready" || level === "auto_capsulized";
  };
  const proceedBlocker = (): string =>
    providerConnectionError() ??
    (compatibility() && !compatibilityRunnable()
      ? t("new.error.notRunnable")
      : t("new.proceedHint"));
  const canContinue = () =>
    compatibility() !== null &&
    compatibilityRunnable() &&
    providerConnectionError() === null;
  const usingSelectedService = () =>
    Boolean(selectedServiceEntry()) && Boolean(sourceGitUrl());
  const hasChosenSource = () =>
    activeTab() === "git" || usingSelectedService() || Boolean(sourceGitUrl());
  const sourceSummaryTitle = () =>
    sourceGitUrl() ? name().trim() || capsuleNameFromUrl(sourceGitUrl()) : "";
  const retryAfterSyncWait = () => {
    if (compatibility()) void runFlow();
    else void runCompatibilityCheck();
  };

  /**
   * Single install action. Folds the old two-step (check → confirm) into one:
   * run the compatibility check when needed, stop only on a real blocker (compat
   * level not runnable, or missing/unselected provider connection) so the inline
   * panels can explain it — otherwise continue straight through to create + plan.
   */
  const submitInstall = async () => {
    // validate() exempts connection-scoped required inputs only when the
    // workspace connections are loaded (storeScopeHintValue reads connections()).
    // Auto-install fires before any user interaction loaded them, so ensure
    // they're settled first — otherwise a valid one-tap install is wrongly
    // blocked as "missing required input".
    await loadConnections().catch(() => []);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!compatibility()) {
      await runCompatibilityCheck();
      // The check failed or could not resolve a result; its own error is shown.
      if (!compatibility()) return;
    }
    await loadProviderConnections().catch(() => []);
    await settleProviderConnectionRows();
    // Blockers render inline from compatibility state (compat result panel /
    // cloud-account callout). Stop here so the user can resolve them first.
    if (!canContinue()) return;
    await runFlow();
  };

  // ストア[追加] auto-start: fire the single install action once, as soon as
  // the workspace / install config / store hydration settle. Validation errors
  // and blockers fall back to the visible form — auto never skips a review.
  let autoInstallAttempted = false;
  createEffect(() => {
    if (!autoInstallRequested || autoInstallAttempted) return;
    if (!workspaceId()) return;
    if (!tcsHandoffSettled()) return;
    if (!sourceGitUrl()) return;
    if (!selectedInstallConfigId()) return;
    autoInstallAttempted = true;
    // Strip `auto=1` from THIS history entry before firing. Otherwise, after
    // the install navigates to the run, a browser Back to /new remounts a fresh
    // component whose per-instance flag is reset and re-fires the whole install
    // (a duplicate Source + sync). A fresh store [追加] pushes a new entry with
    // auto=1, so legitimate re-installs are unaffected.
    if (typeof window !== "undefined") {
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has("auto")) {
          url.searchParams.delete("auto");
          window.history.replaceState(
            window.history.state,
            "",
            url.pathname + url.search + url.hash,
          );
        }
      } catch {
        // history/URL unavailable — the per-instance flag still guards this mount.
      }
    }
    void submitInstall();
  });
  const findExistingCapsule = async (
    workspace: string,
    capsuleName: string,
    environment: string,
    options: { readonly force?: boolean } = {},
  ): Promise<Capsule | null> => {
    const capsules = await listCapsulesCached(workspace, {
      includeDestroyed: false,
      force: options.force,
    });
    return (
      capsules.find(
        (capsule) =>
          capsule.status !== "destroyed" &&
          capsule.name === capsuleName &&
          capsule.environment === environment,
      ) ?? null
    );
  };

  const runCompatibilityCheck = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setCheckingCompatibility(true);
    setError(null);
    setSyncRequired(false);
    setStepSource("running");
    setStepSync("running");
    setStepInstall("idle");
    setStepPlan("idle");
    setSourceSyncRunStatus(null);
    startSourceSyncSlowTimer();
    const flow = startAbortableFlow();
    try {
      await loadProviderConnections().catch(() => []);
      throwIfStaleFlow(flow);
      let result = await checkCapsuleCompatibility({
        workspaceId: workspaceId()!,
        sourceId: createdSourceId() ?? undefined,
        gitUrl: sourceGitUrl(),
        ref: sourceRef(),
        path: installModulePath(),
        name: name().trim(),
        authConnectionId: sourceAuthConnectionIdForRun(),
        installConfigId: selectedInstallConfigId(),
        signal: flow.controller.signal,
        onSourceCreated: (sourceId) => {
          if (isCurrentFlow(flow)) setCreatedSourceId(sourceId);
        },
        onSourceSyncProgress: (progress) => {
          if (!isCurrentFlow(flow)) return;
          if (progress.run?.status) {
            setSourceSyncRunStatus(progress.run.status);
          }
          if (progress.elapsedMs > 8_000) {
            setSourceSyncSlow(true);
          }
        },
      });
      throwIfStaleFlow(flow);
      if (compatibilityCheckLooksTransient(result)) {
        await abortableDelay(1_500, flow.controller.signal);
        throwIfStaleFlow(flow);
        result = await checkCapsuleCompatibility({
          workspaceId: workspaceId()!,
          sourceId: result.sourceId ?? createdSourceId() ?? undefined,
          gitUrl: sourceGitUrl(),
          ref: sourceRef(),
          path: installModulePath(),
          name: name().trim(),
          authConnectionId: sourceAuthConnectionIdForRun(),
          installConfigId: selectedInstallConfigId(),
          signal: flow.controller.signal,
          onSourceCreated: (sourceId) => {
            if (isCurrentFlow(flow)) setCreatedSourceId(sourceId);
          },
          onSourceSyncProgress: (progress) => {
            if (!isCurrentFlow(flow)) return;
            if (progress.run?.status) {
              setSourceSyncRunStatus(progress.run.status);
            }
            if (progress.elapsedMs > 8_000) {
              setSourceSyncSlow(true);
            }
          },
        });
        throwIfStaleFlow(flow);
      }
      if (result.sourceId) {
        setCreatedSourceId(result.sourceId);
      }
      setStepSource("done");
      setStepSync("done");
      setProviderRows(rowsFromCompatibility(result));
      setCompatibility(result);
    } catch (err) {
      if (isAbortError(err) || !isCurrentFlow(flow)) return;
      const apiError = err instanceof ControlApiError ? err : undefined;
      setAppHostnameConflict(false);
      if (apiError?.isSourceSyncRequired) {
        const sourceId = sourceIdFromControlError(apiError);
        if (sourceId) setCreatedSourceId(sourceId);
        setStepSource("done");
        setStepSync("error");
        setSyncRequired(true);
      } else if (apiError?.code === "source_sync_failed") {
        setStepSource("done");
        setStepSync("error");
      } else if (apiError?.isAppHostnameUnavailable) {
        setAppHostnameConflict(true);
        setStepSource("error");
        setStepSync("idle");
      } else {
        setStepSource("error");
        setStepSync("idle");
      }
      setError(
        apiError?.isSourceSyncRequired
          ? t("new.error.syncPending")
          : apiError?.code === "source_sync_failed"
            ? sourceFetchErrorMessage(apiError)
            : addFlowErrorMessage(apiError),
      );
    } finally {
      if (isCurrentFlow(flow)) {
        finishAbortableFlow(flow);
        clearSourceSyncSlowTimer();
        setCheckingCompatibility(false);
      }
    }
  };

  const runFlow = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    await loadProviderConnections().catch(() => []);
    await settleProviderConnectionRows();
    if (!canContinue()) {
      setError(proceedBlocker());
      return;
    }
    setBusy(true);
    setError(null);
    setExistingCapsule(null);
    setSyncRequired(false);
    setSourceSyncRunStatus(null);
    startSourceSyncSlowTimer();
    const flow = startAbortableFlow();
    const workspace = workspaceId()!;
    const flowInput = {
      name: name().trim(),
      gitUrl: sourceGitUrl(),
      ref: sourceRef(),
      path: installModulePath(),
      authConnectionId: sourceAuthConnectionIdForRun(),
      installConfigId:
        compatibility()?.installConfigId ?? selectedInstallConfigId(),
      compatibilityReportId: compatibility()?.reportId,
      vars: installVariables(),
      store: storeMetadataForRun(),
      sourceId: createdSourceId(),
      capsuleId: createdCapsuleId(),
      syncDone: stepSync() === "done",
    };
    try {
      // Step 1 — create Source (skip if a previous attempt already created it).
      let sourceId = flowInput.sourceId;
      if (!sourceId) {
        setStepSource("running");
        const result = await createSource({
          workspaceId: workspace,
          name: flowInput.name,
          url: flowInput.gitUrl,
          defaultRef: flowInput.ref,
          defaultPath: ".",
          autoSync: true,
          authConnectionId: flowInput.authConnectionId,
        });
        throwIfStaleFlow(flow);
        sourceId = result.source.id;
        setCreatedSourceId(sourceId);
        setStepSource("done");
      } else {
        setStepSource("done");
      }

      // Step 2 — sync the Source to resolve an immutable snapshot. When the
      // compatibility check already created and synced the Source, reuse that
      // snapshot instead of adding a second source_sync run.
      if (!flowInput.syncDone) {
        setStepSync("running");
        const syncEnvelope = await syncSource(sourceId, {
          signal: flow.controller.signal,
        });
        throwIfStaleFlow(flow);
        await waitForLatestSourceSnapshot(sourceId, {
          runId: extractRunId(syncEnvelope),
          signal: flow.controller.signal,
          onProgress: (progress) => {
            if (!isCurrentFlow(flow)) return;
            if (progress.run?.status) {
              setSourceSyncRunStatus(progress.run.status);
            }
            if (progress.elapsedMs > 8_000) {
              setSourceSyncSlow(true);
            }
          },
        });
        throwIfStaleFlow(flow);
        setStepSync("done");
      } else {
        setStepSync("done");
      }

      await settleProviderConnectionRows();
      throwIfStaleFlow(flow);
      if (!canContinue()) {
        setStepInstall("idle");
        setStepPlan("idle");
        setError(null);
        return;
      }
      const providerConnectionsForRun = providerConnectionsPayload();

      // Step 3 — create the current compatibility record bound to the chosen
      // service-side config. Public UI presents this as Capsule creation.
      let capsuleId = flowInput.capsuleId;
      if (!capsuleId) {
        setStepInstall("running");
        const existing = await findExistingCapsule(
          workspace,
          flowInput.name,
          "production",
          { force: true },
        ).catch(() => null);
        throwIfStaleFlow(flow);
        if (existing) {
          setStepInstall(INSTALLATION_DONE);
          setStepPlan("idle");
          setExistingCapsule(existing);
          return;
        }
        const capsule = await createCapsule({
          workspaceId: workspace,
          name: flowInput.name,
          environment: "production",
          sourceId,
          installConfigId: flowInput.installConfigId,
          ...(flowInput.path && flowInput.path !== "."
            ? { modulePath: flowInput.path }
            : {}),
          ...(flowInput.vars ? { vars: flowInput.vars } : {}),
          ...(flowInput.store ? { store: flowInput.store } : {}),
          // Store installs opt into auto-update by default (app feel): new
          // source versions re-plan and auto-apply when clean. Link/Git
          // installs stay manual.
          ...(flowInput.store ? { autoUpdate: true } : {}),
        });
        throwIfStaleFlow(flow);
        clearCapsuleListCache(workspace);
        clearCurrentStateVersionCache(workspace);
        clearDashboardOverviewCache(workspace);
        capsuleId = capsule.id;
        setCreatedCapsuleId(capsuleId);
      } else {
        setStepInstall("running");
      }
      await putCapsuleProviderConnectionSet(
        capsuleId,
        providerConnectionsForRun,
      );
      throwIfStaleFlow(flow);
      setStepInstall("done");

      // Step 4 — create the first plan Run, then jump to the run screen.
      setStepPlan("running");
      const planOptions = {
        ...(flowInput.compatibilityReportId
          ? { compatibilityReportId: flowInput.compatibilityReportId }
          : {}),
      };
      const planEnvelope = await planCapsule(capsuleId, planOptions);
      throwIfStaleFlow(flow);
      setStepPlan("done");
      const runId = extractRunId(planEnvelope);
      if (runId) {
        // Install is one action: tell the run screen to auto-continue to apply
        // when the plan is clean (no approval / no destructive change), so the
        // visitor never has to press "deploy" on a plan console.
        const base =
          appendAppHandoff(`/runs/${runId}`, appHandoff) ?? `/runs/${runId}`;
        navigate(base + (base.includes("?") ? "&" : "?") + "auto=install");
      } else {
        navigate("/");
      }
    } catch (err) {
      if (isAbortError(err) || !isCurrentFlow(flow)) {
        return;
      }
      const apiError = err instanceof ControlApiError ? err : undefined;
      setAppHostnameConflict(false);
      if (apiError?.isSourceSyncRequired) {
        setSyncRequired(true);
        setStepSync("error");
        setError(t("new.error.syncPending"));
      } else if (apiError?.code === "source_sync_failed") {
        setStepSync("error");
        setError(sourceFetchErrorMessage(apiError));
      } else if (apiError?.isAppHostnameUnavailable) {
        setAppHostnameConflict(true);
        setError(addFlowErrorMessage(apiError));
      } else if (isDuplicateServiceError(apiError)) {
        setStepPlan("idle");
        const existing = await findExistingCapsule(
          workspace,
          flowInput.name,
          "production",
          { force: true },
        ).catch(() => null);
        throwIfStaleFlow(flow);
        if (existing) {
          setStepInstall(INSTALLATION_DONE);
          setExistingCapsule(existing);
          setError(null);
        } else {
          setStepInstall("error");
          setExistingCapsule(null);
          setError(t("new.error.nameReserved"));
        }
      } else {
        setError(addFlowErrorMessage(apiError));
      }
      if (stepPlan() === "running") setStepPlan("error");
      else if (stepInstall() === "running") setStepInstall("error");
      else if (stepSync() === "running") setStepSync("error");
      else if (stepSource() === "running") setStepSource("error");
    } finally {
      const currentFlow = isCurrentFlow(flow);
      if (currentFlow) {
        finishAbortableFlow(flow);
      }
      if (currentFlow || activeFlowAbort === undefined) {
        clearSourceSyncSlowTimer();
        setBusy(false);
      }
    }
  };

  const stepIcon = (s: StepState): string =>
    s === "done" ? "✓" : s === "error" ? "✕" : s === "running" ? "…" : "·";
  // Text twin of the glyph — "✓"/"·" read as nothing useful (or nonsense) in
  // a screen reader, so the glyph is aria-hidden and this announces instead.
  const stepStateLabel = (s: StepState): string =>
    s === "done"
      ? t("new.step.state.done")
      : s === "error"
        ? t("new.step.state.failed")
        : s === "running"
          ? t("new.step.state.running")
          : t("new.step.state.pending");
  const stepClass = (s: StepState): string =>
    s === "running"
      ? "is-active"
      : s === "done"
        ? "is-done"
        : s === "error"
          ? "is-error"
          : "";
  const showSetupProgress = () =>
    checkingCompatibility() ||
    busy() ||
    sourceSyncSlow() ||
    [stepSource(), stepSync(), stepInstall(), stepPlan()].some(
      (step) => step === "running" || step === "error",
    );

  const gitFields = () => (
    <FormField label={t("new.git.url")}>
      <Input
        id="new-capsule-git-url"
        name="gitUrl"
        type="text"
        value={gitUrl()}
        onInput={(e) => {
          clearSelectedStoreEntry();
          const parsed = parseInstallPrefillFromInput(e.currentTarget.value);
          if (parsed) {
            applyInstallPrefillInput(parsed);
            return;
          }
          setActiveInstallPrefill(null);
          setGitUrl(e.currentTarget.value);
          resetCompatibility();
        }}
        placeholder="https://github.com/your-name/service.git"
        autocomplete="off"
        spellcheck={false}
      />
    </FormField>
  );

  const sourceAccessFields = () => (
    <div class="wb-advanced-group">
      <h4 class="wb-subhead">
        <KeyRound size={15} aria-hidden="true" />
        {t("new.sourceAccess.title")}
      </h4>
      <p class="wb-note">{t("new.sourceAccess.body")}</p>
      <FormField label={t("new.sourceAccess.mode")}>
        <Select
          id="new-source-access-mode"
          name="sourceAccessMode"
          value={sourceAccessMode()}
          onChange={(e) => {
            setSourceAccessMode(e.currentTarget.value as SourceAccessMode);
            setSourceTokenError(null);
            resetCompatibility();
          }}
        >
          <option value="public">{t("new.sourceAccess.public")}</option>
          <option value="existing">{t("new.sourceAccess.existing")}</option>
          <option value="token">{t("new.sourceAccess.token")}</option>
        </Select>
      </FormField>

      <Show when={sourceAccessMode() === "existing"}>
        <FormField label={t("new.sourceAccess.connection")}>
          <Select
            id="new-source-auth-connection"
            name="sourceAuthConnection"
            value={sourceAuthConnectionId()}
            onChange={(e) => {
              setSourceAuthConnectionId(e.currentTarget.value);
              resetCompatibility();
            }}
          >
            <option value="" selected={!sourceAuthConnectionId()}>
              {t("new.sourceAccess.selectConnection")}
            </option>
            <For each={sourceGitConnections()}>
              {(connection) => (
                <option
                  value={connection.id}
                  selected={connection.id === sourceAuthConnectionId()}
                >
                  {sourceConnectionLabel(connection)}
                </option>
              )}
            </For>
          </Select>
        </FormField>
        <Show when={sourceGitConnections().length === 0}>
          <p class="wb-note">{t("new.sourceAccess.noConnections")}</p>
        </Show>
      </Show>

      <Show when={sourceAccessMode() === "token"}>
        <div class="wb-source-token-grid">
          <FormField label={t("new.sourceAccess.username")}>
            <Input
              id="new-source-token-username"
              name="sourceTokenUsername"
              type="text"
              value={sourceTokenUsername()}
              onInput={(e) => setSourceTokenUsername(e.currentTarget.value)}
              placeholder="your-username"
              autocomplete="username"
              spellcheck={false}
            />
          </FormField>
          <FormField label={t("new.sourceAccess.accessToken")} required>
            <Input
              id="new-source-token"
              name="sourceAccessToken"
              type="password"
              value={sourceToken()}
              onInput={(e) => {
                setSourceToken(e.currentTarget.value);
                setSourceTokenError(null);
              }}
              placeholder={t("new.sourceAccess.tokenPlaceholder")}
              autocomplete="new-password"
              spellcheck={false}
            />
          </FormField>
        </div>
        <div class="wb-form-actions wb-source-token-actions">
          <Button
            type="button"
            variant="secondary"
            busy={savingSourceToken()}
            disabled={savingSourceToken()}
            onClick={() => void saveSourceTokenConnection()}
          >
            {t("new.sourceAccess.saveToken")}
          </Button>
        </div>
        <p class="wb-note">{t("new.sourceAccess.tokenBody")}</p>
        <Show when={sourceTokenError()}>
          {(message) => (
            <p class="wb-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </Show>
    </div>
  );

  const sourceDetailFields = () => (
    <div class="wb-advanced-group">
      <h4 class="wb-subhead">{t("new.git.advanced")}</h4>
      <div class="wb-form-row">
        <FormField label={t("new.git.ref")}>
          <Input
            id="new-capsule-ref"
            name="ref"
            type="text"
            value={ref()}
            onInput={(e) => {
              clearSelectedStoreEntry();
              setPinnedFullRef(null);
              setRef(e.currentTarget.value);
              resetCompatibility();
            }}
            placeholder="main"
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
        <FormField label={t("new.git.path")}>
          <Input
            id="new-capsule-path"
            name="path"
            type="text"
            value={path()}
            onInput={(e) => {
              clearSelectedStoreEntry();
              setPath(e.currentTarget.value);
              resetCompatibility();
            }}
            placeholder="."
            autocomplete="off"
            spellcheck={false}
          />
        </FormField>
      </div>
    </div>
  );

  const prefilledLinkReview = () => {
    const capsule = capsuleNameFromUrl(sourceGitUrl());
    return (
      <section class="av-link-review" aria-label={t("new.deeplink.aria")}>
        <div class="av-link-review-icon" aria-hidden="true">
          <Download size={20} />
        </div>
        <div class="av-link-review-main">
          <span class="av-link-review-kicker">{t("new.deeplink.kicker")}</span>
          <h3>{t("new.deeplink.title", { capsule })}</h3>
          <p>{t("new.deeplink.body")}</p>
          <dl class="av-link-review-meta">
            <div>
              <dt>{t("new.deeplink.source")}</dt>
              <dd>{sourceHostLabel(sourceGitUrl())}</dd>
            </div>
            <div>
              <dt>{t("new.deeplink.version")}</dt>
              <dd>{displayRef(sourceRef())}</dd>
            </div>
            <div>
              <dt>{t("new.deeplink.folder")}</dt>
              <dd>{displayModulePath(sourcePath())}</dd>
            </div>
          </dl>
        </div>
      </section>
    );
  };
  const addSummaryTitle = () =>
    selectedServiceEntry()?.name[locale()] ||
    name().trim() ||
    capsuleNameFromUrl(sourceGitUrl()) ||
    t("new.advancedImport.title");
  const addSummaryDescription = () =>
    selectedServiceEntry()?.description[locale()] ||
    (activeTab() === "git"
      ? t("new.advancedImport.subtitle")
      : t("new.selection.subtitle"));
  const addSummaryProvider = () =>
    selectedServiceEntry()
      ? providerDisplayName(selectedServiceEntry()!.provider)
      : sourceHostLabel(sourceGitUrl());

  return (
    <>
      <Show
        when={workspaceId()}
        fallback={
          <NoWorkspaceStartPanel
            busy={createFirstWorkspace.busy()}
            error={createFirstWorkspace.error()}
            onCreate={() => void createFirstWorkspace.run()}
          />
        }
      >
        <h1 class="sr-only">{t("new.title")}</h1>

        <Show when={installPrefillRejected}>
          <div class="wb-action-callout" role="alert">
            <strong>{t("new.deeplink.invalidTitle")}</strong>
            <p>{t("new.deeplink.invalidBody")}</p>
          </div>
        </Show>

        <Show when={appHandoff}>
          {(handoff) => (
            <div class="wb-action-callout wb-app-handoff" role="status">
              <div>
                <span class="wb-app-handoff-kicker">
                  {t("new.appHandoff.kicker")}
                </span>
                <strong>
                  {t("new.appHandoff.title", {
                    app: appHandoffProductLabel(handoff().product),
                  })}
                </strong>
              </div>
              <p>{t("new.appHandoff.body")}</p>
              <dl class="wb-app-handoff-meta">
                <div>
                  <dt>{t("new.appHandoff.app")}</dt>
                  <dd>{appHandoffProductLabel(handoff().product)}</dd>
                </div>
                <div>
                  <dt>{t("new.appHandoff.return")}</dt>
                  <dd>
                    <code>{handoff().returnUri}</code>
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </Show>

        <Show when={!hasChosenSource()}>
          <section
            class="av-add-discovery"
            aria-label={t("new.discovery.aria")}
          >
            <header class="av-add-discovery-head">
              <div class="av-add-discovery-title">
                <span class="av-add-discovery-icon" aria-hidden="true">
                  <Search size={22} />
                </span>
                <div>
                  <h2>{t("new.discovery.title")}</h2>
                  <p>{t("new.discovery.subtitle")}</p>
                </div>
              </div>
            </header>
            <StoreBrowser
              locale={locale()}
              onConfigure={pickStoreListing}
              showSourceControls={true}
              showSortControl={false}
            />
            <div class="av-manual-entry">
              <p class="av-manual-entry-lead">
                {t("new.discovery.manualLead")}
              </p>
              <details class="wb-disclosure av-manual-entry-details">
                <summary>{t("new.discovery.manualToggle")}</summary>
                <form
                  class="av-link-entry"
                  onSubmit={(event) => {
                    event.preventDefault();
                    startLinkImport();
                  }}
                >
                  <Input
                    id="new-service-link"
                    name="serviceLink"
                    type="text"
                    value={linkDraft()}
                    onInput={(event) => setLinkDraft(event.currentTarget.value)}
                    placeholder={t("new.discovery.linkPlaceholder")}
                    autocomplete="off"
                    spellcheck={false}
                  />
                  <Button variant="primary" type="submit">
                    {t("new.discovery.linkCta")}
                  </Button>
                </form>
              </details>
            </div>
          </section>
        </Show>

        <Show when={hasChosenSource()}>
          <section class="av-add-flow" aria-label={t("new.title")}>
            <div class="av-add-flow-header">
              <div class="av-add-flow-selected">
                <div class="av-add-flow-icon" aria-hidden="true">
                  <Show
                    when={selectedServiceEntry()}
                    fallback={<Download size={22} />}
                  >
                    {(entry) => <StoreIcon entry={entry()} />}
                  </Show>
                </div>
                <div class="av-add-flow-copy">
                  <span class="av-add-flow-kicker">
                    {usingSelectedService()
                      ? t("new.flow.selected")
                      : t("new.flow.manual")}
                  </span>
                  <h2>
                    {usingSelectedService()
                      ? (selectedServiceEntry()?.name[locale()] ??
                        sourceSummaryTitle())
                      : t("new.advancedImport.title")}
                  </h2>
                  <p>
                    {usingSelectedService()
                      ? (selectedServiceEntry()?.description[locale()] ??
                        t("new.selection.subtitle"))
                      : t("new.advancedImport.subtitle")}
                  </p>
                </div>
              </div>
            </div>
            <div class="av-add-flow-body">
              <form
                class="wb-install-form wb-install-source-form av-add-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitInstall();
                }}
              >
                <Show when={!usingSelectedService()}>
                  {activeInstallPrefill() ? prefilledLinkReview() : gitFields()}
                </Show>

                <Show when={selectedServiceEntry()}>
                  {(entry) => (
                    <section class="av-service-setup">
                      <div class="av-service-setup-head">
                        <h3>{t("new.storeInput.title")}</h3>
                        <p>{t("new.storeInput.subtitle")}</p>
                      </div>
                      <div class="av-service-setup-grid">
                        <FormField label={t("new.name")}>
                          <Input
                            id="new-capsule-name"
                            name="name"
                            type="text"
                            value={name()}
                            onInput={(e) => {
                              setName(e.currentTarget.value);
                              resetCompatibility();
                            }}
                            placeholder="photo-blog"
                            autocomplete="off"
                            spellcheck={false}
                          />
                        </FormField>
                        <For each={visibleStoreInputs(entry())}>
                          {(field) => (
                            <FormField
                              label={
                                field.type === "boolean"
                                  ? undefined
                                  : field.label[locale()]
                              }
                              hint={field.helper?.[locale()]}
                              required={field.required}
                            >
                              <Show
                                when={field.type === "boolean"}
                                fallback={
                                  <Input
                                    id={`store-input-${entry().id}-${field.name}`}
                                    name={`storeInput:${field.name}`}
                                    type={field.secret ? "password" : "text"}
                                    invalid={
                                      appHostnameConflict() &&
                                      isStorePublicEndpointField(entry(), field)
                                    }
                                    value={storeInputValue(entry(), field)}
                                    onInput={(e) =>
                                      updateStoreInputValue(
                                        entry(),
                                        field,
                                        e.currentTarget.value,
                                      )
                                    }
                                    placeholder={field.placeholder ?? ""}
                                    autocomplete={
                                      field.secret ? "new-password" : "off"
                                    }
                                    spellcheck={false}
                                  />
                                }
                              >
                                <Checkbox
                                  id={`store-input-${entry().id}-${field.name}`}
                                  name={`storeInput:${field.name}`}
                                  label={field.label[locale()]}
                                  checked={storeInputBooleanChecked(
                                    entry(),
                                    field,
                                  )}
                                  onChange={(e) =>
                                    updateStoreInputValue(
                                      entry(),
                                      field,
                                      e.currentTarget.checked
                                        ? "true"
                                        : "false",
                                    )
                                  }
                                />
                              </Show>
                            </FormField>
                          )}
                        </For>
                      </div>
                    </section>
                  )}
                </Show>

                <Show when={!selectedServiceEntry()}>
                  <FormField label={t("new.name")}>
                    <Input
                      id="new-capsule-name"
                      name="name"
                      type="text"
                      value={name()}
                      onInput={(e) => {
                        setName(e.currentTarget.value);
                        resetCompatibility();
                      }}
                      placeholder="photo-blog"
                      autocomplete="off"
                      spellcheck={false}
                    />
                  </FormField>
                </Show>

                <details
                  class="wb-disclosure wb-input-vars"
                  open={
                    shouldOpenServiceAdvanced() ||
                    hasMissingAdvancedStoreInputs() ||
                    sourceAccessMode() !== "public"
                  }
                >
                  <summary>{t("new.advanced.title")}</summary>
                  <Show when={!usingSelectedService()}>
                    <Show when={activeInstallPrefill()}>{gitFields()}</Show>
                    {sourceAccessFields()}
                    {sourceDetailFields()}
                  </Show>
                  <Show when={selectedServiceEntry()}>
                    {(entry) => (
                      <Show when={advancedStoreInputs(entry()).length > 0}>
                        <section class="wb-stack">
                          <For each={advancedStoreInputs(entry())}>
                            {(field) => (
                              <FormField
                                label={
                                  field.type === "boolean"
                                    ? undefined
                                    : field.label[locale()]
                                }
                                hint={field.helper?.[locale()]}
                                required={field.required}
                              >
                                <Show
                                  when={field.type === "boolean"}
                                  fallback={
                                    <Input
                                      id={`store-input-advanced-${entry().id}-${field.name}`}
                                      name={`storeInputAdvanced:${field.name}`}
                                      type={field.secret ? "password" : "text"}
                                      invalid={
                                        appHostnameConflict() &&
                                        isStorePublicEndpointField(
                                          entry(),
                                          field,
                                        )
                                      }
                                      value={storeInputValue(entry(), field)}
                                      onInput={(e) =>
                                        updateStoreInputValue(
                                          entry(),
                                          field,
                                          e.currentTarget.value,
                                        )
                                      }
                                      placeholder={field.placeholder ?? ""}
                                      autocomplete={
                                        field.secret ? "new-password" : "off"
                                      }
                                      spellcheck={false}
                                    />
                                  }
                                >
                                  <Checkbox
                                    id={`store-input-advanced-${entry().id}-${field.name}`}
                                    name={`storeInputAdvanced:${field.name}`}
                                    label={field.label[locale()]}
                                    checked={storeInputBooleanChecked(
                                      entry(),
                                      field,
                                    )}
                                    onChange={(e) =>
                                      updateStoreInputValue(
                                        entry(),
                                        field,
                                        e.currentTarget.checked
                                          ? "true"
                                          : "false",
                                      )
                                    }
                                  />
                                </Show>
                              </FormField>
                            )}
                          </For>
                        </section>
                      </Show>
                    )}
                  </Show>
                  <Show when={supportsServiceNameInput()}>
                    <FormField label={t("new.vars.projectName")}>
                      <Input
                        ref={serviceNameInput}
                        id="new-project-name"
                        name={
                          serviceNameVariableForCurrentSource() ??
                          "service_name"
                        }
                        type="text"
                        invalid={appHostnameConflict()}
                        value={serviceNameInputValue()}
                        onInput={(e) => {
                          setResourcePrefixTouched(true);
                          setResourcePrefix(e.currentTarget.value);
                          resetCompatibility();
                        }}
                        placeholder="photo-blog"
                        autocomplete="off"
                        spellcheck={false}
                      />
                      <Show when={managedHostPreview()}>
                        {(host) => (
                          <p class="wb-note">
                            {t("new.hostPreview", { host: host() })}
                          </p>
                        )}
                      </Show>
                    </FormField>
                  </Show>
                  <section class="wb-stack">
                    <h3 class="tg-card-title">{t("new.env.title")}</h3>
                    <p class="wb-note">{t("new.env.body")}</p>
                    <div class="wb-variable-list">
                      {/* <Index>: rows are replaced per keystroke, so <For>
                          (reference-keyed) would recreate the focused input on
                          every character. */}
                      <Index each={envVariables()}>
                        {(row, index) => (
                          <div class="wb-variable-row">
                            <FormField label={t("new.env.name")}>
                              <Input
                                id={`new-env-name-${index}`}
                                name={`envName:${index}`}
                                type="text"
                                value={row().name}
                                onInput={(e) =>
                                  updateEnvVariable(index, {
                                    name: e.currentTarget.value,
                                  })
                                }
                                placeholder="APP_PUBLIC_URL"
                                autocomplete="off"
                                autocapitalize="characters"
                                spellcheck={false}
                              />
                            </FormField>
                            <FormField label={t("new.env.value")}>
                              <Input
                                id={`new-env-value-${index}`}
                                name={`envValue:${index}`}
                                type="text"
                                value={row().value}
                                onInput={(e) =>
                                  updateEnvVariable(index, {
                                    value: e.currentTarget.value,
                                  })
                                }
                                placeholder={t("new.env.valuePlaceholder")}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                            <Button
                              type="button"
                              variant="ghost"
                              icon={<Trash size={16} />}
                              onClick={() => removeEnvVariable(index)}
                            >
                              {t("new.env.remove")}
                            </Button>
                          </div>
                        )}
                      </Index>
                    </div>
                    <div class="wb-form-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        icon={<Plus size={16} />}
                        onClick={addEnvVariable}
                      >
                        {t("new.env.add")}
                      </Button>
                    </div>
                    <Show when={envVariableError()}>
                      {(message) => (
                        <p class="wb-error" role="alert">
                          {message()}
                        </p>
                      )}
                    </Show>
                  </section>
                  <section class="wb-stack">
                    <h3 class="tg-card-title">{t("new.vars.inputsTitle")}</h3>
                    <p class="wb-note">{t("new.vars.inputsBody")}</p>
                    <div class="wb-variable-list">
                      {/* <Index> for the same per-keystroke focus reason as
                          the env editor above. */}
                      <Index each={inputVariables()}>
                        {(row, index) => (
                          <div class="wb-variable-row">
                            <FormField label={t("new.vars.inputName")}>
                              <Input
                                id={`new-var-name-${index}`}
                                name={`varName:${index}`}
                                type="text"
                                value={row().name}
                                onInput={(e) =>
                                  updateInputVariable(index, {
                                    name: e.currentTarget.value,
                                  })
                                }
                                placeholder={t("new.vars.namePlaceholder")}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                            <FormField label={t("new.vars.inputValue")}>
                              <Input
                                id={`new-var-value-${index}`}
                                name={`varValue:${index}`}
                                type="text"
                                value={row().value}
                                onInput={(e) =>
                                  updateInputVariable(index, {
                                    value: e.currentTarget.value,
                                  })
                                }
                                placeholder={t("new.vars.valuePlaceholder")}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                            <Button
                              type="button"
                              variant="ghost"
                              icon={<Trash size={16} />}
                              onClick={() => removeInputVariable(index)}
                            >
                              {t("new.vars.removeInput")}
                            </Button>
                          </div>
                        )}
                      </Index>
                    </div>
                    <div class="wb-form-actions">
                      <Button
                        type="button"
                        variant="secondary"
                        icon={<Plus size={16} />}
                        onClick={addInputVariable}
                      >
                        {t("new.vars.addInput")}
                      </Button>
                    </div>
                    <Show when={inputVariableError()}>
                      {(message) => (
                        <p class="wb-error" role="alert">
                          {message()}
                        </p>
                      )}
                    </Show>
                  </section>
                </details>

                <Show
                  when={
                    checkingCompatibility() ||
                    (busy() && stepSync() === "running")
                  }
                >
                  <div class="wb-status-panel" role="status" aria-live="polite">
                    <strong>{t("new.progress.title")}</strong>
                    <p>
                      {sourceSyncSlow()
                        ? t("new.progress.slow")
                        : t("new.progress.fetching")}
                    </p>
                    <Show when={sourceSyncRunStatus()}>
                      {(status) => (
                        <details class="wb-inline-details">
                          <summary>{t("new.progress.details")}</summary>
                          <span class="wb-status-meta">
                            {t("new.progress.status", {
                              status: runStatusLabel(status()),
                            })}
                          </span>
                        </details>
                      )}
                    </Show>
                  </div>
                </Show>

                <Show when={compatibility()}>
                  {(result) => (
                    <>
                      {shouldShowCompatibilityPanel(result()) ? (
                        <section class="wb-inline-panel">
                          <div class="wb-compat-head">
                            <h3 class="tg-card-title">
                              {t("new.compat.title")}
                            </h3>
                            <Badge tone={compatibilityTone(result().level)}>
                              {compatibilityLabel(result().level)}
                            </Badge>
                          </div>
                          <p class="wb-compat-summary">
                            {result().level === "ready" ||
                            result().level === "auto_capsulized"
                              ? t("new.compat.readyBrief")
                              : compatibilitySummaryDisplay(result())}
                          </p>
                          <Show when={result().level === "needs_patch"}>
                            <p class="wb-note">{t("new.compat.patchHelp")}</p>
                          </Show>
                          <Show when={result().diagnostics.length > 0}>
                            <details class="wb-disclosure">
                              <summary>{t("new.compat.details")}</summary>
                              <ul class="wb-diagnostics">
                                <For each={result().diagnostics}>
                                  {(diagnostic) => {
                                    const display =
                                      compatibilityDiagnosticDisplay(
                                        diagnostic,
                                      );
                                    return (
                                      <li
                                        class={`wb-diagnostic wb-diagnostic-${diagnostic.severity}`}
                                      >
                                        <Show when={display.technical}>
                                          <span class="wb-diagnostic-tech muted">
                                            {t(
                                              "new.compat.diagnostic.technicalNote",
                                            )}{" "}
                                          </span>
                                        </Show>
                                        {display.message}
                                        <Show when={display.detail}>
                                          {(detail) => (
                                            <span class="muted">
                                              {" "}
                                              — {detail()}
                                            </span>
                                          )}
                                        </Show>
                                      </li>
                                    );
                                  }}
                                </For>
                              </ul>
                            </details>
                          </Show>
                        </section>
                      ) : (
                        <p class="wb-ready-note">
                          <Badge tone="ok">
                            {compatibilityLabel(result().level)}
                          </Badge>
                          <span>{t("new.compat.readyBrief")}</span>
                        </p>
                      )}
                    </>
                  )}
                </Show>

                <Show
                  when={
                    compatibility() && providerRowsRequiringChoice().length > 0
                  }
                >
                  <section class="wb-inline-panel">
                    <div class="wb-compat-head">
                      <h3 class="tg-card-title">{t("new.providers.title")}</h3>
                    </div>
                    <div class="wb-provider-grid">
                      <For each={providerRowsRequiringChoice()}>
                        {(row, index) => {
                          const options = () => providerConnectionsForRow(row);
                          return (
                            <div class="wb-provider-row">
                              <div class="wb-provider-meta">
                                <span class="wb-provider-title">
                                  {providerLabel(row.provider)}
                                </span>
                                <Show when={row.alias}>
                                  <span class="muted">
                                    {t("new.providers.alias", {
                                      alias: row.alias,
                                    })}
                                  </span>
                                </Show>
                              </div>
                              <Select
                                id={`provider-connection-${index()}`}
                                name={`providerConnection:${row.provider}:${row.alias ?? "default"}`}
                                aria-label={`${providerLabel(row.provider)} ${row.alias ? t("new.providers.alias", { alias: row.alias }) : ""} ${t("new.providers.selectConnection")}`.trim()}
                                value={row.connectionId}
                                onChange={(e) =>
                                  updateProviderRow(row, {
                                    connectionId: e.currentTarget.value,
                                  })
                                }
                              >
                                <option value="" selected={!row.connectionId}>
                                  {t("new.providers.selectConnection")}
                                </option>
                                <For each={options()}>
                                  {(connection) => (
                                    <option
                                      value={connection.id}
                                      selected={
                                        connection.id === row.connectionId
                                      }
                                    >
                                      {providerConnectionLabel(connection)}
                                    </option>
                                  )}
                                </For>
                              </Select>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                    <Show when={providerConnectionError()}>
                      {(m) => (
                        <p class="wb-error" role="alert">
                          {m()}
                        </p>
                      )}
                    </Show>
                    <Show when={missingProviderRows().length > 0}>
                      <div class="wb-action-callout" role="note">
                        <strong>{t("new.providers.missingTitle")}</strong>
                        <p>{t("new.providers.missingBody")}</p>
                        <ul>
                          <For each={missingProviderRows()}>
                            {(row) => <li>{providerLabel(row.provider)}</li>}
                          </For>
                        </ul>
                        <Button
                          variant="secondary"
                          size="sm"
                          href={providerConnectionsHref()}
                        >
                          {t("new.providers.setupMissing")}
                        </Button>
                        <p class="muted">{t("new.providers.returnNote")}</p>
                      </div>
                    </Show>
                  </section>
                </Show>

                <Show when={installConfigs.error}>
                  <div class="wb-action-callout" role="alert">
                    <strong>{t("new.error.configLoadFailed")}</strong>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => void refetchInstallConfigs()}
                    >
                      {t("common.retry")}
                    </Button>
                  </div>
                </Show>

                <div class="wb-form-actions">
                  <Button
                    variant="primary"
                    type="submit"
                    busy={checkingCompatibility() || busy()}
                    disabled={
                      checkingCompatibility() ||
                      busy() ||
                      installConfigLoading() ||
                      (compatibility() !== null && !canContinue())
                    }
                  >
                    {checkingCompatibility()
                      ? t("new.compat.checking")
                      : busy()
                        ? t("new.installing")
                        : installConfigLoading()
                          ? t("common.loading")
                          : t("new.installCta")}
                  </Button>
                  <Show
                    when={
                      compatibility() && !checkingCompatibility() && !busy()
                    }
                  >
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => void runCompatibilityCheck()}
                    >
                      {t("new.compat.recheck")}
                    </Button>
                  </Show>
                  <Show when={syncRequired() && !busy()}>
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={retryAfterSyncWait}
                    >
                      {t("common.retry")}
                    </Button>
                  </Show>
                </div>

                <Show when={error()}>
                  {(m) => (
                    <p class="wb-error" role="alert">
                      {m()}
                    </p>
                  )}
                </Show>
                <Show
                  when={appHostnameConflict() && canSuggestPublicHostname()}
                >
                  <div class="wb-action-callout" role="note">
                    <strong>{t("new.hostnameConflict.title")}</strong>
                    <p>{t("new.hostnameConflict.body")}</p>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={useSuggestedServiceName}
                    >
                      {t("new.hostnameConflict.suggest")}
                    </Button>
                  </div>
                </Show>
                <Show when={existingCapsule()}>
                  {(capsule) => (
                    <div class="wb-action-callout" role="status">
                      <strong>{t("new.existing.title")}</strong>
                      <p>
                        {t("new.existing.body", {
                          name: capsule().name,
                          environment: capsule().environment,
                        })}
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        href={`/services/${encodeURIComponent(capsule().id)}`}
                      >
                        {t("new.existing.open")}
                      </Button>
                    </div>
                  )}
                </Show>
              </form>

              <aside class="av-add-summary" aria-label={t("new.summary.aria")}>
                <div class="av-add-summary-card">
                  <div class="av-add-summary-head">
                    <span class="av-add-summary-icon" aria-hidden="true">
                      <Show
                        when={selectedServiceEntry()}
                        fallback={<Download size={22} />}
                      >
                        {(entry) => <StoreIcon entry={entry()} />}
                      </Show>
                    </span>
                    <div>
                      <span class="av-add-summary-kicker">
                        {usingSelectedService()
                          ? t("new.flow.selected")
                          : t("new.flow.manual")}
                      </span>
                      <h3>{addSummaryTitle()}</h3>
                    </div>
                  </div>
                  <p>{addSummaryDescription()}</p>
                  <dl class="av-add-summary-meta">
                    <div>
                      <dt>
                        {usingSelectedService()
                          ? t("new.summary.provider")
                          : t("new.deeplink.source")}
                      </dt>
                      <dd>{addSummaryProvider()}</dd>
                    </div>
                    <Show when={!usingSelectedService()}>
                      <div>
                        <dt>{t("new.deeplink.version")}</dt>
                        <dd>{displayRef(sourceRef())}</dd>
                      </div>
                      <div>
                        <dt>{t("new.deeplink.folder")}</dt>
                        <dd>{displayModulePath(sourcePath())}</dd>
                      </div>
                    </Show>
                  </dl>
                </div>

                <Show when={showSetupProgress()} fallback={null}>
                  <details class="wb-disclosure av-add-technical">
                    <summary>{t("new.step.technical")}</summary>
                    <ol class="wb-steps">
                      <li class={`wb-step ${stepClass(stepSource())}`}>
                        <span class="wb-step-icon" aria-hidden="true">
                          {stepIcon(stepSource())}
                        </span>
                        <span class="sr-only">
                          {stepStateLabel(stepSource())}
                        </span>
                        {t("new.step.register")}
                      </li>
                      <li class={`wb-step ${stepClass(stepSync())}`}>
                        <span class="wb-step-icon" aria-hidden="true">
                          {stepIcon(stepSync())}
                        </span>
                        <span class="sr-only">
                          {stepStateLabel(stepSync())}
                        </span>
                        {t("new.step.sync")}
                      </li>
                      <li class={`wb-step ${stepClass(stepInstall())}`}>
                        <span class="wb-step-icon" aria-hidden="true">
                          {stepIcon(stepInstall())}
                        </span>
                        <span class="sr-only">
                          {stepStateLabel(stepInstall())}
                        </span>
                        {t("new.step.create")}
                      </li>
                      <li class={`wb-step ${stepClass(stepPlan())}`}>
                        <span class="wb-step-icon" aria-hidden="true">
                          {stepIcon(stepPlan())}
                        </span>
                        <span class="sr-only">
                          {stepStateLabel(stepPlan())}
                        </span>
                        {t("new.step.plan")}
                      </li>
                    </ol>
                  </details>
                </Show>
              </aside>
            </div>
          </section>
        </Show>
      </Show>
    </>
  );
}
