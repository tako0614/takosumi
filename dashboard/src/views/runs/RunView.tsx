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
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { Activity, ExternalLink } from "lucide-solid";
import { redactString } from "takosumi-contract/redaction";
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
  listStateVersions,
  listProviderConnections,
  listRuns,
  destroyPlanCapsule,
  openRunStream,
  planCapsuleUpdate,
  type ProviderConnection,
  type ProviderResolution,
  type Run,
  type RunAuditEvent,
  type RunCostInfo,
  type RunDiagnostic,
  type RunLogs,
  type RunPlanResource,
} from "../../lib/control-api.ts";
import { hasPlatformExtensionCapability } from "../../lib/runtime-capabilities.ts";
import { readableProviderSourceLabel } from "../../lib/provider-labels.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  changeCountsForRun,
  changeCountsKnownForRun,
  changesFromLogs,
  connectionNamesFromLogs,
  inputNamesFromLogs,
  isTerminalRunStatus,
  runHasChangeSummary,
} from "../../lib/run-logs.ts";
import {
  awaitsDeployApproval,
  isDeployApprovalCandidate,
  isReviewRun,
} from "../../lib/run-approval.ts";
import {
  stateVersionReadinessAfterApply,
  type StateVersionReadiness,
} from "../../lib/capsules-ui.ts";
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
import { useConfirmDialog } from "../../lib/confirm-dialog.ts";
import { runFailureHint } from "../../lib/run-errors.ts";
import { clearCurrentStateVersionCache } from "../../lib/current-state-versions.ts";
import { clearDashboardOverviewCache } from "../../lib/dashboard-overview.ts";
import { clearInstallConfigListCache } from "../../lib/install-config-list.ts";
import { listAuthorizedUiSurfaces } from "../../lib/ui-surface-interfaces.ts";
import { refreshSession } from "../account/lib/session.ts";
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
const RELEASE_ACTIVATION_POLL_MS = 3_000;
/** Newest-slice size of the Workspace Run ledger fetched to decide whether a
 * succeeded review run's deploy approval was already consumed by a later
 * apply (matches the run history's first page). */
const SIBLING_RUNS_LIMIT = 200;

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
  return cost.estimatedUsdMicros;
}

function isRequestTimeout(error: unknown): boolean {
  return error instanceof ControlApiError && error.code === "request_timeout";
}

/** True when the run fetch failed because the run genuinely does not exist —
 * anything else (network, 5xx, auth hiccup) is a transient load error and must
 * NOT render the "not found" empty state. */
function isRunNotFound(error: unknown): boolean {
  return (
    error instanceof ControlApiError &&
    (error.status === 404 || error.code === "not_found")
  );
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
    cost.ratingStatus === "unrated" ||
    costEstimatedUsdMicros(cost) > 0 ||
    cost.reasons.length > 0
  );
}

/** Pre-apply cost / shortfall panel — backend-computed values only. */
function CostNotice(props: { readonly cost: RunCostInfo }) {
  const cost = () => props.cost;
  const commercialBilling = () =>
    hasPlatformExtensionCapability("billing.commercial.v1");
  const estimatedUsdMicros = () => costEstimatedUsdMicros(cost());
  return (
    <div class={`wa-cost${cost().blocked ? " wa-cost-blocked" : ""}`}>
      <Show when={cost().ratingStatus === "unrated"}>
        <p class="wa-cost-line">{t("run.cost.unrated")}</p>
      </Show>
      <Show when={estimatedUsdMicros() > 0}>
        <p class="wa-cost-line">
          {t("run.cost.required", {
            n: formatUsdMicros(estimatedUsdMicros()),
          })}
        </p>
      </Show>
      <Show when={cost().blocked}>
        <p class="wa-error">{t("run.cost.capacityBlocked")}</p>
        <Show when={cost().reasons.length > 0}>
          <ul class="wa-cost-reasons">
            <For each={cost().reasons}>{(reason) => <li>{reason}</li>}</For>
          </ul>
        </Show>
        <Show
          when={commercialBilling()}
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

function diagnosticDisplayText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = redactString(value);
  return redacted.length > 4_000 ? `${redacted.slice(0, 4_000)}...` : redacted;
}

function isManagedHostnameSlotLimitRun(
  run: Run,
  diagnostics: readonly RunDiagnostic[],
): boolean {
  return (
    run.errorCode === "managed_public_hostname_slot_limit_reached" ||
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "managed_public_hostname_slot_limit_reached",
    )
  );
}

