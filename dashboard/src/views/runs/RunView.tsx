/**
 * Run view (`/runs/:id`) — where a review lands after "変更を確認" and where a
 * deploy is executed.
 *
 * Layered for both personas: the SUMMARY layer leads with one plain sentence
 * about what is happening and the single next action (approve / deploy /
 * retry), plus the create/update/delete counts and any cost notice. Expert
 * material (snapshot ids, digests, policy, inputs, connections, audit trail)
 * lives in folded detail sections below — except diagnostics, which unfold
 * automatically when the run failed.
 *
 * Flow logic is unchanged from the legacy run screen: poll while non-terminal,
 * approve `waiting_approval`, apply a finished policy-passed plan
 * (destructive plans need an explicit second confirmation), billing `blocked`
 * gates the deploy button.
 */
import "../../styles/wave-a.css";
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
import { useNavigate, useParams } from "@solidjs/router";
import { Activity, ExternalLink } from "lucide-solid";
import Page from "../account/components/auth/Page.tsx";
import {
  approveRun,
  ControlApiError,
  cancelRun,
  createApplyRun,
  extractRunId,
  getCapsule,
  getRun,
  getRunCostInfo,
  getRunLogs,
  listActivity,
  listDeployments,
  listProviderConnections,
  listRuns,
  openRunStream,
  planCapsule,
  type ProviderConnection,
  type ProviderResolution,
  type Run,
  type RunAuditEvent,
  type RunCostInfo,
  type RunDiagnostic,
  type RunPlanResource,
} from "../../lib/control-api.ts";
import { isTakosumiCloudRuntime } from "../../lib/deployment-brand.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  changeCountsForRun,
  changesFromLogs,
  connectionNamesFromLogs,
  inputNamesFromLogs,
  isTerminalRunStatus,
} from "../../lib/run-logs.ts";
import { launchUrlFromDeployment } from "../../lib/capsules-ui.ts";
import {
  appendAppHandoff,
  createAppHandoffConnectHref,
  appHandoffFromSearch,
  appHandoffProductLabel,
} from "../../lib/app-handoff.ts";
import {
  diagnosticSeverityLabel,
  operationLabel,
  policyStatusLabel,
  policyTone,
  runStatusLabel,
  runTone,
} from "../../lib/labels.ts";
import { clearCapsuleListCache } from "../../lib/capsule-list.ts";
import { runFailureHint } from "../../lib/run-errors.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import {
  formatDateTime,
  locale,
  setDocumentTitle,
  t,
} from "../../i18n/index.ts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  KVList,
  type KVItem,
  PageHeader,
  Skeleton,
  StatusBadge,
  type Tone,
} from "../../components/ui/index.ts";

const APPLY_REQUEST_TIMEOUT_MS = 45_000;

export default function RunView() {
  return <Page>{() => <Inner />}</Page>;
}

function formatUsdMicros(value: number): string {
  return new Intl.NumberFormat(locale() === "ja" ? "ja-JP" : "en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value % 10_000 === 0 ? 2 : 6,
  }).format(value / 1_000_000);
}

function costEstimatedUsdMicros(cost: RunCostInfo): number {
  return (
    cost.estimatedUsdMicros ?? Math.round(cost.estimatedCredits * 1_000_000)
  );
}

function costAvailableUsdMicros(cost: RunCostInfo): number | undefined {
  return (
    cost.availableUsdMicros ??
    (cost.availableCredits === undefined
      ? undefined
      : Math.round(cost.availableCredits * 1_000_000))
  );
}

function costShortfallUsdMicros(cost: RunCostInfo): number | undefined {
  return (
    cost.shortfallUsdMicros ??
    (cost.creditShortfall === undefined
      ? undefined
      : Math.round(cost.creditShortfall * 1_000_000))
  );
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof ControlApiError && error.code === "request_timeout";
}

function latestApplyRunForPlan(
  runs: readonly Run[],
  planRun: Run,
): Run | undefined {
  const planCreatedAt = Date.parse(planRun.createdAt);
  return runs.find((candidate) => {
    if (candidate.type !== "apply") return false;
    if (candidate.capsuleId !== planRun.capsuleId) return false;
    if (Number.isNaN(planCreatedAt)) return true;
    const candidateCreatedAt = Date.parse(candidate.createdAt);
    return Number.isNaN(candidateCreatedAt)
      ? true
      : candidateCreatedAt >= planCreatedAt;
  });
}

function hasCostToShow(cost: RunCostInfo): boolean {
  return (
    cost.blocked ||
    costEstimatedUsdMicros(cost) > 0 ||
    cost.reservationStatus !== undefined ||
    costShortfallUsdMicros(cost) !== undefined ||
    cost.reasons.length > 0
  );
}

/** Pre-apply cost / shortfall panel — backend-computed values only. */
function CostNotice(props: { readonly cost: RunCostInfo }) {
  const cost = () => props.cost;
  const cloudBilling = () => isTakosumiCloudRuntime();
  const estimatedUsdMicros = () => costEstimatedUsdMicros(cost());
  const availableUsdMicros = () => costAvailableUsdMicros(cost());
  const shortfallUsdMicros = () => costShortfallUsdMicros(cost());
  return (
    <div class={`wa-cost${cost().blocked ? " wa-cost-blocked" : ""}`}>
      <Show when={estimatedUsdMicros() > 0}>
        <Show when={cloudBilling()}>
          <p class="wa-cost-line">
            {t("run.cost.required", {
              n: formatUsdMicros(estimatedUsdMicros()),
            })}
          </p>
        </Show>
      </Show>
      <Show when={availableUsdMicros() !== undefined}>
        <Show when={cloudBilling()}>
          <p class="wa-cost-line muted">
            {t("run.cost.balance", {
              n: formatUsdMicros(availableUsdMicros() ?? 0),
            })}
          </p>
        </Show>
      </Show>
      <Show when={cost().blocked}>
        <p class="wa-error">
          <Show
            when={cloudBilling()}
            fallback={<>{t("run.cost.capacityBlocked")}</>}
          >
            {t(
              shortfallUsdMicros() !== undefined
                ? "run.cost.shortfall"
                : "run.cost.blocked",
              {
                n: formatUsdMicros(shortfallUsdMicros() ?? 0),
              },
            )}
          </Show>
        </p>
        <Show when={cloudBilling() && cost().reasons.length > 0}>
          <ul class="wa-cost-reasons">
            <For each={cost().reasons}>{(reason) => <li>{reason}</li>}</For>
          </ul>
        </Show>
        <Show
          when={cloudBilling()}
          fallback={
            <>
              <p class="muted">{t("run.cost.operatorHelp")}</p>
              <Button variant="secondary" size="sm" href="/billing">
                {t("run.cost.quotaCta")}
              </Button>
            </>
          }
        >
          <Button variant="secondary" size="sm" href="/billing">
            {t("run.cost.billingCta")}
          </Button>
        </Show>
      </Show>
    </div>
  );
}

/** True when an apply rejection is the destructive-confirmation precondition. */
function isDestructiveConfirmationRequired(error: ControlApiError): boolean {
  const message = (error.message ?? "").toLowerCase();
  return (
    message.includes("confirmdestructive") || message.includes("destructive")
  );
}

