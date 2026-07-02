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
import type { JsonValue } from "takosumi-contract";
import { providerEnvRule } from "takosumi-contract/provider-env-rules";
import AppShell from "../account/components/shell/AppShell.tsx";
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
import { firstPartyStoreListings } from "../store/first-party-listings.ts";
import { buildNewQuery } from "../store/store-link.ts";
import type { TcsListing } from "../../lib/tcs-client.ts";
import {
  clearCapsuleListCache,
  listCapsulesCached,
} from "../../lib/capsule-list.ts";
import { listInstallConfigsCached } from "../../lib/install-config-list.ts";
import {
  Badge,
  Button,
  FormField,
  Input,
  Select,
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
  readonly resourceTypes: readonly string[];
}

interface InputVariableRow {
  readonly name: string;
  readonly value: string;
  readonly jsonValue?: JsonValue;
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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: NonNullable<NonNullable<InstallConfig["catalog"]>["source"]>;
};
type CatalogInputField = CatalogEntry["inputs"][number];
type CatalogInstallConfig = InstallConfig & {
  readonly catalog: NonNullable<InstallConfig["catalog"]> & {
    readonly source: NonNullable<
      NonNullable<InstallConfig["catalog"]>["source"]
    >;
  };
};

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

function sourceFetchErrorMessage(
  apiError: ControlApiError | undefined,
): string {
  const message = apiError?.message.trim() ?? "";
  const refMatch = /source ref did not resolve to a commit:\s*([^\s)]+)/iu.exec(
    message,
  );
  if (refMatch?.[1]) {
    return t("new.error.sourceRefNotFound", { ref: refMatch[1] });
  }
  return t("new.error.sourceFetchFailed", {
    message: message || t("new.error.sourceFetchFailedUnknown"),
  });
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

