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
import { Activity } from "lucide-solid";
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
  planInstallation,
  type Run,
  type RunAuditEvent,
  type RunCostInfo,
  type RunDiagnostic,
} from "../../lib/control-api.ts";
import { createAction } from "../account/lib/action.tsx";
import {
  changeCountsForRun,
  changesFromLogs,
  connectionNamesFromLogs,
  inputNamesFromLogs,
  isTerminalRunStatus,
} from "../../lib/run-logs.ts";
import {
  operationLabel,
  policyStatusLabel,
  policyTone,
  runStatusLabel,
  runTone,
} from "../../lib/labels.ts";
import { formatDateTime, setDocumentTitle, t } from "../../i18n/index.ts";
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
} from "../../components/ui/index.ts";

export default function RunView() {
  return <Page>{() => <Inner />}</Page>;
}

/** Formats a backend-provided credit count for display (no invented units). */
function formatCredits(value: number): string {
  return value.toLocaleString();
}

function hasCostToShow(cost: RunCostInfo): boolean {
  return (
    cost.blocked ||
    cost.estimatedCredits > 0 ||
    cost.reservationStatus !== undefined ||
    cost.creditShortfall !== undefined ||
    cost.reasons.length > 0
  );
}

/** Pre-apply cost / shortfall panel — backend-computed values only. */
function CostNotice(props: { readonly cost: RunCostInfo }) {
  const cost = () => props.cost;
  return (
    <div class={`wa-cost${cost().blocked ? " wa-cost-blocked" : ""}`}>
      <Show when={cost().estimatedCredits > 0}>
        <p class="wa-cost-line">
          {t("run.cost.required", {
            n: formatCredits(cost().estimatedCredits),
          })}
        </p>
      </Show>
      <Show when={cost().availableCredits !== undefined}>
        <p class="wa-cost-line muted">
          {t("run.cost.balance", {
            n: formatCredits(cost().availableCredits ?? 0),
          })}
        </p>
      </Show>
      <Show when={cost().blocked}>
        <p class="wa-error">
          <Show
            when={cost().creditShortfall !== undefined}
            fallback={<>{t("run.cost.blocked")}</>}
          >
            {t("run.cost.shortfall", {
              n: formatCredits(cost().creditShortfall ?? 0),
            })}
          </Show>
        </p>
        <Show when={cost().reasons.length > 0}>
          <ul class="wa-cost-reasons">
            <For each={cost().reasons}>{(reason) => <li>{reason}</li>}</For>
          </ul>
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

function DiagnosticRow(props: { diagnostic: RunDiagnostic }) {
  return (
    <li class={`wa-diag wa-diag-${props.diagnostic.severity}`}>
      <span class="wa-diag-sev">{props.diagnostic.severity}</span>
      <span class="wa-diag-msg">{props.diagnostic.message}</span>
      <Show when={props.diagnostic.detail}>
        <pre class="wa-pre">{props.diagnostic.detail}</pre>
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
        {(value) => <pre class="wa-pre">{value()}</pre>}
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
  // The owning app, for the plain-language summary sentence + back link.
  const installationId = () => run.latest?.installationId ?? null;
  const [installation] = createResource(installationId, getInstallation);
  const appName = () => installation.latest?.name;

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
  const changeCounts = createMemo(() =>
    changeCountsForRun(run.latest, logs()?.auditEvents ?? []),
  );
  const connections = createMemo(() =>
    connectionNamesFromLogs(logs()?.auditEvents ?? []),
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
    const name = appName() ?? r.installationId ?? "";
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
                text: t("run.summary.destroyReady", { name }),
                sub,
              }
            : { kind: "action", text: t("run.summary.ready", { name }), sub };
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

  const detailItems = (r: Run): readonly KVItem[] => {
    const out: KVItem[] = [
      { label: t("run.details.runId"), value: <code>{r.id}</code> },
      { label: t("run.details.type"), value: <code>{r.type}</code> },
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
                href={`/capsules/${encodeURIComponent(id())}`}
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
                    return c && hasCostToShow(c) && isDeployableRun(r())
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
                      <Button
                        variant="primary"
                        href={`/capsules/${encodeURIComponent(id())}`}
                      >
                        {t("run.backToApp")}
                      </Button>
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
                        if (id) navigate(`/capsules/${encodeURIComponent(id)}`);
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

              {/* ===== diagnostics — open automatically when failed ===== */}
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
                  <Match when={logs()}>
                    {(l) => (
                      <Show
                        when={l().diagnostics.length > 0}
                        fallback={
                          <p class="muted">{t("run.diagnostics.empty")}</p>
                        }
                      >
                        <Show
                          when={r().status !== "failed"}
                          fallback={
                            <ul class="wa-diags">
                              <For each={l().diagnostics}>
                                {(d) => <DiagnosticRow diagnostic={d} />}
                              </For>
                            </ul>
                          }
                        >
                          <details class="wb-disclosure">
                            <summary>
                              {t("common.details")}{" "}
                              <Badge tone="muted">
                                {l().diagnostics.length}
                              </Badge>
                            </summary>
                            <ul class="wa-diags">
                              <For each={l().diagnostics}>
                                {(d) => <DiagnosticRow diagnostic={d} />}
                              </For>
                            </ul>
                          </details>
                        </Show>
                      </Show>
                    )}
                  </Match>
                </Switch>
              </Card>

              {/* ===== expert details (folded) ===== */}
              <details class="wb-disclosure">
                <summary>{t("run.details.title")}</summary>
                <div class="wa-stack">
                  <Card>
                    <KVList items={detailItems(r())} />
                  </Card>
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
                      when={connections().length > 0}
                      fallback={
                        <p class="muted">{t("run.connections.empty")}</p>
                      }
                    >
                      <NameList names={connections()} />
                    </Show>
                  </Card>
                  <Card>
                    <CardHeader
                      title={
                        <span class="wa-title-row">
                          {t("run.audit.title")}
                          <Badge tone="muted">
                            {(logs()?.auditEvents ?? []).length}
                          </Badge>
                        </span>
                      }
                    />
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
                </div>
              </details>
            </div>
          )}
        </Match>
      </Switch>
    </AppShell>
  );
}
