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
import AppShell from "../account/components/shell/AppShell.tsx";
import Page from "../account/components/auth/Page.tsx";
import {
  approveRun,
  ControlApiError,
  createApplyRun,
  extractRunId,
  getInstallation,
  getRun,
  getRunCostInfo,
  getRunLogs,
  listDeployments,
  listProviderConnections,
  planInstallation,
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
import { launchUrlFromOutputs } from "../../lib/installations-ui.ts";
import {
  diagnosticSeverityLabel,
  operationLabel,
  policyStatusLabel,
  policyTone,
  runStatusLabel,
  runTone,
} from "../../lib/labels.ts";
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

function DiagnosticRow(props: { diagnostic: RunDiagnostic }) {
  const message = () =>
    diagnosticDisplayText(props.diagnostic.message) ?? "diagnostic";
  const detail = () => diagnosticDisplayText(props.diagnostic.detail);
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

  const [run, { refetch: refetchRun }] = createResource(runId, getRun);
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
    () => run.latest?.spaceId ?? null,
    listProviderConnections,
  );
  // The owning app, for the plain-language summary sentence + back link.
  const installationId = () => run.latest?.installationId ?? null;
  const [installation] = createResource(installationId, getInstallation);
  const appName = () => installation.latest?.name;
  const appliedRunDeploymentKey = createMemo(() => {
    const r = run.latest;
    const id = installationId();
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
    return launchUrlFromOutputs(deployment?.outputsPublic ?? {});
  });

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

  // Poll while the run is non-terminal so the screen advances on its own.
  createEffect(() => {
    const current = run.latest;
    if (!current || isTerminalRunStatus(current.status)) return;
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
  const showDiagnosticsPanel = createMemo(
    () =>
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
    try {
      envelope = await createApplyRun(runId(), { confirmDestructive });
    } catch (error) {
      if (
        error instanceof ControlApiError &&
        error.status === 409 &&
        isDestructiveConfirmationRequired(error)
      ) {
        setNeedsConfirm(true);
        return;
      }
      throw error;
    }
    setNeedsConfirm(false);
    setApplied(true);
    // Jump to the apply Run when the backend surfaced its id — that page then
    // polls to "デプロイが完了しました" on its own. Fallback: stay here with the
    // applied notice (the legacy behaviour).
    const applyRunId = extractRunId(envelope);
    if (applyRunId && applyRunId !== runId()) {
      navigate(`/runs/${applyRunId}`);
      return;
    }
    await Promise.all([refetchRun(), refetchLogs()]);
  });

  const retryPlan = createAction(async () => {
    const instId = run.latest?.installationId;
    if (!instId) return;
    const envelope = await planInstallation(instId);
    const newRunId = extractRunId(envelope);
    if (newRunId) navigate(`/runs/${newRunId}`);
  });

  const costInfo = () => cost.latest;
  const costBlocked = () => costInfo()?.blocked === true;

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
        return {
          kind: "error",
          text: t("run.summary.failed", { operation: operationLabel(r.type) }),
          sub: r.errorCode ?? t("run.summary.failedHint"),
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
          return {
            kind: "error",
            text: t("run.summary.failed", {
              operation: operationLabel(r.type),
            }),
            sub: r.errorCode ?? t("run.summary.failedHint"),
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
    if (r.installationId) {
      out.push({
        label: t("run.details.installation"),
        value: <code>{r.installationId}</code>,
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

  return (
    <AppShell>
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
            when={installationId()}
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
                    <div class={`av-run-summary av-run-summary-${s().kind}`}>
                      <Show when={s().kind === "progress"}>
                        <span class="av-run-spinner" aria-hidden="true" />
                      </Show>
                      <div class="av-run-summary-text">
                        <p class="av-run-summary-line">{s().text}</p>
                        <Show when={s().sub}>
                          {(sub) => <p class="av-run-summary-sub">{sub()}</p>}
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
                      isReviewRun(r()) &&
                      r().installationId
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

                  <Show
                    when={
                      r().status === "succeeded" &&
                      (r().type === "apply" || r().type === "destroy_apply") &&
                      installationId()
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
                <Show when={!applied() && requiresDestructiveConfirmation(r())}>
                  <p class="wa-deploy-warn">{t("run.destructiveWarning")}</p>
                  <div class="wa-form-actions">
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={deploy.busy()}
                      onClick={() => {
                        setNeedsConfirm(false);
                        const id = installationId();
                        if (id) navigate(`/services/${encodeURIComponent(id)}`);
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

              {/* ===== changes (counts always, lists folded) ===== */}
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
                              fallback={<p class="muted">{t("common.none")}</p>}
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
                      <Show when={r().status === "failed"}>
                        <p class="wa-error">{t("run.diagnostics.failed")}</p>
                      </Show>
                      <details class="wb-disclosure">
                        <summary>
                          {t("common.details")}{" "}
                          <Badge tone="muted">{diagnosticRows().length}</Badge>
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
    </AppShell>
  );
}