function diagnosticDisplayText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gu, "Bearer [REDACTED]")
    .replace(
      /\b(?:sk|pk|rk|ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9._-]+/gu,
      "[REDACTED]",
    )
    .replace(
      /\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*=([^\s"']+)/giu,
      (match) => match.replace(/=.+$/u, "=[REDACTED]"),
    );
  return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}...` : redacted;
}

function isCreditsRequiredText(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return (
    normalized.includes("credits_required") ||
    normalized.includes("cloud_extension_insufficient_credits") ||
    normalized.includes('"reason":"insufficient_credits"') ||
    normalized.includes('"reason": "insufficient_credits"') ||
    (normalized.includes("reservationstatus") &&
      normalized.includes("insufficient_credits")) ||
    normalized.includes("usd balance reservation failed") ||
    normalized.includes("insufficient credits")
  );
}

function isCreditsRequiredRun(
  run: Run,
  diagnostics: readonly RunDiagnostic[],
): boolean {
  return (
    run.errorCode === "credits_required" ||
    diagnostics.some(
      (diagnostic) =>
        isCreditsRequiredText(diagnostic.message) ||
        isCreditsRequiredText(diagnostic.detail),
    )
  );
}

type AccessIssueKind =
  | "connection_verification"
  | "connection_setup"
  | "connection_changed"
  | "credential_service";

function accessIssueFromText(
  value: string | undefined,
): AccessIssueKind | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("provider_connection_changed")) {
    return "connection_changed";
  }
  if (normalized.includes("provider_connection_not_ready")) {
    return "connection_verification";
  }
  if (normalized.includes("provider_connection_setup_required")) {
    return "connection_setup";
  }
  if (normalized.includes("credential_service_unavailable")) {
    return "credential_service";
  }
  if (
    normalized.includes("resolved_bindings_changed") ||
    normalized.includes("re-plan before apply")
  ) {
    return "connection_changed";
  }
  if (
    (normalized.includes("credential_mint_failed") &&
      normalized.includes("not verified")) ||
    normalized.includes("pending (not verified)") ||
    (normalized.includes("provider connection") &&
      normalized.includes("status pending is not verified"))
  ) {
    return "connection_verification";
  }
  if (
    normalized.includes("credential_mint_failed") &&
    (normalized.includes("provider connection evidence is required") ||
      normalized.includes("provider connection resolution is required") ||
      normalized.includes("root-only provider connection is required") ||
      (normalized.includes("connection ") &&
        normalized.includes(" not found")) ||
      normalized.includes("provider connection is required") ||
      normalized.includes("belongs to another space") ||
      normalized.includes("git source connection") ||
      normalized.includes("cannot back a provider env binding") ||
      (normalized.includes("provider ") &&
        normalized.includes(" does not match")))
  ) {
    return "connection_setup";
  }
  if (
    normalized.includes("credential_mint_failed") &&
    (normalized.includes("connection vault is not configured") ||
      normalized.includes("requires a managed provider credential issuer") ||
      normalized.includes("could not mint a run-scoped provider token") ||
      normalized.includes("gateway materialization is takosumi cloud-only") ||
      normalized.includes("mint driver"))
  ) {
    return "credential_service";
  }
  return undefined;
}

function accessIssueFromErrorCode(
  errorCode: string | undefined,
): AccessIssueKind | undefined {
  switch (errorCode) {
    case "provider_connection_not_ready":
      return "connection_verification";
    case "provider_connection_setup_required":
      return "connection_setup";
    case "provider_connection_changed":
      return "connection_changed";
    case "credential_service_unavailable":
      return "credential_service";
    default:
      return undefined;
  }
}

function accessIssueForRun(
  run: Run,
  diagnostics: readonly RunDiagnostic[],
): AccessIssueKind | undefined {
  const codeIssue = accessIssueFromErrorCode(run.errorCode);
  if (codeIssue) return codeIssue;
  for (const diagnostic of diagnostics) {
    const issue =
      accessIssueFromText(diagnostic.message) ??
      accessIssueFromText(diagnostic.detail);
    if (issue) return issue;
  }
  return undefined;
}

function accessIssueSummary(issue: AccessIssueKind): {
  readonly text: string;
  readonly sub: string;
} {
  switch (issue) {
    case "connection_verification":
      return {
        text: t("run.summary.connectionVerificationRequired"),
        sub: t("run.summary.connectionVerificationHint"),
      };
    case "connection_setup":
      return {
        text: t("run.summary.connectionSetupRequired"),
        sub: t("run.summary.connectionSetupHint"),
      };
    case "connection_changed":
      return {
        text: t("run.summary.connectionChanged"),
        sub: t("run.summary.connectionChangedHint"),
      };
    case "credential_service":
      return {
        text: t("run.summary.credentialServiceIssue"),
        sub: t("run.summary.credentialServiceHint"),
      };
  }
}

function accessIssueDiagnostic(issue: AccessIssueKind): {
  readonly title: string;
  readonly short: string;
  readonly detail: string;
} {
  switch (issue) {
    case "connection_verification":
      return {
        title: t("run.diagnostics.connectionVerificationRequired"),
        short: t("run.diagnostics.connectionVerificationShort"),
        detail: t("run.diagnostics.connectionVerificationDetail"),
      };
    case "connection_setup":
      return {
        title: t("run.diagnostics.connectionSetupRequired"),
        short: t("run.diagnostics.connectionSetupShort"),
        detail: t("run.diagnostics.connectionSetupDetail"),
      };
    case "connection_changed":
      return {
        title: t("run.diagnostics.connectionChanged"),
        short: t("run.diagnostics.connectionChangedShort"),
        detail: t("run.diagnostics.connectionChangedDetail"),
      };
    case "credential_service":
      return {
        title: t("run.diagnostics.credentialServiceIssue"),
        short: t("run.diagnostics.credentialServiceShort"),
        detail: t("run.diagnostics.credentialServiceDetail"),
      };
  }
}

function DiagnosticRow(props: { diagnostic: RunDiagnostic }) {
  const creditsRequired = () =>
    isCreditsRequiredText(props.diagnostic.message) ||
    isCreditsRequiredText(props.diagnostic.detail);
  const accessIssue = () =>
    accessIssueFromText(props.diagnostic.message) ??
    accessIssueFromText(props.diagnostic.detail);
  const message = () =>
    creditsRequired()
      ? t("run.diagnostics.creditsRequiredShort")
      : accessIssue()
        ? accessIssueDiagnostic(accessIssue()!).short
        : (diagnosticDisplayText(props.diagnostic.message) ?? "diagnostic");
  const detail = () =>
    creditsRequired()
      ? t("run.diagnostics.creditsRequiredDetail")
      : accessIssue()
        ? accessIssueDiagnostic(accessIssue()!).detail
        : diagnosticDisplayText(props.diagnostic.detail);
  return (
    <li class={`wa-diag wa-diag-${props.diagnostic.severity}`}>
      <span class="wa-diag-sev">
        {diagnosticSeverityLabel(props.diagnostic.severity)}
      </span>
      <span class="wa-diag-msg">{message()}</span>
      <Show when={detail()}>
        {(text) => <pre class="wa-pre">{text()}</pre>}
      </Show>
    </li>
  );
}

function AuditEventRow(props: { event: RunAuditEvent }) {
  const eventType = () =>
    String(
      props.event.type ?? props.event.action ?? props.event.message ?? "event",
    );
  const at = () => {
    const raw = props.event.at ?? props.event.createdAt;
    if (typeof raw === "number")
      return formatDateTime(new Date(raw).toISOString());
    if (typeof raw === "string") return formatDateTime(raw);
    return "";
  };
  const detail = () => {
    const raw = props.event.detail ?? props.event.data ?? props.event.metadata;
    if (raw === undefined) return "";
    try {
      return JSON.stringify(raw, null, 2);
    } catch {
      return String(raw);
    }
  };

  return (
    <li class="wa-audit-row">
      <div class="wa-audit-head">
        <code>{eventType()}</code>
        <Show when={at()}>
          {(value) => <span class="muted">{value()}</span>}
        </Show>
      </div>
      <Show when={detail()}>
        {(value) => (
          <details class="wb-inline-details">
            <summary>{t("run.audit.detail")}</summary>
            <pre class="wa-pre">{value()}</pre>
          </details>
        )}
      </Show>
    </li>
  );
}

function NameList(props: { readonly names: readonly string[] }) {
  return (
    <ul class="wa-list">
      <For each={props.names}>
        {(n) => (
          <li>
            <code>{n}</code>
          </li>
        )}
      </For>
    </ul>
  );
}

interface ProviderResolutionRow {
  readonly provider: string;
  readonly connectionId?: string;
  readonly connectionName?: string;
  readonly status: ProviderResolution["status"];
  readonly blockedReason?: string;
}

function providerRequirementLabel(resolution: ProviderResolution): string {
  const requirement = resolution.requirement;
  const provider =
    requirement.providerSource || requirement.providerName || "provider";
  return requirement.alias ? `${provider}.${requirement.alias}` : provider;
}

function providerResolutionStatusLabel(
  status: ProviderResolution["status"],
): string {
  switch (status) {
    case "resolved_provider_connection":
      return t("run.connections.statusResolved");
    case "blocked_missing_connection":
      return t("run.connections.statusMissing");
    case "blocked_policy":
      return t("run.connections.statusBlocked");
  }
}

function providerResolutionTone(status: ProviderResolution["status"]): Tone {
  switch (status) {
    case "resolved_provider_connection":
      return "ok";
    case "blocked_missing_connection":
      return "warn";
    case "blocked_policy":
      return "danger";
  }
}

function providerDisplayName(provider: string): string {
  const tail = provider.toLowerCase().trim().split("/").at(-1) ?? provider;
  switch (tail) {
    case "aws":
      return "AWS";
    case "cloudflare":
      return "Cloudflare";
    case "google":
    case "google-beta":
      return "Google Cloud";
    case "hcloud":
      return "Hetzner Cloud";
    default:
      return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : provider;
  }
}

function providerResolutionNeedsAttention(row: ProviderResolutionRow): boolean {
  return row.status !== "resolved_provider_connection";
}

function providerConnectionName(
  connectionId: string | undefined,
  connectionsById: ReadonlyMap<string, ProviderConnection>,
): string | undefined {
  if (!connectionId) return undefined;
  const connection = connectionsById.get(connectionId);
  return connection
    ? connection.displayName || providerDisplayName(connection.providerSource)
    : undefined;
}

function providerResolutionRows(
  run: Run | undefined,
  connectionsById: ReadonlyMap<string, ProviderConnection>,
): readonly ProviderResolutionRow[] {
  return (run?.providerResolutions ?? []).map((resolution) => {
    const evidence = resolution.evidence;
    const connectionId =
      resolution.connectionId ??
      (evidence.kind === "provider_connection"
        ? evidence.connectionId
        : undefined);
    return {
      provider: providerRequirementLabel(resolution),
      connectionId,
      connectionName: providerConnectionName(connectionId, connectionsById),
      status: resolution.status,
      blockedReason:
        resolution.blockedReason ??
        (evidence.kind === "blocked" ? evidence.reason : undefined),
    };
  });
}

function ProviderResolutionTable(props: {
  readonly rows: readonly ProviderResolutionRow[];
}) {
  return (
    <div class="wa-provider-resolution-list">
      <For each={props.rows}>
        {(row) => (
          <div class="wa-provider-resolution-row">
            <div>
              <span class="wa-provider-resolution-label">
                {t("run.connections.provider")}
              </span>
              <span>{providerDisplayName(row.provider)}</span>
            </div>
            <div>
              <span class="wa-provider-resolution-label">
                {t("run.connections.connection")}
              </span>
              <span>{row.connectionName ?? "—"}</span>
            </div>
            <div>
              <span class="wa-provider-resolution-label">
                {t("run.connections.status")}
              </span>
              <Badge tone={providerResolutionTone(row.status)}>
                {providerResolutionStatusLabel(row.status)}
              </Badge>
              <Show when={row.blockedReason}>
                {(reason) => <p class="muted">{reason()}</p>}
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

const PLAN_RESOURCE_REVIEW_LIMIT = 25;

function isActionablePlanResource(resource: RunPlanResource): boolean {
  return resource.actions.some((action) => action !== "no-op");
}

function planResourceTone(resource: RunPlanResource): Tone {
  if (resource.actions.includes("delete")) return "danger";
  if (
    resource.actions.includes("create") &&
    resource.actions.includes("delete")
  )
    return "danger";
  if (resource.actions.includes("update")) return "warn";
  if (resource.actions.includes("create")) return "ok";
  return "muted";
}

function planResourceActionLabel(resource: RunPlanResource): string {
  const actions = resource.actions;
  if (actions.includes("delete") && actions.includes("create")) {
    return t("run.resources.actionReplace");
  }
  if (actions.includes("delete")) return t("run.resources.actionDelete");
  if (actions.includes("update")) return t("run.resources.actionUpdate");
  if (actions.includes("create")) return t("run.resources.actionCreate");
  return actions.join(" / ") || t("common.unknown");
}

function planResourceScopeLabel(
  scope: RunPlanResource["scope"] | undefined,
): string | undefined {
  if (!scope) return undefined;
  const parts = [
    scope.cloudflareAccountId
      ? t("run.scope.cloudflareAccount", { id: scope.cloudflareAccountId })
      : undefined,
    scope.cloudflareZoneId
      ? t("run.scope.cloudflareZone", { id: scope.cloudflareZoneId })
      : undefined,
    scope.awsAccountId
      ? t("run.scope.awsAccount", { id: scope.awsAccountId })
      : undefined,
    scope.awsRegion
      ? t("run.scope.awsRegion", { region: scope.awsRegion })
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function planResourceDisplayLabel(resource: RunPlanResource): string {
  const tail = resource.type.trim().split(".").at(-1) ?? resource.type;
  const withoutProvider = tail.replace(
    /^(cloudflare|aws|google|google-beta|hcloud|digitalocean|vultr|scaleway|openstack)_/,
    "",
  );
  const words = withoutProvider
    .split("_")
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return resource.type || resource.address;
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function PlanResourceReview(props: {
  readonly resources: readonly RunPlanResource[];
}) {
  const actionable = () => props.resources.filter(isActionablePlanResource);
  const visible = () => actionable().slice(0, PLAN_RESOURCE_REVIEW_LIMIT);
  const hiddenCount = () =>
    Math.max(0, actionable().length - PLAN_RESOURCE_REVIEW_LIMIT);
  return (
    <Show when={actionable().length > 0}>
      <div class="wa-plan-resources">
        <div class="wa-plan-resources-head">
          <div>
            <p class="wa-section-kicker">{t("run.resources.kicker")}</p>
            <h3>{t("run.resources.title")}</h3>
          </div>
          <Badge tone="muted">
            {t("run.resources.count", { n: actionable().length })}
          </Badge>
        </div>
        <div class="wa-plan-resource-list">
          <For each={visible()}>
            {(resource) => (
              <div class="wa-plan-resource-row">
                <Badge tone={planResourceTone(resource)}>
                  {planResourceActionLabel(resource)}
                </Badge>
                <div class="wa-plan-resource-main">
                  <strong>{planResourceDisplayLabel(resource)}</strong>
                  <details class="wb-inline-details">
                    <summary>{t("run.resources.identifiers")}</summary>
                    <p>
                      <span class="muted">{t("run.resources.address")}</span>{" "}
                      <code>{resource.address}</code>
                    </p>
                    <p>
                      <span class="muted">{t("run.resources.type")}</span>{" "}
                      <code>{resource.type}</code>
                    </p>
                    <Show when={planResourceScopeLabel(resource.scope)}>
                      {(scope) => (
                        <p class="wa-plan-resource-scope">
                          <span class="muted">{t("run.resources.scope")}</span>{" "}
                          {scope()}
                        </p>
                      )}
                    </Show>
                  </details>
                </div>
              </div>
            )}
          </For>
        </div>
        <Show when={hiddenCount() > 0}>
          <p class="muted">{t("run.resources.more", { n: hiddenCount() })}</p>
        </Show>
      </div>
    </Show>
  );
}

function Inner() {
  const params = useParams();
  const navigate = useNavigate();
  const runId = () => params.id ?? "";
  const appHandoff = appHandoffFromSearch(
    typeof location === "undefined" ? "" : location.search,
  );
  // Install context: NewAppView sends the plan run here with ?auto=install so
  // this screen shows a clean App-Store-style install progress instead of the
  // technical run console. withAuto() preserves the flag across the plan→apply
  // hop and any re-plan so the whole install reads as one flow.
  // ?auto=install (store install) and ?auto=update (1-tap update from the app
  // detail) share the same App-Store-style progress screen; update mode only
  // swaps the copy (更新中/更新しました instead of 追加中/追加しました).
  const autoMode =
    typeof location !== "undefined"
      ? new URLSearchParams(location.search).get("auto")
      : null;
  const autoUpdateMode = autoMode === "update";
  const autoInstall = autoMode === "install" || autoUpdateMode;
  const withAuto = (path: string) =>
    autoInstall
      ? path +
        (path.includes("?") ? "&" : "?") +
        (autoUpdateMode ? "auto=update" : "auto=install")
      : path;
  const [forceConsole, setForceConsole] = createSignal(false);

  const [run, { refetch: refetchRun, mutate: mutateRun }] = createResource(
    runId,
    getRun,
  );
  const [logs, { refetch: refetchLogs }] = createResource(runId, getRunLogs);
  const [cost] = createResource(runId, async (id) => {
    try {
      return await getRunCostInfo(id);
    } catch {
      // Best-effort: absent cost info never breaks the deploy UI.
      return undefined;
    }
  });
  const [providerConnectionsForRun] = createResource(
    () => run.latest?.workspaceId ?? null,
    listProviderConnections,
  );
  // Activity only feeds the post-deploy launch-URL resolution, so fetch it
  // only for a succeeded apply/destroy-apply run — not on every plan / prep /
  // failed run screen (100 rows each).
  const [activity] = createResource(
    () => {
      const r = run.latest;
      if (!r?.workspaceId) return null;
      const isCompletedApply =
        (r.type === "apply" || r.type === "destroy_apply") &&
        r.status === "succeeded";
      return isCompletedApply ? r.workspaceId : null;
    },
    (id) => listActivity(id, 100),
  );
  // The owning app, for the plain-language summary sentence + back link.
  const capsuleId = () => run.latest?.capsuleId ?? null;
  const [capsule] = createResource(capsuleId, getCapsule);
  const appName = () => capsule.latest?.name;
  const appliedRunDeploymentKey = createMemo(() => {
    const r = run.latest;
    const id = capsuleId();
    if (!id || !r || r.type !== "apply" || r.status !== "succeeded") {
      return undefined;
    }
    return `${id}:${r.id}`;
  });
  const [deployments] = createResource(appliedRunDeploymentKey, async (key) => {
    const [id] = key.split(":");
    try {
      return await listDeployments(id);
    } catch {
      return [];
    }
  });
  const completedRunLaunchUrl = createMemo(() => {
    const r = run.latest;
    if (!r || r.type !== "apply" || r.status !== "succeeded") return undefined;
    const rows = deployments() ?? [];
    const deployment =
      rows.find(
        (row) => row.applyRunId === r.id && row.status !== "destroyed",
      ) ?? rows.find((row) => row.status === "active");
    if (activity.loading) return undefined;
    return launchUrlFromDeployment(
      deployment,
      activity() ?? [],
      capsuleId() ?? undefined,
    );
  });

  const clearLauncherCaches = (workspaceId: string | undefined): void => {
    if (!workspaceId) return;
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
  };

  createEffect(() => {
    const r = run.latest;
    const titleKey =
      r?.type === "apply" || r?.type === "destroy_apply"
        ? "run.title.apply"
        : r?.type === "destroy_plan"
          ? "run.title.destroy"
          : r?.type === "plan"
            ? "run.title.plan"
            : "run.title.other";
    setDocumentTitle(t(titleKey as Parameters<typeof t>[0]));
  });

  const [lastLauncherCacheClearKey, setLastLauncherCacheClearKey] =
    createSignal<string | undefined>();
  createEffect(() => {
    const r = run.latest;
    if (!r || !isTerminalRunStatus(r.status)) return;
    if (r.type !== "apply" && r.type !== "destroy_apply") {
      return;
    }
    const key = `${r.id}:${r.status}:${r.workspaceId}`;
    if (lastLauncherCacheClearKey() === key) return;
    setLastLauncherCacheClearKey(key);
    clearLauncherCaches(r.workspaceId);
  });

  // Primary: subscribe to run status over SSE (real-time push, no client poll).
  // The 3s poll below stays as a fallback for when the stream can't connect.
  const [sseActive, setSseActive] = createSignal(false);
  createEffect(() => {
    const id = runId();
    if (!id) return;
    let disposed = false;
    const close = openRunStream(id, {
      onOpen: () => {
        if (!disposed) setSseActive(true);
      },
      onRun: (r) => {
        if (disposed) return;
        mutateRun(r);
        void refetchLogs();
        if (isTerminalRunStatus(r.status)) {
          disposed = true;
          setSseActive(false);
          close();
        }
      },
      onError: () => setSseActive(false),
    });
    onCleanup(() => {
      disposed = true;
      setSseActive(false);
      close();
    });
  });

  // Fallback poll while the run is non-terminal and the SSE stream is not
  // driving updates. Considerate: pauses on a hidden tab (and refetches on
  // return) and yields entirely to SSE when the stream is live.
  const [pageVisible, setPageVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  if (typeof document !== "undefined") {
    const onVisibility = () => {
      const visible = document.visibilityState !== "hidden";
      setPageVisible(visible);
      if (visible && run.latest && !isTerminalRunStatus(run.latest.status)) {
        void refetchRun();
        void refetchLogs();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() =>
      document.removeEventListener("visibilitychange", onVisibility),
    );
  }
  createEffect(() => {
    const current = run.latest;
    if (!current || isTerminalRunStatus(current.status)) return;
    if (!pageVisible() || sseActive()) return;
    const timer = setTimeout(() => {
      void refetchRun();
      void refetchLogs();
    }, 3000);
    onCleanup(() => clearTimeout(timer));
  });

  const inputs = createMemo(() =>
    inputNamesFromLogs(logs()?.auditEvents ?? []),
  );
  const changes = createMemo(() => changesFromLogs(logs()?.auditEvents ?? []));
  const planResources = createMemo(() => run.latest?.planResources ?? []);
  const changeCounts = createMemo(() =>
    changeCountsForRun(run.latest, logs()?.auditEvents ?? []),
  );
  const connections = createMemo(() =>
    connectionNamesFromLogs(logs()?.auditEvents ?? []),
  );
  const providerConnectionsById = createMemo(
    () =>
      new Map(
        (providerConnectionsForRun() ?? []).map((connection) => [
          connection.id,
          connection,
        ]),
      ),
  );
  const providerRows = createMemo(() =>
    providerResolutionRows(run.latest, providerConnectionsById()),
  );
  const providerRowsNeedingAttention = createMemo(() =>
    providerRows().filter(providerResolutionNeedsAttention),
  );
  const diagnosticRows = createMemo(() => logs()?.diagnostics ?? []);
  const creditsRequired = createMemo(() => {
    const r = run.latest;
    return r ? isCreditsRequiredRun(r, diagnosticRows()) : false;
  });
  const connectionVerificationRequired = createMemo(() => {
    const r = run.latest;
    return r ? accessIssueForRun(r, diagnosticRows()) !== undefined : false;
  });
  const runAccessIssue = createMemo(() => {
    const r = run.latest;
    return r ? accessIssueForRun(r, diagnosticRows()) : undefined;
  });
  const showDiagnosticsPanel = createMemo(
    () =>
      creditsRequired() ||
      connectionVerificationRequired() ||
      diagnosticRows().length > 0 ||
      Boolean(logs.error) ||
      (logs.loading && run.latest?.status === "failed"),
  );

  const approve = createAction(async () => {
    await approveRun(runId());
    await Promise.all([refetchRun(), refetchLogs()]);
  });

  const [applied, setApplied] = createSignal(false);
  const [needsConfirm, setNeedsConfirm] = createSignal(false);

  const isReviewRun = (r: Run): boolean =>
    r.type === "plan" || r.type === "destroy_plan";
  const isDeployableRun = (r: Run): boolean =>
    isReviewRun(r) &&
    r.status === "succeeded" &&
    r.policyStatus === "pass" &&
    !applied();
  const requiresDestructiveConfirmation = (r: Run): boolean =>
    isDeployableRun(r) &&
    (needsConfirm() ||
      r.type === "destroy_plan" ||
      r.requiresApproval === true ||
      changeCounts().delete > 0);

  const deploy = createAction(async (confirmDestructive?: boolean) => {
    let envelope: unknown;
    const currentRun = run.latest;
    try {
      envelope = await createApplyRun(runId(), {
        confirmDestructive,
        timeoutMs: APPLY_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (
        error instanceof ControlApiError &&
        error.status === 409 &&
        isDestructiveConfirmationRequired(error)
      ) {
        setNeedsConfirm(true);
        return;
      }
      if (currentRun && isRequestTimeout(error)) {
        const recovered = latestApplyRunForPlan(
          await listRuns(currentRun.workspaceId, 30),
          currentRun,
        );
        if (recovered) {
          envelope = { run: recovered };
        } else {
          envelope = await createApplyRun(runId(), {
            confirmDestructive,
            timeoutMs: APPLY_REQUEST_TIMEOUT_MS,
          });
        }
      } else {
        throw error;
      }
    }
    setNeedsConfirm(false);
    setApplied(true);
    clearLauncherCaches(currentRun?.workspaceId);
    // Jump to the apply Run when the backend surfaced its id — that page then
    // polls to "デプロイが完了しました" on its own. Fallback: stay here with the
    // applied notice (the legacy behaviour).
    const applyRunId = extractRunId(envelope);
    if (applyRunId && applyRunId !== runId()) {
      navigate(
        withAuto(
          appendAppHandoff(`/runs/${applyRunId}`, appHandoff) ??
            `/runs/${applyRunId}`,
        ),
      );
      return;
    }
    await Promise.all([refetchRun(), refetchLogs()]);
  });

  // One-action install: NewAppView sends the plan run here with ?auto=install.
  // When the plan is clean (succeeded, policy pass, no approval, no destructive
  // change) we continue straight to apply so the visitor never presses "deploy"
  // on a plan console. Any gate (approval / destructive / policy / delete)
  // falls through to the explicit review + action button below.
  const [autoContinued, setAutoContinued] = createSignal(false);
  // Per-run UI state must reset when this SAME component instance navigates
  // between runs (deploy → apply run, retry → fresh plan): stale `applied`
  // would fake a デプロイしました summary on a never-applied plan and hide the
  // deploy button; stale autoContinued/forceConsole break the ?auto=install
  // re-plan loop.
  let lastRunId = runId();
  createEffect(() => {
    const id = runId();
    if (id === lastRunId) return;
    lastRunId = id;
    setApplied(false);
    setNeedsConfirm(false);
    setAutoContinued(false);
    setForceConsole(false);
  });
  createEffect(() => {
    const r = run.latest;
    if (!autoInstall || autoContinued() || applied() || deploy.busy() || !r) {
      return;
    }
    if (isDeployableRun(r) && !requiresDestructiveConfirmation(r)) {
      // Never auto-apply past the billing/cost gate the manual deploy button
      // enforces — wait for the check, and stop on a blocked estimate (the
      // install screen shows the gate card instead).
      if (cost.loading || costBlocked()) return;
      setAutoContinued(true);
      void deploy.run(false);
    }
  });

  const retryPlan = createAction(async () => {
    const instId = run.latest?.capsuleId;
    if (!instId) return;
    const envelope = await planCapsule(instId);
    const newRunId = extractRunId(envelope);
    if (newRunId) {
      navigate(
        withAuto(
          appendAppHandoff(`/runs/${newRunId}`, appHandoff) ??
            `/runs/${newRunId}`,
        ),
      );
    }
  });

  const cancel = createAction(async () => {
    await cancelRun(runId());
    await refetchRun();
  });
  // A queued/running run (or a parked review) can still be stopped.
  const cancellable = () => {
    const s = run.latest?.status;
    return (
      s === "queued" || s === "running" || s === "waiting_approval"
    );
  };

  const costInfo = () => cost.latest;
  const costBlocked = () => costInfo()?.blocked === true;
  const appConnectHref = () =>
    createAppHandoffConnectHref(appHandoff, completedRunLaunchUrl());

  // --- install progress layer (App-Store-style, shown when ?auto=install) -----
  type InstallStepKey = "fetch" | "check" | "deploy" | "done";
  const INSTALL_STEPS: readonly InstallStepKey[] = [
    "fetch",
    "check",
    "deploy",
    "done",
  ];
  type InstallState =
    | { readonly phase: "progress"; readonly step: InstallStepKey }
    | { readonly phase: "gate" }
    | { readonly phase: "error" }
    | { readonly phase: "done" };
  const installState = createMemo((): InstallState => {
    // A dead run fetch or a failed apply-run creation must surface as an
    // error, not an eternal spinner.
    if (run.error || deploy.error()) return { phase: "error" };
    const r = run.latest;
    if (!r) return { phase: "progress", step: "fetch" };
    if (r.status === "failed") return { phase: "error" };
    if (r.type === "apply" || r.type === "destroy_apply") {
      return r.status === "succeeded"
        ? { phase: "done" }
        : { phase: "progress", step: "deploy" };
    }
    // review (plan) run
    if (r.status === "waiting_approval") return { phase: "gate" };
    if (r.status === "succeeded") {
      // Clean plan auto-continues to apply; a gate (approval / destructive /
      // blocked cost estimate) stops for explicit review.
      return r.policyStatus === "pass" &&
        !requiresDestructiveConfirmation(r) &&
        !costBlocked()
        ? { phase: "progress", step: "deploy" }
        : { phase: "gate" };
    }
    return { phase: "progress", step: "check" };
  });
  const installStepIndex = (step: InstallStepKey): number =>
    INSTALL_STEPS.indexOf(step);
  const installActiveIndex = createMemo(() => {
    const s = installState();
    if (s.phase === "done") return INSTALL_STEPS.length;
    if (s.phase === "progress") return installStepIndex(s.step);
    return installStepIndex("check");
  });

  // --- summary layer ---------------------------------------------------------

  type SummaryKind = "progress" | "action" | "ok" | "danger" | "error";
  interface Summary {
    readonly kind: SummaryKind;
    readonly text: string;
    readonly sub?: string;
  }

  const summary = createMemo((): Summary | null => {
    const r = run.latest;
    if (!r) return null;
    const name = appName();
    if (r.type === "apply" || r.type === "destroy_apply") {
      if (r.status === "queued" || r.status === "running") {
        return { kind: "progress", text: t("run.summary.applying") };
      }
      if (r.status === "succeeded") {
        return { kind: "ok", text: t("run.summary.applySucceeded") };
      }
      if (r.status === "failed") {
        if (isCreditsRequiredRun(r, diagnosticRows())) {
          return {
            kind: "action",
            text: t("run.summary.creditsRequired"),
            sub: t("run.summary.creditsRequiredHint"),
          };
        }
        const accessIssue = accessIssueForRun(r, diagnosticRows());
        if (accessIssue) {
          const accessSummary = accessIssueSummary(accessIssue);
          return {
            kind: "action",
            text: accessSummary.text,
            sub: accessSummary.sub,
          };
        }
        return {
          kind: "error",
          text: t("run.summary.failed", { operation: operationLabel(r.type) }),
          sub: runFailureHint(r.errorCode),
        };
      }
      return {
        kind: "progress",
        text: t("run.summary.fallback", { status: runStatusLabel(r.status) }),
      };
    }
    if (isReviewRun(r)) {
      if (applied()) {
        return { kind: "ok", text: t("run.summary.applied") };
      }
      switch (r.status) {
        case "queued":
          return { kind: "progress", text: t("run.summary.queued") };
        case "running":
          return { kind: "progress", text: t("run.summary.planning") };
        case "waiting_approval":
          return { kind: "action", text: t("run.summary.waitingApproval") };
        case "succeeded": {
          if (r.policyStatus !== "pass") {
            return { kind: "danger", text: t("run.summary.blocked") };
          }
          const counts = changeCounts();
          const sub = t("run.summary.readyChanges", {
            create: counts.create,
            update: counts.update,
            delete: counts.delete,
          });
          return r.type === "destroy_plan"
            ? {
                kind: "danger",
                text: name
                  ? t("run.summary.destroyReady", { name })
                  : t("run.summary.destroyReadyGeneric"),
                sub,
              }
            : {
                kind: "action",
                text: name
                  ? t("run.summary.ready", { name })
                  : t("run.summary.readyGeneric"),
                sub,
              };
        }
        case "failed":
          if (isCreditsRequiredRun(r, diagnosticRows())) {
            return {
              kind: "action",
              text: t("run.summary.creditsRequired"),
              sub: t("run.summary.creditsRequiredHint"),
            };
          }
          const accessIssue = accessIssueForRun(r, diagnosticRows());
          if (accessIssue) {
            const accessSummary = accessIssueSummary(accessIssue);
            return {
              kind: "action",
              text: accessSummary.text,
              sub: accessSummary.sub,
            };
          }
          return {
            kind: "error",
            text: t("run.summary.failed", {
              operation: operationLabel(r.type),
            }),
            sub: runFailureHint(r.errorCode),
          };
        default:
          return {
            kind: "progress",
            text: t("run.summary.fallback", {
              status: runStatusLabel(r.status),
            }),
          };
      }
    }
    if (r.type === "drift_check" && r.status === "succeeded") {
      return { kind: "ok", text: t("run.summary.driftDone") };
    }
    // Read-only preparation runs (追加前の確認 / 内容の取得) get a plain
    // sentence instead of the mechanical status fallback.
    if (r.type === "compatibility_check" || r.type === "source_sync") {
      const doneKey =
        r.type === "compatibility_check"
          ? "run.summary.compatDone"
          : "run.summary.syncDone";
      const runningKey =
        r.type === "compatibility_check"
          ? "run.summary.compatRunning"
          : "run.summary.syncRunning";
      if (r.status === "succeeded") return { kind: "ok", text: t(doneKey) };
      if (r.status === "failed") {
        return {
          kind: "error",
          text: t("run.summary.failed", { operation: operationLabel(r.type) }),
          sub: runFailureHint(r.errorCode),
        };
      }
      return { kind: "progress", text: t(runningKey) };
    }
    return {
      kind: "progress",
      text: t("run.summary.fallback", { status: runStatusLabel(r.status) }),
    };
  });

  const supportDetailItems = (r: Run): readonly KVItem[] => {
    const out: KVItem[] = [
      { label: t("run.details.type"), value: operationLabel(r.type) },
      {
        label: t("run.details.policy"),
        value: r.policyStatus ? (
          <StatusBadge
            status={r.policyStatus}
            label={policyStatusLabel}
            tone={policyTone}
          />
        ) : (
          <span class="muted">—</span>
        ),
      },
    ];
    out.push({
      label: t("run.details.created"),
      value: formatDateTime(r.createdAt),
    });
    out.push({
      label: t("run.details.started"),
      value: formatDateTime(r.startedAt),
    });
    out.push({
      label: t("run.details.finished"),
      value: formatDateTime(r.finishedAt),
    });
    if (r.errorCode) {
      out.push({
        label: t("run.details.error"),
        value: <code>{r.errorCode}</code>,
      });
    }
    return out;
  };

  const debugDetailItems = (r: Run): readonly KVItem[] => {
    const out: KVItem[] = [
      { label: t("run.details.runId"), value: <code>{r.id}</code> },
    ];
    if (r.capsuleId) {
      out.push({
        label: t("run.details.capsule"),
        value: <code>{r.capsuleId}</code>,
      });
    }
    if (r.sourceSnapshotId) {
      out.push({
        label: t("run.details.sourceSnapshot"),
        value: <code>{r.sourceSnapshotId}</code>,
      });
    }
    if (r.dependencySnapshotId) {
      out.push({
        label: t("run.details.dependencySnapshot"),
        value: <code>{r.dependencySnapshotId}</code>,
      });
    }
    if (r.baseStateGeneration !== undefined) {
      out.push({
        label: t("run.details.baseGeneration"),
        value: <code>{r.baseStateGeneration}</code>,
      });
    }
    if (r.planDigest) {
      out.push({
        label: t("run.details.planDigest"),
        value: <code>{r.planDigest}</code>,
      });
    }
    return out;
  };

  const pageTitle = () => {
    const r = run.latest;
    if (!r) return t("run.title.other");
    if (r.type === "apply" || r.type === "destroy_apply")
      return t("run.title.apply");
    if (r.type === "destroy_plan") return t("run.title.destroy");
    if (r.type === "plan") return t("run.title.plan");
    return t("run.title.other");
  };

  const installStepLabel = (step: InstallStepKey): string =>
    step === "fetch"
      ? t("install.step.fetch")
      : step === "check"
        ? t("install.step.check")
        : step === "deploy"
          ? t("install.step.deploy")
          : t("install.step.done");

  /** Clean App-Store-style install screen (progress → done → open/return),
   * shown instead of the technical run console while ?auto=install is set. */
  const installScreen = () => {
    const st = installState();
    const name = appName();
    return (
      <div class="av-install" role="status" aria-live="polite">
        <Switch>
          <Match when={st.phase === "done"}>
            <div class="av-install-card av-install-done">
              <span class="av-install-check" aria-hidden="true">
                ✓
              </span>
              <h2>
                {autoUpdateMode
                  ? name
                    ? t("update.doneTitle", { name })
                    : t("update.doneTitleGeneric")
                  : name
                    ? t("install.doneTitle", { name })
                    : t("install.doneTitleGeneric")}
              </h2>
              <p>
                {autoUpdateMode ? t("update.doneSub") : t("install.doneSub")}
              </p>
              <div class="av-install-actions">
                <Show when={completedRunLaunchUrl()}>
                  {(url) => (
                    <a
                      class="tg-btn tg-btn-primary tg-btn-lg tg-btn-block"
                      href={url()}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {t("install.open")}
                    </a>
                  )}
                </Show>
                <Show when={appConnectHref()}>
                  {(href) => (
                    <a
                      class="tg-btn tg-btn-secondary tg-btn-block"
                      href={href()}
                    >
                      {t("run.appHandoff.open", {
                        app: appHandoffProductLabel(appHandoff!.product),
                      })}
                    </a>
                  )}
                </Show>
                <a class="tg-btn tg-btn-ghost tg-btn-block" href="/">
                  {t("install.toApps")}
                </a>
              </div>
            </div>
          </Match>
          <Match when={st.phase === "error"}>
            <div class="av-install-card">
              <span
                class="av-install-badge av-install-badge-error"
                aria-hidden="true"
              >
                !
              </span>
              <h2>
                {autoUpdateMode
                  ? t("update.errorTitle")
                  : t("install.errorTitle")}
              </h2>
              {/* One plain sentence with the next action — the summary layer
                  already classifies credits / account-access / known failure
                  codes. The console stays behind 詳細を見る. */}
              <p>
                {deploy.error() ??
                  summary()?.sub ??
                  summary()?.text ??
                  t("install.errorSub")}
              </p>
              <div class="av-install-actions">
                <button
                  type="button"
                  class="tg-btn tg-btn-secondary tg-btn-block"
                  onClick={() => setForceConsole(true)}
                >
                  {t("install.errorCta")}
                </button>
                <a class="tg-btn tg-btn-ghost tg-btn-block" href="/">
                  {t("install.toApps")}
                </a>
              </div>
            </div>
          </Match>
          <Match when={st.phase === "gate"}>
            <div class="av-install-card">
              <span
                class="av-install-badge av-install-badge-gate"
                aria-hidden="true"
              >
                ?
              </span>
              <h2>{t("install.gateTitle")}</h2>
              <p>{t("install.gateSub")}</p>
              <div class="av-install-actions">
                <button
                  type="button"
                  class="tg-btn tg-btn-primary tg-btn-block"
                  onClick={() => setForceConsole(true)}
                >
                  {t("install.gateCta")}
                </button>
                <a class="tg-btn tg-btn-ghost tg-btn-block" href="/">
                  {t("install.toApps")}
                </a>
              </div>
            </div>
          </Match>
          <Match when={st.phase === "progress"}>
            <div class="av-install-card av-install-progress">
              <div class="av-install-head">
                <span class="av-install-icon" aria-hidden="true">
                  {name ? name.slice(0, 2).toUpperCase() : "··"}
                </span>
                <div class="av-install-head-text">
                  <h2>
                    {name ??
                      (autoUpdateMode
                        ? t("update.installingGeneric")
                        : t("install.installingGeneric"))}
                  </h2>
                  <p class="muted">{t("install.wait")}</p>
                </div>
              </div>
              <div class="av-install-bar" aria-hidden="true">
                <i
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        ((installActiveIndex() + 0.5) / INSTALL_STEPS.length) *
                          100,
                      ),
                    )}%`,
                  }}
                />
              </div>
              <p class="av-install-phase">
                <span class="av-install-spin" aria-hidden="true" />
                {installStepLabel(
                  INSTALL_STEPS[
                    Math.min(installActiveIndex(), INSTALL_STEPS.length - 1)
                  ],
                )}
              </p>
            </div>
          </Match>
        </Switch>
      </div>
    );
  };

  return (
    <>
      <Show when={autoInstall && !forceConsole()} fallback={installConsole()}>
        {installScreen()}
      </Show>
    </>
  );

  function installConsole() {
    return (
      <>
        <PageHeader
          title={
            <span class="wa-title-row">
              {pageTitle()}
              <Show when={run.latest}>
                {(r) => (
                  <StatusBadge
                    status={r().status}
                    label={runStatusLabel}
                    tone={runTone}
                  />
                )}
              </Show>
            </span>
          }
          subtitle={appName() ? `${appName()}` : undefined}
          actions={
            <Show
              when={capsuleId()}
              fallback={
                <Button variant="ghost" href="/">
                  {t("app.backToList")}
                </Button>
              }
            >
              {(id) => (
                <Button
                  variant="ghost"
                  href={`/services/${encodeURIComponent(id())}`}
                >
                  {t("run.backToApp")}
                </Button>
              )}
            </Show>
          }
        />

        <Switch>
          <Match when={run.loading}>
            <Card>
              <Skeleton variant="block" />
            </Card>
          </Match>
          <Match when={run.error}>
            <EmptyState
              icon={<Activity size={28} />}
              title={t("common.unknown")}
              message={(run.error as ControlApiError).message}
            />
          </Match>
          <Match when={run()}>
            {(r) => (
              <div class="wa-stack">
                {/* ===== summary layer ===== */}
                <Card>
                  <Show when={summary()}>
                    {(s) => (
                      <div
                        class={`av-run-summary av-run-summary-${s().kind}`}
                        role="status"
                        aria-live="polite"
                      >
                        <Show when={s().kind === "progress"}>
                          <span class="av-run-spinner" aria-hidden="true" />
                        </Show>
                        <div class="av-run-summary-text">
                          <p class="av-run-summary-line">{s().text}</p>
                          <Show when={s().sub}>
                            {(sub) => <p class="av-run-summary-sub">{sub()}</p>}
                          </Show>
                          {/* A connection problem gets a direct path to the
                              connections screen — the hint alone strands the
                              user on this page. */}
                          <Show
                            when={
                              runAccessIssue() === "connection_setup" ||
                              runAccessIssue() === "connection_verification"
                            }
                          >
                            <Button
                              variant="secondary"
                              size="sm"
                              href="/connections"
                            >
                              {t("run.connections.setupCta")}
                            </Button>
                          </Show>
                        </div>
                      </div>
                    )}
                  </Show>

                  {/* cost (backend values only) */}
                  <Show
                    when={(() => {
                      const c = costInfo();
                      if (!c || !isDeployableRun(r())) return undefined;
                      return isTakosumiCloudRuntime()
                        ? hasCostToShow(c)
                          ? c
                          : undefined
                        : c.blocked
                          ? c
                          : undefined;
                    })()}
                  >
                    {(c) => <CostNotice cost={c()} />}
                  </Show>

                  {/* primary action */}
                  <div class="wa-form-actions">
                    <Show when={r().status === "waiting_approval"}>
                      <Button
                        variant="primary"
                        type="button"
                        busy={approve.busy()}
                        onClick={() => void approve.run()}
                      >
                        {approve.busy() ? t("run.approving") : t("run.approve")}
                      </Button>
                    </Show>

                    <Show
                      when={
                        !applied() &&
                        isDeployableRun(r()) &&
                        !requiresDestructiveConfirmation(r())
                      }
                    >
                      <Button
                        variant={
                          r().type === "destroy_plan" ? "danger" : "primary"
                        }
                        type="button"
                        disabled={deploy.busy() || costBlocked()}
                        busy={deploy.busy()}
                        onClick={() => void deploy.run(undefined)}
                      >
                        {deploy.busy()
                          ? t("run.deploying")
                          : costBlocked()
                            ? t("run.deployBlocked")
                            : t("run.deploy")}
                      </Button>
                    </Show>

                    <Show
                      when={
                        r().status === "failed" &&
                        (isReviewRun(r()) ||
                          connectionVerificationRequired()) &&
                        r().capsuleId
                      }
                    >
                      <Button
                        variant="secondary"
                        type="button"
                        busy={retryPlan.busy()}
                        onClick={() => void retryPlan.run()}
                      >
                        {t("run.retryPlan")}
                      </Button>
                    </Show>

                    <Show when={cancellable()}>
                      <Button
                        variant="ghost"
                        type="button"
                        busy={cancel.busy()}
                        onClick={() => void cancel.run()}
                      >
                        {t("run.cancel")}
                      </Button>
                    </Show>

                    <Show
                      when={
                        r().status === "succeeded" &&
                        (r().type === "apply" ||
                          r().type === "destroy_apply") &&
                        capsuleId()
                      }
                    >
                      {(id) => (
                        <>
                          <Show when={completedRunLaunchUrl()}>
                            {(url) => (
                              <Button
                                variant="primary"
                                href={url()}
                                target="_blank"
                                rel="noreferrer noopener"
                                icon={<ExternalLink size={16} />}
                              >
                                {t("apps.openApp")}
                              </Button>
                            )}
                          </Show>
                          <Show when={appConnectHref()}>
                            {(href) => (
                              <Button variant="secondary" href={href()}>
                                {t("run.appHandoff.open", {
                                  app: appHandoffProductLabel(
                                    appHandoff!.product,
                                  ),
                                })}
                              </Button>
                            )}
                          </Show>
                          <Button
                            variant={
                              completedRunLaunchUrl() ? "secondary" : "primary"
                            }
                            href={`/services/${encodeURIComponent(id())}`}
                          >
                            {t("run.backToApp")}
                          </Button>
                        </>
                      )}
                    </Show>
                  </div>

                  {/* destructive double-confirmation */}
                  <Show
                    when={!applied() && requiresDestructiveConfirmation(r())}
                  >
                    <p class="wa-deploy-warn">{t("run.destructiveWarning")}</p>
                    <div class="wa-form-actions">
                      <Button
                        variant="secondary"
                        type="button"
                        disabled={deploy.busy()}
                        onClick={() => {
                          setNeedsConfirm(false);
                          const id = capsuleId();
                          if (id)
                            navigate(`/services/${encodeURIComponent(id)}`);
                        }}
                      >
                        {t("run.stop")}
                      </Button>
                      <Button
                        variant="danger"
                        type="button"
                        disabled={deploy.busy() || costBlocked()}
                        busy={deploy.busy()}
                        onClick={() => void deploy.run(true)}
                      >
                        {deploy.busy()
                          ? t("run.deploying")
                          : costBlocked()
                            ? t("run.deployBlocked")
                            : t("run.destructiveConfirm")}
                      </Button>
                    </div>
                  </Show>

                  <Show when={approve.error()}>
                    {(m) => (
                      <p class="wa-error" role="alert">
                        {m()}
                      </p>
                    )}
                  </Show>
                  <Show when={deploy.error()}>
                    {(m) => (
                      <p class="wa-error" role="alert">
                        {m()}
                      </p>
                    )}
                  </Show>
                  <Show when={retryPlan.error()}>
                    {(m) => (
                      <p class="wa-error" role="alert">
                        {m()}
                      </p>
                    )}
                  </Show>
                </Card>

                {/* ===== changes (counts always, lists folded). Read-only
                    preparation runs (確認 / 取得) never change resources —
                    an all-zero strip there is noise, so it renders only for
                    plan/apply-family runs. ===== */}
                <Show
                  when={
                    run.latest?.type !== "compatibility_check" &&
                    run.latest?.type !== "source_sync"
                  }
                >
                <Card>
                  <CardHeader title={t("run.changes.title")} />
                  <div class="wa-change-strip">
                    <span class="wa-change-stat wa-change-create">
                      {t("run.changes.create")}{" "}
                      <strong>{changeCounts().create}</strong>
                    </span>
                    <span class="wa-change-stat wa-change-update">
                      {t("run.changes.update")}{" "}
                      <strong>{changeCounts().update}</strong>
                    </span>
                    <span class="wa-change-stat wa-change-delete">
                      {t("run.changes.delete")}{" "}
                      <strong>{changeCounts().delete}</strong>
                    </span>
                  </div>
                  <Show when={changes().length > 0}>
                    <details class="wb-disclosure">
                      <summary>{t("common.details")}</summary>
                      <div class="wa-change-grid">
                        <For each={["create", "update", "delete"] as const}>
                          {(action) => (
                            <div class="wa-change-col">
                              <h4>
                                {t(
                                  `run.changes.${action}` as Parameters<
                                    typeof t
                                  >[0],
                                )}
                              </h4>
                              <Show
                                when={
                                  changes().filter((c) => c.action === action)
                                    .length > 0
                                }
                                fallback={
                                  <p class="muted">{t("common.none")}</p>
                                }
                              >
                                <ul>
                                  <For
                                    each={changes().filter(
                                      (c) => c.action === action,
                                    )}
                                  >
                                    {(item) => (
                                      <li>
                                        <code>{item.label}</code>
                                      </li>
                                    )}
                                  </For>
                                </ul>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </details>
                  </Show>
                </Card>
                </Show>

                {/* ===== change detail — surfaced by default, not buried ===== */}
                <Show when={planResources().some(isActionablePlanResource)}>
                  <Card>
                    <PlanResourceReview resources={planResources()} />
                  </Card>
                </Show>

                <Show when={providerRowsNeedingAttention().length > 0}>
                  <details class="wb-disclosure">
                    <summary>{t("run.connections.reviewTitle")}</summary>
                    <Card>
                      <p class="wa-notice">{t("run.connections.reviewBody")}</p>
                      <ProviderResolutionTable
                        rows={providerRowsNeedingAttention()}
                      />
                    </Card>
                  </details>
                </Show>

                {/* ===== diagnostics — shown only when there is signal ===== */}
                <Show when={showDiagnosticsPanel()}>
                  <Card>
                    <CardHeader title={t("run.diagnostics.title")} />
                    <Show when={creditsRequired()}>
                      <div class="wa-stack">
                        <p class="wa-notice">
                          {t("run.diagnostics.creditsRequired")}
                        </p>
                        <Show when={isTakosumiCloudRuntime()}>
                          <Button variant="secondary" size="sm" href="/billing">
                            {t("run.cost.billingCta")}
                          </Button>
                        </Show>
                      </div>
                    </Show>
                    <Show when={connectionVerificationRequired()}>
                      <div class="wa-stack">
                        <p class="wa-notice">
                          {accessIssueDiagnostic(runAccessIssue()!).title}
                        </p>
                      </div>
                    </Show>
                    <Switch>
                      <Match when={logs.loading}>
                        <Skeleton variant="row" count={2} />
                      </Match>
                      <Match when={logs.error}>
                        <p class="wa-error">
                          {t("common.fetchFailed", {
                            message: (logs.error as ControlApiError).message,
                          })}
                        </p>
                      </Match>
                      <Match when={diagnosticRows().length > 0}>
                        <Show
                          when={
                            r().status === "failed" &&
                            !creditsRequired() &&
                            !connectionVerificationRequired()
                          }
                        >
                          <p class="wa-error">{t("run.diagnostics.failed")}</p>
                        </Show>
                        <details class="wb-disclosure">
                          <summary>
                            {t("common.details")}{" "}
                            <Badge tone="muted">
                              {diagnosticRows().length}
                            </Badge>
                          </summary>
                          <ul class="wa-diags">
                            <For each={diagnosticRows()}>
                              {(d) => <DiagnosticRow diagnostic={d} />}
                            </For>
                          </ul>
                        </details>
                      </Match>
                    </Switch>
                  </Card>
                </Show>

                {/* ===== expert details (folded) ===== */}
                <details class="wb-disclosure">
                  <summary>{t("run.details.title")}</summary>
                  <div class="wa-stack">
                    <Card>
                      <KVList items={supportDetailItems(r())} />
                    </Card>
                    <details class="wb-disclosure">
                      <summary>{t("run.details.debug")}</summary>
                      <Card>
                        <KVList items={debugDetailItems(r())} />
                      </Card>
                    </details>
                    <Card>
                      <CardHeader title={t("run.inputs.title")} />
                      <Show
                        when={inputs().length > 0}
                        fallback={<p class="muted">{t("run.inputs.empty")}</p>}
                      >
                        <NameList names={inputs()} />
                      </Show>
                    </Card>
                    <Card>
                      <CardHeader title={t("run.connections.title")} />
                      <Show
                        when={
                          connections().length > 0 || providerRows().length > 0
                        }
                        fallback={
                          <p class="muted">{t("run.connections.empty")}</p>
                        }
                      >
                        <Show
                          when={providerRows().length > 0}
                          fallback={<NameList names={connections()} />}
                        >
                          <ProviderResolutionTable rows={providerRows()} />
                        </Show>
                      </Show>
                    </Card>
                    <details class="wb-disclosure">
                      <summary>
                        {t("run.audit.title")}{" "}
                        <Badge tone="muted">
                          {(logs()?.auditEvents ?? []).length}
                        </Badge>
                      </summary>
                      <Card>
                        <Show
                          when={(logs()?.auditEvents ?? []).length > 0}
                          fallback={<p class="muted">{t("run.audit.empty")}</p>}
                        >
                          <ul class="wa-audit">
                            <For each={logs()?.auditEvents ?? []}>
                              {(event) => <AuditEventRow event={event} />}
                            </For>
                          </ul>
                        </Show>
                      </Card>
                    </details>
                  </div>
                </details>
              </div>
            )}
          </Match>
        </Switch>
      </>
    );
  }
}
