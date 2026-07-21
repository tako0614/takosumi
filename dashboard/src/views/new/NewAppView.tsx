/**
 * ストア (`/new`) — the single discovery + add surface. This is the primary
 * store tab: browsing the decentralized Takosumi store(s) and adding what you
 * pick are ONE page, not a store page that bounces to a separate add page.
 * Picking a listing swaps this same page from the store grid to the install
 * flow; there is no second store listing anywhere in the dashboard.
 *
 * Whether a Capsule can be added without user configuration is decided by this
 * flow against the real repository-owned metadata. A listing says
 * nothing about build or deploy duration: the store feed strips the input
 * schema and makes no client-side readiness or speed claim.
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
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  ArrowLeft,
  Cloud,
  Download,
  Globe2,
  HardDrive,
  KeyRound,
  Package,
  Search,
  Plus,
  Trash,
} from "lucide-solid";
import {
  isPublicManagedProviderConnection,
  installExperienceInitialSecret,
  installExperiencePublicEndpoint,
  installExperienceServiceNameVariable,
  type JsonValue,
  type ManagedPublicHostnameMode,
} from "takosumi-contract";
import Page from "../account/components/auth/Page.tsx";
import {
  currentWorkspaceId,
  selectAvailableWorkspaceId,
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
  type ProviderBindings,
  type Capsule,
  type CapsuleCompatibilityDiagnostic,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  listProviderConnections,
  listConnections,
  planCapsule,
  putCapsuleProviderBindingSet,
  revokeConnection,
  syncSource,
  testConnection,
  waitForLatestSourceSnapshot,
  type CapsuleCompatibilityProvider,
  type ProviderConnection,
  type RunStatus,
  type Workspace,
} from "../../lib/control-api.ts";
import { locale, t } from "../../i18n/index.ts";
import { StoreBrowser } from "../store/StoreBrowser.tsx";
import { buildNewQuery } from "../store/store-link.ts";
import { consumeAutoInstallToken } from "../../lib/auto-install-handoff.ts";
import { fetchTcsListing, type TcsListing } from "../../lib/tcs-client.ts";
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
  Spinner,
  Toast,
  type Tone,
} from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { friendlyError } from "../../lib/error-copy.ts";

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
  CAPSULE_NAME_PATTERN,
  CAPSULE_DONE,
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
  isSafePlainEnvName,
  storeKindFromStoreListing,
  storeSurfaceFromStoreListing,
  safeStoreToken,
  nonEmptyStoreText,
  storeInstallConfigsForSource,
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
 * Pick-busy live region. Mounted EMPTY and filled a microtask later (the
 * Toast pattern in components/ui/Toast.tsx): live regions only announce text
 * that changes inside an already-mounted region, and this panel used to mount
 * together with its content — most screen readers never announced it. The
 * Spinner is aria-hidden within this panel: it carries its own role=status,
 * which would nest a second live region inside this one.
 */
function StorePickBusyStatus() {
  const [announce, setAnnounce] = createSignal(false);
  onMount(() => queueMicrotask(() => setAnnounce(true)));
  return (
    <div
      class="wb-status-panel av-pick-status"
      role="status"
      aria-live="polite"
    >
      <Show when={announce()}>
        <span aria-hidden="true" style="display:inline-flex">
          <Spinner size={16} />
        </span>
        <strong>{t("new.pick.checking")}</strong>
      </Show>
    </div>
  );
}

/**
 * A polite live region that mounts EMPTY, then reveals its content a microtask
 * later (same idiom as StorePickBusyStatus). A screen reader only announces
 * text that changes INSIDE an already-mounted live region, so a region that
 * mounts together with its content is silent — this fills after mount so the
 * status is spoken.
 */
