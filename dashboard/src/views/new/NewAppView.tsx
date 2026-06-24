/**
 * Add a service (`/new`) — starter catalog first for normal users, explicit
 * install links / Git sources second, one underlying flow.
 *
 * Three entry shapes, identical install path:
 *   - Link/source import: the primary path for app install links or raw Git
 *     URLs, including services that are not in the starter catalog.
 *   - Examples: curated first-party / known service coordinates returned by
 *     the InstallConfig API. Picking one pre-fills the same Git-backed flow.
 *   - External install link: another site links `/install?git=…` (or the
 *     packed `?source=git::…` form); the router forwards the query here and
 *     lib/install-link.ts seeds the Git form. A link only PRE-FILLS — the
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
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import {
  Cloud,
  Download,
  Globe2,
  HardDrive,
  KeyRound,
  Plus,
  Trash,
} from "lucide-solid";
import type { JsonValue } from "takosumi-contract";
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import { currentSpaceId, setCurrentSpaceId } from "../../lib/space-state.ts";
import {
  capsuleNameFromUrl,
  hasInstallPrefillParams,
  isSafeInstallVariableName,
  isSafeInstallVariableValue,
  parseInstallPrefill,
} from "../../lib/install-link.ts";
import {
  installReturnPathFromPrefill,
  providerConnectionsHrefForInstallReturn,
} from "../../lib/install-return-context.ts";
import {
  checkCapsuleCompatibility,
  ControlApiError,
  createInstallation,
  createSpace,
  createSourceHttpsTokenConnection,
  createSource,
  extractRunId,
  listInstallations,
  type InstallationProviderConnectionBindings,
  type Installation,
  type CapsuleCompatibilityDiagnostic,
  type CapsuleCompatibilityLevel,
  type CapsuleCompatibilityResult,
  type InstallConfig,
  listProviderConnections,
  listConnections,
  listStarterCatalogInstallConfigs,
  planInstallation,
  putInstallationProviderConnectionSet,
  syncSource,
  testConnection,
  waitForLatestSourceSnapshot,
  type CapsuleCompatibilityProvider,
  type Connection,
  type ProviderConnection,
  type ProviderCredentialOwnership,
  type RunStatus,
  type Space,
} from "../../lib/control-api.ts";
import { locale, t } from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardSection,
  EmptyState,
  FormField,
  Input,
  Select,
  Skeleton,
  Toast,
  type Tone,
} from "../../components/ui/index.ts";
import { createAction } from "../account/lib/action.tsx";

type StepState = "idle" | "running" | "done" | "error";
type FlowRun = {
  readonly id: number;
  readonly controller: AbortController;
};
type SourceAccessMode = "public" | "existing" | "token";

interface ProviderConnectionRow {
  readonly provider: string;
  readonly alias: string;
  readonly connectionId: string;
  readonly ownershipOptions: readonly ProviderCredentialOwnership[];
  readonly resourceTypes: readonly string[];
}

interface InputVariableRow {
  readonly name: string;
  readonly value: string;
}

function CatalogIcon(props: { readonly entry: CatalogEntry }) {
  switch (props.entry.kind) {
    case "worker":
      return <Cloud size={20} />;
    case "site":
      return <Globe2 size={20} />;
    case "storage":
      return <HardDrive size={20} />;
  }
}

const INSTALLATION_NAME_PATTERN = /^[a-z0-9-]+$/u;
const INSTALLATION_DONE: StepState = "done";

type CatalogEntry = NonNullable<InstallConfig["catalog"]> & {
  readonly id: string;
  readonly installConfigId: string;
};
type CatalogInputField = CatalogEntry["inputs"][number];
type CatalogInstallConfig = InstallConfig & {
  readonly catalog: NonNullable<InstallConfig["catalog"]> & {
    readonly source: NonNullable<
      NonNullable<InstallConfig["catalog"]>["source"]
    >;
  };
};

function CatalogCard(props: {
  readonly entry: CatalogEntry;
  readonly onSelect: (entry: CatalogEntry) => void;
}) {
  return (
    <li>
      <button
        type="button"
        class="av-catalog-card"
        onClick={() => props.onSelect(props.entry)}
      >
        <span class="av-catalog-icon" aria-hidden="true">
          <CatalogIcon entry={props.entry} />
        </span>
        <span class="av-catalog-text">
          <span class="av-catalog-name">{props.entry.name[locale()]}</span>
          <span class="av-catalog-desc">
            {props.entry.description[locale()]}
          </span>
        </span>
      </button>
    </li>
  );
}

function compatibilityTone(level: CapsuleCompatibilityLevel): Tone {
  switch (level) {
    case "ready":
    case "auto_capsulized":
      return "ok";
    case "needs_patch":
      return "warn";
    case "unsupported":
      return "danger";
  }
}

function compatibilityLabel(level: CapsuleCompatibilityLevel): string {
  switch (level) {
    case "ready":
      return t("new.compat.ready");
    case "auto_capsulized":
      return t("new.compat.auto");
    case "needs_patch":
      return t("new.compat.patch");
    case "unsupported":
      return t("new.compat.unsupported");
  }
}

function providerNameFromDiagnostic(
  diagnostic: CapsuleCompatibilityDiagnostic,
): string {
  const match =
    /^Provider\s+([a-zA-Z0-9_.-]+)\s+(?:contains|can be lifted)/u.exec(
      diagnostic.message,
    );
  return match?.[1] ?? "provider";
}

function providerDisplayName(provider: string): string {
  const normalized = provider.toLowerCase();
  switch (normalized) {
    case "aws":
      return "AWS";
    case "cloudflare":
      return "Cloudflare";
    case "google":
      return "Google Cloud";
    case "hcloud":
      return "Hetzner Cloud";
    default:
      return provider;
  }
}

function compatibilityDiagnosticDisplay(
  diagnostic: CapsuleCompatibilityDiagnostic,
): {
  readonly message: string;
  readonly detail?: string;
  readonly technical?: boolean;
} {
  const provider = providerDisplayName(providerNameFromDiagnostic(diagnostic));
  const code = diagnostic.code;
  if (
    code === "provider_credentials_in_source" ||
    /^Provider\s+[a-zA-Z0-9_.-]+\s+contains credential-like attributes\.?$/u.test(
      diagnostic.message,
    )
  ) {
    return {
      message: t("new.compat.issue.providerCredentials.message", {
        provider,
      }),
      detail: t("new.compat.issue.providerCredentials.detail", { provider }),
    };
  }
  if (
    code === "provider_block_lift_candidate" ||
    /^Provider\s+[a-zA-Z0-9_.-]+\s+can be lifted into the generated root/u.test(
      diagnostic.message,
    )
  ) {
    return {
      message: t("new.compat.issue.providerLift.message", { provider }),
    };
  }
  if (
    code === "dependency_lock_detected" ||
    diagnostic.message ===
      "A provider dependency lockfile is present and will be reviewed by the provider lockfile policy after credential-free init."
  ) {
    return { message: t("new.compat.issue.lockfile.message") };
  }
  return {
    message: t("new.compat.issue.reviewRequired.message"),
    detail: diagnostic.detail || diagnostic.message,
    technical: true,
  };
}

function compatibilitySummaryDisplay(
  result: CapsuleCompatibilityResult,
): string {
  const credentialDiagnostic = result.diagnostics.find(
    (diagnostic) =>
      diagnostic.code === "provider_credentials_in_source" ||
      /^Provider\s+[a-zA-Z0-9_.-]+\s+contains credential-like attributes\.?$/u.test(
        diagnostic.message,
      ),
  );
  if (
    credentialDiagnostic &&
    /^Provider\s+[a-zA-Z0-9_.-]+\s+contains credential-like attributes\.?$/u.test(
      result.summary,
    )
  ) {
    return t("new.compat.summary.providerCredentials", {
      provider: providerDisplayName(
        providerNameFromDiagnostic(credentialDiagnostic),
      ),
    });
  }
  return t("new.compat.summary.reviewRequired");
}

function shouldShowCompatibilityPanel(
  result: CapsuleCompatibilityResult,
): boolean {
  return result.level !== "ready" || result.diagnostics.length > 0;
}

function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/iu.test(value.trim());
}

function displayRef(value: string): string {
  const trimmed = value.trim();
  return isFullCommitSha(trimmed) ? trimmed.slice(0, 8) : trimmed;
}

function sourceHostLabel(value: string): string {
  try {
    const url = new URL(value.trim());
    return url.hostname.replace(/^www\./iu, "");
  } catch {
    return value.trim() || "-";
  }
}

function displayModulePath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, "") || ".";
}

function slugInputValue(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "capsule"
  );
}

function spaceSuffix(value: string | null): string {
  return (value ?? "")
    .replace(/^space_/u, "")
    .replace(/[^a-z0-9-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 6)
    .toLowerCase();
}

function catalogInputKey(entryId: string, fieldName: string): string {
  return `${entryId}:${fieldName}`;
}

function catalogSurfaceRank(surface: CatalogEntry["surface"]): number {
  if (surface === "service") return 0;
  if (surface === "building_block") return 1;
  return 2;
}

function catalogConfigKey(config: CatalogInstallConfig): string {
  if (config.catalog.templateId) return `template:${config.catalog.templateId}`;
  const source = config.catalog.source;
  return `source:${source.git}#${source.ref}:${source.path}`;
}

function catalogConfigPriority(config: CatalogInstallConfig): number {
  if (config.spaceId === undefined || config.id.startsWith("cfg-official-")) {
    return 0;
  }
  return 1;
}

function dedupeCatalogConfigs(
  configs: readonly CatalogInstallConfig[],
): readonly CatalogInstallConfig[] {
  const byKey = new Map<string, CatalogInstallConfig>();
  for (const config of configs) {
    const key = catalogConfigKey(config);
    const current = byKey.get(key);
    if (
      !current ||
      catalogConfigPriority(config) < catalogConfigPriority(current)
    ) {
      byKey.set(key, config);
    }
  }
  return [...byKey.values()];
}

const DEFAULT_CAPSULE_INSTALL_CONFIG_ID = "cfg-default-opentofu-capsule";

function catalogDefaultInputValue(
  entry: CatalogEntry,
  field: CatalogInputField,
  spaceId: string | null,
): string {
  const base = slugInputValue(entry.suggestedName);
  const suffix = spaceSuffix(spaceId);
  switch (field.defaultValue) {
    case "service-name":
      return base;
    case "service-name-with-space":
      return suffix ? `${base}-${suffix}` : base;
    case "main":
      return "main";
    case "us-east-1":
      return "us-east-1";
    default:
      return "";
  }
}

function isTakosOpenTofuCapsule(git: string, modulePath: string): boolean {
  const normalizedPath = modulePath.trim().replace(/^\/+|\/+$/gu, "") || ".";
  if (normalizedPath !== "deploy/opentofu") return false;
  try {
    const url = new URL(git.trim());
    const repo = url.pathname.replace(/\.git$/iu, "").toLowerCase();
    return url.hostname === "github.com" && repo.endsWith("/takos");
  } catch {
    return false;
  }
}

function inputVariableRowsFromPrefill(
  vars: Readonly<Record<string, string>> | undefined,
): readonly InputVariableRow[] {
  return Object.entries(vars ?? {})
    .filter(([name]) => name !== "project_name")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ name, value }));
}

function sourceIdFromControlError(error: ControlApiError | undefined): string {
  const body = error?.body;
  if (body && typeof body === "object" && "sourceId" in body) {
    const value = (body as { readonly sourceId?: unknown }).sourceId;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function isDuplicateServiceError(error: ControlApiError | undefined): boolean {
  return error?.isDuplicateService ?? false;
}

function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "queued":
      return t("status.run.queued");
    case "running":
      return t("status.run.running");
    case "waiting_approval":
      return t("status.run.waiting_approval");
    case "succeeded":
      return t("status.run.succeeded");
    case "failed":
      return t("status.run.failed");
    case "cancelled":
      return t("status.run.cancelled");
    case "expired":
      return t("status.run.expired");
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
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
    <section class="av-start" aria-label={t("space.start.aria")}>
      <div class="av-start-copy">
        <span class="av-start-kicker">{t("space.start.kicker")}</span>
        <h2 class="av-start-title">{t("space.start.title")}</h2>
        <p class="av-start-sub">{t("space.start.body")}</p>
      </div>
      <Button
        variant="primary"
        type="button"
        busy={props.busy}
        icon={<Plus size={18} />}
        onClick={props.onCreate}
      >
        {props.busy ? t("space.start.creating") : t("space.start.create")}
      </Button>
      <Show when={props.error}>
        {(message) => <Toast tone="error">{message()}</Toast>}
      </Show>
    </section>
  );
}

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

function initialAddTab(search: string, hasPrefill: boolean): "catalog" | "git" {
  if (hasPrefill) return "git";
  const params = new URLSearchParams(search);
  return params.get("mode") === "link" ? "git" : "catalog";
}

function Inner() {
  const navigate = useNavigate();

  // External install link (client-handled): another site links
  // `/install?git=…` (or the packed `?source=git::…` form), the router
  // forwards the query here, and the parser seeds the Git form. A link only
  // PRE-FILLS — the visitor still confirms in this client (compatibility
  // check, then the explicit add button).
  const initialSearch = typeof location === "undefined" ? "" : location.search;
  const prefill =
    typeof location === "undefined"
      ? undefined
      : parseInstallPrefill(initialSearch);
  const installPrefillRejected =
    typeof location !== "undefined" &&
    !prefill &&
    hasInstallPrefillParams(initialSearch);

  // Normal `/new` opens the catalog. Explicit link mode and external
  // `/install?git=…` redirects open the Git-backed flow with the source visible.
  const [activeTab, setActiveTab] = createSignal<"catalog" | "git">(
    initialAddTab(initialSearch, Boolean(prefill)),
  );
  const [selectedCatalogId, setSelectedCatalogId] = createSignal<string | null>(
    null,
  );
  const [catalogInputValues, setCatalogInputValues] = createSignal<
    Readonly<Record<string, string>>
  >({});
  const [catalogInputTouched, setCatalogInputTouched] = createSignal<
    Readonly<Record<string, boolean>>
  >({});
  const initialRef = prefill?.ref || "main";
  const [gitUrl, setGitUrl] = createSignal(prefill?.git ?? "");
  const [ref, setRef] = createSignal(displayRef(initialRef));
  const [pinnedFullRef, setPinnedFullRef] = createSignal<string | null>(
    isFullCommitSha(initialRef) ? initialRef : null,
  );
  const [path, setPath] = createSignal(prefill?.path || ".");
  const [sourceAccessMode, setSourceAccessMode] =
    createSignal<SourceAccessMode>("public");
  const [sourceAuthConnectionId, setSourceAuthConnectionId] = createSignal("");
  const [sourceTokenUsername, setSourceTokenUsername] = createSignal("git");
  const [sourceToken, setSourceToken] = createSignal("");
  const [savingSourceToken, setSavingSourceToken] = createSignal(false);
  const [sourceTokenError, setSourceTokenError] = createSignal<string | null>(
    null,
  );
  const initialName = prefill
    ? (prefill.name ?? capsuleNameFromUrl(prefill.git))
    : "";
  const [name, setName] = createSignal(initialName);
  const [resourcePrefix, setResourcePrefix] = createSignal(
    prefill?.vars?.project_name ?? "",
  );
  const [resourcePrefixTouched, setResourcePrefixTouched] = createSignal(
    prefill?.vars?.project_name !== undefined,
  );
  const [inputVariables, setInputVariables] = createSignal<
    readonly InputVariableRow[]
  >(inputVariableRowsFromPrefill(prefill?.vars));
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [providerRows, setProviderRows] = createSignal<ProviderConnectionRow[]>(
    [],
  );

  const spaceId = () => (currentSpaceId() ? currentSpaceId() : null);
  const [configs] = createResource(spaceId, listStarterCatalogInstallConfigs);
  const [connections, { refetch: refetchConnections }] = createResource(
    spaceId,
    listConnections,
  );
  const [providerConnections] = createResource(
    spaceId,
    listProviderConnections,
  );
  const createFirstWorkspace = createAction(async (): Promise<Space> => {
    const space = await createSpace({
      handle: defaultWorkspaceHandle(),
      displayName: t("space.defaultName"),
      type: "personal",
    });
    setCurrentSpaceId(space.id);
    window.dispatchEvent(new Event("takosumi:spaces-changed"));
    return space;
  });
  const configList = createMemo<readonly InstallConfig[]>(
    () => configs() ?? [],
  );
  const catalogEntries = createMemo<readonly CatalogEntry[]>(() =>
    dedupeCatalogConfigs(
      configList().filter((config): config is CatalogInstallConfig =>
        Boolean(config.catalog?.source),
      ),
    )
      .map((config) => ({
        id: config.catalog.templateId ?? config.id,
        installConfigId: config.id,
        ...config.catalog,
      }))
      .sort(
        (a, b) =>
          catalogSurfaceRank(a.surface) - catalogSurfaceRank(b.surface) ||
          a.order - b.order ||
          a.name[locale()].localeCompare(b.name[locale()]),
      ),
  );
  const primaryCatalog = createMemo(() =>
    catalogEntries().filter((entry) => entry.surface === "service"),
  );
  const featuredCatalog = createMemo(() =>
    primaryCatalog().length > 0 ? primaryCatalog() : catalogEntries(),
  );
  const showSecondaryCatalog = () => primaryCatalog().length > 0;
  const buildingBlockCatalog = createMemo(() =>
    catalogEntries().filter((entry) => entry.surface === "building_block"),
  );
  const exampleCatalog = createMemo(() =>
    catalogEntries().filter((entry) => entry.surface === "example"),
  );
  const defaultGitInstallConfig = () =>
    configList().find(
      (config) => config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    ) ??
    configList().find(
      (config) =>
        config.sourceKind === "generic_capsule" && config.spaceId === undefined,
    ) ??
    configList().find((config) => config.sourceKind === "generic_capsule");
  const ensureConfigSelected = () => {
    const list = configList();
    if (list.length === 0) return list;
    const current = installConfigId();
    if (!current || !list.some((config) => config.id === current)) {
      setInstallConfigId(defaultGitInstallConfig()?.id ?? "");
    }
    return list;
  };
  const selectedInstallConfigId = () => {
    ensureConfigSelected();
    return installConfigId();
  };
  const selectedCatalogEntry = () => {
    const id = selectedCatalogId();
    return id
      ? (catalogEntries().find((entry) => entry.id === id) ?? null)
      : null;
  };
  const catalogInputValue = (entry: CatalogEntry, field: CatalogInputField) => {
    const key = catalogInputKey(entry.id, field.name);
    return (
      catalogInputValues()[key] ??
      catalogDefaultInputValue(entry, field, spaceId())
    );
  };
  const updateCatalogInputValue = (
    entry: CatalogEntry,
    field: CatalogInputField,
    value: string,
  ) => {
    const key = catalogInputKey(entry.id, field.name);
    setCatalogInputValues((current) => ({
      ...current,
      [key]: value,
    }));
    setCatalogInputTouched((current) => ({
      ...current,
      [key]: true,
    }));
    resetCompatibility();
  };
  const selectedCatalogVariables = () => {
    const entry = selectedCatalogEntry();
    if (!entry) return {};
    const variables: Record<string, string> = {};
    for (const field of entry.inputs) {
      const value = catalogInputValue(entry, field).trim();
      if (value) variables[field.name] = value;
    }
    return variables;
  };
  const selectedCatalogVariableNames = () =>
    new Set(Object.keys(selectedCatalogVariables()));
  const catalogInputError = (): string | null => {
    const entry = selectedCatalogEntry();
    if (!entry) return null;
    for (const field of entry.inputs) {
      const value = catalogInputValue(entry, field).trim();
      if (field.required && !value) {
        if (isConnectionScopedCatalogInput(entry, field)) {
          continue;
        }
        return t("new.catalogInput.errorRequired", {
          label: field.label[locale()],
        });
      }
      if (value && !isSafeInstallVariableValue(value)) {
        return t("new.catalogInput.errorUnsafeValue", {
          label: field.label[locale()],
        });
      }
    }
    return null;
  };
  const clearSelectedCatalog = () => {
    if (!selectedCatalogId()) return;
    setSelectedCatalogId(null);
    setCatalogInputValues({});
    setCatalogInputTouched({});
    setInstallConfigId(defaultGitInstallConfig()?.id ?? "");
  };

  // Step machine: keep the created Source id so a retry resumes mid-flow.
  const [createdSourceId, setCreatedSourceId] = createSignal<string | null>(
    null,
  );
  const [createdInstallationId, setCreatedInstallationId] = createSignal<
    string | null
  >(null);
  const [existingInstallation, setExistingInstallation] =
    createSignal<Installation | null>(null);
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
    if (!spaceId()) return t("new.error.spaceRequired");
    if (!gitUrl().trim()) return t("new.error.urlRequired");
    if (!name().trim()) return t("new.error.nameRequired");
    if (!INSTALLATION_NAME_PATTERN.test(name().trim())) {
      return t("new.error.nameInvalid");
    }
    if (!selectedInstallConfigId()) return t("new.error.configMissing");
    const sourceCredentialError = sourceAccessError();
    if (sourceCredentialError) return sourceCredentialError;
    const catalogError = catalogInputError();
    if (catalogError) return catalogError;
    const variableError = inputVariableError();
    if (variableError) return variableError;
    return null;
  };
  const effectiveRef = () => {
    const current = ref().trim();
    const pinned = pinnedFullRef();
    if (pinned && current === displayRef(pinned)) return pinned;
    return current || "main";
  };
  const supportsProjectNameInput = () =>
    isTakosOpenTofuCapsule(gitUrl(), path()) ||
    prefill?.vars?.project_name !== undefined;
  const supportsCloudflareScopeInput = () =>
    isTakosOpenTofuCapsule(gitUrl(), path());
  const defaultProjectName = () => {
    const base = slugInputValue(name() || capsuleNameFromUrl(gitUrl()));
    const suffix = spaceSuffix(spaceId());
    return suffix && base === "takos" ? `${base}-${suffix}` : base;
  };
  const projectNameVariable = () =>
    slugInputValue(resourcePrefix() || defaultProjectName());
  const updateInputVariable = (
    index: number,
    patch: Partial<InputVariableRow>,
  ) => {
    setInputVariables((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
    resetCompatibility();
  };
  const addInputVariable = () =>
    setInputVariables((rows) => [...rows, { name: "", value: "" }]);
  const removeInputVariable = (index: number) => {
    setInputVariables((rows) => rows.filter((_, i) => i !== index));
    resetCompatibility();
  };
  const normalizedInputVariables = () => {
    const variables: Record<string, string> = {};
    for (const row of inputVariables()) {
      const variableName = row.name.trim();
      const value = row.value.trim();
      if (!variableName && !value) continue;
      variables[variableName] = value;
    }
    return variables;
  };
  const inputVariableError = (): string | null => {
    const seen = new Set<string>();
    const catalogNames = selectedCatalogVariableNames();
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
      if (supportsProjectNameInput() && variableName === "project_name") {
        return t("new.vars.errorProjectNameReserved");
      }
      if (catalogNames.has(variableName)) {
        return t("new.vars.errorCatalogReserved", { name: variableName });
      }
      if (seen.has(variableName)) {
        return t("new.vars.errorDuplicate", { name: variableName });
      }
      seen.add(variableName);
    }
    return null;
  };
  const shouldOpenServiceAdvanced = () => inputVariables().length > 0;
  const installReturnVariables = (): Readonly<Record<string, string>> => {
    const variables: Record<string, string> = {};
    if (supportsProjectNameInput()) {
      variables.project_name = projectNameVariable();
    }
    Object.assign(variables, selectedCatalogVariables());
    Object.assign(variables, normalizedInputVariables());
    return variables;
  };
  const installVariables = ():
    | Readonly<Record<string, JsonValue>>
    | undefined => {
    const variables: Record<string, JsonValue> = {
      ...selectedCatalogVariables(),
      ...normalizedInputVariables(),
    };
    if (supportsProjectNameInput()) {
      variables.project_name = projectNameVariable();
    }
    if (supportsCloudflareScopeInput()) {
      variables.cloudflare = {};
    }
    return Object.keys(variables).length > 0 ? variables : undefined;
  };
  const currentInstallReturnPath = () =>
    installReturnPathFromPrefill({
      git: gitUrl(),
      ref: effectiveRef(),
      path: path().trim() || ".",
      name: name().trim(),
      vars: installReturnVariables(),
    });
  const providerConnectionsHref = () =>
    providerConnectionsHrefForInstallReturn(currentInstallReturnPath());

  const visibleConnections = () => connections() ?? connections.latest ?? [];
  const catalogScopeHintValue = (
    entry: CatalogEntry,
    field: CatalogInputField,
  ): string | undefined => {
    const matchingConnections = visibleConnections().filter(
      (connection) =>
        connection.scope === "space" &&
        connection.status === "verified" &&
        sameProviderFamily(entry.provider, connection.provider),
    );
    const hints = new Set<string>();
    for (const connection of matchingConnections) {
      if (entry.provider === "cloudflare" && field.name === "accountId") {
        const value = connection.scopeHints?.accountId?.trim();
        if (value) hints.add(value);
      }
      if (entry.provider === "aws" && field.name === "region") {
        const value = connection.scopeHints?.awsRegion?.trim();
        if (value) hints.add(value);
      }
    }
    return hints.size === 1 ? Array.from(hints)[0] : undefined;
  };
  const catalogInputHasImplicitValue = (
    entry: CatalogEntry,
    field: CatalogInputField,
  ) =>
    field.required &&
    !catalogInputTouched()[catalogInputKey(entry.id, field.name)] &&
    catalogScopeHintValue(entry, field) !== undefined;
  const isConnectionScopedCatalogInput = (
    entry: CatalogEntry,
    field: CatalogInputField,
  ) => entry.provider === "cloudflare" && field.name === "accountId";
  const visibleCatalogInputs = (entry: CatalogEntry) =>
    entry.inputs.filter(
      (field) =>
        !isConnectionScopedCatalogInput(entry, field) &&
        !catalogInputHasImplicitValue(entry, field),
    );
  const advancedCatalogInputs = (entry: CatalogEntry) =>
    entry.inputs.filter(
      (field) =>
        !isConnectionScopedCatalogInput(entry, field) &&
        catalogInputHasImplicitValue(entry, field),
    );
  const hasMissingAdvancedCatalogInputs = () => {
    const entry = selectedCatalogEntry();
    if (!entry || !compatibility()) return false;
    return advancedCatalogInputs(entry).some(
      (field) => field.required && !catalogInputValue(entry, field).trim(),
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
    const currentSpaceId = spaceId();
    if (!currentSpaceId) {
      setSourceTokenError(t("new.error.spaceRequired"));
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
        spaceId: currentSpaceId,
        displayName: t("new.sourceAccess.defaultDisplayName", {
          name: name().trim() || capsuleNameFromUrl(gitUrl()) || "source",
        }),
        repoUrl: gitUrl().trim() || undefined,
        username: sourceTokenUsername().trim() || "git",
        token,
      });
      await testConnection(connection.id);
      await refetchConnections();
      setSourceAuthConnectionId(connection.id);
      setSourceAccessMode("existing");
      setSourceToken("");
      resetCompatibility();
    } catch (err) {
      const apiError = err instanceof ControlApiError ? err : undefined;
      setSourceTokenError(apiError?.message ?? String(err));
    } finally {
      setSavingSourceToken(false);
    }
  };

  createEffect(() => {
    if (!supportsProjectNameInput() || resourcePrefixTouched()) return;
    setResourcePrefix(defaultProjectName());
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
  const sameProviderFamily = (
    requiredProvider: string,
    connectionProvider: string,
  ) => {
    const required = canonicalProvider(requiredProvider);
    const connection = canonicalProvider(connectionProvider);
    if (required === connection) return true;
    return providerTail(required) === providerTail(connection);
  };

  const visibleProviderConnections = () =>
    providerConnections() ?? providerConnections.latest ?? [];
  const readyProviderConnections = () =>
    visibleProviderConnections().filter(
      (connection) => connection.status === "ready",
    );
  const connectionMatchesOwnershipOptions = (
    connection: ProviderConnection,
    ownershipOptions: readonly ProviderCredentialOwnership[],
  ) => ownershipOptions.includes(connection.ownership);
  const providerConnectionsForProvider = (
    provider: string,
    ownershipOptions: readonly ProviderCredentialOwnership[],
  ) =>
    readyProviderConnections().filter(
      (connection) =>
        connectionMatchesOwnershipOptions(connection, ownershipOptions) &&
        sameProviderFamily(provider, connection.providerSource),
    );
  const providerNeedsConnection = (row: ProviderConnectionRow) =>
    providerConnectionsForProvider(row.provider, row.ownershipOptions)
      .length === 0;
  const needsCloudCredential = () =>
    compatibility() !== null && providerRows().some(providerNeedsConnection);
  const missingProviderRows = () =>
    providerRows().filter(providerNeedsConnection);
  const providerRowNeedsVisibleChoice = (row: ProviderConnectionRow) => {
    const candidates = providerConnectionsForProvider(
      row.provider,
      row.ownershipOptions,
    );
    if (candidates.length !== 1) return true;
    return row.connectionId !== candidates[0]?.id;
  };
  const providerRowsRequiringChoice = () =>
    providerRows().filter(providerRowNeedsVisibleChoice);

  const defaultConnectionForProvider = (
    provider: string,
    ownershipOptions: readonly ProviderCredentialOwnership[],
    _resourceTypes: readonly string[],
  ): string => {
    const candidates = providerConnectionsForProvider(
      provider,
      ownershipOptions,
    );
    return candidates[0]?.id ?? "";
  };

  const defaultProviderRowsWithReadyConnections = (
    rows: readonly ProviderConnectionRow[],
  ): ProviderConnectionRow[] => {
    let changed = false;
    const defaultedRows = rows.map((row) => {
      const candidates = providerConnectionsForProvider(
        row.provider,
        row.ownershipOptions,
      );
      if (
        row.connectionId &&
        candidates.some((connection) => connection.id === row.connectionId)
      ) {
        return row;
      }
      const connectionId = defaultConnectionForProvider(
        row.provider,
        row.ownershipOptions,
        row.resourceTypes,
      );
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

  const ownershipOptionsForProvider = (
    provider: CapsuleCompatibilityProvider,
  ): readonly ProviderCredentialOwnership[] =>
    provider.ownershipOptions.length > 0
      ? provider.ownershipOptions
      : ["env"];

  const rowsFromCompatibility = (
    result: CapsuleCompatibilityResult,
  ): ProviderConnectionRow[] =>
    result.providers
      .filter((provider) => provider.allowed)
      .flatMap((provider) => {
        const aliases = provider.aliases.length > 0 ? provider.aliases : [""];
        const ownershipOptions = ownershipOptionsForProvider(provider);
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
          connectionId: defaultConnectionForProvider(
            provider.source,
            ownershipOptions,
            resourceTypes,
          ),
          ownershipOptions,
          resourceTypes,
        }));
      });

  const updateProviderRow = (
    index: number,
    patch: Partial<ProviderConnectionRow>,
  ) =>
    setProviderRows((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  const providerConnectionError = (): string | null => {
    for (const row of providerRows()) {
      const candidates = providerConnectionsForProvider(
        row.provider,
        row.ownershipOptions,
      );
      if (!row.connectionId.trim()) {
        return t("new.providers.errorConnection", {
          provider: row.provider,
        });
      }
      if (
        !candidates.some((connection) => connection.id === row.connectionId)
      ) {
        return t("new.providers.errorConnection", {
          provider: row.provider,
        });
      }
    }
    return null;
  };

  const providerConnectionsPayload =
    (): InstallationProviderConnectionBindings =>
      providerRows().map((row) => ({
        provider: row.provider,
        ...(row.alias ? { alias: row.alias } : {}),
        connectionId: row.connectionId,
      }));

  const resetCompatibility = () => {
    abortActiveFlow();
    setCompatibility(null);
    setProviderRows([]);
    setCreatedSourceId(null);
    setCreatedInstallationId(null);
    setExistingInstallation(null);
    setError(null);
  };

  const pickCatalogEntry = (entry: CatalogEntry) => {
    if (!entry.source) return;
    setGitUrl(entry.source.git);
    setRef(displayRef(entry.source.ref));
    setPinnedFullRef(
      isFullCommitSha(entry.source.ref) ? entry.source.ref : null,
    );
    setPath(entry.source.path);
    setName(entry.suggestedName);
    setSelectedCatalogId(entry.id);
    setInstallConfigId(entry.installConfigId);
    const defaults: Record<string, string> = {};
    for (const field of entry.inputs) {
      defaults[catalogInputKey(entry.id, field.name)] =
        catalogScopeHintValue(entry, field) ??
        catalogDefaultInputValue(entry, field, spaceId());
    }
    setCatalogInputValues(defaults);
    setCatalogInputTouched({});
    setResourcePrefix("");
    setResourcePrefixTouched(false);
    resetCompatibility();
    setActiveTab("catalog");
  };

  createEffect(() => {
    const entry = selectedCatalogEntry();
    if (!entry) return;
    setCatalogInputValues((current) => {
      let changed = false;
      const next: Record<string, string> = { ...current };
      for (const field of entry.inputs) {
        const key = catalogInputKey(entry.id, field.name);
        if (catalogInputTouched()[key]) continue;
        if ((next[key] ?? "").trim()) continue;
        const scopeHint = catalogScopeHintValue(entry, field);
        if (!scopeHint) continue;
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
    activeTab() !== "git" && Boolean(gitUrl().trim());
  const sourceSummaryTitle = () =>
    gitUrl().trim() ? name().trim() || capsuleNameFromUrl(gitUrl()) : "";
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
    // Blockers render inline from compatibility state (compat result panel /
    // cloud-account callout). Stop here so the user can resolve them first.
    if (!canContinue()) return;
    await runFlow();
  };
  const findExistingInstallation = async (
    space: string,
    installationName: string,
    environment: string,
  ): Promise<Installation | null> => {
    const installations = await listInstallations(space);
    return (
      installations.find(
        (installation) =>
          installation.status !== "destroyed" &&
          installation.name === installationName &&
          installation.environment === environment,
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
      const result = await checkCapsuleCompatibility({
        spaceId: spaceId()!,
        sourceId: createdSourceId() ?? undefined,
        gitUrl: gitUrl().trim(),
        ref: effectiveRef(),
        path: path().trim() || ".",
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
      if (apiError?.isSourceSyncRequired) {
        const sourceId = sourceIdFromControlError(apiError);
        if (sourceId) setCreatedSourceId(sourceId);
        setStepSource("done");
        setStepSync("error");
        setSyncRequired(true);
      } else if (apiError?.code === "source_sync_failed") {
        setStepSource("done");
        setStepSync("error");
      } else {
        setStepSource("error");
        setStepSync("idle");
      }
      setError(
        apiError?.isSourceSyncRequired
          ? t("new.error.syncPending")
          : apiError?.code === "source_sync_failed"
            ? t("new.error.sourceFetchFailed", {
                message: apiError.message,
              })
            : (apiError?.message ?? String(err)),
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
    if (!canContinue()) {
      setError(proceedBlocker());
      return;
    }
    setBusy(true);
    setError(null);
    setExistingInstallation(null);
    setSyncRequired(false);
    setSourceSyncRunStatus(null);
    startSourceSyncSlowTimer();
    const flow = startAbortableFlow();
    const space = spaceId()!;
    const flowInput = {
      name: name().trim(),
      gitUrl: gitUrl().trim(),
      ref: effectiveRef(),
      path: path().trim() || ".",
      authConnectionId: sourceAuthConnectionIdForRun(),
      installConfigId:
        compatibility()?.installConfigId ?? selectedInstallConfigId(),
      vars: installVariables(),
      providerConnections: providerConnectionsPayload(),
      sourceId: createdSourceId(),
      installationId: createdInstallationId(),
      syncDone: stepSync() === "done",
    };
    try {
      // Step 1 — create Source (skip if a previous attempt already created it).
      let sourceId = flowInput.sourceId;
      if (!sourceId) {
        setStepSource("running");
        const result = await createSource({
          spaceId: space,
          name: flowInput.name,
          url: flowInput.gitUrl,
          defaultRef: flowInput.ref,
          defaultPath: flowInput.path,
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

      // Step 3 — create the current compatibility record bound to the chosen
      // service-side config. Public UI presents this as Capsule creation.
      let installationId = flowInput.installationId;
      if (!installationId) {
        setStepInstall("running");
        const existing = await findExistingInstallation(
          space,
          flowInput.name,
          "production",
        ).catch(() => null);
        throwIfStaleFlow(flow);
        if (existing) {
          setStepInstall(INSTALLATION_DONE);
          setStepPlan("idle");
          setExistingInstallation(existing);
          return;
        }
        const installation = await createInstallation({
          spaceId: space,
          name: flowInput.name,
          environment: "production",
          sourceId,
          installConfigId: flowInput.installConfigId,
          ...(flowInput.vars ? { vars: flowInput.vars } : {}),
        });
        throwIfStaleFlow(flow);
        installationId = installation.id;
        setCreatedInstallationId(installationId);
      } else {
        setStepInstall("running");
      }
      await putInstallationProviderConnectionSet(
        installationId,
        flowInput.providerConnections,
      );
      throwIfStaleFlow(flow);
      setStepInstall("done");

      // Step 4 — create the first plan Run, then jump to the run screen.
      setStepPlan("running");
      const planEnvelope = await planInstallation(installationId);
      throwIfStaleFlow(flow);
      setStepPlan("done");
      const runId = extractRunId(planEnvelope);
      navigate(runId ? `/runs/${runId}` : "/");
    } catch (err) {
      if (isAbortError(err) || !isCurrentFlow(flow)) {
        return;
      }
      const apiError = err instanceof ControlApiError ? err : undefined;
      if (apiError?.isSourceSyncRequired) {
        setSyncRequired(true);
        setStepSync("error");
        setError(t("new.error.syncPending"));
      } else if (apiError?.code === "source_sync_failed") {
        setStepSync("error");
        setError(
          t("new.error.sourceFetchFailed", {
            message: apiError.message,
          }),
        );
      } else if (isDuplicateServiceError(apiError)) {
        setStepInstall(INSTALLATION_DONE);
        setStepPlan("idle");
        const existing = await findExistingInstallation(
          space,
          flowInput.name,
          "production",
        ).catch(() => null);
        throwIfStaleFlow(flow);
        if (existing) {
          setExistingInstallation(existing);
          setError(null);
        } else {
          setError(t("new.error.alreadyExists", { name: flowInput.name }));
        }
      } else {
        setError(apiError?.message ?? String(err));
      }
      if (stepPlan() === "running") setStepPlan("error");
      else if (stepInstall() === "running") setStepInstall("error");
      else if (stepSync() === "running") setStepSync("error");
      else if (stepSource() === "running") setStepSource("error");
    } finally {
      if (isCurrentFlow(flow)) {
        finishAbortableFlow(flow);
        clearSourceSyncSlowTimer();
        setBusy(false);
      }
    }
  };

  const stepIcon = (s: StepState): string =>
    s === "done" ? "✓" : s === "error" ? "✕" : s === "running" ? "…" : "·";
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
    <>
      <FormField label={t("new.git.url")}>
        <Input
          id="new-capsule-git-url"
          name="gitUrl"
          type="text"
          value={gitUrl()}
          onInput={(e) => {
            clearSelectedCatalog();
            setGitUrl(e.currentTarget.value);
            resetCompatibility();
          }}
          placeholder="https://github.com/your-name/service.git"
          autocomplete="off"
          spellcheck={false}
        />
      </FormField>

      <details
        class="wb-disclosure wb-source-access"
        open={sourceAccessMode() !== "public"}
      >
        <summary>
          <KeyRound size={15} aria-hidden="true" />
          {t("new.sourceAccess.title")}
        </summary>
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
      </details>

      <details class="wb-disclosure wb-source-advanced">
        <summary>{t("new.git.advanced")}</summary>
        <div class="wb-form-row">
          <FormField label={t("new.git.ref")}>
            <Input
              id="new-capsule-ref"
              name="ref"
              type="text"
              value={ref()}
              onInput={(e) => {
                clearSelectedCatalog();
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
                clearSelectedCatalog();
                setPath(e.currentTarget.value);
                resetCompatibility();
              }}
              placeholder="."
              autocomplete="off"
              spellcheck={false}
            />
          </FormField>
        </div>
      </details>
    </>
  );

  const prefilledLinkReview = () => {
    const capsule = capsuleNameFromUrl(gitUrl() || prefill?.git || "");
    return (
      <>
        <section class="av-link-review" aria-label={t("new.deeplink.aria")}>
          <div class="av-link-review-icon" aria-hidden="true">
            <Download size={20} />
          </div>
          <div class="av-link-review-main">
            <span class="av-link-review-kicker">
              {t("new.deeplink.kicker")}
            </span>
            <h3>{t("new.deeplink.title", { capsule })}</h3>
            <p>{t("new.deeplink.body")}</p>
            <dl class="av-link-review-meta">
              <div>
                <dt>{t("new.deeplink.source")}</dt>
                <dd>{sourceHostLabel(gitUrl())}</dd>
              </div>
              <div>
                <dt>{t("new.deeplink.version")}</dt>
                <dd>{displayRef(ref())}</dd>
              </div>
              <div>
                <dt>{t("new.deeplink.folder")}</dt>
                <dd>{displayModulePath(path())}</dd>
              </div>
            </dl>
          </div>
        </section>
        <details class="wb-disclosure wb-source-edit">
          <summary>{t("new.deeplink.editSource")}</summary>
          {gitFields()}
        </details>
      </>
    );
  };

  return (
    <AppShell>
      <Show
        when={spaceId()}
        fallback={
          <NoWorkspaceStartPanel
            busy={createFirstWorkspace.busy()}
            error={createFirstWorkspace.error()}
            onCreate={() => void createFirstWorkspace.run()}
          />
        }
      >
        <Show when={installPrefillRejected}>
          <div class="wb-action-callout" role="alert">
            <strong>{t("new.deeplink.invalidTitle")}</strong>
            <p>{t("new.deeplink.invalidBody")}</p>
          </div>
        </Show>

        <Show when={activeTab() !== "git" && !gitUrl().trim()}>
          <section class="av-store" aria-label={t("new.store.aria")}>
            <div class="av-store-head">
              <div>
                <h2>{t("new.store.title")}</h2>
              </div>
            </div>
            <Switch>
              <Match when={configs.loading}>
                <div class="av-catalog-grid" aria-busy="true">
                  <Skeleton variant="row" count={3} />
                </div>
              </Match>
              <Match when={configs.error}>
                <Toast tone="error">
                  {t("common.fetchFailed", {
                    message: (configs.error as ControlApiError).message,
                  })}
                </Toast>
              </Match>
              <Match when={!configs.loading && catalogEntries().length === 0}>
                <EmptyState
                  icon={<Download size={28} />}
                  title={t("new.store.empty.title")}
                  message={t("new.store.empty.message")}
                  action={
                    <Button variant="primary" href="/new?mode=link">
                      {t("new.advancedImport.open")}
                    </Button>
                  }
                />
              </Match>
              <Match when={catalogEntries().length > 0}>
                <>
                  <ul class="av-catalog-grid">
                    <For each={featuredCatalog()}>
                      {(entry) => (
                        <CatalogCard
                          entry={entry}
                          onSelect={pickCatalogEntry}
                        />
                      )}
                    </For>
                  </ul>
                  <Show
                    when={
                      showSecondaryCatalog() &&
                      buildingBlockCatalog().length > 0
                    }
                  >
                    <details class="wb-disclosure av-catalog-more">
                      <summary>{t("new.store.blocksTitle")}</summary>
                      <ul class="av-catalog-grid av-catalog-grid-secondary">
                        <For each={buildingBlockCatalog()}>
                          {(entry) => (
                            <CatalogCard
                              entry={entry}
                              onSelect={pickCatalogEntry}
                            />
                          )}
                        </For>
                      </ul>
                    </details>
                  </Show>
                  <Show
                    when={showSecondaryCatalog() && exampleCatalog().length > 0}
                  >
                    <details class="wb-disclosure av-catalog-more">
                      <summary>{t("new.store.examplesTitle")}</summary>
                      <ul class="av-catalog-grid av-catalog-grid-secondary">
                        <For each={exampleCatalog()}>
                          {(entry) => (
                            <CatalogCard
                              entry={entry}
                              onSelect={pickCatalogEntry}
                            />
                          )}
                        </For>
                      </ul>
                    </details>
                  </Show>
                </>
              </Match>
            </Switch>
            <div class="av-manual-import">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => setActiveTab("git")}
              >
                {t("new.advancedImport.open")}
              </Button>
            </div>
          </section>
        </Show>

        <Show when={activeTab() === "git" || Boolean(gitUrl().trim())}>
          <Card class="av-import-card">
            <CardHeader
              title={
                usingSelectedService()
                  ? (selectedCatalogEntry()?.name[locale()] ??
                    sourceSummaryTitle())
                  : t("new.advancedImport.title")
              }
              subtitle={
                usingSelectedService()
                  ? (selectedCatalogEntry()?.description[locale()] ??
                    t("new.selection.subtitle"))
                  : t("new.advancedImport.subtitle")
              }
              actions={
                activeTab() === "git" && !gitUrl().trim() ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setActiveTab("catalog")}
                  >
                    {t("new.advancedImport.close")}
                  </Button>
                ) : undefined
              }
            />
            <CardSection>
              <form
                class="wb-install-form wb-install-source-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitInstall();
                }}
              >
                <Show when={!usingSelectedService()}>
                  {prefill ? prefilledLinkReview() : gitFields()}
                </Show>

                <Show when={selectedCatalogEntry()}>
                  {(entry) => (
                    <section class="av-service-setup">
                      <div class="av-service-setup-head">
                        <h3>{t("new.catalogInput.title")}</h3>
                        <p>{t("new.catalogInput.subtitle")}</p>
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
                        <For each={visibleCatalogInputs(entry())}>
                          {(field) => (
                            <FormField
                              label={field.label[locale()]}
                              hint={field.helper?.[locale()]}
                              required={field.required}
                            >
                              <Input
                                id={`catalog-input-${entry().id}-${field.name}`}
                                name={`catalogInput:${field.name}`}
                                type="text"
                                value={catalogInputValue(entry(), field)}
                                onInput={(e) =>
                                  updateCatalogInputValue(
                                    entry(),
                                    field,
                                    e.currentTarget.value,
                                  )
                                }
                                placeholder={field.placeholder ?? ""}
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                          )}
                        </For>
                      </div>
                    </section>
                  )}
                </Show>

                <Show when={!selectedCatalogEntry()}>
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
                    hasMissingAdvancedCatalogInputs()
                  }
                >
                  <summary>{t("new.serviceAdvanced.title")}</summary>
                  <Show when={selectedCatalogEntry()}>
                    {(entry) => (
                      <Show when={advancedCatalogInputs(entry()).length > 0}>
                        <section class="wb-stack">
                          <For each={advancedCatalogInputs(entry())}>
                            {(field) => (
                              <FormField
                                label={field.label[locale()]}
                                hint={field.helper?.[locale()]}
                                required={field.required}
                              >
                                <Input
                                  id={`catalog-input-advanced-${entry().id}-${field.name}`}
                                  name={`catalogInputAdvanced:${field.name}`}
                                  type="text"
                                  value={catalogInputValue(entry(), field)}
                                  onInput={(e) =>
                                    updateCatalogInputValue(
                                      entry(),
                                      field,
                                      e.currentTarget.value,
                                    )
                                  }
                                  placeholder={field.placeholder ?? ""}
                                  autocomplete="off"
                                  spellcheck={false}
                                />
                              </FormField>
                            )}
                          </For>
                        </section>
                      </Show>
                    )}
                  </Show>
                  <Show when={supportsProjectNameInput()}>
                    <FormField label={t("new.vars.projectName")}>
                      <Input
                        id="new-project-name"
                        name="project_name"
                        type="text"
                        value={projectNameVariable()}
                        onInput={(e) => {
                          setResourcePrefixTouched(true);
                          setResourcePrefix(e.currentTarget.value);
                          resetCompatibility();
                        }}
                        placeholder="photo-blog"
                        autocomplete="off"
                        spellcheck={false}
                      />
                    </FormField>
                  </Show>
                  <section class="wb-stack">
                    <h3 class="tg-card-title">{t("new.vars.inputsTitle")}</h3>
                    <p class="wb-note">{t("new.vars.inputsBody")}</p>
                    <div class="wb-variable-list">
                      <For each={inputVariables()}>
                        {(row, index) => (
                          <div class="wb-variable-row">
                            <FormField label={t("new.vars.inputName")}>
                              <Input
                                name={`varName:${index()}`}
                                type="text"
                                value={row.name}
                                onInput={(e) =>
                                  updateInputVariable(index(), {
                                    name: e.currentTarget.value,
                                  })
                                }
                                placeholder="setting"
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                            <FormField label={t("new.vars.inputValue")}>
                              <Input
                                name={`varValue:${index()}`}
                                type="text"
                                value={row.value}
                                onInput={(e) =>
                                  updateInputVariable(index(), {
                                    value: e.currentTarget.value,
                                  })
                                }
                                placeholder="value"
                                autocomplete="off"
                                spellcheck={false}
                              />
                            </FormField>
                            <Button
                              type="button"
                              variant="ghost"
                              icon={<Trash size={16} />}
                              onClick={() => removeInputVariable(index())}
                            >
                              {t("new.vars.removeInput")}
                            </Button>
                          </div>
                        )}
                      </For>
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

                <Show when={!configs.loading && configList().length === 0}>
                  <p class="wb-error" role="alert">
                    {t("new.error.configMissing")}
                  </p>
                </Show>

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
                            {compatibilitySummaryDisplay(result())}
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
                          const options = () =>
                            providerConnectionsForProvider(
                              row.provider,
                              row.ownershipOptions,
                            );
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
                                  updateProviderRow(index(), {
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

                <div class="wb-form-actions">
                  <Button
                    variant="primary"
                    type="submit"
                    busy={checkingCompatibility() || busy()}
                    disabled={
                      checkingCompatibility() ||
                      busy() ||
                      (compatibility() !== null && !canContinue())
                    }
                  >
                    {checkingCompatibility()
                      ? t("new.compat.checking")
                      : busy()
                        ? t("new.installing")
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
                <Show when={existingInstallation()}>
                  {(installation) => (
                    <div class="wb-action-callout" role="status">
                      <strong>{t("new.existing.title")}</strong>
                      <p>
                        {t("new.existing.body", {
                          name: installation().name,
                          environment: installation().environment,
                        })}
                      </p>
                      <Button
                        variant="secondary"
                        size="sm"
                        href={`/services/${encodeURIComponent(installation().id)}`}
                      >
                        {t("new.existing.open")}
                      </Button>
                    </div>
                  )}
                </Show>
              </form>

              <Show when={showSetupProgress()} fallback={null}>
                <details class="wb-disclosure">
                  <summary>{t("new.step.technical")}</summary>
                  <ol class="wb-steps">
                    <li class={`wb-step ${stepClass(stepSource())}`}>
                      <span class="wb-step-icon">{stepIcon(stepSource())}</span>
                      {t("new.step.register")}
                    </li>
                    <li class={`wb-step ${stepClass(stepSync())}`}>
                      <span class="wb-step-icon">{stepIcon(stepSync())}</span>
                      {t("new.step.sync")}
                    </li>
                    <li class={`wb-step ${stepClass(stepInstall())}`}>
                      <span class="wb-step-icon">
                        {stepIcon(stepInstall())}
                      </span>
                      {t("new.step.create")}
                    </li>
                    <li class={`wb-step ${stepClass(stepPlan())}`}>
                      <span class="wb-step-icon">{stepIcon(stepPlan())}</span>
                      {t("new.step.plan")}
                    </li>
                  </ol>
                </details>
              </Show>
            </CardSection>
          </Card>
        </Show>
      </Show>
    </AppShell>
  );
}