type AccessIssueKind =
  | "connection_verification"
  | "connection_setup"
  | "connection_changed"
  | "credential_service";

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
    const issue = accessIssueFromErrorCode(diagnostic.code);
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
  const hostnameSlotLimit = () =>
    props.diagnostic.code === "managed_public_hostname_slot_limit_reached";
  const accessIssue = () => accessIssueFromErrorCode(props.diagnostic.code);
  const message = () =>
    hostnameSlotLimit()
      ? t("run.diagnostics.hostnameSlotLimitShort")
      : accessIssue()
        ? accessIssueDiagnostic(accessIssue()!).short
        : (diagnosticDisplayText(props.diagnostic.message) ?? "diagnostic");
  const detail = () =>
    hostnameSlotLimit()
      ? t("run.diagnostics.hostnameSlotLimitDetail")
      : accessIssue()
        ? accessIssueDiagnostic(accessIssue()!).detail
        : diagnosticDisplayText(props.diagnostic.detail);
  // A raw (code-less) runner error keeps its own newlines — the .wa-diag-msg
  // span flattens them into flowing prose. Render multi-line raw text in a
  // <pre> (THEME's .wa-pre applies white-space: pre-wrap). Classified issues
  // stay a tidy one-line span. Provider-connection causes are selected only by
  // the diagnostic's stable code and receive friendly copy above.
  const rawMultilineMessage = () =>
    !hostnameSlotLimit() && !accessIssue() && /\n/u.test(message());
  return (
    <li class={`wa-diag wa-diag-${props.diagnostic.severity}`}>
      <span class="wa-diag-sev">
        {diagnosticSeverityLabel(props.diagnostic.severity)}
      </span>
      <Show
        when={rawMultilineMessage()}
        fallback={<span class="wa-diag-msg">{message()}</span>}
      >
        <pre class="wa-pre">{message()}</pre>
      </Show>
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
  return readableProviderSourceLabel(provider);
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
  const parts = Object.entries(scope.facts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, value]) => `${dimension}: ${String(value)}`);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function planResourceDisplayLabel(resource: RunPlanResource): string {
  const tail = resource.type.trim().split(".").at(-1) ?? resource.type;
  const words = tail
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
            {/* h2, not h3: the page h1 is the only heading above this one. */}
            <h2>{t("run.resources.title")}</h2>
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
  // Read ?auto REACTIVELY: this same component instance navigates run → run
  // in place (plan → apply, retry → fresh plan), so a value captured once from
  // location.search would leave stale install/update chrome on the next run.
  const [searchParams] = useSearchParams();
  const autoMode = (): string | null => {
    const value = searchParams.auto;
    return typeof value === "string" ? value : null;
  };
  const autoUpdateMode = () => autoMode() === "update";
  const autoInstall = () => autoMode() === "install" || autoUpdateMode();
  const withAuto = (path: string) =>
    autoInstall()
      ? path +
        (path.includes("?") ? "&" : "?") +
        (autoUpdateMode() ? "auto=update" : "auto=install")
      : path;
  const [forceConsole, setForceConsole] = createSignal(false);

  const [run, { refetch: refetchRun, mutate: mutateRun }] = createResource(
    runId,
    getRun,
  );
  const [logs, { refetch: refetchLogs }] = createResource(runId, getRunLogs);
  // Last-good logs snapshot. The resource accessor `logs()` THROWS when the
  // resource is errored, and the SSE stream refetches logs on every run event
  // (plus the 3s fallback poll) — so one transient 5xx mid-deploy would throw
  // out of a derived memo and blank/freeze the whole console. Read `logData()`
  // (never `logs()`) for derived values; a failed refetch keeps the last-good
  // logs on screen instead of clearing them.
  const [logsSnapshot, setLogsSnapshot] = createSignal<RunLogs | undefined>();
  createEffect(() => {
    if (logs.error) return;
    const latest = logs.latest;
    if (latest) setLogsSnapshot(latest);
  });
  const logData = (): RunLogs | undefined => logsSnapshot();
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
  // Activity feeds post-apply readiness, so fetch it only for a succeeded
  // apply/destroy-apply run, then poll only while release activation remains
  // unsettled. Runtime launch URLs are read separately from Interface.
  const [activity, { refetch: refetchActivity }] = createResource(
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
  const appliedRunStateVersionKey = createMemo(() => {
    const r = run.latest;
    const id = capsuleId();
    if (!id || !r || r.type !== "apply" || r.status !== "succeeded") {
      return undefined;
    }
    return `${id}:${r.id}`;
  });
  const [stateVersions, { refetch: refetchStateVersions }] = createResource(
    appliedRunStateVersionKey,
    async (key) => {
      const [id] = key.split(":");
      try {
        return await listStateVersions(id);
      } catch {
        return [];
      }
    },
  );
  const completedRunStateVersion = createMemo(() => {
    const r = run.latest;
    if (!r || r.type !== "apply" || r.status !== "succeeded") {
      return undefined;
    }
    return (stateVersions() ?? []).find((row) => row.createdByRunId === r.id);
  });
  const completedRunReadiness = createMemo((): StateVersionReadiness => {
    const r = run.latest;
    if (!r || r.type !== "apply" || r.status !== "succeeded") {
      return "settling";
    }
    if (stateVersions.loading || activity.loading) {
      return "settling";
    }
    // A failed activity fetch must NOT strand readiness in "settling" forever
    // (activity never retries), nor throw out of this memo — reading an errored
    // resource throws. Fall back to computing readiness from the stateVersion
    // alone. Lifecycle requirements are not inferred from OpenTofu Outputs;
    // matching lifecycle activity is the only activation signal here.
    return stateVersionReadinessAfterApply(
      completedRunStateVersion(),
      activity.error ? [] : (activity() ?? []),
      capsuleId() ?? undefined,
    );
  });
  const completedRunUiSurfaceKey = createMemo(() => {
    const r = run.latest;
    const id = capsuleId();
    if (
      !r ||
      !id ||
      r.type !== "apply" ||
      r.status !== "succeeded" ||
      completedRunReadiness() !== "ready"
    ) {
      return undefined;
    }
    return { workspaceId: r.workspaceId, capsuleId: id, runId: r.id };
  });
  const [completedRunUiSurfaces] = createResource(
    completedRunUiSurfaceKey,
    async ({ workspaceId, capsuleId: id }) => {
      const session = await refreshSession();
      if (!session) throw new Error("dashboard session is unavailable");
      return await listAuthorizedUiSurfaces(workspaceId, session.subject, {
        capsuleId: id,
      });
    },
  );
  const completedRunLaunchUrl = createMemo(() => {
    // Runtime launch surfaces are Interface-owned. StateVersion history,
    // OpenTofu Outputs, Store metadata, and release activation responses do
    // not carry or infer a launch URL. Any malformed/unbound Interface read
    // fails closed to the service-detail action below.
    if (completedRunUiSurfaces.error) return undefined;
    return completedRunUiSurfaces()?.[0]?.url;
  });

  const clearWorkspaceProjectionCaches = (
    workspaceId: string | undefined,
  ): void => {
    if (!workspaceId) return;
    clearCapsuleListCache(workspaceId);
    clearCurrentStateVersionCache(workspaceId);
    clearDashboardOverviewCache(workspaceId);
    clearInstallConfigListCache(workspaceId);
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
    clearWorkspaceProjectionCaches(r.workspaceId);
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

  createEffect(() => {
    const current = run.latest;
    if (
      !current ||
      current.type !== "apply" ||
      current.status !== "succeeded" ||
      !pageVisible()
    ) {
      return;
    }
    const readiness = completedRunReadiness();
    if (readiness === "ready" || readiness === "activation_failed") return;
    const timer = setTimeout(() => {
      void Promise.all([refetchStateVersions(), refetchActivity()]);
    }, RELEASE_ACTIVATION_POLL_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const inputs = createMemo(() =>
    inputNamesFromLogs(logData()?.auditEvents ?? []),
  );
  const changes = createMemo(() =>
    changesFromLogs(logData()?.auditEvents ?? []),
  );
  const planResources = createMemo(() => run.latest?.planResources ?? []);
  const changeCounts = createMemo(() =>
    changeCountsForRun(run.latest, logData()?.auditEvents ?? []),
  );
  // `run.summary` is optional on the wire — when the backend recorded neither
  // a summary nor log-parsable change items, changeCounts() is an all-zero
  // FALLBACK, not a fact. The destructive gate and the completed-run changes
  // card must both distinguish "0 changes" from "unknown".
  const changeCountsKnown = createMemo(() => {
    if (run.error) return false;
    return changeCountsKnownForRun(run.latest, logData()?.auditEvents ?? []);
  });
  // A destroy plan that reports 削除0 is not a recorded fact — a removal
  // deletes resources by definition, so the backend simply did not record the
  // counts. Treat all-zero destroy counts as UNKNOWN so the honest 記録なし
  // shows instead of contradicting the destructive warning with 作成0/変更0/削除0.
  const changeCountsTrustworthy = createMemo(() => {
    if (!changeCountsKnown()) return false;
    const r = run.latest;
    if (
      (r?.type === "destroy_plan" || r?.type === "destroy_apply") &&
      changeCounts().delete === 0
    ) {
      return false;
    }
    return true;
  });
  const connections = createMemo(() =>
    connectionNamesFromLogs(logData()?.auditEvents ?? []),
  );
  const providerConnectionsById = createMemo(
    () =>
      // `.error` first: reading an errored resource throws, which would take the
      // whole run view (and, via the root boundary, the shell) down. A failed
      // connection list degrades to no name resolution, not a crash.
      new Map(
        (providerConnectionsForRun.error
          ? []
          : (providerConnectionsForRun() ?? [])
        ).map((connection) => [connection.id, connection]),
      ),
  );
  const providerRows = createMemo(() =>
    providerResolutionRows(run.latest, providerConnectionsById()),
  );
  const providerRowsNeedingAttention = createMemo(() =>
    providerRows().filter(providerResolutionNeedsAttention),
  );
  const diagnosticRows = createMemo(() => logData()?.diagnostics ?? []);
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

  // Whether this plan's deploy approval is still OPEN is not a run-local
  // fact: any apply / destroy_apply created for the same Capsule at/after the
  // plan consumes it (the run history's semantics, shared via
  // lib/run-approval.ts). The Run payload carries no applied-by linkage, so
  // read the newest slice of the Workspace Run ledger whenever this run COULD
  // await a deploy — an already-applied plan opened from history must not
  // present 承認待ち + an active デプロイを実行 CTA again.
  const [siblingRuns] = createResource(
    () => {
      if (run.error) return null;
      const r = run.latest;
      if (!r || !isDeployApprovalCandidate(r)) return null;
      // Key by run id so navigating plan → apply → back re-reads the ledger.
      return [r.workspaceId, r.id] as const;
    },
    ([workspaceId]) => listRuns(workspaceId, SIBLING_RUNS_LIMIT),
  );
  const isDeployableRun = (r: Run): boolean => {
    if (!isDeployApprovalCandidate(r) || applied()) return false;
    // Ledger read failed: fall back to run-local facts rather than
    // permanently hiding the deploy button on a transient error — the backend
    // re-verifies the plan digest and base state generation on apply anyway.
    if (siblingRuns.error) return true;
    const siblings = siblingRuns.latest;
    // Still loading: stay conservative — don't claim an open approval yet.
    if (siblings === undefined) return false;
    return awaitsDeployApproval(r, siblings);
  };
  // True once the sibling ledger POSITIVELY shows this plan's approval was
  // consumed by a later apply attempt (never true while the ledger read is
  // still loading or failed) — drives the settled "already deployed" summary
  // line instead of a contradictory "ready to deploy" with no button.
  const deployApprovalConsumed = (r: Run): boolean => {
    if (!isDeployApprovalCandidate(r) || applied()) return false;
    if (siblingRuns.error) return false;
    const siblings = siblingRuns.latest;
    if (siblings === undefined) return false;
    return !awaitsDeployApproval(r, siblings);
  };
  // The sibling ledger is still loading for a plan that COULD await deploy:
  // isDeployableRun stays conservatively false until it resolves, so the deploy
  // button is withheld — don't show a "ready to deploy" line during this
  // window (a settled 確認中 progress line instead of ready-copy-with-no-button).
  const deployApprovalResolving = (r: Run): boolean =>
    isDeployApprovalCandidate(r) &&
    !applied() &&
    !siblingRuns.error &&
    siblingRuns.latest === undefined;
  // A succeeded review run whose policy did NOT pass: it never becomes
  // deployable, so it must still offer a way forward (re-plan) instead of
  // dead-ending on the "blocked" line.
  const isPolicyBlockedReview = (r: Run): boolean =>
    isReviewRun(r) && r.status === "succeeded" && r.policyStatus !== "pass";
  // Header badge status: a succeeded review run still awaiting its deploy is
  // already approved/passed — the remaining step is EXECUTION, so present
  // 実行待ち (ready to run), not 承認待ち (which reads as "still needs approval"
  // and mislabels the destructive-execute stage). Reuses the deploy-CTA
  // condition so the list and detail can never disagree.
  const displayStatus = (r: Run): Run["status"] | "ready_to_deploy" =>
    isDeployableRun(r) ? "ready_to_deploy" : r.status;
  // Deploy/destructive CTAs read the change counts; before the logs land those
  // counts are an all-zero fallback, so requiresDestructiveConfirmation would
  // briefly flip the plain "デプロイ" button to the destructive gate. Hold both
  // as a skeleton until the counts are trustworthy (backend summary, or the
  // log fetch has settled).
  const deployCtaReady = (r: Run): boolean =>
    runHasChangeSummary(r) || !logs.loading;
  // Fail-closed: when the counts are unknowable (no backend summary, nothing
  // parsed from the logs) a plan with deletes would read as 0 — require the
  // explicit destructive confirmation instead of silently applying.
  const requiresDestructiveConfirmation = (r: Run): boolean =>
    isDeployableRun(r) &&
    (needsConfirm() ||
      r.type === "destroy_plan" ||
      r.requiresApproval === true ||
      changeCounts().delete > 0 ||
      !changeCountsKnown());

  const deploy = createAction(async (confirmedReview?: boolean) => {
    let envelope: unknown;
    const currentRun = run.latest;
    if (
      currentRun &&
      requiresDestructiveConfirmation(currentRun) &&
      confirmedReview !== true
    ) {
      setNeedsConfirm(true);
      return;
    }
    try {
      envelope = await createApplyRun(runId(), {
        timeoutMs: APPLY_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      if (currentRun && isRequestTimeout(error)) {
        const recovered = latestApplyRunForPlan(
          await listRuns(currentRun.workspaceId, 30),
          currentRun,
        );
        if (recovered) {
          envelope = { run: recovered };
        } else {
          envelope = await createApplyRun(runId(), {
            timeoutMs: APPLY_REQUEST_TIMEOUT_MS,
          });
        }
      } else {
        throw error;
      }
    }
    setNeedsConfirm(false);
    setApplied(true);
    clearWorkspaceProjectionCaches(currentRun?.workspaceId);
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
  // Once-per-plan-run guard that survives a re-mount: Back / revisit of an
  // ?auto=install plan URL must NOT silently re-fire the auto-apply.
  const autoAppliedKey = () => `takosumi.auto-applied@${runId()}`;
  const autoAppliedAlready = () => {
    try {
      return sessionStorage.getItem(autoAppliedKey()) === "1";
    } catch {
      return false;
    }
  };
  createEffect(() => {
    const r = run.latest;
    if (!autoInstall() || autoContinued() || applied() || deploy.busy() || !r) {
      return;
    }
    // Revisited ?auto plan whose deploy approval a later apply already consumed
    // (Back / fresh tab / a different session where the sessionStorage guard is
    // absent): isDeployableRun is false, so neither the auto-apply nor the
    // escape below would fire and the install screen would spin 追加中… forever.
    // Drop to the honest console (it shows すでにデプロイ済み + a link to the app).
    if (deployApprovalConsumed(r)) {
      setForceConsole(true);
      return;
    }
    // We already auto-applied this plan earlier this session and navigated on
    // to the apply run. Landing back here (browser Back) must not strand the
    // user on a never-advancing "追加中…" spinner — the guard blocks a re-apply
    // but the install screen would still render progress. Drop to the real run
    // console (deploy button OR the settled すでにデプロイ済み summary) so the
    // screen is always actionable, deployable or not. Checked before the logs
    // gate below because this path never auto-applies — it only escapes.
    if (autoAppliedAlready()) {
      setForceConsole(true);
      return;
    }
    // Destructive-gate inputs must be SETTLED before auto-continuing: with no
    // run.summary the gate reads log-derived counts, and right after the SSE
    // terminal flip those logs are still being refetched — evaluating against
    // the stale fetch would read a plan with deletes as 0 and auto-apply it.
    // logs.loading is reactive, so this effect re-runs once the fetch lands.
    if (!runHasChangeSummary(r) && logs.loading) return;
    if (isDeployableRun(r) && !requiresDestructiveConfirmation(r)) {
      // Never auto-apply past the billing/cost gate the manual deploy button
      // enforces — wait for the check, and stop on a blocked estimate (the
      // install screen shows the gate card instead).
      if (cost.loading || costBlocked()) return;
      setAutoContinued(true);
      try {
        sessionStorage.setItem(autoAppliedKey(), "1");
      } catch {
        /* private mode: fall back to the in-instance guard */
      }
      void deploy.run(false);
    }
  });

  const retryPlan = createAction(async () => {
    const instId = run.latest?.capsuleId;
    if (!instId) return;
    // Preserve the requested operation. A failed destroy must be retried as a
    // destroy, while an ordinary plan retry syncs and pins the latest source.
    const envelope =
      run.latest?.type === "destroy_plan"
        ? await destroyPlanCapsule(instId)
        : await planCapsuleUpdate(instId);
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
  // Cancelling a queued/running apply must never be one stray click — name
  // the run (service + operation) in an explicit ConfirmDialog first.
  const { confirm } = useConfirmDialog();
  const confirmCancel = async (): Promise<void> => {
    const r = run.latest;
    const operation = operationLabel(r?.type);
    const name = appName();
    const ok = await confirm({
      title: t("run.cancelConfirm.title"),
      message: name
        ? t("run.cancelConfirm.message", { name, operation })
        : t("run.cancelConfirm.messageGeneric", { operation }),
      confirmText: t("run.cancelConfirm.cta"),
      cancelText: t("run.cancelConfirm.keep"),
      danger: true,
    });
    if (!ok) return;
    await cancel.run();
  };
  // A queued/running run (or a parked review) can still be stopped.
  const cancellable = () => {
    const s = run.latest?.status;
    return s === "queued" || s === "running" || s === "waiting_approval";
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
    // A dead run fetch (initial load only) or a failed apply-run creation must
    // surface as an error, not an eternal spinner. A transient refetch error
    // while a run is already on screen must NOT flip the install screen to the
    // failure card — keep rendering from the last-good run below.
    if ((run.error && !run.latest) || deploy.error()) {
      return { phase: "error" };
    }
    const r = run.latest;
    if (!r) return { phase: "progress", step: "fetch" };
    // Terminal non-success states (failed / cancelled / expired) must not spin
    // forever — polling has stopped, nothing will advance the screen.
    if (
      r.status === "failed" ||
      r.status === "cancelled" ||
      r.status === "expired"
    ) {
      return { phase: "error" };
    }
    if (r.type === "apply") {
      if (r.status !== "succeeded") {
        return { phase: "progress", step: "deploy" };
      }
      const readiness = completedRunReadiness();
      if (readiness === "activation_failed") return { phase: "error" };
      if (readiness === "ready") return { phase: "done" };
      return { phase: "progress", step: "done" };
    }
    if (r.type === "destroy_apply") {
      return r.status === "succeeded"
        ? { phase: "done" }
        : { phase: "progress", step: "deploy" };
    }
    // review (plan) run
    if (r.status === "waiting_approval") return { phase: "gate" };
    if (r.status === "succeeded") {
      // Already deployed (a later apply consumed this plan's approval) — never
      // spin "deploy" progress on a terminal plan. The auto-continue effect
      // also forces the console here; this gate keeps an escape button in the
      // brief window before that fires.
      if (deployApprovalConsumed(r)) return { phase: "gate" };
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
    // Terminal, non-failure statuses: render a settled line (no spinner). A
    // cancelled/expired run has stopped polling, so a "progress" fallback would
    // spin forever and contradict the terminal badge in the header.
    if (r.status === "cancelled") {
      return { kind: "danger", text: t("run.summary.cancelled") };
    }
    if (r.status === "expired") {
      return {
        kind: "error",
        text: t("run.summary.expired"),
        sub: t("run.summary.expiredHint"),
      };
    }
    const name = appName();
    if (r.type === "apply" || r.type === "destroy_apply") {
      const isRemoval = r.type === "destroy_apply";
      if (r.status === "queued" || r.status === "running") {
        return {
          kind: "progress",
          text: t(isRemoval ? "run.summary.removing" : "run.summary.applying"),
        };
      }
      if (r.status === "succeeded") {
        if (r.type === "apply") {
          const readiness = completedRunReadiness();
          if (readiness === "settling") {
            return { kind: "progress", text: t("run.summary.finishing") };
          }
          if (readiness === "activation_pending") {
            return {
              kind: "progress",
              text: t("run.summary.activationPending"),
            };
          }
          if (readiness === "activation_failed") {
            return {
              kind: "error",
              text: t("run.summary.activationFailed"),
              sub: t("app.surfaces.activationFailed"),
            };
          }
        }
        return {
          kind: "ok",
          text: t(
            isRemoval ? "run.summary.removed" : "run.summary.applySucceeded",
          ),
        };
      }
      if (r.status === "failed") {
        if (isManagedHostnameSlotLimitRun(r, diagnosticRows())) {
          return {
            kind: "action",
            text: t("run.summary.hostnameSlotLimit"),
            sub: t("run.summary.hostnameSlotLimitHint"),
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
            // Not a dead end: the re-plan action renders alongside (see
            // isPolicyBlockedReview) and this hint points at the next step.
            return {
              kind: "danger",
              text: t("run.summary.blocked"),
              sub: t("run.summary.blockedHint"),
            };
          }
          // The sibling ledger says a later apply already consumed this
          // plan's approval (e.g. opened from history) — settle the summary
          // instead of claiming the deploy is still waiting to be run.
          if (deployApprovalConsumed(r)) {
            return { kind: "ok", text: t("run.summary.alreadyApplied") };
          }
          // Ledger still loading: the deploy button is withheld, so show a
          // neutral 確認中 line instead of "ready to deploy" copy with no button.
          if (deployApprovalResolving(r)) {
            return { kind: "progress", text: t("run.summary.checkingDeploy") };
          }
          // Only show the create/update/delete sub when the counts are a
          // recorded fact — a destroy reporting 削除0 (or a plan with no
          // recorded summary) must not sit under the ready line contradicting
          // it. Honest omission over a fake 作成0/変更0/削除0.
          const counts = changeCounts();
          const sub = changeCountsTrustworthy()
            ? t("run.summary.readyChanges", {
                create: counts.create,
                update: counts.update,
                delete: counts.delete,
              })
            : undefined;
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
          if (isManagedHostnameSlotLimitRun(r, diagnosticRows())) {
            return {
              kind: "action",
              text: t("run.summary.hostnameSlotLimit"),
              sub: t("run.summary.hostnameSlotLimitHint"),
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

  // Consumer install/update error card copy — one friendly sentence, never the
  // raw control-plane text. Action errors have already crossed a presentation
  // boundary that intentionally retains no machine classification; only a
  // persisted Run/RunDiagnostic code may select issue-specific behavior.
  const installErrorText = (): string => {
    if (deploy.error()) return t("install.errorSub");
    return summary()?.sub ?? summary()?.text ?? t("install.errorSub");
  };

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
    if (r.type === "apply") return t("run.title.apply");
    if (r.type === "destroy_apply" || r.type === "destroy_plan")
      return t("run.title.destroy");
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

  // One-line mirror of the install phase for the scoped live region below.
  const installLiveText = () => {
    const st = installState();
    if (st.phase === "done") {
      return autoUpdateMode()
        ? t("update.doneTitleGeneric")
        : t("install.doneTitleGeneric");
    }
    if (st.phase === "error") {
      return autoUpdateMode()
        ? t("update.errorTitle")
        : t("install.errorTitle");
    }
    if (st.phase === "gate") return t("install.gateTitle");
    return installStepLabel(
      INSTALL_STEPS[Math.min(installActiveIndex(), INSTALL_STEPS.length - 1)],
    );
  };

  const installPercent = () =>
    Math.min(
      100,
      Math.round(((installActiveIndex() + 0.5) / INSTALL_STEPS.length) * 100),
    );

  /** Clean App-Store-style install screen (progress → done → open/return),
   * shown instead of the technical run console while ?auto=install is set. */
  const installScreen = () => {
    const st = installState();
    const name = appName();
    return (
      <div class="av-install">
        {/* Live region scoped to the one-line status only — putting it on
            the whole screen re-announces every heading and button. */}
        <p class="sr-only" role="status" aria-live="polite">
          {installLiveText()}
        </p>
        <Switch>
          <Match when={st.phase === "done"}>
            <div class="av-install-card av-install-done">
              <span class="av-install-check" aria-hidden="true">
                ✓
              </span>
              <h2>
                {autoUpdateMode()
                  ? name
                    ? t("update.doneTitle", { name })
                    : t("update.doneTitleGeneric")
                  : name
                    ? t("install.doneTitle", { name })
                    : t("install.doneTitleGeneric")}
              </h2>
              <p>
                {autoUpdateMode() ? t("update.doneSub") : t("install.doneSub")}
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
                {autoUpdateMode()
                  ? t("update.errorTitle")
                  : t("install.errorTitle")}
              </h2>
              {/* One plain sentence with the next action — the summary layer
                  already classifies billing / account-access / known failure
                  codes. The console stays behind 詳細を見る. */}
              <p>{installErrorText()}</p>
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
                      (autoUpdateMode()
                        ? t("update.installingGeneric")
                        : t("install.installingGeneric"))}
                  </h2>
                  <p class="muted">
                    {completedRunReadiness() === "activation_pending"
                      ? t("install.activationPending")
                      : t("install.wait")}
                  </p>
                </div>
              </div>
              <div
                class="av-install-bar"
                role="progressbar"
                aria-label={t("install.progressAria")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={installPercent()}
              >
                <i
                  style={{ width: `${installPercent()}%` }}
                  aria-hidden="true"
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
              {/* Escape hatch: a long or wedged deploy must never be a dead
                  end — drop to the full run console on demand. */}
              <button
                type="button"
                class="tg-btn tg-btn-ghost tg-btn-sm av-install-detail"
                onClick={() => setForceConsole(true)}
              >
                {t("install.errorCta")}
              </button>
            </div>
          </Match>
        </Switch>
      </div>
    );
  };

  return (
    <>
      <Show when={autoInstall() && !forceConsole()} fallback={installConsole()}>
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
                    status={displayStatus(r())}
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
          {/* Initial load ONLY — every 3s fallback poll / visibility refetch /
              approve refetch also flips run.loading, and unmounting the whole
              console for a skeleton on each of those would flicker and evict
              focus. Keep rendering `.latest` during refetches (mirrors
              RunGroupView). */}
          <Match when={run.loading && !run.error && !run.latest}>
            <Card>
              <Skeleton variant="block" />
            </Card>
          </Match>
          {/* Load-failure EmptyState is for the INITIAL load only: a transient
              5xx from the SSE-driven log refetch / 3s poll while a run is
              already on screen must NOT replace the console — it falls through
              to the content Match below (which shows a quiet refresh notice). */}
          <Match when={run.error && !run.latest}>
            <Show
              when={isRunNotFound(run.error)}
              fallback={
                <EmptyState
                  icon={<Activity size={28} />}
                  title={t("run.loadFailedTitle")}
                  message={t("common.fetchFailed", {
                    message: (run.error as ControlApiError).message,
                  })}
                  action={
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => void refetchRun()}
                    >
                      {t("common.retry")}
                    </Button>
                  }
                />
              }
            >
              <EmptyState
                icon={<Activity size={28} />}
                title={t("run.notFoundTitle")}
                message={t("run.notFoundMessage")}
                action={
                  <Button variant="secondary" href="/runs">
                    {t("nav.runs")}
                  </Button>
                }
              />
            </Show>
          </Match>
          {/* `run.latest`, never `run()`: the accessor throws on error, and a
              transient error must keep the last-good run rendered here. */}
          <Match when={run.latest}>
            {(r) => (
              <div class="wa-stack">
                {/* Quiet inline notice when a refetch failed but we still have
                    the last-good run — mirrors RunGroupView's refresh notice. */}
                <Show when={run.error}>
                  <p class="wa-notice" role="alert">
                    {t("run.refreshFailed")}
                  </p>
                </Show>
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
                      return hasCostToShow(c) ? c : undefined;
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

                    {/* Deploy CTA counts aren't trustworthy until the logs
                        land — hold the deploy / destructive gate as a skeleton
                        so it doesn't flash the wrong button first. */}
                    <Show when={isDeployableRun(r()) && !deployCtaReady(r())}>
                      <Skeleton variant="row" count={1} />
                    </Show>

                    <Show
                      when={
                        !applied() &&
                        isDeployableRun(r()) &&
                        deployCtaReady(r()) &&
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
                        ((r().status === "failed" &&
                          (isReviewRun(r()) ||
                            connectionVerificationRequired())) ||
                          isPolicyBlockedReview(r())) &&
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
                        onClick={() => void confirmCancel()}
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
                    when={
                      !applied() &&
                      requiresDestructiveConfirmation(r()) &&
                      deployCtaReady(r())
                    }
                  >
                    <p class="wa-deploy-warn">{t("run.destructiveWarning")}</p>
                    <div class="wa-form-actions">
                      {/* This control only navigates back — it does NOT cancel
                          the plan (a succeeded plan can't be cancelled; its
                          deploy approval is simply left unused). Name it for
                          what it does so it doesn't imply an abort. */}
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
                        {t("run.stopGoBack")}
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
                  <Show when={cancel.error()}>
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
                    {/* Past tense once an apply-family run has settled — the
                        changes HAPPENED; a review run keeps the future tense
                        (its changes are still a proposal). */}
                    <CardHeader
                      title={t(
                        (r().type === "apply" ||
                          r().type === "destroy_apply") &&
                          isTerminalRunStatus(r().status)
                          ? "run.changes.titleDone"
                          : "run.changes.title",
                      )}
                    />
                    {/* Honest zero: a settled run with neither a backend
                        summary nor log-derived items must say "no record",
                        never 作成0/変更0/削除0 (live-verified false zeros on a
                        real apply). A destroy reporting 削除0 is likewise not a
                        fact (see changeCountsTrustworthy) — it must not sit next
                        to the "既存リソースの削除が含まれます" warning. While the log
                        refetch is in flight the strip stays (record may arrive). */}
                    <Show
                      when={
                        changeCountsTrustworthy() ||
                        !isTerminalRunStatus(r().status) ||
                        logs.loading
                      }
                      fallback={
                        <p class="muted">{t("run.changes.noRecord")}</p>
                      }
                    >
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
                    </Show>
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
                    <Show when={connectionVerificationRequired()}>
                      <div class="wa-stack">
                        <p class="wa-notice">
                          {accessIssueDiagnostic(runAccessIssue()!).title}
                        </p>
                      </div>
                    </Show>
                    <Switch>
                      {/* Prefer last-good diagnostics: only skeleton / show the
                          fetch-failed line on the INITIAL load (no snapshot) —
                          a transient refetch error must keep the diagnostics on
                          screen, not swap them for an error line. */}
                      <Match when={logs.loading && !logsSnapshot()}>
                        <Skeleton variant="row" count={2} />
                      </Match>
                      <Match when={diagnosticRows().length > 0}>
                        <Show
                          when={
                            r().status === "failed" &&
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
                      <Match when={logs.error && !logsSnapshot()}>
                        <p class="wa-error">
                          {t("common.fetchFailed", {
                            message: (logs.error as ControlApiError).message,
                          })}
                        </p>
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
                          {(logData()?.auditEvents ?? []).length}
                        </Badge>
                      </summary>
                      <Card>
                        <Show
                          when={(logData()?.auditEvents ?? []).length > 0}
                          fallback={<p class="muted">{t("run.audit.empty")}</p>}
                        >
                          <ul class="wa-audit">
                            <For each={logData()?.auditEvents ?? []}>
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