function AnnouncedStatus(props: {
  readonly class?: string;
  readonly children: JSX.Element;
}) {
  const [announce, setAnnounce] = createSignal(false);
  onMount(() => queueMicrotask(() => setAnnounce(true)));
  return (
    <div class={props.class} role="status" aria-live="polite">
      <Show when={announce()}>{props.children}</Show>
    </div>
  );
}

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
    default:
      return <Package size={20} />;
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
  const { confirm } = useConfirmDialog();

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
  // The query is NOT the authority for that: `auto`, `tcsBase` and `tcsListing`
  // are all forgeable, so an EXTERNAL link (`/install?git=…` or a hand-crafted
  // `/new?git=…&auto=1&tcsBase=…&tcsListing=…`) could otherwise register and
  // deploy an attacker-chosen repo into the user's workspace with no Add click.
  // Only a one-shot sessionStorage token minted by our own store CTA in this
  // tab arms it; everything else stays pre-fill only.
  const autoInstallRequested =
    new URLSearchParams(initialSearch).get("auto") === "1" &&
    initialTcsHandoff !== null &&
    consumeAutoInstallToken(initialSearch);
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
  // Store-card pick preparation: visible busy state while the hand-off is
  // normalized, and the last failed pick so discovery can offer a retry.
  const [storePickBusy, setStorePickBusy] = createSignal(false);
  const [failedStorePick, setFailedStorePick] = createSignal<TcsListing | null>(
    null,
  );
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
  // True only after the visitor edits the display-name field themselves — a
  // store pick auto-fills setName() with the suggested name, which must not
  // count as meaningful input for the 選び直す discard guard.
  const [nameTouched, setNameTouched] = createSignal(false);
  // The derived service identity (display name + public subdomain) renders as
  // one read-only URL line until the user asks to change it.
  const [identityOpen, setIdentityOpen] = createSignal(false);
  const [resourcePrefix, setResourcePrefix] = createSignal("");
  const [resourcePrefixTouched, setResourcePrefixTouched] = createSignal(false);
  const [managedPublicHostnameMode, setManagedPublicHostnameMode] =
    createSignal<ManagedPublicHostnameMode>("scoped");
  const [inputVariables, setInputVariables] = createSignal<
    readonly InputVariableRow[]
  >([]);
  const [envVariables, setEnvVariables] = createSignal<
    readonly EnvVariableRow[]
  >([]);
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [appHostnameConflict, setAppHostnameConflict] = createSignal(false);
  const [providerRows, setProviderRows] = createSignal<ProviderConnectionRow[]>(
    [],
  );
  let serviceNameInput: HTMLInputElement | undefined;
  // Focus targets: 選び直す moves focus back to the discovery heading, and a
  // successful store pick moves it to the mounted chosen-flow section —
  // otherwise focus falls to <body> when the previously-focused control
  // unmounts, stranding keyboard and screen-reader users.
  let discoveryHeading: HTMLHeadingElement | undefined;
  let chosenFlowSection: HTMLElement | undefined;

  const workspaceId = () =>
    currentWorkspaceId() ? currentWorkspaceId() : null;
  // This page is the store tab, so it is a normal first landing spot with no
  // Workspace selected yet (a fresh browser, a store deep link). Recover the
  // selection here instead of showing 最初のワークスペースを作成 to someone who
  // already has one; `resolvingWorkspace` keeps that panel hidden until we
  // actually know there is none.
  const [resolvingWorkspace, setResolvingWorkspace] =
    createSignal(!currentWorkspaceId());
  onMount(async () => {
    if (!resolvingWorkspace()) return;
    try {
      const workspaces = await listWorkspacesCached();
      const chosen = selectAvailableWorkspaceId(
        currentWorkspaceId(),
        workspaces,
      );
      if (chosen) setCurrentWorkspaceId(chosen);
    } catch {
      // The shell workspace switcher and the create action below cover this.
    } finally {
      setResolvingWorkspace(false);
    }
  });
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
    readonly ProviderConnection[] | null
  >(null);
  const [providerConnections, setProviderConnections] = createSignal<
    readonly ProviderConnection[] | null
  >(null);
  // A transient 5xx while loading Provider Connections must not masquerade as
  // "no connections" (which would show the false クラウド接続が必要です blocker).
  // Track the fetch error so the panel can offer a retry instead.
  const [providerConnectionsLoadError, setProviderConnectionsLoadError] =
    createSignal<unknown>(null);
  let loadedWorkspaceId: string | null = null;
  let connectionsPromise: Promise<readonly ProviderConnection[]> | null = null;
  let providerConnectionsPromise: Promise<
    readonly ProviderConnection[]
  > | null = null;

  const resetLazyWorkspaceData = () => {
    connectionsPromise = null;
    providerConnectionsPromise = null;
    setConnections(null);
    setProviderConnections(null);
    setProviderConnectionsLoadError(null);
  };

  const loadConnections = async (
    options: { readonly force?: boolean } = {},
  ): Promise<readonly ProviderConnection[]> => {
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
        if (workspaceId() === current) {
          setProviderConnections(items);
          setProviderConnectionsLoadError(null);
        }
        return items;
      })
      .catch((err) => {
        if (workspaceId() === current) setProviderConnectionsLoadError(err);
        throw err;
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
      (config) => config.name === "opentofu-capsule" && !config.store,
    );
  const sourceCoordinateForInstallConfig = () => {
    const prefill = activeInstallPrefill();
    return {
      url: prefill?.git ?? gitUrl().trim(),
      path: prefill?.path || path().trim() || ".",
    };
  };
  const installConfigsForCurrentSource = () => {
    const coordinate = sourceCoordinateForInstallConfig();
    return storeInstallConfigsForSource(
      installConfigList(),
      coordinate.url,
      coordinate.path,
    );
  };
  const ensureConfigSelected = () => {
    const list = installConfigList();
    if (list.length === 0) return list;
    const sourceMatches = installConfigsForCurrentSource();
    const desiredId =
      sourceMatches.length === 1
        ? sourceMatches[0]!.id
        : sourceMatches.length === 0
          ? (defaultGitInstallConfig()?.id ?? "")
          : "";
    const current = installConfigId();
    if (current !== desiredId) setInstallConfigId(desiredId);
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
  createEffect(() => {
    sourceCoordinateForInstallConfig();
    installConfigList();
    ensureConfigSelected();
  });
  const genericInstallConfigForSource = (): InstallConfig =>
    defaultGitInstallConfig() ?? {
      id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
      name: "opentofu-capsule",
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: "",
      updatedAt: "",
    };
  const installConfigForStoreListing = (
    listing: TcsListing,
  ): InstallConfig | null => {
    const matches = storeInstallConfigsForSource(
      installConfigList(),
      listing.source.url,
      listing.source.path,
    );
    if (matches.length > 1) return null;
    return matches[0] ?? genericInstallConfigForSource();
  };
  const storeEntryForListing = (listing: TcsListing): StoreEntry | null => {
    const config = installConfigForStoreListing(listing);
    return config ? storeEntryFromStoreListing(listing, config) : null;
  };
  const storeServiceEntry = (): StoreEntry | null => {
    const listing = selectedStoreListing();
    if (!listing) return null;
    return storeEntryForListing(listing);
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
        effectiveManagedBaseDomain(storePublicEndpoint(entry)?.baseDomain),
        managedPublicHostnameMode(),
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
      const baseDomain = effectiveManagedBaseDomain(endpoint?.baseDomain);
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
        if (isManagedSubdomainLabel(label) && baseDomain) {
          const managedLabel = managedHostnameLabel(label);
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
        if (isServiceIdentityStoreInput(entry, field)) {
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
          baseDomain:
            effectiveManagedBaseDomain(publicEndpoint?.baseDomain) ?? "",
        });
      }
      if (
        value &&
        (field.format === "url" || field.name === publicEndpoint?.urlVariable)
      ) {
        const baseDomain = effectiveManagedBaseDomain(
          publicEndpoint?.baseDomain,
        );
        const host = publicEndpointHost(value);
        if (
          !host ||
          (baseDomain &&
            host.endsWith(`.${baseDomain}`) &&
            !hostIsManagedBaseDomainSubdomain(host, baseDomain))
        ) {
          return t("new.storeInput.errorCustomDomain", {
            label: field.label[locale()],
            baseDomain: baseDomain ?? "",
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
  // Correlation id (`error.requestId`) of the install failure behind the
  // current error() — rendered as a muted "quote this id to support" line.
  const [errorRequestId, setErrorRequestId] = createSignal<string | null>(null);
  // After an install submit fails, the pre-submit 確認結果 card still says
  // "このまま追加できます" right above the failure alert. Demote it: hide the
  // stale check display until the user re-runs the check (もう一度確認 stays).
  const [staleCheckResult, setStaleCheckResult] = createSignal(false);
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
    // Clear the sticky slow flag too: left set, the next pick would render
    // the 技術的な詳細 step list (all idle) before any check even starts.
    setSourceSyncSlow(false);
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
    if (!CAPSULE_NAME_PATTERN.test(name().trim())) {
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
    if (!sameGitUrl(listing.source.url, sourceGitUrl())) return null;
    if (
      normalizeSourcePath(listing.source.path) !==
      normalizeSourcePath(installModulePath())
    ) {
      return null;
    }
    return listing;
  };
  const storeListingForCurrentSource = (): TcsListing | null => {
    const active = activeStoreListing();
    if (active) return active;
    const selected = selectedStoreListing();
    if (selected && storeListingMatchesCurrentSource(selected)) {
      return selected;
    }
    // A listing is discovery/display only. Setup declarations come from the
    // separately selected DB-owned InstallConfig, never repository metadata.
    return null;
  };
  const storeListingMatchesCurrentSource = (listing: TcsListing): boolean => {
    if (!sameGitUrl(listing.source.url, sourceGitUrl())) return false;
    return (
      normalizeSourcePath(listing.source.path) ===
      normalizeSourcePath(installModulePath())
    );
  };
  const installExperienceForCurrentSource = () =>
    selectedServiceEntry()?.installExperience;
  const serviceNameVariableForCurrentSource = () =>
    selectedServiceEntry()
      ? storeServiceNameVariable(selectedServiceEntry()!)
      : undefined;
  const storeServiceNameDefault = () => {
    const entry = selectedServiceEntry();
    const variable = entry ? storeServiceNameVariable(entry) : undefined;
    return variable
      ? entry?.inputs.find((input) => input.name === variable)?.defaultValue
      : undefined;
  };
  const storeConfigServiceNameDefault = () =>
    selectedServiceEntry()
      ? storeServiceNameField(selectedServiceEntry()!)?.defaultValue
      : undefined;
  const supportsServiceNameInput = () =>
    serviceNameHintIsGenerated(storeServiceNameDefault()) ||
    serviceNameHintIsGenerated(storeConfigServiceNameDefault());
  const defaultProjectName = () => {
    const base = slugInputValue(name() || capsuleNameFromUrl(sourceGitUrl()));
    return base;
  };
  const serviceNameInputValue = () =>
    slugInputValue(resourcePrefix() || defaultProjectName());
  const managedHostnameLabel = (requested: string): string =>
    managedPublicHostnameMode() === "vanity"
      ? slugInputValue(requested)
      : managedServiceLabel(workspaceHandle(), requested);
  const supportsManagedPublicHostnameChoice = () =>
    Boolean(
      installExperiencePublicEndpoint(installExperienceForCurrentSource())
        ?.subdomainVariable &&
      (selectedManagedProviderConnection() || hasManagedProviderFallback()),
    );
  // Preview the FINAL managed hostname (workspace-prefixed + base domain) the
  // deploy will use, so the workspace prefix is not a surprise. Empty until
  // the workspace handle and a base domain are known.
  const managedHostPreview = (): string => {
    const endpoint = installExperiencePublicEndpoint(
      installExperienceForCurrentSource(),
    );
    const baseDomain = effectiveManagedBaseDomain(endpoint?.baseDomain);
    const label = managedHostnameLabel(serviceNameInputValue());
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
      // The subdomain lives behind 変更; applying a suggestion into a collapsed
      // field would look like nothing happened.
      setIdentityOpen(true);
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
  // Same managed-host computation as the advanced サービスID preview, shown
  // under the MAIN public-name (subdomain) field so the resulting URL is
  // visible without opening 詳細設定.
  const storeFieldHostPreview = (
    entry: StoreEntry,
    field: StoreInputField,
  ): string => {
    const endpoint = storePublicEndpoint(entry);
    if (!endpoint?.subdomainVariable) return "";
    if (field.name !== endpoint.subdomainVariable) return "";
    const label = storeInputValue(entry, field).trim().toLowerCase();
    if (!label || !isManagedSubdomainLabel(label)) return "";
    const managedLabel = managedHostnameLabel(label);
    const baseDomain = effectiveManagedBaseDomain(endpoint.baseDomain);
    return managedLabel && baseDomain ? `${managedLabel}.${baseDomain}` : "";
  };
  // One-line explanations for the advanced 独自URL / route pattern fields when
  // the listing itself ships no helper text.
  const advancedStoreFieldHint = (
    entry: StoreEntry,
    field: StoreInputField,
  ): string | undefined => {
    const helper = field.helper?.[locale()];
    if (helper) return helper;
    const endpoint = storePublicEndpoint(entry);
    if (endpoint?.urlVariable && field.name === endpoint.urlVariable) {
      return t("new.advanced.customUrlHint");
    }
    if (
      endpoint?.routePatternVariable &&
      field.name === endpoint.routePatternVariable
    ) {
      return t("new.advanced.routePatternHint");
    }
    return undefined;
  };
  // Live service-name validation: the submit-time `^[a-z0-9-]+$` rule surfaces
  // inline while typing instead of only after pressing add.
  const serviceNameFieldError = (): string | null => {
    const value = name().trim();
    if (!value) return null;
    return CAPSULE_NAME_PATTERN.test(value) ? null : t("new.error.nameInvalid");
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
  const storeListingDefaultVariables = (): Readonly<
    Record<string, JsonValue>
  > => ({});
  const storeListingVariableNames = () => new Set<string>();
  const inputVariableError = (): string | null => {
    const seen = new Set<string>();
    const storeNames = new Set([
      ...selectedStoreVariableNames(),
      ...storeListingVariableNames(),
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
  const installVariables = ():
    Readonly<Record<string, JsonValue>> | undefined => {
    const variables: Record<string, JsonValue> = {
      ...storeListingDefaultVariables(),
      ...selectedStoreVariables(),
      ...normalizedInputVariables(),
    };
    const serviceNameVariable = serviceNameVariableForCurrentSource();
    if (serviceNameVariable && supportsServiceNameInput()) {
      variables[serviceNameVariable] = serviceNameInputValue();
    }
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
      }),
      appHandoff,
    );
  const providerConnectionsHref = () =>
    providerConnectionsHrefForInstallReturn(currentInstallReturnPath());

  const visibleConnections = () => connections() ?? [];
  const selectedManagedProviderConnection = ():
    ProviderConnection | undefined => {
    for (const row of providerRows()) {
      if (!row.connectionId) continue;
      const selected = providerConnectionsForProvider(row.provider).find(
        (candidate) => candidate.id === row.connectionId,
      );
      if (selected) {
        return isPublicManagedProviderConnection(selected)
          ? selected
          : undefined;
      }
    }
    const managedProvider = managedStoreProviderForCurrentSource();
    if (!managedProvider) return undefined;
    return readyProviderConnections().find(
      (candidate) =>
        isPublicManagedProviderConnection(candidate) &&
        sameProviderSource(managedProvider, candidate.providerSource),
    );
  };
  const effectiveManagedBaseDomain = (declared?: string): string | undefined =>
    managedBaseDomain(
      selectedManagedProviderConnection()?.scopeHints
        ?.managedPublicBaseDomain ?? declared,
    );
  const managedProviderVariableDefaults = (
    current: Readonly<Record<string, JsonValue>>,
  ): Record<string, JsonValue> => {
    const connection = selectedManagedProviderConnection();
    if (!connection) return {};
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
    for (const [name, value] of Object.entries(
      connection.scopeHints?.moduleInputDefaults ?? {},
    )) {
      setDefault(name, value);
    }
    if (publicEndpoint) {
      const subdomainVariable = publicEndpoint.subdomainVariable?.trim();
      const urlVariable = publicEndpoint.urlVariable?.trim();
      const routePatternVariable = publicEndpoint.routePatternVariable?.trim();
      const publicBaseDomain = effectiveManagedBaseDomain(
        publicEndpoint.baseDomain,
      );
      const currentSubdomain =
        subdomainVariable && typeof current[subdomainVariable] === "string"
          ? current[subdomainVariable].trim()
          : "";
      const currentAppUrl =
        urlVariable && typeof current[urlVariable] === "string"
          ? current[urlVariable].trim()
          : "";
      const managedAppLabel = currentSubdomain
        ? managedHostnameLabel(currentSubdomain)
        : "";
      const managedAppHost =
        managedAppLabel && publicBaseDomain
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
    return defaults;
  };
  const isServiceIdentityStoreInput = (
    entry: StoreEntry,
    field: StoreInputField,
  ) =>
    field.name === storeServiceNameVariable(entry) &&
    serviceNameHintIsGenerated(field.defaultValue);
  const isInitialSecretStoreInput = (
    entry: StoreEntry,
    field: StoreInputField,
  ) =>
    installExperienceInitialSecret(entry.installExperience)?.variable ===
    field.name;
  const isAdvancedStoreInput = (entry: StoreEntry, field: StoreInputField) =>
    field.advanced === true &&
    // `initial_secret` explicitly projects the field into common setup.
    !isInitialSecretStoreInput(entry, field);
  const visibleStoreInputs = (entry: StoreEntry) =>
    entry.inputs.filter(
      (field) =>
        !isServiceIdentityStoreInput(entry, field) &&
        !isAdvancedStoreInput(entry, field),
    );
  const advancedStoreInputs = (entry: StoreEntry) =>
    entry.inputs.filter(
      (field) =>
        !isServiceIdentityStoreInput(entry, field) &&
        isAdvancedStoreInput(entry, field),
    );
  // The public-endpoint subdomain IS the service's identity, and Takosumi
  // already derives it from the listing. Presenting it as the resulting URL
  // with an explicit 変更 affordance (instead of a raw required text field)
  // is what lets an ordinary store install ask for nothing at all. It is not
  // folded away: `installIdentityFields()` renders the same input inline.
  const identityStoreInput = (entry: StoreEntry) =>
    storePublicEndpointSubdomainField(entry);
  const setupStoreInputs = (entry: StoreEntry) => {
    const identity = identityStoreInput(entry);
    return visibleStoreInputs(entry).filter(
      (field) => field.name !== identity?.name,
    );
  };
  const hasSetupStoreInputs = () => {
    const entry = selectedServiceEntry();
    return Boolean(entry && setupStoreInputs(entry).length > 0);
  };
  const storePublisherLabel = (): string => {
    const publisher = selectedServiceEntry()?.publisher;
    if (!publisher) return "";
    return publisher.displayName?.trim() || `@${publisher.handle}`;
  };
  const storeBadgeLabel = (): string =>
    selectedServiceEntry()?.badge[locale()]?.trim() ?? "";
  // The public host this install will land on. Empty while the workspace
  // handle or managed base domain is still unknown.
  const installTargetHost = (): string => {
    const entry = selectedServiceEntry();
    const identity = entry ? identityStoreInput(entry) : undefined;
    if (entry && identity) return storeFieldHostPreview(entry, identity);
    return managedHostPreview();
  };
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
        connection.scope === "workspace" &&
        (connection.kind === "source_git_https_token" ||
          connection.kind === "source_git_ssh_key") &&
        connection.status === "verified",
    );
  const sourceConnectionLabel = (connection: ProviderConnection) =>
    connection.displayName ||
    (typeof connection.scopeHints?.providerSettings?.repositoryUrl === "string"
      ? connection.scopeHints.providerSettings.repositoryUrl
      : undefined) ||
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
      try {
        await testConnection(connection.id);
      } catch (verifyError) {
        // The connection row was created but its token failed verification —
        // best-effort revoke so retries don't accumulate dead
        // source_git_https_token connections.
        await revokeConnection(connection.id).catch(() => {});
        throw verifyError;
      }
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
  const canonicalProviderSource = (provider: string) => {
    const normalized = canonicalProvider(provider);
    return normalized.split("/").length === 2
      ? `registry.opentofu.org/${normalized}`
      : normalized;
  };
  // Matching is exact after registry qualification. A local-name/tail match is
  // not proof that two provider sources share credentials.
  const sameProviderSource = (
    requiredProvider: string,
    connectionProvider: string,
  ) =>
    canonicalProviderSource(requiredProvider) ===
    canonicalProviderSource(connectionProvider);
  const providerRequiresConnection = (row: ProviderConnectionRow) =>
    row.credentialRequired;

  const visibleProviderConnections = () => providerConnections() ?? [];
  const isUsableManagedProviderConnection = (connection: ProviderConnection) =>
    connection.status === "pending" &&
    isPublicManagedProviderConnection(connection);
  const isReadyProviderConnection = (connection: ProviderConnection) =>
    connection.status === "verified" ||
    isUsableManagedProviderConnection(connection);
  const readyProviderConnections = () =>
    visibleProviderConnections().filter(isReadyProviderConnection);
  const providerConnectionsForProvider = (provider: string) =>
    readyProviderConnections().filter((connection) =>
      sameProviderSource(provider, connection.providerSource),
    );
  const providerConnectionsForRow = (row: ProviderConnectionRow) =>
    providerConnectionsForProvider(row.provider);
  const managedProviderConnectionForRow = (
    row: ProviderConnectionRow,
  ): ProviderConnection | undefined =>
    providerConnectionsForRow(row).find(isPublicManagedProviderConnection);
  const managedStoreProviderForCurrentSource = (): string | undefined =>
    selectedServiceEntry()?.provider ??
    storeListingForCurrentSource()?.provider;

  createEffect(() => {
    if (!managedStoreProviderForCurrentSource()) return;
    void loadProviderConnections().catch(() => {});
  });

  const rowCanUseManagedProviderFallback = (row: ProviderConnectionRow) => {
    const managedProvider = managedStoreProviderForCurrentSource();
    return (
      managedProvider !== undefined &&
      sameProviderSource(managedProvider, row.provider) &&
      // The fallback is real only when an operator-managed connection is
      // actually listed (Cloud). A self-host without one must show the
      // friendly connection callout instead of failing server-side.
      managedProviderConnectionForRow(row) !== undefined
    );
  };
  const hasManagedProviderFallback = () =>
    providerRows().some(rowCanUseManagedProviderFallback);
  const rowHasManagedProviderDefault = (row: ProviderConnectionRow) => {
    const managedProvider = managedStoreProviderForCurrentSource();
    if (!managedProvider) return false;
    if (!sameProviderSource(managedProvider, row.provider)) {
      return false;
    }
    const best = providerConnectionsForRow(row)[0];
    return (
      best !== undefined &&
      best.id === row.connectionId &&
      isPublicManagedProviderConnection(best)
    );
  };
  const providerNeedsConnection = (row: ProviderConnectionRow) =>
    providerRequiresConnection(row) &&
    !rowCanUseManagedProviderFallback(row) &&
    providerConnectionsForProvider(row.provider).length === 0;
  const needsCloudCredential = () =>
    compatibility() !== null && providerRows().some(providerNeedsConnection);
  const missingProviderRows = () =>
    providerRows().filter(providerNeedsConnection);
  const providerRowNeedsVisibleChoice = (row: ProviderConnectionRow) => {
    if (!providerRequiresConnection(row)) return false;
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
      .filter((provider) => {
        if (!provider.allowed) return false;
        if (provider.credentialRequired === true) return true;
        const managedProvider = managedStoreProviderForCurrentSource();
        return (
          managedProvider !== undefined &&
          sameProviderSource(managedProvider, provider.source)
        );
      })
      .flatMap((provider) => {
        const aliases = provider.aliases.length > 0 ? provider.aliases : [""];
        return aliases.map((alias) => ({
          provider: provider.source,
          alias,
          connectionId: "",
          credentialRequired: true,
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

  const providerBindingsPayload = (): ProviderBindings =>
    providerRows()
      .filter((row) => providerRequiresConnection(row))
      .filter((row) => row.connectionId.trim())
      .map((row) => ({
        provider: row.provider,
        ...(row.alias ? { alias: row.alias } : {}),
        connectionId: row.connectionId,
      }));

  // Identity of the Source that createdSourceId points at. Editing the name
  // or a store input must not discard the registered Source — only a change
  // to the source coordinates themselves (URL / ref / auth) invalidates it,
  // so retries reuse the Source instead of accumulating one duplicate per
  // keystroke.
  let createdSourceIdentity: string | null = null;
  const sourceIdentitySnapshot = () =>
    JSON.stringify([
      sourceGitUrl(),
      sourceRef(),
      sourceAuthConnectionIdForRun() ?? "",
    ]);
  const recordCreatedSource = (sourceId: string) => {
    setCreatedSourceId(sourceId);
    createdSourceIdentity = sourceIdentitySnapshot();
  };
  const resetCompatibility = () => {
    abortActiveFlow();
    setCompatibility(null);
    setProviderRows([]);
    if (
      createdSourceId() !== null &&
      createdSourceIdentity !== sourceIdentitySnapshot()
    ) {
      setCreatedSourceId(null);
      createdSourceIdentity = null;
    }
    setCreatedCapsuleId(null);
    setExistingCapsule(null);
    setAppHostnameConflict(false);
    setError(null);
    setErrorRequestId(null);
    setStaleCheckResult(false);
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
    const storeEntry = storeListing ? storeEntryForListing(storeListing) : null;
    if (storeListing) {
      setStoreInputValues({});
      setStoreInputTouched({});
      setInputVariables([]);
      setEnvVariables([]);
      setInstallConfigId(storeEntry?.installConfigId ?? "");
      setStoreMetadataUnavailable(storeEntry === null);
    } else {
      setInputVariables([]);
      setEnvVariables([]);
    }
    const nextServiceNameVariable = storeEntry
      ? storeServiceNameVariable(storeEntry)
      : undefined;
    const nextProjectNameDefault = nextServiceNameVariable
      ? storeServiceNameField(storeEntry!)?.defaultValue
      : undefined;
    if (nextProjectNameDefault) {
      const isGeneratedProjectName = serviceNameHintIsGenerated(
        nextProjectNameDefault,
      );
      const literalProjectName =
        nextProjectNameDefault.source === "literal" &&
        typeof nextProjectNameDefault.value === "string"
          ? nextProjectNameDefault.value
          : "";
      setResourcePrefix(isGeneratedProjectName ? "" : literalProjectName);
      setResourcePrefixTouched(
        !isGeneratedProjectName && literalProjectName !== "",
      );
    } else {
      setResourcePrefix("");
      setResourcePrefixTouched(false);
    }
    resetCompatibility();
  };

  const prepareStoreListing = async (
    listing: TcsListing,
    _signal?: AbortSignal,
  ): Promise<TcsListing> => listing;

  // Guard out-of-order picks: tapping card A then quickly card B must not let
  // A's slower metadata response overwrite B's form (same reqToken pattern as
  // StoreBrowser.rebuild()). Stale resolutions are dropped silently.
  let storePickToken = 0;
  const STORE_PICK_BUSY_DELAY_MS = 250;
  const pickStoreListing = (listing: TcsListing) => {
    void (async () => {
      const token = ++storePickToken;
      setFailedStorePick(null);
      setStoreMetadataUnavailable(false);
      setError(null);
      // Delay-gated: a spinner that appears and vanishes within a frame reads
      // as a glitch, not as progress. Only a pick that actually keeps the user
      // waiting gets an indicator.
      const busyTimer = setTimeout(() => {
        if (token === storePickToken) setStorePickBusy(true);
      }, STORE_PICK_BUSY_DELAY_MS);
      const settlePickBusy = () => {
        clearTimeout(busyTimer);
        setStorePickBusy(false);
      };
      let hydratedListing: TcsListing;
      try {
        hydratedListing = await prepareStoreListing(listing);
      } catch {
        if (token !== storePickToken) return;
        settlePickBusy();
        setStoreMetadataUnavailable(true);
        setFailedStorePick(listing);
        setError(t("new.error.configLoadFailed"));
        return;
      }
      if (token !== storePickToken) return;
      settlePickBusy();
      void loadConnections();
      // Focus lands on the freshly-mounted chosen-flow section: the tapped
      // store card unmounts with the discovery section, and focus must not
      // fall to <body>.
      queueMicrotask(() => chosenFlowSection?.focus());
      const prefill = parseInstallPrefill(`?${buildNewQuery(hydratedListing)}`);
      if (prefill) {
        applyInstallPrefillInput(prefill, { storeListing: hydratedListing });
        return;
      }

      setActiveTab("store");
      setActiveInstallPrefill(null);
      setSelectedStoreListing(hydratedListing);
      setGitUrl(hydratedListing.source.url);
      setRef("");
      setPinnedFullRef(null);
      setPath(hydratedListing.source.path || ".");
      setName(hydratedListing.suggestedName);
      const config = installConfigForStoreListing(hydratedListing);
      setInstallConfigId(config?.id ?? "");
      setStoreMetadataUnavailable(config === null);
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

  // Clear the chosen source/store state so the discovery section mounts again.
  const performReturnToDiscovery = () => {
    storePickToken += 1;
    setStorePickBusy(false);
    setFailedStorePick(null);
    setActiveInstallPrefill(null);
    setSelectedStoreListing(null);
    setStoreInputValues({});
    setStoreInputTouched({});
    setGitUrl("");
    setLinkDraft("");
    setRef("");
    setPinnedFullRef(null);
    setPath(".");
    setName("");
    setNameTouched(false);
    setResourcePrefix("");
    setResourcePrefixTouched(false);
    setInputVariables([]);
    setEnvVariables([]);
    setInstallConfigId(defaultGitInstallConfig()?.id ?? "");
    setSourceAccessMode("public");
    setSourceAuthConnectionId("");
    setSourceToken("");
    setSourceTokenError(null);
    setStoreMetadataUnavailable(false);
    setStepSource("idle");
    setStepSync("idle");
    setStepInstall("idle");
    setStepPlan("idle");
    setSyncRequired(false);
    setActiveTab("store");
    resetCompatibility();
    // The clicked 選び直す button unmounts with the flow section — move focus
    // to the discovery heading instead of letting it fall to <body>.
    queueMicrotask(() => discoveryHeading?.focus());
  };
  // Meaningful input = something a one-tap 選び直す would silently discard. A
  // freshly-picked service carrying only auto-filled defaults is not meaningful,
  // so it returns without a prompt.
  const hasMeaningfulInstallInput = () =>
    Boolean(
      nameTouched() ||
      resourcePrefixTouched() ||
      linkDraft().trim() ||
      inputVariables().some((row) => row.name.trim() || row.value.trim()) ||
      envVariables().some((row) => row.name.trim() || row.value.trim()) ||
      Object.keys(storeInputTouched()).length > 0,
    );
  // Back to the picker. Guarded while an install is in flight — an accidental
  // tap must not silently drop a running install (the control is also disabled
  // then) — and confirmed when the form holds meaningful input so one tap never
  // wipes a filled setup without warning.
  const returnToDiscovery = () => {
    if (busy()) return;
    if (!hasMeaningfulInstallInput()) {
      performReturnToDiscovery();
      return;
    }
    void confirm({
      title: t("new.discard.title"),
      message: t("new.discard.body"),
      confirmText: t("new.discard.confirm"),
      cancelText: t("common.cancel"),
      danger: true,
    }).then((ok) => {
      if (ok) performReturnToDiscovery();
    });
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
        const hydratedListing = await prepareStoreListing({
          ...listing,
          primaryServer: initialTcsHandoff.base,
        });
        setStoreMetadataUnavailable(false);
        setSelectedStoreListing(hydratedListing);
        setActiveTab("store");
        void loadConnections();
        // Only a listing that actually resolved and matches the pre-filled
        // source settles the handoff. A missing/mismatched/failed listing must
        // leave it unsettled: settling in a `finally` armed the auto-install
        // precondition for exactly the store handoffs that could not be
        // verified, which is the case that must fall back to the visible form.
        setTcsHandoffSettled(true);
      } catch {
        setStoreMetadataUnavailable(true);
        setError(t("new.error.configLoadFailed"));
      }
    })();
  });

  const compatibilityRunnable = () => {
    const level = compatibility()?.level;
    return level === "ready";
  };
  // Reached only from inside submit/runFlow, so "press add first" would be a
  // lie: either a listed item blocks the install, or the check never produced
  // a result and the honest instruction is to try again.
  const proceedBlocker = (): string =>
    providerConnectionError() ??
    (compatibility() && !compatibilityRunnable()
      ? t("new.error.notRunnable")
      : t("new.error.checkIncomplete"));
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
    // A typed-but-unsaved source token used to fail validation with "save the
    // token first", pointing at a separate button buried in 詳細設定. Saving it
    // here is the same explicit action the user already asked for.
    if (sourceAccessMode() === "token" && sourceToken().trim()) {
      await saveSourceTokenConnection();
      if (sourceTokenError()) return;
    }
    // Ensure source connections settle before validating source access.
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
  // the workspace / install config / store selection settle. Validation errors
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
    setErrorRequestId(null);
    setStaleCheckResult(false);
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
          if (isCurrentFlow(flow)) recordCreatedSource(sourceId);
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
            if (isCurrentFlow(flow)) recordCreatedSource(sourceId);
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
        recordCreatedSource(result.sourceId);
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
        if (sourceId) recordCreatedSource(sourceId);
        setStepSource("done");
        setStepSync("error");
        setSyncRequired(true);
      } else if (apiError?.code === "source_sync_failed") {
        setStepSource("done");
        setStepSync("error");
      } else if (apiError?.isAppHostnameUnavailable) {
        setAppHostnameConflict(true);
        // Reveal the identity block so the conflicting name — and the 候補名
        // affordance that fixes it — are both visible.
        setIdentityOpen(true);
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
        // A finished (>8s) check must not leave the slow flag set: the next
        // pick would render the technical step list before any check starts.
        setSourceSyncSlow(false);
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
    setErrorRequestId(null);
    setStaleCheckResult(false);
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
      managedPublicHostname: supportsManagedPublicHostnameChoice()
        ? { mode: managedPublicHostnameMode() }
        : undefined,
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
        recordCreatedSource(sourceId);
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
        // A blocker surfaced only after the source synced (e.g. a connection
        // choice is now required). Say why instead of ending 追加中… silently.
        setError(proceedBlocker());
        return;
      }
      const providerBindingsForRun = providerBindingsPayload();

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
          setStepInstall(CAPSULE_DONE);
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
          ...(flowInput.managedPublicHostname
            ? { managedPublicHostname: flowInput.managedPublicHostname }
            : {}),
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
      await putCapsuleProviderBindingSet(capsuleId, providerBindingsForRun);
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
      // The pre-submit check result predates this failure — stop asserting
      // "このまま追加できます" above the failure alert, and keep the failure's
      // correlation id for the support line under the alert.
      setStaleCheckResult(true);
      setErrorRequestId(apiError?.requestId ?? null);
      if (apiError?.isSourceSyncRequired) {
        setSyncRequired(true);
        setStepSync("error");
        setError(t("new.error.syncPending"));
      } else if (apiError?.code === "source_sync_failed") {
        setStepSync("error");
        setError(sourceFetchErrorMessage(apiError));
      } else if (apiError?.isAppHostnameUnavailable) {
        setAppHostnameConflict(true);
        // Reveal the identity block so the conflicting name — and the 候補名
        // affordance that fixes it — are both visible.
        setIdentityOpen(true);
        setError(addFlowErrorMessage(apiError));
      } else if (isDuplicateServiceError(apiError)) {
        setStepPlan("idle");
        const existing = await findExistingCapsule(
          workspace,
          flowInput.name,
          "production",
          { force: true },
        ).catch(() => null);
        // Non-throwing staleness check: throwing here would escape the catch
        // block and surface as an unhandled rejection.
        if (!isCurrentFlow(flow)) return;
        if (existing) {
          setStepInstall(CAPSULE_DONE);
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
        setSourceSyncSlow(false);
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

  // Installing is the primary state, not an interruption: the four setup steps
  // drive one calm progress line in place of the action row. Waiting must not
  // borrow the error palette.
  const installSteps = (): readonly {
    readonly state: StepState;
    readonly label: string;
  }[] => [
    { state: stepSource(), label: t("new.step.register") },
    { state: stepSync(), label: t("new.step.sync") },
    { state: stepInstall(), label: t("new.step.create") },
    { state: stepPlan(), label: t("new.step.plan") },
  ];
  const installProgressActive = () => checkingCompatibility() || busy();
  const installProgressPercent = (): number => {
    const steps = installSteps();
    const done = steps.filter((step) => step.state === "done").length;
    const running = steps.some((step) => step.state === "running") ? 0.5 : 0;
    // Never render an empty bar: a just-started install still reads as moving.
    return Math.max(8, Math.round(((done + running) / steps.length) * 100));
  };
  const installProgressLabel = (): string => {
    const running = installSteps().find((step) => step.state === "running");
    if (running) return running.label;
    const next = installSteps().find((step) => step.state === "idle");
    return next?.label ?? t("new.step.register");
  };

  const gitFields = () => (
    <FormField label={t("new.git.url")}>
      <Input
        id="new-capsule-git-url"
        name="gitUrl"
        type="text"
        value={gitUrl()}
        disabled={busy()}
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
        placeholder="https://git.example.com/owner/service.git"
        autocomplete="off"
        spellcheck={false}
      />
    </FormField>
  );

  const sourceAccessFields = () => (
    <div class="wb-advanced-group">
      <h3 class="wb-subhead">
        <KeyRound size={15} aria-hidden="true" />
        {t("new.sourceAccess.title")}
      </h3>
      <p class="wb-note">{t("new.sourceAccess.body")}</p>
      <FormField label={t("new.sourceAccess.mode")}>
        <Select
          id="new-source-access-mode"
          name="sourceAccessMode"
          value={sourceAccessMode()}
          disabled={busy()}
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
            disabled={busy()}
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
              disabled={busy()}
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
              disabled={busy()}
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
            disabled={savingSourceToken() || busy()}
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
      <h3 class="wb-subhead">{t("new.git.advanced")}</h3>
      <div class="wb-form-row">
        <FormField label={t("new.git.ref")}>
          <Input
            id="new-capsule-ref"
            name="ref"
            type="text"
            value={ref()}
            disabled={busy()}
            onInput={(e) => {
              clearSelectedStoreEntry();
              setActiveInstallPrefill(null);
              setPinnedFullRef(null);
              setRef(e.currentTarget.value);
              resetCompatibility();
            }}
            placeholder="HEAD"
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
            disabled={busy()}
            onInput={(e) => {
              clearSelectedStoreEntry();
              setActiveInstallPrefill(null);
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
  // Derived service identity. An ordinary store install shows the resulting
  // URL and nothing else; 変更 reveals the same display-name / subdomain inputs
  // inline, so the install contract stays visible rather than folded away.
  // Takes an ACCESSOR, not a value: <Show> does not re-invoke its child
  // function when `when` merely changes identity, so capturing the entry here
  // would freeze the pre-InstallConfig placeholder and silently drop the
  // subdomain input.
  const installIdentityFields = (entry: () => StoreEntry) => {
    const identity = () => identityStoreInput(entry());
    return (
      <section class="av-add-identity">
        <div class="av-add-identity-row">
          <div class="av-add-identity-target">
            <span class="av-add-identity-label">{t("new.identity.label")}</span>
            <Show
              when={installTargetHost()}
              fallback={
                <span class="av-add-identity-host muted">
                  {name().trim() || defaultProjectName()}
                </span>
              }
            >
              {(host) => <span class="av-add-identity-host">{host()}</span>}
            </Show>
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={busy()}
            aria-expanded={identityOpen()}
            onClick={() => setIdentityOpen(!identityOpen())}
          >
            {identityOpen() ? t("new.identity.done") : t("new.identity.edit")}
          </Button>
        </div>
        <Show when={identityOpen()}>
          <div class="av-add-identity-fields">
            <FormField label={t("new.name")} error={serviceNameFieldError()}>
              <Input
                id="new-capsule-name"
                name="name"
                type="text"
                invalid={serviceNameFieldError() !== null}
                maxlength={96}
                value={name()}
                disabled={busy()}
                onInput={(e) => {
                  setName(e.currentTarget.value);
                  setNameTouched(true);
                  resetCompatibility();
                }}
                placeholder="photo-blog"
                autocomplete="off"
                spellcheck={false}
              />
            </FormField>
            <Show when={identity()}>
              {(field) => (
                <FormField
                  label={field().label[locale()]}
                  hint={field().helper?.[locale()]}
                  required={field().required}
                >
                  <Input
                    id={`store-input-${entry().id}-${field().name}`}
                    name={`storeInput:${field().name}`}
                    type="text"
                    invalid={appHostnameConflict()}
                    disabled={busy()}
                    value={storeInputValue(entry(), field())}
                    onInput={(e) =>
                      updateStoreInputValue(
                        entry(),
                        field(),
                        e.currentTarget.value,
                      )
                    }
                    placeholder={field().placeholder ?? ""}
                    autocomplete="off"
                    spellcheck={false}
                  />
                </FormField>
              )}
            </Show>
            <Show when={supportsManagedPublicHostnameChoice()}>
              <FormField
                label={t("new.hostname.mode.label")}
                hint={t("new.hostname.mode.hint")}
              >
                <Select
                  id="new-managed-public-hostname-mode"
                  name="managedPublicHostnameMode"
                  value={managedPublicHostnameMode()}
                  disabled={busy()}
                  onChange={(event) => {
                    setManagedPublicHostnameMode(
                      event.currentTarget.value as ManagedPublicHostnameMode,
                    );
                    resetCompatibility();
                  }}
                >
                  <option value="scoped">
                    {t("new.hostname.mode.scoped")}
                  </option>
                  <option value="vanity">
                    {t("new.hostname.mode.vanity")}
                  </option>
                </Select>
              </FormField>
            </Show>
          </div>
        </Show>
      </section>
    );
  };
  return (
    <>
      <Show
        when={workspaceId()}
        fallback={
          <Show when={!resolvingWorkspace()}>
            <NoWorkspaceStartPanel
              busy={createFirstWorkspace.busy()}
              error={createFirstWorkspace.error()}
              onCreate={() => void createFirstWorkspace.run()}
            />
          </Show>
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
                  {/* tabindex=-1: programmatic focus target for 選び直す. */}
                  <h2 ref={discoveryHeading} tabindex={-1}>
                    {t("new.discovery.title")}
                  </h2>
                  <p>{t("new.discovery.subtitle")}</p>
                </div>
              </div>
            </header>
            <Show when={storePickBusy()}>
              <StorePickBusyStatus />
            </Show>
            <Show when={!storePickBusy() && error()}>
              {(message) => (
                <div class="wb-action-callout av-pick-error" role="alert">
                  <strong>{message()}</strong>
                  <Show when={failedStorePick()}>
                    {(listing) => (
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        onClick={() => pickStoreListing(listing())}
                      >
                        {t("common.retry")}
                      </Button>
                    )}
                  </Show>
                </div>
              )}
            </Show>
            <div
              class="av-store-pick-scope"
              classList={{ "is-picking": storePickBusy() }}
              aria-busy={storePickBusy()}
            >
              {/* The dashboard's ONLY store grid. Source controls (取得元) and
                  sort both live here — the merged page has to carry everything
                  the separate store tab used to offer. */}
              <StoreBrowser
                locale={locale()}
                onConfigure={pickStoreListing}
                showSourceControls={true}
                showSortControl={true}
              />
            </div>
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
                    aria-label={t("new.discovery.linkPlaceholder")}
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
          {/* tabindex=-1: programmatic focus target after a store pick (the
              heading inside is display:none on wide screens). */}
          <section
            class="av-add-flow"
            aria-label={t("new.title")}
            ref={chosenFlowSection}
            tabindex={-1}
          >
            <div class="av-add-flow-back">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                icon={<ArrowLeft size={16} />}
                disabled={busy()}
                onClick={returnToDiscovery}
              >
                {t("new.flow.back")}
              </Button>
            </div>
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
                  <h2>
                    {usingSelectedService()
                      ? (selectedServiceEntry()?.name[locale()] ??
                        sourceSummaryTitle())
                      : t("new.advancedImport.title")}
                  </h2>
                  <p class="av-add-flow-by">
                    <Show
                      when={usingSelectedService()}
                      fallback={<span>{t("new.flow.manual")}</span>}
                    >
                      <Show when={storePublisherLabel()}>
                        {(publisher) => <span>{publisher()}</span>}
                      </Show>
                      <Show when={storeBadgeLabel()}>
                        {(badge) => (
                          <span class="av-add-flow-badge">{badge()}</span>
                        )}
                      </Show>
                    </Show>
                  </p>
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
                  {(entry) => installIdentityFields(entry)}
                </Show>

                <Show
                  when={hasSetupStoreInputs() ? selectedServiceEntry() : null}
                >
                  {(entry) => (
                    <section class="av-service-setup">
                      <div class="av-service-setup-head">
                        <h3>{t("new.storeInput.title")}</h3>
                        <p>{t("new.storeInput.subtitle")}</p>
                      </div>
                      <div class="av-service-setup-grid">
                        <For each={setupStoreInputs(entry())}>
                          {(field) => (
                            <FormField
                              label={field.label[locale()]}
                              hint={field.helper?.[locale()]}
                              required={field.required}
                              // A boolean field renders a self-labeling Checkbox
                              // (its own <label>); wrap it in a group, not a
                              // second <label>.
                              as={field.type === "boolean" ? "group" : "label"}
                            >
                              <Show
                                when={field.type === "boolean"}
                                fallback={
                                  <>
                                    <Input
                                      id={`store-input-${entry().id}-${field.name}`}
                                      name={`storeInput:${field.name}`}
                                      type={field.secret ? "password" : "text"}
                                      invalid={
                                        appHostnameConflict() &&
                                        isStorePublicEndpointField(
                                          entry(),
                                          field,
                                        )
                                      }
                                      disabled={busy()}
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
                                    <Show
                                      when={storeFieldHostPreview(
                                        entry(),
                                        field,
                                      )}
                                    >
                                      {(host) => (
                                        <p class="wb-note">
                                          {t("new.hostPreview", {
                                            host: host(),
                                          })}
                                        </p>
                                      )}
                                    </Show>
                                  </>
                                }
                              >
                                <Checkbox
                                  id={`store-input-${entry().id}-${field.name}`}
                                  name={`storeInput:${field.name}`}
                                  label={t("app.config.enabled")}
                                  disabled={busy()}
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
                  <FormField
                    label={t("new.name")}
                    error={serviceNameFieldError()}
                  >
                    <Input
                      id="new-capsule-name"
                      name="name"
                      type="text"
                      invalid={serviceNameFieldError() !== null}
                      maxlength={96}
                      value={name()}
                      disabled={busy()}
                      onInput={(e) => {
                        setName(e.currentTarget.value);
                        setNameTouched(true);
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
                    sourceAccessMode() !== "public" ||
                    // A hostname conflict flags the サービスID field invalid
                    // in here; keep the disclosure open so the chosen 候補名 is
                    // visible and the queued focus() lands on a shown input.
                    appHostnameConflict()
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
                                label={field.label[locale()]}
                                hint={advancedStoreFieldHint(entry(), field)}
                                required={field.required}
                                // A boolean field renders a self-labeling
                                // Checkbox (its own <label>); wrap it in a
                                // group, not a second <label>.
                                as={
                                  field.type === "boolean" ? "group" : "label"
                                }
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
                                      disabled={busy()}
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
                                    label={t("app.config.enabled")}
                                    disabled={busy()}
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
                    <FormField
                      label={t("new.vars.projectName")}
                      hint={t("new.advanced.serviceIdHint")}
                    >
                      <Input
                        ref={serviceNameInput}
                        id="new-project-name"
                        name={
                          serviceNameVariableForCurrentSource() ??
                          "service_name"
                        }
                        type="text"
                        invalid={appHostnameConflict()}
                        disabled={busy()}
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
                                disabled={busy()}
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
                                disabled={busy()}
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
                              disabled={busy()}
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
                        disabled={busy()}
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
                                disabled={busy()}
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
                                disabled={busy()}
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
                              disabled={busy()}
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
                        disabled={busy()}
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

                <Show when={!staleCheckResult() && compatibility()}>
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
                            {result().level === "ready"
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
                    <Show when={providerConnectionsLoadError()}>
                      {(loadError) => {
                        // A failed connections fetch must not read as "no
                        // connections" — offer a retry, not the false
                        // missing-account blocker.
                        const friendly = () => friendlyError(loadError(), t);
                        return (
                          <div class="wb-action-callout" role="alert">
                            <strong>{friendly().message}</strong>
                            <Show when={friendly().detail}>
                              {(detail) => <p class="muted">{detail()}</p>}
                            </Show>
                            <Button
                              variant="secondary"
                              size="sm"
                              type="button"
                              onClick={() =>
                                void loadProviderConnections({ force: true })
                              }
                            >
                              {t("common.retry")}
                            </Button>
                          </div>
                        );
                      }}
                    </Show>
                    <Show when={!providerConnectionsLoadError()}>
                      <div class="wb-provider-grid">
                        <For each={providerRowsRequiringChoice()}>
                          {(row, index) => {
                            const options = () =>
                              providerConnectionsForRow(row);
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

                <Show
                  when={!installProgressActive()}
                  fallback={
                    <AnnouncedStatus class="av-add-progress">
                      <div
                        class="av-add-progress-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={installProgressPercent()}
                        aria-label={t("new.progress.title")}
                      >
                        <span
                          class="av-add-progress-fill"
                          style={{ width: `${installProgressPercent()}%` }}
                        />
                      </div>
                      <p class="av-add-progress-label">
                        {t("new.progress.title")}
                      </p>
                      <p class="av-add-progress-note">
                        {sourceSyncSlow()
                          ? t("new.progress.slow")
                          : installProgressLabel()}
                      </p>
                      <Show when={sourceSyncRunStatus()}>
                        {(status) => (
                          <p class="av-add-progress-note">
                            {t("new.progress.status", {
                              status: runStatusLabel(status()),
                            })}
                          </p>
                        )}
                      </Show>
                      <Show when={showSetupProgress()} fallback={null}>
                        <details class="wb-disclosure av-add-technical">
                          <summary>{t("new.progress.details")}</summary>
                          <ol class="wb-steps">
                            <For each={installSteps()}>
                              {(step) => (
                                <li class={`wb-step ${stepClass(step.state)}`}>
                                  <span class="wb-step-icon" aria-hidden="true">
                                    {stepIcon(step.state)}
                                  </span>
                                  <span class="sr-only">
                                    {stepStateLabel(step.state)}
                                  </span>
                                  {step.label}
                                </li>
                              )}
                            </For>
                          </ol>
                        </details>
                      </Show>
                    </AnnouncedStatus>
                  }
                >
                  <div class="wb-form-actions av-add-actions">
                    <Button
                      variant="primary"
                      type="submit"
                      disabled={
                        installConfigLoading() ||
                        (compatibility() !== null && !canContinue())
                      }
                    >
                      {installConfigLoading()
                        ? t("common.loading")
                        : t("new.installCta")}
                    </Button>
                    <Show when={compatibility()}>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => void runCompatibilityCheck()}
                      >
                        {t("new.compat.recheck")}
                      </Button>
                    </Show>
                    <Show when={syncRequired()}>
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={retryAfterSyncWait}
                      >
                        {t("common.retry")}
                      </Button>
                    </Show>
                  </div>
                  {/* A disabled install button with no stated reason is a dead
                      end; say what is holding it. */}
                  <Show when={compatibility() !== null && !canContinue()}>
                    <p class="av-add-blocked">{proceedBlocker()}</p>
                  </Show>
                </Show>

                <Show when={error()}>
                  {(m) => (
                    <p class="wb-error" role="alert">
                      {m()}
                      <Show when={errorRequestId()}>
                        {(id) => (
                          <span class="wb-error-request">
                            {t("new.error.requestId", { id: id() })}
                          </span>
                        )}
                      </Show>
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
                    <AnnouncedStatus class="wb-action-callout">
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
                    </AnnouncedStatus>
                  )}
                </Show>
              </form>
            </div>
          </section>
        </Show>
      </Show>
    </>
  );
}