function workspaceSuffix(value: string | null): string {
  return (value ?? "")
    .replace(/^workspace_/u, "")
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
  if (
    config.workspaceId === undefined ||
    config.id.startsWith("cfg-official-")
  ) {
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
  workspaceId: string | null,
): string {
  const base = slugInputValue(entry.suggestedName);
  const suffix = workspaceSuffix(workspaceId);
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

function catalogVariablePath(name: string): readonly string[] | undefined {
  const path = name.split(".").map((part) => part.trim());
  if (path.length === 0) return undefined;
  return path.every(isSafeCatalogVariablePathSegment) ? path : undefined;
}

function isSafeCatalogVariablePathSegment(value: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

function catalogInputJsonValue(
  field: CatalogInputField,
  raw: string,
): JsonValue | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (field.type === "boolean") {
    const normalized = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  if (field.type === "number") {
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) return numberValue;
  }
  return value;
}

function setCatalogJsonVariable(
  target: Record<string, JsonValue>,
  name: string,
  value: JsonValue,
): void {
  const path = catalogVariablePath(name);
  if (!path) return;
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    const next = isJsonRecord(existing) ? { ...existing } : {};
    cursor[segment] = next;
    cursor = next;
  }
  cursor[path[path.length - 1]!] = value;
}

function isJsonRecord(
  value: JsonValue | undefined,
): value is Record<string, JsonValue> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function installVariableDisplayValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function inputVariableRowsFromPrefill(
  vars: Readonly<Record<string, JsonValue>> | undefined,
): readonly InputVariableRow[] {
  return Object.entries(vars ?? {})
    .filter(([name]) => name !== "project_name")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({
      name,
      value: installVariableDisplayValue(value),
      ...(typeof value === "string" ? {} : { jsonValue: value }),
    }));
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

function defaultWorkspaceHandle(): string {
  const time = Date.now().toString(36).slice(-6);
  const random = Math.random().toString(36).slice(2, 8) || "new";
  return `workspace-${time}-${random}`.slice(0, 39);
}

function parseInitialInstallConfigId(search: string): string | null {
  const raw = new URLSearchParams(search).get("installConfigId")?.trim();
  if (!raw || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(raw)) return null;
  return raw;
}

function initialAddTab(search: string): "catalog" | "git" {
  // Start on the service browser. Install links and pasted source links enter
  // the same flow after a source is selected.
  return parseInitialInstallConfigId(search) || !hasInstallPrefillParams(search)
    ? "catalog"
    : "git";
}

function Inner() {
  const navigate = useNavigate();

  // External install link (client-handled): another site links
  // `/install?git=…` (or the packed `?source=git::…` form), the router
  // forwards the query here, and the parser seeds the Git form. A link only
  // PRE-FILLS — the visitor still confirms in this client (compatibility
  // check, then the explicit add button).
  const initialSearch = typeof location === "undefined" ? "" : location.search;
  const appHandoff = appHandoffFromSearch(initialSearch);
  const initialInstallPrefill =
    typeof location === "undefined"
      ? undefined
      : parseInstallPrefill(initialSearch);
  const installPrefillRejected =
    typeof location !== "undefined" &&
    !initialInstallPrefill &&
    hasInstallPrefillParams(initialSearch);
  const initialInstallConfigId = parseInitialInstallConfigId(initialSearch);
  const [linkDraft, setLinkDraft] = createSignal(
    initialInstallPrefill?.git ?? "",
  );

  // `/new` opens the install-link form. External `/install?git=…` redirects and
  // store hand-offs (`?installConfigId=…`) seed the same Git-backed flow.
  const [activeTab, setActiveTab] = createSignal<"catalog" | "git">(
    initialAddTab(initialSearch),
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
  const [activeInstallPrefill, setActiveInstallPrefill] =
    createSignal<InstallPrefill | null>(initialInstallPrefill ?? null);
  const initialRef = initialInstallPrefill?.ref || "main";
  const [gitUrl, setGitUrl] = createSignal(initialInstallPrefill?.git ?? "");
  const [ref, setRef] = createSignal(displayRef(initialRef));
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
  const initialProjectName =
    typeof initialInstallPrefill?.vars?.project_name === "string"
      ? initialInstallPrefill.vars.project_name
      : "";
  const [name, setName] = createSignal(initialName);
  const [resourcePrefix, setResourcePrefix] = createSignal(initialProjectName);
  const [resourcePrefixTouched, setResourcePrefixTouched] = createSignal(
    initialProjectName !== "",
  );
  const [inputVariables, setInputVariables] = createSignal<
    readonly InputVariableRow[]
  >(inputVariableRowsFromPrefill(initialInstallPrefill?.vars));
  const [installConfigId, setInstallConfigId] = createSignal("");
  const [compatibility, setCompatibility] =
    createSignal<CapsuleCompatibilityResult | null>(null);
  const [checkingCompatibility, setCheckingCompatibility] = createSignal(false);
  const [providerRows, setProviderRows] = createSignal<ProviderConnectionRow[]>(
    [],
  );

  const workspaceId = () =>
    currentWorkspaceId() ? currentWorkspaceId() : null;
  const shouldLoadStarterConfigs = () => {
    const id = workspaceId();
    return id && initialInstallConfigId ? id : null;
  };
  const shouldLoadInstallConfigs = () => {
    const id = workspaceId();
    if (!id) return null;
    if (activeTab() === "git") return id;
    if (gitUrl().trim() || activeInstallPrefill() || selectedCatalogId()) {
      return id;
    }
    return null;
  };
  const [starterConfigs] = createResource(
    shouldLoadStarterConfigs,
    (id) => listInstallConfigsCached(id, { view: "starter-catalog" }),
  );
  const [installConfigs] = createResource(shouldLoadInstallConfigs, (id) =>
    listInstallConfigsCached(id),
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
  const starterConfigList = createMemo<readonly InstallConfig[]>(
    () => starterConfigs() ?? [],
  );
  const installConfigList = createMemo<readonly InstallConfig[]>(
    () => installConfigs() ?? [],
  );
  const allCatalogEntries = createMemo<readonly CatalogEntry[]>(() =>
    dedupeCatalogConfigs(
      starterConfigList().filter((config): config is CatalogInstallConfig =>
        Boolean(config.catalog?.source),
      ),
    )
      .map((config) => ({
        id: config.catalog.templateId ?? config.id,
        installConfigId: config.id,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        ...config.catalog,
      }))
      .sort(
        (a, b) =>
          catalogSurfaceRank(a.surface) - catalogSurfaceRank(b.surface) ||
          a.order - b.order ||
          a.name[locale()].localeCompare(b.name[locale()]),
      ),
  );
  const localStoreListings = createMemo<readonly TcsListing[]>(
    () => firstPartyStoreListings,
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
    installConfigList().find((config) => config.sourceKind === "generic_capsule");
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
  const selectedCatalogEntry = () => {
    const id = selectedCatalogId();
    return id
      ? (allCatalogEntries().find((entry) => entry.id === id) ?? null)
      : null;
  };
  const catalogInputValue = (entry: CatalogEntry, field: CatalogInputField) => {
    const key = catalogInputKey(entry.id, field.name);
    return (
      catalogInputValues()[key] ??
      catalogDefaultInputValue(entry, field, workspaceId())
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
    const variables: Record<string, JsonValue> = {};
    for (const field of entry.inputs) {
      const value = catalogInputJsonValue(
        field,
        catalogInputValue(entry, field),
      );
      if (value !== undefined) {
        setCatalogJsonVariable(variables, field.name, value);
      }
    }
    return variables;
  };
  const selectedCatalogReturnVariables = (): Readonly<
    Record<string, string>
  > => {
    const entry = selectedCatalogEntry();
    if (!entry) return {};
    const variables: Record<string, string> = {};
    for (const field of entry.inputs) {
      if (!isSafeInstallVariableName(field.name)) continue;
      const value = catalogInputValue(entry, field).trim();
      if (value) variables[field.name] = value;
    }
    return variables;
  };
  const selectedCatalogVariableNames = () => {
    const entry = selectedCatalogEntry();
    if (!entry) return new Set<string>();
    return new Set(
      entry.inputs
        .map((field) => catalogVariablePath(field.name)?.[0])
        .filter((name): name is string => name !== undefined),
    );
  };
  const catalogInputError = (): string | null => {
    const entry = selectedCatalogEntry();
    if (!entry) return null;
    for (const field of entry.inputs) {
      if (!catalogVariablePath(field.name)) {
        return t("new.vars.errorUnsafeName", { name: field.name });
      }
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
  const currentInstallPrefill = () =>
    activeInstallPrefill() ?? parseInstallPrefillFromInput(gitUrl());
  const sourceGitUrl = () => currentInstallPrefill()?.git ?? gitUrl().trim();
  const sourceRef = () => {
    const prefill = currentInstallPrefill();
    return prefill ? prefill.ref || "main" : effectiveRef();
  };
  const sourcePath = () =>
    currentInstallPrefill()?.path || path().trim() || ".";
  const prefilledProjectName = () => {
    const value = currentInstallPrefill()?.vars?.project_name;
    return typeof value === "string" ? value : undefined;
  };
  const supportsProjectNameInput = () => prefilledProjectName() !== undefined;
  const defaultProjectName = () => {
    return slugInputValue(name() || capsuleNameFromUrl(sourceGitUrl()));
  };
  const projectNameVariable = () =>
    slugInputValue(
      resourcePrefix() || prefilledProjectName() || defaultProjectName(),
    );
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
  const installReturnVariables = (): Readonly<Record<string, JsonValue>> => {
    const variables: Record<string, JsonValue> = {};
    if (supportsProjectNameInput()) {
      variables.project_name = projectNameVariable();
    }
    Object.assign(variables, selectedCatalogReturnVariables());
    Object.assign(variables, normalizedInputVariables());
    return variables;
  };
  const installVariables = ():
    Readonly<Record<string, JsonValue>> | undefined => {
    const variables: Record<string, JsonValue> = {
      ...(currentInstallPrefill()?.vars ?? {}),
      ...selectedCatalogVariables(),
      ...normalizedInputVariables(),
    };
    if (supportsProjectNameInput()) {
      variables.project_name = projectNameVariable();
    }
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
    if (!supportsProjectNameInput() || resourcePrefixTouched()) return;
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
  const providerRequiresConnection = (provider: string) =>
    providerEnvRule(provider) !== undefined;
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
  const readyProviderConnections = () =>
    visibleProviderConnections().filter(
      (connection) => connection.status === "verified",
    );
  const providerConnectionsForProvider = (provider: string) =>
    readyProviderConnections().filter((connection) =>
      sameProviderFamily(provider, connection.providerSource),
    );
  const providerNeedsConnection = (row: ProviderConnectionRow) =>
    providerRequiresConnection(row.provider) &&
    providerConnectionsForProvider(row.provider).length === 0;
  const needsCloudCredential = () =>
    compatibility() !== null && providerRows().some(providerNeedsConnection);
  const missingProviderRows = () =>
    providerRows().filter(providerNeedsConnection);
  const providerRowNeedsVisibleChoice = (row: ProviderConnectionRow) => {
    if (!providerRequiresConnection(row.provider)) return false;
    const candidates = providerConnectionsForProvider(row.provider);
    if (candidates.length !== 1) return true;
    return row.connectionId !== candidates[0]?.id;
  };
  const providerRowsRequiringChoice = () =>
    providerRows().filter(providerRowNeedsVisibleChoice);

  const defaultConnectionForProvider = (provider: string): string => {
    const candidates = providerConnectionsForProvider(provider);
    return candidates[0]?.id ?? "";
  };

  const defaultProviderRowsWithReadyConnections = (
    rows: readonly ProviderConnectionRow[],
  ): ProviderConnectionRow[] => {
    let changed = false;
    const defaultedRows = rows.map((row) => {
      const candidates = providerConnectionsForProvider(row.provider);
      if (
        row.connectionId &&
        candidates.some((connection) => connection.id === row.connectionId)
      ) {
        return row;
      }
      const connectionId = defaultConnectionForProvider(row.provider);
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
          connectionId: defaultConnectionForProvider(provider.source),
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
      const candidates = providerConnectionsForProvider(row.provider);
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

  const providerConnectionsPayload = (): CapsuleProviderConnectionBindings =>
    providerRows()
      .filter((row) => providerRequiresConnection(row.provider))
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
    setError(null);
  };
  const applyInstallPrefillInput = (next: InstallPrefill) => {
    const nextRef = next.ref || "main";
    setActiveTab("git");
    setActiveInstallPrefill(next);
    setGitUrl(next.git);
    setRef(displayRef(nextRef));
    setPinnedFullRef(isFullCommitSha(nextRef) ? nextRef : null);
    setPath(next.path || ".");
    if (next.name || !name().trim()) {
      setName(next.name ?? capsuleNameFromUrl(next.git));
    }
    setInputVariables(inputVariableRowsFromPrefill(next.vars));
    const nextProjectName =
      typeof next.vars?.project_name === "string"
        ? next.vars.project_name
        : undefined;
    if (nextProjectName) {
      setResourcePrefix(nextProjectName);
      setResourcePrefixTouched(true);
    } else {
      setResourcePrefix("");
      setResourcePrefixTouched(false);
    }
    resetCompatibility();
  };

  const pickCatalogEntry = (entry: CatalogEntry) => {
    if (!entry.source) return;
    void loadConnections();
    setActiveInstallPrefill(null);
    setLinkDraft("");
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
        catalogDefaultInputValue(entry, field, workspaceId());
    }
    setCatalogInputValues(defaults);
    setCatalogInputTouched({});
    setResourcePrefix("");
    setResourcePrefixTouched(false);
    resetCompatibility();
    setActiveTab("catalog");
  };
  const pickStoreListing = (listing: TcsListing) => {
    const localEntry = listing.installConfigId
      ? allCatalogEntries().find(
          (entry) =>
            entry.installConfigId === listing.installConfigId ||
            entry.id === listing.installConfigId,
        )
      : undefined;
    if (localEntry) {
      pickCatalogEntry(localEntry);
      return;
    }

    const prefill = parseInstallPrefill(`?${buildNewQuery(listing)}`);
    if (prefill) {
      applyInstallPrefillInput(prefill);
      return;
    }

    setActiveTab("git");
    setActiveInstallPrefill(null);
    setSelectedCatalogId(null);
    setGitUrl(listing.source.git);
    setRef(displayRef(listing.source.resolvedCommit ?? listing.source.ref));
    setPinnedFullRef(
      isFullCommitSha(listing.source.resolvedCommit ?? listing.source.ref)
        ? (listing.source.resolvedCommit ?? listing.source.ref)
        : null,
    );
    setPath(listing.source.path || ".");
    setName(listing.suggestedName);
    setInputVariables([]);
    resetCompatibility();
  };
  const startLinkImport = () => {
    const raw = linkDraft().trim();
    if (!raw) {
      setActiveTab("git");
      clearSelectedCatalog();
      return;
    }
    const parsed = parseInstallPrefillFromInput(raw);
    if (parsed) {
      applyInstallPrefillInput(parsed);
      return;
    }
    clearSelectedCatalog();
    setActiveTab("git");
    setActiveInstallPrefill(null);
    setGitUrl(raw);
    setName(name().trim() || capsuleNameFromUrl(raw));
    setRef("main");
    setPinnedFullRef(null);
    setPath(".");
    resetCompatibility();
  };

  let initialCatalogApplied = false;
  createEffect(() => {
    if (initialCatalogApplied || !initialInstallConfigId) return;
    const entry = allCatalogEntries().find(
      (candidate) =>
        candidate.installConfigId === initialInstallConfigId ||
        candidate.id === initialInstallConfigId,
    );
    if (!entry) return;
    initialCatalogApplied = true;
    pickCatalogEntry(entry);
  });

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
    activeTab() !== "git" && Boolean(sourceGitUrl());
  const hasChosenSource = () =>
    activeTab() === "git" || usingSelectedService() || Boolean(sourceGitUrl());
  const addGuideStage = (): "select" | "configure" | "review" => {
    if (busy() || existingCapsule() || canContinue()) return "review";
    return hasChosenSource() ? "configure" : "select";
  };
  const addGuideClass = (stage: "select" | "configure" | "review"): string => {
    const order = { select: 0, configure: 1, review: 2 } as const;
    const current = addGuideStage();
    if (stage === current) return "is-current";
    return order[stage] < order[current] ? "is-done" : "";
  };
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
  const findExistingCapsule = async (
    workspace: string,
    capsuleName: string,
    environment: string,
  ): Promise<Capsule | null> => {
    const capsules = await listCapsulesCached(workspace, {
      includeDestroyed: false,
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
      const result = await checkCapsuleCompatibility({
        workspaceId: workspaceId()!,
        sourceId: createdSourceId() ?? undefined,
        gitUrl: sourceGitUrl(),
        ref: sourceRef(),
        path: sourcePath(),
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
            ? sourceFetchErrorMessage(apiError)
            : t("new.error.generic"),
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
      path: sourcePath(),
      authConnectionId: sourceAuthConnectionIdForRun(),
      installConfigId:
        compatibility()?.installConfigId ?? selectedInstallConfigId(),
      compatibilityReportId: compatibility()?.reportId,
      vars: installVariables(),
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
        });
        throwIfStaleFlow(flow);
        clearCapsuleListCache(workspace);
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
      const planEnvelope = await planCapsule(
        capsuleId,
        flowInput.compatibilityReportId
          ? { compatibilityReportId: flowInput.compatibilityReportId }
          : {},
      );
      throwIfStaleFlow(flow);
      setStepPlan("done");
      const runId = extractRunId(planEnvelope);
      navigate(
        runId
          ? (appendAppHandoff(`/runs/${runId}`, appHandoff) ?? `/runs/${runId}`)
          : "/",
      );
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
        setError(sourceFetchErrorMessage(apiError));
      } else if (isDuplicateServiceError(apiError)) {
        setStepInstall(INSTALLATION_DONE);
        setStepPlan("idle");
        const existing = await findExistingCapsule(
          workspace,
          flowInput.name,
          "production",
        ).catch(() => null);
        throwIfStaleFlow(flow);
        if (existing) {
          setExistingCapsule(existing);
          setError(null);
        } else {
          setError(t("new.error.alreadyExists", { name: flowInput.name }));
        }
      } else {
        setError(t("new.error.generic"));
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
    const capsule = capsuleNameFromUrl(sourceGitUrl());
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
        <details class="wb-disclosure wb-source-edit">
          <summary>{t("new.deeplink.editSource")}</summary>
          {gitFields()}
        </details>
      </>
    );
  };
  const addSummaryTitle = () =>
    selectedCatalogEntry()?.name[locale()] ||
    name().trim() ||
    capsuleNameFromUrl(sourceGitUrl()) ||
    t("new.advancedImport.title");
  const addSummaryDescription = () =>
    selectedCatalogEntry()?.description[locale()] ||
    (activeTab() === "git"
      ? t("new.advancedImport.subtitle")
      : t("new.selection.subtitle"));
  const addSummaryProvider = () =>
    selectedCatalogEntry()
      ? providerDisplayName(selectedCatalogEntry()!.provider)
      : sourceHostLabel(sourceGitUrl());

  return (
    <AppShell>
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
            </header>
            <StoreBrowser
              locale={locale()}
              localListings={localStoreListings()}
              onInstall={pickStoreListing}
              onConfigure={pickStoreListing}
              showSourceControls={false}
              showSortControl={false}
              showKindFilters={false}
              loadRemoteOnMount={false}
            />
          </section>
        </Show>

        <Show when={hasChosenSource()}>
          <section class="av-add-flow" aria-label={t("new.title")}>
            <div class="av-add-flow-header">
              <div class="av-add-flow-selected">
                <div class="av-add-flow-icon" aria-hidden="true">
                  <Show
                    when={selectedCatalogEntry()}
                    fallback={<Download size={22} />}
                  >
                    {(entry) => <CatalogIcon entry={entry()} />}
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
                      ? (selectedCatalogEntry()?.name[locale()] ??
                        sourceSummaryTitle())
                      : t("new.advancedImport.title")}
                  </h2>
                  <p>
                    {usingSelectedService()
                      ? (selectedCatalogEntry()?.description[locale()] ??
                        t("new.selection.subtitle"))
                      : t("new.advancedImport.subtitle")}
                  </p>
                </div>
              </div>
              <ol class="av-add-guide" aria-label={t("new.flow.aria")}>
                <li class={addGuideClass("select")}>
                  <span>1</span>
                  {t("new.flow.stepSelect")}
                </li>
                <li class={addGuideClass("configure")}>
                  <span>2</span>
                  {t("new.flow.stepConfigure")}
                </li>
                <li class={addGuideClass("review")}>
                  <span>3</span>
                  {t("new.flow.stepReview")}
                </li>
              </ol>
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

                <Show
                  when={
                    !starterConfigs.loading &&
                    starterConfigList().length === 0 &&
                    !hasChosenSource()
                  }
                >
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
                            providerConnectionsForProvider(row.provider);
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
                        when={selectedCatalogEntry()}
                        fallback={<Download size={22} />}
                      >
                        {(entry) => <CatalogIcon entry={entry()} />}
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
                      <dt>{t("new.summary.provider")}</dt>
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
                        <span class="wb-step-icon">
                          {stepIcon(stepSource())}
                        </span>
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
              </aside>
            </div>
          </section>
        </Show>
      </Show>
    </AppShell>
  );
}
